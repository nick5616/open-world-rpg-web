// Package snapshot implements delta snapshots (spec 9 wire protocol): the
// zone's per-client encoder and the matching client-side decoder (used by the
// Go bots and tests; WP06 ports the decoder to TS).
//
// Model (Quake 3 style, generalizing wizard-wars' cold-field wire cache):
//
//   - The server keeps a ring of the last BASELINE_RING (32) frames it sent to
//     a client: for each, the exact entity states the client will believe once
//     it applies that snapshot.
//   - The client acks the newest snapshot tick it received (Input.ackTick).
//     The next snapshot is a delta against that acked frame (baselineTick), or
//     a full snapshot (baselineTick 0) when the ack is missing or older than
//     the ring.
//   - Client state for tick T = state(baselineTick), minus `removed`, with each
//     EntityRecord applied. A record for an entity the baseline lacks is
//     applied onto the ZERO state: first sight omits zero-valued fields
//     (unchanged-from-zero costs nothing too) but always carries kind and the
//     name. An entity in the baseline that has no record keeps its baseline
//     state, which is how unchanged entities cost zero bytes and how slower
//     AOI rings skip ticks: the server simply does not send them and records
//     the baseline state in the new frame.
//   - SelfState is diffed the same way against the baseline's self.
//
// Because every frame is relative to an ACKED frame, any snapshot can be lost
// or (over WebTransport datagrams) reordered without corrupting the client.
package snapshot

import (
	"errors"
	"sort"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/proto"
)

// Ring is the number of frames kept per client (BASELINE_RING).
const Ring = constants.BaselineRing

// EntState is one entity's quantized wire state (what a client knows).
type EntState struct {
	ID        uint32
	Kind      proto.EntityKind
	X, Y, Z   int32
	Yaw       uint8
	Pitch     uint8
	Vx        int16
	Vy        int16
	Vz        int16
	HealthPct uint8
	Activity  uint8
	TypeID    uint16
	Name      string
	Level     uint8
	PartyID   uint32
	// Appearance (protocol v6, CR 034): what a player wears (proto
	// EntityRecord.appearance); 0 for everything else.
	Appearance uint64
}

// Diff returns the record turning base into cur. base nil means first sight
// (diff against the zero state; kind and name are always included). A zero
// Mask means nothing changed.
func Diff(base, cur *EntState) proto.EntityRecord {
	var z EntState
	first := base == nil
	if first {
		base = &z
	}
	r := proto.EntityRecord{ID: cur.ID}
	if first || cur.Kind != base.Kind {
		r.Mask |= proto.EntityRecordHasKind
		r.Kind = cur.Kind
	}
	if cur.X != base.X {
		r.Mask |= proto.EntityRecordHasX
		r.X = cur.X
	}
	if cur.Y != base.Y {
		r.Mask |= proto.EntityRecordHasY
		r.Y = cur.Y
	}
	if cur.Z != base.Z {
		r.Mask |= proto.EntityRecordHasZ
		r.Z = cur.Z
	}
	if cur.Yaw != base.Yaw {
		r.Mask |= proto.EntityRecordHasYaw
		r.Yaw = cur.Yaw
	}
	if cur.Pitch != base.Pitch {
		r.Mask |= proto.EntityRecordHasPitch
		r.Pitch = cur.Pitch
	}
	if cur.Vx != base.Vx {
		r.Mask |= proto.EntityRecordHasVx
		r.Vx = cur.Vx
	}
	if cur.Vy != base.Vy {
		r.Mask |= proto.EntityRecordHasVy
		r.Vy = cur.Vy
	}
	if cur.Vz != base.Vz {
		r.Mask |= proto.EntityRecordHasVz
		r.Vz = cur.Vz
	}
	if cur.HealthPct != base.HealthPct {
		r.Mask |= proto.EntityRecordHasHealthPct
		r.HealthPct = cur.HealthPct
	}
	if cur.Activity != base.Activity {
		r.Mask |= proto.EntityRecordHasActivity
		r.Activity = cur.Activity
	}
	if cur.TypeID != base.TypeID {
		r.Mask |= proto.EntityRecordHasTypeID
		r.TypeID = cur.TypeID
	}
	if first || cur.Name != base.Name {
		r.Mask |= proto.EntityRecordHasName
		r.Name = cur.Name
	}
	if cur.Level != base.Level {
		r.Mask |= proto.EntityRecordHasLevel
		r.Level = cur.Level
	}
	if cur.PartyID != base.PartyID {
		r.Mask |= proto.EntityRecordHasPartyID
		r.PartyID = cur.PartyID
	}
	if cur.Appearance != base.Appearance {
		r.Mask |= proto.EntityRecordHasAppearance
		r.Appearance = cur.Appearance
	}
	return r
}

// Apply returns base with r's present fields applied (base nil = zero state).
func Apply(base *EntState, r *proto.EntityRecord) EntState {
	var s EntState
	if base != nil {
		s = *base
	}
	s.ID = r.ID
	m := r.Mask
	if m&proto.EntityRecordHasKind != 0 {
		s.Kind = r.Kind
	}
	if m&proto.EntityRecordHasX != 0 {
		s.X = r.X
	}
	if m&proto.EntityRecordHasY != 0 {
		s.Y = r.Y
	}
	if m&proto.EntityRecordHasZ != 0 {
		s.Z = r.Z
	}
	if m&proto.EntityRecordHasYaw != 0 {
		s.Yaw = r.Yaw
	}
	if m&proto.EntityRecordHasPitch != 0 {
		s.Pitch = r.Pitch
	}
	if m&proto.EntityRecordHasVx != 0 {
		s.Vx = r.Vx
	}
	if m&proto.EntityRecordHasVy != 0 {
		s.Vy = r.Vy
	}
	if m&proto.EntityRecordHasVz != 0 {
		s.Vz = r.Vz
	}
	if m&proto.EntityRecordHasHealthPct != 0 {
		s.HealthPct = r.HealthPct
	}
	if m&proto.EntityRecordHasActivity != 0 {
		s.Activity = r.Activity
	}
	if m&proto.EntityRecordHasTypeID != 0 {
		s.TypeID = r.TypeID
	}
	if m&proto.EntityRecordHasName != 0 {
		s.Name = r.Name
	}
	if m&proto.EntityRecordHasLevel != 0 {
		s.Level = r.Level
	}
	if m&proto.EntityRecordHasPartyID != 0 {
		s.PartyID = r.PartyID
	}
	if m&proto.EntityRecordHasAppearance != 0 {
		s.Appearance = r.Appearance
	}
	return s
}

