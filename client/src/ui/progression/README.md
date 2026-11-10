# Progression UI (playtest 1)

Level-up fanfare, character panel, area notices and the crystal tower
prompt. Contract: `docs/cr/012-progression-difficulty.md`; why:
`docs/decisions/0021-discovery-difficulty.md`.

| File | What |
| --- | --- |
| `events.ts` | Event kinds 900-903, Interact 10 action 2 (attune) and 50/4 (learn), decoders for `character_stats` (900) and `area` (901), encoders for tests/mocks. Go twins: `server/zone/internal/game/progression.go` (`EncodeStats`), `difficulty.go` (`EncodeArea`); `progression.test.ts` replays the Go vectors. |
| `gains.ts` | Pure: stats at a level (combat.yaml `leveling`, the numbers the zone applies), the fanfare's gain lines, upcoming levels and tier unlocks, weapon skill levels and next techniques, learnable spells (Light first). |
| `store.ts` | zustand: latest stats, the area you stand in, the fanfare, notices, panel open; `reduceProgressionEvent` is pure. |
| `towerPrompt.ts` | Pure: what the nearest crystal tower says (climb / attune / attuned / come back). |
| `link.ts` | `attachProgression(session)`: Events in (via `session.eventListeners`), attune/learn Interacts out. NetPlay calls it. |
| `ProgressionHud.tsx` | The HUD the play screen mounts: fanfare (top centre, ~7 s, a synthesized chime), notices (left), tower prompt (below the crosshair, above WP14's loot prompt line), character panel (C; Esc closes; spell cards from `ui/spellcards` for the loadout slots and known spells, WCAG AA text tokens from `ui/spellcards/theme.ts`). |
| `dev.ts` | `window.__lodestoneProgression` (debug builds): `state()`, `event()`, `stats(level, attuned, sites)`, `levelUp(prev, level)`, `area(level, tier, flags, by)`, `attuned(site, region, name)`, `open()`. |
| `dev/shots.mjs` | Headless evidence: solo client + the dev handle; writes `docs/evidence/pt-progression-*.png`. |

Keys: **C** toggles the character panel (KeyC no longer crouches; crouch is
Ctrl), **E** on a tower's top attunes (only while the attune prompt shows).
Playtest 2: the panel's "Skill tree" and "Build overview" buttons open
`client/src/ui/skills` (keys N and B).

Offline (solo) the panel shows level-1 numbers, the tower prompt works
from the map's tower list, and nothing is ever attuned (progress is the
zone's).

For the `pt/ux` location-discovery intro: listen for Event **902**
`tower_attuned` (`targetId` tower site, `value` region index, `x/y/z` the
crystal, `data` region name) on `session.eventListeners`; this module only
shows a notice for it (`useProgression.getState().attuned` holds the last one).
