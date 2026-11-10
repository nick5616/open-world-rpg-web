-- 0025_character_content (playtest 2 content, docs/cr/022-content.md): each
-- character's content progress, server-authoritative and persisted:
-- reputation per town, each side quest giver's next request, the creature
-- codex (kills per creature), lore tablets read, feats and the chosen
-- title, counters for feats, sealed vaults discovered (and when their chest
-- was last opened) and herb patches regrowing. Purely additive.
--
-- `data` is the zone's internal/content State JSON ({"v":1,"rep":{...},
-- "givers":{...},"kills":{...},"tablets":[...],"feats":[...],"title":"",
-- "stats":{...},"regions":0,"vaults":{...},"forage":{...}}). `epoch` is the
-- WP16 ownership epoch of the zone that wrote it, exactly like
-- character_quests (0023): an older owner's late save never overwrites a
-- newer zone's (epoch 0 = a single zone, unfenced).
CREATE TABLE IF NOT EXISTS character_content (
    character_id uuid PRIMARY KEY REFERENCES characters (id) ON DELETE CASCADE,
    data         jsonb NOT NULL DEFAULT '{}',
    epoch        bigint NOT NULL DEFAULT 0,
    updated_at   timestamptz NOT NULL DEFAULT now()
);
