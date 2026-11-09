-- 0014_loot (WP14, docs/cr/010-loot.md): items that stack, lie in the
-- world, and are granted exactly once. Purely additive: no existing column
-- changes meaning, every new column has a default, so rows written before
-- this migration read as single, verified, owned items.
--
-- Numbered 0014 (the work package), like 0012: packages add migrations in
-- parallel and versions need not be contiguous.

-- Stacks (ore, gems, coins, food): one row per stack, `qty` units.
ALTER TABLE items ADD COLUMN qty integer NOT NULL DEFAULT 1 CHECK (qty > 0);
-- Spec 8: items dropped by a local-profile player are marked unverified and
-- are never tradeable. `tradeable` (0001) stays the trading switch; this
-- records why it is off.
ALTER TABLE items ADD COLUMN verified boolean NOT NULL DEFAULT true;
-- Mythic and above carry a generated name ("Dawnbreaker").
ALTER TABLE items ADD COLUMN display_name text;
-- A dropped item lies in the world (owner_character_id NULL, 0001's
-- comment) until someone takes it or it despawns (spec 8: 10 minutes). The
-- zone restores unexpired world items as pickups after a restart and
-- deletes expired ones.
ALTER TABLE items ADD COLUMN world_id uuid REFERENCES worlds (id);
ALTER TABLE items ADD COLUMN world_pos jsonb;           -- {"x","y","z"} meters while in the world
ALTER TABLE items ADD COLUMN despawn_at timestamptz;    -- while in the world
ALTER TABLE items ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX items_in_world ON items (world_id, despawn_at) WHERE owner_character_id IS NULL;

-- Exactly-once grants (spec 11: "Loot grants are a single transaction:
-- insert items and mark the container or vein for that character
-- together. A crash can lose a roll but never duplicate one.").
--
-- Every roll that creates items has a key: container:<id> (spec 8: a
-- container opens once per character), boss:<group>:<week> (the weekly
-- boss lockout), vein:<roll seed>, kill:<zone boot>:<enemy>:<tick>,
-- starter, craft/purchase nonces. The grant transaction inserts the marker
-- first (ON CONFLICT DO NOTHING); a conflict means the roll was already
-- granted and the items are not inserted again. `op_id` tells a retry of
-- the same committed transaction (connection lost after COMMIT) apart from
-- a genuine second grant.
--
-- This replaces character_progress.containers_opened for containers:
-- container ids are 64-bit stable generator ids, not dense indices, so a
-- bitset indexed by them is not practical (decision 0014).
CREATE TABLE loot_grants (
    character_id uuid NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
    grant_key    text NOT NULL,
    op_id        uuid NOT NULL,
    roll_seed    bigint NOT NULL,
    items        integer NOT NULL,          -- rows inserted (audit)
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (character_id, grant_key)
);

-- WP16 fencing: the newest ownership epoch that wrote a character's items.
-- An item transaction from an older owner (a zone the character has left)
-- is refused, so a stale zone can never grant, take or duplicate items
-- after the new owner wrote (see server/zone/internal/game/items_handoff.go).
CREATE TABLE item_epochs (
    character_id uuid PRIMARY KEY REFERENCES characters (id) ON DELETE CASCADE,
    epoch        bigint NOT NULL
);
