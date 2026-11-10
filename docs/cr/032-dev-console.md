# CR 032: Dev console (playtest 2)

Branch `pt2/dev-console`. Nicole: "build a dev mode dev console locally where i can equip every item in the game, see every item, equip every spell, etc".

## Summary

- **Local only, two locks.** The zone takes dev commands only when started with `LODESTONE_ZONE_DEV=1` **and** the insecure development ticket key (no `LODESTONE_TICKET_PUBLIC_KEY`): `server/zone/devconsole.go`. `scripts/dev.mjs` sets the variable for the zone in `npm run dev` (override with `LODESTONE_ZONE_DEV=0`); no deploy does, and `server/zone/devconsole_test.go` reads every file under `infra/` and fails if one mentions it. A zone without dev mode answers every command with Event 1401 value 1 and changes nothing; it ignores the status question silently, so the console never appears. The zone logs `DEV CONSOLE ON` at start and every command (`dev command`, character, action, arguments, result).
- **The client** shows the console only when the zone said so (Event 1400) **and** it is a debug build (`DEBUG`: `npm run dev`, solo, `?debug=1`). **F2** opens and closes it (Esc closes); it is a `data-ui-panel` and frees the mouse. The ` debug panel has a "Dev console (F2)" button on a dev zone; the Esc menu's Controls page lists F2 in a **Dev** group only then.
- **Items tab**: all 300 items (165 base items from items.yaml with the gem, ore, ingot and blueprint families expanded, plus a tome for each of the 135 spells), search, 16 categories (weapons, armor, arrows, tools and the spirit whistle, potions, food, herbs, fish, ores and ingots, gems, instruments, camp kits and firewood, blueprints, tomes, quest items and keys, other), icon, name, kind, base line, key and how many you hold. **Give** (quantity) and **Equip** (weapons into the chosen loadout's main hand, armor into its slot) or **Use** (tomes learn, arrows load, draughts go on the drink key). Gear is rolled at a chosen **rarity** (common .. Bitchin'), **item level**, **affix** (or random ones, as many as the rarity has) and **gem** (any of the 10 at any cut, set in the first socket; every socket the base can have), with uniques and generated names as that tier gives them.
- **Spells tab**: every spell as its spell card, school filter, search, **Learn**, **Unlearn**, **Learn all**, **Unlearn all** (the starting kit stays), **equip to any slot 1-4 of either loadout** (learning it first if needed; the slot is the existing Interact 50/3), **Unlock every tier** (the skill tree, N, then learns any node: no points, prerequisites or tier levels).
- **Character tab**: set level, total XP, gold, extra skill points (this session), any weapon/craft skill level (or all); refill health, mana and stamina; **god mode** (nothing hurts you: `combat.Player.DevGod` zeroes every hit in `mitigate`), **infinite mana**, **infinite stamina**, **no cooldowns**, **fly** with a **speed** multiplier, free skill tree, freeze time; **reset character** (level 1, starting kit, no spells, map, loadouts or quests; pets, steed, achievements and camps stay).
- **World tab**: teleport to coordinates, a **click on the minimap**, any **tower, town or vault** (Event 1402 lists them from the zone); reveal the map (every tower and waypoint: fast travel everywhere); attune every tower crystal (boons, XP); time of day and **freeze time**; force any **weather** state (or back to seeded); **spawn** any enemy (count, level, elite affix) or **boss** ahead of you and despawn them all; start any **world event**; a weakened **tameable** creature of any species; a **pet** of any species (plain, shiny or elemental of any element, any level); a **steed** of any colour with its whistle; **quests**: finish a step, complete (rewards paid), abandon, for each active quest or all; **achievements**: unlock one or all (rewards paid).
- **Command line** at the bottom, mirroring the buttons, with history (arrows) and completion (Tab): `/give <item> [qty] [rarity] [lvl=N] [gem=ruby[:brilliant]] [affix=brutal]`, `/equip <item> [rarity] [l1|l2] ...`, `/learn <spell|all>`, `/unlearn <spell|all>`, `/level <n>`, `/xp <n>`, `/gold <n>`, `/sp <n>`, `/skill <name|all> <lvl>`, `/heal`, `/god`, `/mana`, `/stamina`, `/nocd`, `/fly`, `/speed <x>`, `/freelearn`, `/freeze` (toggles take `on|off`), `/tp <x> <z>|<place>`, `/time <h|hh:mm>`, `/weather <state|seeded>`, `/spawn <enemy|boss> [n] [lvl] [elite]`, `/despawn`, `/event <kind>`, `/tame <species>`, `/pet <species> [shiny|elemental[:fire]] [lvl]`, `/steed [colour]`, `/quest <id|title|all> [step|done|abandon]`, `/reveal`, `/attune`, `/achieve <name|all>`, `/reset yes`, `/help`, `/clear`. Names resolve by key, name, id or an unambiguous prefix ("voidglass_sword", "Healing Draught"). Every answer lands in the log above it. `window.__lodestoneDev.run('/give ...')` runs one from a script.

## Server

`server/zone/internal/game/devconsole.go` (new). Every command goes through the code the game itself uses, so state stays consistent and persists like play (dev grants persist in the dev DB):

- items: `items.DevRoll` (new, `internal/items/dev.go`: an exact rarity and level, a forced affix, the gem socketed) or `items.Stack`, `Inventory.Add` / `Equip` / `useItem`, `commitItems` (the item journal / local save), Event 401 with source 11 (`dev console`); gold by `Add` / `Spend`;
- spells: `Profile.Grant`, new `Profile.DevForget/DevForgetAll`, `learnedSpellIntoSlot`, `sendCombatSync`, `saveCombat`; the free skill tree makes Interact 50/4 call `Grant`;
- level and XP: `Progress.DevSetXP` then the ordinary `levelChanged` (604, 900, refill, feats) going up, `applyProgression` + 900 going down; skill points ride `applyProgression`'s boons; weapon skills `Profile.DevSetSkillXP` (combat.yaml's XP curve);
- map: `explore.World.DevReveal/DevAttuneAll` (new), attunement XP and boons as `attune` pays them, `contentAttuned`;
- teleport: `Server.Teleport` (the fast travel path); time: `SetClockOffset`; frozen time pulls the clock back every 20 s of drift; weather: `WeatherSetup.Override` (the field rebuilt, Event 500 to everyone) or WP10's rain switch on atlas-less worlds;
- spawns: `combat.World.TestGroup` / `TestBoss` (dev placement's), tracked and removed with `RemoveGroup`; world events `devStartEvent`; tameables like the pets dev tool; pets `PetState.Add` + `petEnsureOut` + `petChanged`; steed `steedChanged`; quests `Log.DevAdvance` (new) + `questHappened` (step grants, gold, XP, the quest events) and the ordinary abandon; achievements `State.DevEarn` (new) + `achReward` and Event 1002 (one) or 1241 (many);
- god mode, infinite mana, no cooldowns: `devTick` every tick (mana full, `Player.DevClearCooldowns`); infinite stamina and fly: `devFrame` before each input frame (the wheel refilled; fly is the client's `stepFly`, ported as `DevFlyStep`, no speed check while flying, clamped to the world; landing below the ground puts you on it).
- Interact 250 is not rate-limited on a dev zone (the generic 10 burst / 5 per s would trip on "give" clicks).

## Client

`client/src/ui/devconsole/` (new): `events.ts` (wire, FNV-1a 32 of item keys = the zone's `DevHash`), `catalog.ts` (everything from the generated tables), `commands.ts` (parser, completion), `store.ts`, `link.ts`, `DevConsole.tsx`. Prediction: fly and infinite stamina ride the step's env (`StepEnv.dev`, `sim/devStep.ts`), so the local step and reconciliation replays do exactly what the zone does; the combat timeline's `devCombat` refills mana and clears cooldowns each step like the zone.

## Contract changes

- **Interact 250 `dev`** (contracts/events.md): actions 1-27 (status, give, learn, unlearn, level, xp, gold, skill points, weapon skill, refill, flags, speed, reset, teleport, time, weather, spawn, despawn, event, tameable, pet, steed, quest, reveal, attune, places, achieve).
- **Events 1400-1419** (1403-1419 reserved): 1400 `dev_status`, 1401 `dev_result`, 1402 `dev_places`.
- No protocol, constants, YAML or migration change. `LODESTONE_ZONE_DEV` (zone, local only).

## Known gaps

- Walking/sprinting speed is the shared movement step's (Go = TS goldens, validated by the zone): the speed multiplier is fly speed only.
- Extra skill points last the session (they are not a stored boon); a reset leaves pets, the steed, achievements, camps, renown and the codex.
- Despawn removes what the console spawned on this zone; time and weather are zone-wide (everyone on a dev zone sees them).
- The fly step is not a golden: Go and JS `sin`/`cos` may differ in the last bit, well inside prediction's 2 cm tolerance.
