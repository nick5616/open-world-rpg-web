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
| `zoneregistry` | Redis `zones:{worldId}` registry: zones announce, director picks. WP16: roles (primary/pool), own TTL, `Owner` (the region owner every zone agrees on), `RegionAt`, director assignment (`Plan`, `zoneassign:{worldId}`) |
| `earshot` | (WP11) The zone -> social earshot message on Redis `voice:{worldId}` (CR 005) |
| `movement` | Authoritative movement step (wizard-wars port); the contract WP02's TS prediction mirrors, with trajectory vectors (see its README) |
| `gameloop` | Shared fixed-rate scheduler: one grid, coarse sleep + spin tail (`LODESTONE_SPIN_MS`), bounded catch-up, debt forgiveness, tick/jitter stats; QPC clock on Windows |
| `transport` | `Conn` interface with reliable vs unreliable (latest-wins) sends; WebSocket server/dialer; WebTransport server/dialer (quic-go/webtransport-go: datagrams + one length-prefixed stream), `NewDevCert` (ECDSA, <14 days, hash for `serverCertificateHashes`), `CloseCode` |
| `snapshot` | Delta snapshots: per-client baseline ring encoder (with the optional per-client byte budget and priority accumulator, decision 0005) and the reference client decoder |
| `ratelimit` | Token bucket (the-circle pattern) |
| `writebehind` | Bounded, coalescing, retrying write-behind queue with flush on shutdown |
| `accountapi` | (WP04) Session tokens + shared Postgres queries for accounts, local profiles, worlds, characters; `dbtest` scratch-DB helper |
| `localsave` | (WP04) Local-profile save blobs: Ed25519 sign/verify + Redis newest-counter check |
| `caves` | WP09: cave buffer readers, mouth masks, cave-system id, cave collision (bit-exact port of the TS queries), `Ground` (movement.LevelGround + Collider) |
| `structures` | (WP12) structure overlay on the ground query: towers (and later WP20 buildings) as height functions max-combined with the terrain, bit-identical to the TS twin in `client/src/world/structures`; Go reader of the atlas site table |
| `combatdefs` | (WP13) Go view of `contracts/combat.yaml` (embedded generated JSON): weapons, moves, spells, trees, enemies, bosses, tables, typeId packing (CR 009) |
| `itemdefs` | (WP14) Go view of `contracts/items.yaml` (embedded generated JSON): rarities and odds, materials (sunsteel `killsDemons`), gems, cuts, items, affixes, recipes, loot tables (CR 010) |
| `towns` | (WP20) towns buffer reader (settlements, buildings, boxes, props, NPCs, roads, structures) and the building collision (`Collision`, `Ground`: movement.LevelGround + Collider), bit-exact port of `worldgen/js/src/town.ts` |
| `worldhost` | (WP07) wazero host for `worldgen.wasm`: pooled instances, chunk cache by interest (`Terrain`, a `movement.Ground`), genVersion/atlas-hash pin, minting, land spawns; `worldhost/mintdb` writes minted `worlds` rows (see its README) |
| `cmd/mintworld` | (WP07) Mint a world / the official row from a seed |
| `cmd/heightcmp` | (WP07) Bitwise ground comparison: Go/wazero vs Node vs headless Chromium |

Test: `go test ./...` (includes the protocol golden vectors).
