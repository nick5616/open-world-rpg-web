# client/src/ui/inventory

The client half of WP14 (spec 8 "Loot, rarities and dropping items", spec 7
smelting/forging): the inventory screen, the crafting panel, loot toasts, the
Bitchin' banner, the `[E]` prompt for containers / dropped items / cooking
stations, and pickups and containers in 3D. Everything authoritative comes
from the zone as Events (`contracts/events.md` 400-411, WP20's 805); the
client never invents items or edits them optimistically: every action is an
Interact and the next Event 400 (a full replace) redraws the screen.
Item names, rarity colours, affixes, uniques and recipes come from the
generated table (`contracts/items.yaml` -> `ITEMS` in `@lodestone/contracts`).

| File | What |
| --- | --- |
| `events.ts` | Event kinds / Interact codes and pure decoders: 400 inventory JSON, 401 grants, 402 Bitchin' news, 403 refusal target, 404/805 station ids, 405 crafted item, 406 containers (binary, with `encodeContainers` for tests and mocks) |
| `items.ts` | Item helpers: names (generated names, `tome:<spell>` -> "Tome: <spell name>" from `COMBAT`), rarity name/colour (`holographic` -> animated CSS), stat/affix/unique lines ("+12.3% damage"), slots, socket target packing, recipe have/need checks, refusal texts |
| `store.ts` | zustand store: inventory, containers, open station, last crafted, toasts, banner, panel flags, actions; pure `reduceItemEvent` |
| `link.ts` | `attachInventory(session)` (called by `net/NetPlay.tsx` before Hello so the first 400 is never missed) and `ensureInventoryHook()` (re-hooks `netRuntime.session` if it changed and nobody attached it); the Interact senders |
| `InventoryScreen.tsx` | The inventory (I): equipment column, 8x5 bag, gem and ore pouches, purse, the item card and actions; `window.__lodestoneInventory` is installed here |
| `CraftPanel.tsx` | Smithing (forge/anvil: smelting and forging) or cooking (hearth/campfire: cooking and brewing) recipes with have/need, blueprint, Craft, last crafted |
| `LootHud.tsx` | Toasts, the Bitchin' banner, the `[E]` prompt and its key |
| `LootLayer.tsx` | R3F: non-ore/gem pickups (bobbing, rarity colour, light beam for rare+, colour-cycling beam for Bitchin') and Event 406 containers (chest, buried cache, urn, crate; opened ones dimmed, chest lid open). Mounted next to `<CombatLayer />` in NetPlay |
| `ItemIcon.tsx`, `styles.ts` | Inline-SVG icons per item kind; the shared CSS (holographic gradient, banner, tiles) |
| `dev.ts` | The debug handle and the sample inventory |
| `dev/shots.mjs` | Headless screenshots (below) |

## Wire use

- In: 400 (inventory), 401 (loot toasts, rarity coloured), 402 (banner),
  403 (refusal toast), 404 (cook station open) and 805 (forge/anvil open,
  WP20: townHud leaves 805 to this panel), 405 (last crafted + toast), 406
  (containers), 407 (container opened), 408 (dropped), 409 (boss lockout),
  410 (gems combined), 411 (dropped item taken).
- Out: Interact 20/1 open container; 21 item (1 use, 2 drop with qty 0 = all
  or 1, 3 equip with loadout 0/1, 4 unequip with slot index main0, main1,
  head, body, legs, 5 move, 6 socket with targetId `weapon | gem << 32` and
  the socket index, 7 unsocket, 8 combine, 9 set as the drink key's
  consumable); 22/1 craft (recipe id), 22/2 open a hearth/campfire (prop
  stable id from the towns buffer, kinds 4 and 22); 41/1 take a dropped item.

## Keys and mouse

- **I** toggles the inventory, **Esc** closes it (and the crafting panel).
  Opening releases the pointer lock; click the world to take it back.
  Keys are ignored while typing in a text field.
- **G** or **Delete** drops the selected item (whole stack) while the
  inventory is open; G is swallowed then so it doesn't also open the glider.
- Drag an item **out of the panel** to drop it; onto an equipment slot to
  equip it; onto another cell of its pouch to move it; a gem onto a weapon to
  socket it (first empty socket). Or select a weapon, "Socket a gem", click
  a gem. Buttons on the selected item: Equip (loadout 1/2 for weapons),
  Unequip, Use / Learn / Use arrows, Set as drink, Socket, Unsocket (kept
  at a town forge/anvil, destroyed elsewhere), Combine 3, Drop all, Drop 1.
- **E** opens a container, takes a dropped item or opens a cooking station.

### E arbitration

E is shared with WP20's townHud (talk, boards, forges, shafts) and WP09's
caveManager (mining). LootHud claims E only when a target (unopened
container, pickup, hearth/campfire) is within **2.5 m** (closer than the 4 m
the others reach for) **and** neither other system shows a prompt (the DOM
prompts `[data-testid=town-prompt]` and `[data-testid=cave-hud]` are empty),
no town panel is open, and neither the inventory nor the crafting panel is
open. Its key listener runs in the capture phase so it sees the state before
the others react. Its own prompt hides whenever another prompt is up, so the
screen never offers two E actions at once.

## Offline (solo)

Everything renders harmlessly: the inventory says "offline" and is empty,
actions answer with an "(offline)" toast, WP20's offline forge opens the
crafting panel with crafting disabled, a hearth opens the cooking panel the
same way. `LootLayer` is only mounted online (NetPlay).

## Dev handle

`window.__lodestoneInventory` (debug builds: dev, solo, `?debug=1`):
`state()`, `open()`, `close()`, `openCraft(kind)` ('forge' | 'anvil' |
'cook'), `closeCraft()`, `select(handle | key | generated name)`, `mock()`
(sample inventory: a rare Sunsteel Blade with a socketed topaz in loadout 1,
armor, an orange legendary, a red mythic "Riftreaver" (unverified), a
Bitchin' "Starsong", gems, ores, ingots, blueprints, potions, a tome, 1287
gold; and four containers around the player), `event(kind, data, value,
targetId)` (feed any fake Event), `showBitchin(text, name)`.

## Test

```
npx vitest run --root client src/ui/inventory      # decoders, helpers, reducer, mock validity
node client/src/ui/inventory/dev/shots.mjs         # solo client on a free port; docs/evidence/wp14-*.png
```

`shots.mjs` starts Vite (`VITE_SOLO=1`) on 127.0.0.1 and a random free port
(or uses `LODESTONE_CLIENT_URL`), loads the official seed, calls `mock()` and
writes `wp14-inventory.png`, `wp14-inventory-tooltip.png` (the mythic's
card), `wp14-forge-panel.png` and `wp14-bitchin.png`.
