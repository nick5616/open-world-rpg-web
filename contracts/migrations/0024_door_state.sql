-- 0024_door_state (pt/server-polish, docs/cr/015-door-state.md): building
-- door states outlive the zone. Purely additive.
--
-- Doors (Interact 34, Events 970-972, CR 013) used to live in zone memory:
-- a restart reopened every door, and each zone of a WP16 cluster had its
-- own. Now the zone owning the region a door stands in decides it and
-- writes its row here (on change, batched once a second); every zone reads
-- the table before it starts ticking. One row per door that ever changed;
-- a door without a row is open (the WP20 doorway).
--
-- `door_id` is the door prop's stable u64 id (towns buffer PROPS, the
-- Interact 34 targetId) stored as its two's-complement bigint. `changed_at`
-- is when the authority decided: an upsert older than the stored row is
-- ignored, so a delayed write (a retry, a zone that just lost the region)
-- never undoes a newer decision. `zone_id` is the writer, for humans.
--
-- `world_id` has no foreign key: dev zones serve a uuid-shaped default
-- world that may have no `worlds` row (same as area_difficulty, 0021).
CREATE TABLE IF NOT EXISTS door_state (
    world_id   uuid NOT NULL,
    door_id    bigint NOT NULL,
    open       boolean NOT NULL,
    changed_at timestamptz NOT NULL,
    zone_id    text NOT NULL DEFAULT '',
    PRIMARY KEY (world_id, door_id)
);
