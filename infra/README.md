# infra

Everything that runs Lodestone outside `npm run dev` (spec 13, WP18).
Decisions and trade-offs: `docs/decisions/0018-deploy-and-observability.md`.

| Path | What |
| --- | --- |
| `docker-compose.yml` | Local dev infra: Postgres, Redis, LiveKit (`npm run infra:up`, or implicitly `npm run dev`). Unchanged by WP18. |
| `deploy.mjs` | The one deploy command: `--target gcp` (real, or `--dry-run`) and `--target local` (rehearsal). |
| `lib/` | Deploy steps: `gcp.mjs` (GCP + Netlify), `local.mjs` + `smoke.mjs` (rehearsal), `build.mjs` (wasm, images, static builds), `secrets.mjs`, `config.mjs`, `runner.mjs` (dry-run aware command runner). |
| `docker/` | One Dockerfile per Go service (director, account, zone, social, creator), multi-stage, distroless, env-only config, plus the shared build-context whitelist (`*.Dockerfile.dockerignore`). |
| `vm/` | The game VM: `docker-compose.vm.yml` (zone, social, LiveKit, Postgres, Redis, Caddy), `Caddyfile` (TLS + path routing), `startup.sh` / `shutdown.sh` / `pg-backup.sh` (GCE guest scripts), `prometheus.vm.yml`. |
| `rehearsal/` | Overlay that adds the Cloud Run and Netlify pieces as containers for the local rehearsal. |
| `netlify/` | `_headers` for the client and creator builds (hashed assets cached forever). |
| `gcp/` | Bucket lifecycle and CORS JSON. |
| `observability/` | Local Prometheus + Grafana (`npm run infra:obs`), dashboards and their generator. |
| `cost/` | Cost notes stub (WP19 fills the numbers). |

## What runs where

| Piece | Production | Why |
| --- | --- | --- |
| Client, creator web | Netlify (static) | `netlify deploy --prod`; creator `/v1/*` proxied to Cloud Run by `_redirects` |
| Director, account, creator endpoint | Cloud Run, min instances 0 | Stateless HTTPS; reach the VM over Direct VPC egress (no paid connector) |
| Zone, social, LiveKit, Postgres, Redis | One GCE VM (`lodestone-game`, e2-standard-2), containers | Long-lived sockets and UDP; started on demand by the director, stopped after 15 idle minutes |
| TLS for `wss://` | Caddy on the VM, Let's Encrypt for `<ip-dashed>.sslip.io` (or `LODESTONE_GAME_HOST`) | Browsers on an https page may only open secure sockets |
| Keys and passwords | Secret Manager | Generated once by the deploy, never rotated by it |
| Postgres backups | `gs://<project>-lodestone-backups/pg/` | Nightly while awake and on every stop; `latest.sql.gz` never expires |
| worldgen wasm archive | `gs://<project>-lodestone-worldgen/worldgen/worldgen-<sha256:16>.wasm` | Public, `immutable`, `--no-clobber`, no lifecycle: kept forever |
| Idle check | Cloud Scheduler, every 5 min, `POST <director>/internal/wake/tick` | The director scales to zero, so it cannot keep its own timer |

## Deploy for real

### Prerequisites (once)

- A GCP project with billing enabled, and an account that is Owner on it
  (or the "CI deployer" roles below).
- `gcloud` authenticated (`gcloud auth login`); the deploy never changes your
  gcloud configuration, it passes `--project` to every command.
- `netlify` CLI authenticated (`netlify login`, or `NETLIFY_AUTH_TOKEN`).
- Docker running; Node 20+, Rust (for `npm run build:wasm`), `npm ci` done.
- Optional: a domain for the game server (`LODESTONE_GAME_HOST=play.example.com`
  with an A record to the VM's static IP; otherwise `<ip-dashed>.sslip.io`
  is used, which needs no DNS).

### One command

```
LODESTONE_GCP_PROJECT=<project-id> npm run deploy
```

(= `node infra/deploy.mjs --target gcp --yes --project <project-id>`.) It is
idempotent: the first run bootstraps an empty project (APIs, Artifact
Registry, service accounts and the VM power role, static IPs and firewall,
secrets, buckets, images, wasm, VM, Cloud Run, Scheduler, Netlify sites);
later runs only push new images, update metadata and redeploy. If the VM is
awake it is updated in place over IAP SSH; if asleep, it picks up the new tag
on its next wake. Takes ~10-15 minutes the first time.

