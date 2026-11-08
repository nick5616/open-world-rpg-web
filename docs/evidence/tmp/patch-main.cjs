const fs = require('fs');
const p = 'server/zone/main.go';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b) => {
  if (!s.includes(a)) throw new Error('missing ' + a.slice(0, 70));
  s = s.replace(a, b);
};
rep(`//	LODESTONE_PG_URL, LODESTONE_REDIS_ADDR
package main`, `//	LODESTONE_ZONE_DEBUG_UPDRAFTS  WP10: "x,z,radius,top,lift[;...]" debug updraft columns (client: ?updraft=...)
//	LODESTONE_ZONE_DEBUG_RAIN      WP10: 1 = always rain, 0 = never (default: the seeded weather stub)
//	LODESTONE_PG_URL, LODESTONE_REDIS_ADDR
package main`);
rep(`	cfg := game.Config{`, `	updraft, rain := game.DebugEnvFromEnv() // WP10 dev overrides of the movement env
	if updraft != nil || rain != nil {
		log.Warn("debug movement env active", "updrafts", os.Getenv("LODESTONE_ZONE_DEBUG_UPDRAFTS"), "rain", os.Getenv("LODESTONE_ZONE_DEBUG_RAIN"))
	}
	cfg := game.Config{`);
rep(`		Ground:     ground, // WP07: wasm terrain (terrain.go), flat only without worldgen.wasm
`, `		Ground:     ground, // WP07: wasm terrain (terrain.go), flat only without worldgen.wasm
		Updraft:    updraft,
		Rain:       rain,
`);
fs.writeFileSync(p, s);
console.log('ok');
