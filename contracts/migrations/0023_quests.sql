-- 0023_quests (playtest 1, docs/cr/013-playtest-ux-quests.md): each
-- character's quest log, server-authoritative and persisted (accepted
-- bounties were kept in zone memory only by WP20; the starter quest line
-- "Ward against the night" lives here too). Purely additive.
--
-- `log` is the zone's internal/quests Log JSON ({"v":1,"active":[...],
-- "done":[...],"started":[...],"tracked":id}); every quest carries its own
-- steps and markers, so a saved log is self-contained. `epoch` is the WP16
-- ownership epoch of the zone that wrote it: a write older than the stored
-- epoch is refused, so a previous owner's late save never overwrites the
-- new owner's (epoch 0 = a single zone, unfenced).
--
-- Numbered 0023: 0022 is left to the parallel progression branch (CR 012);
-- versions need not be contiguous (see 0012, 0014).
CREATE TABLE IF NOT EXISTS character_quests (
    character_id uuid PRIMARY KEY REFERENCES characters (id) ON DELETE CASCADE,
    log          jsonb NOT NULL DEFAULT '{}',
    epoch        bigint NOT NULL DEFAULT 0,
    updated_at   timestamptz NOT NULL DEFAULT now()
);
