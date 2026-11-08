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

## WP01: Worldgen core, overworld ✅

Branch `wp/01-worldgen`. ABI and every buffer layout: `worldgen/README.md`.

Works:
- `spec_from_seed`: every WorldSpec field from the seed, in playable sub-ranges, with original seeded name grammars (5 grammars, blocklist against inspiration-game names). Specs are validated (rejected, not clamped) before use.
- Atlas pass (~300-450 ms in wasm, ~310 KB, 103-141 KB gzipped vs 2 MB budget): continent mask with sea border and a land anchor per region; macro heightmap at 32 m (hills, ridged mountains, mesas); priority-flood hydrology (rivers by `riverDensity`, lakes, sea level); climate (altitude lapse, gradient, bias, upwind moisture with rain shadows); six biomes; region biome mix, dominant + secondary element, danger from spawn; visibility-driven sites with stable ids and dense indices: >= 1 tower per region (largest viewshed), cave mouths and structures preferring "just behind a ridge" from towers, 9 structure types, settlement sites (hamlet/village/town, >= 1 per region), waypoints, landmarks, enemy camps, and gap filling until >= 98% of walkable land sees a POI within 800 m (99.9-100% on the golden worlds).
- Chunk pass: 65 x 65 heights at 2^lod m (seams match across LODs and neighbors), water surface per sample, slope-aware 6-material splat (two RGBA8 planes), seamless Poisson scatter (trees, rocks, bushes, grass tufts) with stable bijective ids, loot container and spawn anchors (wild + around sites). Detail chunk in a Chromium Web Worker: mean 2.34 ms, p95 3.73 ms (budget 8 ms).
- Collision: `collision_height` (exactly the f32 lattice mesh the chunks carry; ~1.7 us/query), `ground_normal`, `raycast`. A pure-TS `chunkSurfaceHeight` reproduces the wasm bits from chunk heights.
- Wasm ABI with no imports; `npm run build:wasm` -> `worldgen/pkg/worldgen.wasm` + `worldgen-<sha256>.wasm` + manifest.
- `@lodestone/worldgen` (worldgen/js): typed loader + pure-TS atlas/chunk readers.
- Determinism: golden table of 288 chunks over 5 worlds (every biome, water, sites, LOD 0-6) + atlas hashes + 320 collision heights; `npm run test:golden` passes in Node, headless Chromium (Web Worker), Go/wazero compiler and interpreter, and native Rust.
- Debug map on port 5180 (`npm run debug -w @lodestone/worldgen`).
- Evidence: `docs/evidence/wp01-golden.txt` (all hosts, timings, sizes), `docs/evidence/wp01-chromium-golden.json`, `docs/evidence/wp01-atlas-stats.txt`, screenshots `docs/evidence/wp01-atlas-seed7.png`, `wp01-atlas-seed1234.png`, `wp01-atlas-seed7-coverage.png`.

Known gaps:
- CI does not run `npm run test:golden` yet (needs `npx playwright install chromium` on runners); `npm test` runs the Node and Go golden checks only when the wasm is built, and CI builds it after tests. Suggest a CI step `npm run test:golden` (root file owned by WP00).
- Timings are from one desktop (i7-11700K), not a mid-range laptop; there is ~2x headroom on the 8 ms budget.
- Roads, town layouts and structure geometry are WP20; caves (`cave_build`) are WP09. Sites carry the data they need (kind, size, radius, yaw, per-site seed, element).
- Rivers follow the 32 m D8 network with a noise warp; wide rivers can look straight-segmented up close. Lakes are shaped per chunk from a warped mask.
- Low `landFraction` worlds can put outlying regions on small islands (each region is guaranteed land, not connection to the mainland).
- genVersion 1 is still tunable until the first world is minted; after that the golden table is frozen (`worldgen/golden/README.md`).

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

## WP08: Social service ✅

Branch `wp/08-social`. Details: `server/social/README.md`, `client/src/social/README.md`, decisions `docs/decisions/0008-social-service.md`, contract changes `docs/cr/001-social-relations-by-character.md` (migration 0003) and `docs/cr/002-social-protocol-v2.md` (social.yaml v2).

