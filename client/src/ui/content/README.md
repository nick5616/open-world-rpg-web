# client/src/ui/content

The playtest 2 content bundle in the browser (CR 023, `docs/cr/023-content.md`).
The zone owns everything (`server/zone/internal/content`, `internal/game/content*.go`,
`worldevents.go`, `dungeons.go`); this folder shows it and sends Interact 80.
Names and texts come from `contracts/content.yaml` (generated `CONTENT`).

| File | What |
| --- | --- |
| `events.ts` | Event kinds 1000-1029, Interact 80, decoders (1007 is binary: tablets and herb patches of an area), the world event status line |
| `store.ts` | zustand: the content sync (codex kills, tablets read, achievements earned with their times and points (CR 031), title, renown, vaults found), places near you, world events in range, live vaults, the tablet being read, notes; `reduceContentEvent` is pure |
| `titles.ts` | other players' titles (Event 1005) read by the nameplate (`net/avatar.ts`) |
| `link.ts` | hooks the live session (NetPlay calls `ensureContentHook` before Hello) |
| `ContentHud.tsx` | world event tracker (top centre), notes (left), lore tablet reader, sealed vault panel, the `[E]` prompt for tablets / herbs / vault parts, `window.__lodestoneContent` (debug builds) |
| `JournalTabs.tsx` | the journal's Bestiary, Fish, Lore, Achievements (the list of ui/achievements, compact) and Renown tabs (J) |
| `ContentLayer.tsx` | in-world: tablets, herb patches (one instanced mesh), vault parts, world event beams, the caravan's wagon, the starfall's shard |
| `dev/content-shots.ts` | headless evidence: `cd client && npx vite-node src/ui/content/dev/content-shots.ts [--only=dialogue,event,vault,lore,codex]` |

Where to find each thing in game:

- **Side quests**: talk (E) to townsfolk; quest givers offer a request with a line of dialogue (the offer card), Accept puts it in the journal with map/compass markers. Hand gathered items to the giver by talking to them with the items in your pack.
- **Stories**: an innkeeper (The Lodestone's Hum), a guard or bounty keeper (Embers of the Old Watch), a farmer (The Bell Beneath) offer them once.
- **World events**: they come to you (every ~75 s the zone may start one 160-380 m from a player); the tracker under the compass and a red star on the compass and map show where.
- **Sealed vaults**: one per region at a ruin or shrine; found within 70 m, then on the map (a gold keyhole). The panel on the left reads the inscription.
- **Lore tablets**: standing stones with a blue rune at ruins, shrines and watchtowers (E to read).
- **Herbs**: leafy clumps in the wild (E to gather); cook or brew them at a hearth or campfire.
- **Codex, renown**: J, then the tabs. **Achievements and titles** (CR 031): Y, the Esc menu, the character panel or the journal tab (`client/src/ui/achievements`); titles show under your name for others.
