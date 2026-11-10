-- 0026_camps (playtest 2 camps, docs/cr/025-camps.md): camp pieces players
-- place in the world, and the items kept in camp storage chests. Purely
-- additive.
--
-- One row per placed piece (contracts/camps.yaml: campfire, bedroll,
-- storage chest, workbench, signpost). The zone that placed it writes the
-- row (write-behind, coalesced per piece); every zone of the world reads
-- the table before it starts ticking. A picked-up or decayed piece's row is
-- deleted.
--
-- `piece_id` is the zone-allocated 40-bit id (the Interact 90 target id).
-- `owner_character_id` has no foreign key and is text: dev tickets and bots
-- place pieces as characters without a `characters` row (their pieces are
-- memory-only and never written), and a deleted character's camp simply
-- decays. `kind` is the camps.yaml piece id (1-based order). Positions are
-- the wire's centimetres (the collision twin uses cm / 100 on both sides).
-- `rot` is the 45 degree rotation step (0-7). `burn_until` is the world
-- clock (unix seconds + the world's offset) when a campfire goes out.
-- `owner_seen_at` is when the owner was last within decay.visitM of their
-- camp: a camp unseen for decay.days is removed (with its chest's items).
-- `party_hash` is the owner's party (zone PartyHash) when last seen, for
-- chests locked to the party (`lock` 1) and signposts on party maps.
-- `world_id` has no foreign key, like door_state (0024).
CREATE TABLE IF NOT EXISTS camp_pieces (
    world_id           uuid NOT NULL,
    piece_id           bigint NOT NULL,
    owner_character_id text NOT NULL,
    owner_name         text NOT NULL DEFAULT '',
    kind               smallint NOT NULL,
    x_cm               integer NOT NULL,
    y_cm               integer NOT NULL,
    z_cm               integer NOT NULL,
    rot                smallint NOT NULL DEFAULT 0,
    label              text NOT NULL DEFAULT '',
    lock               smallint NOT NULL DEFAULT 0,
    party_hash         bigint NOT NULL DEFAULT 0,
    burn_until         double precision NOT NULL DEFAULT 0,
    placed_at          timestamptz NOT NULL DEFAULT now(),
    owner_seen_at      timestamptz NOT NULL DEFAULT now(),
    zone_id            text NOT NULL DEFAULT '',
    updated_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (world_id, piece_id)
);
CREATE INDEX IF NOT EXISTS camp_pieces_owner ON camp_pieces (world_id, owner_character_id);

-- Camp storage: an item in a chest is an `items` row like a dropped one
-- (owner_character_id NULL, world_id and world_pos set, 0014) that also
-- names its chest; it never despawns (despawn_at NULL) and is never restored
-- as a pickup. Putting an item in and taking it out are item-journal
-- transactions (exactly once: a take checks the row still lies in the chest).
ALTER TABLE items ADD COLUMN IF NOT EXISTS camp_piece_id bigint;
CREATE INDEX IF NOT EXISTS items_in_camp ON items (world_id, camp_piece_id) WHERE camp_piece_id IS NOT NULL;
