# CR 049: Dialog (talking to townsfolk)

Playtest 4 (branch `pt4/dialog`). Nicole: "I load the game and idk what to do... nothing pulling me... make NPCs more lively, and have dialog."

Talking to a townsperson was one canned line in a side panel. It is now a conversation that pulls you into the world: people have temperaments and backstories, remember you, tell you about real places nearby and put them on your map, and offer quests inside the conversation.

## Wire

- **Interact 180 `dialog`**: `targetId` = the NPC's entity id. Action 1 open (same reach as talk, `npcReachM` 6.5 m), 2 choose (`arg` = the choice id of the last node), 3 close. Interact 30 talk still works unchanged for old clients and tests.
- **Event 1910 `dialog_node`** (JSON: the NPC, the line, a mood hint, the choices `{id, text, kind}`, an optional rumour, quest offer, note, their warmth to you), **1911 `dialog_end`** (you closed it, walked away, idle 90 s, they are gone, goodbye), **1912 `dialog_refused`**, **1913 `dialog_mark`** (a rumour's place became a pin). Rows in `contracts/events.md`. No new protocol messages, no migration (see Memory).

## Words: `server/zone/internal/dialog` (pure)

No clocks and no randomness beyond hashes of ids. `Person` (who), `Context` (the world as this player meets it), `Memory` (what the player remembers of this person), `Site` candidates (real places) in; a `Node` (line + choices) out.

- **Persona** (`persona.go`): a temperament (warm, gruff, nervous, cheerful, weary, gossipy, wry, proud; weighted by role and by hall), a quirk, a family, where they came from, what they want, a confidence. All drawn from pools by `hash(npc id, town, role)`, so two people in one town rarely sound alike. Dwarven halls draw from their own pools (and keep `npc/talk.go`'s `dwarfLines` for the legacy talk).
- **Key characters** (`keys.go`): hand-written, consistent with docs/decisions/0024-main-story.md. The glue decides who they are from the quests and story that already name them: the keeper of the Haven's inn (Ulus on the official world, Act I), whoever gives "Slimes in the meadows", the Haven's blacksmith (the Ward, sunsteel) and bounty keeper, the Act IV captain, the Act V master smith. Names are generated with the world, so the lines say `{me}`.
- **Greeting** (`lines.go`): first meeting versus met before (they use your name once met), then one thing they notice, rotating with how often you have talked: night and a town defense, weather, time of day, your level and gear, your deeds the zone knows (a camp that went quiet nearby, a tower you attuned, a vault you found, the Deep Warden's fall, the story act, the Hush silenced), a world event happening now.
- **Topics**: their work (shop, bounties, rest, forge) opens the usual services; "Heard anything interesting?" (rumours); "Tell me about this place" (settlement, region, nearest neighbours with distance and direction); "Who are you?" then, as they warm to you, family (affinity 1), where they are from (2), what they hope for (4), a confidence (7).
- **Rumours** (`rumour.go`): a real nearby place the player has not done and has not already been told about, nearest first with a role bias (blacksmiths talk caves and shafts, guards bandits, farmers herbs and water, innkeepers events and towers) and a per-person jitter so two people point at different things. Kinds: cave, mineshaft, dwarven camp or stronghold, bandit camp, tower not attuned, sky island, sky palace, Depths shrine, sealed vault, herb patch, fishing water, steed merchant, a world event, landmark. "Mark it on my map" sets a personal pin (free slot, else the last), which shows on the map and the compass.

## Glue: `internal/game/dialog.go`

- **Quest offers and talk steps play inside the conversation, generically.** Opening a dialog runs the old talk (`questsTalk`, `contentTalk`) with a capture on the session's `sendEvent`/`sendEventTo`: Event 800 lines and 951 offers are collected instead of sent, then played first as nodes ("Go on." / "I'll do it." / "Not now."). Whatever quest system makes an offer on a talk (starter, side, story, the first-hour agent's short quests) shows up in the dialog with no per-quest code; the offer card still works for the board and as the fallback for old clients. Accepting goes through the normal `questInteract` (`Interact 60/1`).
- **World** (`dialogContext`, `dialogSites`): weather at the NPC, the world clock, level, gear tier (wielded weapon and armour rarity), atlas sites near the NPC (3.2 km) with the character's discovery, attunement and vault state, camp groups currently down, herb patches, water, the nearest town with a general merchant (steeds), active world events.
- **Hold**: while anyone talks to an NPC (`dlg.held`), `townsTick` skips `w.Step` for that NPC and turns it toward the talker; released on close, when the player walks more than reach + 3 m away, after 90 s of silence, on leave, or when the settlement deactivates. Several players may talk to one NPC. Cost: one map length check per tick while nobody talks; a 2 Hz check over open conversations.
- **Memory**: per character per NPC: met, talks, affinity (a new day +1, a new topic +1, a finished request from them +3), topics and rumours heard (capped at 48). Stored in the character's content state JSON (`content.State.Dlg`, `"dlg"`), which already persists through `character_content`, a local profile's save blob and the WP16 handoff, so **migration 0035 is not needed** (left unused).

## Client: `client/src/ui/dialog/`

`DialogOverlay` (lower third, typewriter, numbered answers, dimmed HUD, framing bars), `camera.ts` (eases the view to the face; back after), `voice.ts` (a quiet synthesized murmur through the UI bus with a per-NPC pitch), `link.ts` (the controller: Interact 180, npcFocus `setTalkingTo` / `setSpeaking` / `say`, services open in `townHud.ts`'s panels while the conversation waits and come back when they close), `offline.ts` (solo fallback), `store.ts` (pure reducer, key map, typewriter timing). Keys 1-6 pick, E / Space / Enter / click skip then go on, Esc leaves (panel stack). New keys are in `input/bindings.ts` (context `dialog`) and the Controls page. `PlayerController` calls `dialogCamStep` once a frame; `lookRouter.blockMove` stands you still while it is open.

## Alternatives rejected

- A scripted dialog tree per NPC: too much writing for ~hundreds of people; a persona + topic engine gives variety and hooks into live world state.
- Sending offers as separate events from the quest systems: every quest system would need dialog code; capture at the transport keeps one seam.
- A new table for memory: the content state already has save, local-blob and handoff paths.
