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
	"sync/atomic"

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
// G5: lookups by id (every record a snapshot sends) read a published slice
// without a lock; the RWMutex's reader count was a cache line every snapshot
// worker wrote. Elements below a published length never change.
var names = struct {
	mu   sync.RWMutex
	ids  map[string]uint32
	list atomic.Pointer[[]string]
}{ids: map[string]uint32{"": 0}}

func init() { names.list.Store(&[]string{""}) }

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
	l := append(*names.list.Load(), name)
	id = uint32(len(l) - 1)
	names.ids[name] = id
	names.list.Store(&l)
	return id
}

func nameOf(id uint32) string { return (*names.list.Load())[id] }

func toEnc(s *EntState, name uint32) encEnt {
	return encEnt{ID: s.ID, X: s.X, Y: s.Y, Z: s.Z, PartyID: s.PartyID, name: name, Vx: s.Vx, Vy: s.Vy, Vz: s.Vz,
		TypeID: s.TypeID, Kind: s.Kind, Yaw: s.Yaw, Pitch: s.Pitch, HealthPct: s.HealthPct, Activity: s.Activity, Level: s.Level}
}

func (b *encEnt) state() EntState {
	return EntState{ID: b.ID, Kind: b.Kind, X: b.X, Y: b.Y, Z: b.Z, Yaw: b.Yaw, Pitch: b.Pitch, Vx: b.Vx, Vy: b.Vy, Vz: b.Vz,
		HealthPct: b.HealthPct, Activity: b.Activity, TypeID: b.TypeID, Name: nameOf(b.name), Level: b.Level, PartyID: b.PartyID}
}

// diffEnc is Diff(&b.state(), cur) for cur with name id curName, without
// looking the baseline's name up (G5: the string table read was a cache
// miss per record): names compare by id, which is the same test.
func diffEnc(b *encEnt, cur *EntState, curName uint32) proto.EntityRecord {
	base := EntState{ID: b.ID, Kind: b.Kind, X: b.X, Y: b.Y, Z: b.Z, Yaw: b.Yaw, Pitch: b.Pitch, Vx: b.Vx, Vy: b.Vy, Vz: b.Vz,
		HealthPct: b.HealthPct, Activity: b.Activity, TypeID: b.TypeID, Name: cur.Name, Level: b.Level, PartyID: b.PartyID}
	r := Diff(&base, cur) // names equal here: no name bit
	if b.name != curName {
		r.Mask |= proto.EntityRecordHasName
		r.Name = cur.Name
	}
	return r
}

// same reports whether c (with name id name) equals b in every diffed field,
// i.e. Diff would produce an empty mask.
func (b *encEnt) same(c *EntState, name uint32) bool {
	return b.X == c.X && b.Y == c.Y && b.Z == c.Z && b.Vx == c.Vx && b.Vz == c.Vz && b.Vy == c.Vy && b.Yaw == c.Yaw &&
		b.Pitch == c.Pitch && b.HealthPct == c.HealthPct && b.Activity == c.Activity && b.TypeID == c.TypeID &&
		b.Kind == c.Kind && b.name == name && b.Level == c.Level && b.PartyID == c.PartyID
}

