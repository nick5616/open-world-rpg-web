# CR 034: Visible armor (playtest 2)

Branch `pt2/armor-visuals`. Nicole: "make armor appear on characters and have that be shared client / server state, so everybody sees the same thing".

## Summary

- **Every armor piece shows on the avatar.** Head: cap, helm (an open nasal helm in iron; a closed great helm in silver, starmetal, voidglass and sunsteel, with a ridge, a crest and wings, crystal spikes or a crown of sun rays), hood, circlet. Body: jerkin, cuirass, mail, robe, each with its shoulders (leather caps, layered plate pauldrons, round pauldrons, a mantle), sleeves (short, mail, wide) and forearms (bracers, plate vambraces with an elbow cop and a flared cuff, bell cuffs), and below the belt a fauld, a mail skirt or a robe skirt. Legs: leggings with knee patches and boots, greaves (mail thighs with a cuisse plate, knee cops, faceted greaves, plated sabatons), boots. Low poly in the Valheim / Breath of the Wild style: faceted plate, banded mail, stitched leather, soft cloth.
- **Material, rarity, gem.** The material colours it (iron, silver, sunsteel with its glow, starmetal, voidglass, leather, cloth); the rarity is the accent (trim, belt buckle, cuff, crest, tabard: grey, green, blue, purple, orange, red, gold), with a soft pulsing glow from relic up and a holographic sheen for Bitchin' (strongest at grazing angles, the trim more than the plate). A socketed gem is a small glowing inlay (brow, breast, knees). Armor bases have no sockets; the dev console's gem option now gives an armor piece one socket so the inlay can be seen (cosmetic: gear stats read weapon gems only).
- **The bare body underneath is hidden** where armor covers it (the navy shirt, the arms, the trousers, the skin head and face band under a closed helm), so the outfit costs fewer draw calls than it saves.
- **Shared state.** The zone decides what you wear: it packs your three equipped armor pieces into one number, the **appearance**, recomputed only when your items change. It rides your player entity's snapshot record (a new masked field, protocol v6): sent when it changes and on first sight (a late joiner, someone walking into range, a ghost from the next zone, after a handoff or a rejoin), nothing while it stays the same. Your own body reads the very same number from your inventory event. Two browsers on a private stack (`tools/playtest/armor-shots.mjs`): the Watcher's view of the Knight carries exactly the Knight's inventory appearance (39686077724106: a mythic starmetal helm with an aquamarine, a legendary silver cuirass, rare iron greaves); unequipping all three gives 0 for both; a rejoin keeps it (local profile).
- **First person**: your forearms wear the body armor (a stitched leather bracer, a plate vambrace with the rarity's cuff, a mail sleeve under a bracer, a robe's bell sleeve), swapped only when your appearance changes.
- **New armor** (items.yaml; keys appended, none renamed): a `cloth` material (appended: material codes never move), Traveller's Hood, Woven Robe, Travel Boots, Iron Mail Hauberk, Silver Circlet, and a forged sunsteel set (helm, mail, greaves: recipes and blueprints appended, so recipe ids stay; random loot never rolls sunsteel, as for weapons). Every armor piece names its `style` (validated by the generator per slot).

## The appearance

`server/zone/internal/game/appearance.go`, twin `client/src/combat/armor/appearance.ts`:

```
per slot s (0 head, 1 body, 2 legs), at bit 17 * s:
  bits 0-5   visual id: 1 + the piece's index among items.yaml armor (0 none)
  bits 6-9   material code (1 + index in items.yaml materials, as the weapon look)
  bits 10-12 rarity (0 common .. 7 Bitchin')
  bits 13-16 gem: 1 + index in items.yaml gems of the first socketed gem (0 none)
bits 51-63 zero (below 2^53: exact in JSON and JS numbers)
```

