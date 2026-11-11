-- 0030_rift_leaderboard (playtest 2 rift runs, docs/cr/040-rift-runs.md):
-- each character's best run per rift chapter, for the per-chapter
-- leaderboard. Purely additive.
--
-- `world_id` is text (the zone's configured world id, as camps use it) so
-- dev worlds without a `worlds` row still work; `character_id` is text for
-- the same reason (dev tickets and bots have no `characters` row; their
-- rows are never written because the zone only writes uuid ids). `stage` is
-- the deepest room cleared (1-50), `ms` how long that run took (the tie
-- break: faster is better). The zone keeps the top 20 per chapter in memory,
-- read at start, and writes a row whenever a character beats their own best.
CREATE TABLE IF NOT EXISTS rift_best (
    world_id     text NOT NULL,
    chapter      smallint NOT NULL,
    character_id text NOT NULL,
    name         text NOT NULL,
    stage        smallint NOT NULL,
    ms           bigint NOT NULL,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (world_id, chapter, character_id)
);
CREATE INDEX IF NOT EXISTS rift_best_board ON rift_best (world_id, chapter, stage DESC, ms ASC);
