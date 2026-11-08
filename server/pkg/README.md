# server/pkg

Shared Go packages for every service (module `lodestone/server/pkg`).

| Package | What |
| --- | --- |
| `proto` | Zone wire protocol: generated codec (`protocol_gen.go`), hand-written primitive runtime (`wire.go`), quantization (`quant.go`) |
| `constants` | Generated from `contracts/constants.yaml` |
| `socialproto` | Generated social socket JSON types |
| `worldspec` | Generated WorldSpec struct, ranges and enums |
| `env` | Env-var config with local defaults |
| `svc` | Service shell: JSON logs, `/healthz`, `/metrics`, graceful shutdown, CORS |
| `migrate`, `cmd/migrate` | Applies `contracts/migrations` (`npm run migrate`) |
| `ticket` | Ed25519 connect tickets (director signs, zone/social verify); dev key when env unset |
| `zoneregistry` | Redis `zones:{worldId}` registry: zones announce, director picks |
| `movement` | Authoritative movement step (wizard-wars port); the contract WP02's TS prediction mirrors, with trajectory vectors (see its README) |
| `gameloop` | Shared fixed-rate scheduler: one grid, coarse sleep + spin tail (`LODESTONE_SPIN_MS`), bounded catch-up, debt forgiveness, tick/jitter stats; QPC clock on Windows |
| `transport` | `Conn` interface with reliable vs unreliable (latest-wins) sends; WebSocket server/dialer; WebTransport stub |
| `snapshot` | Delta snapshots: per-client baseline ring encoder and the reference client decoder |
| `ratelimit` | Token bucket (the-circle pattern) |
| `writebehind` | Bounded, coalescing, retrying write-behind queue with flush on shutdown |
| `accountapi` | (WP04) Session tokens + shared Postgres queries for accounts, local profiles, worlds, characters; `dbtest` scratch-DB helper |
| `localsave` | (WP04) Local-profile save blobs: Ed25519 sign/verify + Redis newest-counter check |
| `worldhost` | (WP07) wazero host for `worldgen.wasm`: pooled instances, chunk cache by interest (`Terrain`, a `movement.Ground`), genVersion/atlas-hash pin, minting, land spawns; `worldhost/mintdb` writes minted `worlds` rows (see its README) |
| `cmd/mintworld` | (WP07) Mint a world / the official row from a seed |
| `cmd/heightcmp` | (WP07) Bitwise ground comparison: Go/wazero vs Node vs headless Chromium |

Test: `go test ./...` (includes the protocol golden vectors).
