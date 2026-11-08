package movement

import "lodestone/server/pkg/proto"

// PlanClimb plans the input of a player who walks forward (at yaw, radians)
// from s, climbs whatever steep ground is in the way the WP10 way, and rests
// on every ledge a climb tops out on until the stamina wheel is full again,
// stopping when done(state) holds or after maxSteps. It predicts with Step
// (no rain, no updrafts), so the result is exactly what the zone will do with
// those inputs in dry weather. Tests and bots use it to get up towers
// (WP12's 80 degree walls with a ledge) and cliffs: holding forward all the
// way would empty the wheel on the second wall.
//
// Returns one flags value per step and the predicted state after the last.
func PlanClimb(s State, yaw float64, g Ground, done func(State) bool, maxSteps int) ([]uint16, State) {
	var flags []uint16
	resting := false
	for len(flags) < maxSteps && !done(s) {
		f := uint16(proto.InputFlagForward)
		if resting {
			f = 0
		}
		next := Step(s, f, yaw, g)
		if !resting && s.Mode == ModeClimb && next.Mode == ModeGround {
			resting = true // topped out on a ledge (or the top): get the wheel back
		} else if resting && next.Stamina >= next.StaminaMax {
			resting = false
		}
		flags = append(flags, f)
		s = next
	}
	return flags, s
}
