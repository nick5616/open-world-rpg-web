# CR 027: mounts, the spirit steed (playtest 2)

Nicole, overnight: "all sorts of good shit" (Valheim and Breath of the Wild). This CR adds a summonable spirit steed: bought with a whistle in the first hour, ridden through the shared movement step (bit-exact TS/Go, new golden vectors), fought from (bows and spells), thrown by hits and spooked by demons, seen by everyone, persisted per character.

## Getting one

- **Spirit Whistle** (`tool:spirit_whistle`, items.yaml, 40 gold) at every general store (`server/zone/internal/npc/talk.go`). New characters carry 20 gold, side quests pay 14-38 and bounties more, so it is a first-hour purchase.
- **Key 5** blows it (every letter is bound already: H/L belong to emotes/photo mode, P/T/N/B/J/M/I/C/O/K/X/Q/R/Z/F/G/V/E/Y/U to other features; 5 sits beside the spell keys 1-4). The first call with the whistle in your pack **bonds** a spirit steed to the character (persisted; the whistle stays and keeps calling it); without one: "General stores sell a Spirit Whistle".
- It **gallops in** from 26 m behind you (the zone picks a dry spot the steed could stand on behind, then beside you) over 2.4 s and stands 2.2 m to your right; with no such spot it **materializes** in place (0.9 s fade in). Others within 140 m see it come.
- **E** within 3.5 m mounts (the zone checks reach, ground mode, no dash, not downed); **E** again gets off (the steed stands beside you), so does **Space at a standstill** (the step itself hops you off). A standing steed nobody rides fades after 10 min; "Send away" in the steed panel dismisses it.
- **Steed panel** (Character (C) → "Your steed"): name (1-16 letters, digits, spaces, ' or -), one of six colours (Moonmist, Ember, Verdant, Dusk, Frost, Shade), Whistle, Send away, a short how-to.

## Riding: the shared movement step

`client/src/sim/ride.ts` and its twin `server/pkg/movement/ride.go` (the contract is the comment at the top of both). Being mounted is **MoveFlag.mounted = 8** (SelfState `flags` bit 3, free until now). **Only the zone sets it** (`movement.Mount`, Interact 110/2); the step only ever clears it, so the client learns a mount from SelfState and replays from it like any server change. While mounted:

| | |
| --- | --- |
| Gaits | `lunge` (the climb lunge, always 0 off a wall) carries the gait in bits 0-1 (0 trot, 1 walk, 2 gallop), "Shift was down last step" in bit 2 and "backing up" in bit 3; `finish` keeps lunge while mounted. W rides at the gait: trot 8.5 m/s (sprint on foot is 7.8 steady), gallop 13.5, walk 3.6 |
| Spur (BotW) | a Shift **press** (edge: bit 2) with W held spends RIDE_SPUR_STAMINA (18 points, 5 spurs per 100-point wheel) from your wheel, adds 4.5 m/s at once (cap 19) and steps the gait up (walk → trot → gallop); a spur's burst over the gallop fades at 3.5 m/s². Holding Shift spends nothing more; the gallop holds for free while W is down; other grounded steps regenerate as on foot. The HUD shows the spurs as pips under the crosshair |
| Steering | W/A/D steer toward the camera-relative wish; the velocity turns by at most 150 / 110 / 75 °/s (walk / trot / gallop) using **literal cos/sin per step** (no trig at run time); below 1 m/s it turns on the spot. A/D alone turn at a walk. S reins in to a walk and brakes (16 m/s²), then backs up at 2 m/s away from the look. No keys: stops at 10 m/s² |
| Slopes | walkable up to 35° (RIDE_WALKABLE_TAN_SQ, a literal); steeper uphill ground is a wall (the move keeps its along-contour part, never climbs), 0.5 m lips are stepped; standing on ground past 45° slides (person rules, no control) |
| Water | deeper than 1.2 m ahead is refused (the steed stops at the edge); wading deeper than 0.35 m slows every gait to 55 %; landing in swimmable water throws the rider (swim mode) |
| Air | Space while moving jumps 7 m/s (1.36 m: fences, logs); no air control, no double jump, no glider; landing faster than 17 m/s down (an 8 m fall) throws the rider |
| Collision | the rider's own push-out (buildings, props, camp pieces, cave walls, unchanged), then the steed's **chest** 0.9 m ahead along the motion is pushed out of the same colliders and the body moves with it (`collideHead`) |
| No dashes | the dodge and channel bits are masked before `beginDash` (counters still run down); climb, glide and swim modes drop the flag |

Everything is + - * / sqrt and comparisons on top of the yaw sin/cos the walk step already used, with Go's products wrapped in `float64()` (no FMA).

## Server authority and validation

- `Player`-side: `mountedFrame` (zone `mounts.go`, before the combat layer and the step): a rider's dodge / mobility dash is stripped; with a **sword or spear** the attack, alt_attack (parry/charge), technique and form are stripped. **Bows, staves, wands and every non-mobility spell work** from the saddle (the client's timeline refuses the same, so nothing is predicted wrongly).
- **Validation** (`movement.MaxHorizontalSpeed`, zone `traversal.go`): a step that starts and ends mounted is bounded by the spur cap (19 m/s) or the speed it carried; the step that drops a rider by that too. New: a step on the ground (ground → ground) **without a mount or a dash** is bounded by `max(previous speed + AIR_CAP_SPEED, sprint wish 12.8, SLIDE_MAX_SPEED)` (friction and ground acceleration never exceed it), so a gallop without the flag (which only the zone sets) is a violation even though it is under the generous 25.6 m/s walk-family bound. Vertical: RIDE_JUMP_SPEED is allowed while mounted.
- **Hits**: a rider who loses health is thrown with STEED_HIT_DISMOUNT_CHANCE 25 % (going down always throws). **Demons**: at night, once a second, a live demon within 12 m spooks the steed with 35 %: the rider is thrown, the steed bolts (runs off and fades), and it can't be called for 20 s.
- **Teleports**: fast travel / respawn with the flag cleared (or a jump over 24 m in a tick) leaves the steed behind (gone).
- WP16: the steed's owned list, phase and cooldown ride a handoff field `steed`; a ridden steed crosses the border with you (the movement state carries the flag); arriving without a steed record clears the flag.

