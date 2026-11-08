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
