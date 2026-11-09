package game

import (
	"errors"
	"math"
	"time"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/snapshot"
	"lodestone/server/pkg/writebehind"
	"lodestone/server/zone/internal/combat"
)

// Entity is one simulated thing in the zone. Only players exist in WP03;
// enemies, pickups and projectiles reuse the same record (spec 8).
type Entity struct {
	ID          uint32
	Kind        proto.EntityKind
	Name        string
	CharacterID string
	Level       uint8
	PartyID     uint32        // 0 = none; WP12 sets it from the social service's party (party.go)
	TypeID      uint16        // enemy type, npc role | variant << 8 (WP20), ...: EntityRecord.typeId
	x           *exploreState // WP12 exploration progress (explore.go), shared with the session
	ListenOnly  bool          // WP11: listen-only (Config.VoiceLocalListenOnly), its speaking bit is never shown
	remote      *remoteInfo   // WP16: mirrored from another zone (ghosts.go); never in Server.ents
	epoch       int64         // WP16: checkpoint fence (persist.go), 0 = unfenced

	Move       movement.State
	Yaw, Pitch float64 // radians, from the newest applied input
	Health     uint16
	HealthMax  uint16
	LastSeq    uint32 // newest applied input frame (acked in snapshots)
	// Stamina, mode and the traversal timers live in Move (WP10): they are
	// part of the shared step and travel in SelfState.

	// WP13 (combat.go): a player's combat state, or the enemy this entity
	// mirrors; TypeID rides in snapshots (combatdefs.TypeID).
	cbt         *combat.Player
	npc         *combat.Enemy
	npcActivity uint8

	drownedEvent bool // WP10: a frame this tick drowned + respawned the player (Event 100)

	prevValid movement.State // last state that passed validation
	idx       int32          // index in Server.ents this tick (grid payload)
	q         snapshot.EntState
	nameID    uint32 // WP19: snapshot.NameID(nameOf), cached for the snapshot phase
	nameOf    string
	// G5 (snapshots.go buildViews): the state published to the snapshot
	// History last, the tick it was, and since when it has been unchanged.
	histQ     snapshot.EntState
	histTick  uint32
	histSince uint32

	// View extrapolation (WP06): what OTHER clients see when this player's
	// input is late. See updateView.
	lastFrame proto.InputFrame
	applied   int // frames applied this tick
	guess     int // guessed steps the view runs ahead of Move
	view      movement.State
	viewRaw   movement.State // view before easing (carried forward next tick)
	viewOff   movement.Vec3  // decaying horizontal easing offset

	// Caves and mining (WP09).
	caveSys   int       // cave system this tick (-1 surface), for interest clipping
	lastSwing time.Time // last accepted pickaxe swing
	// Pickups: personal drops only their owner sees and can take.
	Owner     uint32
	Item      string
	Qty       int
	RollSeed  uint64
	DespawnAt time.Time
	drop      *itemDrop // WP14: the item behind a pickup (items.go), nil for WP09-only pickups
}

// stepsPerTick: 60 Hz input frames, 30 Hz ticks.
const stepsPerTick = constants.MoveStepHz / constants.TickRateHz

// maxGuessSteps bounds the extrapolation at 16 steps (267 ms): a TCP
// retransmit stall (RTO 200 ms + slack) on a lossy link is covered, a player
// whose connection died stops after a quarter second.
const maxGuessSteps = 16

// updateView computes the state others see this tick. The zone simulates a
// player only from their input frames, so when a packet is late (jitter, or
// a TCP retransmit stall on the WebSocket fallback) the authoritative state
// stands still and then jumps by a burst of frames: every observer sees a
// stop and a lurch (measured with tools/netsim "thailand": up to 40 cm per
// stall). Instead, the view runs ahead of the confirmed state by as many
// steps as real time owes (2 per tick, minus frames applied), repeating the
// player's last movement input (without jumps). When the late frames land
// the confirmed state catches up to where the view already is, so walking
// straight through a stall looks seamless; a turn during the stall shows as
// an eased correction on the observer's side. The guess decays by one extra
// step per tick while frames flow, so a lead left by a client that paused
// (hidden tab: no frames, nothing to catch up) melts away in half a second.
//
// Only the view is extrapolated: SelfState (reconciliation), validation,
// AOI and persistence all use the confirmed Move, and combat validation must
// use confirmed history too (WP10).
func (e *Entity) updateView(g movement.Ground, env movement.Env) {
	n := e.applied
	e.applied = 0
	e.guess += stepsPerTick - n
	if n >= stepsPerTick {
		e.guess--
	}
	e.guess = max(0, min(maxGuessSteps, e.guess))
	prev := e.viewRaw
	e.view = e.Move
	if e.guess > 0 && e.LastSeq != 0 {
		f := e.lastFrame
		f.Flags &^= proto.InputFlagJump | proto.InputFlagJumpEdge | proto.InputFlagGlideToggle | oneStepFlags
		for i := 0; i < e.guess; i++ {
			e.view = movement.StepFrameEnv(e.view, f, g, env)
		}
	}
	e.easeView(prev)
}