## Wire (cheap, event driven)

- **Riders**: player snapshot `typeId` **bit 14** (bits 0-11 weapon look, 12-13 PvP), set on mount and dismount only (never per tick); delta-coded like any typeId. The rider's position is the steed's.
- **Event 1140** `steed_sync` (to you, on join only if you own a steed or carry a whistle, and on every change), **1141** `steed_state` (an owner's steed: phase arriving / standing / ridden / bolting / gone, where it stands, its look, to the owner and players within 140 m of the owner or the steed, on change and to newcomers by a 2 s check that does nothing while nobody has a steed out), **1142** `steed_refused`, **1143** `steed_thrown` (cause). Range **1140-1159** (1144-1159 reserved). **Interact 110** `steed` (1 whistle, 2 mount, 3 get off, 4 name chunks, 5 colour, 6 send away, 7 sync, 9 dev whistle).
- `LODESTONE_WIRE_DIGEST=1`: **identical** to main (p90_e600 `831bb7f4...`, p300_e2000 `8c29d408...`); the first build sent 1140 to every joining bot and moved it, hence "only owners or whistle holders". `BenchmarkScale/p300_e2000` (4 runs each): 86.8-88.9 M cycles/tick head vs 87.1-88.4 base, 134.0-134.8 vs 133.8-134.5 kbps/client (noise; `docs/evidence/pt2-mounts-bench.txt`).

## Persistence

Migration **0028** `character_mounts` (character_id, slot, kind, name, colour, bonded_at, epoch, updated_at; PK (character_id, slot); epoch-fenced like 0025). Written through the write-behind queue on bond / rename / colour. Local profiles keep the same list in the save blob's optional `mounts` (`localsave.State.Mounts`). The mounted flag itself is never persisted: a rejoin starts on foot.

## Golden vectors (deliberately added)

`client/src/sim/golden/movement_pt2_ride_{flat,plane,course_east,course_west}.json` (golden format version 5, rows `[x,y,z,vx,vy,vz,airJumps,mode,stamina,timer,lunge,flags]`), generated by `golden/ride.ts` from a mounted initial state (flags bit 3): trot, spur, held Shift, burst, gallop turns, a dodge that must do nothing, diagonal steering, a jump, brake, back up, walk, A/D turning, spurs until the wheel runs short, hop off and walk on; the `course` ground (a twin in `ride_golden_test.go`) adds a fence jumped at a gallop, a building wall bumped and followed, a 26.6° hill, a plateau's 10 m drop that throws the rider, a ford that slows, a lake bank where the steed refuses at 1.2 m, a 63° cliff it can't climb (but the dismounted rider climbs). Replayed by Go `TestReplaysRideGoldens` (1e-9 m, every discrete field exact, and every mounted step inside the validation bound) and vitest `ride.test.ts` (bit for bit). The WP02 / WP10 / WP13 goldens are byte-identical (regenerated, no diff).

## Constants

`contracts/constants.yaml` group `mounts` (version 6): RIDE_* (the step) and STEED_* (the zone and the client).

## Tests

Go: `server/pkg/movement/ride_golden_test.go` (goldens, gaits and spurs, never mounts itself, no dash while riding, mounted-only speeds, can't climb or swim), `server/zone/internal/game/mounts_test.go` on the official world (no whistle refused, bond + arrival heard by another player, persisted, too far refused, mount → SelfState bit, a gallop predicted == authoritative with zero speed violations, typeId bit seen by the other player, a forged on-foot gallop refused by validation, melee/dodge stripped, E off and the steed stands, hits throw, fast travel leaves it behind, a demon at night spooks it (cooldown refusal), name/colour persisted through a restart). Vitest: `client/src/sim/ride.test.ts`, `client/src/ui/mounts/mounts.test.ts` (store and decoders, arrival/bolt poses, name chunks, rig gaits, the avatar seated and facing its motion, the timeline in the saddle, the FOV kick).

## Evidence

`cd client && npx vite-node src/ui/mounts/dev/mount-shots.ts` (the real client and zone on the official world, ONE headless browser with two pages): `docs/evidence/pt2-mounts-summon.png` (the steed galloping in, third person), `-gallop-third.png` (a spur's burst, 16 m/s, the boom pulled back), `-observer.png` (another player's view: rider seated, steed galloping, remote gait `gallop`), `-first.png` (first person in the saddle at 13.5 m/s: the neck and ears below), `-panel.png` (the steed panel after renaming to Misty, Ember), `pt2-mounts-shots.txt`.

## Not covered

- Shots and casts still leave from the 1.6 m combat eye (the steed's withers), not the rider's raised hands; the client converges the aim from it onto the crosshair in both views, so they land where you aim.
- No mounted melee swing; no mounted sounds (hoofbeats, the whistle) yet; the steed has no health of its own.
- The steed walks through trees and boulders that have no player collision (as players do).
- Interactions (doors, NPCs, mining) still reach from the eye, which rides 0.95 m higher in the saddle.
- An account upgrade from a local profile does not copy `mounts` (like the content state).