The only steps the script cannot do itself are printed as `!! MANUAL STEP`
with exactly what to click:

- **Google sign-in (Firebase Auth)**: enable Firebase on the project, enable
  the Google provider, authorize the Netlify domain, register a web app, then
  re-run with `VITE_FIREBASE_API_KEY` / `VITE_FIREBASE_APP_ID`. Local
  profiles work without it.
- **Anthropic API key** (only with `--creator-llm`): add it to Secret Manager
  with the printed command.
- **Org policy** blocking public buckets (only if your org has one): the
  worldgen archive stays private; the printed note explains the override.

Useful options (flag or env var): `--region` / `LODESTONE_GCP_REGION`
(us-central1), `--zone`, `--machine-type` / `LODESTONE_VM_MACHINE_TYPE`,
`--game-host` / `LODESTONE_GAME_HOST`, `--client-site` /
`LODESTONE_NETLIFY_CLIENT_SITE` (default `<project>-client`), `--creator-site`,
`--netlify-team`, `LODESTONE_NETLIFY_CLIENT_SITE_ID` /
`LODESTONE_NETLIFY_CREATOR_SITE_ID` (deploy to existing sites),
`--creator-llm`, `--idle 15m`, `--only vm,run` (re-run some steps), `--tag`,
`--transcript <file>`.

### Dry run (plan only)

```
node infra/deploy.mjs --target gcp --project <project-id> --dry-run
npm run deploy:plan -- --project <project-id>
# after a real deploy, a headless browser smoke test against the live site:
node infra/smoke-live.mjs https://<client-site>.netlify.app
```

Executes nothing (not even read-only `describe` calls). Every probe is shown
as `? cmd` and assumed to find nothing, so the transcript is the complete
plan for an empty project; changes are `+ cmd`, secrets print as
`<redacted>`. Without `--yes` a real run also falls back to the plan.
Transcript of the full plan: `docs/evidence/wp18-deploy-dry-run.txt`.

### CI (`.github/workflows/deploy.yml`)

On every merge to `main`: build, lint, all tests (with
`LODESTONE_REQUIRE_WASM=1`), the determinism golden tests (Node, Chromium,
Go/wazero, native), a dry run, then `infra/deploy.mjs --target gcp --yes`.
It is skipped (green, with a notice) unless the repo has
`secrets.GCP_SA_KEY`, `secrets.NETLIFY_AUTH_TOKEN` and
`vars.LODESTONE_GCP_PROJECT`. `ci.yml` is unchanged.

**CI deployer** service account roles (project level): Cloud Run Admin,
Compute Admin, Artifact Registry Admin, Secret Manager Admin, Storage Admin,
Cloud Scheduler Admin, Service Account Admin, Service Account User, Role
Admin, Project IAM Admin, Service Usage Admin, IAP-secured Tunnel User. (After
the first bootstrap run by an Owner, Cloud Run Admin + Compute Instance Admin
+ Artifact Registry Writer + Storage Object Admin + Secret Manager Secret
Accessor + Service Account User + IAP-secured Tunnel User are enough for
redeploys with `--only build,wasm,vm,run,netlify`.)

### Operating it

- Wake by hand: `curl -X POST <director>/v1/wake`. Stop by hand: `gcloud compute instances stop lodestone-game --zone us-central1-a --project <id>` (the shutdown script still dumps Postgres).
- Logs: Cloud Run logs in Cloud Logging (JSON, `svc` field); VM: `gcloud compute ssh lodestone-game --tunnel-through-iap -- sudo docker compose -f /opt/lodestone/docker-compose.yml logs -f zone`.
- Moderation CLI: `... sudo docker compose -f /opt/lodestone/docker-compose.yml exec social social-admin reports`.
- Prometheus on the VM: `... sudo docker compose -f /opt/lodestone/docker-compose.yml --profile obs up -d prometheus`, then `gcloud compute ssh lodestone-game --tunnel-through-iap -- -L 9390:localhost:9390`.
- Restore a backup: `gcloud storage cp gs://<project>-lodestone-backups/pg/latest.sql.gz - | gunzip | gcloud compute ssh lodestone-game --tunnel-through-iap -- sudo docker compose -f /opt/lodestone/docker-compose.yml exec -T postgres psql -U lodestone -d lodestone` (into an empty database).

