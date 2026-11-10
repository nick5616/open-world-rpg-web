package content

import (
	"testing"

	"lodestone/server/pkg/contentdefs"
)

// Pets (CR 029), the pure part: the taming roll is deterministic in its
// inputs and depends on each of them; favourite food is faster and likelier;
// stats grow with level and variant; XP levels up to the cap; the stable's
// size; records round-trip as JSON; tames count for the feats.

func TestTameRollDeterministic(t *testing.T) {
	sp := contentdefs.D.PetByKey("wolf")
	if sp == nil {
		t.Fatal("no wolf species")
	}
	a := RollTame(42, "char-a", 3, 1001, sp, false, 2)
	b := RollTame(42, "char-a", 3, 1001, sp, false, 2)
	if a != b {
		t.Fatalf("same inputs, different rolls: %+v %+v", a, b)
	}
	// Each input moves the roll: over many creatures the outcomes differ by
	// world, character and roll count.
	diff := func(f func(i int) (TameRoll, TameRoll)) int {
		n := 0
		for i := 0; i < 400; i++ {
			x, y := f(i)
			if x.OK != y.OK || x.Variant != y.Variant {
				n++
			}
		}
		return n
	}
	if diff(func(i int) (TameRoll, TameRoll) {
		return RollTame(42, "a", 0, uint32(i), sp, false, 0), RollTame(43, "a", 0, uint32(i), sp, false, 0)
	}) == 0 {
		t.Fatal("the world seed does not change rolls")
	}
	if diff(func(i int) (TameRoll, TameRoll) {
		return RollTame(42, "a", 0, uint32(i), sp, false, 0), RollTame(42, "b", 0, uint32(i), sp, false, 0)
	}) == 0 {
		t.Fatal("the character does not change rolls")
	}
	if diff(func(i int) (TameRoll, TameRoll) {
		return RollTame(42, "a", i, 7, sp, false, 0), RollTame(42, "a", i+1, 7, sp, false, 0)
	}) == 0 {
		t.Fatal("the roll count does not change rolls")
	}
}

func TestTameRollOddsAndVariants(t *testing.T) {
	sp := contentdefs.D.PetByKey("wolf")
	tm := &contentdefs.D.Taming
	const n = 20000
	ok, okFav, shiny, elem := 0, 0, 0, 0
	for i := 0; i < n; i++ {
		r := RollTame(7, "c", i, uint32(i*31), sp, false, 3)
		if r.OK {
			ok++
			switch r.Variant {
			case VariantShiny:
				shiny++
			case VariantElemental:
				elem++
				if r.Element != 3 {
					t.Fatalf("elemental took %d, the region is 3", r.Element)
				}
			}
		}
		if RollTame(7, "c", i, uint32(i*31), sp, true, 3).OK {
			okFav++
		}
	}
	near := func(got int, want float64, what string) {
		if g := float64(got) / n; g < want*0.85 || g > want*1.15 {
			t.Errorf("%s: %.3f, want ~%.3f", what, g, want)
		}
	}
	near(ok, sp.Chance, "plain chance")
	near(okFav, sp.Chance+tm.FavouriteBonus, "favourite chance")
	if okFav <= ok {
		t.Error("the favourite food is no likelier")
	}
	near(shiny, sp.Chance*tm.ShinyChance, "shiny")
	near(elem, sp.Chance*tm.ElementalChance, "elemental")
	// A region without an element still gives an elemental one.
	for i := 0; i < 5000; i++ {
		if r := RollTame(7, "c", i, 9, sp, true, -1); r.Variant == VariantElemental && (r.Element < 0 || r.Element > 7) {
			t.Fatalf("elemental without an element: %+v", r)
		}
	}
}

