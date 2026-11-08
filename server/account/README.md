# server/account

The account service (spec 4, 11; WP04). Go module `lodestone/server/account`.

- Sign-in: Firebase Auth ID tokens (Google first), plus a **dev provider** (sign in by username) for local work.
- Local profiles: browser-generated profiles whose characters live in IndexedDB as signed save blobs; export/import; upgrade into an account.
- Worlds and characters: world list, character create/list (names unique per world, case-insensitive, across account and local characters).
- Seeds one official world on startup if none exists, minted with `worldgen.wasm` (WP07: `spec_from_seed`, gen_version, atlas_hash via `server/pkg/worldhost/mintdb`; a placeholder row from before is upgraded in place, keeping its seed; without a built wasm it stays a placeholder and zones derive it from the seed).

Connect tickets come from the **director** (`server/director/README.md`), not from here.

## Run

```
npm run infra:up && npm run migrate
go run ./server/account                  # :8091, dev auth on, dev keys (warns)
```

| Env var | Default | Meaning |
| --- | --- | --- |
| `LODESTONE_ACCOUNT_PORT` | `8091` | Listen port |
| `LODESTONE_PG_URL`, `LODESTONE_REDIS_ADDR` | local compose | Postgres / Redis |
| `LODESTONE_ENV` | `development` | `production` refuses dev auth and every development key, and requires a Firebase project |
| `LODESTONE_DEV_AUTH` | on unless production | Enables `POST /v1/auth/dev` and `POST /v1/dev/local/resave` |
| `LODESTONE_FIREBASE_PROJECT_ID` | unset | Enables Firebase sign-in for that project |
| `LODESTONE_FIREBASE_PROVIDERS` | `google.com` | Allowed `firebase.sign_in_provider` values (comma list); stored as `auth_provider` minus `.com` |
| `LODESTONE_FIREBASE_JWKS_URL` | Google securetoken JWKS | Override for tests |
| `LODESTONE_SESSION_PRIVATE_KEY` | dev key + warning | base64 Ed25519 seed (32 bytes) that signs session tokens |
| `LODESTONE_SAVE_PRIVATE_KEY` | dev key + warning | base64 Ed25519 seed that signs local save blobs (the zone needs the same key) |
| `LODESTONE_SESSION_TTL` | `12h` | Session lifetime |
| `LODESTONE_WORLD_SEED` / `LODESTONE_WORLD_NAME` | `20261108` / `Lodestone` | Official world seeded on first start |
| `LODESTONE_WORLDGEN_WASM` | `worldgen/pkg/worldgen.wasm` | Module used to mint the official world (WP07) |
| `LODESTONE_CORS_ORIGIN` | `*` | CORS origin for the browser client |

Generate production keys with e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`; the director needs the matching public keys (`LODESTONE_SESSION_PUBLIC_KEY`, `LODESTONE_SAVE_PUBLIC_KEY`).

## Test

```
cd server/account && go test ./...        # unit + HTTP/Postgres/Redis integration (scratch DB per test)
node client/src/account/dev/acceptance.mjs  # headless browser end to end (from repo root)
```

Integration tests create and drop their own database (`lodestone_wp04_t_*`) and skip when infra is down unless `LODESTONE_REQUIRE_INFRA=1`. `go run ./server/account/cmd/devdb create|drop lodestone_wp04_<x>` makes a scratch database for manual runs.

## Session tokens

Every sign-in endpoint returns a session token. Format (documented so other services can verify it offline):

```
lss1.<base64url(JSON payload)>.<base64url(Ed25519 signature over "lss1." + payload part)>
payload: {"k":"account"|"local","sub":"<accountId or profileId>","prov":"google|dev|local","name":"…","iat":<unix ms>,"exp":<unix ms>}
```

Lifetime 12 h (`LODESTONE_SESSION_TTL`), no refresh: sign in again (Firebase refreshes its own ID token; local profiles re-open with their secret). Send as `Authorization: Bearer <session>`. Verify with `accountapi.VerifySession` (`server/pkg/accountapi`). A session only lets you ask for things; zones and social trust only the 60 s connect tickets from the director.

## Errors

Non-2xx responses are `{"error": "<code>", "message": "<human text>"}`. Codes are stable; messages may change.

## Endpoints

All bodies are JSON. `🔒` = requires `Authorization: Bearer <session>`.

### `GET /v1/auth/config`
Which sign-in options to show.
```json
{"devAuth": true, "firebase": {"projectId": "lodestone-prod"} | null, "localProfiles": true, "providers": ["google.com"]}
```

### `POST /v1/auth/firebase`
Exchange a Firebase ID token (from `user.getIdToken()`) for a session. The token is verified server-side: RS256 against Google's securetoken JWKS (cached per `Cache-Control`, refetched on unknown `kid` at most once a minute), `iss = https://securetoken.google.com/<project>`, `aud = <project>`, `exp`/`iat`/`auth_time` with 5 min skew, `sub` 1–128 chars. The account row is `(auth_provider = "google", auth_subject = <Firebase uid>)`.
```
→ {"idToken": "<jwt>"}
← 200 SessionResponse
   401 invalid_token · 403 provider_not_allowed · 403 account_suspended|account_banned · 404 firebase_disabled · 503 auth_unavailable (Google keys unreachable)
```
`SessionResponse`:
```json
{"session": "lss1…", "expiresAt": 1762600000000, "kind": "account",
 "account": {"id": "uuid", "provider": "google", "status": "active", "createdAt": "…"}, "name": "Nicole"}
```

