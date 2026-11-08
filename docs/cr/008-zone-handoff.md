# CR 008: Zone handoff (ZoneTransfer v4) and the zone cluster keys

Author: WP16 · Date: 2026-11-08 · Status: applied on `wp/16-handoff`

## What

1. **`contracts/protocol.yaml` version 3 → 4 (additive):** `ZoneTransfer` (id 72, s2c, reliable; defined by WP00, never sent before) gets its meaning and two appended fields:

   | Field | Type | Meaning |
   | --- | --- | --- |
   | `zoneId` | string | the zone this is about |
   | `endpoint` | string | its WebSocket URL |
   | `ticket` | bytes | a single-use pre-connect token, valid 60 s (opaque: `ho1.<hex>`) |
   | `kind` (new) | u8 | 0 = pre-connect, 1 = cancel |
   | `wtEndpoint` (new) | string | its WebTransport URL (`#certHash=` fragment included) or empty |

   - **kind 0, pre-connect.** Sent by the zone that owns the player when they come within `GHOST_BAND_M` (64 m) of a region another zone owns (or stand in one). The client opens a second connection to `zoneId` and sends `Hello` with `ticket` in place of a director ticket. That zone keeps the connection on standby: no Welcome, no snapshots, ClockPong only.
   - **The switch is that zone's `Welcome` on the standby connection** (no new message): it means ownership moved there. The client makes that connection the active one, resets its snapshot decoder, resends every input frame after its last acknowledged one, and keeps prediction, interpolation and clock. The new zone continues the exact movement state at the old zone's last applied input, so its first snapshot agrees with the prediction. The old connection stays open as the old zone's standby for the way back.
   - **kind 1, cancel.** The player left the band (plus 16 m): close the standby connection to `zoneId`.
   - `KickCode.transferred` (7, already defined) is used when a zone drops a standby connection (idle 10 min, replaced, or the player logged in elsewhere).

2. **New zone-to-zone and registry keys (Redis, not codegen contracts).** Formats live in `server/zone/internal/game/cluster.go` (Go only: only zones read them) and `server/pkg/zoneregistry`:

   | Key | Holds |
   | --- | --- |
   | `zones:{worldId}` (existing) | entries gain `role` (`primary` / `pool`, empty = legacy whole-world zone), `ttlMs` (own staleness, 3 s in cluster mode) and `debug` (tools' HTTP base) |
   | `zoneassign:{worldId}` | the director's region assignment: zoneId → regions (pool zones announce theirs) |
   | `zoneassignlead:{worldId}` | director instance lease for writing it |
   | `zoneslot:{worldId}` | counter: each cluster zone's local entity id range (slot << 24) |
   | `zone:{worldId}:{zoneId}` | pub/sub: control messages to one zone (`ready`, `unready`, `transfer`, `release`, `none`; JSON). Spec 11 names `zone:{zoneId}`; the world is added so concurrent worlds on one Redis never collide |
   | `ghost:{worldId}` | pub/sub: ghost-band frames (binary, version byte 1), every zone, 30 Hz |
   | `hotoken:{worldId}:{token}` | pre-connect token record (60 s, single use: GETDEL) |
   | `hostate:{worldId}:{id}` | a handoff state in flight (60 s, single use: GETDEL) |
   | `owner:{worldId}:{charId}` | the zone that owns a character now (cross-zone duplicate login) |
   | `entid:{worldId}`, `entid:{worldId}:next` | world-stable player entity ids (2^30 + n) |
   | `worldpos:{worldId}` (spec 11) | presence feed: every player once a second (binary record, version byte 1) |

3. **`characters.position` gains an optional `"e"` key** (no migration): the checkpoint epoch of the zone that wrote it. Cluster zones write with a fenced `UPDATE … WHERE COALESCE((position->>'e')::bigint, 0) <= $epoch`; single-zone zones keep the original statement. Every existing reader decodes `{x, y, z}` and ignores the extra key.

Regenerated with `npm run gen`: `contracts/ts/src/gen/protocol.ts`, `server/pkg/proto/protocol_gen.go`, `contracts/golden/protocol_vectors.json` (`PROTOCOL_VERSION` 4).

## Why

- Spec 9 "Zones and handoff": "When a player enters the ghost band, the client pre-connects to the next zone with a ticket; ownership transfers when they cross. The player never sees a loading screen." The pre-connect needs endpoints (both transports) and a credential the neighbor accepts; the switch needs no extra round trip, so the neighbor's Welcome is the signal.
- The pre-connect credential is a Redis token rather than a signed ticket: zones hold only the director's public key, the token is single use and carries the identity the old zone verified, and it needs no new key distribution.
- The registry fields make ownership a pure function of the live entries (`zoneregistry.Owner`) that every zone, the director and the bots compute identically, and let a dead spot zone's regions fail over in ~3 s (spec 13).

## Consumers affected

| Consumer | Change |
| --- | --- |
| `server/zone` | Sends ZoneTransfer, accepts `ho1.` tokens as standby sessions, transfers/admits (`internal/game/handoff.go`), ghosts and presence (`ghosts.go`), Redis plumbing (`internal/cluster`), cluster mode wiring (`cluster.go`). Off unless `LODESTONE_ZONE_CLUSTER`/`_ROLE`/`_REGIONS` is set. |
| `client/src/net` | `zoneSession.ts` handles ZoneTransfer, standby connections, the switch and failover; `NetPlay.tsx` passes `zoneId` and a `reconnect` callback. Hello sends `PROTOCOL_VERSION` 4 automatically. |
| `tools/bots` | Follow handoffs and fail over with `-cluster`; speak v4 after a rebuild |
| `server/director` | Routes with `zoneregistry.Owner`, runs the region assigner (`LODESTONE_DIRECTOR_ASSIGN_EVERY`, default 2 s) |
| `server/pkg/zoneregistry` | `Role`, `TTLMs`, `Debug`, `Owner`, `RegionAt`, `Plan`, assignment helpers (additive; `Pick` unchanged) |
| `server/social`, account | None (the registry stays readable; positions keep `{x, y, z}`) |

The zone kicks clients whose `Hello.protocolVersion` differs, so v3 clients must be rebuilt (every client in the repo reads the generated constant). WP13 (combat) and WP20 (towns) branches regenerate on merge; a package that adds per-character zone state registers a `game.HandoffField` so it survives handoffs (server/zone/README.md "Multiple zones").
