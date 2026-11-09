# 0016: Multiple zones and handoff

WP16 · 2026-11-08 · Spec 4, 9 ("Zones and handoff"), 11, 13 (spot failover), 14 (soak scenario 2)

## Context

Until WP16 one zone process owned the whole world. Spec 9 asks for zones owning sets of regions, assigned by the director through the Redis registry; a 64 m ghost band so players see across borders; pre-connect and a transfer the player never notices; a world presence feed for the far ring; and (spec 13) a dead spot zone's regions failing over to the primary from the last checkpoint with clients reconnecting on their own. Single-zone dev must not change.

## Decisions

### 1. Ownership is a pure function of the registry

`zoneregistry.Owner(live, region)`: the live zone that lists the region explicitly, else the fallback (the `primary`, or a legacy zone announcing no regions and no role); ties to the lowest zone id, **never to load**. The director's routing, every zone's handoff checks and the bots all evaluate the same function on the same `zones:{worldId}` read, so they agree. (WP04's `Pick` balanced equal zones by player count; two zones splitting the players in one place could not see each other, so the director now routes with `Owner`. `Pick` is kept for compatibility.)

Cluster zones heartbeat every second and declare `ttlMs` 3000, so a killed zone's regions belong to the primary about 3 s after its last heartbeat, with nobody having to notice the death.

### 2. The director assigns regions to pool zones

Roles: `primary` (owns what nobody claims; the failover target, spec 13: on regular pricing), `pool` (owns only what the director assigns: spot capacity), or regions pinned by config (`LODESTONE_ZONE_REGIONS`). The director's assigner (`internal/director/assign.go`, every 2 s, Redis lease per world) computes `zoneregistry.Plan`: sticky (moving a region costs every player in it a handoff); a dead pool zone's regions go back to the primary; a new pool zone gets `ceil(n/(k+1))` of the primary's regions in x-major order (contiguous stripes). Pool zones read `zoneassign:{worldId}` on each heartbeat and announce it. A director scaled to zero assigns nothing new, but routing and failover keep working (decision 1).

When ownership changes under players (assignment, failover, a zone joining), the same per-player check that handles walking hands them over: every zone checks each player at 10 Hz and transfers anyone standing 2 m inside a region it does not own.

### 3. Handoff protocol: pre-connect token, standby connection, Welcome = switch

See `server/zone/internal/game/handoff.go` (header) and CR 008.

1. Within 64 m of a foreign region the owner A stores a single-use token in Redis and sends `ZoneTransfer{kind 0, B's endpoints, token}`. The client connects to B and says Hello with the token; B holds a **standby session** (no entity) and tells A `ready`.
2. 2 m inside B's region, if B is ready, A builds a `HandoffState` (movement state bit-exact, last applied input seq and frame, observers' extrapolated view, health, level, exploration progress, local-save state, party, checkpoint epoch, registered extension fields), queues the transfer checkpoint, turns the entity into a mirror with the same id, keeps the client's connection as **its** standby, stores the state and tells B `transfer`.
3. B takes the state (GETDEL: exactly once) and admits the standby session on its next tick with the same entity id and state; input continues at `lastSeq + 1`. B's **Welcome** on that connection is the client's switch signal: it swaps connections, resets the snapshot decoder and resends unacknowledged inputs; prediction, interpolation and clock carry on (zone clocks are all Unix time). B's first snapshot acks `lastSeq` with exactly the state the client predicted: **no correction**.

Walking back costs no pre-connect: A kept the old connection and told B it was ready implicitly with the transfer.

Why a Redis token rather than a ticket the zone signs: zones hold only the director's public key (spec 9 security); a token carries the identity A already verified, is single use, and needs no new key distribution. Why the Welcome as the switch: it is the first message the new zone sends anyway, so the switch costs no extra round trip, and the client needs no knowledge of server timing.

**Nobody is dropped for a slow or failed pre-connect**: A keeps simulating a player past its border until B is ready (every zone can simulate anywhere: the terrain is the same wasm). Observers across the line see them through the ghost band meanwhile.

### 4. One entity id per character, world-wide

`Cluster.EntityID` (Redis `entid:{worldId}`: 2^30 + n). Observers on both sides keep one interpolation track through a handoff: the entity goes from local to mirrored (or back) in the same tick, with no removal and no first sight. Zone-local entities (pickups, enemies) use per-zone ranges `slot << 24`. `Server.ents` is now kept sorted by sorted insert (ids are no longer allocated in join order).

### 5. Mirrors live outside the simulation

Mirrored entities (`s.cl.remote`) never enter `Server.ents`: enemy AI, checkpoints, exploration, mining, earshot and every other per-entity loop keep seeing only what the zone owns (important while WP13 builds enemies that target players). They join the AOI grid after the local entities and reach clients exactly like local ones; interest is sorted by entity id for the encoder.

