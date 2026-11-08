# tools/creator: WorldSpec creator tool (WP17)

Mints worlds (spec 6). A world is `(seed, WorldSpec, genVersion)`; minting
stores `(seed, spec, genVersion, atlasHash)` as a row in the `worlds` table and
that row is the world. Three ways to make the spec, in order of preference:

1. **From the seed** (default): `spec_from_seed(seed)` in worldgen.wasm picks
   every field. The page starts here; minting sends only the seed and the
   endpoint stores the generator's spec untouched.
2. **Presets + sliders**: seven presets (Archipelago, Highland, Badlands, plus
   the original Frostreach, Mirewood, Verdant Vale, Starfall Wilds) laid over
   the seed's spec, a slider for every numeric field (ranges from the
   generated `WORLDSPEC_RANGES`, weights grouped with their share), pickers
   for palette, name grammar and up to 4 loot themes, a name field.
3. **Vibe text** (optional, last resort): only when the endpoint runs with
   `LODESTONE_CREATOR_LLM=1` and `ANTHROPIC_API_KEY`. The result fills the
   sliders and stays editable. Flag off or a failed call: a short notice and
   the sliders keep working.

The live 2D atlas preview (biomes with hillshade, sea, lakes, rivers, regions
with names and elements, towers, settlements to scale, structures, cave
mouths, waypoints, landmarks, camps, spawn, plus summary stats and a region
table) is built in a Web Worker by the same worldgen.wasm, debounced 200 ms
and latest-wins. Rendering is adapted from `worldgen/debug/`.

Never runs for players, at runtime or per chunk. Only the endpoint can call a
model, and only the clamped name and the enum fields of a validated spec can
ever reach players.

| Path | What |
| --- | --- |
| `web/` | Vite app (vanilla TS): `src/main.ts` page, `src/preview/` worker + renderer, `src/spec/` normalize, schema, presets, slider layout, `src/api.ts` endpoint client |
| `server/` | Go endpoint (module `lodestone/tools/creator/server`, README there) |
| `fixtures/normalize.json` | Shared TS/Go normalize fixtures (generated, do not edit) |
| `test/` | vitest: normalize + fixture freshness, presets (incl. through the wasm), slider coverage |
| `scripts/e2e.mjs` | Headless acceptance run (evidence in `docs/evidence/wp17-*`) |
| `scripts/gen-fixtures.ts` | Regenerates `fixtures/normalize.json` from `test/fixture-cases.ts` |

## Validation and clamping (identical in TS and Go)

Every creator spec (sliders, presets, vibe) goes through `normalize`
(`web/src/spec/normalize.ts`, ported line by line to
`server/internal/spec/normalize.go`):

1. **Structural validation** against `contracts/worldspec.schema.json` with
   exactly the constraints the clamp repairs removed (numeric ranges, integer
   type, name length/pattern, loot tag enum/count/uniqueness). Missing or
   extra keys, wrong types, an unknown palette or name grammar, a malformed
   seed: rejected.
2. **Clamp** in the schema's `required` order: numbers to range; integers
   rounded half up; each weight group clamped to [0, 1] then divided by its
   max (the generator's own normalization, exactly idempotent; all zero ->
   all 1); name: disallowed characters to spaces, collapsed, trimmed, cut to
   40, rejected if under 3 characters or if a word starts with a blocked stem
   (the worldgen name blocklist); seed canonical decimal, > 2^64-1 rejected;
   unknown, repeated and surplus loot tags dropped.
3. **Strict validation** against the contract schema.

`fixtures/normalize.json` (42 cases) holds inputs and the TS output; the Go
test must produce the same specs (exact float equality) and the same change
lists. The browser preview hashes exactly what the endpoint mints: the e2e
run checks the server's atlas hash equals the preview's for every mint.

## Run

```
npm run infra:up && npm run migrate && npm run build:wasm
npm run server -w @lodestone/creator      # Go endpoint on :8094 (LODESTONE_CREATOR_PORT)
npm run dev -w @lodestone/creator         # web app on http://localhost:5177 (LODESTONE_CREATOR_WEB_PORT), /v1 proxied to :8094
```

Open `http://localhost:5177/?seed=20261108` (any uint64; `&token=` if the
endpoint requires one). The preview works without the endpoint; minting and
the world list need it.

## Test

```
npm test -w @lodestone/creator             # vitest (wasm tests skip if worldgen.wasm is missing; LODESTONE_REQUIRE_WASM=1 fails instead)
npm run typecheck -w @lodestone/creator
cd tools/creator/server && go test ./...   # Go unit + process integration (scratch DB; LODESTONE_REQUIRE_INFRA=1 to fail when infra is down)
npm run e2e -w @lodestone/creator          # headless acceptance: seed, presets, sliders, vibe (fake model), flag off
npm run fixtures -w @lodestone/creator     # after changing normalize.ts or fixture-cases.ts; then rerun the Go tests
```

The e2e run uses its own ports (API 18194, web 15177, fake model 18195), a
scratch database (`lodestone_wp04_wp17e2e`, dropped afterwards) and removes its
vibe cache key from the shared Redis.
