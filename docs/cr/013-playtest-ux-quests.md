# CR 013: Playtest 1 UX: quests with map markers, doors, weapon looks

Author: pt/ux · Date: 2026-11-09 · Status: applied on `pt/ux`

Nicole's first playtest asked for quest markers (and seeing where a quest
takes place before accepting), a starter quest that teaches where sunsteel
and Light magic come from, doors that close, and weapons that look like
weapons. This CR collects the contract changes those need. Everything is
additive: no existing field, id or meaning changed. `protocol.yaml`,
`constants.yaml`, `combat.yaml`, `items.yaml` and worldgen output are **not**
changed (no PROTOCOL_VERSION, genVersion or golden change); everything rides
the generic `Event` / `Interact` messages, one existing snapshot field and
one new table.

## What

### 1. Quests: Events 950-955, Interact 60 (`contracts/events.md`)

- New Event range **950-969** (quests); kinds:
  - **950 `quest_log`**: the whole quest log as JSON after join and on every
    change (quests, steps with done flags, the current step's text, hint,
    count, **markers** `{x, z, r?, label}` in meters (`r` > 0: an area
    circle), gold, XP, `turnIn`).
  - **951 `quest_offer`**: a quest you may accept, with `stepMarkers`
    (every step's markers) so the client can show where it takes place
    before accepting.
  - **952 `quest_step`**, **953 `quest_completed`**, **954 `quest_refused`**
    (reasons 1-6), **955 `quest_started`**.
- New Interact target kind **60 `quest`**: 1 accept an offer, 2 abandon, 3
  hand in (deliveries; within 10 m of the settlement's board or bounty
  keeper), 4 track.
- Event **401 `loot_granted`** gets source **9** (quest reward).
- Event **802 `bounties`**: the `accepted` byte may be **2** (you completed
  that job). Old clients that test `!= 0` show it as accepted.

### 2. Quest persistence: migration `0023_quests.sql`

New table `character_quests (character_id uuid PK -> characters, log jsonb,
epoch bigint, updated_at)`. `log` is the zone's `internal/quests` Log JSON;
`epoch` is the WP16 ownership epoch: a save from an older owner is refused
(epoch 0 = single zone, unfenced). Accepted bounties, which WP20 kept in
zone memory only, now live here. **Run `npm run migrate` after merging**
(until then account characters' quest saves fail and retry; the zone keeps
the log in memory and logs the error).

Numbered 0023 because 0022 is the parallel progression branch's (CR 012);
migration versions need not be contiguous (0012, 0014).

Local profiles: `localsave.State` gains optional `quests` (raw JSON), so
blobs issued before this CR still parse. The account-service upgrade
(local -> account) does not copy it yet (gap).

Zone handoff (WP16): a `quests` HandoffField carries the live log.

### 3. Doors: Interact 34, Events 970-972

WP20 reserved Interact 34-39 for doors. Building doors (towns buffer PROPS
kind 0 on buildings with floors and a closed front) can be opened and
closed:

- **Interact 34 `door`** (targetId = door prop stable id): 1 open, 2 close,
  3 toggle (4.5 m from the eye).
- **970 `door_state`**: a door opens or closes, stamped with the movement
  step it applies at (each recipient's own input seq), so client prediction
  and the zone switch the door's collision on exactly the same step.
- **971 `door_baseline`**: a settlement's doors that are not settled open,
  for a client coming in range.
- **972 `door_refused`**: too far, not a door, someone in the doorway,
  still swinging, already in that state.

Collision: door boxes are precomputed from the towns buffer identically in
TS (`worldgen/js/src/doors.ts`) and Go (`server/pkg/towns/doors.go`), replayed as
vectors on both sides; an overlay on the building ground pushes bodies out
of closed doors. Doors start open, so the WP20 golden collide vectors and
every existing movement golden are unchanged. Details in
`client/src/world/buildings/README.md` and `server/pkg/towns/README.md`.

### 4. Weapon looks: the player entity's `typeId`

`EntityRecord.typeId` was unused for players. It now carries the active
loadout's weapon look so other clients draw it in the avatar's hand:
bits 0-3 combat.yaml weapon id (0 none), bits 4-7 material code (0
ordinary, else 1 + the index in items.yaml `materials`), bits 8-11
socketed gem element + 1 (0 none). Set only when the loadout or gear
changes (never per tick); it rides the usual delta coding, ghosts and
handoffs. Event **212 `combat_sync`** gains 2 trailing bytes (the material
code per loadout) for your own first-person weapon; decoders accept the
event without them (older zones).

## Why

- Quests need to be server-authoritative and persisted to survive
  reconnects, restarts and handoffs; markers must come from the zone,
  which knows where the sunsteel seam and the shrine are.
- Door state must reach every client nearby and apply on the same
  movement step on both sides, like WP15's chemistry ops, or walking
  through a doorway would cause prediction corrections.
- Remote weapon looks need some per-player field; `typeId` costs nothing
  when unchanged.

## Consumers affected

- `server/zone`: `internal/quests` (new), `internal/game/quests.go` (new),
  hooks in `server.go`, `session.go`, `towns.go` (bounties -> quests),
  `items.go` (inventory recheck, tome -> empty spell slot), `combat.go`
  (spell recheck, weapon look), `explore.go` (local blob); `internal/npc`
  (`Bounty.Item`, `EncodeBountiesState`); doors in `internal/game` and
  `internal/npc`; `weaponlook.go`.
- `server/pkg/localsave` (`State.Quests`), `server/pkg/towns` (doors).
- `worldgen/js` (door boxes, TS twin; no wasm change).
- `client`: `ui/quests` (new), `ui/map` (markers, previews), `world/buildings`
  (bounty previews, doors), `combat` (weapons, spell selection, billboards),
  `net/avatar.ts` (remote weapons), `net/NetPlay.tsx`.
- `contracts/migrations/0023_quests.sql` (new).

## Compatibility

All additions. An old client ignores Events 950-972 and the typeId of
players (it drew no weapon), and decodes 212 without reading the tail. An
old zone sends none of them: the new client shows no quests and no doors
closing (doors stay open, which is the old collision), and draws remote
players unarmed. Deploy the zone and client together for door collision
to agree (doors start open, so a mix agrees until someone closes one).
