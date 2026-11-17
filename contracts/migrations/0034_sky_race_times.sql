-- 0034_sky_race_times (playtest 3 sky activities, docs/cr/044-sky-depths.md):
-- best times of the Glide Ring Race at the sky towns' challenge stands.
-- Purely additive.
--
-- One row per (stand, character): the fastest run that character flew. The
-- zone that runs the stand writes the row when a personal best is set (never
-- on the tick: a background write) and every zone of the world reads the
-- table before it starts ticking, to rank times and show each stand's top
-- five. `stand_id` is the towns ACTIVITY prop's stable id (a genVersion 3
-- sky-town square). `character_id` has no foreign key and is text, like
-- camp_pieces (0026): dev tickets and bots race without a `characters` row,
-- and a deleted character's time simply stays on the board under its name.
-- `world_id` has no foreign key, like door_state (0024).
CREATE TABLE IF NOT EXISTS sky_race_times (
    world_id     uuid        NOT NULL,
    stand_id     bigint      NOT NULL,
    character_id text        NOT NULL,
    name         text        NOT NULL DEFAULT '',
    best_ms      integer     NOT NULL CHECK (best_ms > 0),
    set_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (world_id, stand_id, character_id)
);

CREATE INDEX IF NOT EXISTS sky_race_times_by_stand ON sky_race_times (world_id, stand_id, best_ms);