// The frames themselves (G5, 4 vCPU): a frame entry is not the state but a
// reference to it (entRef, 12 bytes instead of 40). The states live in a
// per-tick store: the zone's History, shared by every client's encoder (the
// tick's quantized entities, written once per tick), or the encoder's own
// arena for states it has no shared reference to (a caller without a
// History, and states carried forward, below). In a dense crowd most of a
// client's frame each tick is "the same state as in the baseline" (entities
// not due this tick, deferred records, unchanged ones), which used to be a
// 40-byte copy per entity per client per tick out of a baseline frame that
// had long left every cache: ~13 MB written and read again per tick at
// spec 14 scenario 1's size, the snapshot phase's largest cost on two cores
// with SMT siblings (docs/decisions/v1-capacity.md, G5 4 vCPU). Now it is a
// 24-byte reference copy, and the states themselves are read from a ~6 MB
// store every client shares.
//
// "Did it change since the baseline" (every due entity, every client, every
// tick) must not read the baseline state either: scattered over up to 16
// ticks' stores, that read was the new cache miss. A reference carries a
// fingerprint of its state, and the History records since which tick each
// entity's state has been what it is now (Set's since). Then: a shared
// reference to a tick at or after "since" is the current state (unchanged,
// exactly); a different fingerprint is a different state (changed,
// exactly); only the rest (equal fingerprints, or a carried reference)
// compares the states field by field.
//
// Lifetime: both stores keep histLen ticks. A frame never refers to a state
// more than carryAge ticks older than itself: copying a reference forward
// that is older than that copies the state into the encoder's own arena for
// the current tick ("carry"). Frames are used as baselines for at most
// Ring-1 ticks, so every state a usable frame refers to is at most
// carryAge+Ring-1 = 47 < histLen ticks old and its slot has not been reused.

const (
	histLen  = 64 // ticks of states kept (History and each encoder's own arena)
	carryAge = 16 // max age of a state a new frame may refer to
	ownBit   = 1 << 31
	// Compile-time check of the lifetime rule above (negative = error).
	_ = uint(histLen - carryAge - Ring)
)

// entRef is one frame entry: entity ID and where its state is (the store of
// tick Tick; idx with ownBit set = the encoder's own arena).
type entRef struct {
	ID   uint32
	Tick uint32
	idx  uint32
	fp   uint64 // fingerprint of the state
}

// fingerprint hashes every field same compares. Equal states have equal
// fingerprints; different fingerprints prove different states.
func fingerprint(b *encEnt) uint64 {
	const m = 0x9e3779b97f4a7c15
	h := uint64(0)
	for _, w := range [...]uint64{
		uint64(uint32(b.X)) | uint64(uint32(b.Y))<<32,
		uint64(uint32(b.Z)) | uint64(b.PartyID)<<32,
		uint64(b.name) | uint64(uint16(b.Vx))<<32 | uint64(uint16(b.Vy))<<48,
		uint64(uint16(b.Vz)) | uint64(b.TypeID)<<16 | uint64(b.Kind)<<32 | uint64(b.Yaw)<<40 | uint64(b.Pitch)<<48 | uint64(b.HealthPct)<<56,
		uint64(b.Activity) | uint64(b.Level)<<8,
	} {
		h = (h ^ w) * m
		h ^= h >> 29
	}
	return h
}

// History is the per-tick store of entity states shared by the encoders of
// every client of one zone (G5). Each tick, before any Build for that tick,
// the zone calls Begin and Set for every entity a client may be sent, and
// passes Candidate.Ref = 1 + index. Build only reads it, so encoders on
// several goroutines may share it during the snapshot phase. Keeping it is
// optional: without one (or with Ref 0) an encoder stores states itself.
type History struct {
	slots [histLen]histSlot
	cur   *histSlot
}

type histSlot struct {
	tick  uint32
	ents  []encEnt
	fp    []uint64 // History only: fingerprint(ents[i])
	since []uint32 // History only: Set's since
}

// Begin opens tick's store with n entries (reusing the slot of tick-64).
func (h *History) Begin(tick uint32, n int) {
	s := &h.slots[tick%histLen]
	s.tick = tick
	if cap(s.ents) < n {
		s.ents = make([]encEnt, n, n+n/4)
		s.fp = make([]uint64, n, n+n/4)
		s.since = make([]uint32, n, n+n/4)
	}
	s.ents, s.fp, s.since = s.ents[:n], s.fp[:n], s.since[:n]
	h.cur = s
}

// Set stores entry i of the current tick; nameID is NameID(st.Name). since
// is a tick from which on the entity's state has been st without a break
// (it was Set with an equal state at every tick from since to now; the
// current tick when unsure): encoders then skip comparing it with baselines
// of those ticks.
func (h *History) Set(i int, st *EntState, nameID, since uint32) {
	c := h.cur
	c.ents[i] = toEnc(st, nameID)
	c.fp[i] = fingerprint(&c.ents[i])
	c.since[i] = since
}

