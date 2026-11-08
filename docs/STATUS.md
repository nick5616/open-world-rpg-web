# Status

One section per work package (spec 15). Each package edits only its own section.
Gates: G0 ✅ · G1 ✅ · G2 ✅ · G3 ⏳ · G4 ⏳ · G5 ⏳

## Gate evidence (orchestrator)

- **G0**: docs/evidence/wp00-dev-smoke.log.
- **G1**: same chunk hashes in Node, Chromium and Go/wazero (docs/evidence/wp01-golden.txt, re-run on main after merge); one player walks generated terrain solo in `npm run dev:solo` (docs/evidence/wp05-*).
- **G2**: two browsers see each other on *generated terrain* over the binary protocol under "thailand": docs/evidence/g2-two-browsers-terrain-ws.txt and g2-terrain-ws-*.png (run on main after the WP05 merge: 0 local corrections, 0 remote teleports; a first run on a heavily loaded machine (2 fps headless) logged one 58 cm eased remote jump, the re-run had none). 150-bot soaks within budget: wp03-soak-*, wp07-soak-spread.*. Chat and whispers: wp08-e2e.txt. Known gap: the WP06 acceptance harness doesn't start the social service, so its browsers log refused social sockets (harmless; WP08's e2e covers social).

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

## WP07: Server terrain and collision ✅

Branch `wp/07-server-terrain`. Decisions: `docs/decisions/0007-server-terrain.md`. Package: `server/pkg/worldhost/README.md`.

Works:
- `server/pkg/worldhost`: wazero host for `worldgen.wasm` (compiled once; refuses any import or another ABI; loaded from `LODESTONE_WORLDGEN_WASM`, default `worldgen/pkg/worldgen.wasm`, optional `LODESTONE_WORLDGEN_WASM_SHA256` pin), pooled instances with the atlas copied into each (trapped instances replaced), wrappers for `spec_from_seed`, `atlas_build`, `chunk_build`, `collision_height`, `ground_normal`, `raycast`, `hash_buffer`.
- Pin: `OpenRow` refuses a world whose `gen_version` differs from the wasm's and rebuilds the atlas and compares `atlas_hash`; placeholder rows open from `spec_from_seed(seed)`. The zone exits 1 on a refusal (`TestZoneRefusesWrongGenVersion`).
- Chunk cache by interest (`worldhost.Terrain`, a `movement.Ground`): pure-Go collision formula on cached LOD 0 heights (23 ns/query, bitwise equal to the wasm), wasm `collision_height` on a miss (2.7-5 us), never generates in a query; background workers on their own instances; per-player `Want` (48 m + 3 s of travel, twice a second); LRU (3072 chunks) that never evicts chunks wanted in the current epoch. Terrain share of a 150-player tick: 46 us (`docs/evidence/wp07-bench.txt`).
- Zone on terrain: ground snapping via the shared movement step, Welcome carries the real seed and genVersion ("1"), `/debug/zone` adds spec + atlasHash, `/debug/terrain` and `zone_terrain_*` metrics; vertical validation (rise <= one jump step or onto the snapped ground, never below ground) next to WP03's horizontal bound; spawns: saved positions respected (lifted if below ground), new characters (no row or WP04's `(2048, 0, 2048)` creation placeholder) on a dry cell within 8 m of the atlas spawn settlement.
- Minting: the account service mints the official world on startup (`server/pkg/worldhost/mintdb`: insert minted, or upgrade a placeholder row in place keeping id + seed, never touch a minted row); `go run ./server/pkg/cmd/mintworld [-official]` does it on demand. Official world seed 20261108 = "Highmarch of Beigleifeild", genVersion 1, atlas `50ae4562cfd25265`. Evidence: `docs/evidence/wp07-mint.txt` (placeholder -> upgraded -> already-minted -> zone pins and serves it).
- Bots (`-terrain auto|on|off`): rebuild the zone's world (refuse on atlas hash mismatch), predict on terrain, spawn on dry land, turn back from the sea, warm their chunks before connecting.
- Acceptance, bots on terrain (scratch DB, zone serving the minted official world, 150 bots, 75 s): spread `docs/evidence/wp07-soak-spread.txt|json|prom`: **360,043 prediction checks, 0 mismatches, max error 0 cm**, tick p50 0.84 / **p99 1.27** / max 2.1 ms, bots between 26.6 and 383 m altitude, 2,018 chunks generated (mean 5.2 ms), 182 wasm misses vs 2.85M cache answers, downlink max 21.7 kbps. Clustered (300 m disc) `wp07-soak-clustered.txt`: 359,924 checks, 0 mismatches, tick p99 3.19 ms.
- Acceptance, heights match exactly: `go run ./server/pkg/cmd/heightcmp -n 10000` (`docs/evidence/wp07-heights.txt`, full table `wp07-heights-table.csv.gz`): Go/wazero compiler, Go/wazero interpreter, Go fast path, Node `collisionHeight`, Node `chunkSurfaceHeight`, Chromium 131 Web Worker `collisionHeight` and `chunkSurfaceHeight` **all bit-identical at 10,000/10,000 points** (incl. lattice points, cell diagonals, chunk borders, out-of-world), same atlas hash in every host.
- Tests: worldhost unit tests (golden collision heights, 20k-point bitwise fast path, cache never blocks, eviction, concurrency, pin/mint, spawns, movement on terrain) + benchmarks; mintdb against scratch Postgres DBs; zone in-process session on terrain (server == prediction to the cm while climbing), spawn and validation tests; subprocess tests (zone binary on terrain vs a client with its own worldhost; refusal); heightcmp test spawns Node; bots land-spawn/sea tests. go vet + gofmt clean; `npx eslint` clean for `server/pkg/worldhost/jscheck`.

