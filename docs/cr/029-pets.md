# CR 029: taming and pet companions (playtest 2)

Nicole, overnight: "all sorts of good shit" (Valheim and Breath of the Wild). This CR adds Valheim-style taming (weaken a creature, feed it its favourite food while it is calm) and pets that follow you, fight beside you, level up, have one ability each, wait in a stable, and are knocked out instead of killed. Data: `contracts/content.yaml` section `taming` (+ four feats, emote 25) → `npm run gen` → `server/pkg/contentdefs` (`Taming`) and the client's `CONTENT.taming`.

## Tameable creatures

Nine species, one per combat.yaml creature (the generator refuses demons and bosses, unknown foods and non-food items):

| Species | Favourite food (others) | Meter | Chance | Health / bite (lv 1) | Ability |
| --- | --- | --- | --- | --- | --- |
| Dewdrop Slime | Heartleaf (apple, glowmoss) | 3 s | 95 % | 150 / 6 | **Soothing Ooze** (heal: you below 70 %: 12 % of your health, and itself) |
| Mossback Slime | Glowmoss (heartleaf) | 3.5 s | 90 % | 170 / 6 | **Mossbloom** (heal: you and your party near you below 80 %) |
| Thornback boar | Apple (berry tart, emberroot) | 5 s | 80 % | 170 / 10 | **Tusk Charge** (a rush at a foe 4-12 m away: 2x and a stun) |
| Mossjaw wolf | Raw meat (grilled meat) | 6 s | 75 % | 130 / 11 | **Rallying Howl** (buff: your damage +15 % for 8 s when a fight starts) |
| Crag ram | Frostcap (heartleaf, bread) | 5 s | 80 % | 180 / 10 | **Headlong** (1.8x and a knockback) |
| Rime stalker | Frostgill char (speckled trout, raw meat) | 7 s | 65 % | 140 / 10 | **Frost Breath** (1.4x ice on the target and everything within 3 m, slowed) |
| Bog lurker | Mudback carp (bog pike, reed perch) | 6 s | 70 % | 190 / 8 | **Mire** (0.8x earth within 4 m, slowed) |
| Dust scuttler | Raw meat (silverfin) | 5 s | 75 % | 130 / 10 | **Venom Sting** (1.3x and a curse: +20 % damage taken) |
| Glintfox | Berry tart (silverfin, cheese) | 8 s | 50 % | 110 / 7 | **Dazzle** (a stun) |

The meter is `tameS` x `favouriteMult` (0.6) with the favourite; the chance gets `favouriteBonus` (+15 %, at most 99 %). Every species uses its creature's model and codex entry; the bestiary (J) says whether a creature is tameable, its foods and its ability.

## Taming (server-authoritative)

