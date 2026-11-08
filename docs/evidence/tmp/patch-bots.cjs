const fs = require('fs');
let p = 'tools/bots/bot.go';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b) => {
  if (!s.includes(a)) throw new Error('missing ' + a.slice(0, 70));
  s = s.replace(a, b);
};
rep(`	b.state.Pos = movement.Vec3{X: x, Z: z}
	return b`, `	// WP10: a full stamina wheel, like the zone's join (sprinting drains it).
	b.state = movement.NewState(movement.Vec3{X: x, Z: z})
	return b`);
rep(`		b.state.Pos = movement.Vec3{X: proto.CmToMeters(self.X), Y: proto.CmToMeters(self.Y), Z: proto.CmToMeters(self.Z)}
		b.state.Vel = movement.Vec3{X: proto.CmsToVel(self.Vx), Y: proto.CmsToVel(self.Vy), Z: proto.CmsToVel(self.Vz)}
		b.state.AirJumps = int(self.AirJumps)`, `		// WP10: SelfState carries the whole movement state (mode, stamina, timers).
		b.state = movement.FromSelf(*self)`);
fs.writeFileSync(p, s);

p = 'server/pkg/snapshot/snapshot.go';
s = fs.readFileSync(p, 'utf8');
rep(`	set(cur.Flags != base.Flags, proto.SelfStateHasFlags)
	return out`, `	set(cur.Flags != base.Flags, proto.SelfStateHasFlags)
	set(cur.MoveExt != base.MoveExt, proto.SelfStateHasMoveExt) // WP10, protocol v2
	return out`);
rep(`	if m&proto.SelfStateHasFlags != 0 {
		s.Flags = r.Flags
	}
	s.Mask = 0`, `	if m&proto.SelfStateHasFlags != 0 {
		s.Flags = r.Flags
	}
	if m&proto.SelfStateHasMoveExt != 0 {
		s.MoveExt = r.MoveExt
	}
	s.Mask = 0`);
fs.writeFileSync(p, s);
console.log('ok');
