# CR 022: shared spell visuals (playtest 2)

Author: pt2/shared-spell-fx agent · Date: 2026-11-10 · Status: applied on `pt2/shared-spell-fx`

Nicole: "make spells graphics/animations shared client state".

Read as: what a caster sees of their own spells and casting animations must
be what every other client sees of them (the same effect, from the same
origin, with the same timing, shape and held state), drawn from shared,
replicated state instead of each client guessing. The code agreed with that
reading: the caster's visuals came from prediction, everyone else's from a
partial reconstruction of Event 214 / 223 with its own guesses (a beam that
never followed its caster, a stream aimed from an 8-bit look, a short dash
pose for a held flight, no swing arcs, no arrows), and the two code paths
had drifted apart.

## Before and after (audit)

"Caster" = what you see of your own action (prediction; third person shows
your body). "Observer before / after" = another player within 64 m, on main
`d2f3a50` and on this branch. Measured where marked (M) by
`client/src/combat/dev/shared-fx-shots.ts` on a private zone, two headless
clients (`docs/evidence/pt2-shared-fx-run{,-before}.json`, screenshots
`pt2-shared-fx-{casts,channels,dashes,weapons}{,-before}.jpg`).

| Mechanic / animation | Caster | Observer before | Observer after |
| --- | --- | --- | --- |
| cast (off hand: sword, spear, bow, none) | `cast` pose, hand glow, flourish, projectile leaves the hand and eases onto the eye path | `cast` pose (M); projectile from the hand along a parallel path that never joins the eye path; no flourish on spells without a projectile | same pose (M); same hand-to-eye path (one projectile function); flourish for every caster |
| castStaff (staff, wand) | `castStaff`, from the tip | `castStaff` (M), tip | same (M) |
| castBig (areas, domains, runes) | `castBig`, windup sigil at the aim point (0.5 m ground walk) | `castBig` (M); sigil from a 0.75 m walk (could land a step off) | same (M); one `aim.ts` walk for both |
| castBeam (channelled beams) | follows your aim every tick | locked at the start on the nearest enemy in a 6 deg cone, never followed (M: screenshots) | follows the caster's replicated aim (Event 226) every frame, through the same `beamEnd` (M: 0.001 deg from the caster's aim at rest, vs 0.32 deg for the 8-bit drawn look) |
| stream (hold to fire) | shots along your aim, seeded jitter; your own body: a 460 ms cast pose, then nothing | held cast pose (M); shots from the 8-bit drawn look (third person: the camera look, 0.5-3.8 deg off where the caster's shots went, M) | held cast pose and the release flick on both (M); shots along the replicated aim (M: 0.001-0.002 deg); a player who arrives mid-stream starts at the right shot of the same seed |
| rain | seeded points around your aim point | around the drawn look's aim point | around the replicated aim's (M: 0.001 deg) |
| charge (hold to empower) | knot at the hand; your own body: no pose | `castBig` held (M) | `castBig` held on both (M); the released shot flies along the aim the caster's did |
| orbit | blades from `orbOffset` | same | same |
| homing | seekers on the shared step | re-simulated from the hand | re-simulated from the eye path, easing in from the hand (the same launch as yours) |
| brand, delayed burst | Event 224 | same | same |
| summon | flourish (first person only), the ally entity | no flourish; the ally entity | flourish for observers too; the ally entity |
| shield | shell (others), edge tint (you), bursts when broken (219) | shell for its full duration, never burst early | bursts when it breaks (219 to observers) |
| form (Q) | burst on the first hit frame (2 steps after the start) | burst at the event (2 steps early) | on the first hit frame |
| dash burst (every element) | 360 ms `dash` pose, burst FX | same; a held dash started looked like a dodge roll (M: `dodge` / `dash`) | same burst |
| held dash (jet, skate, blink, dash, glide, phase) | your body: the 360 ms dash pose, then running animation; FX while fast | the same 360 ms pose, then whatever the speed looked like (M: `dodge`, `dash`, nothing); FX alive while drawn speed >= 14 m/s | held flight poses on both (M, 8/8): jet = Iron Man along the velocity (upright climbing, flat in level flight, head first in a dive), skate, soar (glide), rush (blink, burst dashes, phase, blood); FX at full flame exactly while held (the casting bit), coasting after |
| melee swing (sword, spear, wand jab) | first-person swing; third person the arm swing | the arm swing only (M) | a world-space arc for both (gem-tinted, spin and thrust variants), on the move's own startup and active frames |
| shot moves (bow, staff bolt) | arrow / bolt | **nothing** | arrow / bolt from the hand, the drawn shot at its charged speed (214 now carries the draw) |
| area moves (plunge, slam) | shockwave | nothing | shockwave at the same aim point |
| sword parry | `parry` | `parry` (M) | same (M) |
| spear charge, bow draw held | held pose while held | held until a 2.5 / 3 s time-out (M: a 3.6 s bow draw showed nothing at 3.6 s) | held exactly while held (the casting bit; M: drawn at 3.6 s on both) |
| mining | swing pose | swing pose (707) | same, through the caster record |
| statuses on players | the zone applies none to players (combat.yaml `statuses`: enemies only; PvP and enemy strikes carry none) | none | none: nothing to replicate. Statuses on enemies were already shared (206 to everyone within 64 m, the caster included); the engine's status path takes any entity id, so a future player status draws with no client change |
| timing | prediction (now) | FX at receipt while the avatar is drawn ~50-100 ms in the past: spells left a body before its arm moved | every remote action, hold and aim applied when the caster's drawn body reaches it (their interpolation delay) |
| cast origin | first person: the view model's tip / hand; third person: `castOrigin` | `castOrigin` with the avatar's weapon | one `casterHand(key)` for every body (yours in third person and everyone's): the same weapon rule and pose |
| third-person aim | your shots go toward the crosshair (a few degrees off the camera look) | drawn along the camera look (M: 0.5-3.8 deg off) | the frames of aimed steps carry the crosshair aim, so the zone and everyone use the aim the shot really took (M: 0.001-0.002 deg) |

## The shared state (client)

`client/src/combat/castState.ts`: one record per caster (`'self'` or an
entity id): the newest action (Event 214 semantics), what is held (stream,
charge, beam, guard), the running dash and whether its key holds it, the
precise aim. Your prediction feeds yours (`runtime.ts`: every action
started, holds, the held dash from the timeline, your aim every frame;
`LocalAvatar.tsx`: mining). Replication feeds everyone else's with the same
calls (`remoteEvent()` for Events 214 / 223 / 226 / 219 / 707, `activity()`
for the drawn casting bit), applied at the caster's drawn moment. Both
renderers read only the record:

- the avatar: `net/avatarAnim.ts followCaster(anim, record, weapon)` is the
  one call for your body and everyone's (`LocalAvatar.tsx`,
  `RemotePlayers.tsx`); the old per-event triggers are gone;
- the FX engine: beams (`channelBeam`), streams and rain follow
  `castState.aimOf`, dash FX live while `dash.holding`, shells by caster;
  projectile launch, flourish, swing arcs and weapon shots are single
  functions used for both.

`client/src/combat/aim.ts` holds the aim walk, target pick and beam end used
by the runtime (your claims and visuals) and the engine (everyone's).

## Wire (all event-driven, nothing per tick for a player who holds nothing)

- **Activity casting bit on players** (an existing snapshot field, bit 3,
  until now only enemies' wind-ups): set while a held action runs: stream or
  charge, a channelled beam for windup + duration, a dash on steps whose hold
  the zone paid for, a guard (the secondary held on a sword, spear or bow).
  Delta-encoded: a byte when it flips. Observers end held poses, the dash's
  full flame and guards exactly where the caster's ended; nameplates do not
  show it (the pose does).
- **Event 226 `held`** (contracts/events.md): u16/i16 aim of a held stream,
  charge or beam to players within 64 m except the holder, when it moved by
  >= 64 / 128 units (~0.35 deg), at most every 3 ticks (10 Hz); a smaller
  change once 6 ticks after the last update (the aim a turn ended on); a
  keepalive every 30 ticks for every held action (data: start seq, the
  stream's seed, and progress), so a player who arrives mid-hold starts it
  where it is. 37 bytes each.
- **Event 219 to observers when a shield breaks** (value 0, entityId = owner).
- **Event 214 for a charged weapon move** appends u8 the draw (as charge
  spells already did), so others fly the arrow at its speed.
- **Aim in the frame**: on a step that aims a spell, shot or area move, and
  while a stream, charge or beam is held, the client's InputFrame yaw/pitch
  is the crosshair aim (third person: the convergence, first person:
  unchanged). No protocol change; prediction replays the same frames; the
  zone validates the aim the shot really used; the only side effect is that
  such a step's movement wish direction follows the aim (at most a few
  degrees, on those steps only).

No protocol version, struct or snapshot field change; `npm run gen:check`
clean.

### Cost

- Per observer within 64 m of a player holding a stream / beam / charge
  (`server/zone/internal/combat/held_test.go`, encoded bytes): sweeping
  the aim continuously (30 deg/s) 39 events in 4 s = **2.9 kbps**; holding
  still **0.24 kbps** (keepalives); a held dash 0.3 kbps (keepalives only:
  its look is its velocity). Nothing while nobody holds anything.
- Casting bit: one byte per flip in a record already sent.
- Scale scenario (300 players, 2,000 enemies; bots never hold anything):
  see "G5" below.

## Server

`server/zone/internal/combat/held.go`: `Player.HeldVisual` (a few field
tests), `World.heldTick` (once a tick, in `World.Step` after `dashTick`),
`HeldActivity` (the game layer ORs it into the player's Activity in
`combatTick`). `dashes.go` marks paid held steps (`dash.holding`),
`player.go` records the frame's exact look and the guard, `actions.go`
opens a beam's held window and sends the charged move's draw, `ai.go`
tells observers a shield broke.

## G5

`docs/evidence/pt2-shared-fx-bench.txt`: `BenchmarkScale/p300_e2000`
(300 ticks x3, base main `d2f3a50` vs head, same machine) p50 4.2-5.0 vs
4.0-4.6 ms, p99 7.7-8.0 vs 5.7-8.4 ms, 103.3-103.9 vs 100.3-103.6 M
cycles/tick, 137.2 kbps/client both (noise: the bots hold nothing). Wire
digest identical on base and head: p90_e600 `831bb7f4...`, p300_e2000
`8c29d408...`.

## Parity, measured (two clients, `pt2-shared-fx-run.json`)

32 actions (casts, beams, streams, rain, charge, orbit, homing, brands,
summon, shield, eight held dashes, four weapon attacks, three guards and
their releases): the caster's own body and the observer's avatar of them
showed the same action in 31 of 32 samples (the miss: a sword parry the
caster's body had already finished when the 1 s sample began, the observer's
still running ~100 ms later) and the same held pose in 32 of 32 (before:
5 of 32 action matches could be checked at all; held dashes showed `dodge`,
`dash` or nothing, a 3.6 s bow draw nothing). Aim of held spells, the
observer's against the caster's own, at rest: 0.001-0.002 deg (the 8-bit
drawn look: 0.23-0.33 deg; before CR 022 observers used that look, which
in third person was also 0.47-3.8 deg off the crosshair aim the caster's
shots took). While the caster turns, the two clients sampled at the same
wall-clock moment differ by what the observer's ~100 ms of display delay
hides (median 4-8 deg at ~40 deg/s for both the replicated aim and the
drawn look): that is the interpolation delay every remote thing has, not a
divergence.

## Tests

- Go: `server/zone/internal/combat/held_test.go` (nothing for an idle
  player; aim updates rate-limited, audience = 64 m without the holder,
  exact aim, shots for late observers; keepalives only for a still aim and
  for dashes; the settle update; the bit only while a dash is thrusting;
  beams for their duration, guards on sword/spear/bow but not staff;
  shield break to observers), `server/zone/internal/game/held_test.go`
  (end to end: a near player gets 226 and sees the bit, the caster and a
  player 110 m away get nothing, the bit drops on release).
- Vitest: `client/src/combat/castState.test.ts` (the decoders and Go's
  packing, the drawn-time delay, the casting bit, `aimOf`; your pose and
  theirs for a stream, a jet, a bow draw past 3 s, mining; third-person aim
  in the frame; a beam following a replicated aim; a held dash's FX alive
  while the bit holds it), plus the fx and avatar suites updated for the
  new routing.

## Not covered

- Mining and forms are not in the two-browser run (a vein and a level-gated
  form technique); both go through the same record and are unit tested.
- Particles still use `Math.random` for their spray: positions, paths,
  seeds, timing and held state match; individual sparks do not.
- Several dash screenshots frame the fast-moving caster poorly; the parity samples (both clients' records and bodies) measure it.
- An observer more than 64 m from a dash's start (but inside interest)
  learns its variant from the first keepalive (<= 1 s); until then it sees
  the carry, not the held pose.
- A remote charge's gathering fraction is drawn from when its start reached
  the observer.
