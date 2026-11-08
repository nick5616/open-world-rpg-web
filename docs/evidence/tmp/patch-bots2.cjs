const fs = require('fs');
let p = 'tools/bots/bot.go';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b) => {
  if (!s.includes(a)) throw new Error('missing ' + a.slice(0, 70));
  s = s.replace(a, b);
};
rep(`	state    movement.State
	welcomed bool
`, `	state    movement.State
	welcomed bool
	seed     uint64 // world seed from Welcome: the weather stub's rain (WP10)
`);
rep(`				b.state = movement.StepFrame(b.state, f, b.cfg.ground())`, `				// WP10: same env as the zone (rain from the weather stub at
				// world time; bots share the zone's clock on one machine).
				env := movement.Env{Raining: weather.IsRaining(b.seed, weather.WorldTimeS(nowMs()))}
				b.state = movement.StepFrameEnv(b.state, f, b.cfg.ground(), env)`);
rep(`			b.welcomed = true
			b.st.Connected = true
`, `			b.welcomed = true
			b.st.Connected = true
			b.seed = msg.Seed
`);
rep(`	"lodestone/server/pkg/transport"
	"lodestone/server/pkg/worldhost"`, `	"lodestone/server/pkg/transport"
	"lodestone/server/pkg/weather"
	"lodestone/server/pkg/worldhost"`);
fs.writeFileSync(p, s);
console.log('ok');
