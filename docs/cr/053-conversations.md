# CR 053: Conversations revamp (a dialogue box, answers in your voice, checks, goodbyes, bubbles)

Playtest 5 (branch `pt5/dialog-revamp`). Nicole: "revamp NPC conversations entirely. Like make it dialogue boxes, speech bubbles, and have conversations to exit. Take inspiration from the Fallout games."

CR 049 gave townsfolk temperaments, memory, rumours and quests inside the talk, but it still read like a menu: a light lower third, numbered labels ("Goodbye."), Esc as the usual way out. This CR keeps all of its engine and turns the talk into a conversation: a framed box with a transcript, answers that are things you say, answers that depend on who you are, a goodbye the person answers, and speech bubbles that nearby players see too. The inspiration is Fallout's mechanics (skill-gated lines that unlock or refuse, a way out on every screen, the words you chose in front of you), not its art or UI; the look is Lodestone's own (parchment and amber, a serif voice).

## Wire (see contracts/events.md)

- **Interact 180** keeps its sub-actions (1 open, 2 choose, 3 close); no new Interact. Choosing now also covers a check answer, a haggle over a quest's purse and the goodbye. 3 is the "walk away" path (Esc), not the normal ending.
- **Event 1910 `dialog_node`** gains per choice `tag` (the bracket in front) and `low` (a check you do not meet), and per node `check` (`{tag, pass}`, the check the line answers) and `bye` (the farewell: `choices` is `[]`). A node has at most 6 answers and the last is always `kind: leave` (except the farewell).
- **Event 1911 `dialog_end`**: value 1 (walked away) is now past 8 m (was reach + 3 = 9.5 m); value 4 (goodbye) follows the farewell node.
- **Event 1960 `dialog_say`** (range 1960-1969): a player's chosen answer, to the players within 20 m of them and to them. The text is the zone's (the choice it holds), a client cannot make one up. The person's own line reaches those players through the existing Event 1930 `npc_bark`; the talker's own box already carries it. Cost: events only on a choice or a node, to the few players within 20 m. No migration.

## Answers in your own voice

