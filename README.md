# Lodestone

A browser-based, first-person open world RPG: a procedurally generated world
shared by hundreds of players, with towns, caves, gems and ores, demons at
night, quick PvE combat, parties, chat and proximity voice.

The build spec is [`docs/SPEC.md`](docs/SPEC.md). What works today is in
[`docs/STATUS.md`](docs/STATUS.md).

## Prerequisites

- Node 20.10+ and npm
- Go 1.27 (`go.work` pins modules)
- Rust via rustup (`rust-toolchain.toml` pins 1.99.1 + `wasm32-unknown-unknown`)
- Docker Desktop (WSL2 backend) on Windows, Docker Engine on Linux

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | Install JS workspaces |
| `npm run refs` | Clone the read-only reference repos into `refs/` |
| `npm run gen` | Regenerate code from `contracts/` (`gen:check` verifies freshness) |
| `npm run dev` | Postgres, Redis, LiveKit in Docker, migrations, Go services, Vite client |
| `npm run dev:solo` | Client + worldgen only, no servers |
| `npm test` | Generated-code check, TS, Go and Rust tests |
| `npm run lint` | eslint, tsc, go vet, gofmt, clippy |
| `npm run infra:up` / `infra:down` | Just the Docker services |

## Local ports (all overridable by env var)

| Service | Port | Env var |
| --- | --- | --- |
| Client (Vite) | 5173 | `LODESTONE_CLIENT_PORT` |
| Director | 8090 | `LODESTONE_DIRECTOR_PORT` |
| Account | 8091 | `LODESTONE_ACCOUNT_PORT` |
| Zone | 8092 | `LODESTONE_ZONE_PORT` |
| Social | 8093 | `LODESTONE_SOCIAL_PORT` |
| Creator API | 8094 | `LODESTONE_CREATOR_PORT` |
| Postgres | 55432 | `LODESTONE_PG_PORT` / `LODESTONE_PG_URL` |
| Redis | 56379 | `LODESTONE_REDIS_PORT` / `LODESTONE_REDIS_ADDR` |
| LiveKit | 7880 (+7881 TCP, 7882 UDP mux) | `LODESTONE_LIVEKIT_PORT` |

## Layout

```
contracts/   protocol.yaml, social.yaml, constants.yaml, worldspec.schema.json, migrations/, codegen/, ts/ (@lodestone/contracts)
worldgen/    Rust crate -> worldgen.wasm
client/      Vite + React + R3F
server/      director/ zone/ social/ account/ pkg/ (Go workspace modules)
tools/       creator/ bots/ netsim/ textures/
infra/       docker-compose.yml, deploy scripts
docs/        SPEC.md, STATUS.md, cr/, decisions/
scripts/     Node entry points behind npm run
```
