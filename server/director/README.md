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
3. Zones that list the region explicitly win over whole-world zones (`regions: []`); among equals, fewest players (`zoneregistry.Pick`). In v1 a single whole-world zone takes everyone.
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