Known gaps:
- Slope rules (`WALKABLE_SLOPE_DEG`, `MAX_STEP_UP_M`) are applied on neither side: the ground snap walks up any slope. Client and server stay identical; WP10 adds slopes to both with climb/slide, and must extend `verticalOK` (zone `internal/game/terrain.go`) for climb and glide.
- Terrain makes y/vy change every tick for walking players: clustered downlink rose from avg 102 / max 137 kbps (flat) to avg 121-127 / max 152-163 kbps, so one clustered run exceeded the 160 kbps budget (`wp07-soak-clustered*.txt`, flat baseline `wp07-soak-clustered-flat-baseline.txt`). For WP06's per-client byte budget (decision 0005).
- Three of five clustered terrain runs showed tick stalls (p99 40-125 ms, max 450-770 ms; `wp07-soak-clustered-noisy-run.txt`) while other agents loaded the shared machine; repeats with gctrace and a tick poller were clean (p99 3.2-3.4 ms, GC pauses < 1 ms, no wasm work in steady state). Not reproduced, not explained; re-measure on a quiet box (WP18).
- CI runs `npm test` before `npm run build:wasm`, so every terrain test skips there. Suggest (WP00/WP18 own CI) a step after the wasm build: `LODESTONE_REQUIRE_WASM=1 npm run test:go` and `go run ./server/pkg/cmd/heightcmp -n 10000`.
- Without a built wasm the zone falls back to flat ground (dev only; fatal with `LODESTONE_ZONE_REQUIRE_TERRAIN=1` or in production) and the account service keeps a placeholder row.
- Welcome's position is cm-quantized; a client spawned there should take y from its own terrain (the bots do). Note for WP06 in `server/zone/README.md`.
- No cave collision yet (WP09 owns `cave_build`); `raycast`/`ground_normal` are wrapped but the zone doesn't use them yet. Chunk records (scatter/container/spawn ids) are cached for WP09/WP13 but unused.
- Timings from one desktop (i7-11700K, Windows 11), shared with other agents.

Assumptions:
- `worlds.gen_version` holds the generator major version ("1"), not the wasm content hash the 0001 migration comment mentions; `atlas_hash` is the strong pin (decision 0007). No contract change.
- A character whose saved position is exactly WP04's creation default `(2048, 0, 2048)` has never been checkpointed and gets the atlas spawn.
- Shared files touched: `server/pkg/go.mod`/`go.sum` (wazero), `server/pkg/README.md` (rows), `server/zone/main.go` (terrain load, Ground, /debug/zone fields), `server/zone/internal/game/{server.go (1 line), session.go (spawn calls), entity.go (2 lines), persist.go (World spec/atlasHash)}`, `server/zone/zone_integration_test.go` (1 env line: keep it flat), `server/zone/README.md` (appended section), `server/account/main.go` (`seedWorld`) + README, `tools/bots/{bot.go, main.go, README.md}`. No contract changes, no worldgen changes.

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

## WP05: Chunk streaming, terrain rendering and textures ✅

Branch `wp/05-terrain`. Details: `client/src/world/README.md`, decisions `docs/decisions/0009-world-rendering.md`, texture pipeline `tools/textures/README.md`.

