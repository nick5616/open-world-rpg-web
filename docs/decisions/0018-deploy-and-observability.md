# 0018: Deploy and observability (WP18)

Status: accepted (not yet exercised against a real GCP project; see "Not done").

Context: spec 13 asks for scripts in `infra/` that deploy everything end to
end with the authenticated `gcloud` and `netlify` CLIs, a GitHub Actions
deploy on merge to `main`, content-hashed `worldgen.wasm` kept forever,
Prometheus metrics and structured logs in every Go service, a debug HUD, a
wake-on-demand game VM, and near-zero idle cost. This run was not allowed to
touch any cloud, so "a clean clone deploys everything with one script" is
proven by a dry-run plan plus a local rehearsal of the production topology.

## Decisions

### 1. One Node script, two targets, everything idempotent

`infra/deploy.mjs --target gcp|local`. Every outward command goes through
`infra/lib/runner.mjs`, which distinguishes *probes* (read-only checks),
*outputs* (read-only queries) and *runs* (changes). `--dry-run` executes
none of them, not even probes, and assumes every probe finds nothing, so the
transcript is the complete plan for an empty project. A real run needs
`--yes` (CI passes it); without it the script prints the plan. Every gcloud
command carries `--project`; the script never changes gcloud config.
Secrets are passed on stdin and printed as `<redacted>`.

Why not Terraform: spec 13 says scripts an agent can run with the two CLIs,
and spec 4 says Node or Go only. The price is that drift is not detected
(e.g. a changed firewall rule is not updated, only created when missing).

### 2. Containers: one Dockerfile per service, wasm built once on the host

Multi-stage, `golang:1.27-alpine` -> `distroless/static:nonroot`,
`CGO_ENABLED=0`, ~10-25 MB per image, configured only by env vars. The build
context is the repo root behind a whitelist `.dockerignore` (one per
Dockerfile, identical, checked by the script). `worldgen.wasm` is *not*
built in a Docker stage: it is built once by `npm run build:wasm` and copied
into the zone, account and creator images and the client bundle, so all of
them carry byte-identical wasm (spec 5 pins worlds to its hash). The zone
image also carries `migrate` and `mintworld`.

### 3. The VM: compose + Caddy, configured through instance metadata

Debian 12, Docker installed by the startup script on first boot, Docker's
data-root on a separate persistent disk (`auto-delete=no`), so Postgres,
Redis AOF, Caddy certificates and pulled images survive stops and even VM
recreation. `infra/vm/docker-compose.vm.yml`, the Caddyfile and the guest
scripts travel as instance metadata; secrets are fetched from Secret Manager
by the VM's own service account at every boot. No SSH or SCP is needed to
deploy; an awake VM is refreshed with `google_metadata_script_runner startup`
over IAP.

Compose order: Postgres healthy -> `migrate` -> `mint` (mints the official
world, so the zone never boots into the dev world before the account
service, which lives on Cloud Run, has run) -> zone, social.

TLS: browsers on the https Netlify page can only open `wss://`, so Caddy
terminates TLS with Let's Encrypt and routes by path (`/zone/ws`,
`/social/ws`, `/livekit/*`). Without a domain the host is
`<ip-with-dashes>.sslip.io`, which resolves to the static IP with no DNS
work. WebTransport does not go through Caddy: the zone serves HTTP/3 on UDP
4433 with its self-signed 10-day certificate pinned by hash (WP06), which a
VM that sleeps nightly rotates naturally.

### 4. Cloud Run reaches the VM over Direct VPC egress, guarded by a network tag

Director, account and creator need Postgres and Redis, which live on the VM.
Direct VPC egress (`--network --subnet --vpc-egress private-ranges-only
--network-tags lodestone-run`) costs nothing extra (a Serverless VPC Access
connector bills its instances 24/7). The firewall admits 5432/6379/8092/8093
only from that tag. The VM gets a reserved internal IP so the services' env
never changes.

### 5. Static external IP (the main idle cost) over an ephemeral one

~$7.30/month while the VM sleeps. An ephemeral IP would be free while
stopped but changes the game host (and its certificate, and every URL the
director hands out) on each wake, which needs DNS updates or a dynamic
host in the director. Revisit in WP19 with real numbers (`infra/cost/README.md`).

### 6. Wake on demand lives in the director, behind a Provider interface

`server/director/internal/wake`: `Provider{Status, Start, Stop}` with a GCE
implementation over plain REST (`compute.googleapis.com`, metadata-server
token; no Google SDK in game code, spec 13 rule 5), a `Fake` for tests and
the rehearsal, and *none* by default, which keeps local development and all
existing tests "always awake" (`POST /v1/wake` answers `awake` at once).

- `POST /v1/wake` (public) is what the client polls before sign-in: the
  account service's database sleeps with the VM, so the waking screen must
  come before the account screen. `/v1/connect` and `/v1/social-ticket` are
  gated the same way (503 `waking_world`, which the WP04 client already
  retries), answering before any Postgres access.
