# client/src/ui/map

The map, compass and exploration HUD (WP12, spec 8 "Map and compass").
Everything authoritative comes from the zone as Events
(`contracts/events.md` 600-608); the client never invents progress.

| File | What |
| --- | --- |
| `events.ts` | Event kind / Interact constants, `decodeProgress`, `decodePins`, `packPinPos` (TS twin of `server/zone/internal/explore/progress.go`) |
| `store.ts` | zustand exploration store (progress, pins, party id, toasts, map open, actions) with a pure `reduceEvent` |
| `zoneLink.ts` | `attachExploration(session, ready)`: Events in, Interacts out, re-issued local save blobs into IndexedDB. Called by `net/NetPlay.tsx` before Hello so the progress Event after Welcome is never missed |
| `ExplorationHud.tsx` | Mounts the compass, toasts and map; M toggles the map, Esc closes it (ignored while typing in chat); `window.__lodestoneMap` debug handle |
| `MapScreen.tsx` | The map: paper for unrevealed regions, atlas terrain for revealed ones, sites (hidden / dimmed in revealed regions / known / unlocked), pins, party members (the zone's party ring), you. Click an unlocked tower/waypoint then "Fast travel here"; right-click = personal pin (10 max), Shift+right-click = party pin, click a pin = remove (party pins: only your own); wheel zoom, drag pan |
| `mapRender.ts` | One 1024 px software render of the atlas (biomes, hillshade, 40 m contours, water, rivers) graded toward paper; adapted from WP17's preview renderer |
| `Compass.tsx` | Top strip: heading ticks and cardinals, party members and pins with distance; out-of-window markers stick to the edge |
| `world.ts` | The atlas + towers the map draws (set by `world/structures/StructuresLayer.tsx`) |
| `dev/acceptance.mjs` | The G3 map-and-tower acceptance run (below) |

Offline (`dev:solo`, "continue offline") the map and compass work but
nothing is revealed and pins/fast travel are disabled: progress is the
server's.

## Party pins: relayed by the zone

Each member has one shared party pin. The zone keeps the party's pins in
memory, pushes the pins Event to members it hosts at once, and stores them
in Redis next to the party (`partypins:{worldId}:{partyId}`, 6 h TTL) so
members on another zone or reconnecting see them on the next 2 s poll.
Decision and alternatives: `docs/decisions/0012-exploration.md`.

## Test

```
npx vitest run --root client src/ui                 # payload vectors from Go, reducer, compass maths, map visibility
node client/src/ui/map/dev/acceptance.mjs           # infra up; ~4 min; evidence in docs/evidence/wp12-*
```

The acceptance run builds and starts account, director, zone and social on
private ports (18290-18293, Vite 5293) against a scratch database
(`lodestone_wp04_wp12e2e`, dropped afterwards) and drives two headless
Chromium processes on the real GPU (ANGLE/D3D11): party via `/invite` and the
party frame, waypoint touch, a ~500 m sprint to the nearest tower and the
climb, region reveal, discovery XP, a party pin through the map UI, compass
and map screenshots from both players, two fast travels through the map UI,
no second XP grant, and a reload that brings the progress back from Postgres.

## Quest markers (playtest 1)

The map and the compass also draw quests (`client/src/ui/quests`, CR 013):
every active quest's current markers on the map (tracked in gold, others
dimmer; areas as circles, points as "!" diamonds, labels stacked when they
would overlap), a cyan dashed preview of where an offer or a bounty notice
would take you (`setQuestPreview` then `setMapOpen(true)`: the map frames
the places and you; closing the map drops the preview), and the tracked
quest's markers on the compass (the nearest labelled with its distance).
The side panel lists the tracked quest or the preview with distances.
