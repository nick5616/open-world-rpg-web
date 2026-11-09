# CR 017: travel to a friend (playtest 2)

Author: pt2/bugs agent · Date: 2026-11-09 · Status: applied on `pt2/bugs`

Nicole: "add the ability to teleport to friends in the friend tab". The
Friends panel gets a **Travel** button per online friend; the zone moves you
to them.

## What

- **Interact 61 `friend`** (contracts/events.md): `targetId` = FNV-1a 64 of
  the friend's character id (Interact carries no string; the zone matches
  the hash against its players and, in a cluster, the world presence feed
  `worldpos:{world}`), action 1 = travel, 2 = cancel.
- **Events 980-982** (new range 980-989): `travel_channel` (a 3 s channel
  started; the client draws a bar and darkens the screen), `travel_refused`
  (reasons 1-10), `travel_arrived` (after the core teleport Event 2).
- **Rules** (server-authoritative, `server/zone/internal/game/friendtravel.go`):
  an accepted friendship (`social_friends`, read by the zone's own Postgres
  pool off the tick while the channel runs); the friend online in this
  world; neither of you in combat (hurt or fighting in the last 10 s, or
  downed; the friend's combat state is known only on the same zone); a 3 s
  channel that moving 1 m or taking damage cancels; a 30 s cooldown after a
  travel. The move is `Teleport` onto the friend's spot (fast travel's
  path); a spot owned by another zone hands the player over through WP16's
  handoff, as after a walk across the border.

No change to `protocol.yaml`, `constants.yaml`, migrations or the social
protocol. The zone reads `social_friends` (migration 0003), which the
social service owns; the zone's database user already has access (one
database, one user on every deploy).

## Consumers

- `server/zone/internal/game` (`friendtravel.go`, `session.go` dispatch and
  session fields, `server.go` tick hook, `ghosts.go`/`handoff.go` presence by
  character), `server/zone/internal/combat/player.go` (`InCombatWithin`).
- `client/src/social/travel.ts`, `client/src/social/ui/{FriendsPanel,
  TravelOverlay, SocialOverlay}.tsx`.
