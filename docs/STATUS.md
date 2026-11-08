# Status

One section per work package (spec 15). Each package edits only its own section.
Gates: G0 ✅ · G1 ⏳ · G2 ⏳ · G3 ⏳ · G4 ⏳ · G5 ⏳

## WP00: Monorepo scaffold and contracts ✅

Works:
- npm workspaces (`contracts/ts`, `client`, `tools/*`), Go workspace (`go.work`, six modules), Cargo workspace (`worldgen`), pinned Rust toolchain.
- `contracts/`: `protocol.yaml` (13 messages, masked entity/self records), `constants.yaml` (world, sim, movement, AOI, voice, social, gameplay, security), `social.yaml`, `worldspec.schema.json`, migration `0001_init.sql`.
- Codegen (`npm run gen`, `gen:check`) emits TS, Go and Rust plus 39 golden byte vectors. TS (vitest) and Go tests decode and re-encode every vector identically.
- Go shared packages: `proto` (codec runtime + quantization), `constants`, `socialproto`, `worldspec`, `env`, `svc` (healthz, metrics, graceful shutdown), `migrate` + `cmd/migrate`.
- `infra/docker-compose.yml` (Postgres 16, Redis 7, LiveKit 1.8). `npm run dev` brings up infra, applies migrations, starts director/account/zone/social stubs (healthy on /healthz) and the Vite client; `npm run dev:solo` runs the client alone. Evidence: `docs/evidence/wp00-dev-smoke.log`.
- CI skeleton `.github/workflows/ci.yml` (ubuntu + windows): gen check, lint, tests, wasm build, client build.

Known gaps:
- CI has never run on GitHub (no push in this run).
- Service binaries are stubs; their packages replace them.
- `friends`/`blocks` reference `accounts`, so local profiles cannot have friends until WP08 decides how to key them (CR expected).

## WP04: Accounts, director and persistence ✅

Works (evidence: `docs/evidence/wp04-acceptance.txt`, `wp04-01…08-*.png`, `wp04-tickets.json`, `wp04-dev-smoke.txt`; run `node client/src/account/dev/acceptance.mjs`):
- Account service (`server/account`, :8091): Firebase ID token sign-in (RS256 vs Google securetoken JWKS with caching/rotation, iss/aud/exp/iat/auth_time checks; unit-tested with a local RSA key and mock JWKS, no real project exists), dev auth by username (`LODESTONE_DEV_AUTH`, default on, refused when `LODESTONE_ENV=production`), local profiles (browser UUID + secret, hash stored), worlds, characters (validated names, unique per world case-insensitively across account and local characters), signed initial save blob for local characters, verify, upgrade (one transaction), seeds one official world on startup.
- Session tokens `lss1.<payload>.<Ed25519 sig>`, 12 h (`server/pkg/accountapi`). Director verifies them offline.
- Director (`server/director`, :8090): region from character/save position, zone pick from `zones:{worldId}` (explicit region owners before whole-world zones), signed zone + social tickets (60 s), `503 waking_world` + `Retry-After` when no zone is live, social-ticket re-issue, world status. `cmd/fakezone` announces a stand-in zone.
- `server/pkg/localsave`: blob build/sign/verify (domain-separated, length-prefixed), per-character newest counter in Redis hash `localsave:{profileId}` (TTL 180 days, refreshed on use). Edited blobs fail the signature, old blobs fail the counter.
- Client `client/src/account/`: `AccountScreen` (account vs local profile, create/select character, Play with "waking the world" retry, Export/Import/Upgrade, `onReady(ReadySession)`), typed API client, IndexedDB `lodestone` DB with stores `profile` + `saves` (caches go in `cache:*` stores; `clearCaches()` never touches saves). Dev page `client/account-dev.html` (vite --port 5174).
- Headless acceptance (Chromium): dev sign-in → create → waking 503 → fake zone up → ticket, then `TestAcceptanceTicketFile` verifies every received ticket with `ticket.Verify` for its zone (and rejects it for another). Local path: profile → character → blob (counter 1) in IndexedDB → tampered blob rejected (account + director) → counter 2 issued → old blob rejected → local ticket → export → tampered import refused → import in a fresh browser → upgrade into an account (level carried over) → profile retired (410).
- Tests: Go unit + integration over real HTTP, scratch Postgres DBs and Redis (`accountapi`, `localsave`, `account`, `director`); vitest for export parsing and the API client; tsc/eslint/go vet/gofmt clean.
- Migration `0002_local_profiles.sql`: `worlds.official`, `local_profiles`, `local_characters` (additive).

Known gaps / assumptions:
- The official world's `spec` JSON, `gen_version` and `atlas_hash` are placeholders until worldgen's `spec_from_seed` is wired in (WP01 merge); seed from `LODESTONE_WORLD_SEED` (default 20261108).
- Not yet checked against WP03's real zone: the acceptance used a fake registry entry; the zone accepting a director ticket is verified at merge. Zones must announce under the official world's id (`SELECT id FROM worlds WHERE official`) and use the same ticket key (dev default matches).
- Save points don't exist yet: `POST /v1/dev/local/resave` (dev only) stands in for the zone issuing blobs (WP06/WP14 call `localsave.Store.Issue`).
- Counter records are adopted when missing (local Redis has no persistence), allowing one rollback right after a Redis loss. Production: enable Redis AOF or move counters to Postgres (decision 0004).
- Firebase never exercised against a real project; browser path loads the SDK from gstatic only when `VITE_FIREBASE_*` is set. Linked providers on one Firebase uid would create separate accounts (decision 0004).
- Waking the game VM (spec 13) is not implemented here; the director only reports `waking_world` (WP19).
- No rate limiting on sign-in endpoints yet (profile secrets are 256-bit, Firebase tokens are signed; add token buckets with WP08's limiter).
- New character spawn is the world centre with y = 0 ("snap to ground") until worldgen supplies a spawn.
- Character names have a reserved list but no profanity filter (spec 10's filter lands with WP08).
