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

## WP02: Client shell and movement ✅

Branch `wp/02-client-shell`. Details: `client/README.md`, movement contract `client/src/sim/README.md`.

Works:
- Vite + React + R3F shell: zustand app store, screens title -> account slot (WP04 mounts sign-in in `client/src/screens/AccountSlot.tsx`; solo skips it) -> play (lazy-loaded, three.js not in the title bundle). `npm run dev:solo` starts the client with no servers.
- Movement: pure TS `stepMovement(state, input, ground, dt)` in `client/src/sim/movement.ts`, a verbatim port of wizard-wars `shared/movement.js` + `ClientPrediction.predict()` order, fed by contract constants, one InputFrame per fixed 1/60 s step, quantized u16 yaw, feet position. Algorithm written out for the Go port in `client/src/sim/README.md`; golden trajectories (2 scenarios x 690 steps, flat and tilted plane) in `client/src/sim/golden/`, regression-tested bit-exactly.
- Side-by-side with wizard-wars' original code (`npm run compare:ww -w client`): max position divergence **8.9e-16 m** at the same dt and yaw; feel metrics at native rates (WW 64 Hz vs ours 60 Hz) differ by <= 7 mm in jump apex and stop distance, identical top speeds. Evidence: `docs/evidence/wp02-movement-side-by-side.{md,json,svg,png}`.
- First-person controller: pointer-lock mouse look at display rate, keyboard sampled per frame, 60 Hz fixed steps with an 8-step backlog cap, jump-edge latch (taps shorter than a step still double jump), render pose interpolated between steps (unit test: even per-frame motion at 144 Hz). First-person arms (wand + off hand) with walk bob, air lift and landing dip.
- Pluggable `GroundQuery` (`client/src/sim/ground.ts`) via `GroundContext`; `GameCanvas` takes `ground`, `terrain` and `onStep` props for WP05/WP06. Flat placeholder ground with a chunk grid, gradient sky + sun on a world clock, fog.
- Quality store ported (auto/low/medium/high + PerformanceMonitor), extended with shadow cascades, view distance and normal-map knobs.
- Debug HUD (wizard-wars FrameStats extended): fps, avg/max frame ms, dropped frames, position, speed, move mode, air jumps, look, AOI cell and chunk, step seq, time of day, quality, plus empty slots for transport / RTT / bandwidth (WP06) and chunk queue (WP05) in `client/src/state/live.ts`.
- Dev tools (dev, solo or `?debug=1`): teleport (`x z` or `x y z`), fly/noclip, freeze time + time-of-day slider, AOI cell / chunk / region borders, quality select, `window.__lodestone` handle for scripts.
- Headless run (`npm run shots -w client` against `dev:solo`): walks, sprints, double jumps with real key events; in-browser speeds 4.889 / 7.822 m/s, double-jump apex 2.10 m, no page errors. Evidence: `docs/evidence/wp02-{title,spawn,walking,sprinting,double-jump,cell-borders,fly,debug-panel}.png`, `docs/evidence/wp02-headless.txt`.
- 34 vitest tests; `npx eslint client` and `npm run typecheck -w client` clean; production build 280 KB gzipped (three.js 177 KB).

Known gaps:
- Headless fps (~30-50) is SwiftShader software rendering, not a GPU number; the spec 12 frame-time budget still needs a real-GPU traversal benchmark (WP05 has the real scene).
- Effective walking speed is 4.89 m/s, sprint 7.82 m/s (Source-style equilibrium accel x wish / friction), as in wizard-wars. BASE_MOVE_SPEED (8) is the wish speed. Faithful to the reference; flag for Nicole when tuning glide (9 m/s) against it.
- No collision beyond the ground height: climb, glide, swim, stamina, walls and caves wait for the wasm collision queries (spec 8).
- Shadows are one directional light with a 40 m frustum around the player, not cascades; sky is a gradient dome, not analytic scattering (rendering packages).
- Fly mode is client-only; WP06 must refuse it online (or make it a server-checked admin command).
- Sign-in placeholder only; WP04's `client/src/account/` screen is not wired in yet.
- Go float notes for WP03 (FMA fusion on arm64, sin/cos ulps) are in `client/src/sim/README.md`; the Go replay of the goldens is not written yet.

Assumptions:
- Freeze time = freeze the world clock (day/night), not the player simulation.
- Debug tools are on in dev and solo builds and behind `?debug=1` in production.
- Spawn is the world center (2048, 2048) on a flat plane at y = 0.
- wizard-wars never wired SPRINT_MULTIPLIER into movement; sprint multiplies the wish speed the way its `predict()` applied any speed multiplier.
- Escape does not pause (the world is shared); keyboard movement keeps working without pointer lock, which is also what lets headless runs walk.
- Shared files touched: `client/package.json` scripts only (`golden`, `compare:ww`, `shots`); no root files, no contracts.

