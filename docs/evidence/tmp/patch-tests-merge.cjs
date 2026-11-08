const fs = require('fs');
function patch(p, pairs) {
  let s = fs.readFileSync(p, 'utf8');
  for (const [a, b] of pairs) {
    if (!s.includes(a)) throw new Error(p + ' missing ' + a.slice(0, 70));
    s = s.replace(a, b);
  }
  fs.writeFileSync(p, s);
}
patch('server/zone/internal/game/game_test.go', [
  [`		SpinTail: time.Millisecond, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if mod != nil {`, `		SpinTail: time.Millisecond, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	dry := false
	cfg.Rain = &dry // WP10: deterministic weather (the stub would follow the wall clock)
	if mod != nil {`],
]);
patch('server/zone/internal/game/explore_test.go', [
  [`	// Walk east into the tower: the walls are part of the ground, so (until
	// WP10 adds slope limits) the ground snap carries the player up them,
	// exactly as prediction does on the client.
	cl.stepWalk(150, proto.InputFlagForward, east)`, `	// Walk east into the tower and climb it the WP10 way: 80 degree walls
	// are climbed with stamina, resting on the ledge between the lower and
	// upper wall to refill the wheel. PlanClimb predicts exactly the steps
	// the zone runs, so these inputs put the player on the top.
	g := h.srv.cfg.Ground
	tw := h.srv.cfg.Explore.Towers[0].Shape
	plan, end := movement.PlanClimb(movement.NewState(movement.Vec3{X: 86, Y: g.HeightAt(86, 100), Z: 100}), east, g, func(s movement.State) bool {
		return s.Pos.Y >= tw.TopY-1e-6 && s.Pos.X >= tw.CX-2
	}, 4000)
	if end.Pos.Y < tw.TopY-1e-6 {
		t.Fatalf("planned climb does not reach the top: %+v (top %v)", end, tw.TopY)
	}
	for i := 0; i < len(plan); {
		j := i
		for j < len(plan) && plan[j] == plan[i] {
			j++
		}
		cl.stepWalk(j-i, plan[i], east)
		i = j
	}`],
]);
patch('server/zone/zone_explore_integration_test.go', [
  [`	// Walk east (+x) through the tower: up the lower wall, across the
	// ledge, up the upper wall, onto the top. Predict every step locally.
	east := -math.Pi / 2
	sim := movement.State{Pos: movement.Vec3{X: sx, Y: g0, Z: sz}}
	steps := int(math.Ceil((tw.MaxR+3)/(4.8/60))) + 30 // walking speed ~4.9 m/s
	var frames []proto.InputFrame
	maxY := sim.Pos.Y
	for seq := uint32(1); seq <= uint32(steps); seq++ {
		f := proto.InputFrame{Seq: seq, Flags: proto.InputFlagForward, Yaw: proto.YawToU16(east)}
		frames = append(frames, f)
		sim = movement.StepFrame(sim, f, ground)
		maxY = math.Max(maxY, sim.Pos.Y)
		if sim.Pos.X >= tw.CX { // stop on the top, at the axis
			break
		}
	}`, `	// Walk east (+x) into the tower and climb it the WP10 way: up the lower
	// wall with stamina, rest on the ledge until the wheel is full, up the
	// upper wall, mantle onto the top, walk to the axis. Predict every step
	// locally (movement.PlanClimb; the zone runs with rain off).
	east := -math.Pi / 2
	sim := movement.NewState(movement.Vec3{X: sx, Y: g0, Z: sz})
	eastYaw := proto.U16ToYaw(proto.YawToU16(east)) // plan with the angle the zone decodes
	plan, _ := movement.PlanClimb(sim, eastYaw, ground, func(s movement.State) bool { return s.Pos.Y >= tw.TopY-1e-6 && s.Pos.X >= tw.CX }, 5000)
	var frames []proto.InputFrame
	maxY := sim.Pos.Y
	climbed := false
	for i, fl := range plan {
		f := proto.InputFrame{Seq: uint32(i + 1), Flags: fl, Yaw: proto.YawToU16(east)}
		frames = append(frames, f)
		sim = movement.StepFrame(sim, f, ground)
		maxY = math.Max(maxY, sim.Pos.Y)
		climbed = climbed || sim.Mode == movement.ModeClimb
	}
	if !climbed {
		t.Fatal("the tower walls were not climbed (WP10)")
	}`],
  [`	deadline := time.Now().Add(15 * time.Second)`, `	deadline := time.Now().Add(time.Duration(len(frames))*time.Second/30 + 15*time.Second)`],
  [`		"LODESTONE_ZONE_NO_DB=1",`, `		"LODESTONE_ZONE_NO_DB=1",
		"LODESTONE_ZONE_DEBUG_RAIN=0", // WP10: the prediction below assumes dry weather`],
]);
console.log('ok');
