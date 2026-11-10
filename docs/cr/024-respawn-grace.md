# CR 024: respawn grace and the downed screen (playtest 2)

Author: pt2/onboarding agent · Date: 2026-11-10 · Status: applied on `pt2/onboarding`

Playtest 2, new player onboarding: "dying outside the Haven: a clear downed
overlay ('Downed by <enemy>'), a fair respawn at the last waypoint or town,
brief spawn protection, and say what you lose".

## What was there

Spec 8 already had the rule: a downed player respawns after
`PLAYER_RESPAWN_S` (3 s) at the last waypoint touched (`RespawnPoint`), with
full health and mana and everything kept. Event 203 (`EvPlayerDowned`)
already names what downed you (`targetId`) and the wait (`value`, ms). The
client showed a bare "Downed" line, and a player who died at a pack's edge
could come back into the same fight (a waypoint next to a camp) with no time
to get their bearings.

## Change

- `contracts/constants.yaml`: `PLAYER_RESPAWN_GRACE_S = 5` (combat group).
  Codegen: TS, Go, Rust.
- Zone (`combat`): `Player.graceTick` set at the respawn. While
  `Graced(tick)`: enemies don't acquire or keep the player as a target
  (`acquire`, `chase`), enemy strikes and projectiles don't hurt them
  (`hurtPlayer`), and PvP claims on them are refused (`RefuseInvulnerable`).
  Landing an accepted hit (PvE `applyHit`, PvP `applyPlayerHit`) ends the
  grace at once, so it can't be used to attack untouchable.
- No protocol change: the client knows the respawn (Event 221) and its own
  accepted hits, so it draws the grace from the shared constant.
- Client: the downed screen ("Downed by a Dewdrop Slime", "Back on your feet
  at <waypoint> in 3 s", "You keep everything you carry") and a grace line
  after the respawn (`client/src/combat/downed.ts`, `DownedOverlay`).

Environmental damage (fire, drowning) is not affected: the grace is about
enemies and players.

## Tests

`server/zone/internal/game/respawn_test.go`: brutes down a new character, the
downed event names one of them and the wait, the respawn is at the respawn
point with full health/mana and draughts kept, brutes placed on the respawn
point neither target nor hurt the player for the grace and do afterwards; an
accepted hit ends the grace. Client: `downed.test.ts`.
