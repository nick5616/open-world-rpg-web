# CR 050: Lively townsfolk (playtest 4)

Branch `pt4/lively-npcs`. Playtest feedback: "Make NPCs more lively." Towns should feel inhabited: people working, noticing you, talking to each other, reacting to the world. Dialog itself is CR 049 (`pt4/dialog`); this CR owns how townsfolk look and behave. No migration, no new protocol messages; Event kinds 1930 (shared bark) and 1931 (bell).

## Speech bubbles

Everything an NPC says out loud is drawn as a card over its head: zone barks (Event 1930), greetings, market cries, the chats between neighbours, rain and fear mutters, dialog lines. `client/src/world/buildings/npcFocus.ts` (the shared seam) holds the live lines; `npcBubbles.ts` draws them as a few reusable DOM cards (the same cheap approach as the name labels): at most 4 at once, within 25 m of the camera, on screen, nearest first with a line addressed to you slightly preferred, 0.2 s ease in, 0.5 s ease out, fading toward the range edge. A line to you has a warm gold border. The name label steps aside while its NPC speaks. Event 1930 is wired in `npcs.ts` (a session event listener, like townHud).

## They notice you

Within 6 m an idle or working NPC turns its head (and a third of that on the torso, limited to about 60 and 23 degrees) to follow you, easing back when you leave or go behind it, with an occasional nod. When you come within 5 m of someone who has not greeted you lately it waves and says a short line (client-side pools by role, time of day and rain in `npcLines.ts`). A greeting is rate limited by `GreetLimiter` (150 s per NPC, 8 s between any two, 4 a minute), so a walk through town gives a few, not a chorus. The NPC the dialog has open (`npcFocus.talkingTo`) turns its body to face you, plants its feet, gestures with both hands and tilts its head while `npcFocus.speaking`, and every speaking or barking NPC flaps its mouth (the face part has open and shut eyes and mouth).

## Work, visibly

Procedural poses per role at the work spot, with a held tool drawn by the shared props part: the blacksmith hammers in bursts of five at the anvil (a spark burst and a quiet `forge_hammer` clang on every blow; his blows replace the audio engine's random forge strikes while he is in view, `smithLink.ts`), the farmer hoes or scythes, the merchant arranges wares (some hold a crate) and calls out ("Apples! Crisp as a frost!"), the guard stands watch with a spear, shifting and scanning, the innkeeper wipes the counter and carries a mug, the bounty keeper studies the board with folded arms, villagers sweep, carry a basket or a bucket (also while walking) or rest. Everyone breathes, shifts weight, blinks and looks around. Each NPC has its own height, build and gait; elders (about one in six villagers) stoop and walk slower.

## Looks

One `GearMesh` per kind of dress holds every variant and each NPC shows a bitmask of it (`npcGear.ts`: per-vertex piece bit and colour slot, per-instance mask and colours, the vertex shader collapses the pieces not worn): 5 hair styles plus bald, a wide hat, a soft cap, a flat cap, a helmet with a plume, a hood, a headscarf, short beard, full beard, moustache, the dwarves' beard; vest, apron, tabard, skirt or dress, collar, shawl, belt; long or rolled sleeves and bracers. Roles keep their identity (guards helmeted in town-coloured tabards, smiths in leather aprons with bare forearms) and vary within it. Draw calls for townsfolk: 11 meshes before, 8 in view now (legs, torso, head, arms, face, headgear, dress, props) plus the sparks only while a smith strikes.

## Each other

Two NPCs that are idle within 3.4 m of each other stop, face each other and chat in alternating bubbles from a pool of 22 overheard conversations (gossip about a strange light in the hills, the dwarves under the mountain, bandits on the north road, the sky islands, the Hollow Bell). It is deterministic from their ids and the clock (`chatLine`: every client sees the same chat in the same minute, nothing sent), pairs refresh four times a second, walking past is enough to overhear.

## Reactions

- Rain (above 0.4): a hand over the head, hurried steps; the zone sends villagers and farmers indoors (`World.Rain`, set once per townsTick from the weather) while merchants, smiths, guards and keepers keep their awnings.
- Dusk (zone `dusk`, once per night): a guard (or the innkeeper in a town without one) calls "Lanterns!" or "Gates close at nightfall!" through `npcBark` (Event 1930) to players within 30 m, and villages and towns toll their bell for everyone within 160 m (**Event 1931 `town_bell`**: x/z/y of the square in cm, value = strokes; client plays the synthesized `town_bell` cue, `audio/bells.ts`, spatialised at the square).
- Monsters within 20 m: villagers cower (crouched, arms over the head, a frightened line), guards turn to face the threat and call out.
- You level up (Event 604): townsfolk within 14 m cheer (the existing applaud arms) and one calls "Well done!". A song already makes them applaud (CR 028).

## Richer schedules (`server/zone/internal/npc/life.go`)

Lunch (12:30-13:30) for a third of the villagers and farmers at the inn; an evening gathering (19:00-20:30): two in five of the off-duty folk at the square, one in five at the inn, the rest home (in rain the square's regulars squeeze into the inn); merchants keep market hours 08:00-18:00; a guard walks a beat to a street point 7-18 m from his post for a third of the day in 75 s stretches; a quarter of a villager's day goes on strolling to a neighbour's spot (idle neighbours chat), an eighth sitting on a doorstep (the client sits an idle villager found on a step, facing the street). Places are chosen once in `New`; `Want` stays a hash and a few compares per NPC per tick. `BenchmarkStepActiveTown`: about 15-20 ns per NPC per tick before, 19-28 after (400 active NPCs: 3 us per tick).

## Town animals (`townAnimals.ts`, `animalsPlan.ts`)

Planned per settlement from its id (all clients agree, nothing on the wire), simulated only near the camera, four instanced draws, halved on Low: chickens pecking near the farms (they scoot from you, roost at night and in rain), one or two dogs trotting between street points (the first tags along behind a passer-by for about ten seconds), cats on doorsteps (they slip away from a close visitor). Not in dwarven halls or sky towns.

## Cost

Zone: flat (above). Client: gear meshes in 8 draws, DOM bubbles capped at four, per-frame no allocation in the NPC loop, animals only near the camera.

## Contracts

`contracts/events.md`: 1930 `npc_bark` (shared seam, already there) and 1931 `town_bell`. No protocol, content or migration change.
