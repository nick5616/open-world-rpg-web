# CR 025: Camps (campfire, bedroll, storage chest, workbench, signpost)

Branch `pt2/camps`. Nicole: "all sorts of good shit" overnight; inspirations Valheim and Breath of the Wild. A Valheim-flavoured camp system without full base building.

## Summary

- **Five placeable pieces**, crafted as **kits** anywhere (the camp menu, **P**) from firewood and existing loot: **Campfire** (light and warmth; a cooking station; burns on firewood for in-game hours; while it burns demons never rise within 14 m, never step into that circle and leave the players inside alone), **Bedroll** (rest for the **Rested** buff: x2 health regen, x1.5 mana regen, +25 stamina wheel points for 10 min, 17 min by a burning fire; it is your **respawn point**), **Storage chest** (16 slots, locked to you or shared with your party, persisted), **Workbench** (a crafting station for torches, rope, a whetstone and arrows away from town), **Signpost** (a named marker on your and your party's map and compass).
- **Placement mode**: a ghost ahead of you snapped to the terrain, green or red with its footprint (and the campfire's safe circle); mouse wheel or R turns it 45 degrees, left mouse places it, right mouse or Esc cancels; hold E on your own piece to pick it up (its kit comes back). Rules: not in a settlement's footprint (+14 m), not on slopes over 28 degrees or 0.9 m of relief, not in water or underground, not overlapping a building, structure or another piece, 8 m from someone else's camp, one camp per character (every piece within 18 m of the first), at most 6 pieces (2 campfires, 1 bedroll, 2 chests, 1 workbench, 2 signposts).
- **Server-authoritative**: the zone checks every rule (`server/pkg/camps.Check`; the client mirrors it for the ghost), owns and persists the pieces, removes a camp whose owner has not been within 48 m of it for **14 real days** (decay; a chest's items go with it).
- **Firewood** (`wood:firewood`): fallen branches (a `deadfall` forage patch in meadow, forest, highlands, wetland and badlands, E to gather 2-3; drawn as branches) and the general store (2 gold).

## Contract changes

- **New `contracts/camps.yaml`** → `npm run gen` → `contracts/ts/src/gen/camps.ts` (`CAMPS`) and `server/pkg/campdefs/camps_gen.json` (+ `campdefs.go`). Generator `contracts/codegen/lib/camps.mjs` (checks kits and the fire's wood against items.yaml; rotation steps fixed at 8). Piece ids are the order in the file (append only).
- **items.yaml** (additive, no version bump): categories `wood` (stack 50, kind material) and `camp` (stack 5, kind tool); items `wood:firewood`, `camp:campfire|bedroll|chest|workbench|signpost`; recipe stations **`camp`** (kits: no station needed) and **`workbench`** (a camp piece): `kit_*` and `bench_torch|rope|whetstone|copper_arrows|iron_arrows`, appended (existing recipe ids unchanged). `items.mjs` accepts the new categories and stations.
- **content.yaml**: forage herb `deadfall` (item `wood:firewood`). Adding a forage entry re-weights which herb grows in a patch of those biomes (patch ids and places unchanged; a few existing patches now grow branches). Deadfall does not count toward Green Thumb.
- **Events 1100-1107** (new range 1100-1119, `contracts/events.md`): 1100 `camp_area` (binary: an area's pieces), 1101 `camp_piece`, 1102 `camp_removed`, 1103 `camp_refused`, 1104 `camp_chest`, 1105 `camp_rested`, 1106 `camp_mine`, 1107 `camp_note`. **Interact 90 `camp`**: 1 place, 2 pick up, 3 use, 4 fuel, 5 chest put, 6 chest take, 7 signpost name chunk, 8 chest lock, 9 dev kits, 10 sync. Event 404 `targetId` 4 = a camp workbench; a camp campfire opens cooking as 3. Interact 22/1 crafts `camp` recipes without a station.
- **Migration 0026** `camp_pieces` (one row per piece: owner, kind, cm position, rotation, label, lock, party hash, `burn_until` on the world clock, `owner_seen_at` for decay) and **`items.camp_piece_id`** (a stored item is an `items` row like a dropped one that names its chest; never despawns, never restored as a pickup). Run `npm run migrate`.
- **No `protocol.yaml` or `constants.yaml` change.** The Rested stamina bonus rides `SelfState.staminaMax` like level and tower boons; combat's `Player.RegenMult/ManaRegenMult` (zone only).

## Collision: solid pieces in the TS/Go twin

Chests, workbenches and signposts are **solid** (players and enemies collide with them); campfires and bedrolls are low and stay walk-through. Each solid piece is one box in the towns layout (`x, z, cos, sin, hx, hz, bottom, top, top`) pushed out of **after the town collision and the closed doors**, with exactly the per-box arithmetic of `towns.Doors.After` (two passes, ascending piece id): `server/pkg/camps` (Go) and `client/src/ui/camps/collide.ts` (TS). Every input is exact on both sides: positions are the wire's centimetres / 100, rotations are 45 degree steps whose cos/sin come from one table (`Math.SQRT1_2`), the box only adds generated numbers. **Golden vectors**: `server/pkg/camps/testdata/camps.json` (written by `go test ./server/pkg/camps -run TestCollisionVectors -update`: 21 pieces in every rotation, a tight cluster, non-solid pieces, 840 bodies, 153 of them pushed (on top, under, beside or deep inside a box)) replayed bit for bit by `client/src/ui/camps/camps.test.ts`. The towns golden tables are untouched (camps are a separate overlay; `test:golden` unchanged).

The zone wraps a player's frame ground with the pieces only within 24 m of a solid piece (`campWrap` after `frameGround`'s doors); the client's `CampGround` sits on the door ground inside the chemistry overlay and is a pass-through with no pieces, so every movement golden is unchanged. A new piece is refused within reach of any body, so the round trip before a client learns of it costs no correction in practice (no per-player stamps like the doors': a piece that appears on someone's path within that ~100 ms is pushed out by the zone and corrected once).

## Network budget

Event driven, nothing per tick. Pieces are sent once per session per 256 m area as you come within one area of it (about 40 bytes a piece), then each change to the sessions that have the area. Camps are off in worlds without an atlas or towns (the flat and scale worlds), so `LODESTONE_WIRE_DIGEST=1` is **unchanged**: p90_e600 `831bb7f4...`, p300_e2000 `8c29d408...`.

## Persistence and exactly-once

- Pieces go through the write-behind queue keyed per piece (a newer state replaces a queued one; a delete replaces a queued upsert). Placing writes the row only after the kit's removal committed (the item op's `Done`); picking up deletes the row in the item op's `Before`, ahead of the kit's grant. A crash can lose a kit, never duplicate one.
- Chest moves are item-journal transactions built like TransferItem's drop and take: a take checks the row still lies in the chest and carries a take marker. Memory-only characters (dev tickets) keep chest items in memory; a persisted item they take is deleted first and joins them after the commit. **Local profiles cannot store items** (their items live in the browser's signed save; refused with reason 23); they can take what their party left them.

## WP16

The zone owning a point is the authority for pieces placed there: it places, changes, removes and persists them and tells every other zone (`ctlCampSet`); everywhere else players see them, collide with them and the fire keeps demons away. Placing, using or picking up from another zone's ground (a border) is refused (reason 20) rather than raced. Rested rides the handoff (`camp` field).

## Integration

- WP15 night (`night.go`): `spawnSpot` refuses within the fire's circle + 6 m, `demonBlocked` keeps hunting demons out of it, `demonSheltered` leaves players inside alone, `huntTopUp` raises no hunters for a player by a burning fire.
- CR 024 respawn: `RespawnPoint` is your bedroll (beside it) before your last waypoint; the downed screen says "Back on your feet at your bedroll" and "Your bedroll is your respawn point" (`client/src/combat/downed.ts`).
- Cooking: a camp campfire is a cook station (the existing panel) with a fuel strip; the workbench opens the same panel with its recipes.
- Audio: burning campfires are positional `campfire` loops (`audio/bridge.ts loopSources`); visuals use the night layer's flame cards (exported) plus a warm point light (the nearest three) and glowing embers.
- Map and compass: your and your party's signposts (a little tent) and your bedroll.
- Esc menu controls page: a Camping group. What's new: `pt2-camps`.

## Known gaps

- No repairs at the workbench: items have no durability yet (it makes tools and arrows).
- The Rested buff is not saved across a logout (it rides a WP16 handoff); resting does not skip the night (a shared world).
- A decayed chest's items are deleted, not dropped.
- Only the owner picks a piece up; party members can rest in a party bedroll and use a shared chest but not move pieces.
- Names, numbers and texts are proposals for Nicole (`contracts/camps.yaml`).
