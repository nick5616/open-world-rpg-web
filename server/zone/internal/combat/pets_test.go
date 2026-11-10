package combat

import (
	"math"
	"testing"

	"lodestone/server/pkg/movement"
)

// Pets (CR 029) in the combat world: a pet follows its owner and catches up
// at once from afar; it joins a fight against what fights its owner, never
// starts one with a sleeping creature, bites until it falls and earns the
// XP; its bites draw the creature onto it and enemy strikes hurt it; at
// zero health it is knocked out (removed, reported); stay holds a spot, an
// attack order picks the target; abilities (heal, buff, charge, strike);
// taming's calm: a weakened tameable is reported, a calmed one stands and
// never attacks, a hit breaks the calm, Tame removes it without XP.

func testPetSpec(owner uint32, at movement.Vec3) PetSpec {
	return PetSpec{Owner: owner, Slot: 1, Enemy: "wolf", Level: 1, Element: -1, HPMax: 130, HP: 130, Damage: 11, Speed: 9.4, Reach: 2.2, EveryMs: 1100, WindupMs: 250,
		AggroM: 16, LeashM: 28, FollowM: 2.6, WarpM: 60, GuardM: 10, RegenPctS: 0.02, Pos: at}
}

func stepN(w *World, n int) {
	for i := 0; i < n; i++ {
		w.Step(w.tick + 1)
		w.Drain()
	}
}

func TestPetFollowsAndWarps(t *testing.T) {
	w, _ := newWorld()
	h := newHand(w, 1, movement.Vec3{X: 100, Z: 100}, "sword")
	pet := w.SpawnPet(testPetSpec(h.p.ID, movement.Vec3{X: 110, Z: 100}))
	if pet == nil || w.Summon(pet.ID) != pet || w.Enemy(pet.ID) != nil || pet.TypeID()&PetTypeBit == 0 || pet.HealthPct() != 100 {
		t.Fatalf("spawned %+v", pet)
	}
	stepN(w, 60)
	if d := hdist(pet.Pos, h.p.Pos); d > 4.5 {
		t.Fatalf("pet %.1f m from its owner after 2 s", d)
	}
	// The owner walks 30 m: it follows.
	h.p.Pos.X += 30
	stepN(w, 120)
	if d := hdist(pet.Pos, h.p.Pos); d > 4.5 {
		t.Fatalf("pet %.1f m behind after the owner walked", d)
	}
	// A fast travel: it is there at once.
	h.p.Pos = movement.Vec3{X: 600, Y: 5, Z: 600}
	stepN(w, 1)
	if d := hdist(pet.Pos, h.p.Pos); d > 4 {
		t.Fatalf("pet did not catch up (%.1f m)", d)
	}
	// One pet per owner; leaving removes it.
	p2 := w.SpawnPet(testPetSpec(h.p.ID, h.p.Pos))
	if len(w.Pets()) != 1 || w.PetOf(h.p.ID) != p2 {
		t.Fatal("two pets for one owner")
	}
	w.RemovePlayer(h.p.ID)
	if len(w.Pets()) != 0 {
		t.Fatal("a pet outlived its owner leaving")
	}
}