Every answer is a sentence your character would say, in its own words ("Heard anything strange lately?", "I could use some work.", "Show me what's on the anvil."), with a short tag in front where it helps: `[Leave]`, `[Quest]`, `[Barter]` (opens the shop), `[Rumour]`, `[Work]` (the bounty board), `[Mark]` (pins a rumour's place on your map: the `mark` semantics are untouched), `[Rest]`, `[Forge]`.

## Checks

A check is a tag that depends on your character. `internal/dialog/checks.go`:

| Tag | Passes when | Pass unlocks | Fail |
| --- | --- | --- | --- |
| `[Mage]` (Knight, Lancer, Archer, Mage; the class of the weapon in your active loadout, a class each person asks for) | you are that class | a line of lore for your kind of fighter (three per class) | "Wrong shoulders for it." (in the person's temperament), tag dimmed "too low" |
| `[Warmth ♥♥♥]` (2-4 hearts, by temperament: warm and cheerful folk 2, gruff and proud 4) | the hearts shown on their name (a heart is 2 affinity) | at a shop: **10% off** their wares for 10 minutes; elsewhere a **secret rumour** (vaults, shrines, palaces, dwarven halls, sky islands, towers) with `[Mark]`, then the confidence they have kept | refusal |
| `[Level 10]` (5, 8 or 10 by person, +3 for guards and bounty keepers) | your level | a **dangerous place** (bandit camps, shafts, shrines, vaults, palaces) with `[Mark]` | refusal |
| `[Sunsteel]` (only people who work a forge) | an ingot or a sunsteel weapon in your pack | forge lore and **15% off** | refusal |
| `[Level 6]` under a quest offer that pays gold | your level | a **25% bonus** (at least 5 gold) paid once on accepting that quest | refusal; one haggle per conversation |

Failing a check never ends the conversation: they refuse in character and the topics come back. A refusal line exists for each of the eight temperaments and each check, so a gruff smith and a nervous baker do not refuse the same way. The discount is applied where the shop prices are made (`waresFor`), so the shop panel and the buy path agree. The check is evaluated by the zone when you choose (the client only draws the tag), and which checks a person offers rotates with how often you have talked.

## The way out

- **Every node has one**: `dialog.Finish` (called on every node by the glue, idempotent) tags the answers and makes sure the last of at most six is a goodbye, giving up a lesser answer if the list is full. Quest offers, "go on" lines, rumours, check results all go through it. Tested over 40 people x 7 roles x 7 key characters x 3 worlds x 3 memories x every topic.
- **Goodbyes** are your voice ("Take care.", "I should go.", "That's all for now. Thanks.", role lines like "Keep the fire hot.") and rotate between visits. Choosing one sends a farewell node (4 per temperament) with no answers; the zone closes the box once it has been readable (1.8 s plus 45 ms per character, at most 5 s), with Event 1911 value 4. E, a click or Esc during the farewell closes at once. Esc at any other time is "walk away" (value 0), kept for the panel stack.
- **Walking away** (more than 8 m) ends it with a parting line the person calls after you as an Event 1930 bubble ("Oh. Leaving mid-sentence. Bold."). Idle for 90 s still ends it quietly.

## The box (client `ui/dialog/DialogOverlay.tsx`)

A framed box at the bottom: the speaker's name, role and town, their warmth to you as hearts, a "Walk away (Esc)" button; a scrollable transcript (their lines and yours, kept for the whole conversation, newest at the bottom, 60 lines); the current line typing out (E, Space, Enter or a click skips; a number key during the typing skips it first), a chip when their line answers a check (`[Mage] passed` / `[Level 10] too low`), the quest card and the mark note as before; then the numbered answers with tinted tags (a failed check is struck through and says "too low"). It scales with one unit `--u` (1 px at 1280x720, up to 2 px, never below 1), so it reads from small windows to 4K. The conversation camera aims a little below the face (`dialogCam.lift`, 0.1 rad) so the face sits above the box. The HUD still dims. A soft two-note chime plays as the box opens (rising) and closes (falling) on the UI bus (`voice.ts dialogChime`).

## Speech bubbles

- **Theirs**: the line shows over their head (existing `npcFocus`), now cut at a sentence when long (the box has all of it), bigger on large windows. Players within 20 m other than the talker see it as a bark.
- **Yours**: the answer you choose is a bubble over your avatar for you (third person) and for players within 20 m, drawn in a cool italic style so it reads as a person and not an NPC. `BubbleLayer` got a `player` kind; `RemotePlayers` draws it from the avatar position (yours from the local view); `npcFocus.ts` has `playerFocus`.

## Content

New per-temperament pools (eight temperaments, so two townsfolk rarely sound alike): service lines (shop, board, rest, forge), "what else?" lines, small talk (a new "How are you holding up?" topic, worded for the role: "How's business?", "Quiet watch?", four lines each), pass reactions, refusals, parting calls, four farewells each (was two). A test asserts no line is spoken by two temperaments.

## Memory, migrations

Memory is unchanged (`content.State.Dlg`); new topic keys (`t:chat`, `t:ck-*`, `t:haggle`, `t:secret`) go in the same list. **No migration**: 0036 is unused.

## Gaps

- The `[Level 6]` bonus is paid once per quest id (the reward marker is per quest id and per character), so a repeatable bounty pays it the first time only.
- Class is read from the weapon of your active loadout (there are no classes in the game); swapping loadouts changes which `[Mage]`-type line you see.
- Your own bubble is not seen in first person (the camera is in your head); it shows in third person and for everyone else.

## Alternatives rejected

- Sending the check result from the client (a tag the client computes): refused, the zone owns the truth and the gate.
- Letting the farewell be a client timer: kept the server timer so a dropped client cannot leave the NPC held; the client can still close early.
- Changing quest rewards inside the quest system: the quest code is shared with other branches; the haggle pays its bonus through the ordinary quest grant instead.
