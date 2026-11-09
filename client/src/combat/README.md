# client/src/combat

The client side of combat (WP13). Online only: NetPlay attaches it to the
zone session (`link.ts`), offline play has no enemies.

| File | What |
| --- | --- |
| `timeline.ts` | The step-synchronous timeline (runs inside LocalSim's 60 Hz steps): input buffer (150 ms), attack starts and combos, dodge-cancel, bow draw / spear charge, sword parry, spell slots with cooldown + mana prediction, mobility spells as dash variants, elemental form (Q), technique (V/middle mouse), drink (R). Mirrors `server/zone/internal/combat/player.go` |
| `runtime.ts` | Input listeners, predicted hits (melee arcs on the active frames, local projectiles, beams, chains, area and lingering spells, runes), spark + hitstop at once, HitClaims, numbers on HitResult, combat Events -> HUD/FX |
| `probe.ts` | The input-to-hit timing probe (press -> first hit frame, feedback, recovery, dodge-cancel, i-frames, buffer, hitstop, drink, wind-ups, confirmation) |
| `events.ts` | Event kinds 200-222, Interact 50, `combat_sync` / telegraph decoders, typeId unpacking |
| `store.ts` | HUD state (zustand, event-rate) and the FX queue |
| `CombatLayer.tsx` | Enemies, telegraph decals, projectiles, areas, beams, sparks, floating numbers; mounts the first-person weapon (`weapons/`) and feeds it the melee swings |
| `weapons/` | Procedural weapon models, the first-person weapon and the weapon look other players see (pt/ux, below) |
| `CombatHud.tsx` | Health, mana, weapon (the equipped item's name, else the type) + four spell slots with cooldowns, draughts, boss bar, toasts, downed overlay |
| `link.ts` | Session attach, PlayerDriver hooks, `window.__lodestoneCombat` (probe, HUD) |
| `dev/feel-browser.ts` | Headless Chromium feel run against the real zone (`npm run combat:browser -w client`) |

Controls (playtest 1, `spellSelect.ts`): LMB attack; **mouse wheel** selects
what the right button uses: the weapon's secondary (parry for the sword,
draw for the bow, charge for the spear, heavy/bonk for the staff and wand;
the default, so RMB behaves as in WP13 until you scroll) or one of the four
spell slots (empty slots are skipped; the selected box is raised with a
gold "RMB" badge); **RMB** uses the selection (casts the spell); **hold Z**
for the weapon's secondary at any time (parry or draw with a spell
selected); **1-4** still cast directly (and select their slot); F or Left
Alt dodge, Q elemental form, V or middle mouse weapon technique, R draught,
X swap loadout (a slot that is empty in the new loadout falls back to the
weapon). The hint line under the bars says the same (`COMBAT_HINT`).
Selection is client-side only: the zone sees the same cast / alt_attack
input bits as before, so WP13's feel numbers and the timeline tests are
unchanged (`spellSelect.test.ts` drives the runtime through the wheel).

Overhead health bars (playtest 1): each enemy's bar (and an elite's or
boss's name label) sits in a plate that `faceCamera` turns to the camera
every frame, double-sided, so it reads from any side (it used to turn with
the body and vanished from behind; `billboard.test.ts`, screenshots
`docs/evidence/pt-ux-healthbars-{before,after}-{north,south,east,west}.png`).
Player nameplates (`net/avatar.ts`) and NPC labels were already sprites /
screen-space labels.

Tests: `npx vitest run src/combat` (feel limits in the tables, timeline
rules, wire decoders). The real-time numbers come from the probe run
(docs/evidence/wp13-feel.*).

## Weapons (pt/ux: "weapons don't look like weapons")

Sword, spear, bow, staff and wand are procedural models (no assets, nothing
in CREDITS.md), built once per look and cached for the session (never
disposed):

| File | What |
| --- | --- |
| `weapons/builder.ts` | Loft/lathe/sweep mesh builder: one indexed BufferGeometry per weapon with vertex colour and a `surf` attribute (metalness, roughness, glow) |
| `weapons/material.ts` | The ONE material every weapon, fist and forearm shares (a patched MeshStandardMaterial: per-vertex PBR terms, a sky/ground reflection for metal since the scene has no environment map, glow with a slow shimmer and rim); one program, compiled when the first weapon is drawn at zone join |
| `weapons/models.ts` | The five weapons at three detail levels, hands, the bow's dynamic string and nocked arrow |
| `weapons/look.ts` | Weapon look (type, material, gem) and its typeId packing |
| `weapons/FirstPersonWeapon.tsx` | The first-person rig: poses, fists and forearms, swing (hitstop-frozen, probe-measured exactly as before), bow draw, cast flicks, walk bob |
| `weapons/dev/preview.html` | Art preview on the Vite dev server (`/src/combat/weapons/dev/preview.html?sunsteel=1&gem=5`, `?d=1`, `?zoom=sword`); `dev/preview-shot.ts` screenshots it, `dev/tris.ts` prints triangle counts |
| `dev/weapon-shots.ts` | `npm run weapons:shots -w client [-- before]`: real client + real zone screenshots, docs/evidence/pt-ux-weapon-*.png |

What they look like: an arming sword (tapered, bevelled, fullered blade,
curved crossguard with finials and a langet carrying the gem on both faces,
leather-strapped grip, wheel pommel); a spear (ash shaft, strapped grip,
cord binding, socketed leaf head with a midrib and the gem at its base, butt
spike); a recurve bow (laminated limbs, leather grip, riser fittings, the gem
in the riser, a string that pulls back with the draw and an arrow nocked
while drawing); a staff (gnarled shaft, metal collar, four tines cradling a
large gem, plain quartz when none is socketed); a wand (ebony with carved
beads and spiral, metal ferrule, three claws holding the gem tip).

Materials colour the metal: steel by default, items.yaml copper, iron,
silver, sunsteel, starmetal, voidglass (oak = wooden). **Sunsteel** is a
warm gold-white with glowing edges and a shimmer running up the blade (it
reads at night too). Gems take their element colour (`ELEMENT_COLORS`) and
glow.

Budgets (triangles, one draw call each; fist 566, forearm 80):

| | first person | third person (< 25 m) | far (25-90 m) |
| --- | --- | --- | --- |
| sword | 1588 | 552 | 124 |
| spear | 1184 | 432 | 112 |
| bow | 964 | 448 | 76 |
| staff | 1252 | 354 | 68 |
| wand | 1068 | 222 | 68 |

The first-person view is 3 draw calls (weapon, right fist, right forearm),
5 with the off hand (spear shaft, bow grip); each remote player adds 1.

Where the look comes from: your own weapon and gem from the active loadout
(`combat_sync`), its material from the per-loadout material codes that now
end `combat_sync`; other players' from their entity's snapshot `typeId`
(weapon id | material code << 4 | (gem element + 1) << 8, contracts/
events.md "Players"), which the zone sets only when the loadout or gear
changes. Remote avatars hold it in the right hand (the bow in the left) on
the high LOD and at the side on the mid LOD.

Tests: `src/combat/weapons/weapons.test.ts` (budgets, bounds, determinism,
cache, gem and sunsteel glow, bow draw, typeId packing, combat_sync tail),
`src/net/avatar.test.ts` (a remote avatar holds and swaps the weapon);
zone: `server/zone/internal/game/weaponlook_test.go`.
