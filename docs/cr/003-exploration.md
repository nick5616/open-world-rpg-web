# CR 003: Exploration events, Interact registry, pins column

Author: WP12 · Date: 2026-11-08 · Status: applied on `wp/12-map`

## What (all additive)

1. **Event kinds 600-608** (`contracts/events.md`, WP12's claimed range): tower
   unlocked, waypoint activated, discovery (XP), progress sync (binary
   payload), level up, pins (binary payload), fast travel denied, party,
   respawn point. Payload layouts are documented in `events.md` and pinned by
   `server/zone/internal/explore/testdata/events_vectors.json`, which the
   Go encoder writes and the TS decoder replays.
2. **Interact registry** (`contracts/events.md` "Interact"): `Interact`
   (protocol.yaml id 5) existed with `targetKind/targetId/action/arg` and no
   assigned meanings. WP12 takes `targetKind` 10 (site: fast travel) and 11
   (pin: set/clear personal, set/clear party) and opens the table for later
   packages (chests, NPCs, doors).
3. **Migration `0012_exploration_pins.sql`**: `character_progress.pins jsonb
   NOT NULL DEFAULT '[]'` for spec 8's 10 persisted personal pins.
4. **`localsave.Progress.Pins`** (`server/pkg/localsave/state.go`): optional
   JSON field (`omitempty`), the blob twin of the new column. Old blobs parse
   unchanged; the signature covers the state text verbatim, so no layout
   change.

`protocol.yaml` itself is **not** changed (no new message, no version bump):
the generic `Event` and `Interact` messages carry everything, which keeps
WP12 out of the protocol-version race with the other Phase 3 packages.

## Why

- Fast travel, pins and progress need a client-to-zone verb and zone-to-client
  notifications; `Interact` and `Event` exist for exactly that and only lacked
  registered meanings.
- Personal pins must persist (spec 8); 0001's `character_progress` has the
  bitsets but nowhere for pins.
- The migration is numbered 0012 (after the package), not 0004, because
  several Phase 3 packages add migrations in parallel and the migrator
  refuses duplicate versions; versions need not be contiguous.

## Consumers affected

| Consumer | Change |
| --- | --- |
| `server/zone` (WP03/WP06 owners; WP12 adds `internal/explore`, `internal/game/{explore,party,persist_progress}.go`) | Sends the events, handles the Interacts, reads/writes `pins` |
| `client/src/net/zoneSession.ts` (WP06) | `onEvent` / `onSaveBlob` callbacks and `sendInteract()` (previously Events were dropped) |
| `client/src/ui/map` (WP12) | Decodes the events, sends the Interacts |
| `server/pkg/localsave` (WP04) | New optional `Progress.Pins` field |
| `server/account` upgrade (WP04) | None required; pins in a local blob are not copied into the new column on upgrade yet (STATUS gap) |
| Everyone else | None: no other package sends or reads these kinds yet |

Migration 0012 has to be applied (`npm run migrate`) before a zone with WP12
saves progress; until then saves fail and retry in the write-behind queue
(logged), and nothing else breaks.
