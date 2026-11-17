package game

import (
	"testing"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/structures"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/explore"
)

// Chest gear (CR 043): none-to-some at tier 1, a hall's always one, rarer
// and higher level the deeper the floor.
func TestChestGearByTierAndDepth(t *testing.T) {
	count := func(tier int, y float64) (n, rarity, level int) {
		for seed := uint64(1); seed <= 400; seed++ {
			if it := chestGear(seed*0x9E3779B97F4A7C15, tier, y); it != nil {
				n++
				rarity += it.Rarity
				level += it.Level
			}
		}
		return
	}
	n1, _, _ := count(1, -20)
	n2, _, _ := count(2, -20)
	n3, r3shallow, l3shallow := count(3, -20)
	_, r3deep, l3deep := count(3, -230)
	if n1 < 20 || n1 > 110 || n2 < 130 || n2 > 240 || n3 != 400 {
		t.Fatalf("gear per 400 chests: tier 1 %d, tier 2 %d, tier 3 %d", n1, n2, n3)
	}
	if r3deep <= r3shallow || l3deep <= l3shallow {
		t.Fatalf("depth does not help: rarity %d -> %d, level %d -> %d", r3shallow, r3deep, l3shallow, l3deep)
	}
}

// Event 1863 beside the deep warden's engaged / defeated boss events.
func TestLowerHallsEvent(t *testing.T) {
	ed := combatdefs.D.EnemyByKey("deep_warden")
	if ed == nil {
		t.Fatal("no deep_warden")
	}
	s := &Server{cfg: Config{Explore: &explore.World{Atlas: &structures.Atlas{Sites: []structures.Site{
		{Index: 0, Category: structures.CategoryPOI, Kind: structures.POIWaypoint, X: 5, Z: 5},
		{Index: 1, Category: structures.CategoryPOI, Kind: structures.POILowerHalls, X: 100, Z: 200},
	}}}}}
	at := movement.Vec3{X: 101, Y: -150, Z: 199}
	mk := func(kind uint16) combat.Out {
		return combat.Out{Aud: combat.Audience{Near: at, Radius: 60}, Ev: proto.Event{Kind: kind, EntityID: 77, TargetID: uint32(ed.ID), X: proto.MetersToCm(at.X), Y: proto.MetersToCm(at.Y), Z: proto.MetersToCm(at.Z)}}
	}
	out := s.dwarfWardenEvents([]combat.Out{mk(combat.EvBossEngaged), mk(combat.EvBossDefeated)})
	if len(out) != 4 {
		t.Fatalf("%d events", len(out))
	}
	for i, want := range []int32{0, 1} {
		e := out[2+i]
		if e.Ev.Kind != EventLowerHalls || e.Ev.Value != want || e.Ev.TargetID != 1 || e.Ev.EntityID != 77 || e.Aud.Radius != 140 {
			t.Fatalf("event %d: %+v aud %+v", i, e.Ev, e.Aud)
		}
	}
}