## Local rehearsal (no cloud)

```
npm run deploy:local                # = node infra/deploy.mjs --target local
node infra/deploy.mjs --target local --keep        # leave it running afterwards
node infra/deploy.mjs --target local --skip-build  # reuse the last images
```

Builds worldgen.wasm, the five production images, the production client and
creator builds; writes a production `.env` (`LODESTONE_ENV=production`,
freshly generated Ed25519 keys and tokens, no dev auth) into
`%TEMP%/lodestone-rehearsal` (the VM's `/opt/lodestone`); runs
`vm/docker-compose.vm.yml` unchanged plus `rehearsal/docker-compose.rehearsal.yml`
as compose project **`lodestone-rehearsal`** with its own volumes, on
127.0.0.1 only:

| Port | Stands in for |
| --- | --- |
| 28080 | Caddy on the VM (`ws://localhost:28080/zone/ws`, `/social/ws`, `/livekit`) |
| 28433/udp | zone WebTransport |
| 28090 / 28091 / 28094 | director / account / creator on Cloud Run (director uses the **fake** wake provider, 8 s boot) |
| 28173 / 28177 | client / creator on Netlify |
| 28092 / 28093, 28432, 28379, 28881-28882 | VPC-only zone/social health+metrics, Postgres, Redis, LiveKit |

Then it smoke-tests healthz and metrics (with and without the metrics token)
on every service, the edge, the static builds and the creator proxy, and
drives headless Chromium through the production client: "waking the world"
screen, local profile, character, director ticket, zone connection, debug
HUD. It tears down **only** its own project (`down -v` on
`lodestone-rehearsal`); the dev infra (project `lodestone`) is never touched.
Evidence: `docs/evidence/wp18-rehearsal.txt` and `wp18-rehearsal-*`.

## Local Prometheus and Grafana

```
npm run infra:obs        # Prometheus http://localhost:9390, Grafana http://localhost:3390
npm run infra:obs:down   # removes only the lodestone-obs project
```

Scrapes `npm run dev` (8090-8094, `env="dev"`) and a kept rehearsal
(28090-28094, `env="rehearsal"`, using its metrics token). Grafana opens on
"Lodestone overview" (players, tick time vs the 33 ms period, per-client
downlink/uplink vs the 160/24 kbps budgets, AOI ring sizes, write-behind
depth and outcomes, terrain cache, HTTP rates/latency, director tickets and
wakes, chat, goroutines, heap) and has "Lodestone cost per player" (see
`cost/README.md`). Dashboards are generated: edit
`observability/gen-dashboards.mjs`, run it, commit the JSON.

## Metrics every service exports (`/metrics`, Prometheus text)

From `server/pkg/svc` (all services): `lodestone_build_info{version,go}`,
`process_uptime_seconds`, `go_goroutines`, `go_heap_bytes`,
`go_gc_cycles_total`, `http_requests_total{code}`,
`http_request_duration_seconds_bucket/_sum/_count`. Set
`LODESTONE_METRICS_TOKEN` to require `Authorization: Bearer <token>` (the
deploy does; `/healthz` stays open). Logs are JSON on stdout (`slog`, field
`svc`) everywhere.

Service-specific: zone `zone_tick_ms{q}`, `zone_tick_jitter_ms{q}`,
`zone_players`, `zone_sessions{transport}`, `zone_client_down_kbps{q}` /
`zone_client_up_kbps{q}` (per client, quantiles across clients),
`zone_bytes_in_total` / `zone_bytes_out_total` (new, monotonic),
`zone_aoi_entities_avg{ring}` / `_max`, `zone_writebehind_depth` and
outcome counters, `zone_terrain_*`; director `director_tickets_issued_total{kind}`,
`director_waking_total`, `director_wake_starts_total` / `_stops_total` /
`_errors_total`, `director_wake_players_online`, `director_wake_idle_seconds`;
account `account_*`; social `social_*`; creator `creator_*`.
