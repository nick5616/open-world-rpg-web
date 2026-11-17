-- 0031_terrain_edits (pt3/world-edits, docs/cr/040-world-edits.md): the
-- terrain the players dug and filled. Purely additive.
--
-- A terrain edit is a signed height delta (0.25 m steps, +-6 m, i8) per 1 m
-- lattice vertex over the generated heights, which never change. One row per
-- 64 m chunk that holds any: `entries` is the packed list the wire carries
-- (n x [u16 LE local vertex index z*64 + x, i8 delta], non-zero vertices
-- only), so a chunk costs 3 bytes per edited vertex (a dug pit is a few
-- hundred bytes), at most 4096 x 3 = 12 KB; the zone bounds the world at 640
-- chunks. The zone rewrites a chunk's row (upsert) through its write-behind
-- queue after a swing, coalescing bursts, deletes the row when every vertex
-- is back to zero, and reads the whole table once before it starts ticking.
--
-- Felled trees and broken rocks are not here: they are world_edits rows
-- (kind object_destroyed, expires_at = when it grows back, NULL = never
-- inside a player's base), the table mined veins already use.
--
-- `world_id` has no foreign key: dev zones serve a uuid-shaped default world
-- that may have no `worlds` row (same as door_state, 0024).
CREATE TABLE IF NOT EXISTS terrain_edits (
    world_id   uuid NOT NULL,
    chunk_x    integer NOT NULL,
    chunk_z    integer NOT NULL,
    entries    bytea NOT NULL,
    vertices   integer NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (world_id, chunk_x, chunk_z)
);
