-- 0012_exploration_pins (WP12, docs/cr/003-exploration.md): personal map pins.
-- Purely additive.
--
-- Spec 8 gives every character up to 10 personal map pins that persist;
-- 0001's character_progress has the exploration bitsets (towers, waypoints,
-- discoveries) but nowhere for pins. A jsonb array of {slot, color, x, z}
-- (x/z in centimeters, slot 0..9) keeps them with the rest of the
-- character's exploration state, written in the same transaction.
--
-- Numbered 0012 (the work package), not 0004: several Phase 3 packages add
-- migrations in parallel and the migrator refuses duplicate versions;
-- versions need not be contiguous (migrate.Apply runs every version not yet
-- recorded, in order).

ALTER TABLE character_progress ADD COLUMN pins jsonb NOT NULL DEFAULT '[]'::jsonb;
