package npc

import (
	"context"
	"encoding/binary"
	"math"
	"os"
	"testing"

	"lodestone/server/pkg/towns"
	"lodestone/server/pkg/worldhost"
)

// officialTowns builds the official world's towns layer (seed 20261108)
// through the real wasm; skipped when worldgen.wasm is not built.
func officialTowns(t *testing.T) *towns.Towns {
	t.Helper()
	mod, err := worldhost.LoadFromEnv(context.Background())
	if err != nil {
		if os.Getenv("LODESTONE_REQUIRE_WASM") == "1" {
			t.Fatal(err)
		}
		t.Skipf("worldgen.wasm not built: %v", err)
	}
	spec, err := mod.SpecFromSeed(20261108)
	if err != nil {
		t.Fatal(err)
	}
	w, err := mod.OpenWorld(spec, 20261108, worldhost.WorldOptions{MaxInstances: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	b, err := w.TownsBytes()
	if err != nil {
		t.Fatal(err)
	}
	tw, err := towns.Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	return tw
}

func flat(_, y, _ float64) float64 { return 0 }

func inside(b *towns.Building, x, z, pad float64) bool {
	dx, dz := x-b.X, z-b.Z
	u := dx*b.C + dz*b.S
	v := dz*b.C - dx*b.S
	return math.Abs(u) < b.HX-pad && math.Abs(v) < b.HZ-pad
}

func TestScheduleDayAndNight(t *testing.T) {
	tw := officialTowns(t)
	w := New(tw, 20261108, nil)
	noon := 12.0 / 24 * DayLengthS
	night := 1.0 / 24 * DayLengthS
	indoors, homed := 0, 0
	for i := range w.NPCs {
		d := w.NPCs[i].Def
		w.Place(i, noon, flat)
		if s := w.NPCs[i]; s.X != d.WorkX && d.Role != towns.RoleVillager {
			t.Fatalf("npc %d (%s) not at work at noon", i, towns.RoleNames[d.Role])
		}
		if !w.Open(i, noon) && d.Role != towns.RoleVillager && d.Role != towns.RoleFarmer {
			t.Errorf("npc %d (%s) closed at noon", i, towns.RoleNames[d.Role])
		}
		w.Place(i, night, flat)
		if w.Works(i, Hour(night)) {
			if d.Role != towns.RoleInnkeeper && d.Role != towns.RoleGuard {
				t.Errorf("npc %d (%s) works at 01:00", i, towns.RoleNames[d.Role])
			}
			continue
		}
		if d.Home < 0 {
			continue
		}
		homed++
		if inside(&tw.Buildings[d.Home], w.NPCs[i].X, w.NPCs[i].Z, 0.1) {
			indoors++
		}
	}
	t.Logf("%d npcs; %d of %d off duty at 01:00 are inside their home", len(w.NPCs), indoors, homed)
	if homed == 0 || indoors != homed {
		t.Fatalf("only %d of %d npcs with homes are indoors at night", indoors, homed)
	}
}

// TestWalkHomeAlongStreets walks every working NPC from work to home at
// dusk and checks it arrives, and that it never cuts through another
// building on the way (it uses doors and streets).
func TestWalkHomeAlongStreets(t *testing.T) {
	tw := officialTowns(t)
	w := New(tw, 20261108, nil)
	dusk := 19.05 / 24 * DayLengthS
	before := 18.9 / 24 * DayLengthS
	walkers, arrived, samples, through := 0, 0, 0, 0
	for i := range w.NPCs {
		d := w.NPCs[i].Def
		if d.Home < 0 || d.Role == towns.RoleInnkeeper || d.Role == towns.RoleGuard || d.Role == towns.RoleFarmer {
			continue
		}
		w.Place(i, before, flat)
		walkers++
		start := w.NPCs[i]
		for k := 0; k < 30*600 && !(w.NPCs[i].At && w.NPCs[i].Goal == GoalHome); k++ {
			w.Step(i, dusk+float64(k)/30, 1.0/30, flat)
			s := &w.NPCs[i]
			if k%15 != 0 {
				continue
			}
			samples++
			st := &tw.Settlements[d.Settlement]
			for b := st.BuildingFirst; b < st.BuildingFirst+st.Buildings; b++ {
				bd := &tw.Buildings[b]
				if bd.Floors == 0 || b == d.Home || inside(bd, start.X, start.Z, 0) {
					continue
				}
				if inside(bd, s.X, s.Z, 0.4) {
					through++
					break
				}
			}
		}
		s := w.NPCs[i]
		if s.At && math.Hypot(s.X-d.HomeX, s.Z-d.HomeZ) < 0.01 {
			arrived++
		}
	}
	t.Logf("%d walkers, %d arrived home, %d of %d samples inside another building", walkers, arrived, through, samples)
	if arrived != walkers {
		t.Fatalf("%d of %d npcs did not get home within 10 minutes", walkers-arrived, walkers)
	}
	if float64(through) > 0.02*float64(samples) {
		t.Fatalf("%d of %d walk samples inside other buildings", through, samples)
	}
}

func TestBountiesDeterministicAndEncoded(t *testing.T) {
	tw := officialTowns(t)
	sites := []Site{{Index: 5, Category: 2, Kind: towns.StructBanditCamp, X: tw.Settlements[0].X + 400, Z: tw.Settlements[0].Z - 300, Name: "Grimhollow"}}
	w := New(tw, 20261108, sites)
	a := w.Bounties(0, 1234)
	b := w.Bounties(0, 1234)
	if len(a) < 3 || len(a) > 4 {
		t.Fatalf("%d bounties", len(a))
	}
	for k := range a {
		if a[k] != b[k] || a[k].Text == "" || a[k].Reward == 0 {
			t.Fatalf("bounty %d: %+v vs %+v", k, a[k], b[k])
		}
	}
	data := EncodeBounties(a, func(id uint32) bool { return id == a[0].ID })
	if data[0] != 1 || int(data[1]) != len(a) {
		t.Fatalf("header %v", data[:2])
	}
	// Walk the records back.
	o := 2
	for k := range a {
		id := binary.LittleEndian.Uint32(data[o:])
		acc := data[o+13]
		l := int(binary.LittleEndian.Uint16(data[o+14:]))
		if id != a[k].ID || (acc == 1) != (k == 0) || string(data[o+16:o+16+l]) != a[k].Text {
			t.Fatalf("record %d mismatch", k)
		}
		o += 16 + l
	}
	if o != len(data) {
		t.Fatalf("trailing bytes")
	}
	shop := EncodeShop(wares[0])
	if shop[1] != byte(len(wares[0])) {
		t.Fatal("shop count")
	}
	if compass(0, -10) != "north" || compass(10, 0) != "east" {
		t.Fatal("compass")
	}
}
