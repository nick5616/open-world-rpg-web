# CR 039: Hotbar slots (playtest 2)

Branch `pt2/dodge-dungeons`. Nicole: "at the 10 level marks you should get an additional spell/weapon/hotbar slot".

## What a level gives (proposal: every number is one line in combat.yaml)

| Level | Spell slots per loadout | Weapon loadouts | Default key of the new slot |
|---|---|---|---|
| 1 | 4 | 2 | 1 2 3 4 |
| 10 | 5 | 2 | 8 |
| 20 | 6 | **3** (training bow in hand) | 9 |
| 30 | 7 | 3 | - |
| 40 | 8 (the most) | 3 | = |

- `combat.yaml leveling.hotbar: {baseSlots: 4, slotEveryLevels: 10, maxSlots: 8, loadoutLevels: [1, 1, 20]}` and a third `start.loadouts` entry (`bow`, no spells). Constants `MAX_SPELL_SLOTS = 8`, `MAX_LOADOUTS = 3` (`MAX_EQUIPPED_SPELLS` stays 4: the slots everyone has). The generator refuses a table that does not fit them.
- **Why weapons grow at 20 only**: a third loadout is a whole second build (weapon + gem + arrows + its own slots), worth one of the five marks; a fourth would make X a long cycle. The other marks give spell slots, which are the hotbar.
- Every spell slot opens in **every** loadout at once.

## Keys (proposal)

1-4 keep slots 1-4. 5, 6 and 7 are the steed's whistle and the pet (CR 027, CR 029) and every letter is taken, so slots 5-8 default to **8, 9, - and =**, the rest of the number row. **Every slot key can be changed** on the Esc menu's Controls page ("Spell slot keys": click a slot, press a key or a mouse side button; a key another slot holds swaps; a key the world uses for something else is refused and says what it does; "Defaults" resets). Stored in this browser (`localStorage lodestone.hotbarKeys`). The binding table (`input/bindings.ts`) declares the defaults for `combat/hotbar.ts`; the HUD, spell cards, skill tree and fanfare show the current keys.

## Server (authoritative)

- `combatdefs.SpellSlots(level)`, `LoadoutsOpen(level)`, `SlotLevel(i)`.
- `combat.Loadout.Spells` is `[MAX_SPELL_SLOTS]string`, `Profile.Loadouts` `[MAX_LOADOUTS]Loadout`. The Interact paths check the level: `Profile.EquipSpellAt` (slot and loadout open), `Profile.SwapAt` (the third loadout from 20); a cast from a slot the level has not opened is refused (`RefuseIllegal`), so a modified client cannot use slot 5 at level 9. Item equip (Interact 21/3) into loadout 3 is refused before 20 (`ItemRefuseNotAllow`). `items.EqMain2 = "eq:main2"`.
- **Wire**: castSlot 0-3 = slots 1-4 (unchanged), 4 = elemental form, 5 = technique (unchanged), **6-9 = slots 5-8** (`combat.CastSlotOf` / `SpellSlotOf`; client `hotbar.ts castSlotOf`). Old clients never send 6-9; the protocol version is unchanged (as CR 020's `channel`). **combat_sync version 2** (Event 212): loadout and slot counts in the header, every loadout and slot, and the open counts after the level (`contracts/events.md`). Interact 21/4 unequip index 5 = main2; dev console give's loadout field widened to 2 bits.
- **Persistence and migration**: `character_progress.skill_tree` v2 (three loadouts of eight, `hotbarSeen`). A v1 row (two of four) loads into the first slots and loadouts, the third loadout is the training bow, and it is written back as v2 on the next save; no SQL migration. **Existing characters above level 10**: `hotbarSeen` is 0 for a v1 row, so on the next join the zone sends Event 900 with the new **reason 3 "hotbar"** (previous level = the level last told) and the client shows a "NEW SLOTS" card listing each slot and the loadout; `hotbarSeen` is saved so it is said once. A level-up past a mark says it in the level-up fanfare instead ("New spell slot! Slot 5 (8)", "New weapon loadout! Loadout 3 (X cycles)"), and the zone records it as told.

## Client

- `combat/hotbar.ts`: the table, castSlot mapping, keys (rebindable, listeners), fanfare lines. `combat/HotbarKeys.tsx`: the Controls page editor.
- HUD: the open slots with their keys; past four, two rows of four (fits the 520 px centre column); "loadout n/3" under the weapon once three are open; X cycles the open loadouts.
- Spell cards (C) and the skill tree's sidebar (N): the open slots, the next locked slot as a card ("Opens at level 20"), the third loadout tab (locked before 20, "Loadout 3 · level 20"); "Put in slot" buttons for every open slot.
- Build overview (B): every open loadout and its open slots. Inventory (I): the third main hand and "Equip · Loadout 3" from 20. Character panel "Coming next" lists the marks. Dev console: loadout 3, slots 1-8, `/equip ... l3`.

## Tests

Go `internal/combat/hotbar_test.go` (table by level, castSlot mapping round trip and collisions, equip/swap refused before the level, a slot 5 cast refused at 9 and cast at 10, the v1 skill tree migration and the v2 round trip, combat_sync v2 layout), `internal/game/hotbar_test.go` (a level-15 character never told: Event 900 reason 3 once after join; slot 5 equips over Interact, slot 6 and loadout 3 refused; at level 20 the fanfare and no second notice, swap to loadout 3, equip its slot 6, `hotbarSeen` 20). Vitest `combat/hotbar.test.ts` (table, wire mapping, combat_sync v2 decode, default keys and the chat shortcut, rebinding swaps and refusals, fanfare lines, the reason 3 card, the third main hand's slot order).
