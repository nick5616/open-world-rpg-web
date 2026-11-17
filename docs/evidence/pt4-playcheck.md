# Playtest 4: playcheck (branch `pt4/playcheck`)

Nicole: "Idk if any of it works because nothing pulled me to try anything." This is a play-through from the player's side: a private stack (`node tools/playtest/stack.mjs --zone-env LODESTONE_ZONE_DEV=1`, a fresh scratch world), the real client in headless Chromium driven with real keys and mouse (`tools/playtest/playcheck-driver.mjs`: a long-lived page you give small step files; `contact-sheet.mjs` makes the evidence sheets). The dev console was used only to get somewhere (`/tp`, `/vibe go`, `/level`, `/give`, `/god`); the action being tested was always a real key press or click. Where an older harness already covers a feature end to end it was re-run (dwarf camp walk, PvP acceptance) or cited.

Evidence sheets (small JPEGs, labelled): `pt4-playcheck-1-start.jpg`, `-2-combat-magic.jpg`, `-3-world-edits-build.jpg`, `-4-places.jpg`, `-5-systems.jpg` (all in `docs/evidence/`).

Legend: yes = worked end to end as a player would do it; partly = worked with a caveat or only the first half was run; not run = not exercised in this pass (reason given).

| Feature | How a player finds it | Works? | Evidence | Fix commit |
|---|---|---|---|---|
| Title cavern, character creation (build, skin, hair, beard, eyes) | Play, then New | yes | sheet 1 (title, creation) | |
| Your look shown to another player | Another browser met in the world | yes (long blond hair, dark skin, blue outfit all showed on the other client; the nameplate floats well above the head) | sheet 1 (other player) | |
| First quest ("Slimes in the meadows") | Welcome card + gold compass diamond + quest tracker | yes: walked to Tammir, E, quest accepted, tracker changed to the slimes with a marker | sheet 1 (quest dialog) | |
| Combat basics (sword, boar) | Tip "Enemy nearby", hotbar hint line | yes: hits accepted, kill gave a codex entry and "First Blood" | sheet 1 (after kill) | |
| Spells (keys 1-4) | Hotbar, hint line | yes: Frost Bite cost 10 mana and cast | sheet 2 | |
| Combat toasts ("Dodged!", "Parried!") | Appear on their own | was broken: stayed on screen until some other HUD value changed | | 93cf5d0 |
| Spell bank hides equipped spells | Character panel (C) | yes: 111 cards, none of the three slotted spells listed | sheet 2 | |
| Lesser magma dash vs full | Slot 3 from the start | yes: 5.6 m at level 1, 8.2 m at 10, 10.3 m at 15 (a level 20 sample read 8.5 m inside a town, a wall in the way) | | |
| Skill tree (N) | Tip "Skill point to spend" | yes: 8 schools, learnable nodes, tooltips, spell slots | sheet 2 | |
| Torch (8) | Starter kit, tip at night | yes: warm pool of light on the ground and walls | sheet 2 | |
| Class light spell (Hearth Mote) | Skill tree, tier 1 | yes: dragged from the bank into slot 4 with clicks, cast lit the wall | sheet 2 | |
| Demons: high level shrug off steel | Night tip | partly: server tests (CR 048); live a level 12 cinder fiend took full 62 per sword hit; level 22 not reached (walked into a tree, see below) | sheet 2 (fight) | |
| Build hammer (9): pieces, ghost, cost | Tip, What's new, Esc menu | yes: foundations x3 (log count fell by 18), bench, bed placed with real clicks; green/red ghost with the reason | sheet 3 | |
| A base and its comfort | Build menu "Comfort" line | yes: bed + bench = "Bare (2/20) · 3 more for Cosy" | sheet 3 | |
| Build menu / camp menu say which key | text in the menus | was wrong: they said 8 (the torch) | | bb298f0, 93cf5d0 |
| Build refusal near a town | red ghost | was misleading ("Not inside a settlement" read as the opposite) | | 3fef9f2 |
| Chop trees (axe, `=`) | Starter axe, `=` hint under the crosshair | yes: held LMB 7 s, +3 logs +1 stick, tree gone | sheet 3 | |
| Dig and fill (shovel, `=`) | same | yes: dug to the -6 m limit paying 210 dirt, fill spent it; "The ground here is protected" near town/road | sheet 3 | |
| Break rocks (pickaxe) | same | not run (same code path as trees; unit tests) | | |
| Mining veins | Caves, E on a vein | not run (needs a cave; see dwarf row) | | |
| Forge / smithing | Town forge, E | yes: "[E] Use the forge", panel with smelting recipes and counts. The anvil was shadowed by the blacksmith's "Talk" prompt at 2 m | | |
| Caves to a dwarven camp | Tunnel mouths on the surface | yes: the existing walk harness (`dwarf-connected-shots.ts`) walked a real tunnel with monsters to the camp of Mogseam | sheet 4 | |
| Stronghold, cave chests, lore tablets, the Deep Warden | deep caves | not run: the dev console cannot teleport underground and the walk to a stronghold is long; `/vibe go` lands on the surface plaza above | sheet 4 (stronghold plaza) | |
| Sky island, sky palace, ward trial, Sky Guardian | beam and halo from far below, map | yes: `/tp x z y` onto the island, arrival banner "Gaetabra Palace", `[E] Strike the Ward of the Sun / Moon / Wind` each worked, the third woke "The Gilded Sky Guardian" with the boss bar | sheet 4 | |
| Sky Guardian kill and chest | | not run (server tests) | | |
| Glide Ring Race | Stand in a sky town | partly: `[E] Glide Ring Race: start` armed a 12-ring course with medal times; the flight itself not run | sheet 4 | |
| Depths and its shrines | Map, Depths gate | partly: `/tp` with a negative y reached the Depths (hellish red cave, lava glow); E at the shrine started its fight (the "Enemy nearby" tip fired), but the "[E] Cleanse the demon shrine" prompt was never on screen when I looked, because the Esc menu had opened over the game (see Not fixed 2) | sheet 4 | |
| Mounts (5) | Spirit Whistle item, 5 | yes: whistle, steed arrives, `[E] Ride Spirit Steed`, mounted and ran, E to dismount | sheet 5 | |
| Pets | Pet card, E | yes: `/pet wolf` followed, card "Following · 4 command · 7 stay", `[E] Pet` | sheet 5 | |
| Taming | | not run | | |
| Fishing | Rod (not in the starter kit), E at water | partly: `[E] Cast your line` over a lake shore; the cast was refused "No water deep enough there" in the shallows I tried; the full catch is covered by sp11 (needs the fast-fish env) | sheet 5 | |
| Emotes (hold H) | Esc menu Controls | yes: wheel opens | sheet 5 | |
| Instruments (U) | needs an instrument in the pack | yes: lute keyboard opens with scales and a click; without one it says where to get one | sheet 5 | |
| Camps (P) | camp menu | yes: menu with campfire, bedroll, chest, workbench, signpost and costs; placing not run | sheet 5 | |
| Photo mode (L) | Esc menu | yes: panel with time, DOF, vignette, grain, FOV, Save PNG | sheet 5 | |
| Ground loot | kill drops | not run (cited: `ground-loot-shots.mjs`, pt2) | | |
| Bounties and side quests | Kelmir the bounty keeper | yes: E opens the board with slay/deliver bounties and offered the "Embers of the Old Watch" quest with a map | sheet 1 | |
| Towers, attunement | Tower on the map, compass | yes: climbed the Thornwrapped Spire (hold W, 66 m to 95 m in ~20 s, mode "climb"), `[E] Attune to the crystal`, +8 stamina, +5 health, +1 skill point, +100 XP | sheet 4 | |
| Map, fast travel | M | partly: map opens and explains "click an unlocked tower or waypoint, then Fast travel"; clicking a locked waypoint says "Touch this waypoint stone to unlock it"; the jump itself not run | | |
| Main story start | Journal "The Last Song begins after Ward against the night" | partly: the journal shows it; not played | | |
| PvP flag and duels | Character panel, party frame | yes: `tools/acceptance/pt2-pvp.mjs` re-run on this branch, ALL PASS (setup 5/5, PvP 9/9, duel 12/12) | (pt2 evidence) | |
| Voice settings | Esc menu Voice | yes: panel with devices, test, diagnostics; no LiveKit in the stack so "offline" | sheet 5 | |
| Kill flash (no bright flash on a kill) | | not re-run: `flash-audit.mjs` needs two GPU browsers and a second Chromium crashed the GPU process of the first on this host | | |
| Achievements (Y) | popups, Esc menu | yes (seen unlocking "First Blood", "Seasoned", "Night Owl", and the panel opened) | | |

