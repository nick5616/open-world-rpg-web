package game

// Playtest 5 town life (CR 054): petting a town animal. The rules are pure
// (petRefusal); the wire is checked on the official world's real settlement:
// a start tells the player standing beside (not the petter), a stop too, and
// a mounted, hurt, airborne, far-from-any-town or spamming start is refused.

import (
	"testing"
	"time"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

func TestAnimalKeyRoundTrips(t *testing.T) {
	for _, c := range [][2]int{{0, 0}, {0, 3}, {41, 255}, {1000, 17}} {
		si, idx := splitAnimalKey(animalKey(c[0], c[1]))
		if si != c[0] || idx != c[1] {
			t.Errorf("%v -> %d %d", c, si, idx)
		}
	}
}

func TestPetRefusalRules(t *testing.T) {
	ok := petFacts{onGround: true, inTown: true}
	cases := []struct {
		name string
		f    petFacts
		want int32
	}{
		{"fine", ok, 0},
		{"mounted", petFacts{onGround: true, inTown: true, riding: true}, PetRefuseMounted},
		{"in combat", petFacts{onGround: true, inTown: true, hurt: true}, PetRefuseCombat},
		{"airborne", petFacts{inTown: true}, PetRefuseNotOnGnd},
		{"spam", petFacts{onGround: true, inTown: true, spamming: true}, PetRefuseTooFast},
		{"no town", petFacts{onGround: true}, PetRefuseNoTown},
		{"mounted beats combat", petFacts{onGround: true, inTown: true, riding: true, hurt: true}, PetRefuseMounted},
	}
	for _, c := range cases {
		if got := petRefusal(c.f); got != c.want {
			t.Errorf("%s: %d, want %d", c.name, got, c.want)
		}
	}
}

func TestAnimalPetIsToldToNeighboursOnly(t *testing.T) {
	h, store, w, _, _ := meadowsHarness(t)
	si := spawnSettlement(t, w)
	st := w.T.Settlements[si]
	g := h.srv.cfg.Ground
	const charA, charB = "33333333-4444-5555-6666-777777777791", "33333333-4444-5555-6666-777777777792"
	at := func(dx float64) movement.Vec3 {
		x, z := st.X+dx, st.Z+2
		return movement.Vec3{X: x, Y: g.HeightAt(x, z) + 0.3, Z: z}
	}
	store.rows[charA] = at(0)
	store.rows[charB] = at(3)
	a := h.dial("")
	a.join(h, charA, "Petter")
	b := h.dial("")
	b.join(h, charB, "Watcher")
	for _, c := range []*client{a, b} {
		c.pump(300 * time.Millisecond)
	}
	key := uint64(animalKey(si, 2))
	a.send(&proto.Interact{TargetKind: InteractPetAnimal, TargetID: key, Action: PetActStart})
	a.pump(200 * time.Millisecond)
	b.pump(150 * time.Millisecond)
	got := b.eventsOf(EventAnimalPet)
	if len(got) != 1 || got[0].TargetID != uint32(key) || got[0].Value != 1 {
		t.Fatalf("watcher saw %+v (refusals to the petter: %+v)", got, a.eventsOf(EventAnimalPetRefused))
	}
	if n := len(a.eventsOf(EventAnimalPet)); n != 0 {
		t.Fatalf("the petter got %d echoes", n)
	}
	// A second start inside the limiter window is refused.
	a.send(&proto.Interact{TargetKind: InteractPetAnimal, TargetID: key, Action: PetActStart})
	a.pump(150 * time.Millisecond)
	if r := a.eventsOf(EventAnimalPetRefused); len(r) != 1 || r[0].Value != PetRefuseTooFast {
		t.Fatalf("spam refusal: %+v", r)
	}
	// Moving away stops it, and the watcher is told.
	a.send(&proto.Interact{TargetKind: InteractPetAnimal, TargetID: key, Action: PetActStop})
	a.pump(150 * time.Millisecond)
	b.pump(150 * time.Millisecond)
	got = b.eventsOf(EventAnimalPet)
	if len(got) != 2 || got[1].Value != 0 {
		t.Fatalf("stop: %+v", got)
	}
	// A stop with nothing running says nothing.
	a.send(&proto.Interact{TargetKind: InteractPetAnimal, TargetID: key, Action: PetActStop})
	a.pump(100 * time.Millisecond)
	b.pump(100 * time.Millisecond)
	if n := len(b.eventsOf(EventAnimalPet)); n != 2 {
		t.Fatalf("a stray stop was broadcast: %d", n)
	}
	// An animal of a settlement that does not exist is refused.
	time.Sleep(petEvery)
	a.send(&proto.Interact{TargetKind: InteractPetAnimal, TargetID: uint64(animalKey(len(w.T.Settlements)+5, 0)), Action: PetActStart})
	a.pump(150 * time.Millisecond)
	if r := a.eventsOf(EventAnimalPetRefused); len(r) != 2 || r[1].Value != PetRefuseNoTown {
		t.Fatalf("no town refusal: %+v", r)
	}
}
