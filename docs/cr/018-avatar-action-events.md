# CR 018: two action events for avatar animation (playtest 2)

Author: pt2/third-person agent · Date: 2026-11-09 · Status: applied on `pt2/third-person`

Playtest 2 asked for "animations in the third person of other people doing
things in the game". Almost everything a remote avatar needs is already on
the wire: movement (snapshot position, velocity, Activity bits, look pitch),
attacks, casts, forms and dashes (Event 214), enemy hits (222), downed (203,
health %). A plain dodge is derived on the client (a sudden ground-speed
burst). Two things players do were invisible to everyone else:

- **Raising the secondary**: the sword parry stance, the spear charge and
  the bow draw. Only the release of a charge was sent (as its attack id).
- **Swinging a pickaxe**: Event 701 goes to the miner only.

## What

- **Event 214 `cast`, new targetId `0x4001`** (`combat.CastFXGuard`): the
  zone sends it, like every 214, to players within 64 m except the actor, on
  the input frame where `alt_attack` goes from up to down while the active
  weapon is a sword, spear or bow (staff and wand turn the secondary into a
  heavy attack, which already has its own 214). Once per press; `x/y/z` and
  `data` (yaw, pitch) as for every 214. Clients that don't know the id ignore
  it (the audio trigger already masks ids it doesn't recognise).
- **Event 707 `mine_swing`** (WP09 range): to players within 64 m of the
  miner, not to the miner, for every accepted pickaxe swing (the one that
  sends the miner its 701). `entityId` = miner, `x/y/z` = the vein (cm).

No change to `protocol.yaml`, `constants.yaml`, the snapshot or any struct:
both are reliable Events on existing channels, sent only when a player acts
(no per-entity, per-tick bytes; the per-client downlink budget is untouched).

## Consumers

- Zone: `server/zone/internal/combat` (`FrameResult.Guard`, `CastFXGuard`,
  `actions.go`), `server/zone/internal/game/mining.go` (`EventMineSwing`,
  `mineSwingFX`). Tests: `combat/guard_test.go`, `game/mining_test.go`
  `TestMineSwingSeenByOthers`.
- Client: `client/src/net/avatarAnim.ts` (`CAST_FX_GUARD`, `EV_MINE_SWING`,
  action classification), `client/src/net/RemotePlayers.tsx` (routing).
- `contracts/events.md` rows 214 and 707.
