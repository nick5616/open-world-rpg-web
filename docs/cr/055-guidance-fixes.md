# CR 055: Guidance fixes (people speak in the world, named pins, an Info tab, toast bars)

Playtest 5 (branch `pt5/guidance-ui`). Three items from Nicole:

1. "How does Tammir know directly about the controls? It should toast the controls after exiting the conversation with Tammir."
2. "Marking on your map didn't work for pointing out where the horse stables are. Could also be under an info tab in the journal."
3. "Tip toasts should have a linear progress bar along the bottom that shows how long you have to look at them."

New wire: Interact 185 `place_pin`, Events 1980 `place_marked` and 1981
`place_refused` (range 1980-1989; contracts/events.md). Event 605 (pins) now
carries a label for personal pins in the field that was empty for them. No
migration (pins live in the JSON of `character_progress.pins`; 0035 unused), no
protocol or yaml change.

## 1. People speak in the world

Every line a giver says, and the journal text that stands in for it, no longer
names a key or a control (`server/zone/internal/quests/errands.go`, `content.go`,
`game/errands.go`, `game/dialog.go`): the slimes quest and its notes, the six
errands (ore, timber, torch, pond, steed, tower), the Ward's notes, the mentor's
second call and the smith's "the forge is just there". "Take the torch, light it"
rather than "key 8"; "blow it in the open" rather than "H" (H is the emote wheel;
the whistle was always key 5, so the old line was also wrong).

`quests/inworld_test.go` builds every errand (with and without the talk step),
the slimes quest and the Ward (with and without a shaft or a shrine) and fails
on "press", "[E]", "key", "hold E", "click", "(G)", "key 8", "1-4" and the like
in any offer, step text, note or line.

The controls move to the client, read from the live bindings:

- `client/src/ui/tips/controlTips.ts`: each control (attack, spells, dodge,
  draught, interact, torch, build, whistle, camp, pack, map, journal, glider,
  guide) names the handler file and key code it is bound to in
  `input/bindings.ts` (movement from the key map); the keycaps are looked up
  there, so a rebound or moved key shows as such (test: the bindings entry is
  changed and the toast follows). Groups: what you were just told (START per
  quest key: the slimes, mining, timber and the hammer, the dark mouth, fishing,
  the steed, the tower) and what to do with the reward (DONE: wear the cap, wield
  the sword, lay out the bedroll, cook the fish, open the map).
- `controlLink.ts` watches the conversation (read-only on `useDialog`; nothing in
  `ui/dialog` is touched) and the quest log: a quest that moves on from its talk
  step, or is accepted inside a conversation, or is handed in, since the
  conversation began (2.5 s of lead for a log that arrives just before the first
  line, 4 s of grace after it closes for one that arrives just after), toasts its
  group when the conversation closes. Once per character (localStorage), never
  while tips are off.
- `ControlToasts.tsx`: a card in the tips' slot (keycaps, a line each, a close
  box, a bar). Tips wait while it is up.

Checked the other givers: the smith, guard, innkeeper, merchant and bounty keeper
errands, the Ward and the dialog's own persona lines had the same problem only in
the errand and quest text above; the rumour, topic and greeting lines
(`server/zone/internal/dialog`) name no keys.

## 2. Marking the stables

Reproduced in the real client (`tools/playtest/pt5-stables.mjs`): a merchant's
rumour about a steed merchant, "Mark it on my map", note "Marked on your map:
Kudrogair". The pin was set on the server, saved, sent (Event 605) and drawn,
so "didn't work" was this: an anonymous purple drop on blank "Unexplored" paper
(the stables are in a town you have not found, so the map shows nothing else
there), no name on the map, no name on the compass (an unlabelled triangle and
"289 m"), indistinguishable from a pin you dropped by hand, and nothing to lead
you there (the wisp's key goes to the tracked quest first).

Fixed:

- Pins carry a name. `explore.Pin.Label` (JSON, `omitempty`; old saves load),
  `SetLabeledPin`, `ClipLabel` (48 bytes); the pins Event's name field carries it
  for personal pins (party pins keep the owner). A conversation's mark names the
  place by what it is: "Stables, Kudrogair", "Tower, The Spire", "Fishing spot".
  Moving a pin by hand drops the name.
- The map draws the label beside the pin and names it on hover; the compass shows
  it; `pinName` is the one place that decides.
- `world/guide/guideStore.ts`: `guideTo(x, z, label)` ("Guide me"), and a place a
  conversation or the journal just marked (Events 1913 and 1980, `ui/map/placeMarks.ts`)
  is what the guide key leads to for two minutes, before the tracked quest.
  Marking from the journal says so in the guide's line ("Marked: ... Press . and a
  wisp leads you there", the key from the bindings).
- Interact 185 / Event 1980: the journal marks a service. The client sends the
  place (packed like Interact 11) and `arg` = settlement | kind << 16; the zone
  names the pin "<Service>, <Town>", checks the place is within the town's radius
  + 160 m (a shrine or tower: within 900 m of its centre), places it through the
  same `placePin` a conversation uses, and answers 1980 + 605, or 1981 with the
  reason. Marking a place already marked answers 1980 with slot 255 so "Guide me"
  still has its place.

### The Info tab

`ui/quests/townInfo.ts` (pure, tested) and `InfoTab.tsx`, the journal's second
tab. For each town you have found (its atlas site is in your discoveries, or you
stand in it), from the towns buffer and the atlas sites: stables (the general
merchant, who sells the spirit whistle, as the zone's rumour says), smith (the
forge, else the blacksmith), inn, storage (the storehouse), bounty board,
every merchant with what they sell, and the nearest shrine and tower within
900 m. Each row: distance and direction, "Mark on map" (becomes "On your map"),
"Guide me" (closes the journal and starts the wisp). `useMapWorld` now carries
the towns buffer.

## 3. The toast bar

One component (`ui/toast/ToastBar.tsx`): 3 px along the bottom edge, drains
linearly over the toast's remaining time (CSS animation with a negative delay, so
a toast already part-way starts part-way). Hover on a `.ls-timed` toast pauses
the bar (CSS) and, where the toast keeps its own clock, the clock too (tips and
controls toasts shift their start while hovered). `prefers-reduced-motion`: the
bar steps down in eight jumps. On: tips and first-hour tips, controls toasts,
quest notices (the immersive HUD's shorter time is respected: `noteTtl`),
exploration toasts (discovery, tower, level...), combat toasts ("Dodged!"), loot
toasts, the guide's line. Not covered: the dialog's "why it ended" toast (it is in
`ui/dialog`, which another branch owns; one `<ToastBar>` line when that lands) and
the large discovery intros (not timed readables).

## Tests

- Go: `quests/inworld_test.go`; `explore/pinlabel_test.go`;
  `game/guidance_test.go` (Interact 185: names, saves, again, far, no town, bad
  kind); `game/dialog_pinlabel_test.go`; the dialog mark test checks the label.
- Client: `tips/controlTips.test.ts` (keys from the bindings, a rebound key,
  changes, the link on the stores, once per character, grace, tips off, expiry,
  hover), `toast/toastBar.test.ts`, `quests/townInfo.test.ts`,
  `map/placeMarks.test.ts` (label on the wire, the wisp's place), the Go pin
  vectors in `map/map.test.ts`.
- Real client: `tools/playtest/pt5-guidance.mjs` and `pt5-guide.mjs`,
  `docs/evidence/pt5-guidance-*.jpg`.