func TestPetFightsLevelsAndIsKnockedOut(t *testing.T) {
	w, _ := newWorld()
	h := newHand(w, 1, movement.Vec3{X: 100, Z: 100}, "sword")
	h.p.HPMax, h.p.HP = 1e6, 1e6
	pet := w.SpawnPet(testPetSpec(h.p.ID, movement.Vec3{X: 101, Z: 101}))
	// A sleeping creature is left alone.
	sleeper := spawnOne(w, "boar", movement.Vec3{X: 108, Z: 100})
	sleeper.Group.Dummy = true // it stands idle (never notices the owner)
	stepN(w, 60)
	if sleeper.HP < sleeper.HPMax {
		t.Fatal("the pet started a fight")
	}
	// It turns on the owner: the pet joins in and bites until it falls.
	sleeper.Group.Dummy = false
	sleeper.State, sleeper.Target = Chase, h.p.ID
	sleeper.HPMax, sleeper.HP = 60, 60
	var xp []PetXP
	for i := 0; i < 600 && sleeper.Alive(); i++ {
		w.Step(w.tick + 1)
		xp = append(xp, w.DrainPets().XP...)
		w.Drain()
	}
	if sleeper.Alive() {
		t.Fatalf("the boar outlived the pet (hp %.0f)", sleeper.HP)
	}
	if len(xp) != 1 || xp[0].Slot != 1 || xp[0].XP <= 0 {
		t.Fatalf("pet XP %+v", xp)
	}
	// Bites draw a creature onto the pet; its strikes hurt the pet.
	brute := spawnOne(w, "boar", movement.Vec3{X: 106, Z: 100})
	brute.HPMax, brute.HP = 1e5, 1e5
	brute.State, brute.Target = Chase, h.p.ID
	var kos []PetKO
	turned := false
	for i := 0; i < 3000 && len(kos) == 0; i++ {
		w.Step(w.tick + 1)
		kos = append(kos, w.DrainPets().KO...)
		w.Drain()
		turned = turned || brute.petTgt == pet.ID
	}
	if !turned {
		t.Fatal("the boar never turned on the pet")
	}
	if len(kos) != 1 || kos[0].Slot != 1 || w.PetOf(h.p.ID) != nil || w.Summon(pet.ID) != nil {
		t.Fatalf("knocked out: %+v, still out %v", kos, w.PetOf(h.p.ID) != nil)
	}
	stepN(w, 30)
	if brute.petTgt != 0 {
		t.Fatal("the boar still chases a knocked-out pet")
	}
}

func TestPetCommandsAndAbilities(t *testing.T) {
	w, _ := newWorld()
	h := newHand(w, 1, movement.Vec3{X: 100, Z: 100}, "sword")
	h.p.HPMax, h.p.HP = 1e6, 1e6
	pet := w.SpawnPet(testPetSpec(h.p.ID, movement.Vec3{X: 101, Z: 100}))
	stepN(w, 10)
	// Stay: the owner walks away, the pet holds its spot.
	w.CommandPet(pet, PetStay, 0)
	spot := pet.Pos
	h.p.Pos.X += 20
	stepN(w, 90)
	if hdist(pet.Pos, spot) > 1.5 {
		t.Fatalf("stay: moved %.1f m", hdist(pet.Pos, spot))
	}
	// Follow again, then an attack order on a creature nobody fights.
	w.CommandPet(pet, PetFollow, 0)
	stepN(w, 90)
	idle := spawnOne(w, "ram", movement.Vec3{X: h.p.Pos.X + 8, Z: 100})
	idle.HPMax, idle.HP = 1e4, 1e4
	w.CommandPet(pet, PetFollow, idle.ID)
	stepN(w, 120)
	if idle.HP >= 1e4 || idle.lastPetHit != pet.ID {
		t.Fatal("the pet ignored its attack order")
	}
	// The wolf's howl: the owner's damage goes up while they fight.
	pet.pet.spec.Ability = PetAbility{ID: 3, Kind: "buff", CooldownS: 20, Power: 0.15, DurationS: 8, Element: -1}
	pet.pet.abilityAt = 0
	var acts []PetAct
	for i := 0; i < 30; i++ {
		w.Step(w.tick + 1)
		acts = append(acts, w.DrainPets().Acts...)
		w.Drain()
	}
	if len(acts) == 0 || acts[0].Ability != 3 || h.p.petBuffEnd <= w.tick || math.Abs(h.p.petBuffMult-1.15) > 1e-9 {
		t.Fatalf("howl: acts %+v buff %v until %d", acts, h.p.petBuffMult, h.p.petBuffEnd)
	}
	// A heal (the slime's): the owner below the line is healed.
	pet.pet.spec.Ability = PetAbility{ID: 1, Kind: "heal", CooldownS: 12, Power: 0.12, HealBelow: 0.7, Element: -1}
	pet.pet.abilityAt = 0
	h.p.HPMax, h.p.HP = 200, 100
	stepN(w, 5)
	if h.p.HP < 100+0.12*200-1 {
		t.Fatalf("mend: owner at %.0f", h.p.HP)
	}
	// A charge stuns at the end of the rush.
	pet.pet.spec.Ability = PetAbility{ID: 4, Kind: "charge", CooldownS: 9, Power: 2, RangeMin: 4, RangeMax: 12, Status: "stun", Element: -1}
	pet.pet.abilityAt = 0
	idle.Pos = movement.Vec3{X: pet.Pos.X + 8, Y: 5, Z: pet.Pos.Z}
	pet.ally.target = idle.ID
	stunned := false
	for i := 0; i < 60 && !stunned; i++ {
		w.Step(w.tick + 1)
		w.Drain()
		stunned = idle.has("stun", w.tick)
	}
	if !stunned {
		t.Fatal("the charge never stunned")
	}
}

