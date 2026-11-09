package snapshot

// The encoder's compact baseline frames (WP19).
//
// Each client's encoder keeps BASELINE_RING (32) frames of everything the
// client knows. At spec 14 scenario 1's size (300 clients, ~1,300 entities in
// each interest set) that is ~12 M entity states: with EntState's Name
// string they were 56-byte records holding a pointer, ~700 MB the garbage
// collector had to scan on every cycle. Each cycle's mark phase took a P away
// from the 4-vCPU zone for a long stretch and showed as tick p99 spikes
// (docs/evidence/wp19-*). encEnt is the same state with the name replaced by
// an interned id: 40 bytes and pointer-free, so the GC never scans the rings
// and the encoder copies 30 % fewer bytes per tick.
//
// The wire output is unchanged: a name id stands for exactly one string, so
// "name changed" means the same thing, and records still carry the string.

import (
	"sort"
	"sync"

	"lodestone/server/pkg/proto"
)

// encEnt is an EntState with the name interned (see NameID).
type encEnt struct {
	ID        uint32
	X, Y, Z   int32
	PartyID   uint32
	name      uint32
	Vx        int16
	Vy        int16
	Vz        int16
	TypeID    uint16
	Kind      proto.EntityKind
	Yaw       uint8
	Pitch     uint8
	HealthPct uint8
	Activity  uint8
	Level     uint8
}

// names interns entity names process-wide (encoders on every snapshot worker
// share it). Ids are never reused; names are short and few (characters,
// enemy and townsfolk titles), so the table only grows by new names.
var names = struct {
	mu   sync.RWMutex
	ids  map[string]uint32
	list []string
}{ids: map[string]uint32{"": 0}, list: []string{""}}

// NameID interns name and returns its id ("" is 0). Callers on a hot path
// should cache the id per entity and pass it in Candidate.NameID.
func NameID(name string) uint32 {
	if name == "" {
		return 0
	}
	names.mu.RLock()
	id, ok := names.ids[name]
	names.mu.RUnlock()
	if ok {
		return id
	}
	names.mu.Lock()
	defer names.mu.Unlock()
	if id, ok := names.ids[name]; ok {
		return id
	}
	id = uint32(len(names.list))
	names.ids[name] = id
	names.list = append(names.list, name)
	return id
}

func nameOf(id uint32) string {
	names.mu.RLock()
	defer names.mu.RUnlock()
	return names.list[id]
}

func toEnc(s *EntState, name uint32) encEnt {
	return encEnt{ID: s.ID, X: s.X, Y: s.Y, Z: s.Z, PartyID: s.PartyID, name: name, Vx: s.Vx, Vy: s.Vy, Vz: s.Vz,
		TypeID: s.TypeID, Kind: s.Kind, Yaw: s.Yaw, Pitch: s.Pitch, HealthPct: s.HealthPct, Activity: s.Activity, Level: s.Level}
}

func (b *encEnt) state() EntState {
	return EntState{ID: b.ID, Kind: b.Kind, X: b.X, Y: b.Y, Z: b.Z, Yaw: b.Yaw, Pitch: b.Pitch, Vx: b.Vx, Vy: b.Vy, Vz: b.Vz,
		HealthPct: b.HealthPct, Activity: b.Activity, TypeID: b.TypeID, Name: nameOf(b.name), Level: b.Level, PartyID: b.PartyID}
}

// same reports whether c (with name id name) equals b in every diffed field,
// i.e. Diff would produce an empty mask.
func (b *encEnt) same(c *EntState, name uint32) bool {
	return b.X == c.X && b.Y == c.Y && b.Z == c.Z && b.Vx == c.Vx && b.Vz == c.Vz && b.Vy == c.Vy && b.Yaw == c.Yaw &&
		b.Pitch == c.Pitch && b.HealthPct == c.HealthPct && b.Activity == c.Activity && b.TypeID == c.TypeID &&
		b.Kind == c.Kind && b.name == name && b.Level == c.Level && b.PartyID == c.PartyID
}

// encFrame is one compact baseline frame (see Frame).
type encFrame struct {
	Tick uint32
	Self proto.SelfState
	Ents []encEnt // sorted by ID
}

func (f *encFrame) find(id uint32) *encEnt {
	i := sort.Search(len(f.Ents), func(i int) bool { return f.Ents[i].ID >= id })
	if i < len(f.Ents) && f.Ents[i].ID == id {
		return &f.Ents[i]
	}
	return nil
}

type encRing struct {
	frames [Ring]encFrame
}

func (r *encRing) get(tick uint32) *encFrame {
	if tick == 0 {
		return nil
	}
	f := &r.frames[tick%Ring]
	if f.Tick != tick {
		return nil
	}
	return f
}

func (r *encRing) slot(tick uint32) *encFrame {
	f := &r.frames[tick%Ring]
	f.Tick = tick
	f.Ents = f.Ents[:0]
	return f
}

// KnownCursor walks the newest frame's entity ids (what the client will know
// once it applies the last snapshot), for AOI hysteresis in a merge walk.
type KnownCursor struct {
	ents []encEnt
	p    int
}

// Known returns a cursor over the newest frame (empty before the first Build).
func (e *Encoder) Known() KnownCursor {
	if f := e.r.get(e.last); f != nil {
		return KnownCursor{ents: f.Ents}
	}
	return KnownCursor{}
}

// Has reports whether id is in the frame; ids must be asked in ascending order.
func (k *KnownCursor) Has(id uint32) bool {
	for k.p < len(k.ents) && k.ents[k.p].ID < id {
		k.p++
	}
	return k.p < len(k.ents) && k.ents[k.p].ID == id
}

// Knows reports whether the newest frame holds entity id (binary search).
func (e *Encoder) Knows(id uint32) bool {
	f := e.r.get(e.last)
	return f != nil && f.find(id) != nil
}
