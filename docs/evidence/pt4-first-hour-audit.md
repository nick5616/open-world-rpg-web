# Playtest 4, first hour: audit of what a brand-new character sees

Before CR 051. Method: `tools/playtest/pt4-first-hour.mjs` on a private stack
(`tools/playtest/stack.mjs`), a brand-new local character, hands off the
keyboard for 200 s (a screenshot every 20 s, every visible `data-testid`
element logged as it appears or goes). Screenshots were not committed; the
log is summarised here. Tips after the first card are read from
`client/src/ui/tips` (the run never dismissed the card, as a player who does
not know what to click would not).

## What is on screen, in order

| t | what appears |
| --- | --- |
| 0 s | the loading card, then the world: a first person sword in hand, the town square, a compass with a gold diamond at the far right edge ("Tammir, farmer 50 m"), a quest tracker top right ("Slimes in the meadows / Talk to Tammir, the farmer of Draedmore"), a hotbar with a sword and three spells already slotted (Ember Flick, Frost Bite, Magma Dash) and a fourth empty slot, health and mana bars, a controls line under them ("LMB attack ... 1-4 cast, F dodge, Q form, N skills, B build"), a clock and weather chip, chat, friends, graphics and sound buttons, a voice chip ("Voice connecting..."). |
| 1 s | the note "New quest: Slimes in the meadows", the region notice "The Haven: gentle creatures only". |
| 3 s | the **Welcome to Lodestone** card, centred, over the whole scene, with a scrim. Three bullets: one shared world, "someone in town has a first job for you", Esc for controls. |
| 7 s | the town intro card ("Draedmore"), the lock hint goes away. |
| 7-200 s | nothing else: the welcome card stays up (the first tip, "Getting around", comes 2 s after the card is closed; "Your quest" at 12 s; "Townsfolk" when next to a person). Nobody calls to the player. |

## What pulls

- Nothing moves toward the player. The only pull is a diamond on the very edge
  of the compass and a line of grey text; Tammir stands 50 m away among eight
  other villagers who all look the same from there.
- The quest says what to do ("Talk to Tammir") but not why, and the person
  who needs the help does not seem to need it.

## What overwhelms

- The welcome card arrives 3 s into the first view, on top of the only moment
  the world could say something: whatever the player was about to read is
  behind a scrim.
- Eleven pieces of HUD at once, a full spell bar with spells nobody has been
  introduced to, a controls strip listing eight systems (B build, Q form, N
  skills...), a debug panel in dev builds.
- After the card: tips queue up behind the first interaction ("Getting
  around", "Your quest", "Townsfolk", then "Enemy nearby", a cliff, falling,
  night, a skill point), most of which fire inside the first quest.
- Past the first quest the Ward starts: a sunsteel seam 140 m down a shaft, a
  blueprint, a forge and a spell. Pickaxe, axe, shovel, torch, hammer,
  whistle, rod: all in the pack or one purchase away, none of them introduced
  by anyone.

## What is unclear

- Whether to click: "Let's go" is the only call to action and it does not
  go anywhere.
- Who Tammir is and which of the villagers he is.
- What the first thing to *do* is once the card is gone: the tip says "walk,
  jump, sprint".
- What any tool in the pack is for (nothing said it; the Ward's note says
  "your pickaxe" in a text line).
- What comes after the Ward: nobody said "come back later".

## What this branch changes (CR 051)

1. The mentor (Tammir, the slimes' giver) calls the new player over by name
   (Event 1930 bark) 3 s after joining, and again at 43 s if they are still
   standing nearby ("Walk up close and press E to talk").
2. The welcome card and all but four tips (moving, the quest, fighting,
   healing) wait until the slimes are handed in (or 10 minutes of play). The
   Talk tip is the mentor's to say.
3. The Ward no longer follows the slimes directly: three short errands do,
   each given by a person and aimed at one system (ore and the forge, timber
   and the hammer, the torch and a cave mouth); the Ward follows them, and
   the fish, the steed and the tower follow as offers.
