# server/zone/internal/npc

The townsfolk (WP20, spec 5 and 8): schedules, walking, dialogue, wares and
the bounty board. Pure game logic over the generated people of the towns
buffer (`server/pkg/towns`): the generator fixes who lives where (stable
ids, homes, work spots, names); this package decides where they are at
what time and what they say, and may change freely with normal deploys.

| File | What |
| --- | --- |
| `npc.go` | `World` (NPC states + one street graph per settlement), `TimeOfDay`, `Hour`, schedules (`Works`, `Want`, `Open`), `Place` (where an NPC is when its town wakes up), `Step` (walk along the route), `Route` (out of the door, along streets/ring/square, in through the target's door) |
| `talk.go` | `Say` (lines by role and time, closed at night), `Wares` + `EncodeShop` (Event 801), `Bounties` (3-4 seeded jobs per settlement per in-game day: clear / slay / scout a nearby structure or camp, deliver items) + `EncodeBounties` (Event 802) |

Schedules: work 07:00-19:00 (farmers 06-18); innkeepers and guards keep
their posts round the clock (the inn is open at night). Villagers wander
within 5 m of their work spot by day. The zone glue
(`internal/game/towns.go`) spawns a settlement's NPCs as snapshot entities
while a player is within 200 m of its edge and steps them on the movement
ground (floors, ramps). Doors: `World.Doors` (`DoorGate`) is asked every
step an NPC walks a door segment of its route; the zone glue
(`internal/game/doors.go`) opens a closed door (the NPC waits for it) and
closes it behind them; nil = every door open.

## Test

```
npm run build:wasm
cd server/zone && go test ./internal/npc
```

On the official world: every off-duty NPC with a home is indoors at 01:00
(217/217), every walker gets home at dusk (174/174) and 0 of 15,206 walk
samples are inside another building; bounties are deterministic and their
payload decodes.
