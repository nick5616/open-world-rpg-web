package movement

import (
	"math"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/proto"
)

// SelfState packing (protocol.yaml v2, CR 004). Position and velocity are
// cm-quantized as before; the WP10 state travels exactly: flags bits 0-3 are
// Flag*, bits 4-7 the lunge counter; moveExt is stamina (fine units) in bits
// 0-15 and the mode timer in bits 16-23. The TS twin is client/src/sim/moveWire.ts.

// PackFlags is SelfState.flags for s.
func PackFlags(s State) uint8 { return s.Flags&0x0f | uint8(s.Lunge&0x0f)<<4 }

// PackMoveExt is SelfState.moveExt for s.
// WP13 (CR 005, protocol v3): bits 24-27 dash steps, 28-31 i-frame steps.
func PackMoveExt(s State) uint32 {
	return uint32(s.Stamina&0xffff) | uint32(s.Timer&0xff)<<16 | uint32(s.Dash&0xf)<<24 | uint32(s.IFrames&0xf)<<28
}

// StaminaX10 converts fine units to the display field (x10, one decimal).
func StaminaX10(fine int) uint16 {
	return uint16(math.Round(float64(fine) * 10 / constants.StaminaFinePerPoint))
}

// SelfFields fills the movement half of a SelfState (position, velocity,
// stamina, mode, airJumps, activity, flags, moveExt). Health is the caller's.
func SelfFields(st *proto.SelfState, s State) {
	st.X = proto.MetersToCm(s.Pos.X)
	st.Y = proto.MetersToCm(s.Pos.Y)
	st.Z = proto.MetersToCm(s.Pos.Z)
	st.Vx = proto.VelToCms(s.Vel.X)
	st.Vy = proto.VelToCms(s.Vel.Y)
	st.Vz = proto.VelToCms(s.Vel.Z)
	st.Stamina = StaminaX10(s.Stamina)
	st.StaminaMax = StaminaX10(s.StaminaMax)
	st.Mode = proto.MoveMode(s.Mode)
	st.AirJumps = uint8(s.AirJumps)
	st.Activity = Activity(s)
	st.Flags = PackFlags(s)
	st.MoveExt = PackMoveExt(s)
}

// FromSelf rebuilds the replayable state from a SelfState with full values
// (what a client does before replaying unacked input; the bots use it).
func FromSelf(st proto.SelfState) State {
	return State{
		Pos:        Vec3{proto.CmToMeters(st.X), proto.CmToMeters(st.Y), proto.CmToMeters(st.Z)},
		Vel:        Vec3{proto.CmsToVel(st.Vx), proto.CmsToVel(st.Vy), proto.CmsToVel(st.Vz)},
		AirJumps:   int(st.AirJumps),
		Mode:       int(st.Mode),
		Stamina:    int(st.MoveExt & 0xffff),
		StaminaMax: int(math.Round(float64(st.StaminaMax) * constants.StaminaFinePerPoint / 10)),
		Timer:      int(st.MoveExt >> 16 & 0xff),
		Lunge:      int(st.Flags >> 4),
		Flags:      st.Flags & 0x0f,
		Dash:       int(st.MoveExt >> 24 & 0xf),
		IFrames:    int(st.MoveExt >> 28 & 0xf),
	}
}