// Tick is the tick of the open store (0 before the first Begin).
func (h *History) Tick() uint32 {
	if h == nil || h.cur == nil {
		return 0
	}
	return h.cur.tick
}

// encFrame is one compact baseline frame (see Frame).
type encFrame struct {
	Tick uint32
	Self proto.SelfState
	Ents []entRef // sorted by ID
}

func (f *encFrame) find(id uint32) *entRef {
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

// state is the entity state r refers to.
func (e *Encoder) state(r *entRef) *encEnt {
	if r.idx&ownBit != 0 {
		return &e.own[r.Tick%histLen].ents[r.idx&^ownBit]
	}
	return &e.hist.slots[r.Tick%histLen].ents[r.idx]
}

// keepOwn stores st (fingerprint fp) in the encoder's arena for tick and
// refers to it.
func (e *Encoder) keepOwn(tick uint32, st encEnt, fp uint64) entRef {
	o := &e.own[tick%histLen]
	o.ents = append(o.ents, st)
	return entRef{ID: st.ID, Tick: tick, idx: ownBit | uint32(len(o.ents)-1), fp: fp}
}

// refCur refers to candidate c's current state (in the shared History when
// the candidate has a reference into this tick's store, else a copy).
func (e *Encoder) refCur(tick uint32, c *Candidate, name uint32) entRef {
	if c.Ref != 0 && e.useHist {
		return entRef{ID: c.State.ID, Tick: tick, idx: c.Ref - 1, fp: e.hist.cur.fp[c.Ref-1]}
	}
	st := toEnc(c.State, name)
	return e.keepOwn(tick, st, fingerprint(&st))
}

// carry copies baseline reference b into the frame for tick: as is while
// it is young enough, else its state moves into this tick's own arena.
func (e *Encoder) carry(tick uint32, b *entRef) entRef {
	if tick-b.Tick <= carryAge {
		return *b
	}
	return e.keepOwn(tick, *e.state(b), b.fp)
}

// changed reports whether candidate c (name id n) differs from its
// baseline state b in any diffed field, reading b's state only when the
// History cannot tell (see "did it change" above).
func (e *Encoder) changed(c *Candidate, n uint32, b *entRef) bool {
	if c.Ref != 0 && e.useHist {
		cur := e.hist.cur
		if b.fp != cur.fp[c.Ref-1] {
			return true
		}
		// Equal fingerprints too: b is this entity's state at b.Tick (a
		// caller with two entities under one id gets here only when their
		// fingerprints match as well).
		if b.idx&ownBit == 0 && b.Tick >= cur.since[c.Ref-1] {
			return false
		}
	}
	return !e.state(b).same(c.State, n)
}

// KnownCursor walks the newest frame's entity ids (what the client will know
// once it applies the last snapshot), for AOI hysteresis in a merge walk.
type KnownCursor struct {
	ents []entRef
	p    int
}

// Known returns a cursor over the newest frame (empty before the first Build).
func (e *Encoder) Known() KnownCursor {
	if f := e.r.get(e.last); f != nil {
		return KnownCursor{ents: f.Ents}
	}
	return KnownCursor{}
}

// Has reports whether id is in the frame; ids must be asked in ascending
// order. It binary-searches the rest of the frame, so a caller that asks
// only about a few ids (the zone asks only when the answer matters) does not
// walk the whole frame.
func (k *KnownCursor) Has(id uint32) bool {
	lo, hi := k.p, len(k.ents)
	for lo < hi {
		m := int(uint(lo+hi) >> 1)
		if k.ents[m].ID < id {
			lo = m + 1
		} else {
			hi = m
		}
	}
	k.p = lo
	return lo < len(k.ents) && k.ents[lo].ID == id
}

// Knows reports whether the newest frame holds entity id (binary search).
func (e *Encoder) Knows(id uint32) bool {
	f := e.r.get(e.last)
	return f != nil && f.find(id) != nil
}