### `POST /v1/auth/dev` (dev auth only)
Sign in by username; creates account `(auth_provider "dev", auth_subject lower(username))`. Refused in production.
```
→ {"username": "nicole"}            3-32 of a-z 0-9 _ -  (case-insensitive)
← 200 SessionResponse · 400 invalid_username · 403 dev_auth_disabled
```

### `POST /v1/local/session`
Open (or on first sight, register) a local profile. The browser generates `profileId` (UUID v4) and `profileSecret` (base64url of 32 random bytes) and keeps both in IndexedDB; the server stores only a hash of the secret. Anyone holding both can play the profile, which is why the export file must be kept private.
```
→ {"profileId": "uuid", "profileSecret": "43+ chars"}
← 200 {"session": "lss1…", "expiresAt": …, "kind": "local", "profile": {"id": "uuid", "createdAt": "…"}}
   400 bad_request · 403 profile_secret (id claimed by another secret) · 410 profile_upgraded
```

### `GET /v1/me` 🔒
```json
{"kind": "account", "subject": "uuid", "provider": "dev", "name": "nicole", "expiresAt": 0, "account": {…}}
{"kind": "local", "subject": "uuid", "provider": "local", "expiresAt": 0, "profile": {…}}
```

### `GET /v1/worlds`
```json
{"worlds": [{"id": "uuid", "name": "Lodestone", "seed": "20261108", "spec": {…}, "genVersion": "placeholder", "atlasHash": "placeholder", "official": true}]}
```
`seed` is a decimal string (uint64 does not fit a JS number). The director serves the same list.

### `GET /v1/characters?worldId=<uuid>` 🔒
The session owner's characters (`worldId` optional).
```json
{"characters": [{"id": "uuid", "worldId": "uuid", "name": "Nicole", "level": 1, "xp": 0,
  "position": {"x": 2048, "y": 0, "z": 2048}, "local": false, "accountId": "uuid", "createdAt": "…"}]}
```
For local characters (`"local": true, "profileId": …`) level/xp/position are placeholders: the truth is in the save blob.

### `POST /v1/characters` 🔒
```
→ {"worldId": "uuid", "name": "Nicole", "appearance": {…optional, ≤4 KB}}
← 201 {"character": Character, "save": SaveBlob | absent}
   400 invalid_name|bad_request · 404 world_not_found · 409 name_taken|too_many_characters (8 per world) · 410 profile_upgraded
```
Names: 3–16 characters, ASCII letters, digits and `_`, starting with a letter, no `__`, not reserved (admin, system, gm, …). Unique per world, case-insensitive, across account and local characters. New characters start at `(2048, 0, 2048)`, `y = 0` meaning "snap to ground" (placeholder until worldgen supplies a spawn). For a **local** session the response carries the first signed save blob (counter 1), which the browser must store.

`SaveBlob` (server/pkg/localsave):
```json
{"format": "lodestone-save", "v": 1, "profileId": "uuid", "characterId": "uuid", "worldId": "uuid",
 "counter": 1, "issuedAt": 1762600000000, "state": "<character state as JSON text>", "sig": "<base64url Ed25519>"}
```
Treat it as opaque: `state` is signed byte for byte. Its JSON shape is `localsave.State` (name, level, xp, position, lastWaypoint, staminaMax, appearance, progress{bitsets, skillTree, spells}, items[]).

### `POST /v1/local/saves/verify` 🔒 (local session)
Checks a blob: belongs to this profile, signature valid, counter is the newest issued. Used by Import.
```
→ {"save": SaveBlob}
← 200 {"ok": true, "counter": 2, "characterId": "uuid", "name": "Wanderer", "level": 4}
   400 bad_signature (edited or not ours) · 403 wrong_profile · 409 stale_save (older than the newest) · 409 no_record
```

### `POST /v1/local/upgrade` 🔒 (account session)
Moves every character of a local profile into the signed-in account, in one Postgres transaction, copying each character's verified save state into `characters`, `character_progress` and `items`. Character ids and names are kept. Afterwards the profile is retired (`410 profile_upgraded` on its sessions) and its `localsave:` record is dropped; the browser copy is only a cache.
```
→ {"localSession": "<the profile's own session token>", "saves": [SaveBlob, …]}   newest blob for EVERY character of the profile
← 200 {"accountId": "uuid", "characters": [Character, …]}
   400 bad_signature · 401 unauthorized (localSession) · 403 account_only|wrong_profile · 409 stale_save|upgrade_mismatch · 410 profile_upgraded
```

### `POST /v1/dev/local/resave` 🔒 (dev auth only, local session)
Stands in for a zone save point until WP06/WP14: verifies the presented blob, optionally changes level/xp/position, and issues the next counter.
```
→ {"save": SaveBlob, "set": {"level": 4, "xp": 777, "position": {"x":…,"y":…,"z":…}}}
← 200 {"save": SaveBlob}   (counter + 1)
```

### `GET /healthz`, `GET /metrics`
From `server/pkg/svc`. Metrics: `account_sessions_issued_total{provider}`, `account_characters_created_total{kind}`, `account_saves_rejected_total{reason}`, `account_local_upgrades_total`, `account_firebase_rejected_total`, `account_errors_total`.

## Layout

| Path | What |
| --- | --- |
| `main.go` | Config, key loading, production guards, world seeding |
| `internal/api` | HTTP handlers + integration tests |
| `internal/firebase` | Firebase ID token verifier (no Admin SDK) + tests against a mock JWKS |
| `cmd/devdb` | Create/drop scratch databases for e2e runs |
| `../pkg/accountapi` | Session tokens and the shared Postgres queries (also used by the director) |
| `../pkg/localsave` | Save blob signing/verification and Redis counters (also used by the zone) |
