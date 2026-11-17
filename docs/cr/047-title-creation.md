# CR 047: Title cavern and character creation (playtest 3)

Branch `pt3/title-creation`. Playtest feedback: "Make a landing page that looks like gems and all that in a cave, then have the character selection/creation screen be like Valheim instead of plain like ours."

## Summary

- **Title**: the logotype over a live R3F gem cavern (`client/src/screens/stage/`): a noise-displaced cavern seen from inside, shader-only rock (colour, strata, glowing gold/copper ore veins and flecks, wet low-roughness floor patches), 30 crystal clusters in the game's five gem colours (sapphire, amethyst, emerald, ruby, topaz: `world/caves/caveVisuals.ts` table), stalactites, four fixed gem lights, light pools on the floor, soft light shafts, fog, 220 drifting motes, a slow camera drift. First paint is the logotype over a CSS cavern (no three.js, no worldgen wasm); the 3D scene is a lazy chunk that fades in over it.
- **Select / create**: the same cavern as a stage with a campfire. Your character is the game's own `Avatar` (full rig, idle animation) restyled with your look, framed by the camera, drag to turn (pointer capture only starts on the cavern, never on a panel), a slow self-turn while untouched. Characters list on the left (select, quick Play, double-click to play), Play / Delete (asks first) / New under the figure, creator on the right: name, Randomise, Create, then Build, Skin, Hair, Hair colour, Beard, Eyes. Touching the creator previews the draft on the figure; picking a character brings it back. Phones: figure on top, one scrolling sheet below.
- **Look** (`client/src/net/look.ts`): `{build 0-2, skin 0-5, hairStyle 0-5, hairColor 0-9, beard 0-4, eyes 0-5}`, all small indices (out-of-range clamps, missing falls back to the default), stored as `{"v":1,"look":{...}}`. `Avatar.setLook` (net/avatarLook.ts: shared geometry/materials per option) swaps the skin material on head, hands and mid figure, the hair mesh (6 styles: bald, cropped, swept = the original, long, topknot, mohawk) and colour, adds a beard mesh and irises, scales the whole figure by build; hair, beard and irises follow armor `hides`.
- **Fallbacks**: `?cave=0`, no WebGL, a software renderer (SwiftShader, llvmpipe: headless harnesses stay fast), a lost context or a render error all leave the CSS cavern (gradient, faceted CSS gems, a cold shaft) as the whole backdrop; phones and weak GPUs (`classifyGpu` low) get the lite tier (96 x 56 cavern, ~half the clusters, 90 motes, no shafts, dpr 1). `?cave=1|lite` force a mode (screenshots).
- **Calm**: no strobing anywhere. Gem shimmer (a slow sine, a few percent) and the light breathing are off under Reduce flashing; the camera drift, motes and flames hold still under `prefers-reduced-motion`.

## Persistence (no migration)

`POST /v1/characters` already took an `appearance` JSON object (<= 4 KB) and stored it in `characters.appearance` (account) and in the first save blob's state (`localsave.State.Appearance`, local profiles). What was missing was reading it back:

- `accountapi.Character.Appearance` (omitempty) is filled by `ListCharacters` from `characters.appearance` for account characters (the empty object is omitted). Local characters keep it in their save state; the client reads `state.appearance` (`lookOf` in AccountScreen). Characters made before this change have none and show the default figure.
- New `DELETE /v1/characters/{id}` (account service): an account character's items are released first (`items.owner_character_id` has no cascade), then the row goes (the other tables cascade); a local character's name reservation is released and the client drops its IndexedDB save (`SaveStore.deleteSave`). Another owner's id is a 404. Metric `account_characters_deleted_total{kind}`.
- Migration 0035 was reserved and is **not used**: nothing new to store.
- The character's own body in third person (`scene/LocalAvatar.tsx`) takes the look from `net/ownLook.ts`, set when the character is played.

## Replication (not in this change)

Other players still see the default figure. `EntityRecord.appearance` is the armor word: 51 bits used, and the value must stay below 2^53 (the inventory event's JSON carries the same number), so only 2 bits are free and a look needs 18. The compatible way is an appended masked field (protocol v7, CR note) `look: u32` on `EntityRecord`, set from the character's stored appearance at zone login (the zone reads `characters.appearance` / the verified save blob), sent on change and first sight like `appearance`, decoded into `RemoteView.look` and applied with `Avatar.setLook` in `RemotePlayers`. Contract, zone, codegen and the snapshot extension are a separate change with its own tests.

## Also

- The waking screen and the sign-in panel are restyled glass over the cavern (same testids). Every testid the harnesses and `infra/smoke-live.mjs` use is kept (`play`, `account-screen`, `auth-local`, `auth-dev-*`, `char-name`, `char-create`, `play-<name>` (the selected character's big Play, a quick Play on every other row), `character-list`, `signed-in-as`, `waking`, `ready`, `status`, `error`, `export`, `upgrade`, `continue-offline`). New: `select-<name>`, `char-delete`, `char-delete-confirm`, `char-new`, `look-random`, `look-<field>-<i>`, `stage-name`, `cave-backdrop` (`data-cave` = css | loading | full | lite).
- First-person hands keep the default skin tone (their meshes bake the colour).
- Evidence: `docs/evidence/pt3-title-{title,title-phone,select,create,select-phone}.png` (`node client/scripts/title-shots.mjs`).
