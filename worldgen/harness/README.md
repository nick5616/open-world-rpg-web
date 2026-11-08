# worldgen determinism harness

Hosts that run the golden table (`worldgen/golden/golden.json`) against the
same `worldgen/pkg/worldgen.wasm`. `npm run test:golden` builds the wasm and
runs all of them, writing `docs/evidence/wp01-golden.txt`.

| Host | Where | Run alone |
| --- | --- | --- |
| Node | `worldgen/js/test/golden.test.ts` | `npm test -w @lodestone/worldgen` |
| Chromium, Web Worker | `browser/` (`index.html` + `worker.ts`, served by the debug Vite server on port 5180, driven by Playwright in `run.mjs`) | `node worldgen/harness/browser/run.mjs [--bench 200] [--json out.json]` |
| Go, wazero compiler + interpreter | `go/` (module `lodestone/worldgen/harness`, in `go.work`) | `cd worldgen/harness/go && go test -v ./...` |
| Native Rust (bonus) | `worldgen/tests/golden_native.rs` | `cargo test -p worldgen --release --test golden_native` |

The Chromium run also measures the spec 12 budget: 200 LOD-0 detail chunks
across the world, built in a Web Worker in a cross-origin-isolated page (so
`performance.now()` is precise), and fails if p95 exceeds 8 ms.

`go/wghost.go` is a minimal Go binding of the ABI (`AtlasBuild`,
`ChunkBuild`, `CollisionHeight`, `Hash`). WP07's `server/pkg/worldhost` can
start from it; copy rather than import, since this module only exists for
the harness. The wazero interpreter test (a second execution engine) takes
~30 s and runs only when `LODESTONE_REQUIRE_WASM=1` (set by `test:golden`).
Without a built wasm, the Go and Node golden tests skip so `npm test` works
before `npm run build:wasm`.
