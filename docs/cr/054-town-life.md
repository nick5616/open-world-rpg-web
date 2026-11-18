# CR 054: Town life: named animals you can pet, a sundial, no weather indoors (playtest 5, `pt5/town-life`)

Nicole: "give some dogs names", "make it so you can pet the dogs with a really
good lean down and pet animation", "add a sundial style clock", "shouldn't see
weather effects inside a building."

New wire: Interact 183 `pet_animal`, Events 1970 `animal_pet` and 1971
`animal_pet_refused` (range 1970-1979, `contracts/events.md`), emote 26
`pet_animal` in `contracts/content.yaml` (a system emote: the zone never plays
it, the client poses it). No migration, no worldgen change.

## 1. Names

`client/src/world/buildings/animalNames.ts`. Town dogs (24 names: Biscuit,
Old Tam, Mudge, Sir Wags...) and cats (20: Marmalade, Mistress Pip, Soot...)
are named from the settlement id and the animal's ordinal within its kind, so
every client agrees and nothing is sent. The ordinal (not the plan index) is
what the wire key uses, so names and keys are the same on the Low tier, which
only drops chickens and trailing dogs and cats. Names never repeat inside a
settlement.

- **Nameplate** (`animalPlate.ts`): one soft DOM label over the animal you
  look at within 7.5 m (fades in from 7.5 to 4 m).
- **E prompt**: "[E] Pet Biscuit".
- **Owners' barks** (`animalBarks.ts`): each dog and cat has a keeper among
  the settlement's villagers and farmers (hash over the records, so everyone
  agrees). When the animal is within 5.5 m of you and the keeper within 14 m
  they call it by name ("Biscuit! Leave the traveller be!"), at most once per
  70 s per animal; right after you finish petting it they remark on it
  ("Biscuit likes you. He does not like everyone."). It goes through the
  client bark seam, `npcFocus.say`, the one the zone's `npcBark` (Event 1930)
  also draws through. A zone-side twin was not written: the zone does not know
  the animals or their names (they are client-side), see Gaps.

## 2. Petting

E on a dog or cat within 2.6 m (`PET_REACH_M`). The picker (`interact.ts`)
got a candidate kind `animal` with a wider aiming cone (a dog at your feet is
well below the crosshair) and a small bonus over a person standing behind it.

**The moment** (`petting.ts petBeat(t)`, 2.5 s; one function of the time since
E that the camera, the hand, the avatar, the animal and the tests all read):

| t (s) | what |
|---|---|
| 0 - 0.6 | crouch in (smoothstep), the animal walks to a spot 1.45 m in front of you and turns side-on, head to your left |
| 0.3 - 0.8 | the hand comes up |
| 0.7 - 2.05 | three strokes of 0.45 s: head to rump over the long part (smoothstep), then lift 7 cm and glide back to the head |
| 2.0 - 2.5 | the hand leaves, you rise (smoothstep) |

- **First person** (`scene/FirstPersonPet.tsx`): the camera drops 0.52 m,
  leans up to 0.3 m toward the animal and turns toward its middle (only when
  you were already looking roughly at it); the weapon and arms step aside
  (`view.fpPet`); your own forearm (fixed length, always ending at the hand,
  coming in from the lower right) and a hand with a palm, thumb and four
  fingers follow `handTarget`: the animal publishes its head-top and rump-top
  each frame (whatever pose it is in), the hand rides that line lifted by
  `petBeat.lift` plus a palm's half thickness, so it cannot sink into the fur.
  Fingers curl a touch as a stroke presses.
- **Third person and other players** (`net/avatarAnim.ts` pose 26): down on
  one knee, torso and head leaning over the animal, left hand on the knee, the
  right arm gliding with the same strokes.
- **The animal** (`townAnimals.ts`): stops wandering, walks to the spot (a
  dog sits: haunches settle, front legs straight, head turns to you with a
  question-tilt and nods up into the hand; the tail wags fast and wide; one dog
  in four rolls onto its back for about a second and a half, legs waving; a
  cat arches its back, leans into the hand and trembles with a purr). Hearts
  rise (`petHearts.ts`, one draw call). To let the head turn and the tail wag
  they are their own instanced meshes now: six draw calls with dogs in view
  (chickens, dog bodies, legs, heads, tails, cats) plus the hearts. Dogs also
  wag lazily when idle. A cat now lets you walk up slowly (it still bolts when
  you run at it or crowd it under 0.9 m).
- **Sound** (`audio/animalSynth.ts`, rendered once like the bells): a soft
  panting bark of three huffs for a dog, a swelling purr for a cat, positional
  (`pet_dog`, `pet_cat` cues).
- **Rules** (`petting.ts petBlocked`/`petCancelled`, `petControl.ts`): not
  mounted, downed or in combat (`audioWorld.combatUntil`), not airborne or
  swimming, within reach. Moving (over 0.7 m/s, or 0.9 m from where you
  started), a jump, getting hurt or the saddle ends it cleanly: the camera
  lets go over 0.1 s, the avatar's emote is cleared, the zone is told (stop).
  The E prompt hides while petting. Cosmetic: no buff, no stat. (The brief
  allowed a "Rested"-style buff only if trivial to do right; it was not.)
