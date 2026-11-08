-- 0001_init: v1 tables from spec section 11.
-- Applied by server/pkg/cmd/migrate (numbered, plain SQL, each in one
-- transaction). Several services read these tables, which is why they live in
-- contracts/. Later migrations are owned by WP04 and must only add.

CREATE TABLE accounts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_provider text NOT NULL,             -- 'google' first; 'discord', 'github' later
    auth_subject  text NOT NULL,             -- provider's stable user id (Firebase uid)
    created_at    timestamptz NOT NULL DEFAULT now(),
    status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'muted', 'suspended', 'banned')),
    UNIQUE (auth_provider, auth_subject)
);

CREATE TABLE worlds (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    seed        numeric(20, 0) NOT NULL,     -- uint64 does not fit bigint
    spec        jsonb NOT NULL,
    gen_version text NOT NULL,               -- worldgen wasm content hash, pinned forever
    atlas_hash  text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE characters (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    uuid NOT NULL REFERENCES accounts (id),
    world_id      uuid NOT NULL REFERENCES worlds (id),
    name          text NOT NULL,
    name_lower    text GENERATED ALWAYS AS (lower(name)) STORED,
    level         integer NOT NULL DEFAULT 1,
    xp            bigint NOT NULL DEFAULT 0,
    position      jsonb NOT NULL DEFAULT '{"x":0,"y":0,"z":0}',
    last_waypoint bigint,                    -- atlas POI id
    stamina_max   real NOT NULL DEFAULT 100,
    appearance    jsonb NOT NULL DEFAULT '{}',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (world_id, name_lower)            -- names unique per world, case-insensitive (whisper lookup)
);
CREATE INDEX characters_account ON characters (account_id);

CREATE TABLE character_progress (
    character_id      uuid PRIMARY KEY REFERENCES characters (id) ON DELETE CASCADE,
    towers            bytea NOT NULL DEFAULT '\x',   -- bitsets indexed by atlas POI / container ids
    waypoints         bytea NOT NULL DEFAULT '\x',
    containers_opened bytea NOT NULL DEFAULT '\x',
    discoveries       bytea NOT NULL DEFAULT '\x',
    skill_tree        jsonb NOT NULL DEFAULT '{}',
    spells_known      text[] NOT NULL DEFAULT '{}',
    spells_equipped   text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE items (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_character_id uuid REFERENCES characters (id),   -- NULL while lying in the world
    kind               text NOT NULL,
    base_id            text NOT NULL,
    item_level         integer NOT NULL DEFAULT 1,
    rarity             smallint NOT NULL,                  -- 0 common .. 7 bitchin
    affixes            jsonb NOT NULL DEFAULT '[]',
    sockets            jsonb NOT NULL DEFAULT '[]',
    slot               text,
    roll_seed          bigint NOT NULL,                    -- every roll stores its seed for audit
    tradeable          boolean NOT NULL DEFAULT true,      -- trading-ready fields (spec 8)
    provenance         jsonb NOT NULL DEFAULT '[]',
    created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX items_owner ON items (owner_character_id);

CREATE TABLE world_edits (
    world_id   uuid NOT NULL REFERENCES worlds (id),
    chunk_x    integer NOT NULL,
    chunk_z    integer NOT NULL,
    edit_id    bigint NOT NULL,
    kind       text NOT NULL,
    target_id  numeric(20, 0) NOT NULL,      -- stable generator id (uint64)
    params     jsonb NOT NULL DEFAULT '{}',
    tick       bigint NOT NULL,
    expires_at timestamptz,                  -- NULL = never; a sweeper deletes expired rows hourly
    PRIMARY KEY (world_id, edit_id)
);
CREATE INDEX world_edits_chunk ON world_edits (world_id, chunk_x, chunk_z);
CREATE INDEX world_edits_expiry ON world_edits (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE friends (
    account_a  uuid NOT NULL REFERENCES accounts (id),   -- requester
    account_b  uuid NOT NULL REFERENCES accounts (id),
    state      text NOT NULL CHECK (state IN ('pending', 'accepted')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_a, account_b)
);

CREATE TABLE blocks (
    blocker    uuid NOT NULL REFERENCES accounts (id),
    blocked    uuid NOT NULL REFERENCES accounts (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker, blocked)
);

CREATE TABLE reports (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter   uuid NOT NULL,
    reported   uuid NOT NULL,
    channel    text NOT NULL,
    context    jsonb NOT NULL,               -- last 50 messages of that channel / conversation
    created_at timestamptz NOT NULL DEFAULT now(),
    resolution text
);