func TestTameTimeFoodAndStats(t *testing.T) {
	sp := contentdefs.D.PetByKey("slime")
	if TameTime(sp, true) >= TameTime(sp, false) {
		t.Error("the favourite food is not faster")
	}
	have := map[string]int{sp.Foods[1]: 2}
	if f, fav := LikedFood(sp, func(k string) int { return have[k] }); f != sp.Foods[1] || fav {
		t.Errorf("liked food %q fav %v", f, fav)
	}
	have[sp.Foods[0]] = 1
	if f, fav := LikedFood(sp, func(k string) int { return have[k] }); f != sp.Foods[0] || !fav {
		t.Errorf("the favourite was not chosen first: %q", f)
	}
	if f, _ := LikedFood(sp, func(string) int { return 0 }); f != "" {
		t.Error("food from nothing")
	}
	h1, d1 := PetStats(sp, 1, VariantPlain)
	h5, d5 := PetStats(sp, 5, VariantPlain)
	hs, ds := PetStats(sp, 1, VariantShiny)
	if h1 != sp.HP || d1 != sp.Damage || h5 <= h1 || d5 <= d1 || hs <= h1 || ds <= d1 {
		t.Errorf("stats lv1 %v/%v lv5 %v/%v shiny %v/%v", h1, d1, h5, d5, hs, ds)
	}
	// Every species has an ability and favourite foods that exist.
	for _, s := range contentdefs.D.Taming.Species {
		if contentdefs.D.PetAbility(s.Ability) == nil || len(s.Foods) == 0 {
			t.Errorf("species %s", s.Key)
		}
	}
}

func TestPetLevelsAndStable(t *testing.T) {
	tm := &contentdefs.D.Taming
	r := PetRec{Species: "wolf", Level: 1}
	if n := r.GainXP(contentdefs.D.PetXPToNext(1)); n != 1 || r.Level != 2 || r.XP != 0 {
		t.Fatalf("one level's XP: +%d -> %+v", n, r)
	}
	if n := r.GainXP(1 << 30); r.Level != tm.LevelMax || n != tm.LevelMax-2 || r.XP != 0 {
		t.Fatalf("capped at %d: %+v (+%d)", tm.LevelMax, r, n)
	}
	if r.GainXP(100) != 0 {
		t.Fatal("levels past the cap")
	}
	st := &PetState{V: 1}
	for i := 0; i < tm.MaxPets; i++ {
		p, ok := st.Add(PetRec{Species: "slime", Name: "S", Level: 1})
		if !ok || p.ID != i+1 {
			t.Fatalf("add %d: %+v %v", i, p, ok)
		}
	}
	if st.Active != 1 {
		t.Fatalf("the first tamed is the active one: %d", st.Active)
	}
	if _, ok := st.Add(PetRec{Species: "slime"}); ok || !st.Full() {
		t.Fatal("the stable took one too many")
	}
	if !st.Release(1) || st.Active != 0 || st.Pet(1) != nil {
		t.Fatal("release")
	}
	p, ok := st.Add(PetRec{Species: "boar", Level: 3})
	if !ok || p.ID != tm.MaxPets+1 {
		t.Fatalf("ids are never reused: %+v", p)
	}
	st.Pets[0].KOUntil, st.Rolls, st.Mode = 123, 9, 1
	back := LoadPets(st.JSON())
	if len(back.Pets) != len(st.Pets) || back.Pets[0].KOUntil != 123 || back.Rolls != 9 || back.Mode != 1 || back.Active != st.Active || back.BestLevel() != 3 {
		t.Fatalf("round trip %+v", back)
	}
	if LoadPets([]byte("not json")).V != 1 {
		t.Fatal("bad JSON")
	}
}

func TestTamedFeats(t *testing.T) {
	s := NewState()
	if !s.Tamed("wolf", false) || s.Tamed("wolf", true) {
		t.Fatal("first per species")
	}
	s.Tamed("slime", false)
	if s.Stat2("tamed") != 3 || s.Stat2("tamedspecies") != 2 || s.Stat2("shinytamed") != 1 || s.Stat2("petlevel") != -1 {
		t.Fatalf("stats %v", s.Stats)
	}
	got := map[string]bool{}
	for _, f := range s.NewFeats(nil) {
		got[f.Key] = true
	}
	if !got["first_pet"] || !got["shiny_pet"] || got["menagerie"] {
		t.Fatalf("feats %v", got)
	}
	if LoadState(s.JSON()).TamedKinds["wolf"] != 2 {
		t.Fatal("tamed kinds not saved")
	}
}
