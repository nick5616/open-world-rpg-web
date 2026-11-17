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

## Replication (follow-up commit)

`EntityRecord`'s u16 mask is full (bit 15 is `appearance`) and the armor word has 2 free bits under 2^53 against the 18 a look needs, so a masked `look: u32` could not be appended compatibly (widening the mask would break every older client). The look rides the existing Interact + Event path instead, so **no protocol version bump** and older builds are unaffected (an old client never asks and ignores Event 1900; an old zone ignores Interact 91):

- The zone reads the stored appearance once at login (account: `characters.appearance` through `PGStore.LoadAppearance`; local profile: the verified save state's `appearance`) and packs it (`PackLook`, 19 bits: bit 18 marker, then build, skin, hairStyle, hairColor, beard, eyes) into `exploreState.look`. Zone handoffs re-run the same login path.
- **Interact 91** `look` (action 1, targetId = a player's entity id): the zone answers the asker alone with **Event 1900** (`entityId` = the player, `value` = the packed look). Nothing is sent for a player with no stored look, an unknown id or a non-player. Rate limited per session (24 then 6/s). Nothing per tick.
- The client (`net/remoteLooks.ts` `LookBook`, used by `RemotePlayers`) asks once when an avatar appears, retries up to 3 times 4 s apart, applies the answer with `Avatar.setLook` and forgets leavers. Contracts: `contracts/events.md` (range 1900-1909, Event 1900, Interact 91).
- A player seen only as a ghost from another zone keeps the default figure until they are in this zone (only the owning zone knows the look).
- First-person hands, the armored forearm sleeve and the offline arms use your chosen skin tone (`ownSkinHex()`, read when the hand geometry is first built, so a character switch needs a page reload to recolour them).

## Also

- The waking screen and the sign-in panel are restyled glass over the cavern (same testids). Every testid the harnesses and `infra/smoke-live.mjs` use is kept (`play`, `account-screen`, `auth-local`, `auth-dev-*`, `char-name`, `char-create`, `play-<name>` (the selected character's big Play, a quick Play on every other row), `character-list`, `signed-in-as`, `waking`, `ready`, `status`, `error`, `export`, `upgrade`, `continue-offline`). New: `select-<name>`, `char-delete`, `char-delete-confirm`, `char-new`, `look-random`, `look-<field>-<i>`, `stage-name`, `cave-backdrop` (`data-cave` = css | loading | full | lite).
- Evidence: `docs/evidence/pt3-title-{title,title-phone,select,create,select-phone}.png` (`node client/scripts/title-shots.mjs`).