- **Zone** (`server/zone/internal/game/animal_pet.go`): Interact 183 start
  checks the player (on the ground, not mounted, not downed or in combat within
  20 s, inside the named settlement's radius + 40 m, one start per 1.2 s) and
  tells every player within 48 m but the petter (Event 1970: petter, animal
  key, start or stop, the petter's feet); refusals are Event 1971. Stop is told
  only if a start was.
- **Other players see it**: the petter's avatar kneels (the client poses emote
  26 from Event 1970) and this client's own copy of that animal trots over to
  stand in front of the petter and does the same. The animals are not
  synchronised (each client simulates its own); the copy comes to the petter,
  snapping if it is over 14 m away. A client that has not met that town yet has
  no such animal and ignores the event.

## 3. The sundial

`sundial.ts` (pure, tested), `sundialMesh.ts` (the stone), `hud/SundialClock.tsx`.

- **In the world**: a stone drum with a round plate and a brass gnomon on each
  settlement's square, on the first free spot of four rings (5.5-12 m, in a hash
  order so each town's stands elsewhere) that clears every town box and
  building. Not in dwarven halls or sky towns. The plate (a canvas texture
  built once) carries carved hour lines VI to XVIII at the angles the shadow
  really has at those hours (computed from the renderer's own `sunDirection`,
  so whatever tilt the sky has is what is carved), half-hour ticks, numerals
  and a small carved sun on the unused half. The shadow is the gnomon
  projected along the sun direction each frame (`shadowOf`: the plate angle runs
  from pi at 06:00 over pi/2 at noon to 0 at 18:00, the length is
  `h * |sun.xz| / sun.y` clamped to the plate), drawn as a tapered dark blade.
  Fainter in cloud and rain, absent below a sun height of 0.045 (dawn, dusk and
  the night): nothing is readable by moonlight.
- **On the HUD**: a half-dial under the compass, left of the clock chip (which
  keeps the numbers): a sun (a moon at night) travels the arc from the left at
  06:00 over the top to the right at 18:00, hour ticks every two hours, a thin
  dashed shadow ray from the gnomon to the glyph, and a word for the time of day
  (Dawn, Morning, Midday, Afternoon, Dusk, Evening, Midnight, Small hours).
  Immersive HUD (`hud/immersive.ts dialOpacity`): like the compass it is always
  there; with the setting on it rests at half opacity and brightens for 6 s when
  the hour turns or Tab is held; with the setting off it is always full.

## 4. No weather indoors

`world/sky/exposure.ts`, wired in `world/WorldScene.tsx`. The camera's
exposure, 1 in the open down to 0 in closed rooms, caves and underground, from
`exposureTarget(cover, underground, baseCover)`:

- the audio shelter probe (`audio/shelter.ts`, the same towns-buffer boxes the
  movement collides with): `indoors` (closed building 1, open-fronted forge
  0.55) and `roof` (a roof over the head, up to four more around it);
- the roofs of player-built bases (CR 041 roof, ridge cap and gable pieces,
  from the camps store): a tile within 1.3 m overhead counts fully, a
  neighbour within 2.9 m 0.45;
- the cave/underground factor the scene already had.

It is sampled at 10 Hz and eased linearly, 0.5 s for a full change, every
frame (measured in the real client: 24 frames over 498 ms, the biggest step
0.08). It scales: the rain streaks, the snow and sand particles, the ambient
life that includes the leaves (`life.update` is given `under = 1 - exposure`),
the fog and haze the weather adds (rain, snow, dust, fog banks, the haze
shimmer), the storm's darkening of the sun and sky, and lightning's strength
(`lightningThrough`: 22 % indoors, so a bolt through a window is dim, not
gone). The ground wetness and settled snow are world state, not a screen
effect, so they stay. There is no wet-lens effect in this renderer; hail does
not exist in it either (CR 030's states are rain, snow, dust, fog, haze and
storm).

## Tests

- client `animalNames.test.ts`, `petting.test.ts` (timeline, strokes, hand
  line, roll odds, rules, cancel, wire key, crouch camera, owners' barks,
  nameplate fade, the sounds' envelopes), `sundial.test.ts` (the shadow from the
  sun direction, hour reading against the carved marks, no shadow at night, the
  HUD arc, the immersive rule, the spot search), `sky/exposure.test.ts` (target,
  the 0.5 s ease at any frame rate, no pop, lightning, base roofs);
  `audio/triggers.test.ts` knows the animal synth names.
- zone `animal_pet_test.go`: key round trip, the refusal rules, and on the
  official world's real settlement: a start reaches the player standing beside,
  not the petter, a start inside the limiter window is refused, a stop is told,
  a stray stop is not, a settlement that does not exist is refused.
- real client: `tools/playtest/pt5-town-life.mjs` (see STATUS).

## Gaps

- The sundial has no collision (the player walks through the drum).
- Owners' barks are client-side; a zone `npcBark` twin would need the names in
  Go.
- Pettings are not synchronised animal state: two players petting "the same"
  dog each see their own copy come over.
- The buff was not done (cosmetic only).
- The photo-mode time preview moves the world's light but not the sundial's sun.
