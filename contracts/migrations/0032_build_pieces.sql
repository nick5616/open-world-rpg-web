-- 0032_build_pieces (playtest 3 base building, docs/cr/041-base-building.md):
-- building pieces are camp pieces (0026) with more kinds, so they ride the
-- same table. Purely additive: three columns on camp_pieces.
--
-- `state` is the piece's own state (bit 0: a door or gate is open).
-- `cond` is its condition in percent (100 new or repaired) as of `cond_day`,
-- the world day (world clock seconds / DAY_LENGTH_S) it was stamped; the zone
-- applies weathering and a hearth's mending lazily from the difference, so
-- nothing is written as pieces wear.
ALTER TABLE camp_pieces ADD COLUMN IF NOT EXISTS state    smallint NOT NULL DEFAULT 0;
ALTER TABLE camp_pieces ADD COLUMN IF NOT EXISTS cond     real NOT NULL DEFAULT 100;
ALTER TABLE camp_pieces ADD COLUMN IF NOT EXISTS cond_day real NOT NULL DEFAULT 0;