## Discoverability gaps (features nothing in the game points to)

- **Caves and everything under them** (tunnel mouths, dwarf camps, strongholds, chests, tablets, mining veins, the Deep Warden): nothing on the compass, the map's default layer or in a conversation says "there is a way down here". The first sign is stumbling on a mouth.
- **The sky** (palaces, sky towns, the Glide Ring Race): the light beam is visible from below, but nothing says how to get up (sky lifts and the glider are only explained when you are already falling or in a lift). Nothing in the starter quests mentions the sky.
- **The Depths and its shrines**: only the Depths gate on the map.
- **The hammer (9), the work tool (=), the torch (8)**: the hammer and `=` are only in What's new, the tips list and the Esc menu's controls; there is no in-world cue (a sign, a woodcutter, a first quest). The `=` hint under the crosshair only shows once a tool is up.
- **Bed needs three wolf hides**: the build card shows "6/3" with no item name; a new player cannot tell wolf hide from log. (The ghost's red line does name the missing item only after you pick the piece.)
- **Instrument, fishing rod, Spirit Whistle** are not in the starter kit and nothing sends you to a merchant; each tells you what to do only after you press its key.
- **Fast travel**: the map's hint line says "click an unlocked tower or waypoint" but the first waypoint is a stone you have to touch, which nothing mentions before the map.
- **Taming, camps (P), photo mode (L), emotes (hold H)**: only in the Esc menu's controls list.
- **Demon rules** are explained by a tip at the first night only (good), but nothing says that Light magic and sunsteel exist or where to get them.

## Not fixed

1. **Overlapping centre-screen text at a sky palace.** Repro: `/tp` onto a palace island (`/vibe find landmark=sky_palace`, `/vibe go 1`, then `/tp <x> <z> <floor+1>`), strike the third ward. The place title ("Gaetabra Palace"), the ward notice ("Ward of the Sun: 3 of 3") and the boss name ("The Sky Guardian") draw over each other. (HUD layout belongs to pt4/diegetic.)
2. **The Esc menu opens by itself in headless Chromium** after a teleport (pointer lock is lost and the game opens the menu, by design), so every E prompt is hidden until it is closed. In the harness this cost many steps; with a real browser a teleport or alt-tab does the same, so a player who alt-tabs and comes back sees the Esc menu. Probably fine; noted so nobody chases the missing shrine prompt in a headless run.
3. **Under host stalls the session drops with "Disconnected: bad ticket / ticket: expired" or "Connection lost: websocket connect timeout (10000 ms)".** Four times in about an hour on this heavily loaded machine (zone ticks of 0.5-1.6 s), twice with both browsers dropping at the same second. Zone tickets live 60 s, so a reconnect after a long stall carries an expired ticket. Repro: stall the machine (several parallel builds) for 15 s while playing; you get the dead-screen with Characters / Reconnect buttons. I did not trace why the in-session reconnect (which fetches a fresh ticket) ended on the dead screen; most likely the host stall also starved the director call.
4. **A client crash I could not reproduce**: `pageerror: Cannot read properties of null (reading 'length')` three times at 17:47:47 (zone "leave" at the same second), the canvas went dark navy. It happened in the step that ran `/time 0:00`, `/despawn`, `/spawn cinder_fiend 1 <level>` right after a `/tp` from a sky town to the ground. Re-running the teleport pair and a fiend spawn alone did not crash. No stack was captured (the driver now writes one to `pageerror-*.txt` if it recurs).
5. **Shallow lake shore refuses the cast** ("No water deep enough there") although the prompt `[E] Cast your line` shows over any water. Repro: `/vibe find landmark=lake`, `/vibe go 1`, face the water and press E. Needs a deeper-water hint or hiding the prompt over shallows.
6. **The anvil prompt can be shadowed by the nearest NPC.** Repro: stand at Draedmore's anvil: `[E] Talk to Selina (blacksmith)` wins at 2 m. Town talk path belongs to pt4/dialog.
7. **Level-up banner and "welcome" card cover keys.** The "Welcome to Lodestone" card has to be clicked before E works (the shared harness helper `dismissCards` only knows the What's new card). A player will find the button; the harness cannot. Not a game bug.
8. Kill-flash was not re-measured (see table).
