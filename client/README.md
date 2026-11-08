# client

Vite + React + React Three Fiber app: title screen, first-person walking on a
placeholder world, debug HUD and dev tools (WP02). Terrain streaming (WP05),
networking (WP06) and sign-in (WP04, `src/account/`) plug into the slots
described below.

## Run

```
npm run dev:solo            # from the repo root: client only, no servers (VITE_SOLO=1), http://localhost:5173
npm run dev                 # full stack; the client goes title -> account slot -> play
```

Controls: click the canvas to capture the mouse, WASD move, Shift sprint, Space
jump (press again in the air to double jump, a third time while falling to
open the glider), G open/close the glider, hold W into a steep slope to climb
(Space on a wall = lunge, Space + S = kick off). The stamina wheel shows beside
the crosshair while it is not full (WP10). Debug builds (dev, solo, or
`?debug=1`): F3 HUD, backquote debug panel (teleport, fly, freeze time, time of
day, borders, quality), V fly (Space up, Ctrl/C down), F4 cell/chunk/region
borders. `?autoplay=1` skips the title screen. WP10 dev params:
`?rain=1|0`, `?updraft=x,z,r,top,lift`.
Traversal acceptance: `npm run traversal:accept -w client` (Node client vs
the zone binary) and `npm run traversal:browser -w client` (headless
Chromium); see `src/sim/README.md`.

## Test

```
npm run test -w client        # vitest: movement math, goldens, fixed step, input latch, stores, HUD stats
npm run typecheck -w client
npx eslint client
npm run compare:ww -w client  # wizard-wars side-by-side -> docs/evidence/wp02-movement-side-by-side.*
npm run shots -w client       # headless Playwright capture (start dev:solo first) -> docs/evidence/wp02-*.png
npm run golden -w client      # regenerate src/sim/golden/*.json after an intended movement change
```

## Layout

| Path | What |
| --- | --- |
| `src/sim/` | Pure movement contract shared with the Go zone server. See `src/sim/README.md`. |
| `src/scene/` | R3F: `GameCanvas` (Canvas, quality, monitor), `PlayerController` (look + fixed-step loop + camera), `FirstPersonArms`, `SkyAndSun`, `FlatTerrain`, `CellBorders`, `groundContext`. |
| `src/input/` | Ref-based keyboard and pointer-lock mouse hooks. |
| `src/hud/` | `DebugHud` (FrameStats extended), `DebugPanel`, crosshair/lock hint, debug hotkeys. |
| `src/stores/` | zustand: `appStore` (screens), `qualityStore` (tiers), `debugStore` (dev tools). |
| `src/state/live.ts` | Per-frame values written imperatively (player pose, net/chunk HUD slots, world clock). |
| `src/screens/` | `TitleScreen`, `AccountSlot` (WP04 mount point), `PlayScreen` (lazy, pulls in three.js). |
| `src/devHandle.ts` | `window.__lodestone` for headless scripts and the console (debug builds only). |
| `src/account/` | Owned by WP04. |
| `src/world/` | Owned by WP05. |

## Extension points

- **Ground (WP05):** implement `GroundQuery` (`src/sim/ground.ts`:
  `heightAt(x, z)`, optional `normalAt`) and render
  `<GameCanvas ground={chunkGround} terrain={<ChunkTerrain/>} />`. The
  controller, cell borders and spawn read the ground only through that
  interface.
- **Networking (WP06):** `<GameCanvas onStep={...}>` receives every simulated
  step (`seq`, the quantized `InputFrame` fields, the resulting state); send
  those and keep them for reconciliation. Fill `netStats` in `src/state/live.ts`
  (transport, rttMs, downKbps, upKbps) and the HUD shows them. Fly mode is
  client-only and must be refused online.
- **Chunks (WP05):** fill `netStats.chunkQueue` / `chunksLoaded`.
- **Sign-in (WP04):** render the account screen from `src/screens/AccountSlot.tsx`
  and call `onDone` when a character is chosen.