1. **Weaken**: a tameable creature hurt below `weakenPct` (50 %) of its health is reported by the combat world (`PetOutputs.Weakened`, only when content is on). If the player who hurt it (or whose pet bit it), or anyone within `smellM` (14 m), carries one of its foods, it **calms** for `calmS` (30 s): it stands, turns to the nearest player and sniffs; enemies' AI skips it, pets leave it alone. Event 1201 to players within 48 m (a "?" over it). A hit breaks the calm (it fights on); a calm that runs out ends the same way; once ended it can't calm again for 10 s.
2. **Feed**: E within `feedReachM` (4 m + its radius) → Interact 130/1. The zone spends one food it likes (the favourite first), starts the **meter** (Event 1202 phase 1 to the tamer and players near) and keeps the calm going. One tamer per creature.
3. **Hold**: the meter is interrupted (1202 phase 2 with the reason) when the tamer walks off beyond `stayM` (8 m: it startles and turns on you), is hurt (the same), goes down, leaves, the creature is hurt, or its calm ends.
4. **Roll** (`content.RollTame`, deterministic in the world seed, the character, the character's persisted roll count, the creature's entity id and the food): tamed (1202 phase 3: the creature leaves the world like a corpse, no XP or loot, its group cleared quietly; a pet record is added) or it snatches the food and fights on (phase 4). A tamed creature is **shiny** with `shinyChance` (3 %: gold-touched, +10 % health and damage) or **elemental** with `elementalChance` (8 %: takes the region's element, its bite and strike ability carry it, +5 %). The pet starts at the creature's level, capped by yours.

## Pets

- **One out, the rest in the stable** (`maxPets` 6). The first tamed is the one out; later ones go to the stable (a note). At a **stable** (within `stableM`, 24 m, of one of your camp pieces, CR 025, or in any town; a world with neither has no stables: anywhere) the panel takes one out (the one out goes in), sends the one out to the stable, or releases one (anywhere).
- **In the world** the pet is an Enemy with an ally record on the CR 020 summon machinery (`allyStrike`, `allyHit`, the enemies' steering), kept out of the enemy tables, drawn as EntityKind effect with typeId bit 15 (`combat.PetTypeID`: bits 0-7 the creature, 8-11 element + 1, bit 12 shiny), named "Owner's Name", level in `EntityRecord.level`, real health %. It follows a spot behind your shoulder (faster the farther it is; beyond `warpM` 60 m, e.g. a fast travel, it is set down beside you), joins fights that are already on (never wakes a sleeping or idle creature; creatures fighting you or it first), bites (`attack` reach/everyMs/windupMs, damage x (1 + `damagePerLevel` x (level - 1))), uses its ability on its cooldown, regenerates `regenPctS` out of a fight.
- **Commands** (Interact 130/2): follow, stay (holds the spot, guards `stayGuardM`), attack a creature (`targetId`), come here (at once). Keys: **6** tapped sends it at the creature under the crosshair (nothing there: it heels); **6** held opens the pet wheel (attack, follow, stay, come here, pet, feed); **7** toggles stay / follow; **E** beside it pets it (emote 25, others see the crouch and hearts; one per 1.5 s). Feeding (wheel / panel; a food it likes, else any food) heals `feedHealPct`. Every letter is bound already (U is CR 028's instruments, 5 the whistle); the pet keys stand aside while you play an instrument.
- **Enemies fight back**: a pet's bites build `petThreat` on the creature (x1.6); while it beats the threat of the player the creature chases, the creature turns on the pet (`chasePet`, serial AI, winding up on the pet's position); enemy strikes and projectiles hit pets in their area (no dodges).
- **Knocked out, not dead**: at 0 health the pet is removed (Event 1205 act 4, a note), its record recovers at home for `koRecoverS` (150 s), then it comes back to you (if it is still the one out). The panel shows the recovery clock.
- **Levels**: the creature a pet bit last gives it its kill XP when it falls (`PetOutputs.XP`); `xpBase` 40 to level 2, x`xpGrowth` 1.3 per level, `levelMax` 20; health +12 % and bite +8 % per level; a level-up heals it a quarter and updates the live pet.

## Wire (cheap, event driven)

- Events **1200-1205** (range 1200-1219; 1206-1219 reserved; contracts/events.md): 1200 `pet_sync` (to you on join only if you have pets, on change, and when you step in or out of a stable: checked once a second for players with pets), 1201 `tame_calm`, 1202 `tame_progress`, 1203 `pet_refused`, 1204 `pet_note`, 1205 `pet_act` (players within 48 m). **Interact 130** `pet` (1 feed, 2 command, 3 pet, 4 feed your pet, 5 name chunks, 6 take out, 7 stable, 8 release, 9 sync, 10 dev).
- Pets are ordinary snapshot entities (budget: one per player with one out); their bites are Event 225 with `value` 0 (no spell).
- `LODESTONE_WIRE_DIGEST=1`: **identical** to main (p90_e600 `831bb7f4...`, p300_e2000 `8c29d408...`): taming is off in atlas-less worlds and bots own no pets. `BenchmarkScale/p300_e2000` (4 runs each): 86.2-88.5 vs 86.9-89.0 M cycles/tick, 133.8-134.7 vs 134.0-134.6 kbps/client, p99 3.8-4.2 vs 4.0-4.4 ms (noise; `docs/evidence/pt2-pets-bench.txt`).

## Persistence

Migration **0029** `character_pets` (character_id PK, data jsonb, epoch, updated_at; epoch-fenced like 0025): the `content.PetState` JSON (pets: id, species, name, variant, element, level, XP, health share, knockout end, tamed at, kills; the active pet, the next id, the roll count, the command mode). Written through the write-behind queue on every change (and the pet's health every 8 s while it is out). Local profiles keep the same JSON in the save blob's optional `pets` (`localsave.State.Pets`). WP16: a handoff field `pets` carries the state (with the pet's current health); the next zone puts the pet out beside you. The feats' counters (tamed, kinds tamed, shinies) live in the content state (`content.State.TamedKinds`, stats).

## Achievements and What's new

Feats (content.yaml): **Beast Friend** (tame your first creature), **Keeper of Beasts** (tame every kind: 9, title), **Glimmerfriend** (tame a shiny, title), **Packleader** (raise a pet to level 10, title; stat `petlevel` is the glue's: your best pet's level). What's new: `pt2-pets` ("Taming and pet companions").

## Client

`client/src/ui/pets` (README there): the store and decoders, the prompts ("[E] Feed Raw Meat to the mossjaw wolf · its favourite!", "It sniffs at you. It wants: ..."), the meter under the crosshair, the pet card (name, level, health, follow/stay), the pet wheel, the pet panel (Character (C) → Your pets: every pet with its level, variant, health, bite, XP, kills, favourite food, ability, rename, stable / take out, feed, stay, release; the stable indicator; how to tame when you have none), in-world effects (`PetLayer`). Models: `combat/enemies/spec.ts` `petSpec` + `models.ts` `collar` (a red collar with a gold tag; gold for a shiny; a ribbon on a slime), friendlier tint, no glowing eyes, green health bar, warm nameplate. The bestiary's `TameRow`. The petting pose (`avatarAnim.ts` emote 25).

## Tests

Go: `server/zone/internal/content/pets_test.go` (the roll deterministic and moved by the world, the character and the roll count; odds and variants near content.yaml over 20,000 rolls; an elemental takes the region's element; the favourite is faster and likelier; stats by level and variant; XP to the cap; the stable's size, ids never reused, release; JSON round trip; the tamed feats), `internal/combat/pets_test.go` (follows and warps after a fast travel, one per owner, gone when the owner leaves; never starts a fight with an idle creature; joins one, bites it down and earns the XP; the creature turns on the pet and knocks it out (reported, removed, the creature lets go); stay holds its spot; an attack order; the howl buff, the mend heal, the charge's stun; taming off reports nothing; a weakened tameable is reported once below the share; a calm creature never moves or strikes, pets leave it alone, a hit breaks the calm, Tame removes it without XP or a kill, a calm runs out), `internal/game/pets_test.go` on the official world (no food: no calm; with the favourite food a dev-weakened slime calms; feeding out of reach refused; the meter and the roll (retried if a roll fails); the pet out in the snapshot with the pet bit and "Ash's ..."; saved; a wolf's meter walked away from is interrupted and the wolf turns on you; stay / follow; no stable in the wild; a knockout sends it home and it comes back only after the recovery; the stable in a town; rename saved; a restart brings it back out; the handoff field). Vitest `client/src/ui/pets/pets.test.ts` (1200-1205 decoders and the reducer: sync, calm, the meter to tamed / interrupted / failed, refusals, notes, acts; the numbers match content.yaml; name chunks; the crosshair pick; every species builds as a pet with a collar, plain and shiny, within budget).

## Evidence

`cd client && npx vite-node src/ui/pets/dev/pet-shots.ts` (the real client and zone on the official world, one headless browser): `docs/evidence/pt2-pets-calm.png` (a dev-weakened wolf calmed, "?" over it, the feed prompt), `-taming.png` (the meter at ~60 %, hearts), `-tamed.png` (a shiny wolf tamed: the burst, the feats Beast Friend and Glimmerfriend), `-follow.png` (Fang following), `-fight.png` (Fang biting a bandit beside you, a telegraph), `-wheel.png` (the pet wheel), `-panel.png` (the pet panel), `pt2-pets-shots.txt`.

## Not covered

- Pets don't fight players (no PvP pets) and players can't hurt pets; pets take no statuses.
- Only one pet out; no breeding, saddles, or riding pets; no pet inventory.
- A pet walks through trees and boulders without player collision (as enemies do); in caves it follows by warping when it falls behind.
- Pets don't cross a zone border on their own: the handoff carries them with you (the next zone sets yours down beside you).
- No pet sounds yet.
- An account upgrade from a local profile does not copy `pets` (like the content state).
- Numbers and names are proposals (content.yaml `taming`).