- **Ghost band**: each zone broadcasts (`ghost:{worldId}`) its entities within 64 m of a foreign region every tick and **within 200 m at 10 Hz**. The 200 m tier is an addition to the spec's 64 m: an entity d metres from the border is at least d metres from any foreign player, so this covers everything a foreign player can see in the near and mid rings at those rings' own rates.
- **Far ring**: the presence feed `worldpos:{worldId}` (spec 11), every player once a second, with party ids, so the party ring works across zones too. Presence never overrides a ghost record less than 600 ms old.
- Each record carries its source server time; receivers extrapolate it along its wire velocity to their own tick (capped at 300 ms for ghosts, 1.2 s for presence), so a record that crosses a tick boundary on its way through Redis does not show as a stutter.

### 6. Checkpoint ordering: epoch fence

Two zones' write-behind queues can hold writes for one character around a handoff (or a release); the old owner's may land late (a retry against a slow Postgres). Every cluster owner writes with an epoch (Unix ms at admission, always above the previous owner's: `max(now, previous + 1)`) stored as `characters.position.e`, and Postgres refuses older epochs (`WHERE COALESCE((position->>'e')::bigint, 0) <= $epoch`; progress saves bump it too). The new owner checkpoints in full at admission, so its state always survives whatever order the queues drain in. No migration: the key rides in the existing jsonb; single-zone zones use the original statements. Test: `TestStaleCheckpointIsFencedAfterHandoff` (A's queue blocked until after B wrote).

### 7. Duplicate login across zones: release

Every cluster login swaps its zone into `owner:{worldId}:{charId}`. If another **live** zone held it, the new zone asks it to `release` (pub/sub) and waits up to 1.5 s: the old zone kicks its session (`duplicate_login`), and hands over the live state exactly like a transfer. A dead previous owner is skipped (the checkpoint is used). So no character is ever simulated (and no inventory ever held authoritatively) by two zones.

### 8. Failover = the client reconnects through the director

When the active connection drops without a terminal kick, the client (`ZoneSession` with a `reconnect` callback; the bots likewise) asks the director for a fresh ticket, connects to the region's owner now (backoff 0.25 → 2 s, gives up after 60 s), and snaps to the checkpoint the new zone loaded (a forced correction from the first snapshot; nothing is sent until the renderer took it). This is spec 13's "from the last checkpoint": positions are up to `SAVE_INTERVAL_S` (30 s) old, plus the saves made on every handoff. Using the presence feed as a fresher position source was considered and rejected for v1: the spec names the checkpoint, and a Redis-only position would make Postgres no longer the single durable truth.

### 9. Cluster mode is opt-in

`LODESTONE_ZONE_CLUSTER=1` (or `_ROLE` / `_REGIONS`). Without it a zone behaves exactly as before (no Redis keys beyond WP03's registry entry, local entity ids, unfenced checkpoints). All zones of one world must run in cluster mode.

## Rejected

- **Direct zone-to-zone connections** for ghosts and control: Redis pub/sub already exists on every deployment, measured at well under a millisecond locally, and keeps zones from needing to know each other's internal addresses.
- **Handing off on the client's request** (client decides when it crossed): the server knows ownership and the authoritative position; the client only learns where to pre-connect.
- **Keeping one connection and proxying through the old zone**: doubles bandwidth and latency through the old zone for the rest of the session.
- **Load-balanced duplicates of a region** (WP04's fewest-players pick): players in the same place on different zones can't see each other.

## Known limits

- Earshot (WP11) is still per zone: players on two sides of a border are in each other's ghost band but not each other's earshot. Fix: the earshot runner can take mirrored entities as speakers-only (not listeners) once the voice package agrees on the semantics.
- WebTransport per-chunk streams don't exist yet (WP06 gap), so WorldEdits ride the reliable stream on whichever connection is active; a client re-receives a chunk's edits from the new zone on first interest.
- ~~The director's assigner never rebalances live pool zones by load (sticky by design); WP19 decides rebalancing from soak numbers.~~ WP19b: zones report players per region (`Entry.Load`) and the assigner moves at most one region per 10 s off a zone above 200 players and 1.2x the mean (`zoneregistry.Rebalance`, `server/director/README.md` "Load moves"); the region's players are handed over like a border crossing. Plan stays sticky otherwise.
- Failover rewinds a player to the last checkpoint (up to 30 s), as the spec says.
- WP13 combat crosses a handoff as the profile plus runtime state (HP, mana, seq-based cooldowns as they are, tick timers as time remaining; `internal/combat/handoff.go`); the strike action log and frame ring do not (a claim racing the switch is refused as stale). WP13's combat profile saves are not epoch-fenced yet.
