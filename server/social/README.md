# server/social

The social service (spec 10, WP08). Go module `lodestone/server/social`.
Chat channels, whispers, parties, friends, presence and moderation over the
JSON WebSocket defined in `contracts/social.yaml` (v2). Decisions:
`docs/decisions/0008-social-service.md`.

## Run

```
npm run infra:up && npm run migrate        # needs migration 0003_social
go run ./server/social                     # :8093, /ws, /healthz, /metrics
```

| Env var | Default | Meaning |
| --- | --- | --- |
| `LODESTONE_SOCIAL_PORT` | `8093` | Listen port |
| `LODESTONE_PG_URL`, `LODESTONE_REDIS_ADDR` | local compose | Postgres (relations, reports) / Redis (presence, parties, history, pub/sub) |
| `LODESTONE_TICKET_PUBLIC_KEY` | dev key + warning | Verifies the director's social tickets; refused unset in production |
| `LODESTONE_CORS_ORIGIN` | `*` | Allowed browser origins for `/ws` (comma list) |
| `LODESTONE_SOCIAL_PRESENCE_TTL` | `30s` | Presence TTL (`PRESENCE_TTL_S`); heartbeat every third of it |
| `LODESTONE_SOCIAL_REAP_EVERY` | `10s` | Dead-session reaper interval |
| `LODESTONE_SOCIAL_PARTY_GRACE` | `5m` | Party membership kept while offline (`PARTY_RECONNECT_GRACE_S`) |

Several processes may serve one world: everything goes through Redis.

## Protocol in practice

1. Connect to `/ws`, send `{"type":"auth","ticket":"<socialTicket>"}` within 10 s. The ticket comes from the director (`POST /v1/connect` or `POST /v1/social-ticket`, audience `social`, 60 s).
2. Server sends `welcome`, `relations`, `history` for global, system and each whisper conversation of the last 24 h, `party_state` (if in a party, plus party `history`) and `friends`.
3. Client sends `presence` (region, x, z, zoneId) at about 2 Hz while moving; the first one (and every region change) brings zone `history`. Local chat uses these positions.
4. Duplicate login: the newest socket wins; the old one gets `error replaced` and is closed (on any process).

| Channel | Recipients | Stored (Redis) |
| --- | --- | --- |
| global | everyone in the world | `chat:{w}:global`, 200 |
| zone | sessions whose last presence region equals the sender's | `chat:{w}:zone:{region}`, 100 |
| local | sessions within 30 m of the sender's last presence (message carries x, z for bubbles) | none |
| party | party members | `chat:{w}:party:{partyId}`, 100 |
| whisper | target + sender echo (`toName`) | `chat:{w}:whisper:{a}:{b}`, 100, 24 h |
| system | one player (service notices; zones can publish loot/discovery lines) | `chat:{w}:system:{charId}`, 50 |

Rules (spec 10/11): 280 characters; global slow mode 1 per 10 s; per-channel token buckets (`internal/social/limits.go`: zone 4 burst / 0.5 s⁻¹, local 5 / 1, party 8 / 1, whisper 5 / 1, social actions 10 / 0.5, reports 3 / per minute, every frame 30 / 15); limit errors are sent at most once per second per code. Profanity filter (global and zone, on by default, per-reader `set_filter`) applied on delivery, raw text stored. Local profiles: no global sending (they read it), whispers only to friends and party. Whisper to an offline player: `whisper_status offline`, nothing stored. Whisper to someone who blocked you: you get your echo and `delivered`, they get nothing, nothing stored. Mute hides a player everywhere for you; block = mute + no whispers, no invites, ends friendship.

## Bus (pub/sub `social:{worldId}`)

Every delivery, local or not, is a JSON envelope published to `social:{worldId}` and routed by each process to its own sessions (`internal/social/bus.go`). Other services may publish too, e.g. a zone sending a system line:

```json
{"k":"chat","w":"<worldId>","t":["<characterId>"],"m":{"id":"…","channel":"system","fromId":"","fromName":"","text":"You found a waypoint.","ts":1762600000000}}
```

(prefer storing it in `chat:{w}:system:{charId}` too, as `Hub.SystemMessage` does). Kinds: `chat`, `frame` (prebuilt s2c frame to targets), `friends` (targets refresh), `kick`, `admin` (status change), `presence`.

## Redis keys

`presence:{charId}` (hash, TTL 30 s), `online:{worldId}` (hash char → session, walked by the reaper), `name:{worldId}:{lowercase}` → char id, `charname:{charId}` → name, `party:{id}` (JSON), `partyof:{charId}`, `partyinv:{charId}` (TTL 60 s), `partygrace:{worldId}` (zset of offline members' deadlines), `chat:*` lists above, `whisperconv:{worldId}:{charId}` (zset of partners), `social:worlds`. Full list with reasons in `internal/social/keys.go`.

## Postgres (migration 0003, CR 001)

Relations are keyed by **character id**: `social_friends`, `social_blocks`, `social_mutes`, `social_settings`; local-profile sanctions in `social_sanctions` (accounts use `accounts.status`); `moderation_log`; `reports` gained `world_id`, names and `reason`.

## Admin CLI

```
go run ./server/social/cmd/admin reports [-all] [-n 20]
go run ./server/social/cmd/admin report <id>                 # with the captured last 50 messages
go run ./server/social/cmd/admin resolve <id> "warned"
go run ./server/social/cmd/admin mute|unmute|suspend|ban|unban <CharacterName> [-world <uuid>] [-reason "..."]
go run ./server/social/cmd/admin whois <CharacterName>
```

Actions apply to the character's account (or local profile), are logged in `moderation_log`, and reach live sessions immediately over the bus (mute: can read, can't send; suspend/ban: disconnected and refused; the director also refuses suspended/banned accounts).

## Tools

| Command | What |
| --- | --- |
| `cmd/flood` | Bot flood: N clients flood every channel; reports accepted vs rejected per channel and checks no client beat its bucket (`-clients 50 -duration 20s -rate 40`) |
| `cmd/e2ezones` | E2E helper: announces `zone-west`/`zone-east` splitting the world, moves a character |

## Test

```
cd server/social && go test ./...        # unit + integration (scratch Postgres DB, shared Redis; skips if infra is down)
node client/src/social/dev/e2e.mjs       # from the repo root: 3 browsers via director tickets + admin CLI + flood
```

- `internal/social/unit_test.go`: filter, length, radius, buckets, party records.
- `internal/social/hub_test.go`: every channel, whisper rules (offline, unknown, block, local profiles), rate limits, history + filter + mute, party lifecycle and reconnect grace, friends, reports, duplicate login, bad tickets, admin mute/ban.
- `social_integration_test.go`: builds the binary and runs **two processes**; global, whisper, reply and party across processes and zones, block across processes, and the survivor reaping a killed process's session.

## Layout

| Path | What |
| --- | --- |
| `main.go` | Config, keys, pools, mounts `/ws` |
| `internal/social` | Hub, sessions, channels, whispers, parties, friends, moderation, store, bus |
| `internal/client` | Small Go client used by tests and the flood tool |
| `cmd/admin`, `cmd/flood`, `cmd/e2ezones` | CLIs above |
