package game

import (
	"errors"
	"math"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/snapshot"
	"lodestone/server/pkg/writebehind"
)

// Entity is one simulated thing in the zone. Only players exist in WP03;
// enemies, pickups and projectiles reuse the same record (spec 8).
type Entity struct {
	ID          uint32
	Kind        proto.EntityKind
	Name        string
	CharacterID string
	Level       uint8
	PartyID     uint32 // 0 = none; party ids arrive with WP08 (stub field)

	Move       movement.State
	Yaw, Pitch float64 // radians, from the newest applied input
	Health     uint16
	HealthMax  uint16
	Stamina    float64
	StaminaMax float64
	LastSeq    uint32 // newest applied input frame (acked in snapshots)

	prevValid movement.State // last state that passed validation
	idx       int32          // index in Server.ents this tick (grid payload)
	q         snapshot.EntState
}

// quantize refreshes the wire view others see (spec 9 quantization).
func (e *Entity) quantize(g movement.Ground) {
	var act uint8
	if !movement.Grounded(e.Move, g) {
		act |= proto.ActivityAirborne
	}
	hp := uint8(0)
	if e.HealthMax > 0 {
		hp = uint8(math.Round(float64(e.Health) * 100 / float64(e.HealthMax)))
	}
	e.q = snapshot.EntState{
		ID:        e.ID,
		Kind:      e.Kind,
		X:         proto.MetersToCm(e.Move.Pos.X),
		Y:         proto.MetersToCm(e.Move.Pos.Y),
		Z:         proto.MetersToCm(e.Move.Pos.Z),
		Yaw:       proto.YawToU8(e.Yaw),
		Pitch:     proto.PitchToU8(e.Pitch),
		Vx:        proto.VelToCms(e.Move.Vel.X),
		Vy:        proto.VelToCms(e.Move.Vel.Y),
		Vz:        proto.VelToCms(e.Move.Vel.Z),
		HealthPct: hp,
		Activity:  act,
		Name:      e.Name,
		Level:     e.Level,
		PartyID:   e.PartyID,
	}
}

// selfState is the player's own authoritative state, exact health, for
// reconciliation. Position/velocity here are what the client replays from.
func (e *Entity) selfState(g movement.Ground) proto.SelfState {
	mode := proto.MoveModeGround
	var act uint8
	if !movement.Grounded(e.Move, g) {
		mode = proto.MoveModeAir
		act |= proto.ActivityAirborne
	}
	return proto.SelfState{
		X:          proto.MetersToCm(e.Move.Pos.X),
		Y:          proto.MetersToCm(e.Move.Pos.Y),
		Z:          proto.MetersToCm(e.Move.Pos.Z),
		Vx:         proto.VelToCms(e.Move.Vel.X),
		Vy:         proto.VelToCms(e.Move.Vel.Y),
		Vz:         proto.VelToCms(e.Move.Vel.Z),
		Health:     e.Health,
		HealthMax:  e.HealthMax,
		Stamina:    uint16(math.Round(e.Stamina * 10)),
		StaminaMax: uint16(math.Round(e.StaminaMax * 10)),
		Mode:       mode,
		AirJumps:   uint8(e.Move.AirJumps),
		Activity:   act,
	}
}

// applyFrame steps movement for one input frame and validates the result.
// Returns false if the step was rejected and the player snapped back.
func (e *Entity) applyFrame(f proto.InputFrame, g movement.Ground) bool {
	next := movement.StepFrame(e.Move, f, g)
	e.Yaw = proto.U16ToYaw(f.Yaw)
	e.Pitch = proto.I16ToPitch(f.Pitch)
	e.LastSeq = f.Seq
	vertOK := verticalOK(e.Move, next, g) // WP07, terrain.go; before the clamp

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

	// Max-speed validation (spec 9 security). The step itself is ours, so
	// this only trips on bugs or on modes the server doesn't simulate yet;
	// the violator snaps back to the last valid state with no horizontal
	// momentum, and the client's reconciliation shows that as a correction.
	if !vertOK || movement.HorizontalSpeed(next) > movement.MaxLegitHorizontalSpeed || math.IsNaN(next.Pos.X+next.Pos.Y+next.Pos.Z) {
		e.Move = e.prevValid
		e.Move.Vel.X, e.Move.Vel.Z = 0, 0
		return false
	}
	e.Move = next
	e.prevValid = next
	return true
}

func errorsIsSkip(err error) bool { return errors.Is(err, writebehind.ErrSkip) }
