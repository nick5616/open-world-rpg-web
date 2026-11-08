# client/src/combat

The client side of combat (WP13). Online only: NetPlay attaches it to the
zone session (`link.ts`), offline play has no enemies.

| File | What |
| --- | --- |
| `timeline.ts` | The step-synchronous timeline (runs inside LocalSim's 60 Hz steps): input buffer (150 ms), attack starts and combos, dodge-cancel, bow draw / spear charge, sword parry, spell slots with cooldown + mana prediction, mobility spells as dash variants, elemental form (Q), technique (V/middle mouse), drink (R). Mirrors `server/zone/internal/combat/player.go` |
| `runtime.ts` | Input listeners, predicted hits (melee arcs on the active frames, local projectiles, beams, chains, area and lingering spells, runes), spark + hitstop at once, HitClaims, numbers on HitResult, combat Events -> HUD/FX |
| `probe.ts` | The input-to-hit timing probe (press -> first hit frame, feedback, recovery, dodge-cancel, i-frames, buffer, hitstop, drink, wind-ups, confirmation) |
| `events.ts` | Event kinds 200-222, Interact 50, `combat_sync` / telegraph decoders, typeId unpacking |
| `store.ts` | HUD state (zustand, event-rate) and the FX queue |
| `CombatLayer.tsx` | Enemies, telegraph decals, projectiles, areas, beams, sparks, floating numbers, the first-person weapon and its swing |
| `CombatHud.tsx` | Health, mana, weapon + four spell slots with cooldowns, draughts, boss bar, toasts, downed overlay |
| `link.ts` | Session attach, PlayerDriver hooks, `window.__lodestoneCombat` (probe, HUD) |
| `dev/feel-browser.ts` | Headless Chromium feel run against the real zone (`npm run combat:browser -w client`) |

Controls: LMB attack, RMB parry (sword) / draw (bow) / charge (spear) / bonk
(staff, wand), F or Left Alt dodge, 1-4 spells, Q elemental form, V or
middle mouse weapon technique, R draught, X swap loadout.

Tests: `npx vitest run src/combat` (feel limits in the tables, timeline
rules, wire decoders). The real-time numbers come from the probe run
(docs/evidence/wp13-feel.*).