Both sides test one shared vector (an iron helm, relic, ruby + a Bitchin' cloth robe = 1017261316). The material is redundant with the item today; it is carried so a future dye or reforge can change it without a protocol change.

## Wire and server

- **protocol.yaml v6**: `EntityRecord.appearance: u64`, the 16th (last) bit of its u16 mask. A v5 client cannot skip it, so the version bump kicks old clients (`version_mismatch`) as for every protocol change.
- **Zone** (`items.go applyGear`): `Entity.Appearance = AppearanceOf(inventory)` whenever the inventory version moved (also without combat); `quantize` copies it into the snapshot state. Event 400 gains `"ap"` (omitted when 0).
- **Snapshot encoder** (`server/pkg/snapshot`): `EntState.Appearance`, diffed and applied like every field. The baseline frames' compact state (`encEnt`) holds it as an interned u16 (`LookID`, like names) in what was two bytes of padding: still 40 bytes (a test pins it), the fingerprint covers it, and an entity wearing nothing costs no lookup. Past 65,534 distinct outfits in one zone process a new one gets an overflow id that always compares as changed (re-sent while due: correct, a few bytes dearer; not reachable in practice).
- **Ghosts and presence** (`cluster.go`): after the gone list, an optional section `u16 n + n x (u32 id, u64 appearance)` lists only the records that wear something. A frame with nobody armored is byte-identical to before (tested), and a zone built before CR 034 stops reading before it, so the frame version is unchanged. This is the inter-zone bus, not the client wire.
- **Handoff and rejoin**: the inventory travels (handoff) or is restored (account DB, local save), and `applyGear` recomputes the appearance from it before the first snapshot shows the player there.

## Client

`client/src/combat/armor/`:

- `spec.ts`: appearance -> model spec: named parts each on a rig bone (`neck`, `torso`, `body`, `shoulderL/R`, `elbowL/R`, `hipL/R`, `kneeL/R`), which bare meshes it hides, the finish (material surfaces, rarity trim, gem), the far tint and the mid silhouette kind.
- `model.ts`: the parts lofted with the weapons' mesh builder (vertex colour + `surf` metal/rough/glow). **Full rig: the whole outfit is ONE skinned geometry**, each part built in its bone's frame and bound rigidly to it (skinIndex = the bone, weight 1): one draw call whatever it covers. The avatar adds an identity `THREE.Bone` to each joint group (created on first armor), binds a `SkinnedMesh` with identity inverses, and sets a fixed cull sphere. **Mid LOD** (25-80 m): one static silhouette mesh on the capsule (helmet shape, body and leg colour, pauldrons). **Far LOD**: the box takes the outfit's colour (one shared material per colour). **First person**: the sleeved forearm. Geometry is cached per appearance and shared by every avatar wearing it (built once, disposed when the last wearer takes it off); `setAppearance` runs only when the number changes.
- `material.ts`: one MeshStandardMaterial (vertex colours, per-vertex metal/rough from `surf`, the weapons' sky reflection and clock), the graphics-style hooks (toon bands, rim, retro snap) like every lit material, glow (`surf.z > 0`) and holo (`surf.z < 0`). Its plain and skinned programs are in the WP19b warm-up (`world/warmExtras.ts`).
- `fp.ts` (the view model's forearms, from `FirstPersonWeapon`), `own.ts` (your appearance from the inventory store).
- `net/avatar.ts setAppearance`, `snapshotDecoder` / `interpolation` (`RemoteView.appearance`), `scene/LocalAvatar.tsx` (your body: the inventory's `ap`), `RemotePlayers` (`__lodestoneAvatars` reports it).

Draw calls at the full rig (the bare rig is 12-13): a closed helm, a body piece and leggings or greaves hide 11 bare meshes and add 1 (what is left: the two fists, the weapon and the outfit); a cap or circlet alone adds 1. Triangles: 1,856-2,848 per full outfit (every head x body x legs combination, with gems), at most 225 for the mid silhouette.

## Cost

- **Client wire**: 8 bytes in a player's record when their armor changes and on first sight; nothing per tick. Nothing at all for a player wearing nothing.
- **`LODESTONE_WIRE_DIGEST=1`**: the G5 scale scenario's bots wear nothing, so every byte count is identical (p90_e600 21,071,668 bytes, p300_e2000 55,563,662). The hashes differ only by the protocol version number in Hello/Welcome (5 -> 6): with the version constant set back to 5 they are identical to main (p90_e600 `831bb7f4...`, p300_e2000 `8c29d408...`).
- **Zone**: `AppearanceOf` once per inventory change; `LookID` (a read-locked map) per armored entity per tick in the History store, none for the rest.

## Tests

- Go `server/zone/internal/game/appearance_test.go`: the encoding round-trips over random outfits, every armor piece has a visual id, style and material, below 2^53, the shared vector; replication in-process (dev give+equip of three pieces: the observer's snapshot carries the zone's number and the owner's inventory `ap` matches; while unchanged no record carries it again; a late joiner gets it on first sight; unequipping the helm clears that slot for both); ghost and presence frames carry it and a frame with nobody armored is byte-identical; across a two-zone handoff the new zone recomputes the same appearance and the old zone's ghost of the player carries it to an observer there.
- Go `server/pkg/snapshot/appearance_test.go`: `encEnt` is 40 bytes; first sight sends it, unchanged ticks never do, a change does, decoder and encoder frames agree; `LookID` interning and the overflow id.
- Vitest `client/src/combat/armor/armor.test.ts`: the appearance number (the zone's vector, bigint input, inventory items); for **every armor item in items.yaml** at common, relic (with a gem) and Bitchin': parts have builders and sit on their slot's bones, the finish (no rarity glow on common, glow from relic, holo for Bitchin', sunsteel glows), the hidden bare parts, one skinned geometry with every vertex on a real bone, the mid silhouette, the first-person sleeve for body armor; an avatar: one skinned outfit on 13 bones, fewer draw calls than bare, rebuilt only on change (20 frames: no rebuild), a second wearer shares the geometry, the helm at head height and the greaves on the legs (skinned positions), taking it off restores the bare rig and the last wearer frees it; mid LOD silhouette and far tint; first-person forearms dress and undress. `net.test.ts`'s reference encoder covers the new field.
- Evidence: `docs/evidence/pt2-armor-observer.jpg` (the Knight's own third person beside the Watcher's view from the front), `pt2-armor-back.jpg`, `pt2-armor-fp.jpg` (first person), from `tools/playtest/armor-shots.mjs` on a private stack (`node tools/playtest/stack.mjs --zone-env LODESTONE_ZONE_DEV=1`); `pt2-armor-gallery.jpg` / `-gallery-back.jpg` / `-gallery-side.jpg` (every style and material, rarities, a swing), `pt2-armor-fp-sheet.jpg`, `pt2-armor-lod.jpg` from the rig lab (`node client/scripts/armor-shots.mjs`).

## Contract changes

- protocol.yaml v6: `EntityRecord.appearance` (u64).
- items.yaml: `materials.cloth` (appended), armor `style` (cap, helm, hood, circlet / jerkin, cuirass, mail, robe / leggings, greaves, boots), eight armor items, three recipes (appended).
- contracts/events.md: Event 400 `ap`; the "Players" paragraph documents the appearance. No new Event kinds, constants or migrations.

## Known gaps

- Armor bases still have no sockets (only dev gems inlay); a later CR can give armor sockets and gem stats.
- The rig has no feet: boots and sabatons add a foot under each shin. Legs swing through a robe's skirt at full stride (rigid parts, no cloth simulation).
- A local profile's blob is re-issued at most every 5 s (explore.go `localSaveEvery`, pre-existing): an equip change in the last seconds before leaving waits for the next change or the 30 s checkpoint; the two-browser script makes one more change before it rejoins.
