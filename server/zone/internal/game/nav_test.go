package game

import (
	"math"
	"testing"

	"lodestone/server/pkg/movement"
	"lodestone/server/zone/internal/combat"
)

// Playtest 2 pathfinding on the official world's caves (seed 20261108):
// a pet whose owner went down a cave mouth walks in after them (the cave
// graph's route: the mouth, the entry tunnel, the entrance chamber) instead
// of walking about on the hillside overhead or warping.
func TestPetWalksIntoACaveMouth(t *testing.T) {
	ct := testCaveTerrain(t)
	g := ct.CaveGraph()
	tried := 0
	for oi := range g.OpeningsList {
		o := g.OpeningsList[oi]
		if o.Sinkhole || o.System < 0 || o.System >= len(g.Systems) {
			continue
		}
		sys := g.Systems[o.System]
		ch := g.Chambers[sys.FirstChamber] // the entrance chamber
		dx, dz := o.X-ch.X, o.Z-ch.Z
		l := math.Hypot(dx, dz)
		if l < 1 {
			continue
		}
		// the pet starts on the hillside 12 m out from the mouth
		sx, sz := o.X+dx/l*(o.RMask+12), o.Z+dz/l*(o.RMask+12)
		sy := ct.HeightAt(sx, sz)
		if ct.InCave(sx, sy, sz) || movement.WaterAt(ct, sx, sz) > sy {
			continue
		}
		ct.Caves.Ensure(o.X, o.Y, o.Z, 90)
		ct.Caves.Ensure(ch.X, ch.Y, ch.Z, 60)
		owner := movement.Vec3{X: ch.X, Y: ct.FloorAt(ch.X, ch.Y, ch.Z), Z: ch.Z}
		if !ct.InCave(owner.X, owner.Y, owner.Z) || owner.Y < ch.Y-ch.RY-2 {
			continue // no floor under the chamber centre
		}
		tried++
		id := uint32(100)
		w := combat.NewWorld(combat.Config{Seed: 1, NoWildPacks: true}, ct, func() uint32 { id++; return id })
		p := combat.NewPlayer(1, "owner", combat.NewProfile(), 1)
		p.Pos = owner
		w.AddPlayer(p)
		pet := w.SpawnPet(combat.PetSpec{Owner: 1, Slot: 1, Enemy: "wolf", Level: 1, Element: -1, HPMax: 130, HP: 130, Damage: 11, Speed: 9.4, Reach: 2.2,
			EveryMs: 1100, WindupMs: 250, AggroM: 16, LeashM: 28, FollowM: 2.6, WarpM: 60, GuardM: 10, RegenPctS: 0.02, Pos: movement.Vec3{X: sx, Z: sz}})
		if pet == nil {
			t.Fatal("no pet")
		}
		start := pet.Pos
		prev, jump := pet.Pos, 0.0
		reached := -1
		for i := 0; i < 30*40 && reached < 0; i++ {
			w.Step(uint32(i + 1))
			w.Drain()
			jump = math.Max(jump, math.Sqrt(sq(pet.Pos.X-prev.X)+sq(pet.Pos.Y-prev.Y)+sq(pet.Pos.Z-prev.Z)))
			prev = pet.Pos
			if hdist2(pet.Pos, owner) < 5 && math.Abs(pet.Pos.Y-owner.Y) < 3 {
				reached = i
			}
		}
		st := w.NavStats()
		t.Logf("mouth %d (system %d): pet from %.1f,%.1f,%.1f to the owner at %.1f,%.1f,%.1f (%.1f m below the mouth); reached after %.1f s, biggest step %.2f m, nav %+v",
			oi, o.System, start.X, start.Y, start.Z, owner.X, owner.Y, owner.Z, o.Y-owner.Y, float64(reached)/30, jump, st)
		if reached < 0 {
			t.Fatalf("the pet never reached its owner in the cave (it is at %+v)", pet.Pos)
		}
		if jump > 2 {
			t.Fatalf("the pet warped (a %.1f m step)", jump)
		}
		if st.CavePaths == 0 {
			t.Fatal("no cave route was used")
		}
		// and out again: the owner is back on the hillside
		p.Pos = start
		out, jump := -1, 0.0
		for i := 0; i < 30*40 && out < 0; i++ {
			w.Step(uint32(30*40 + i + 1))
			w.Drain()
			jump = math.Max(jump, math.Sqrt(sq(pet.Pos.X-prev.X)+sq(pet.Pos.Y-prev.Y)+sq(pet.Pos.Z-prev.Z)))
			prev = pet.Pos
			if hdist2(pet.Pos, start) < 5 && math.Abs(pet.Pos.Y-start.Y) < 3 {
				out = i
			}
		}
		t.Logf("  and out again after %.1f s, biggest step %.2f m, nav %+v", float64(out)/30, jump, w.NavStats())
		if out < 0 || jump > 2 {
			t.Fatalf("the pet did not walk out after its owner (at %+v, biggest step %.1f m)", pet.Pos, jump)
		}
		if tried >= 2 {
			return
		}
	}
	if tried == 0 {
		t.Fatal("no cave mouth with open hillside in front and a chamber floor")
	}
}

func hdist2(a, b movement.Vec3) float64 { return math.Hypot(a.X-b.X, a.Z-b.Z) }
