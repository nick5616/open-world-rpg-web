# client/src/ui/story

The main story, "The Last Song", and the endgame in the browser (playtest 2,
CR 035; design: `docs/decisions/0024-main-story.md`). The zone owns the story
(`server/zone/internal/story`, `internal/game/{story,finale,revive}.go`); the
acts are ordinary quests (kind 3, "Main story"), so the tracker, journal,
map and compass show them like any other. This folder adds what is the
story's own.

| File | What |
| --- | --- |
| `events.ts` | Events 1600-1612, Interact 140, the JSON types, small wording helpers |
| `store.ts` | zustand: your story (1600), your party's progress (1601), the finale (1603, 1604), the ending (1605), lines (1606, 1607), revives (1610-1612); `reduceStoryEvent` is pure |
| `link.ts` | Hooks the live session (NetPlay calls `ensureStoryHook` before Hello); an act's title card goes through the discovery intro queue (`ui/intro`); a revive window stretches the downed screen's countdown |
| `StoryHud.tsx` | The story's lines (subtitles above the hotbar), the finale panel under the boss bar (the shroud, the bells, the endless night's countdown), the Hush's entrance (letterbox and title card), revives (`[E] Raise <name> (hold)`; while down, Space respawns now), the ending (lines over a sunrise, then the credits); `StoryPartyLine` (in the quest tracker) and `StoryJournalBar` (in the journal: the acts, **Catch up**, the Starless Vow) |
| `FinaleLayer.tsx` | The Heartfall in the world: obsidian pillars, the sigil, the floating Heart, the wells of dawn, the shroud over the Hush, the dawn beam after a victory |
| `credits.ts` | The credit roll: the game's own lines, then CREDITS.md (`?raw`, parsed) |
| `story.test.ts` | Reducer, revives, credits parsing, contract wiring |

Keys: **E** (hold) raises a fallen friend (`input/interact.ts` E_ORDER: after
towns, caves and towers, before loot), **Space** while down respawns now,
**Esc / Enter** skip the ending or leave the credits. **J** journal: Catch up,
the Starless Vow.

Dev handle (debug builds): `window.__lodestoneStory` (`state()`, `catchUp()`,
`vow(on)`, `respawn()`, `revive(id, on)`, `sync()`, `closeEnding()`). Dev
console (F2 on a dev zone): `/story act 4 2`, `/story heartfall`,
`/story hush 34`, `/story bells`, `/story down`, `/story win`,
`/story vigil`, `/story places`, `/story reset`.

Evidence: `tools/playtest/story-shots.mjs` (two browsers on a private stack,
`docs/evidence/pt2-main-story-*.jpg`).
