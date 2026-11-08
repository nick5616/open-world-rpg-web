# CR 002: Social protocol v2

Author: WP08 · Date: 2026-11-08 · Status: applied on `wp/08-social`

## What (`contracts/social.yaml`, version 1 → 2, additive)

- New s2c message `relations {muted: string[], blocked: string[], profanityFilter: bool}`: the server's view of who I muted and blocked (names) and my filter setting. Sent after `welcome` and after every block/unblock/mute/unmute/set_filter.
- `ErrorCode` gains `muted` (a moderator muted you: read-only), `banned` (suspended or banned; the socket closes), `replaced` (you signed in from another window; the socket closes and must not reconnect).

Regenerated: `contracts/ts/src/gen/social.ts`, `server/pkg/socialproto/social_gen.go` (`npm run gen`).

## Why

- Without `relations` the client would have to keep its own copy of mute/block lists, which drifts across devices and reconnects, and the name menu could not show "Unmute"/"Unblock" correctly.
- The three error codes make the client's reconnect logic correct: after `replaced` or `banned`, reconnecting would fight the other window or hammer the server; after `muted`, the UI explains why sending fails.

## Consumers affected

| Consumer | Change |
| --- | --- |
| `server/social` (WP08) | Sends `relations` and the new codes |
| `client/src/social` (WP08) | Handles them (store reducer, socket stops reconnecting on `replaced`/`banned`) |
| Anyone else | None: no other package speaks the social protocol yet. Old v1 messages are unchanged |

The social socket has no version handshake (JSON, unknown types are ignored by both sides), so v1 and v2 peers interoperate; a v1 client simply ignores `relations`.