// View easing: when a guess turns out wrong (the player turned a corner
// during an input stall) the view would jump by up to a metre in one tick.
// Instead the difference between where observers expected the player (the
// previous view carried forward by its velocity) and the corrected view
// becomes an offset that decays with a 50 ms time constant, so the
// correction plays out as a quick curve over ~4 ticks. Measured in the
// two-browser "thailand" run: a 55 cm one-tick jump before this. Steady
// walking carries forward exactly (offset 0); discontinuities over 3 m
// (snap-back, respawn) are shown as they are.
const viewEaseDecay = 0.513 // exp(-33.3 ms / 50 ms)

func (e *Entity) easeView(prev movement.State) {
	e.viewRaw = e.view
	if e.LastSeq == 0 || prev == (movement.State{}) {
		return
	}
	// Horizontal only: gravity and landings make vertical carry-forward
	// noisy, and corner guesses are a horizontal error.
	dt := 1.0 / float64(constants.TickRateHz)
	dx := prev.Pos.X + prev.Vel.X*dt - e.view.Pos.X
	dz := prev.Pos.Z + prev.Vel.Z*dt - e.view.Pos.Z
	if d := math.Hypot(dx, dz); d > 0.05 && d < 3 {
		e.viewOff.X += dx
		e.viewOff.Z += dz
	}
	e.viewOff.X *= viewEaseDecay
	e.viewOff.Z *= viewEaseDecay
	if math.Hypot(e.viewOff.X, e.viewOff.Z) > 3 {
		e.viewOff = movement.Vec3{}
	}
	e.view.Pos.X += e.viewOff.X
	e.view.Pos.Z += e.viewOff.Z
}

// quantize refreshes the wire view others see (spec 9 quantization), from
// the extrapolated view (updateView).
func (e *Entity) quantize(_ movement.Ground) {
	// WP10: activity bits (climbing, gliding, swimming, airborne) come from
	// the step's mode, so remote players can pose them.
	act := movement.Activity(e.view)
	act |= e.speakingActivity() // WP11 (earshot.go)
	act |= e.combatActivity()   // WP13: enemy wind-ups (combat.go)
	hp := uint8(0)
	if e.HealthMax > 0 {
		hp = uint8(math.Round(float64(e.Health) * 100 / float64(e.HealthMax)))
	}
	e.q = snapshot.EntState{
		ID:        e.ID,
		Kind:      e.Kind,
		X:         proto.MetersToCm(e.view.Pos.X),
		Y:         proto.MetersToCm(e.view.Pos.Y),
		Z:         proto.MetersToCm(e.view.Pos.Z),
		Yaw:       proto.YawToU8(e.Yaw),
		Pitch:     proto.PitchToU8(e.Pitch),
		Vx:        proto.VelToCms(e.view.Vel.X),
		Vy:        proto.VelToCms(e.view.Vel.Y),
		Vz:        proto.VelToCms(e.view.Vel.Z),
		HealthPct: hp,
		Activity:  act,
		Name:      e.Name,
		Level:     e.Level,
		PartyID:   e.PartyID,
		TypeID:    e.TypeID,
	}
}

// selfState is the player's own authoritative state, exact health, for
// reconciliation. Position/velocity here are what the client replays from.
// WP10: the whole movement state (mode, exact stamina, timers, flags) so
// the client can replay from it (movement.SelfFields, protocol v2).
func (e *Entity) selfState(_ movement.Ground) proto.SelfState {
	st := proto.SelfState{Health: e.Health, HealthMax: e.HealthMax}
	movement.SelfFields(&st, e.Move)
	return st
}

// applyFrame steps movement for one input frame and validates the result.
// Returns false if the step was rejected and the player snapped back.
func (e *Entity) applyFrame(f proto.InputFrame, g movement.Ground, env movement.Env) bool {
	next := movement.StepFrameEnv(e.Move, f, g, env)
	e.Yaw = proto.U16ToYaw(f.Yaw)
	e.Pitch = proto.I16ToPitch(f.Pitch)
	e.LastSeq = f.Seq
	e.lastFrame = f
	e.applied++
	vertOK := verticalOK(e.Move, next, g) // WP07/WP10, traversal.go; before the clamp
	horizOK := horizontalOK(e.Move, next) // per mode (WP10)

	// World bounds: the v1 world spans [0, WORLD_SIZE_M) on x and z. The
	// client does not clamp, so a player pressing into the edge gets a
	// reconciliation correction, which is the right feedback for a wall.
	const maxXZ = float64(constants.WorldSizeM) - 0.01
	if next.Pos.X < 0 || next.Pos.X > maxXZ {
		next.Pos.X = math.Max(0, math.Min(maxXZ, next.Pos.X))
		next.Vel.X = 0
	}
	if next.Pos.Z < 0 || next.Pos.Z > maxXZ {
		next.Pos.Z = math.Max(0, math.Min(maxXZ, next.Pos.Z))
		next.Vel.Z = 0
	}

	// Max-speed validation per mode (spec 9 security). The step itself is
	// ours, so this only trips on bugs; the violator snaps back to the last
	// valid state with no horizontal momentum, and the client's
	// reconciliation shows that as a correction.
	if !vertOK || !horizOK || math.IsNaN(next.Pos.X+next.Pos.Y+next.Pos.Z) {
		e.Move = e.prevValid
		e.Move.Vel.X, e.Move.Vel.Z = 0, 0
		return false
	}
	if respawned(e.Move, next) {
		e.drownedEvent = true
	}
	e.Move = next
	e.prevValid = next
	return true
}

func errorsIsSkip(err error) bool { return errors.Is(err, writebehind.ErrSkip) }
