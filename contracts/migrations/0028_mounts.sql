-- 0028_mounts (playtest 2 mounts, docs/cr/027-mounts.md): the steeds bonded
-- to each character. A Spirit Whistle's first call bonds a spirit steed (the
-- zone writes the row); its name and colour are the owner's to change.
-- Purely additive.
--
-- One row per owned steed; `slot` is its index in the character's list (one
-- steed today, the table allows more). `kind` is the steed kind (1 = spirit
-- steed), `colour` the client palette index (0-5). `epoch` is the WP16
-- ownership epoch of the zone that wrote it, exactly like character_content
-- (0025): an older owner's late save never overwrites a newer zone's (epoch
-- 0 = a single zone, unfenced). Local profiles keep the same list in their
-- save blob (`mounts`); like the content state, an account upgrade does not
-- copy it yet.
CREATE TABLE IF NOT EXISTS character_mounts (
    character_id uuid NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
    slot         smallint NOT NULL,
    kind         smallint NOT NULL DEFAULT 1,
    name         text NOT NULL DEFAULT '',
    colour       smallint NOT NULL DEFAULT 0,
    bonded_at    timestamptz NOT NULL DEFAULT now(),
    epoch        bigint NOT NULL DEFAULT 0,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (character_id, slot)
);