// DiffSelf returns the SelfState record turning base into cur (both carry
// full values; their masks are ignored). base nil = zero state.
func DiffSelf(base, cur *proto.SelfState) proto.SelfState {
	var z proto.SelfState
	if base == nil {
		base = &z
	}
	out := *cur
	out.Mask = 0
	set := func(changed bool, bit uint16) {
		if changed {
			out.Mask |= bit
		}
	}
	set(cur.X != base.X, proto.SelfStateHasX)
	set(cur.Y != base.Y, proto.SelfStateHasY)
	set(cur.Z != base.Z, proto.SelfStateHasZ)
	set(cur.Vx != base.Vx, proto.SelfStateHasVx)
	set(cur.Vy != base.Vy, proto.SelfStateHasVy)
	set(cur.Vz != base.Vz, proto.SelfStateHasVz)
	set(cur.Health != base.Health, proto.SelfStateHasHealth)
	set(cur.HealthMax != base.HealthMax, proto.SelfStateHasHealthMax)
	set(cur.Stamina != base.Stamina, proto.SelfStateHasStamina)
	set(cur.StaminaMax != base.StaminaMax, proto.SelfStateHasStaminaMax)
	set(cur.Mode != base.Mode, proto.SelfStateHasMode)
	set(cur.AirJumps != base.AirJumps, proto.SelfStateHasAirJumps)
	set(cur.Activity != base.Activity, proto.SelfStateHasActivity)
	set(cur.Flags != base.Flags, proto.SelfStateHasFlags)
	set(cur.MoveExt != base.MoveExt, proto.SelfStateHasMoveExt) // WP10, protocol v2
	return out
}

// ApplySelf applies a SelfState record onto base (nil = zero). The result
// carries full values with Mask 0.
func ApplySelf(base *proto.SelfState, r *proto.SelfState) proto.SelfState {
	var s proto.SelfState
	if base != nil {
		s = *base
	}
	m := r.Mask
	if m&proto.SelfStateHasX != 0 {
		s.X = r.X
	}
	if m&proto.SelfStateHasY != 0 {
		s.Y = r.Y
	}
	if m&proto.SelfStateHasZ != 0 {
		s.Z = r.Z
	}
	if m&proto.SelfStateHasVx != 0 {
		s.Vx = r.Vx
	}
	if m&proto.SelfStateHasVy != 0 {
		s.Vy = r.Vy
	}
	if m&proto.SelfStateHasVz != 0 {
		s.Vz = r.Vz
	}
	if m&proto.SelfStateHasHealth != 0 {
		s.Health = r.Health
	}
	if m&proto.SelfStateHasHealthMax != 0 {
		s.HealthMax = r.HealthMax
	}
	if m&proto.SelfStateHasStamina != 0 {
		s.Stamina = r.Stamina
	}
	if m&proto.SelfStateHasStaminaMax != 0 {
		s.StaminaMax = r.StaminaMax
	}
	if m&proto.SelfStateHasMode != 0 {
		s.Mode = r.Mode
	}
	if m&proto.SelfStateHasAirJumps != 0 {
		s.AirJumps = r.AirJumps
	}
	if m&proto.SelfStateHasActivity != 0 {
		s.Activity = r.Activity
	}
	if m&proto.SelfStateHasFlags != 0 {
		s.Flags = r.Flags
	}
	if m&proto.SelfStateHasMoveExt != 0 {
		s.MoveExt = r.MoveExt
	}
	s.Mask = 0
	return s
}

// Frame is what a client knows after applying the snapshot for Tick.
type Frame struct {
	Tick uint32
	Self proto.SelfState // full values, Mask 0
	Ents []EntState      // sorted by ID
}

// Find returns the entity with id, or nil (binary search).
func (f *Frame) Find(id uint32) *EntState {
	i := sort.Search(len(f.Ents), func(i int) bool { return f.Ents[i].ID >= id })
	if i < len(f.Ents) && f.Ents[i].ID == id {
		return &f.Ents[i]
	}
	return nil
}

// ring holds the last Ring frames, indexed by tick % Ring. Tick 0 is never
// used (baselineTick 0 means "full snapshot").
type ring struct {
	frames [Ring]Frame
}

func (r *ring) get(tick uint32) *Frame {
	if tick == 0 {
		return nil
	}
	f := &r.frames[tick%Ring]
	if f.Tick != tick {
		return nil
	}
	return f
}

// slot returns the frame slot for tick, reset but keeping its backing array
// so steady state allocates nothing.
func (r *ring) slot(tick uint32) *Frame {
	f := &r.frames[tick%Ring]
	f.Tick = tick
	f.Ents = f.Ents[:0]
	return f
}

// ErrNoBaseline means the client lacks the frame a delta refers to.
var ErrNoBaseline = errors.New("snapshot: baseline not available")
