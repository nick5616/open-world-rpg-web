# client/src/ui/quests

Quests in the browser (playtest 1, CR 013). The zone owns the log
(`server/zone/internal/quests`, README "Quests" in `server/zone`); this
folder shows it and sends Interact 60.

| File | What |
| --- | --- |
| `events.ts` | Event kinds 950-955, Interact 60, JSON decoders, "420 m north-east" wording (same compass as the zone's bounty texts) |
| `store.ts` | zustand: the log (950 is the whole truth), a pending offer (951), a map preview, the journal flag, notes; `reduceQuestEvent` is pure |
| `link.ts` | Hooks the live session (NetPlay calls `ensureQuestHook` before Hello so the first 950 is never missed; the HUD re-hooks after reconnects) |
| `QuestHud.tsx` | Tracker (right, under the compass: step, count, distance and direction to the nearest marker), notes, the offer card, the journal (J), `window.__lodestoneQuests` |
| `QuestLayer.tsx` | In-world beams over the tracked quest's markers (one shared geometry/material, at most 4 meshes) |
| `dev/pt-ux-shots.ts` | Headless screenshots for playtest 1 (quests, spell wheel, health bars, HUD before/after) |

Where markers show:

- **Map (M)**: every active quest's current markers (the tracked quest in
  gold with labels, others dimmer); areas are circles (`r` m), points are
  "!" diamonds; overlapping labels stack. The side panel lists the tracked
  quest's places with distance and direction.
- **Compass**: the tracked quest's markers as gold diamonds, the nearest one
  labelled with its distance (from the edge of an area).
- **World**: a gold beam over each marker of the tracked quest, fading as
  you arrive.

Before accepting:

- **Offers** (951: a blacksmith re-offering "Ward against the night") open
  a card with every step and where it takes you (distance, direction, area
  size), a small map of all the places and you, and "Show on map", which
  opens the full map framed on the places (cyan dashed preview).
- **Bounty notices** (WP20's board / bounty keeper panel,
  `world/buildings/townHud.ts`) show each job's place and distance and a
  "Show on map" preview; deliveries say they're handed in at this board.

Controls: J journal (track, show on map, hand in, abandon), M map, Esc closes.

Tests: `quests.test.ts` (reducer, offers, notes, wording).
