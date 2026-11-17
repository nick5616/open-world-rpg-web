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
| `src/hud/` | `DebugHud` (FrameStats extended), `DebugPanel`, crosshair/lock hint, debug hotkeys. `layout.ts` (playtest 1): the bottom HUD's shared CSS variables: the combat stack measures itself into `--ls-hotbar-h`, the lock hint sits above it (`--ls-hint-h`), chat and voice keep to the corners beside the centre column (`--ls-chat-w`) and lift above the stack below 1080 px wide (`--ls-corner-bottom`); before/after at 1280x720, 1920x1080, 800x700 in `docs/evidence/pt-ux-hud-*.png`. `immersive.ts` + `ImmersiveHud.tsx` (playtest 4, CR 052): the **Immersive HUD** (default on; Esc menu > Interface switches it off): health/mana, hotbar and the quest card appear when they matter and fade, notices are fewer and shorter; pure visibility rules in `immersive.test.ts`; plus the low-health vignette and heartbeat. Hidden pieces fade by opacity (never unmounted), so the layout variables stay as measured. |
| `src/ui/quests/` | Playtest 1: quest tracker, offers with location previews, journal (J), quest markers on map/compass/world. See its README. |
| `src/stores/` | zustand: `appStore` (screens), `qualityStore` (tiers; WP19: `shaderTier` for shader-shaping knobs, which auto steps never change: a step used to recompile every shader and froze the page ~4.7 s, `docs/evidence/wp19-lurch-investigation.txt`), `debugStore` (dev tools). |
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
