-- 0029_pets (playtest 2 taming and pet companions, docs/cr/029-pets.md):
-- the creatures each character tamed. Purely additive.
--
-- `data` is the zone's internal/content PetState JSON ({"v":1,"pets":[{id,
-- sp (species key), n (name), v (variant: 0 plain, 1 shiny, 2 elemental),
-- el (element or -1), lv, xp, hp (health share), ko (unix ms: knocked out,
-- recovering at home), at (tamed at), k (kills)}], "active": pet id out
-- with you, "next": the next pet id, "rolls": taming rolls made (the
-- roll's seed counter), "mode": the active pet's command mode}). `epoch` is
-- the WP16 ownership epoch of the zone that wrote it, exactly like
-- character_content (0025): an older owner's late save never overwrites a
-- newer zone's (epoch 0 = a single zone, unfenced). Local profiles keep the
-- same JSON in their save blob (`pets`); like the content state, an account
-- upgrade does not copy it yet.
CREATE TABLE IF NOT EXISTS character_pets (
    character_id uuid PRIMARY KEY REFERENCES characters (id) ON DELETE CASCADE,
    data         jsonb NOT NULL DEFAULT '{}',
    epoch        bigint NOT NULL DEFAULT 0,
    updated_at   timestamptz NOT NULL DEFAULT now()
);
