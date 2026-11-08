# client/src/account

The account screen and everything behind it (WP04). Self-contained: WP02 mounts it, WP06 consumes what it hands over.

```tsx
import { AccountScreen, type ReadySession } from './account';

<AccountScreen onReady={(s: ReadySession) => startGame(s)} />
```

`ReadySession`: `ticket` (zone, 60 s), `socialTicket`, `ticketExpiresAt`, `zoneId`, `zoneEndpoint`, `zoneWtEndpoint?`, `socialEndpoint`, `worldId`, `character`, `isLocalProfile`, `session` (12 h, for new tickets), `save?` (local profiles: the newest blob to present to the zone), `refreshTickets()` (asks the director again, e.g. after the 60 s ticket expired or on zone handoff).

| File | What |
| --- | --- |
| `AccountScreen.tsx` | Choose account (Google via Firebase if configured, dev username if the server allows) or local profile; import a profile file; create/select a character; Play (retries through "Waking the world…"); Export; Upgrade to an account |
| `api.ts` | `LodestoneApi`: typed client for the account service and director; errors are `ApiError {status, code, message, retryAfterS}` |
| `saveStore.ts` | `SaveStore`: the local profile (`crypto.randomUUID()` id + 32-byte secret) and newest signed blob per character in IndexedDB; never overwrites a newer counter |
| `idb.ts` | The shared `lodestone` IndexedDB. Stores `profile`, `saves`; caches go in stores prefixed `cache:` (WP05), cleared by `clearCaches()` without touching saves. Modules add stores with `openLodestoneDb(specs)`, which bumps the version only when a store is missing, so no one hard-codes a version |
| `exportFile.ts` | Export/Import file format (`lodestone-profile-export` v1). The file contains the profile secret: treat it like a password |
| `firebase.ts` | Google sign-in via the Firebase JS SDK, loaded from Google's CDN only when `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID` (and optional `VITE_FIREBASE_APP_ID`) are set |
| `dev/main.tsx`, `../../account-dev.html` | Dev page |
| `dev/acceptance.mjs` | Headless acceptance run (Playwright) |

Service URLs come from `VITE_ACCOUNT_URL` / `VITE_DIRECTOR_URL` (set by `npm run dev`), default `http://localhost:8091` / `:8090`.

## Run the dev page

```
npm run infra:up && npm run migrate
# three terminals:
go run ./server/account
go run ./server/director
go run ./server/director/cmd/fakezone
cd client && npx vite --port 5174      # open http://localhost:5174/account-dev.html
```

## Test

```
npx vitest run --root client src/account     # export file + API client unit tests
npx tsc --noEmit -p client && npx eslint client/src/account
node client/src/account/dev/acceptance.mjs   # from the repo root, infra up: real services + Chromium
```

The acceptance run uses its own scratch database and ports 18090/18091/5174, writes screenshots and a log to `docs/evidence/wp04-*`, and finishes by running the Go test that verifies the received tickets with `ticket.Verify`.
