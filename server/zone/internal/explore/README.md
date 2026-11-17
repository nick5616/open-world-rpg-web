# server/zone/internal/explore

The zone's exploration rules (WP12, spec 8 "Exploration structure", spec 11
`character_progress`). Pure and tick-safe: no I/O, clocks or goroutines.
The glue to sessions, Events, persistence and parties is in
`internal/game/{explore,party,persist_progress}.go`.

| Rule | Detail |
| --- | --- |
| Tower top | Ground under the player is the tower's top platform (overlay `StructureAt`), within the top radius + 0.6 m and no more than 0.6 m below its surface. Unlocks the tower (bitset by site index), reveals the tower's region (derived: a region is revealed by any unlocked tower in it), +150 XP once. |
| Waypoint touch | Within 3 m horizontally and 3 m vertically of the stone: activates it once (fast travel) and makes it the respawn point (`LastWaypoint`) whenever it changes. |
| Discovery | Entering a site's discovery radius once per character: settlements (their footprint radius; 60/80/100 XP by size), structures (max(r, 15) + 10 m; 50 + 25 x tier), towers (40 m; 40 XP), cave mouths (20 m; 50), landmarks (25 m; 30). Enemy camps and waypoints are not discoveries. |
| Level | Wizard-wars curve 60 + 40 x level XP per level, plus an early surcharge (level 1 to 2 is 360 XP; CR 048). |
| Fast travel | To an unlocked tower (arrive on the top's centre) or activated waypoint (2.5 m in front of the stone along its yaw); refused with a reason (unknown, locked, 2 s cooldown). |
| Respawn | `RespawnPoint` = beside the last waypoint touched (WP13's death hook calls `Server.Teleport(e, Server.RespawnPoint(e))`). |
| Pins | 10 personal pins (slots 0-9, x/z in cm, colour), JSON in `character_progress.pins`. |

Checks run at 10 Hz per player from the tick on the authoritative position,
using a 128 m grid of site reach, so a tick costs a map lookup and a few
distance tests per player.

Wire formats (Event kinds 600-608, Interact kinds 10/11) are in
`contracts/events.md`; `testdata/events_vectors.json` pins the two binary
payloads (`go test -run EventPayloads -update` rewrites it; the client's
`client/src/ui/map/map.test.ts` replays it).

## Test

```
cd server/zone && go test ./internal/explore           # rules, levels, pins, payload vectors
cd server/zone && go test ./internal/game -run 'Tower|Waypoint|Party|Progress|LocalProfile'   # in-process sessions
cd server/zone && go test -run TowerClimb .           # zone binary: climb agrees to the cm, fast travel
```
