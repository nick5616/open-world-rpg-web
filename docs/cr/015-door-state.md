# CR 015: building door states persist (playtest polish)

Author: pt/server-polish agent · Date: 2026-11-09 · Status: applied on `pt/server-polish`

Doors (CR 013: Interact 34, Events 970-972) lived in zone memory: a zone
restart reopened every door, and each zone of a WP16 cluster kept its own
copy, so two players on either side of a zone border near a town could see
one door in two states.

## What

- **Migration 0024 `door_state`** (additive): `world_id uuid`, `door_id
  bigint` (the door prop's stable u64 id, two's complement), `open bool`,
  `changed_at timestamptz` (when the authority decided), `zone_id text`
  (writer, for humans); primary key `(world_id, door_id)`. One row per door
  that ever changed; no row = open. Upserts carry `changed_at` and lose to
  a newer stored row.
- **Authority**: the zone owning the region a door stands in (the WP16
  ownership table; a single zone owns everything). Only it decides changes
  and writes rows (batched: the doors changed within a second go in one
  multi-row upsert through the write-behind queue; flushed on shutdown).
- **Zone-to-zone control messages** (pub/sub `zone:{id}`, internal, not the
  client protocol): `door` (a non-owner forwards its player's or NPC's
  request: door id, open/close, who), `doorno` (the owner refused: Event
  972 reason for the asking player), `doorset` (the owner's decision, to
  every other zone, applied there with that zone's own prediction-safe
  stamps).
- Every zone loads the table before it ticks; restored closed doors go to
  arriving players in the existing baseline (971).

No change to `protocol.yaml`, `constants.yaml`, `events.md` semantics or the
client: the client sees exactly the 970/971/972 it saw before, now also
after a restart or a handoff.

## Consumers

- `server/zone/internal/game` (`doors.go`, `doors_sync.go`, `doors_store.go`,
  `cluster.go` control types, `handoff.go` dispatch, `server.go`
  `Config.DoorStore` + Stop flush), `server/zone/{main.go, towns.go}`
  (wiring, restore).
- Run `npm run migrate` after merge.