Works:
- `server/social` (:8093, `/ws`): social-ticket auth (`ticket.AudienceSocial`; suspended/banned owners refused), presence `presence:{charId}` (TTL 30 s, server heartbeat 10 s, WebSocket ping 20 s), `online:{worldId}` + reaper for sessions of dead processes (the-circle `reap_dead`), `name:{worldId}:{lower}` resolution with Postgres fallback, duplicate login (newest wins, across processes).
- Channels per spec 10: global (200), zone by region (100), local 30 m from presence positions with x/z for bubbles (no history), party (100), whisper (100 per conversation, 24 h), system (50, per player; `Hub.SystemMessage` and a documented bus envelope for zones). Capped lists `chat:{worldId}:{channel}[:scope]`; history on join (global, system, whispers; zone on first presence; party on join/rejoin).
- Whispers: `/w`, `/r`, case-insensitive names, offline -> `whisper_status offline` and nothing stored, unknown name -> error, blocked -> sender sees own echo + `delivered`, target gets nothing, nothing stored; local profiles whisper friends/party only and cannot send global (they read it).
- Parties (max 4; invite/accept/decline/leave/kick/promote; leadership passes to the first online member; party of one disbands; Redis state with WATCH/MULTI; 5 min reconnect grace), friends (requests, accept by asking back, remove, cap 200 incl. pending, online + region for accepted friends only), mute, block (= mute + no whispers/invites, ends friendship), reports with the last 50 messages of that channel or conversation (local: what the reporter received) into `reports`.
- Moderation: per-channel token buckets + per-frame gate, global slow mode 1/10 s, 280 characters (code points), control characters stripped, profanity filter on by default for global/zone (applied per reader; raw text stored; `set_filter` opt-out; allow-list incl. the "Bitchin'" rarity), admin CLI `server/social/cmd/admin` (reports, report, resolve, mute/unmute/suspend/ban/unban by character name, whois; logged to `moderation_log`; applied live over the bus).
- Pub/sub `social:{worldId}` carries every delivery, so several social processes share a world; whispers between players presenting different zones (and on different processes) work.
- `client/src/social`: socket client (auth, reconnect 1 -> 30 s backoff with fresh director tickets, queue until welcome, stop on `replaced`/`banned`), zustand store with a pure reducer, chat panel (channel tabs, whisper tabs with unread counts and close, `/g /z /s /p /w /r` + social verbs + `/help`, Tab name autocomplete, toasts while closed, Enter/Escape, click-a-name menu), party frame (online, region, leader controls, invites; `healthOf` slot for the zone's party ring), friends list (online + region, requests, whisper/invite/remove), speech-bubble store (`getSpeechBubble`/`useSpeechBubble` by name), presence at 2 Hz from a position source. `<SocialOverlay />` mounted in `PlayScreen` (renders nothing until `startSocial`). Dev page `client/social-dev.html` (:5175).
- Tests: Go unit (filter, limits, radius, party records), in-process integration on real Redis + scratch Postgres (every channel, whisper rules, rate limits, history/filter/mute, party lifecycle + grace, friends, reports, duplicate login, bad tickets, admin mute/ban), and `server/social/social_integration_test.go` building the binary and running two processes (global/whisper/reply/party across processes and zones, block across processes, reaping a killed process); 17 vitest tests (parser, completion, reducer, bubbles, socket reconnect with a fake WebSocket).

Evidence (`node client/src/social/dev/e2e.mjs`: account + director + social + two stand-in zones on a scratch DB, three Chromium contexts with real director tickets via dev auth and a local profile):
- `docs/evidence/wp08-e2e.txt`: Alice (zone-east, region 2,2) and Bob (zone-west, region 0,0) chat in global, zone, local, party, whisper and `/r`; Lina (local profile, 10 m from Alice) gets local + bubble and zone but not Bob's; slow mode; local profile refused global and stranger whispers, allowed to a friend; friend request/accept with online + region; Lina blocks Bob -> Bob's whisper shows "delivered", Lina receives nothing, Bob's global hidden from her; report + admin CLI mute applied live; reload keeps party and restores history. Screenshots `wp08-01…09-*.png`; admin transcript `wp08-admin.txt`.
- Bot flood (`server/social/cmd/flood`, 50 clients x 40 msg/s x 20 s over 5 channels, 40,000 messages): accepted global 100 / zone 650 / local 1,200 / party 1,350 / whisper 1,200, rejected 33,500; no client beat its bucket bound (max per client = bound - 1 on every channel); the observer saw exactly the accepted lines; `wp08-flood.txt|json` (+ server metrics).

Known gaps:
- Local and zone routing trust the client's `presence` positions; prefer spec 11's zone-written `worldpos:{worldId}` once a zone writes it (no zone does yet).
- Speech bubbles are a data store only: rendering above remote players needs WP06's nameplates (`getSpeechBubble(name)` / `useSpeechBubble`). Nothing calls `startSocial` in the real play flow yet; WP06's title -> account -> play wiring should (snippet in `client/src/social/README.md`).
- `voice_token` answers "Voice is not available yet" (LiveKit, earshot sets and voice block are the voice package's).
- Party ids are strings in Redis; the zone's party ring still uses its stub party id (WP03 gap); a zone needs `partyof:{charId}` to map members.
- Fast travel to a friend/party member (spec 10) needs waypoints (gameplay packages); the friends list has no Travel button yet.
- Account names used by the admin CLI must belong to real character rows; ticket-only characters (bots) cannot be moderated.
- Local-profile sanctions (`social_sanctions`) are enforced by social only; the director does not check them at connect.
- The profanity list is short and English only; it does not yet filter character names (WP04 gap).
- 0001's `friends`/`blocks` tables are now unused (kept: additive rule).

Assumptions:
- "Can't use global chat" for local profiles = can read, cannot send (like listen-only voice). The whisper restriction applies to local senders only.
- Zone chat is scoped by the presence region string (`"x,z"` of 1024 m regions), not by zone server id, per spec 10 "everyone in your current region".
- Local chat has no stored history (spec 10 table); reports on local chat capture what the reporter's session received.
- Friend requests count toward the 200 cap; online status/region is shown for accepted friends only.
- System channel stores service notices (friend requests, party disbanded/removed, declined invites) per player; transient replies ("Invited Bob") are `system` frames, shown inline.
- Shared files touched: `client/src/screens/PlayScreen.tsx` (import + `<SocialOverlay />`), `contracts/social.yaml` + regenerated `contracts/ts/src/gen/social.ts` and `server/pkg/socialproto/social_gen.go`, new `contracts/migrations/0003_social.sql` (applied to the shared dev DB with `npm run migrate`), `docs/cr/`, this section.
