# server/director

The director (spec 4, 9, 13; WP04). Go module `lodestone/server/director`.

Given a session (account or local profile) and a character, it reads the Redis zone registry (`zones:{worldId}`, `server/pkg/zoneregistry`), picks the zone that owns the character's region, and signs two 60 s Ed25519 connect tickets (`server/pkg/ticket`): one for that zone (audience `zone:<zoneId>`) and one for the social service (audience `social`). If no zone is live it answers 503 `waking_world` and the client retries.

## Run

```
npm run infra:up && npm run migrate
go run ./server/account     # sessions + characters (and seeds the official world)
go run ./server/director    # :8090
go run ./server/director/cmd/fakezone   # optional: pretend a zone is up until WP03's zone runs
```

| Env var | Default | Meaning |
| --- | --- | --- |
| `LODESTONE_DIRECTOR_PORT` | `8090` | Listen port |
| `LODESTONE_PG_URL`, `LODESTONE_REDIS_ADDR` | local compose | Postgres (characters, accounts) / Redis (zone registry, save counters) |
| `LODESTONE_TICKET_PRIVATE_KEY` | dev key + warning | base64 Ed25519 seed that signs tickets; zones/social hold the public key |
| `LODESTONE_SESSION_PUBLIC_KEY` | dev key + warning | Verifies account-service sessions offline |
| `LODESTONE_SAVE_PUBLIC_KEY` | dev key + warning | Verifies local save blobs |
| `LODESTONE_SOCIAL_URL` | `ws://localhost:<LODESTONE_SOCIAL_PORT>/ws` | Returned to clients as `socialEndpoint` |
| `LODESTONE_ENV` | `development` | `production` refuses all development keys |
| `LODESTONE_CORS_ORIGIN` | `*` | CORS origin |

## Test

```
cd server/director && go test ./...    # HTTP + Postgres + Redis integration with fake registry entries
node client/src/account/dev/acceptance.mjs   # from repo root: browser → director → ticket → Go ticket.Verify
```

## Zone selection

1. Region = `floor(position / 1024 m)` on x and z, clamped to the 4×4 world (`accountapi.RegionOf`). Position comes from the character row, or for local profiles from the presented save blob (spawn if none).
2. Live entries only (heartbeat within 15 s).
3. WP16: the region's owner by `zoneregistry.Owner`, the same function every cluster zone uses: a zone listing the region explicitly wins over the primary / whole-world zones; ties go to the lowest zone id, never to load (players split across two zones in one place could not see each other). In v1 a single whole-world zone takes everyone.
4. None: `503 waking_world` with `Retry-After: 5`. Waking the game VM on demand (spec 13) is WP19's infra hook; this service only reports.

## Errors

`{"error": "<code>", "message": "…", "retryAfterS": 5?}`, same convention as the account service.

## Endpoints

`🔒` = `Authorization: Bearer <session>` from the account service.

