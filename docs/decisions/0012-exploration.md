# 0012: Towers, waypoints and the map (WP12)

Date: 2026-11-08

## Towers are a structure overlay on the ground query

Towers must be climbable, and WP10's climbing works on steep *terrain*. Rather
than change the heightfield generator (which would change every golden hash
and the genVersion of a world that may already be minted), towers are extra
height functions combined with the terrain by `max` in the ground query, in
TS (`client/src/world/structures`) and Go (`server/pkg/structures`). The
movement code is unchanged: a tower wall is just 80-degree ground.

- 80 degrees: inside the 50-89 climbing band with margin both ways; a
  vertical wall is not a function of (x, z).
- A 1.4 m ledge at 13 m below the top splits the ~28 m climb in two, because
  at spec 8's 2 m/s a single wall would be 14 s on the stamina wheel.
- Top = 28 m above the highest ground under the platform and ledge, so a
  tower on an uneven peak still stands ~30 m tall (the atlas viewshed
  assumed 30).
- Bit-identical across hosts: only `+ - * /`, sqrt and comparisons at query
  time, tan 80 as a literal, explicit `float64()` around products in Go
  (FMA), no Go constant folding of values TS computes at runtime (it cost one
  ulp in the first golden run). `server/pkg/structures/testdata/golden.json`
  is replayed by the TS test (~4,400 points, real terrain included), and a
  zone process test walks up a tower wall predicting on the client-side
  overlay: server and prediction agree to the centimetre.
- Cost: one grid lookup + a sqrt per covering structure (~30 ns).
- Limits: no overhangs or interiors (WP20 needs collision volumes for those);
  merlons are decorative.

## Exploration is server-validated in the tick, from position only

The zone checks each player 10 times a second against a 128 m grid of site
reach: tower top (the overlay says the ground under you is that tower's top
platform), waypoint touch (3 m), discovery radius per site kind. No client
claims exist: the client cannot say "I'm on the tower", it can only walk
there. Fast travel and pins are `Interact`s validated against the
character's progress.

## No protocol.yaml change

`Event` (kinds 600-608) and `Interact` (target kinds 10, 11) already exist
and only needed registered meanings (CR 003). Keeping `protocol.yaml` at
version 1 keeps WP12 out of a protocol-version merge race with the other
Phase 3 packages. The two structured payloads (progress, pins) are small
binary layouts documented in `contracts/events.md` and pinned by Go-generated
vectors that the TS decoder replays.

## Party pins and the party ring go through the zone, not the social service

The party ring was a stub (partyId always 0). The zone now reads the social
service's `partyof:{characterId}` keys from Redis every 2 s (one MGET for
everyone it hosts, off the tick) and sets the snapshot `partyId` to an FNV-32
hash of the party id, so members get each other at any distance at 2 Hz:
that is what the compass and map draw. Party pins ride the same path: the
zone relays them to members it hosts immediately and stores them in Redis
(`partypins:{worldId}:{partyId}`, 6 h TTL) for members on other zones and
reconnects. Alternatives considered:

- A `party_pin` message in `social.yaml`: the social service owns parties,
  but the pins are world positions shown alongside zone data (party ring,
  map), it would mean a social protocol bump and edits in WP08's (and WP11's
  concurrently edited) service, and the zone already needs the party mapping
  for the ring.
- The zone subscribing to social pub/sub for party updates: lower latency
  than 2 s polling, but couples the zone to the social bus envelope format;
  a 2 s poll matches the ring's own 2 Hz and costs one MGET.

One party pin per member (replace to move it): bounded (4 per party), and
every pin has an owner who can remove it.

## Persistence

Accounts: `characters.level/xp/last_waypoint` and `character_progress`
bitsets (towers, waypoints, discoveries; indexed by atlas site index) plus
the new `pins` column (migration 0012), one transaction per save through the
write-behind queue: on any change (coalesced per character), at the 30 s
checkpoint and on logout. `last_waypoint` holds the waypoint site's stable
64-bit id as int64 bits (spec 11 "atlas POI id"). A failed progress read at
login makes the session read-only for progress, so a database blip can't
overwrite a row with empty progress.

Local profiles: the zone now verifies the signed save blob from `Hello`
(signature + counter, `AdoptMissing` like the account service), loads
progress and position from it, and re-issues a blob (`SaveBlob`) when
progress changes (at most every 5 s) and at checkpoints; the client stores it
in IndexedDB (`SaveStore.putSave`, newest counter wins). A blob is never
issued after the connection closed (a counter the browser never receives
would make its stored blob stale), and a session whose blob failed
verification never issues (it would overwrite progress made elsewhere).
Remaining risk: a blob issued while the socket is open but lost before the
browser stores it makes the stored one stale; spec 11's scheme has no ack.

## Discovery XP and the level curve

Values in `internal/explore/explore.go` (`DiscoverXP`, `TowerClimbXP`) on
wizard-wars' curve (60 + 40 x level per level): the spawn town (100) levels
a new character once, a tower is 190 including its climb. WP13 owns combat
XP and may retune the curve; the `level` column is recomputed from XP on load
so a curve change can't leave them inconsistent.
