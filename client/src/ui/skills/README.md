# Skill tree and build overview (playtest 2)

Playtest feedback: "Skill tree you can open" and "Somewhere to see where all
your spec'd items have accumulated". One screen, three kinds of tab:

- **Spell trees** (Fire, Ice, Lightning, Earth, Wind, Light, Dark, Void):
  a graph by tier (columns, each headed with the character level a skill
  point needs) with prerequisite edges (any one prerequisite unlocks a
  node). Node states: learned, learnable now (gold, pulsing), no free point
  (dashed), needs level N, needs a prerequisite. Hover: the spell's numbers
  (damage, hits, cooldown, mana, wind-up, range/radius, status, lifesteal,
  shields, kills demons) and "your hit" with the active loadout's build.
  Click: its card in the sidebar with **Learn** (1 skill point; or
  double-click the node) or **Put in slot 1-4**. Drag a learned castable
  spell onto a slot (the sidebar shows one loadout at a time; a toggle
  switches), or pick it and click a slot; x clears. The slots and the hover
  tooltip are the spell cards of `client/src/ui/spellcards` (as in the
  character panel).
- **Weapon skills**: the six use-based skills (level, progress, what the
  level gives), their techniques (have / level N; the ones the zone does
  not apply yet say so) and the eight elemental forms (yours highlighted).
- **Build**: everything that makes up the character, each number with the
  list of where it comes from: health (base, level, crystal boons, every
  armor piece and affix), mana, stamina, level damage, armor (60% cap), loot
  find, forge luck; per loadout side by side: main-hand item (material,
  item level, rarity, affixes, uniques, socketed gems and their element),
  the four spells, weapon hit and spell multipliers, crit, mana regen,
  cooldowns, the elemental form and its damage, demons; the armor; skill
  points (total = base + level + crystals, spent, unspent, per tree);
  learned passives (tree multipliers; "not in effect yet" where the zone
  does not apply them); elements and statuses the build brings.

Keys: **N** opens the last spell tree (N again closes), **B** the build
(B again closes), **Esc** closes; C, I, M and J close it as their own screen
opens. Opening frees the pointer; the panel carries `data-ui-panel` so the
look hint hides. The character panel (C) has buttons for both, the combat
hint line says "N skills · B build" and the level-up fanfare mentions N.

No contract change: everything comes from data the client already has:
Event 900 (level, attunements, points), combat_sync (known spells,
loadouts, skill XP, free points), Event 400 (inventory) and the generated
`COMBAT` / `ITEMS` tables. Gear is computed client-side as the zone does.

| File | What |
| --- | --- |
| `tree.ts` | Pure: tree layout (tier columns, barycentre lanes), node state (mirrors the zone's `Profile.LearnWith`), tooltip facts, passive effect lines (which ones the zone applies), technique descriptions, element colours |
| `build.ts` | Pure: `gearFor` (twin of `server/zone/internal/items/gear.go` `Inventory.Gear`), `buildOverview` (every number with its parts; damage factors as in `combat/validate.go` `damageOf`), `spellHitWith`, `treeDamageMults` |
| `store.ts` | zustand: open, tab, last tree, picked node |
| `char.ts` | `useChar` (level, points, known spells, loadouts, build view; shared with the character panel), `learnSpell`, `equipSpell` |
| `SkillScreen.tsx` | The screen (mounted by `PlayScreen`) and its keys |
| `dev.ts` | `window.__lodestoneSkills` (debug builds): `state()`, `open(tab)`, `close()`, `pick(key)`, `mock(level, attuned)` (a level-12 character with the inventory mock's gear; offline it also stands in for learn/equip) |
| `dev/shots.mjs` | Solo headless run: the clicks (learn, drag to a slot, pick + click a slot), checks, `docs/evidence/pt2-skill-tree-*.png` at 1920x1080 and 1280x720 |
| `dev/online.mjs` | The same against a real zone (`npm run dev` stack + a non-solo Vite): learn and slot through the screen, checked against combat_sync |

Tests: `skills.test.ts` (layouts of all eight trees, node states vs the
character panel's `learnable`, tooltip facts, passives, gear and every
build number). The gear numbers are pinned on both sides:
`server/zone/internal/items/gear_vector_test.go` computes the same mock
equipment in Go.

```
npx vitest run --root client src/ui/skills
node client/src/ui/skills/dev/shots.mjs
LODESTONE_CLIENT_URL=http://127.0.0.1:5199 node client/src/ui/skills/dev/online.mjs
```