### `POST /v1/connect` 🔒
```
→ {"characterId": "uuid", "save": SaveBlob?}
```
`save` is for local-profile characters: the newest blob from IndexedDB. When present it must belong to the session's profile and this character, pass the signature and be the newest counter; its position picks the region. The zone verifies it again on connect (with `localsave.Store.Verify`), which is what actually protects the state.
```json
← 200 {
  "ticket": "<opaque, audience zone:<zoneId>>",
  "socialTicket": "<opaque, audience social>",
  "expiresAt": 1762600060000,
  "zone": {"zoneId": "zone-1", "endpoint": "ws://localhost:8092/ws", "wtEndpoint": "https://…"?},
  "socialEndpoint": "ws://localhost:8093/ws",
  "worldId": "uuid",
  "region": {"x": 2, "z": 2},
  "character": {"id": "uuid", "worldId": "uuid", "name": "Nicole", "level": 1, "xp": 0, "position": {…}, "local": false, …},
  "isLocalProfile": false
}
```
| Status | `error` | When |
| --- | --- | --- |
| 400 | `bad_request` | characterId not a UUID; save sent for an account character |
| 400 | `bad_signature` | edited save |
| 401 | `unauthorized` | missing/invalid/expired session |
| 403 | `account_suspended` / `account_banned` | checked on every connect, not only at sign-in |
| 403 | `wrong_profile` | save belongs to another profile/character |
| 404 | `not_found` | no such character for this session (someone else's looks the same) |
| 409 | `stale_save` | an older save than the newest issued |
| 410 | `profile_upgraded` | the local profile was moved into an account |
| 503 | `waking_world` | no live zone owns the region; retry after `retryAfterS` |

**Tickets** (`server/pkg/ticket`): `base64url(payload || Ed25519 sig)`, payload = format byte, accountId, profileId, characterId, characterName, worldId, audience, isLocalProfile, issuedAt ms, expiresAt ms (60 s, `TICKET_TTL_S`). Zones call `ticket.Verify(pub, t, ticket.AudienceZone(myZoneID), now)`; the social service uses `ticket.AudienceSocial`. Exactly one of accountId / profileId is set; `isLocalProfile` drives the spec 10 limits (listen-only voice, no global chat, whispers to friends/party only).

### `POST /v1/social-ticket` 🔒
Fresh social ticket only, for reconnecting the social socket without a zone pick.
```
→ {"characterId": "uuid"}
← 200 {"socialTicket": "…", "expiresAt": 1762600060000, "socialEndpoint": "ws://…"}
```
Same 400/401/403/404/410 errors as `/v1/connect`.

### `GET /v1/worlds`
Same response as the account service's `GET /v1/worlds`.

### `GET /v1/worlds/{worldId}/status`
Cheap poll for the "waking the world" screen.
```json
{"worldId": "uuid", "awake": true, "zones": 1, "players": 3}
```

### `GET /healthz`, `GET /metrics`
Metrics: `director_tickets_issued_total{kind}`, `director_waking_total`, `director_errors_total`.

## Layout

| Path | What |
| --- | --- |
| `main.go` | Config, keys, production guards |
| `internal/director` | Handlers, zone selection, tests (incl. `TestAcceptanceTicketFile`, which verifies tickets a real browser received) |
| `cmd/fakezone` | Announces a fake zone with heartbeats (dev/e2e until WP03's zone runs) |

## Wake on demand (WP18)

`internal/wake` starts the game VM when a player shows up and stops it after
15 minutes with nobody online (spec 13; decision 0018). Off by default: with
no `LODESTONE_WAKE_PROVIDER` the world is always awake and `POST /v1/wake`
answers `{"state":"awake","awake":true,"provider":"none"}`.

| Env var | Default | Meaning |
| --- | --- | --- |
| `LODESTONE_WAKE_PROVIDER` | `none` | `gce` (Compute Engine REST, metadata-server token) or `fake` (in-process, for the rehearsal) |
| `LODESTONE_WAKE_GCE_PROJECT` / `_ZONE` / `_INSTANCE` | | The game VM (gce) |
| `LODESTONE_WAKE_IDLE` | `15m` | Stop after this long with nobody online |
| `LODESTONE_WAKE_READY_URLS` | | Comma-separated URLs that must answer 2xx before the world counts as awake (zone/social `/healthz`) |
| `LODESTONE_WAKE_CRON_TOKEN` | | Enables `POST /internal/wake/tick` (Cloud Scheduler, `Authorization: Bearer <token>`) |
| `LODESTONE_WAKE_CHECK_EVERY` | `1m` | In-process idle check while an instance is alive |
| `LODESTONE_WAKE_FAKE_BOOT` | `8s` | Simulated boot time (fake) |
| `LODESTONE_LAZY_DEPS` | off | `1` on Cloud Run: start even when Postgres/Redis (on the sleeping VM) are unreachable |

- `POST /v1/wake` (public, no session: the client calls it before sign-in) ->
  `{"state":"awake|starting|booting|stopping|unknown","awake":bool,"provider":"gce","retryAfterS":3}`; starts a stopped VM.
- With a provider, `POST /v1/connect` and `POST /v1/social-ticket` answer
  `503 waking_world` (`Retry-After`) until awake, before touching Postgres.
- Idle: last activity in Redis (`wake:lastActive`), players from the zone
  registry; the VM's last start time is the floor when Redis is unreachable.
- Metrics: `director_wake_starts_total`, `_stops_total`, `_errors_total`,
  `director_wake_players_online`, `director_wake_idle_seconds`.
- Tests: `go test ./internal/wake` (fake clock: start, debounce, readiness,
  15-minute stop, players keep it awake, broken store, provider outage, HTTP
  gate and cron auth, GCE REST against a fake Compute API, Redis store).

## Region assignment (WP16)

The director assigns regions to pool zones (spec 9: "assigned by the director through the Redis zone registry"): every `LODESTONE_DIRECTOR_ASSIGN_EVERY` (2 s; 0 disables) it scans `zones:*`, takes a per-world Redis lease (`zoneassignlead:{worldId}`, so one Cloud Run instance writes), computes `zoneregistry.Plan` and writes `zoneassign:{worldId}` when it changed. Plan: sticky; a dead pool zone's regions go back to the primary; a joining pool zone takes ceil(n/(k+1)) of the primary's regions as a contiguous stripe; regions pinned by a zone's own config are left alone. Worlds with only legacy (role-less) zones are untouched. Failover does not depend on this loop: the dead zone's entry goes stale after its own 3 s TTL and `Owner` already routes its regions to the primary. Details: `docs/decisions/0016-handoff.md`, `internal/director/assign.go`.

### Load moves (WP19b)

Plan alone never rebalances (moving a region hands off everyone in it), which in WP19's thailand failover run left one pool zone with 612 players (tick p99 49 ms) next to zones with 100-280. Zones now report players per region in their heartbeat (`Entry.Load`), and after Plan settles the assigner runs `zoneregistry.Rebalance`: when the busiest zone is above `Floor` (200) players and above 1.2x the mean of the primary and pool zones, it moves the one region that leaves the busier side of the pair lowest (ties: a region bordering the receiver) to another zone, if that lowers the busy zone by at least 25 players. One move per world per `LODESTONE_DIRECTOR_REBALANCE_COOLDOWN` (10 s), so zones finish the handoffs and report new loads before the next. Players in a moved region are handed over by the zones exactly as at a border (WP16: pre-connect, transfer, no loading screen). After failover the dead zone's regions spread over the survivors; a pool zone that comes back gets Plan's stripe and then the crowded regions. `LODESTONE_DIRECTOR_REBALANCE=0` turns it off; `LODESTONE_DIRECTOR_REBALANCE_FLOOR` sets the floor. Metric `director_region_load_moves_total`; each move is logged ("region moved for load"). Tests: `zoneregistry/rebalance_test.go`, `TestAssignerRebalancesByLoad`.
