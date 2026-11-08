-- 0002_local_profiles (WP04): local profiles, their characters, and the
-- official-world marker. Purely additive: no existing column changes meaning.
--
-- Why local characters get their own table instead of a nullable
-- characters.account_id: zone, social and later packages read `characters`
-- assuming every row belongs to an account (friends, reports, trading all key
-- on accounts). Keeping local characters apart means nothing downstream has to
-- learn a second owner kind until it wants to. Names must still be unique per
-- world across BOTH tables (whispers resolve by name, spec 10); the account
-- service enforces that under a per-(world, name) advisory lock, and each
-- table's own UNIQUE constraint is the backstop.

-- The world the director and account service hand to new players. Seeded on
-- account-service startup when no official world exists.
ALTER TABLE worlds ADD COLUMN official boolean NOT NULL DEFAULT false;

-- A browser-generated profile (spec 11). The browser holds the id and a random
-- secret; we keep only sha256(secret) so a leaked database row cannot be used
-- to impersonate the profile. "No row in accounts" still holds.
CREATE TABLE local_profiles (
    id                  uuid PRIMARY KEY,               -- generated in the browser
    secret_hash         bytea NOT NULL,                 -- sha256 of the browser-held secret
    created_at          timestamptz NOT NULL DEFAULT now(),
    last_seen_at        timestamptz NOT NULL DEFAULT now(),
    upgraded_account_id uuid REFERENCES accounts (id),  -- set once, by the upgrade transaction
    upgraded_at         timestamptz
);

-- Name reservation + ownership for local-profile characters. The character's
-- state lives in the browser as a signed save blob, not here. On upgrade the
-- row moves to `characters` keeping the same id, inside one transaction.
CREATE TABLE local_characters (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL REFERENCES local_profiles (id),
    world_id   uuid NOT NULL REFERENCES worlds (id),
    name       text NOT NULL,
    name_lower text GENERATED ALWAYS AS (lower(name)) STORED,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (world_id, name_lower)
);
CREATE INDEX local_characters_profile ON local_characters (profile_id);