## WP03: Zone server skeleton ✅

Branch `wp/03-zone-skeleton`. Decisions: `docs/decisions/0003-zone-skeleton.md`.

Works:
- `server/zone`: 30 Hz tick on the shared scheduler; WebSocket `/ws` (binary, one message per frame); Hello -> version check (`version_mismatch`) -> Ed25519 ticket check (`bad_ticket`: signature, expiry, audience `zone:<id>`, world) -> Welcome (entity, tick, rate, server time, world id/seed/genVersion from env or else WP04's official world row, spawn from `characters.position`, name); duplicate login kicks the old session; ClockPing/Pong; per-message-type token buckets plus a 60 frames/s movement budget; entity store; 32 m grid with near/mid/far/party rings at 30/10/2/2 Hz (far = players only, 16 m leave hysteresis); delta snapshots against a 32-frame acked baseline ring with masked records, first-sight names, removals and SelfState; spec 9 quantization; max-speed validation with snap-back; write-behind checkpoints every 30 s, on logout and on shutdown (missing character rows logged once and skipped); Redis `zones:{worldId}` heartbeat and removal on shutdown; Prometheus metrics (tick p50/p99/max, jitter, players, per-client kbps, AOI sizes, queue depth, kicks); graceful shutdown (kick `shutdown`, checkpoint, flush, deregister).
- `server/pkg` (new): `movement` (the contract for WP02's TS port, with `testdata/vectors.json` trajectories), `gameloop` (one grid, coarse sleep + spin tail `LODESTONE_SPIN_MS` default 2 ms Windows / 1 ms elsewhere, bounded catch-up, debt forgiveness, QPC clock on Windows), `transport` (`Conn` with reliable vs latest-wins unreliable; WebSocket; WebTransport stub), `snapshot` (encoder + reference decoder), `ratelimit`, `writebehind`. `svc` gained an additive `RunContext`.
- `tools/bots`: dev-ticket bots, 30 Hz packets of 60 Hz frames (walk/strafe/jump/idle personas), ack + full decode, own-movement prediction check, per-bot downlink/uplink, summary + JSON, zone metrics scrape, PASS/FAIL against budgets; `-ticket @file` connects one bot with a real director ticket. `npm run bots -- <flags>`.
- Tests: unit tests in every new package; `movement` replays WP02's TS goldens (max diff 1.4e-14 m over 2 x 690 frames); in-process session tests (kicks, movement == prediction to the cm, two clients see each other and removals, rings, duplicate login, rate-limit kick, frame budget, write-behind with a failing DB, shutdown flush); `server/zone/zone_integration_test.go` builds and runs the zone binary as a subprocess and drives Hello/Input/Snapshot, metrics, registry and graceful exit.

Evidence (Windows 11, 16 cores, Go 1.27.3; zone and 150 bots on the same machine, which other agents were also using):
- Spread soak, 150 bots, 75 s (`docs/evidence/wp03-soak-spread*.txt|json`): tick p50 0.55 / p99 1.56 / max 6.8 ms; downlink avg 13.0, max 16.8 kbps (budget 64); uplink 11.2 kbps (budget 24); ~10 players in view; 0 decode errors; 346k prediction checks, max error 0 cm.
- Clustered soak, 150 bots in a 300 m disc, 75 s (`wp03-soak-clustered*`): ~148 players in view (6 near / 41 mid / 102 far); tick p50 2.0 / p99 3.15 / max 5.4 ms; downlink avg 105.6, max 131.3 kbps (budget 160); uplink 11.2 kbps; 0 errors, prediction error 0 cm.
- Scheduler jitter (`wp03-jitter-idle-windows*.txt`): idle, 2 ms spin: p50 0.00, p99 0.10-0.81, max 0.14-1.76 ms; under load: spread p99 0.18 ms, clustered p99 0.04 ms. Spinning on `time.Now` (0.5 ms steps on Windows) gave ~0.3 ms p50 no matter the tail (`-timenow.txt`), hence QPC.
- Informational dense run, 143 players inside 64 m (`wp03-soak-dense-info*`): tick p99 4.2 ms, but downlink ~530 kbps: over budget, see gaps.
- WP04 acceptance half (`wp03-e2e-director.txt`): dev sign-in -> character -> director `POST /v1/connect` ticket for the zone it found in `zones:{officialWorld}` -> this zone accepts it, spawns at the character row's position, and the logout checkpoint lands in `characters.position`; registry entry removed on shutdown. (Left behind in the shared DB: dev account `wp03e2e`, character `Zonewalker`.)

Known gaps:
- Over the downlink budget when 100+ players stand inside 64 m: the spec 9 near ring sends all of them at 30 Hz. Proposed fix (WP06, needs a decision): per-client byte budget with a priority accumulator in the near ring.
- WebTransport is a stub (`transport.WebTransport.Serve` returns not implemented); WP06 implements it.
- Ground is flat (`movement.Flat`); WP07 plugs in wasm terrain. No climb/glide/swim/stamina yet (stamina is reported, never drained).
- Party ids are a stub field (always 0 until WP08), so the party ring is unit-tested only.
- HitClaim/Interact are accepted and rate-limited but ignored (WP10/WP11).
- Characters without a `characters` row (bots, and WP04's local-profile characters, which live in `local_characters`) spawn near the world center and their checkpoints are skipped; local profiles' signed save blobs (`localsave`) are not verified or issued by the zone yet (WP06/WP14).
- The server stops simulating a player who sends no input (no gravity while silent); fine for a skeleton, revisit with WP06 netsim tests.
- `go test -race` not run: no cgo toolchain on this Windows machine; run it in Linux CI. Jitter not yet measured on Linux.
- Bot RTT uses `time.Now`, so local RTT reads 0-0.1 ms on Windows.

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

## WP06: Netcode integration ✅

Branch `wp/06-netcode`. Decisions: `docs/decisions/0006-netcode-transport.md`, which also implements decision 0005. Package docs: `client/src/net/README.md`, `tools/netsim/README.md`, `server/zone/README.md` (Transports, Input handling, Byte budget).

Works:
- Client `client/src/net/`:
  - Ports of wizard-wars ClientPrediction, EntityInterpolation and ClockSync onto the generated binary codec.
  - Snapshot decoder: a port of `server/pkg/snapshot` with a 32-frame baseline ring, masked fields, zero-state first sight and removals.
  - Prediction runs WP02's `stepMovement` on 60 Hz frames. Input goes out at 30 Hz: new frames + `INPUT_REDUNDANCY` repeats + `ackTick`.
  - Reconciliation compares the server's SelfState at `ackInputSeq` with its own prediction and replays only on disagreement. The correction is eased over 90 ms and snaps beyond 3 m.
  - Interpolation uses per-ring floors (`INTERP_DELAY_NEAR/MID/FAR_MS`), per-entity spacing floors and a jitter-adaptive link delay. It dead-reckons from the wire velocity, cuts teleports and eases discontinuities, with counters for each.
  - Remote players have 3 LODs and a canvas nameplate with name, level and activity-flag chips.
  - HUD shows transport, RTT, ↓/↑ kbps and a sync line. `window.__lodestone.netDebug()` exposes the session state.
- Screen flow: title → WP04's `AccountScreen`, mounted unchanged in `screens/AccountSlot.tsx` → `ReadySession` → `NetPlay` connects to the director's zone, with Reconnect (fresh ticket) and Characters on kick or drop. "Continue offline" and `npm run dev:solo` still play with no servers (`docs/evidence/wp06-solo-smoke.txt`). Fly and teleport are refused while online.
- Transport (`server/pkg/transport`):
  - WebTransport over HTTP/3 (quic-go/webtransport-go v0.13.0): datagrams for unreliable frames, one u32-length-prefixed bidirectional stream for reliable ones, oversized unreliable frames sent on the stream.
  - The zone makes a 10-day ECDSA dev cert at startup and announces `wtEndpoint=https://…/wt#certHash=…` in `zoneregistry`; the browser pins it via `serverCertificateHashes`.
  - The client tries WebTransport for 2.5 s, then falls back to WebSocket (same frames). `?transport=ws|wt` forces one.
  - Shutdown drains WebTransport sessions so the kick and close code arrive. Safari status: 26.4+ per web sources, untested here (decision 0006).
- Zone (`server/zone`):
  - Per-client byte budget (`LODESTONE_ZONE_DOWN_BUDGET_KBPS`, default 150) with a priority accumulator: party, then distance, then an age bonus.
  - Late players are view-extrapolated for observers (≤16 steps), and wrong guesses are eased.
  - Input jitter buffer: a frame gap waits up to 2 ticks; frames lost in every copy are filled with the player's previous input (≤8).
  - Frame-budget burst raised from 30 to 60 frames, which changes a WP03 decision; see 0006.
  - New metrics: per-transport sessions, budget sent/deferred, synthesized/skipped frames.
- `tools/netsim/`:
  - `proxy.mjs`: wizard-wars netsim proxy port (WS ordered pipes, TCP-retransmit loss) plus a UDP relay for QUIC. Profiles: clean, lan, wifi, thailand (80±20 ms one way, 3%), mobile (125±40 ms, 6%, 1.5 Mbit), awful. Live `/config`.
  - `dense-budget.mjs`: the decision 0005 measurement.
  - Real netem (the-circle `e2e/netem.sh`) is documented as optional; it runs inside a Linux container.

Evidence:
- Acceptance: `node client/src/net/dev/acceptance.mjs` (`docs/evidence/wp06-acceptance.txt`, `wp06-acceptance-{ws,wt}.json`, `wp06-{ws,wt}-{a,b,walking,activity}.png`). Real account + director + zone binaries on a scratch database, two Chromium processes, dev sign-in, director tickets, "thailand" netsim. 18.5 s of both players walking squares, on WebSocket and on WebTransport:
  - RTT 158–169 ms.
  - Local reconciliation corrections: **0** on both transports (261–289 prediction agreements per player).
  - Remote extrapolation events while walking: **0**. Teleports: **0**.
  - Largest eased remote discontinuity: 3.4 cm (WS) / 0 cm (WT).
  - Drawn vs true position: under 1 cm.
  - Uplink: 15.5 kbps (WS) / 20 kbps (WT), budget 24. Downlink: 8–14 kbps.
  - Screenshots show the other player with nameplate from both browsers, and the "airborne" chip when B jumps.
- The "mobile" profile also passes: 263–317 ms RTT, 0 corrections, largest discontinuity 22 cm (`wp06-acceptance-mobile*`).
- Dense crowd, decision 0005 (`node tools/netsim/dense-budget.mjs`, `docs/evidence/wp06-dense-budget-*`): 150 bots in a 40 m disc. Downlink averaged **504 kbps (max 531)** with the budget off and **150.2 kbps (max 150.3)** at 150 kbps. Tick p99 rose from 4.8 to 6.6 ms.
- Tests:
  - Go: transport WT round trip, kick close code, latest-wins and big frames, wrong cert hash refused, dev cert limits. Snapshot: budget cap, correctness under loss, priority, starvation, record size vs codec, benchmark. Zone: view extrapolation and easing, reordered input, lost-frame fill, `zone_wt_integration_test.go` (zone binary over WebTransport, cross-transport visibility, registry `wtEndpoint`, shutdown code).
  - TS: vitest for clock, decoder (randomized vs a reference encoder), prediction, interpolation, framing. `zone.integration.test.ts` runs the zone binary and the netsim proxy as processes, with two sessions, B under thailand: 0 corrections, observer within 0.5 m, 0 teleports.
  - Netsim: `node --test`.
  - eslint, tsc, go vet and gofmt are clean.

Known gaps:
- Safari not tested: no Mac here. WebKit 26.4 support of `serverCertificateHashes` comes from compat data, not a test.
- The dev cert does not rotate: a dev zone running longer than 10 days needs a restart before browsers refuse the cert. Production needs `LODESTONE_ZONE_WT_CERT/_KEY` (real cert, plain URL).
- WebTransport per-chunk WorldEdits streams are not implemented; nothing sends WorldEdits yet (WP09).
- The byte budget costs about 9 µs per client per tick in dense crowds (sorting about 145 records). Fine at 150 players; WP19's 300-player soak should re-measure, and building snapshots in parallel per client is the next step if needed.
- Server view extrapolation is cosmetic for observers. Combat hit validation (WP10) must use confirmed position history, not the view.
- Local profiles' save blobs are sent in Hello but not verified or issued by the zone (WP14).
- World time (day/night) is still client-local; it needs an agreed epoch from the server (gameplay package).
- The headless runs use SwiftShader at ~30 fps, so frame-time numbers are not GPU numbers.
- Acceptance thresholds are mine, not the spec's: a local correction > 5 cm or an eased remote discontinuity > 30 cm counts as visible rubber-banding.

Assumptions:
- The cert hash travels as a URL fragment in `wtEndpoint`, so there is no contract change: the registry, director and `ReadySession` carry it verbatim.
- One acceptance "two headless browsers" run = two separate Chromium processes. Both are routed through the proxy by having the zone announce the proxy's endpoints.
- Shared files touched (minimal):
  - `client/src/sim/localSim.ts`: `rebase()`.
  - `client/src/scene/PlayerController.tsx`: optional `PlayerDriver`, correction easing, fly/teleport refused online.
  - `client/src/scene/GameCanvas.tsx`: `driver` and `children` props.
  - `client/src/screens/{AccountSlot,PlayScreen}.tsx`.
  - `client/src/state/live.ts`: `netStats.sync`.
  - `client/src/hud/DebugHud.tsx`: sync line.
  - `client/src/devHandle.ts`: `netDebug`.
  - `client/package.json`: devDeps `ws`, `@types/ws`.
  - `package-lock.json`.
  - `server/pkg/go.mod/go.sum`: webtransport-go.
  - `server/pkg/README.md`.
  - `server/zone` (owned).
