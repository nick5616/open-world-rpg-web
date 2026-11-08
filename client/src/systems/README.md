# client/src/systems

Night, demons, weather and chemistry on the client (WP15). Decision:
docs/decisions/0015-night-chemistry.md; contract: docs/cr/011-wp15-night-chemistry.md.

- `clock.ts`: the world clock (TS twin of `server/pkg/weather/clock.go`):
  world time = synced server time + the world's offset (Event 500); day,
  night, moon phase, rain, the chemistry wind. `clock.test.ts` replays the
  Go vectors.
- `chem/sim.ts`, `material.ts`, `codec.ts`: the TS twin of
  `server/zone/internal/chem` (deterministic fire, ice, pillars).
  `chem.test.ts` replays the Go simulation vectors bit for bit.
- `chem/sync.ts`: one `ChemView` interface, two paths: `EventSync` (run the
  simulation from the zone's ops) and `BitmapSync` (show the zone's 2 Hz
  bitmaps; `?chem=bitmap`).
- `chem/ground.ts`: ice sheets and pillars on `WorldRuntime.ground`
  (pass-through when there are none, so movement goldens are unchanged).
- `night.ts`: `attachNight(session)` (NetPlay) turns Events 500-526 into the
  clock (it drives the sky through `worldClock.source`), the chemistry view
  and the HUD store; `nightWorld(runtime)` once the terrain is loaded;
  `window.__lodestoneNight` dev handle (ignite, freeze, pillar, setTime,
  raiseDemons, defense, sunsteel).
- `NightLayer.tsx`: fire cards, scorch, ice, pillars, rain, demon horns and
  eyes, rise and burn flashes. `NightHud.tsx`: clock chip, notices, the
  defense panel with the ward garden's health.

Offline (`dev:solo`) nothing here runs: the sky keeps its local clock.

Tests: `npm test -w client` (clock and chemistry vectors, two-client sync).
Acceptance: `npm run fire:accept -w client` (two event clients and a bitmap
client against the zone process, 60 s cell for cell:
docs/evidence/wp15-fire-sync.txt); screenshots:
`node client/src/systems/dev/night-shots.mjs`.