func TestTamingCalm(t *testing.T) {
	w, _ := newWorld()
	h := newHand(w, 1, movement.Vec3{X: 100, Z: 100}, "sword")
	h.p.HPMax, h.p.HP = 1e6, 1e6
	e := spawnOne(w, "wolf", movement.Vec3{X: 103, Z: 100})
	// Taming off: nothing is reported.
	w.applyDamage(e, h.p.ID, e.HPMax*0.6, 8, e.Pos, 0, true, false)
	if len(w.DrainPets().Weakened) != 0 {
		t.Fatal("reported with taming off")
	}
	w.Tameable, w.TameWeakenPct = map[int]bool{e.Def.ID: true}, 0.5
	e.HP = e.HPMax * 0.9
	w.applyDamage(e, h.p.ID, e.HPMax*0.2, 8, e.Pos, 0, true, false) // still above half
	if len(w.DrainPets().Weakened) != 0 {
		t.Fatal("reported above the weaken share")
	}
	w.applyDamage(e, h.p.ID, e.HPMax*0.3, 8, e.Pos, 0, true, false)
	wk := w.DrainPets().Weakened
	if len(wk) != 1 || wk[0].Enemy != e || wk[0].By != h.p.ID {
		t.Fatalf("weakened %+v", wk)
	}
	// Calm: it stands and never strikes, even with the player beside it.
	w.Calm(e, 20)
	hp := h.p.HP
	telegraphs := 0
	for i := 0; i < 90; i++ {
		w.Step(w.tick + 1)
		for _, o := range w.Events {
			if o.Ev.Kind == EvTelegraph && o.Ev.EntityID == e.ID {
				telegraphs++
			}
		}
		w.Drain()
		if hdist(e.Pos, movement.Vec3{X: 103, Z: 100}) > 0.5 {
			t.Fatal("a calm creature walked")
		}
	}
	if telegraphs != 0 || h.p.HP != hp || !e.Calm(w.tick) {
		t.Fatalf("calm creature attacked (%d) or the calm ended early", telegraphs)
	}
	// A pet leaves a calm creature alone.
	pet := w.SpawnPet(testPetSpec(h.p.ID, movement.Vec3{X: 101, Z: 101}))
	stepN(w, 60)
	if e.lastPetHit == pet.ID {
		t.Fatal("the pet bit a calm creature")
	}
	// A hit breaks the calm: it fights on.
	w.applyDamage(e, h.p.ID, 1, 8, e.Pos, 0, true, false)
	out := w.DrainPets()
	if len(out.CalmBroken) != 1 || e.Calm(w.tick) || e.State != Chase {
		t.Fatalf("calm not broken: %+v state %v", out, e.State)
	}
	// Tame: gone without XP or a kill.
	w.Calm(e, 5)
	kills := w.Stats.Kills
	if !w.Tame(e) || w.Enemy(e.ID) != nil || w.Stats.Kills != kills {
		t.Fatal("tame")
	}
	_, _, removed, xp, _, _ := w.Drain()
	if len(removed) != 1 || removed[0] != e || len(xp) != 0 {
		t.Fatalf("removed %v xp %v", removed, xp)
	}
	// A calm runs out by itself.
	f := spawnOne(w, "wolf", movement.Vec3{X: 90, Z: 90})
	w.Calm(f, 1)
	stepN(w, 40)
	if f.Calm(w.tick) || f.calmUntil != 0 {
		t.Fatal("the calm never ended")
	}
}
