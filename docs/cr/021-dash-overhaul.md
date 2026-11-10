# CR 021: dash overhaul (playtest 2)

Nicole, playtest 2: "make the dash attacks more useful. as it stands, you can sprint faster on your own. make them make you go really fast, have effects on the environment, look really cool, or last as long as you hold it down, draining either mana or health. some combo of these. also make it so some of them like the fire one, propel you in the direction you are looking. it should feel like you are iron man."

Before: a mobility dash set a speed for 2-15 steps and then clamped to `DASH_EXIT_SPEED` (6 m/s, slower than walking); Magma Dash covered 6 m and stopped, Phase Slip ran at 16 m/s (sprint is 12.8). Now every dash peaks at 2.3-9x sprint, can be held for as long as you pay for it, Magma Dash flies where you look, and each element does something to the world.

## What each dash does now

Sprint = 12.8 m/s. "Burst" is the press (the old dash, now faster); "held" is what holding the spell's key (1-4, or RMB with the slot selected) keeps going; "carry" is the speed kept when you let go (the old clamp to 6 m/s now only applies to the plain dodge).

| Dash (element) | Burst | Held | Cost while held | Carry | World effect (the zone's, no claims) |
| --- | --- | --- | --- | --- | --- |
| Magma Dash (fire) | 30 m/s along the 3D look (yaw and pitch) | **jet**: thrust toward where you look at 36 m/s (2.8x sprint), steering 9 %/step, gravity cancelled in the air: straight up, level flight, dives | 24 mana/s | 18 m/s | burns enemies it passes (14 + burn), sets grass alight along the path (chem ignite every 0.2 s within 4 m of the ground), **slam** when you dive into the ground faster than 14 m/s: 45 + knockback within 4.5 m (Event 230) |
| Glacier Step (ice) | 44 m/s | **skate** at 30 m/s: water is ground while held (you run on lakes) | 16 mana/s | 16 m/s | 8 + slow on enemies passed, freezes the water it skates over (chem freeze); let go over deep water and you swim |
| Static Step (lightning) | 54 m/s | **blink**: 22 m/s with a 120 m/s step (2 m) every 5 steps: chained short teleports | 20 mana/s | 16 m/s | 10 + shock on enemies passed; bolts and shock marks at every blink (FX) |
| Root Launch (earth) | 30 m/s + 6 m/s hop | **dash** at 26 m/s, steered by the keys | 18 mana/s | 14 m/s | 16 + knockback on enemies passed, rock spikes bursting up along the path (FX) |
| Updraft (wind) | 14 m/s launch + 18 m/s | **glide**: 30 m/s, the fall held to 1 m/s | 12 mana/s | 18 m/s | 6 + knockback on enemies passed |
| Sunstep (light) | 46 m/s | **dash** at 30 m/s | 16 mana/s | 16 m/s | 8 on enemies passed (sears demons: Light); heals you and your party within 8 m by 6 every 0.5 s while it runs (the radiant trail) |
| Skip (void) | 60 m/s | **phase** at 34 m/s with the i-frames kept up (enemy strikes miss) | 28 mana/s | 18 m/s | 10 on enemies passed (you phase through them) |
| Phase Slip (dark) | 40 m/s | **dash** at 32 m/s: the blood dash | 6 mana/s **and 14 health/s** (never below 1) | 16 m/s | 12 on enemies passed, 60 % lifesteal |
| Gale Cut (wind form dash) | 40 m/s | (not held: the form's dash) | - | 14 m/s | - |

Every mobility spell now costs 6 mana to start (was free). Trail damage scales like the dasher's spells (weapon spell power, spellcraft, gear spell power, character level, elements) and hits each enemy once per dash; statuses are the normal enemy statuses. Trails, heals, slams and chemistry never touch players (PvE only, like spell chemistry).

Feel (client): the FOV widens up to +16 degrees with dash speed and eases back; radial speed lines over the view; camera shake on the high and ultra FX tiers (none with reduced motion); a whoosh every 0.3 s while held; per-element FX kept alive for as long as the dash runs (yours and other players', read from their drawn speed): jet flames and smoke, frost and ice spikes on the path, blink bolts with flashes and scorch marks, rock spikes, gusts, a ring of light, blood mist, void wisps; the slam bursts with spikes, a shockwave ring and a hard shake.

## How holding works (both movement twins)

The dash still starts on a step with the dodge flag and `castSlot` = the variant. From the next step until the dash has run out, the client puts the running variant in `castSlot` on every frame, and while the key is down also `InputFlag.channel` (bit 14, added by CR 020: held, so `fillGap`'s repeated frames keep it). In the shared step (`server/pkg/movement/dash.go` and its twin `client/src/sim/dash.ts`):

- `Holding(prev, flags, castSlot)`: the state entering the step runs a dash (`Dash > 0`) in a walk-family mode (ground, air, glide), the frame has `channel`, no attack/dodge/cast, and `castSlot` names a variant with a sustain block. A held step re-arms `carrySteps` of dash (blink: `blinkEvery`) and applies the kind (jet: velocity eases onto look x speed by `steer`, gravity cancelled when airborne; dash/skate/phase: horizontal velocity = keys (else straight ahead) x speed; blink: the pulse when the counter runs out; glide: fall capped at `sink`; phase: i-frames kept >= 2). A skate step runs the mode step on a ground that is `max(terrain, water)` with no water (`skateGround`).
- Not held: the counter runs down (the carry: no friction, no steering) and when it ends the horizontal speed is clamped to the exit speed of the variant `castSlot` names (the plain dodge's `DASH_EXIT_SPEED` when it names none).
- `aim: look` variants start along the 3D look: `stepFull` now takes the frame's pitch (`proto.I16ToPitch` / `i16ToPitch`).

`State` is unchanged: `Dash` (4 bits) and `IFrames` (4 bits) still carry everything, and which variant runs comes from the frame, so `SelfState` reconciliation replays exactly as before (the client replays its own stored frames). No new snapshot field, no protocol version change (the `channel` bit is CR 020's).

## Server authority

- `Player.allowDash` (unchanged rules: equipped, known, cooldown, mana) now records the dash it allowed and paid (`dashBegin`).
- `Player.sustainDash` (new `server/zone/internal/combat/dashes.go`, called from `Player.Frame` BEFORE the movement step): a non-start frame that names a variant which is not the dash this player is running, or names one while no dash runs, has `castSlot` zeroed; a held step (`movement.Holding`) is paid there (mana per step = manaPerS / 60, health per step for the blood dash, never below 1) and zeroed when the player cannot pay or the spell is no longer equipped. The step then never sustains a dash the zone did not allow and pay for: it counts down and ends with the plain exit clamp on both sides (the client's prediction is corrected by the usual reconciliation).
- Movement validation: `MaxDashSpeed` now includes the held speeds and the blink pulse (120 m/s) and `MaxDashLift` the jet speed; they apply only while a dash runs (`prev.Dash > 0 || next.Dash > 0`, as before). Without a running dash a jet speed is a violation (36 m/s > the 25.6 m/s walk bound), and every exit speed is inside the walk bound (codegen refuses an `exitSpeed` above it).
- World effects run on the zone tick: `World.dashTick` (trail damage, heal trail, slam, Event 230) and `Server.dashEnvTick` (`server/zone/internal/game/dashes.go`: ignite / freeze ops through `chemAt`, the same path as spell impacts, one op per dasher every 6 ticks).
- `TestOnlyEnemiesCallHurtPlayer` now allows exactly one more health write: `payBlood` in `dashes.go` (the blood dash's self cost).

## Contract

- `contracts/combat.yaml` `dashes`: `aim`, `exitSpeed`, `sustain {kind, speed, steer, carrySteps, blinkSpeed, blinkEvery, sink, manaPerS, healthPerS}`, `trail {radius, damage, status, lifesteal, heal, healRadius, chem, slam {minFall, radius, damage, status}}`; mobility spells `mana: 6`. Codegen (`contracts/codegen/lib/combat.mjs`) validates kinds, carry steps (<= 15, 4 bits), costs and the exit bound, and emits `kindId` for the step; `DashDef`, `DashSustainDef`, `DashTrailDef` in TS, `combatdefs.DashSustain`/`DashTrail`/`DashSlam` in Go.
- `contracts/events.md`: Event 230 `dash_slam` (231-239 reserved for dashes).
- Dev: `LODESTONE_ZONE_DEBUG_SPELLS="key,key"` teaches joining characters those spells on dev combat zones (evidence runs).

## Golden vectors (deliberately regenerated)

`client/src/sim/golden/movement_wp13_dash_{flat,plane}.json` (golden version 3 -> 4) were regenerated: every dash variant changed speed, and the script gained a held section per sustainable dash (start, held steps with the jet looking up, level and diving into the ground, a cast step that must not hold, the carry naming the variant, then holding after the end, which must do nothing). New `movement_wp13_dash_island.json` (ground kind `island`: an island in a lake) holds the skate over the water and drops into a swim when released. `server/pkg/movement/dash_golden_test.go` replays all three through the Go step (1e-9 m, discrete state exact). The WP02/WP10 goldens are byte-identical (no dash in them).

## Wire and tick cost

Nothing new is sent for a player who does not dash: no snapshot field, no per-tick event; the bots of the G5 scale scenario never dash, and the wire digest is identical before and after (`LODESTONE_WIRE_DIGEST=1`, p90_e600 `831bb7f4...`, p300_e2000 `8c29d408...` on both). Per dashing player: the chem ops (one every 0.2 s, the existing chem event), Event 230 on a slam, the normal damage/status events of trail hits. Tick: `dashTick` is one field test per player per tick plus an enemy scan only for players who are dashing; `BenchmarkScale/p300_e2000` (8 runs each, 1 tick) median 112 vs 114 M cycles and 3.6 vs 3.5 ms tick max (base vs head: noise).

## Tests

- `server/pkg/movement/dash_hold_test.go`: the jet flies straight up and holds level flight within every validation bound; a hold needs a running dash, the channel bit, its variant and no attack/dodge/cast; jet speed passes the bounds only with a dash; the skate over water and the swim after.
- `server/zone/internal/combat/dashes_test.go`: a second of jet drains exactly manaPerS and an unpaid step is stripped (the dash ends); holds for another variant, with no dash running or after unequipping are stripped; the blood dash's health cost and its floor at 1; trail damage once per dash and the slam (Event 230, a boar 6 m away hurt); the heal trail heals a party member.
- `server/zone/internal/game/dashes_test.go`: a magma dash schedules ignite ops that reach clients in range; an idle player schedules none.
- `client/src/sim/dashHold.test.ts`, `client/src/combat/dashes.test.ts`: the same rules on the client, the timeline's channel + variant frames and mana per step, the camera kick curve.

## Evidence

`npx vite-node src/combat/dev/dash-shots.ts` (from client/: two headless clients on a real zone): `docs/evidence/pt2-dash-magma.png` (straight up, level flight with speed lines, the dive onto a camp), `pt2-dash-glacier.png` (skating on a lake), `pt2-dash-elements.png` (the other six held), `pt2-dash-shots.json` (positions, speeds, modes, dash counters and predicted mana along each hold: e.g. Magma Dash 35.8 m/s climbing 16 m in 0.6 s, Glacier Step at 30 m/s on the water surface in ground mode).

## Not covered

- Other players' avatars play the short WP13 dash pose at the start of a held dash, not a held flight pose (the FX trail and their speed show the flight).
- The frozen path is the chem freeze state (visible where the chemistry draws frozen water); the skate itself does not leave walkable ice for others.
