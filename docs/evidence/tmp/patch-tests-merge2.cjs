const fs = require('fs');
const p = 'server/zone/zone_explore_integration_test.go';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b) => {
  if (!s.includes(a)) throw new Error('missing ' + a.slice(0, 70));
  s = s.replace(a, b);
};
rep(`	// Spawn 3 m outside the tower's footprint, due west of its axis.
	sx, sz := tw.CX-tw.MaxR-3, tw.CZ`, `	// Spawn 3 m outside the tower's footprint on its uphill side (WP10: the
	// walls are climbed with stamina, and on a slope the downhill face is
	// taller than one wheel climbs; the uphill face plus a rest on the ledge
	// is the intended route).
	best, ang := math.Inf(-1), 0.0
	for k := 0; k < 16; k++ {
		a := float64(k) * math.Pi / 8
		if h := ground.HeightAt(tw.CX+math.Cos(a)*(tw.MaxR+3), tw.CZ+math.Sin(a)*(tw.MaxR+3)); h > best {
			best, ang = h, a
		}
	}
	sx, sz := tw.CX+math.Cos(ang)*(tw.MaxR+3), tw.CZ+math.Sin(ang)*(tw.MaxR+3)
	dx, dz := -math.Cos(ang), -math.Sin(ang) // toward the axis`);
rep(`	east := -math.Pi / 2
	sim := movement.NewState(movement.Vec3{X: sx, Y: g0, Z: sz})
	eastYaw := proto.U16ToYaw(proto.YawToU16(east)) // plan with the angle the zone decodes
	plan, _ := movement.PlanClimb(sim, eastYaw, ground, func(s movement.State) bool { return s.Pos.Y >= tw.TopY-1e-6 && s.Pos.X >= tw.CX }, 5000)`, `	face := math.Atan2(-dx, -dz) // forward = (-sin yaw, -cos yaw) = (dx, dz)
	sim := movement.NewState(movement.Vec3{X: sx, Y: g0, Z: sz})
	faceYaw := proto.U16ToYaw(proto.YawToU16(face)) // plan with the angle the zone decodes
	plan, _ := movement.PlanClimb(sim, faceYaw, ground, func(s movement.State) bool {
		return s.Pos.Y >= tw.TopY-1e-6 && (s.Pos.X-tw.CX)*dx+(s.Pos.Z-tw.CZ)*dz >= 0
	}, 5000)`);
rep(`		f := proto.InputFrame{Seq: uint32(i + 1), Flags: fl, Yaw: proto.YawToU16(east)}`, `		f := proto.InputFrame{Seq: uint32(i + 1), Flags: fl, Yaw: proto.YawToU16(face)}`);
fs.writeFileSync(p, s);
console.log('ok');
