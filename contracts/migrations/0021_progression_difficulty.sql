-- 0021_progression_difficulty (playtest 1, docs/cr/012-progression-difficulty.md,
-- docs/decisions/0021-discovery-difficulty.md). Purely additive.
--
-- Discovery-stamped area difficulty. The world is cut into square areas of
-- `cell_m` metres (combat.yaml difficulty.cellM, 256 m in v1). The first
-- player to come near an area stamps its level from their character level
-- (smoothed against the stamped neighbours); every zone of the world reads
-- the same row, and a stamp never changes. Zones insert with
-- ON CONFLICT DO NOTHING and read the row back, so the first writer wins
-- even when two zones claim the same area at once (WP16). The Haven around
-- the world spawn is fixed at level 1 and never stored.
--
-- `world_id` has no foreign key: dev zones serve a uuid-shaped default
-- world that may have no `worlds` row, and the stamp is harmless without
-- one. `cell_m` is part of the key so a later granularity change starts a
-- fresh map instead of misreading old rows.
CREATE TABLE area_difficulty (
    world_id         uuid NOT NULL,
    cell_m           smallint NOT NULL,
    cell_x           smallint NOT NULL,
    cell_z           smallint NOT NULL,
    level            smallint NOT NULL CHECK (level BETWEEN 1 AND 100),
    stamped_by       text NOT NULL DEFAULT '',      -- character id (accounts: uuid text; local profiles: their id)
    stamped_by_name  text NOT NULL DEFAULT '',
    stamped_by_level smallint NOT NULL DEFAULT 1,   -- the discoverer's character level at the time
    stamped_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (world_id, cell_m, cell_x, cell_z)
);

-- Tower crystals a character has attuned to (Interact 10 action 2 on a
-- tower's top): a bitset indexed by atlas site index, like `towers`. Each
-- first attunement gives a permanent boon (combat.yaml leveling.attune);
-- the boons are derived from this set, never stored separately.
ALTER TABLE character_progress ADD COLUMN attuned bytea NOT NULL DEFAULT '\x';
