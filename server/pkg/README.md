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
| `accountapi` | (WP04) Session tokens + shared Postgres queries for accounts, local profiles, worlds, characters; `dbtest` scratch-DB helper |
| `localsave` | (WP04) Local-profile save blobs: Ed25519 sign/verify + Redis newest-counter check |

Test: `go test ./...` (includes the protocol golden vectors).
