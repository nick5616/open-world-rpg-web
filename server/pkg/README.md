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

Test: `go test ./...` (includes the protocol golden vectors).
