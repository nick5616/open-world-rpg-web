-- 0003_social (WP08, docs/cr/001-social-relations-by-character.md): social
-- relations keyed by CHARACTER id, moderation state for local profiles, and
-- richer report rows. Purely additive.
--
-- Why character ids and not account ids: 0001's `friends`/`blocks` reference
-- accounts(id), but local-profile players have no account row (spec 11), and
-- spec 10 still gives them friends, blocks and mutes. Character ids are the
-- one identity both kinds share: account characters live in `characters`,
-- local ones in `local_characters`, both uuid keyed, and an upgrade keeps the
-- id (decision 0004), so relations survive the upgrade untouched. Names are
-- per world and so are characters, which makes relations naturally per world,
-- matching how players see each other (by character name).
--
-- No foreign keys on the character columns: a character id may be in either
-- table (and moves between them on upgrade), and test bots carry ticket-only
-- characters with no row at all. The social service validates ids it writes.
--
-- 0001's `friends` and `blocks` stay (additive rule) but are unused.

CREATE TABLE social_friends (
    requester  uuid NOT NULL,                 -- character who sent the request
    target     uuid NOT NULL,
    world_id   uuid NOT NULL,
    state      text NOT NULL CHECK (state IN ('pending', 'accepted')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (requester, target),
    CHECK (requester <> target)
);
-- Lookups go both ways ("my friends" = rows where I am either side).
CREATE INDEX social_friends_target ON social_friends (target);

CREATE TABLE social_blocks (
    blocker    uuid NOT NULL,
    blocked    uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker, blocked),
    CHECK (blocker <> blocked)
);
-- "Has the whisper target blocked me?" is answered by the PK; this index
-- serves the reverse question for moderation queries.
CREATE INDEX social_blocks_blocked ON social_blocks (blocked);

-- Mute = stop reading someone in every channel (spec 10). Persisted so it
-- survives reconnects, like blocks.
CREATE TABLE social_mutes (
    muter      uuid NOT NULL,
    muted      uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (muter, muted),
    CHECK (muter <> muted)
);

-- Per-character preferences. Missing row = defaults (filter on).
CREATE TABLE social_settings (
    character_id     uuid PRIMARY KEY,
    profanity_filter boolean NOT NULL DEFAULT true,
    updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Moderation status for local profiles, which have no accounts.status column
-- to carry it. Accounts keep using accounts.status (the director already
-- refuses suspended/banned accounts at connect).
CREATE TABLE social_sanctions (
    profile_id uuid PRIMARY KEY,
    status     text NOT NULL CHECK (status IN ('active', 'muted', 'suspended', 'banned')),
    reason     text,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Every admin action, for audit (who did what to whom and why).
CREATE TABLE moderation_log (
    id             bigserial PRIMARY KEY,
    actor          text NOT NULL,             -- OS user running the admin CLI
    action         text NOT NULL,             -- mute|unmute|suspend|ban|unban|resolve
    subject_kind   text NOT NULL,             -- account|profile|report
    subject_id     text NOT NULL,
    character_name text,
    reason         text,
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- reports.reporter/reported already have no FK; they hold character ids from
-- now on. Names are copied at report time so a report reads on its own.
ALTER TABLE reports ADD COLUMN world_id uuid;
ALTER TABLE reports ADD COLUMN reporter_name text;
ALTER TABLE reports ADD COLUMN reported_name text;
ALTER TABLE reports ADD COLUMN reason text;
CREATE INDEX reports_open ON reports (created_at) WHERE resolution IS NULL;