Works:
- `npm run dev:solo` → Play: the solo player spawns on land at the atlas spawn (seed 20261108, same as WP04's official world; `?seed=` for others) and walks generated terrain. Ground = `WorldGround` straight over the wasm `collision_height` (the function WP07 runs): unit-tested bit-equal to the wasm and to `chunkSurfaceHeight` at 2,000 points; the lod-0 tile mesh is the same surface (same lattice, same diagonal, tested). The Vite config builds `worldgen.wasm` on first start if missing.
- Workers: `min(hardwareConcurrency - 2, 4)` running worldgen.wasm (one compiled `Module` shared), priority queue with dedupe/cancel, transferred buffers; jobs for tiles, scatter, grass, atlas, hash, LRU eviction. Atlas built in a worker (~0.55 s) or loaded from IndexedDB (verified by hash); built tile meshes cached in IndexedDB keyed (atlasHash, genVersion, mesh format, lod, cx, cz), LRU cap 500 MB, read/written inside workers. Stores live in WP04's `lodestone` DB as `cache:atlas`, `cache:terrain-mesh`, `cache:terrain-meta` (prefix `cache:`, so `clearCaches()` never touches saves).
- Terrain: plain three.js chunk manager. Quadtree of worldgen's own chunk tiles (65 × 65 at 2^lod m), split by distance with hysteresis, balanced to one level; predictive streaming (current view + 2.5 s along velocity + 60 m along the look direction + an idle "next ring"); uploads time-sliced (≤ 4 tiles and ≤ 5 ms per frame on high). Geomorphing: tiles replacing their parent ease out of the parent's shape over 0.6 s, merges ease in before the swap, edges bordering coarser tiles are stitched exactly to the coarser lattice, skirts cover transients. Distant terrain beyond the streamed tiles is one mesh straight from the atlas heightmap (coverage texture keeps the two from overlapping).
- Splat shader on `MeshStandardMaterial`: 9 texture-array layers (grass, dirt, highland rock, snow, sand, mud, forest floor, cliff, badlands cliff) blended by the generator's 6 splat weights + biome, height-blended, triplanar rock on slopes > ~50°, anti-tiling second sample, moisture/biome grass tint, flat measured mean colours until the arrays arrive (pbrMaterial rule), normal maps off on low.
- Textures: 11 CC0 sets downloaded from 3dtextures.me by `tools/textures/fetch-sets.mjs` (reads each post's Drive folder) + 2 reused from refs/3d-portfolio-website (only marble-white and stone-column existed there; no terrain sets). `tools/textures/build-textures.mjs` (port of build-textures.mjs): per-set color/normal/ORM WebP, and KTX2 (Basis Universal, `ktx2-encoder` npm package driven in 2D-array mode) arrays: color 900 KB, normal 2.36 MB, ORM 378 KB. `pbrMaterial.ts` rules applied in the terrain loader. `CREDITS.md`.
- Scatter: procedural trees (3 archetypes × 2 mesh LODs + runtime-rendered impostor billboards beyond 200 m), rocks, bushes, grass tufts from the generator records, plus dense grass clumps from workers; world-wide InstancedMeshes re-binned by distance, per-instance dithered LOD cross-fades and far-edge fade-in on the GPU; stable ids kept per instance (`idAt`, `hide(id)`).
- Shared wind field `client/src/world/wind.ts` (CPU `windAt`/`windGust` + `WIND_GLSL`, from WorldSpec windDirection) drives grass, leaves, bushes, clouds.
- Sky: analytic single scattering (Rayleigh + Mie, Kasten–Young airmass) driven by the world clock, sun disk, moon, stars, drifting clouds; sun/moon light colour and sky ambient from the same model. Water: tile water with exact per-vertex depth fade + camera-following sea plane, sky reflection, moving normals, glints, foam. Shadows: CSM, 3 cascades high / 2 medium / none low, patched so other packages' plain materials use cascade 0 only. Post: height fog with sun in-scattering from depth, god rays at half res (high), bloom (medium/high), ACES, lift/gamma/gain grade per time of day and biome. Every effect has a tier switch (`client/src/world/config.ts` WORLD_TIERS + WP02 presets).
- Debug: HUD chunk queue / loaded filled; F4 adds terrain tile outlines coloured by LOD; debug panel World section: "Regenerate chunk + compare hash" (worker build, main-thread build and the hash the loaded mesh was built from: MATCH in the benchmark) and per-biome teleports; `window.__lodestoneWorld`.
- Traversal benchmark `client/src/world/bench/traversal.mjs` (`npm run bench -w client`, against the production build): headless Chromium on the real GPU via ANGLE/D3D11 (an RTX 3070, the spec's high-tier reference class), 20 s walk + a 43 s flight at 80 m/s through forest → highlands → snowpeak → badlands → wetland → meadow, then beauty shots. Results (`docs/evidence/wp05-traversal.md`, `wp05-traversal-{high,low}.json`, log `wp05-traversal-run.txt`):

  | Budget | High 1920×1080 | Low 1280×720 |
  | --- | --- | --- |
  | Draw calls ≤ 400 | max 215 | max 79 |
  | Triangles ≤ 1.5 M | max 1.46 M all passes (1.01 M visible + shadow maps) | max 0.47 M (no shadows on low) |
  | Long tasks > 50 ms | 0 | 0 |
  | JS heap ≤ 600 MB | max 73 MB | max 61 MB |
  | Chunk generation ≤ 8 ms (worker, wasm) | p95 5.8 ms, mean 3.3 ms (mesh build +2.5 ms) | p95 6.4 ms, mean 4.3 ms |
  | Download before first playable ≤ 15 MB gz | 4.3 MB (JS 0.41, wasm 0.38, KTX2 3.7) | 2.0 MB (no normal array on low) |
  | Frame time (16.6 / 33 ms) | p99 16.8 ms at vsync, 0 dropped; uncapped (`LODESTONE_BENCH_UNCAPPED=1`, earlier build) p50 1.7–2.3 ms, p99 9 ms | p99 16.8 ms at vsync |
  | First playable | 3.05 s after navigation (local preview server) | 1.85 s |

- Screenshots: `docs/evidence/wp05-meadow.png`, `wp05-forest.png`, `wp05-snowpeak.png`, `wp05-valley-sunset.png`, `wp05-dawn-fog.png`, `wp05-lod-tiles.png` (LOD outlines), `wp05-debug-panel.png` (hash MATCH).
- Tests: 34 vitest tests in `client/src/world` (quadtree coverage/balance/hysteresis/fallback, tile index diagonal, lod-0 mesh = collision surface, full morph = parent lattice, skirt/face orientation, water depth, worker pool priorities/cancel, LRU, ground = wasm, spawn on land, grass determinism, wind convention, atmosphere colours, CSM patch, texture manifest contract); `node --test` for tools/textures. tsc/eslint clean.

Known gaps:
- Frame-time budgets are verified only on an RTX 3070 (headless, real GPU). The low tier's "integrated GPU at 720p" budget is not measured on integrated hardware; SwiftShader (software GL) is far slower than any GPU and not representative. Medium tier not benchmarked separately.
- "No visible pops at walking speed" is by construction (time-based geomorphs, stitched edges, dithered scatter LODs) and checked by eye in captures; there is no automated pixel-pop metric.
- Trees, rocks and bushes are procedural low-poly meshes; impostors are single-view billboards rendered at load, not baked octahedral impostors; leaves are solid canopies (shadows dapple per canopy, not per leaf; no alpha-tested leaf cards).
- Not built (spec 12 extras outside the WP05 list): SSAO, cloud shadows, weather particles, rain wetness (a `uWet` uniform exists in the terrain shader), snow accumulation, fireflies/dust motes, ambient soundscapes, LUT files (grading is parametric), dynamic resolution, far cascades updated every few frames, shader warmup for world materials (programs compile during the loading veil instead).
- Horizon tiles per region are not baked at mint: the distant mesh is built on the client from the atlas heightmap (one 129 × 129 mesh, cheap).
- Water has no refraction or reflections of terrain (by spec), and river surfaces follow the 2 m water lattice.
- The mesh cache key adds the atlas hash and a mesh-format version to the spec's (genVersion, chunk, lod).
- The texture pipeline needs `npm install` of `sharp` and `ktx2-encoder` (devDependencies of `tools/textures`); built outputs are committed.

Assumptions:
- Solo world = `spec_from_seed(20261108)` regenerated locally (no server to download the atlas from); online, WP06 should pass the world's seed/atlas.
- Spawn: solo teleports to the atlas spawn via the debug-store teleport (the controller's hard-move API); online spawn stays with the zone server (`WorldCanvas spawnOnLand` defaults to SOLO).
- Shared files touched (minimal): `client/src/scene/GameCanvas.tsx` (`environment` and `ownComposer` props), `client/src/screens/PlayScreen.tsx` (`<WorldCanvas />` instead of `<GameCanvas />`; takes the same props, so WP06's `onStep` moves over unchanged), `client/src/hud/DebugPanel.tsx` (mounts the World section), `client/vite.config.ts` (build wasm if missing; ES-module workers), `client/package.json` (`bench` script), `package-lock.json` (new `tools/textures` workspace), `CREDITS.md` (new, root), `docs/decisions/0009-world-rendering.md` (new). No contract or worldgen changes.

## WP17: WorldSpec creator tool ✅

Branch `wp/17-creator`. Details: `tools/creator/README.md`, `tools/creator/server/README.md`, decisions `docs/decisions/0017-creator-tool.md`.

Works:
- Web app (`tools/creator/web`, Vite on 5177, `/v1` proxied to the endpoint): seed field with Random and **From seed** (spec_from_seed via the wasm, the default path; minting sends only the seed), name field, 7 presets (Archipelago, Highland, Badlands + original Frostreach, Mirewood, Verdant Vale, Starfall Wilds) laid over the seed's spec, a slider for every numeric field from `WORLDSPEC_RANGES` (weights grouped with share %), palette / name grammar pickers, loot theme chips capped at 4, vibe box (disabled with a notice when the server's flag is off), mint button, minted-world list.
- Live 2D atlas preview built by worldgen.wasm in a Web Worker (debounced 200 ms, latest-wins): biomes with hillshade, sea/lakes, rivers, region grid with names and elements, towers, settlements to scale with names, structures, cave mouths, waypoints, landmarks, camps, spawn; stats (atlas hash, ms, size, land %, sea level, peak, 800 m POI coverage, site counts by kind, biome shares) and a region table. Rendering adapted from `worldgen/debug/`.
- Normalize gate identical in TS (`web/src/spec/normalize.ts`, ajv 2020) and Go (`server/internal/spec`, santhosh-tekuri/jsonschema): structural validation against the contract schema minus the clampable constraints, clamp (ranges, half-up integer rounding, weights / max, name cleaning + word-prefix blocklist, canonical uint64 seed, unknown/duplicate/surplus loot tags dropped), strict validation. 42 shared fixtures (`tools/creator/fixtures/normalize.json`) replayed by Go with exact float equality; idempotence tested.
- Go endpoint (`tools/creator/server`, :8094): `GET /v1/config`, `GET /v1/worlds`, `POST /v1/normalize`, `POST /v1/mint` (`{seed}` = spec_from_seed untouched; `{spec}` = normalized) -> wazero atlas_build -> `worlds` row `(name, seed, canonical spec, gen_version "1", atlas_hash 16 hex, official=false)`, same format as WP07's worldhost; re-minting the same world returns the existing row. Bearer token option (required in production). Metrics.
- Vibe path behind `LODESTONE_CREATOR_LLM=1` + `ANTHROPIC_API_KEY`: one plain net/http Messages API call (`claude-haiku-5-5`, `output_config.format` JSON schema, effort low), normalize, at most one retry, creator's seed always wins, Redis cache by sha256(normalized prompt + specVersion). With the flag off the model client is never constructed (`TestFlagOffNeverReachesModel` + the process test count zero requests on an injected transport and a reachable fake API).
- Tests: Go unit (normalize/fixtures, model schema, wazero host vs golden atlas hashes, store with concurrent dedupe on a scratch DB, vibe client/service against the fake API incl. retry, refusal, 500, cache), `creator_integration_test.go` (builds and runs the binary: mint from seed (golden hash for seed 1234), sliders and vibe, rows in Postgres, cache in Redis, restart flag off = 0 model requests); 12 vitest tests (fixtures fresh, clamps, presets in range and through the wasm, slider coverage). eslint, tsc, go vet, gofmt clean.

Evidence (`npm run e2e -w @lodestone/creator`: built endpoint + fake Messages API + Vite + headless Chromium, scratch DB):
- `docs/evidence/wp17-e2e.txt`: 20 checks, ALL PASS. Mints from seed only, Archipelago preset, slider edits (source "sliders") and vibe text (fake model; caveDensity 1.4 -> 1, caveMaxDepth 300 -> 256, tag "gothic" dropped), and with the flag off a Frostreach preset mint; every server atlas hash equals the browser preview's; repeat vibe served from cache; flag off: vibe button disabled + notice, `POST /v1/vibe` 503, fake model request count unchanged.
- Mint logs `docs/evidence/wp17-mint-flag-on.txt`, `wp17-mint-flag-off.txt`, fake model log `wp17-fake-model.txt`, rows `wp17-worlds.json`, test run `wp17-tests.txt`.
- Screenshots `docs/evidence/wp17-01-seed-only.png`, `wp17-02-preset-archipelago.png`, `wp17-03-sliders.png`, `wp17-04-preset-highland.png`, `wp17-04-preset-badlands.png`, `wp17-05-vibe.png`, `wp17-06-flag-off-frostreach.png`.

Known gaps:
- The real Messages API was never called (no key in this run, and tests must not): the request shape follows the current docs (`output_config.format` json_schema, `anthropic-version: 2026-10-21`) but is verified only against the fake. First real use should check one response by hand.
- Uses its own wazero host (`internal/worldgen`, adapted from the golden harness) because WP07's `server/pkg/worldhost` was not on main; switch to it after WP07 merges (row format already matches).
- No world deletion, renaming or "make official" in the tool; minted worlds are `official=false` and show up in the account/director world list immediately. Nothing stops a creator from minting many worlds (admin tool; protect it with `LODESTONE_CREATOR_TOKEN` and keep it off the public internet).
- `npm run dev` does not start the creator (run `npm run server` + `npm run dev` in `tools/creator`); not wired into CI beyond the workspace test/lint runs (the Go process test skips without infra/wasm unless `LODESTONE_REQUIRE_*`).
- The vibe cache in local Redis is lost on restart (no persistence); it only costs a model call.

Assumptions:
- "Validate then reject" applies to structure; ranges and tags are clamped (decision 0017). Unknown palette / nameGrammar values and extra keys are rejected, not guessed.
- "Renormalize weights" = divide each group by its max (the generator's own normalization), all-zero -> all 1. Seed-only mints are stored exactly as spec_from_seed returns them.
- The model never chooses the seed; `specVersion` is clamped to 1.
- Creator names use the worldgen blocklist per word prefix; a name that cleans to under 3 characters is rejected.
- Shared files touched: `go.work` (+ `./tools/creator/server`), `package-lock.json` (new workspace `@lodestone/creator` with `ajv@8`). No root `package.json` change (`tools/*` already a workspace glob), no contract or migration change.

## WP12: Towers, waypoints and the map ✅

Branch `wp/12-map`. Decisions: `docs/decisions/0012-exploration.md`. Contract change: `docs/cr/003-exploration.md`. Package docs: `client/src/world/structures/README.md` (structure overlay interface for WP20), `server/pkg/structures/README.md`, `server/zone/internal/explore/README.md`, `client/src/ui/map/README.md`, `server/zone/README.md` (Exploration).

Works:
- **Structure overlay on the ground query** (TS `client/src/world/structures/overlay.ts`, Go `server/pkg/structures`): `ground = max(terrain, structures)`. Towers are solids of revolution built from every atlas tower site: 4 m top, 13 m upper wall, 1.4 m rest ledge, lower wall down to the terrain, 80° walls, top 28 m above the highest ground under it. Bit-identical: a Go-generated golden file (~4,400 points incl. the real seed-20261108 world over wasm terrain: heights, structure index, normals) is replayed by vitest. `WorldRuntime.ground`, the zone's movement ground and the bots' prediction ground all include it. Until WP10 adds slope rules the ground snap carries walkers up the walls; the zone process test walks up a tower (41.5 m) predicting on the client-side overlay and agrees with the zone binary **to the centimetre**.
- **Visuals**: towers as one merged mesh of the exact collision profile (procedural dressed stone, merlons, flagstone top, floating lodestone crystal amber → cyan when unlocked, light pillar over unlocked towers); instanced waypoint stones with a rune lit when activated. 1 + 4 draw calls for all of them.
- **Zone exploration** (`server/zone/internal/explore`, glue in `internal/game/{explore,party,persist_progress}.go`), server-validated at 10 Hz from position only: tower top (the overlay says you stand on that tower's platform) unlocks the tower, reveals its region and grants 150 XP once; waypoint touch (3 m) activates it and sets the respawn point; a discovery radius per site kind (settlements, structures, towers, caves, landmarks) grants XP once per character; wizard-wars level curve. Fast travel (`Interact` site) to unlocked towers/waypoints with a cooldown and denial reasons; `Server.Teleport` + teleport Event (kind 2) to self and observers; `Server.RespawnPoint` hook for WP13. Personal pins (10) and one party pin per member.
- **Party ring** (was a stub): the zone polls the social service's `partyof:{id}` keys every 2 s and sets the snapshot `partyId`; party members see each other at any distance (compass, map). Party pins are relayed by the zone and stored in Redis (`partypins:{worldId}:{partyId}`).
- **Persistence**: accounts in `characters.level/xp/last_waypoint` + `character_progress` bitsets + a new `pins` column (migration `0012_exploration_pins.sql`), one transaction through the write-behind queue on change/checkpoint/logout; the session is read-only for progress if the login read fails. Local profiles: the zone verifies `Hello.saveBlob` (localsave), loads progress and position from it, and re-issues `SaveBlob` on change (at most every 5 s) and at checkpoints; the client stores it in IndexedDB.
- **Client** (`client/src/ui/map`): map on M (paper for unrevealed regions, atlas terrain with contours for revealed ones, sites by visibility, pins, party members, player arrow, zoom/pan, select + "Fast travel here", right-click pin, Shift+right-click party pin), compass strip (heading, party members, pins, distances), discovery/tower/waypoint/level toasts, `window.__lodestoneMap` debug handle. `zoneSession` gained `onEvent`/`onSaveBlob`/`sendInteract`.
- Tests: Go unit (`structures`; `explore`: rules, levels, pins, payload vectors), in-process zone sessions (tower climb → unlock → fast travel + cooldown, waypoint/respawn, party ring + party pins + leaving, progress save/reload with no double XP, local-profile blob round trip on real Redis), `server/zone/zone_explore_integration_test.go` (zone binary); vitest (overlay golden, payload vectors from Go, reducer, compass maths, map visibility). `npm run lint` clean (eslint, tsc, go vet, gofmt, clippy).

Evidence (`node client/src/ui/map/dev/acceptance.mjs`: real account + director + zone + social on private ports and a scratch DB, two headless Chromium processes on the GPU, dev auth): `docs/evidence/wp12-acceptance.txt`, ALL PASS. Party via `/invite` + the party frame; both on each other's compass; waypoint touch; a 511 m sprint + climb of "The Forgotten Spire" → region 5 revealed, +190 XP for the tower (40 discovery + 150 climb) and +50 for a mine passed on the way; Alyssa's party pin (map UI) on Bruno's map and compass; a personal pin stays personal; fast travel waypoint → tower through the map UI (2 teleport Events, lands on the top); no XP granted twice; a reload restores revealed regions/XP/unlocks/pins from Postgres; no page errors. Also `wp12-acceptance.json`, zone log `wp12-zone-exploration.log`, screenshots `wp12-tower.png`, `wp12-tower-top.png`, `wp12-map-revealed.png`, `wp12-map-pins.png`, `wp12-map-bruno.png`, `wp12-compass.png`, `wp12-compass-strip.png`, `wp12-fast-travel-top.png`.

Known gaps:
- Climbing proper is WP10's: today the ground snap walks up the 80° walls (no stamina, instant). WP10's slope rules apply to tower walls unchanged, but WP10 must read normals/slopes through the combined ground (`normalAt`/`slopeAt` on `StructureGround` in TS, `NormalAt` on `structures.Ground` in Go), not the bare terrain. `verticalOK` already accepts snapping up a tower wall.
- If WP09/WP20 change generator output (new genVersion), regenerate the overlay golden (`go test ./structures -run Golden -update` in `server/pkg`); the TS test re-checks it.
- Tower merlons are visual only (a heightfield has no parapets); waypoint stones have no collision.
- Party pins on another zone arrive on the next 2 s poll; the party ring is per zone (the cross-zone far ring is spec 9's `worldpos` feed, not built).
- Local profiles: a blob issued while the socket is open but lost before IndexedDB stores it leaves the stored blob stale (spec 11's scheme has no ack). Pins in a local blob are not copied into `character_progress.pins` on upgrade (account service, WP04).
- Offline (`dev:solo`) the map and compass work but nothing reveals (progress is the server's).
- Migration 0012 was applied only to the scratch acceptance DB, not the shared dev DB: run `npm run migrate` after merge (until then progress saves fail and retry, logged).
- `client/src/input/useMouseLook.ts` grabs pointer lock on a mousedown on any canvas; the map canvas stops that event. Other packages adding canvases in overlays need the same.

Assumptions:
- Discovery set = settlements, structures, towers, cave mouths, landmarks (not waypoints, not enemy camps); XP values and radii in `explore.go`. Climbing a tower gives its own 150 XP on top of the discovery.
- One party pin per member; a member can remove only their own.
- Revealed regions are derived from unlocked towers (no extra column); `last_waypoint` stores the site's stable id as int64 bits.
- Fast travel has a 2 s cooldown and works anywhere (no combat yet); towers arrive on the top centre, waypoints 2.5 m in front of the stone.
- Shared files touched: `client/src/net/zoneSession.ts` (callbacks + `sendInteract`), `client/src/net/NetPlay.tsx` (2 lines), `client/src/world/core/runtime.ts` (ground = overlay), `client/src/world/WorldCanvas.tsx` (mount `StructuresLayer`), `client/src/screens/PlayScreen.tsx` (mount `ExplorationHud`), `server/zone/{main.go, internal/game/server.go, session.go, entity.go}` (hooks, a few lines each), `server/pkg/localsave/state.go` (optional `Pins`), `tools/bots/{bot.go,main.go,terrain.go}` (predict on the overlay), `contracts/events.md`, new `contracts/migrations/0012_exploration_pins.sql`, `docs/cr/003-exploration.md`, README rows in `server/pkg/README.md` and `client/src/world/README.md`, a section in `server/zone/README.md`. No `protocol.yaml`, `social.yaml`, constants or worldgen change.

## WP11: Proximity voice ✅

Branch `wp/11-voice`. Decisions: `docs/decisions/0011-proximity-voice.md`. Contract change: `docs/cr/004-voice-speaking-and-earshot.md` (protocol v2 `InputFlag.speaking`; earshot message on Redis `voice:{worldId}`). Package docs: `server/social/voice/README.md`, `server/social/voice/voicebots/README.md`, `client/src/voice/README.md`, `server/zone/README.md` (Proximity voice: earshot).

Works:
- **Earshot in the zone** (`server/zone/internal/voice`, `internal/game/earshot.go`, `voice.go`): every 250 ms the tick copies positions and a runner goroutine computes the sets: 3D distance, join 40 m / leave 48 m, at most 12 nearest with an 8 m head start for current members (no top-12 swapping in a crowd), cave rule ready for WP09 (`Player.Cave`). Published to `voice:{worldId}` (full every 2 s, deltas only on change, `gone`). Off the tick: 300 players packed together cost ~1.5 ms on the runner and microseconds on the tick. `InputFlag.speaking` is mirrored into `Activity.speaking` (never for local profiles).
- **Social service** (`server/social/voice`, wired in `internal/social/voice.go` and `voicecfg.go`): `voice_token` returns the LiveKit URL, the world's room and an HS256 join token (identity = character id, name = character name; `canPublish` false for local profiles and moderator-muted players; microphone only; no data channel). One reconciler per world (Redis lease `voicelead:{worldId}`): earshot ∪ party − blocks (both ways) − mutes (one way), mapped to the room roster's audio tracks and diffed against what was applied (keyed by participant and track sid, so reconnects and republishes heal), applied with `UpdateSubscriptions` over LiveKit's Twirp API (no SDK). A heal pass runs every 10 s; a silent zone's sets are dropped after 6 s. Metrics `voice_*`, `/debug/voice`.
- **Client** (`client/src/voice`): livekit-client with auto-subscribe off and one AudioContext. Per speaker: gain (per-player volume/mute) → occlusion low-pass (terrain between the heads, checked 4 times a second per speaker on the ground the player walks on) → HRTF `PannerNode` at the speaker's interpolated head every frame (inverse, ref 2 m, max 40 m). Party members beyond earshot crossfade to a flat radio branch (300 Hz-3 kHz, soft clip). Push-to-talk on V: the mic is requested at the first push, never at connect. Voice activation is an opt-in setting. Local profiles see a listen-only HUD. Speaking indicators port the-circle `audio.ts`: an analyser per track writes `--lvl`/`data-speaking` to DOM nodes outside React. Nameplates show "speaking" from the local analyser or the zone bit. The HUD (bottom right) shows PTT state, who you hear with level bars, and settings (talk mode, master volume, per-player volume and mute, saved locally). Debug: `window.__lodestone.voiceDebug()`.
- **Acceptance, voice soak scenario 3** (`server/social/voice/voicebots`, `docs/evidence/wp11-voice-soak-50.txt|json`): 50 Go/pion bots, each a zone player, a social session and a LiveKit participant publishing synthetic Opus speech, cluster within 14 m, walk out for 20 s, stand, then walk back.
  - **872 earshot changes, 872 reflected at the listener, 0 missed, 0 extra, 0 flaps (listener and zone), at most 3 changes per pair.**
  - Zone decision → listener hears (TrackSubscribed) or stops hearing (forwarding stopped): **p50 32, p99 269, max 306 ms; 100 % within 500 ms.** Subscribe p99 275 ms, unsubscribe p99 70 ms.
  - Distance crossing → listener: p50 168, p99 343, max 414 ms. Zone decision → LiveKit answered: p50 4.9 ms.
  - 1.47 M audio packets received; zone tick p99 2.8 ms with 50 players.
- **Acceptance, two people walking apart** (`node client/src/voice/dev/walkapart.mjs`, `docs/evidence/wp11-walkapart.txt|json`, `wp11-walkapart-*.png`). The run used real account, director, zone, social and LiveKit services, plus two Chromium processes with a fake microphone (a steady harmonic tone). Both players held V while B walked ahead of A, then 62 m to A's right, then back across to A's left, then (after a `/invite`) on to 80 m as a party member. A's actual audio output was measured. **ALL PASS**:
  - **Fade:** B is 18.8 dB quieter at 30-40 m than at 3-7 m (the model predicts 17.2 dB); Spearman(distance, level) is −0.994.
  - **Pan:** the right ear is +4.0 dB louder when B is on A's right, the left ear +4.3 dB when B is on the left, and the louder ear was on B's side in 121/121 off-centre samples.
  - **Earshot:** A's output was silent in all 40 samples past 51.5 m and A was unsubscribed past 56.6 m. A was subscribed in all 132 samples inside 38 m.
  - **Panner position:** it sits on B's drawn head (p95 0.34 m) and trails B's true head by the interpolation delay (p95 1.95 m).
  - **Speaking indicators:** A's DOM level bar showed `data-speaking` in 203 samples, and the zone's speaking bit was seen in all 256.
  - **Party radio:** past 56 m B stayed subscribed in radio mode, audible and flat (|R−L| = 0 dB).
  - The microphone was not requested before the first push.
  - No page errors.

  This run predates merging main (flat ground on both sides). After the merge (WP05 terrain client, WP12) the walk-apart test now runs on real terrain with GPU flags and reports occlusion separately. The post-merge rerun could not finish: once the walk was too slow under SwiftShader, and once Docker Desktop's port forwarding to Postgres, Redis and LiveKit hung on this machine. I did not restart Docker Desktop, because other agents share it. After merge, the client tests (128), tsc, eslint and the zone and social builds and vets pass. Rerun `walkapart.mjs` once infra is healthy (gap below).
- Tests:
  - Go unit:
    - `zone/internal/voice`: hysteresis, cap with incumbency, 3D, caves, deltas, no flapping in a jittery crowd, grid = brute force, runner messages.
    - `zone/internal/game/earshot_test.go`: cadence, speaking bit including local profiles.
    - `social/voice`: grants; reconcile rules including party, blocks, mutes, roster, heal, handoff and expiry; LiveKit API smoke against the real SFU.
    - `voicebots`: verdict logic.
  - Process boundaries:
    - `server/zone/zone_earshot_integration_test.go`: zone binary → Redis (sets, 2 s fulls, a sprinting player leaves earshot after ~5 s).
    - `server/social/voice/voice_integration_test.go`: two social binaries, scratch Postgres, Redis and a fake LiveKit API (token grants, one leader, earshot → UpdateSubscriptions in under 1 ms, deltas, block both ways).
  - Vitest (12 tests): spatial maths, prefs, push-to-talk rules.
  - eslint, tsc, go vet and gofmt are clean; `voicebots` is vetted separately (`GOWORK=off`).

Known gaps:
- **The two-browser test has not been rerun since merging main into this branch** (WP05 terrain client, WP12), because Docker Desktop's port forwarding hung at the end of the session. On real terrain, expect some occluded samples (they are reported separately). Run `node client/src/voice/dev/walkapart.mjs` after recreating LiveKit with the new compose config.
- **Trust:** server-side subscriptions need `canSubscribe` in the token, so a modified client could subscribe itself to any track in its world's room. Fix: publishers set per-track subscription permissions from a server-sent allow list, or rooms are sharded by region (0011).
- LiveKit's `TrackUnsubscribed` arrives ~1 s after an unsubscribe (server 1.8 `flushTimeout`, not configurable). Audio stops at once: soak p99 70 ms, and the two-browser test is silent past 48 m + 0.5 s of walking.
- **The shared LiveKit container still runs the old port-range config.** I did not recreate it while other agents were using it. With that config a room fits ~25 participants: bots 26-49 never connected (`docs/evidence/wp11-voice-soak-compose-port-range.txt`). `infra/docker-compose.yml` now uses the UDP mux (7882); after merging, run `docker compose -f infra/docker-compose.yml up -d livekit`. The passing soak ran on a private container with the same config (udp 17882 / tcp 17881).
- livekit-client is pinned to 2.15.16: 2.20+ cannot publish to LiveKit server 1.8.4 ("negotiation timed out"). Upgrading the client needs a newer server image too.
- The roster is polled (ListParticipants every 500 ms, every 1.5 s while a room is empty). A speaker's first push can be heard up to ~0.5 s late, and a pair that joins already in earshot is subscribed p50 1.1 s after both are voice-ready. LiveKit webhooks would remove the poll (needs LiveKit config and a reachable URL).
- Occlusion samples the ground heightfield between the heads, which is exact for terrain. Caves need the wasm raycast, and the cave reverb send is not built (WP09). The cave earshot rule waits for WP09 to set `Player.Cave`.
- Earshot is per zone: players on two sides of a zone boundary don't hear each other until zones mirror the ghost band (spec 9).
- One LiveKit room per world, measured at 50 participants only; spec 10's region sharding is not needed at that scale. Re-measure in WP19's 1,000-player soak.
- Every social process campaigns for every world in `social:worlds`, including stale dev worlds (an idle leader polls an empty room every 1.5 s).
- Voice activation's gate uses the-circle's level threshold with no noise-floor calibration.

Assumptions:
- Party members are added by the social service, which owns parties, not by the zone's earshot computation.
- Per-player mute in the voice settings is local to this device; `/mute Name` is the server-side mute (chat and voice).
- A moderator mute makes voice listen-only, as it does chat ("can read, can't send").
- The speaking bit means transmitting with the local level above the speaking threshold, so holding V in silence shows nothing. The zone strips local profiles' bit.
- Fade/pan acceptance compares A's actual audio output levels (left/right RMS), not just the panner parameters. "Within 500 ms" is measured from the zone's earshot decision; the geometric latency, which adds the 250 ms interval, is reported too.
- Shared files touched:
  - `contracts/protocol.yaml`, plus regenerated `contracts/ts/src/gen/protocol.ts`, `server/pkg/proto/protocol_gen.go` and `contracts/golden/protocol_vectors.json`.
  - New `server/pkg/earshot`, plus a row in `server/pkg/README.md`.
  - `server/zone`: `main.go` (3 lines), `internal/game/server.go` (3 lines), `internal/game/entity.go` (2 lines), `README.md` (section).
  - `server/social`: `main.go`, `internal/social/hub.go`, `session.go`, `friends.go` (a few lines each), `README.md` (2 rows).
  - `client/src/net/NetPlay.tsx` (start/stop voice, speaking flag) and `client/src/net/avatar.ts` (3 lines).
  - `client/src/screens/PlayScreen.tsx` (mount `VoiceHud`).
  - `client/src/social/session.ts` and `index.ts` (`onSocialMessage`).
  - `client/src/devHandle.ts` (`voiceDebug`).
  - `client/src/hud/useDebugHotkeys.ts` and `DebugHud.tsx` (V is push-to-talk online).
  - `client/package.json` and `package-lock.json` (livekit-client 2.15.16).
  - `infra/docker-compose.yml` (LiveKit UDP mux) and `README.md` (port row).
  - `docs/cr/004-*`.
