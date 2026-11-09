# CR 010: Items contract, loot migration, item events (WP14)

## What

1. **New contract `contracts/items.yaml`** (version 1) with its generator
   `contracts/codegen/lib/items.mjs`, emitting
   `contracts/ts/src/gen/items.ts` (`ITEMS`, exported from
   `@lodestone/contracts`; the affix type is `ItemAffixDef` to avoid
   clashing with combat's `AffixDef`) and `server/pkg/itemdefs/items_gen.json`
   (embedded by the new Go package `server/pkg/itemdefs`). Rarities and odds
   (spec 8), materials, gems and cuts, ores, every base item, affixes,
   uniques, generated names, recipes, the starter kit and loot tables.
   **Item keys are a contract** (stored in `items.base_id`, sent on the
   wire): add, never rename.
2. **Migration `0014_loot.sql`** (additive): `items.qty`, `verified`,
   `display_name`, `world_id`, `world_pos`, `despawn_at`, `updated_at`; index
   `items_in_world`; tables `loot_grants` (exactly-once markers: containers
   opened, boss lockouts, starter, rolls, takes) and `item_epochs` (WP16
   ownership fence for item writes).
3. **Events 400-411 and Interact 20-22** (`contracts/events.md`), Interact
   41 extended to public pickups (dropped items, snapshot owner none),
   pickup entity convention (`name` item key, `level` qty, `typeId` rarity).
   Event 805's meaning extended (opens WP14's smithing panel) and 807 now
   costs gold.
4. **`localsave` state** (`server/pkg/localsave/state.go`, additive
   optional fields): `Item.qty/tradeable/verified/provenance/name`,
   `State.loot` (markers, quick consumable). Old blobs still parse.

No protocol.yaml or constants.yaml change (no protocol version bump).

## Why

Spec 8/11: rarities, personal loot, affixes, sockets, gem cuts, forging,
consumables, `tradeable`/`provenance`, `TransferItem`, exactly-once grants.
One item table shared by zone and client is the same pattern as
combat.yaml (CR 009). WP15 needs a stable sunsteel key:
`weapon:sunsteel_blade` and `ammo:sunsteel_arrow`; materials carry
`killsDemons` (sunsteel) and `demonStagger` (silver); the zone exposes
`combat.Player.Gear.KillsDemons` / `.Stagger` for the equipped weapon and
`itemdefs.D.KillsDemons(key)`.

Currency is not in the spec, but WP20's merchants and bounties carry prices;
`currency:gold` (purse, no slot) makes them real.

## Consumers affected

- **WP09 mining**: vein pickups now carry their item and are granted through
  the item system when no external `Config.Granter` is set (Event 704 still
  sent). Item ids unchanged (`ore:<name>`, `gem:<name>:<cut>`).
- **WP20 towns**: shop ids are now real item keys (unchanged strings; the
  blacksmith also sells blueprints); purchases cost gold when no external
  Granter is set; `Config.Stations` default is WP14's (805 still sent).
  `npc.SmithWares()` added.
- **WP13 combat**: `Player.Gear`, `Player.OnDrink`, `SetGear` (additive);
  damage, crit, armor and max health read Gear; inventory-backed drinks
  don't refill on respawn.
- **WP04 accounts**: the local → account upgrade copies qty, trading flags,
  provenance and names into `items`.
- **WP15**: reads `KillsDemons` (see above).
- **WP16**: the inventory rides the handoff state (`HandoffField "items"`);
  item ops are fenced by the ownership epoch; `Server.ItemsPending(char)`
  tells a handoff whether the character's item ops are flushed.
- **Client**: `client/src/ui/inventory/` (new); `PlayScreen`, `NetPlay`,
  `caveManager` (only ore/gem pickups), `townHud` (805 → WP14 panel).

After merge: run `npm run migrate` (migration 0014).