- "Awake" = provider says running *and* every `LODESTONE_WAKE_READY_URLS`
  answers 2xx (zone and social `/healthz` on the internal IP).
- Idle: the director cannot keep a timer, because Cloud Run scales it to
  zero. Last activity lives in Redis on the VM (`wake:lastActive`, monotonic
  Lua set); Cloud Scheduler calls `POST /internal/wake/tick` (bearer token)
  every 5 minutes, and a live director instance also checks every minute.
  Players online come from the zone registry. If Redis is unreachable, the
  VM's own last start time is the floor: a broken Redis delays a stop by at
  most one idle window, never forever. A forgotten VM is the expensive
  failure; stopping a VM whose Redis is broken (so the game is broken
  anyway) is the cheap one.
- A wake call counts as activity and the client re-pings every 2 minutes
  while on the account screen, so the world doesn't fall asleep under
  someone creating a character.
- The director's service account holds a custom role
  (`compute.instances.get/start/stop/resume`) bound on the one instance.
- Cloud Run services start with `LODESTONE_LAZY_DEPS=1`: an unreachable
  Postgres/Redis at startup is logged instead of fatal (Cloud Run refuses a
  revision whose container exits). Local dev keeps failing fast.

### 7. Postgres backups: nightly *and* on every stop

A VM that sleeps most nights never sees 03:30, so the shutdown script dumps
too (after stopping zone and social, whose shutdown flushes the write-behind
queue into Postgres). Timestamped dumps expire after 60 days; `pg/latest.sql.gz`
is overwritten and never expires, so an unplayed world keeps its newest dump.

### 8. worldgen wasm archive

`gs://<project>-lodestone-worldgen/worldgen/worldgen-<sha256:16>.wasm` (+ the
manifest), uploaded with `--no-clobber` and `Cache-Control: public,
max-age=31536000, immutable`, public read, CORS for browsers, no lifecycle
rule. A bucket retention *lock* would make "forever" enforceable but is
irreversible; not applied by a script. The client today loads the wasm from
its own hashed Vite asset (also immutable on Netlify); loading an older
genVersion from the archive is future work when a second genVersion exists.

### 9. Observability

- `server/pkg/svc` (shared): runtime gauges read with `runtime/metrics` (no
  stop-the-world, so scrapes never add to a tick), `lodestone_build_info`,
  HTTP request counters and a latency histogram (WebSocket upgrades passed
  through untouched), and an optional `LODESTONE_METRICS_TOKEN` (Cloud Run
  URLs are public). JSON logs via `slog` were already there.
- Zone gap filled: monotonic `zone_bytes_in_total` / `zone_bytes_out_total`
  (the existing live-client sums drop when a client leaves, so `rate()` was
  impossible). Tick time, players, per-client bandwidth, AOI set sizes and
  write-behind depth already existed (WP03/WP06).
- Local Prometheus (9390) + Grafana (3390) as compose project
  `lodestone-obs`, scraping dev and rehearsal side by side by `env` label.
  Dashboards are generated JSON (one axis per panel, spec budgets drawn as
  threshold lines).
- Client debug HUD: fps, transport, RTT, down/up kbps and chunk queue were
  already wired by WP02/05/06; verified end to end in the rehearsal.
- Cost: Grafana "cost per player" dashboard with a `monthly_cost_usd` input
  and peak CCU from Prometheus; line items in `infra/cost/README.md`.

### 10. CI deploy gated on secrets

`.github/workflows/deploy.yml`: a `gate` job checks
`secrets.GCP_SA_KEY`, `secrets.NETLIFY_AUTH_TOKEN`, `vars.LODESTONE_GCP_PROJECT`;
without them every other job is skipped with a notice. With them: tests
(incl. `LODESTONE_REQUIRE_WASM=1` and the golden tests), a dry run, then the
real deploy in the `production` environment, transcript uploaded as an
artifact. `ci.yml` is untouched.

## Not done / trade-offs to revisit

- **Never deployed to a real cloud.** The plan is reviewed and the topology
  rehearsed, but GCP-side surprises (org policies, quota, Direct VPC egress
  with network tags in this project, Let's Encrypt on sslip.io) are unproven.
- Redis has no password: it is reachable only from the VM and the tagged
  Cloud Run egress. Adding one needs a `LODESTONE_REDIS_PASSWORD` read in
  every service.
- Postgres over the VPC uses `sslmode=disable`.
- `POST /v1/wake` is unauthenticated (it must work before sign-in): anyone
  can keep the VM awake by polling. Bounded by the idle window; rate limit
  or a signed-out "intent" token if it is abused.
- Firewall rules are created when missing, not reconciled.
- Spot zone servers and region failover (spec 13 rule 3) are a later
  decision driven by soak numbers.
- The rehearsal runs on Docker Desktop, where the headless browser fell back
  to WebSocket (WebTransport through Docker Desktop's UDP proxy was not
  established); WebTransport itself is covered by WP06's native acceptance.
