const fs = require('fs');
function patch(p, pairs) {
  let s = fs.readFileSync(p, 'utf8');
  for (const [a, b] of pairs) {
    if (!s.includes(a)) throw new Error(p + ' missing ' + a.slice(0, 70));
    s = s.replace(a, b);
  }
  fs.writeFileSync(p, s);
}
patch('server/pkg/movement/terrain_golden_test.go', [
  [`	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/worldhost"`, `	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/worldhost"`],
  [`		Kind       string \`json:"kind"\`
		Seed       string \`json:"seed"\``, `		Kind       string \`json:"kind"\`
		Seed       string \`json:"seed"\`
		Structures string \`json:"structures"\` // "towers": terrain + WP12's tower overlay`],
  [`		for _, ground := range []struct {
			name string
			g    movement.Ground
		}{{"wasm", wasmGround{w}}, {"terrain", tr}} {`, `		grounds := []struct {
			name string
			g    movement.Ground
		}{{"wasm", wasmGround{w}}, {"terrain", tr}}
		if g.Ground.Structures == "towers" {
			// The ground the zone runs since WP12: towers over the terrain
			// (structures.Towers samples the plain terrain; same bits either way).
			a, err := structures.ParseAtlas(w.Atlas)
			if err != nil {
				t.Fatal(err)
			}
			for i := range grounds {
				o, _ := structures.Towers(a, grounds[i].g)
				grounds[i].g = structures.Wrap(grounds[i].g, o)
				grounds[i].name += "+towers"
			}
		}
		for _, ground := range grounds {`],
  [`			if ground.name == "terrain" {`, `			if ground.name != "wasm" && ground.name != "wasm+towers" {`],
]);
patch('server/zone/internal/game/traversal_test.go', [
  [`	"lodestone/server/pkg/proto"
)`, `	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/structures"
)`],
  [`		var g struct {
			Scenario string \`json:"scenario"\``, `		var g struct {
			Scenario string \`json:"scenario"\`
			Ground   struct {
				Structures string \`json:"structures"\`
			} \`json:"ground"\``],
  [`		r := g.Initial
		e := &Entity{`, `		var ground movement.Ground = tr
		if g.Ground.Structures == "towers" {
			a, err := structures.ParseAtlas(tr.World().Atlas)
			if err != nil {
				t.Fatal(err)
			}
			o, _ := structures.Towers(a, tr)
			ground = structures.Wrap(tr, o) // what the zone runs since WP12
		}
		r := g.Initial
		e := &Entity{`],
  [`			if !e.applyFrame(proto.InputFrame{Seq: uint32(fr[0]), Flags: uint16(fr[1]), Yaw: uint16(fr[2]), Pitch: int16(fr[3])}, tr, env) {`, `			if !e.applyFrame(proto.InputFrame{Seq: uint32(fr[0]), Flags: uint16(fr[1]), Yaw: uint16(fr[2]), Pitch: int16(fr[3])}, ground, env) {`],
]);
console.log('ok');
