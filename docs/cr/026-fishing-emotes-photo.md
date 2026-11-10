# CR 026: Fishing, emotes and photo mode (playtest 2)

Branch `pt2/fishing-emotes-photo`. Nicole: "all sorts of good shit" (inspirations: Valheim, Breath of the Wild). Three self-contained features; photo mode is client only.

## Summary

- **Fishing**: a fishing rod (`tool:fishing_rod`: general and tool merchants, or forged from a copper ingot); E at deep water casts; the float bobs, false nibbles, then the bite (strike within 1.2 s); the reel fight is a tension minigame; 14 species by water (lake, river, sea), biome, hour and weather (6 common, 4 uncommon, 2 rare, 2 legendary); 13 new hearth recipes; a Fish journal tab; four feats.
- **Emotes**: 10 emotes on a wheel (hold H) or `/emote <name>`, posed on the avatar rig, sent to players within 48 m; first person gets a camera nod and a hand gesture.
- **Photo mode** (L; P is the camp menu, CR 025): a free camera clamped around the player, no HUD, style and time-of-day preview, depth of field / vignette / grain, PNG shots. Nothing on the wire.

## Contract changes

- **contracts/content.yaml** (CR 023's data file): new sections `fishing` (rod, cast range, depth, bite window, rate limits, rarities, 14 species with water/biomes/time/weather/weight/fight/habitat/lore) and `emotes` (seeM, burst, everyS, 12 emotes: ids 1-10 the wheel, 20 and 21 the zone's fishing poses); feats `first_catch`, `angler`, `fishwise`, `tall_tale` (new feat stats `fish`, `fishspecies`, `fishlegend`; appended, title ids unchanged). Generator checks (`contracts/codegen/lib/content.mjs`): items exist and are `fish:` items, rarities, waters, biomes, times, weather, fight ranges, emote ids unique and < 32.
- **contracts/items.yaml**: category `fish` (kind material, stack 20), 14 `fish:*` items, `tool:fishing_rod`, 13 foods/potions; recipes appended (`forge_fishing_rod`, 12 `cook_*`, `brew_moonlit_tonic`): existing recipe ids unchanged.
- **Events 1080-1099** (new range): 1080 `fish_cast`, 1081 `fish_hooked`, 1082 `fish_caught`, 1083 `fish_lost`, 1084 `fish_refused`, 1090 `emote`, 1091 `emote_refused` (contracts/events.md).
- **Interact 88 `fishing`** (1 cast, 2 hook, 3 land, 4 lose, 9 dev rod) and **89 `emote`** (1 play, 2 stop).
- **Persistence**: no migration. Fish records ride the CR 023 content state (`character_content` jsonb; `content.State.Fish`: species -> [landed, best g]; `Stats.fish/fishlegend/casts`); fish go into the inventory like any item. Event 1000 gains `fish`.
- Zone env `LODESTONE_ZONE_FISH_FAST=1` (evidence and tests: bites after ~1.5 s, no nibbles).

## Server authority

The zone rolls the catch at the cast (`content.RollCatch`, seeded by world seed, character, the character's persisted cast count and the bobber's 4 m cell), classifies the water from the atlas NODEP flags (river, lake, sea; `combat.AtlasInfo.NodeFlagsNear`), and keeps the species until the fish is landed. A hook before the bite spooks the fish; after the window + 700 ms latency slack it is missed. A landing sooner than the fastest possible fight (`content.FightMinMs` = 1250 ms x stamina, by the zone's clock and the client's fight ms; client/src/ui/fishing/minigame.ts can't win faster) loses the fish. Casts: 1.5 s cooldown after each outcome, a 6-cast burst then one per 4 s, on top of the Interact limiter. Walking 3 m from the cast ends the line.

Emotes: a token bucket per player (3, then one per 1.5 s), wheel ids only (20/21 are the zone's), not while downed, climbing, gliding or swimming.

## Network budget

Event driven; nothing per tick. An emote is one Event to each player within 48 m. A looping emote (sit, dance, rest, a line in the water) is re-checked once a second only for the players holding one (newcomers within range are told once). Fishing sends 3-4 Events to the angler per cast. The scale scenario's bots never fish or emote: `LODESTONE_WIRE_DIGEST=1` unchanged.

## Known gaps

- The account upgrade (local profile -> account) does not copy content state (as CR 023), so fish records stay with the profile.
- Ghost-band players on a neighbouring zone (WP16) don't see emotes across the border; a handoff drops a line in the water.
- Remote anglers' floats don't show the bite or the fight (only the line and the pose); the client draws its own float's fight.
- Names and texts are proposals for Nicole (contracts/content.yaml).
