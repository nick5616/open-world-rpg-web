package game

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// Combat profiles live in character_progress (spec 11 columns, no new
// migration): skill_tree = {"v":1, loadouts, active, weaponSkills},
// spells_known = learned spells, spells_equipped = the active loadout's four
// slots ("" = empty). Decision 0013.

// LoadCombat implements CombatStore.
func (p *PGStore) LoadCombat(ctx context.Context, id string) ([]byte, []string, bool, error) {
	if !uuidRe.MatchString(id) {
		return nil, nil, false, nil // bots and dev tickets: no row
	}
	var tree []byte
	var known []string
	err := p.Pool.QueryRow(ctx, `SELECT skill_tree, spells_known FROM character_progress WHERE character_id = $1::uuid`, id).Scan(&tree, &known)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, false, nil
	}
	if err != nil {
		return nil, nil, false, err
	}
	return tree, known, true, nil
}

// SaveCombat implements CombatStore.
func (p *PGStore) SaveCombat(ctx context.Context, id string, tree []byte, known, equipped []string) error {
	if !uuidRe.MatchString(id) {
		return ErrNoRow
	}
	var exists bool
	if err := p.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM characters WHERE id = $1::uuid)`, id).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNoRow
	}
	if known == nil {
		known = []string{}
	}
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO character_progress (character_id, skill_tree, spells_known, spells_equipped)
		VALUES ($1::uuid, $2::jsonb, $3, $4)
		ON CONFLICT (character_id) DO UPDATE SET skill_tree = EXCLUDED.skill_tree, spells_known = EXCLUDED.spells_known, spells_equipped = EXCLUDED.spells_equipped`,
		id, string(tree), known, equipped)
	return err
}
