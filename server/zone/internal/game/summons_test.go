package game

import (
	"testing"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/combat"
)

// CR 020: a summon spell's ally travels as EntityKind effect named for its
// caster, and fights a player only under the PvP rules (both flagged here).
func TestSummonEntityAndPvPRules(t *testing.T) {
	r := newPvPRig(t)
	a := r.add("Ana", 600, 600)
	b := r.add("Bo", 605, 600)
	r.ticks(5)
	p := a.ent().cbt
	p.Profile.Known = append(p.Profile.Known, "wraith_hound")
	p.Profile.Loadouts[p.Profile.Active].Spells[0] = "wraith_hound"
	p.Mana = p.ManaMax
	a.flags = proto.InputFlagCast
	r.ticks(3)
	var ally *Entity
	for _, e := range r.srv.ents {
		if e.Kind == proto.EntityKindEffect {
			ally = e
		}
	}
	if ally == nil {
		t.Fatal("no ally entity")
	}
	def := combatdefs.D.SummonByKey("wraith_hound")
	if ally.Name != "Ana's Wraith Hound" || ally.TypeID != combatdefs.SummonTypeID(def) {
		t.Fatalf("ally entity %q typeId %#x", ally.Name, ally.TypeID)
	}
	r.seconds(4)
	if _, n := b.last(combat.EvPvPHit); n != 0 {
		t.Fatal("an ally hit an unflagged player")
	}
	a.interact(PvPActFlag, 0, 1)
	b.interact(PvPActFlag, 0, 1)
	r.seconds(5)
	if _, n := b.last(combat.EvPvPHit); n == 0 {
		t.Fatal("an ally never attacked a flagged hostile player")
	}
	// The caster leaves: the ally goes with them.
	r.srv.leave(a.sess)
	r.ticks(2)
	for _, e := range r.srv.ents {
		if e.Kind == proto.EntityKindEffect {
			t.Fatal("the ally outlived its caster")
		}
	}
}
