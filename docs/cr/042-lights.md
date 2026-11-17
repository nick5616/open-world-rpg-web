# CR 042: Torches and familiar lights (playtest 3)

Branch `pt3/lights`. Playtest feedback: "Add stuff to light up dark areas like a torch, and a different spell for each class of magic, like a floating glowing icicle that follows you, for example."

## Summary

- **Torch.** The existing `tool:torch` (items.yaml: 2 firewood at a workbench, 6 gold from general merchants) is now carried lit. It is in the **starter kit** (new characters; older ones buy one). **Key 8** (Interact 160) lights or douses it. Lit, it is a model in your off hand (first person: its own fist and forearm; third person and every other player: in the left hand of the avatar) with a warm flickering pool of light. It burns without fuel, **goes out in water** (swimming; the zone checks once a second and refuses to light one while swimming), when you fall, or when the torch leaves the pack. A spear or bow takes both hands: the torch then hangs at the hip, unseen, and still lights.
- **Familiar lights.** One cheap toggle spell at the root of every spell tree (eight schools), type `defensive` with a `familiar` block (no new spell type): **Hearth Mote** (fire: a hovering ember mote with rising sparks), **Rime Light** (ice: a slowly spinning glowing icicle with two shards circling it), **Dusk Lantern** (dark: a dim violet cage lantern), **Firefly Drift** (earth: six softly blinking fireflies), **Static Orb** (lightning: a pale ball in three slow crackling rings, smooth, never a strobe), **Zephyr Mote** (wind: a bright core in three turning ribbons), **Lumen Wisp** (light: a radiant wisp with a turning star and a tail), **Starless Lamp** (void: a black sphere ringed in cold light with three stars). Cast it to call the light over your right shoulder (it trails you with a little lag and bobs); cast it again to dismiss it. **4 mana to call, free to dismiss, 2.5-3 mana a second while it burns** (regen at level 1 is 11/s, so one is sustainable at rest and a fight drains you); it fades when the mana runs out. Casting another school's light replaces it. All eight names are proposals in `combat.yaml` `pending`.
- **Everyone sees them.** The light state rides in the player's snapshot record (below): another player's torch and familiar draw on their avatar and light your surroundings; a late joiner, a player walking into range and a ghost from the next zone get it on first sight, like worn armor (CR 034). Nothing is sent per tick.
- **Lighting tech.** A fixed pool of pre-created `PointLight`s (**2 on low, 3 on medium, 4 on high and ultra**, `poolSizeFor(maxLights)`), created with the world before the shader warm-up, never added or removed in play. Each frame the lit sources are ranked (your own first, then the nearest to the camera, nothing past 48 m) and take the slots; a slot that changes owner fades in from nothing, intensity eases. Every source, pooled or not, also has an **emissive glow** (an additive sprite halo; the familiars are unlit `MeshBasicMaterial`s), so a crowd of torches beyond the pool is still seen, just not lighting the ground. All the terrain, cave, layer and town materials are `MeshStandardMaterial`s (custom `onBeforeCompile` patches included), so they receive the pooled lights with no shader change (evidence below). Torch and familiar program variants are in `warmExtras.ts` for the warm-up.
- **Calm.** Flames flicker with three slow sines (swing 8%, 3% with Reduce flashing; the largest frame-to-frame step is under 1%, tested), magic lights breathe at 0.5 Hz; nothing strobes and nothing is full-screen.

## Contract changes

- `EntityRecord.appearance` (u64) bits **51-56**: bit 51 a torch is lit, bits 52-56 the familiar light's id (combat.yaml `familiar.id`, 1-31); bits 57-63 zero. The armor (bits 0-50, CR 034) is unchanged and still below 2^51; Event 400 `ap` stays armor only. The client decoder splits the value with BigInt (`net/snapshotDecoder.ts`: `appearance` = the armor, `light` = `>> 51`), so the number the armor code sees is exact. No protocol field or version change (the field's comment grew; `gen:check` clean).
- `combat.yaml`: eight `defensive` spells with `familiar: {id, kind, upkeepPerS, intensity, range}` (ids 1020, 1122, 1226, 1329, 1413, 1511, 1612, 1710; familiar ids 1-8); validated by the generator (`familiar.id` 1-31 and unique, `kind`, positive upkeep / intensity / range). `SpellDef.familiar` in the TS contract and `combatdefs.Familiar` in Go.
- `items.yaml`: `starter` gains `tool:torch: 1`.
- Events **1840** `light_state` (to you: the light bits, the familiar's spell id, why) and **1841** `light_refused`; Interact **160** `light` (0 send, 1 torch, 2 dismiss) in `contracts/events.md`; range 1840-1859 claimed.
- Dev console: `/tp x z [y]` takes an optional exact height, below the terrain too (Interact 250/14 `arg` bit 31, offset binary), for evidence runs in the Underground and the sky.

## Server

`server/zone/internal/game/lights.go`: a per-session `lightState` (torch, familiar id and spell, upkeep), `refreshLook` (the entity's `Appearance` = `armorAp | light bits`, told to the owner as 1840), `lightInteract` (Interact 160: pack check, downed, water, 300 ms between lightings), `familiarCast` (called from `combatFrame` for a legal cast of a spell with a familiar block), `lightTick` (once a second, only for sessions in `Server.lighted`: torch in the water or gone from the pack, everything when downed, the familiar's upkeep and its fade). The combat package pays the cast and keeps `Player.Familiar`, so dismissing the active light is free even at zero mana. Per-tick cost with nobody lit: one `len` check. Casts are validated like every spell (known, cooldown, mana, not downed); the torch like every Interact (rate bucket, pack, mode).

## Client

`client/src/world/lights/`: `familiars.ts` (the table from combat.yaml, light bits), `flicker.ts`, `lightPool.ts` (ranking, pool sizes), `lightStore.ts` (your own light from Event 1840/1841, with the reasons shown), `torchModel.ts` and `familiarModels.ts` (procedural geometry and sprites, shared), `glowTextures.ts`, `LightRig.tsx` (the rig, key 8, debug hook `__lodestoneLights`). `FirstPersonWeapon.tsx` draws your torch hand; `net/avatar.ts` the torch on every avatar (full rig and mid figure; the low figure keeps only the light).

## Not done

- Placing a torch on the ground (a temporary light) and a Light-school demon effect for the Lumen Wisp (the brief's "maybe"); neither was cheap enough to do safely here.
- The torch's state does not cross a zone hand-off (a new session starts unlit; the familiar likewise): the player presses 8 again.
- Older characters do not get the starter torch (it is 6 gold).
- Low-LOD (80 m+) avatars show no torch model, only its light and halo.
