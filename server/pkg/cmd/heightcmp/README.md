# server/pkg/cmd/heightcmp

WP07 acceptance check: server and client ground heights match exactly. For
one world (default: the official seed 20261108) it evaluates the ground at N
points (`worldhost.SamplePoints`) in seven ways and compares f64 bit
patterns against `go-wasm` (wazero compiler `collision_height`):

| Column | Host |
| --- | --- |
| `go-fast` | `worldhost.Terrain` pure-Go formula on cached chunk heights (the zone's hot path) |
| `go-interp` | wazero interpreter (atlas rebuilt there too) |
| `node-wasm`, `node-chunk` | `@lodestone/worldgen` `collisionHeight` / `chunkSurfaceHeight` in Node, child process (`worldhost/jscheck/heights.mjs` via vite-node) |
| `chromium-wasm`, `chromium-chunk` | the same inside a headless Chromium Web Worker (`worldhost/jscheck/browser.mjs`, playwright + Vite) |

```
npm install && npm run build:wasm && npx playwright install chromium
go run ./server/pkg/cmd/heightcmp -n 10000 -out docs/evidence/wp07-heights.txt -table docs/evidence/wp07-heights-table.csv.gz
```

Exit code 1 on any mismatch. Flags: `-seed`, `-n`, `-points-seed`, `-node`,
`-chromium`, `-interp`, `-out`, `-table`.

Test: `go test ./cmd/heightcmp` (from `server/pkg`) runs 400 points against
Node in a child process (Chromium too with `LODESTONE_HEIGHTCMP_CHROMIUM=1`).
