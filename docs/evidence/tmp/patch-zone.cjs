const fs = require('fs');
const Z = 'server/zone/';
const rep = (p, a, b) => {
  p = Z + p;
  let s = fs.readFileSync(p, 'utf8');
  if (!s.includes(a)) throw new Error(p + ': missing ' + a.slice(0, 60));
  s = s.replace(a, b);
  fs.writeFileSync(p, s);
};
rep('internal/game/metrics.go', `	speedViolations atomic.Int64`, `	speedViolations atomic.Int64
	drowned         atomic.Int64 // WP10: drowning respawns`);
rep('internal/game/metrics.go', `	r.SetInt("zone_speed_violations_total", s.m.speedViolations.Load())`, `	r.SetInt("zone_speed_violations_total", s.m.speedViolations.Load())
	r.SetInt("zone_drowned_total", s.m.drowned.Load())`);
rep('internal/game/server.go', `	Ground       movement.Ground
	SpinTail     time.Duration`, `	Ground       movement.Ground
	// WP10: the updraft hook for the movement step (debug columns from
	// LODESTONE_ZONE_DEBUG_UPDRAFTS until WP15 feeds it) and a rain
	// override (nil: the weather stub decides from seed + world time).
	Updraft      movement.UpdraftField
	Rain         *bool
	SpinTail     time.Duration`);
rep('internal/game/server.go', `	saveDiv  uint32
`, `	saveDiv  uint32
	env      movement.Env // WP10: this tick's movement env (stepEnv)
`);
rep('internal/game/server.go', `	tick := s.tick
	now := time.Now()
`, `	tick := s.tick
	now := time.Now()
	s.env = s.stepEnv() // WP10: rain + updrafts for every step this tick
`);
rep('internal/game/server.go', `		e.updateView(s.cfg.Ground)`, `		e.updateView(s.cfg.Ground, s.env)`);
rep('internal/game/server.go', `		Health:      100,
		HealthMax:   100,
		Stamina:     constants.StaminaMax,
		StaminaMax:  constants.StaminaMax,
	}
	s.nextID++
	e.Move.Pos = spawn`, `		Health:      100,
		HealthMax:   100,
	}
	s.nextID++
	e.Move = movement.NewState(spawn) // WP10: full stamina wheel, ground mode`);
rep('internal/game/session.go', `		e.applyFrame(f, s.cfg.Ground)
		s.m.framesSynthesized.Add(1)`, `		e.applyFrame(f, s.cfg.Ground, s.env)
		s.m.framesSynthesized.Add(1)`);
rep('internal/game/session.go', `		if !e.applyFrame(f, s.cfg.Ground) {
			s.m.speedViolations.Add(1)
		}
		s.m.frames.Add(1)
	}`, `		if !e.applyFrame(f, s.cfg.Ground, s.env) {
			s.m.speedViolations.Add(1)
		}
		s.m.frames.Add(1)
	}
	if e.drownedEvent {
		e.drownedEvent = false
		s.sendDrowned(sess)
	}`);
let t = fs.readFileSync(Z + 'internal/game/terrain.go', 'utf8');
const i = t.indexOf('// verticalOK is the terrain half');
if (i < 0) throw new Error('no verticalOK');
t = t.slice(0, i).trimEnd() + '\n\n// verticalOK (WP07) moved to traversal.go when WP10 extended it per mode.\n';
fs.writeFileSync(Z + 'internal/game/terrain.go', t);
console.log('ok');
