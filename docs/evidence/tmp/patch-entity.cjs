const fs = require('fs');
const p = 'server/zone/internal/game/entity.go';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b) => {
  if (!s.includes(a)) throw new Error('missing ' + a.slice(0, 70));
  s = s.replace(a, b);
};
rep(`	Health     uint16
	HealthMax  uint16
	Stamina    float64
	StaminaMax float64
	LastSeq    uint32 // newest applied input frame (acked in snapshots)
`, `	Health     uint16
	HealthMax  uint16
	LastSeq    uint32 // newest applied input frame (acked in snapshots)
	// Stamina, mode and the traversal timers live in Move (WP10): they are
	// part of the shared step and travel in SelfState.

	drownedEvent bool // WP10: a frame this tick drowned + respawned the player (Event 100)
`);
rep(`func (e *Entity) updateView(g movement.Ground) {`, `func (e *Entity) updateView(g movement.Ground, env movement.Env) {`);
rep(`			e.view = movement.StepFrame(e.view, f, g)`, `			e.view = movement.StepFrameEnv(e.view, f, g, env)`);
rep(`		f.Flags &^= proto.InputFlagJump | proto.InputFlagJumpEdge`, `		f.Flags &^= proto.InputFlagJump | proto.InputFlagJumpEdge | proto.InputFlagGlideToggle`);
rep(`func (e *Entity) quantize(g movement.Ground) {
	var act uint8
	if !movement.Grounded(e.view, g) {
		act |= proto.ActivityAirborne
	}
`, `func (e *Entity) quantize(_ movement.Ground) {
	// WP10: activity bits (climbing, gliding, swimming, airborne) come from
	// the step's mode, so remote players can pose them.
	act := movement.Activity(e.view)
`);
rep(`func (e *Entity) selfState(g movement.Ground) proto.SelfState {
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
}`, `// WP10: the whole movement state (mode, exact stamina, timers, flags) so
// the client can replay from it (movement.SelfFields, protocol v2).
func (e *Entity) selfState(_ movement.Ground) proto.SelfState {
	st := proto.SelfState{Health: e.Health, HealthMax: e.HealthMax}
	movement.SelfFields(&st, e.Move)
	return st
}`);
rep(`func (e *Entity) applyFrame(f proto.InputFrame, g movement.Ground) bool {
	next := movement.StepFrame(e.Move, f, g)`, `func (e *Entity) applyFrame(f proto.InputFrame, g movement.Ground, env movement.Env) bool {
	next := movement.StepFrameEnv(e.Move, f, g, env)`);
rep(`	vertOK := verticalOK(e.Move, next, g) // WP07, terrain.go; before the clamp`, `	vertOK := verticalOK(e.Move, next, g) // WP07/WP10, traversal.go; before the clamp
	horizOK := horizontalOK(e.Move, next) // per mode (WP10)`);
rep(`	// Max-speed validation (spec 9 security). The step itself is ours, so
	// this only trips on bugs or on modes the server doesn't simulate yet;
	// the violator snaps back to the last valid state with no horizontal
	// momentum, and the client's reconciliation shows that as a correction.
	if !vertOK || movement.HorizontalSpeed(next) > movement.MaxLegitHorizontalSpeed || math.IsNaN(next.Pos.X+next.Pos.Y+next.Pos.Z) {
		e.Move = e.prevValid
		e.Move.Vel.X, e.Move.Vel.Z = 0, 0
		return false
	}
	e.Move = next`, `	// Max-speed validation per mode (spec 9 security). The step itself is
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
	e.Move = next`);
fs.writeFileSync(p, s);
console.log('ok');
