# CR 052: In-world guidance and a quiet HUD (playtest 4, `pt4/diegetic`)

Nicole: "make more things directly in the game instead of text you see in the
HUD." Client-only. No protocol, Event, Interact, migration or worldgen change
(the Event range 1950-1959 stays unused; genVersion unchanged). Audit of the
HUD: `docs/evidence/pt4-diegetic-audit.md`.

## 1. Immersive HUD (default on)

`client/src/hud/immersive.ts` (pure rules + the persisted setting
`lodestone_hud`, a switch in the Esc menu's **Interface** page). With it on:

| piece | rule |
|---|---|
| health / mana row | shown while either is not full, and 4 s after a value changed; else faded out |
| hotbar | shown while in combat (audio engine's `combatUntil`), in a boss fight, when downed, and 6 s after a hotbar key (spell, draught, swap, dodge, secondary, form, technique), the wheel or an attack click on the world |
| key-hint line under the hotbar | hidden |
| quest tracker card | collapsed (opacity 0) to the compass diamond unless the tracked quest's step just changed (9 s), Tab is held, or the journal (J) is open |
| quest notices | "step" notes dropped (the tracker opening is the news), at most 2 at once, 3.5 s instead of 6 s |
| level-up banner | one small line (the glow and the sound carry it) |
| region / major discovery cards | the small "minor" size on a softer backdrop |

Everything is faded with `opacity`, never unmounted, so the measured layout
variables (`--ls-hotbar-h` and friends, `hud/layout.ts`) are unchanged. The
crosshair, compass, chat, voice, party frame and loot toasts are as before. The
switch off restores every piece exactly.

## 2. The guiding wisp

Key **. (Period)**: the brief reserved G, but G is the glider (`KEY_MAP`), so
the wisp took the free Period key (declared in `input/bindings.ts`, shown in
the Esc menu's Controls). `world/guide/`:

- `route.ts`: a road graph built once per world from `Towns.roads` (every road
  resampled to <= 14 m, junctions of different roads within 10 m linked) and A*
  over it. `planRoute` follows roads when you are within 26 m of one, the goal is
  within 140 m of one and the road is no more than 1.7x the straight line (+80 m);
  otherwise the straight line over the terrain. `stepWisp` keeps the wisp 8-15 m
  ahead of you along the route (`leadAt` drifts between), waits when you stop,
  catches up at 16 m/s, re-plans when you leave the route (> 70 m), the goal
  moves or you step onto a road, and fades inside 14 m of the goal.
- `target.ts`: the tracked quest's nearest marker (an area: a point inside its
  near edge), else your map pin, else a party pin.
- `WispLayer.tsx`: one `Points` object of 16 vertices (head, 11-point trail,
  4 orbiting sparks) on an additive shader; no lights. It skims a road at 1.35 m
  and floats 2.1 m over terrain (water surface counted), hides in caves and in
  the sky. A soft synthesized chime (`wisp_chime`, `audio/bells.ts`) on start and
  arrival. By itself 1.6 s after a quest step changes, for at most 20 s. Pressing
  the key again puts it away. With no goal a one-line note says what to do.
- The tracker's text "500 m south-west" stays in the card when it is open; the
  compass diamond is unchanged.

## 3. Signposts

The towns buffer already stands a post at each road fork (`roads.ts drawSign`)
with blank boards. `world/signposts/`:

- `placement.ts` (pure, deterministic): **fork posts** keep their arms, each now
  named for its destination with its distance; **exit posts** (new) stand beside
  each town road (class 0) 7 m outside the town radius, on the right as you leave,
  at most 3 per town, skipped within 30 m of a fork post. Boards (<= 3, nearest
  first): the town the road leads to, up to 2 named landmarks within 3.2 km and a
  75 degree cone ahead (towers, landmarks, ruins, watchtowers, shrines, wizard
  towers, sunken temples, mineshafts, craters; never camps, sky or underground
  sites), then other towns ahead to fill.
- `boards.ts`: the two lettered faces of each board as world quads (readable
  left to right for their reader) and the arrow angle per face.
- `SignpostLayer.tsx`: exit posts are one small mesh per town, built when you
  first come within 650 m and hidden past 900 m; lettering is a pool of canvas
  textures (3 / 5 / 8 / 8 slots by quality tier) given to the nearest posts
  within 38 m, one draw call each. Text is carved dark on wood with the arrow
  drawn as the reader of that face sees it.

## 4. Landmarks from afar

`world/landmarks/` (`landmarks.ts` pure and tested, `LandmarkLayer.tsx`):

| signal | where | range | when |
|---|---|---|---|
| grey smoke plume (12 puffs, 95 m) | bandit and enemy camps | 2.6 km, nearest 6 (3 on Low) | always |
| pale light pillar (the quest beam's mesh) | towers not yet attuned | 3.6 km, nearest 4 | dusk and night |
| warm lantern pair | dwarven hall doors | 520 m | brighter at night |
| soft glow | cave mouths | 800 m | brighter at night |
| circling dark birds (6 per site) | a sealed vault or an active world event in range | 1.8 km | daylight; not on Low |
| slow glints | sky palaces | 3.2 km | by day; not on Low |

Three `Points` draws (glow, smoke, birds) plus up to four beam meshes; no
three.js lights are added or removed.

## 5. Feedback in the world

- **Low health**: below 40% the screen edges darken and desaturate a little
  (`LowHealthVignette`), strongest near 10%; a slow lub-dub heartbeat
  (`heartbeat`, synthesized) no faster than 70 a minute. Under Reduce flashing
  (default on) or reduced motion the vignette does not swell and the heartbeat is
  halved. Off when downed.
- **Level up**: a spiral of golden motes rises around your character
  (`world/feedback/LevelGlow.tsx`, 28 points, 3.4 s) with the existing level-up
  sound; the banner is one small line.
- **Region entry**: smaller and softer (see 1).
- **Bounty boards**: papers pinned on both faces of the boards near you
  (`BoardPapersLayer.tsx`, one mesh, nearest 3 boards within 55 m), one per
  untaken bounty. The zone sends the list only when a board is opened (Event 802),
  so a board never opened shows 3 papers (every surface town's board holds 3 or 4;
  the dwarf halls' boards differ) and the exact count after you open it; accepting
  a bounty removes its paper.

## Not changed

Tips content and order (`pt4/first-hour`), NPCs, the dusk bell (`pt4/lively-npcs`),
the conversation UI (`pt4/dialog`), server quest content, worldgen.
