# client/src/social

Chat, whispers, parties, friends and speech-bubble data for the browser
(spec 10, WP08), over the social service socket (`server/social`,
`contracts/social.yaml`).

## Mounting (for the play flow, WP06)

`PlayScreen` already renders `<SocialOverlay />`, which draws nothing until a
session starts. Whoever holds the `ReadySession` from `AccountScreen` starts it once:

```ts
import { startSocial, stopSocial } from '../social';
import { localPlayer } from '../state/live';

startSocial({
  endpoint: ready.socialEndpoint,
  ticket: ready.socialTicket,
  // 60 s tickets: reconnects ask the director for a fresh one.
  refreshTicket: () => api.socialTicket(ready.session, ready.character.id).then((r) => r.socialTicket),
  zoneId: () => currentZoneId,                 // the zone you're connected to (changes on handoff)
  position: () => ({ x: localPlayer.pos.x, z: localPlayer.pos.z }),
});
// on sign-out: stopSocial()
```

Optional props on `<SocialOverlay>`: `extraNames` (nearby players for name
autocomplete) and `healthOf(characterId)` (party frame health bars from the
zone's party ring).

## Speech bubbles

Local chat lines carry the speaker's position. Bubbles are a data store keyed
by **character name** (nameplates know names from the zone's first-sight
records; zone entity ids are a different id space):

- `getSpeechBubble(name)` / `allSpeechBubbles()`: imperative, for a render loop.
- `useSpeechBubble(name)`: React hook for DOM nameplates (re-renders on show and expiry).

Bubbles live `CHAT_BUBBLE_MS` (6 s). Rendering them above remote players is
WP06's nameplate code; the dev page draws a flat list to prove the data.

## Keys and commands

Enter opens chat (and releases pointer lock), `/` opens it with a slash, Escape
closes, Tab completes names (friends, party, whisper partners, recent
speakers, `extraNames`), O toggles friends. Plain text goes to the active tab
(local by default). Commands: `/g /z /s /p` channels, `/w Name msg`, `/w Name`
(open tab), `/r msg`, `/invite /kick /promote Name`, `/leave`,
`/friend /unfriend /accept /decline Name`, `/mute /unmute /block /unblock Name`,
`/report Name [reason]`, `/filter on|off`, `/help`. Clicking a name opens a
menu with the same actions.

## Files

| File | What |
| --- | --- |
| `session.ts` | `startSocial` / `stopSocial` / `sendSocial` / `submitChatInput`; presence at 2 Hz (5 s idle) |
| `socket.ts` | WebSocket client: auth, reconnect with backoff (1 s → 30 s), fresh tickets, queue until welcome, stop on `replaced`/`banned` |
| `store.ts` | zustand store; `reduce(state, msg)` is pure and unit-tested |
| `commands.ts` | Slash-command parser, name completion, region math |
| `bubbles.ts` | Speech bubble store |
| `ui/` | `SocialOverlay`, `ChatPanel`, `PartyFrame`, `FriendsPanel`, `NameMenu` |
| `dev/main.tsx`, `../../social-dev.html` | Dev page (port 5175): dev sign-in or local profile → director tickets → overlay |
| `dev/e2e.mjs` | Headless acceptance (3 browsers, admin CLI, flood) |

## Test

```
npx vitest run --root client src/social     # parser, completion, reducer, bubbles, socket reconnect
node client/src/social/dev/e2e.mjs          # from the repo root, infra up
```

Dev page by hand: run account, director and social (see their READMEs), then
`npx vite --port 5175` in `client/` and open
`/social-dev.html?name=Alice` (and `?name=Bob&user=bob` in another browser
profile; `&local=1` for a local profile).
