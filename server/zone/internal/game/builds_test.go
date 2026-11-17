package game

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"testing"
	"time"

	"lodestone/server/pkg/campdefs"
	"lodestone/server/pkg/camps"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/proto"
)

func bkind(key string) int { return campdefs.D.ByKey(key).ID }

// bplace is the Interact 90/1 target of a building piece at cell/edge
// coordinates in metres (x, z), height cm (0: the zone picks a foundation's).
func bplace(key string, rot int, x, z float64, ycm int32) (uint64, uint32) {
	t := placeID(bkind(key), rot, x, z)
	if ycm == 0 {
		return t, 0
	}
	return t, uint32(int64(ycm) + 1048576)
}

func recY(e *proto.Event) int32 { return int32(binary.LittleEndian.Uint32(e.Data[14:])) }

func recState(e *proto.Event) (state, cond byte) {
	// Version 2 tail: the last two bytes.
	return e.Data[len(e.Data)-2], e.Data[len(e.Data)-1]
}

// lastBuildInfo drains the 1820s and returns the newest.
func (cl *client) lastBuildInfo(t *testing.T) buildInfoJSON {
	t.Helper()
	cl.pump(400 * time.Millisecond)
	var last *proto.Event
	rest := cl.evs[:0]
	for _, e := range cl.evs {
		if e.Kind == EventBuildInfo {
			last = e
			continue
		}
		rest = append(rest, e)
	}
	cl.evs = rest
	if last == nil {
		t.Fatal("no build info")
	}
	var bi buildInfoJSON
	if err := json.Unmarshal(last.Data, &bi); err != nil {
		t.Fatal(err)
	}
	return bi
}

func (cl *client) buildPlaced(t *testing.T, key string, rot int, x, z float64, ycm int32) (uint64, int32) {
	t.Helper()
	tid, arg := bplace(key, rot, x, z, ycm)
	cl.pump(150 * time.Millisecond) // the Interact bucket refills 10 a second
	cl.interact(InteractCamp, tid, CampActPlace, arg)
	id, ev := cl.placed(t)
	if ev.Data[8] != byte(bkind(key)) {
		t.Fatalf("%s: placed kind %d", key, ev.Data[8])
	}
	return id, recY(ev)
}

func TestBuildHouseBedHearthAndPermissions(t *testing.T) {
	r := campHarness(t, nil, 12)
	x, z := r.openSpot(t)
	const A, B = "c0000000-0000-0000-0000-0000000000a1", "c0000000-0000-0000-0000-0000000000b1"
	gx, gz := math.Floor(x/2)*2+1, math.Floor(z/2)*2+1 // a cell centre (odd metres)
	a := r.join(t, A, "Mason", gx-3, gz)
	a.interact(InteractCamp, 0, CampActDev, 0)
	if inv := a.inventory(t); findItem(inv, "wood:log") == nil || findItem(inv, "stone:block") == nil {
		t.Fatalf("dev grant has no logs or stone: %+v", inv.Items)
	}
	logs := func() int {
		if it := findItem(a.inventory(t), "wood:log"); it != nil {
			return it.Qty
		}
		return 0
	}

	// A foundation (the zone picks its height), then the shared-height one beside it.
	l0 := logs()
	found, fy := a.buildPlaced(t, "foundation_wood", 0, gx, gz, 0)
	if got := logs(); got != l0-6 {
		t.Fatalf("foundation cost: logs %d -> %d, want -6", l0, got)
	}
	found2, fy2 := a.buildPlaced(t, "foundation_wood", 0, gx+2, gz, fy)
	if fy2 != fy {
		t.Fatalf("neighbour foundation y %d, want flush %d", fy2, fy)
	}
	row := r.store.waitFor(t, found, true)
	if row.Kind != bkind("foundation_wood") || row.Cond != 100 || row.YCm != fy {
		t.Fatalf("stored foundation %+v", row)
	}
	// Off the grid, not held up, overlapping: refused with the reason.
	tid, arg := bplace("wall_wood", 0, gx+0.5, gz-1, fy)
	a.interact(InteractCamp, tid, CampActPlace, arg)
	a.refused(t, camps.RefuseGrid)
	tid, arg = bplace("wall_wood", 0, gx+8, gz-1, fy)
	a.interact(InteractCamp, tid, CampActPlace, arg)
	a.refused(t, camps.RefuseTooFar)
	tid, arg = bplace("floor_wood", 0, gx, gz, fy+250)
	a.interact(InteractCamp, tid, CampActPlace, arg)
	a.refused(t, camps.RefuseSupport)

	// Walls on the north edge, the door on the south, a floor on top of the north wall's level.
	wall, _ := a.buildPlaced(t, "wall_wood", 0, gx, gz-1, fy)
	door, _ := a.buildPlaced(t, "door_wood", 4, gx, gz+1, fy)
	floor, _ := a.buildPlaced(t, "floor_wood", 0, gx, gz-2, fy+250)
	_ = floor

	// A closed door blocks, an open one does not; the state is stored and sent.
	solidClosed := false
	r.do(func() {
		p := r.srv.camp.pieces[door]
		solidClosed = r.srv.camp.set.Blocked(p.X, p.Y, p.Z+0.01, 0.3, 1.8)
	})
	if !solidClosed {
		t.Fatal("a closed door does not block")
	}
	a.interact(InteractCamp, door, CampActUse, 0)
	ev := a.take(EventCampPiece, 3*time.Second)
	if st, _ := recState(ev); ev.Value != 2 || st != 1 {
		t.Fatalf("door change event: value %d state %d", ev.Value, st)
	}
	time.Sleep(100 * time.Millisecond) // the coalesced rebuild
	r.do(func() {
		p := r.srv.camp.pieces[door]
		r.srv.campRebuild()
		if r.srv.camp.set.Blocked(p.X, p.Y, p.Z+0.01, 0.3, 1.8) {
			t.Error("an open door still blocks")
		}
	})
	if row := r.store.waitFor(t, door, true); row.State != 1 {
		// The write is queued: give it a moment.
		time.Sleep(200 * time.Millisecond)
		if row = r.store.waitFor(t, door, true); row.State != 1 {
			t.Fatalf("door state not stored: %+v", row)
		}
	}

	// The floor rests on the wall: the wall cannot be deconstructed.
	a.interact(InteractCamp, wall, CampActPickup, 0)
	a.refused(t, camps.RefuseHolds)

	// Furnishings: a bed, then a table, a bench and a lantern on the second foundation (comfort 3 + 2 + 2).
	bed, _ := a.buildPlaced(t, "bed", 0, gx+0.5, gz, fy)
	a.buildPlaced(t, "table", 0, gx+2.5, gz, fy)
	a.buildPlaced(t, "bench", 0, gx+2.5, gz+1, fy)
	a.buildPlaced(t, "lantern", 0, gx+2.5, gz-1, fy)
	a.interact(InteractCamp, bed, CampActUse, 0)
	rested := a.take(EventCampRested, 3*time.Second)
	var rj struct {
		Comfort int    `json:"comfort"`
		Tier    string `json:"tier"`
	}
	if err := json.Unmarshal(rested.Data, &rj); err != nil || rj.Comfort != 7 || rj.Tier != "Cosy" {
		t.Fatalf("rested %s (%v), want comfort 7 Cosy", rested.Data, err)
	}
	wantDur := (campdefs.D.Rested.DurationS * (1 + 7*campdefs.D.Build.Comfort.DurationPct/100))
	if got := float64(rested.Value); math.Abs(got-wantDur) > 2 {
		t.Fatalf("rested for %vs, want about %vs", got, wantDur)
	}
	// The bed is the respawn point.
	r.do(func() {
		sp := r.srv.RespawnPoint(r.srv.byChar[A].ent)
		p := r.srv.camp.pieces[bed]
		if math.Hypot(sp.X-p.X, sp.Z-p.Z) > 0.01 || math.Abs(sp.Y-p.Y) > 0.01 {
			t.Errorf("respawn %v, bed at %v %v %v", sp, p.X, p.Y, p.Z)
		}
	})
	// Event 1820 knows the base.
	a.interact(InteractCamp, 0, CampActSync, 0)
	if bi := a.lastBuildInfo(t); bi.Pieces != 9 || bi.Comfort.Score != 7 || bi.Home == nil {
		t.Fatalf("build info %+v", bi)
	}

	// Another player: the budget of spots near A's pieces, no door, no deconstruct, no repair.
	b := r.join(t, B, "Brick", gx-3, gz+5)
	addItems(t, r.harness, B, "wood:log", 40)
	tid, arg = bplace("foundation_wood", 0, gx-4, gz, 0)
	b.interact(InteractCamp, tid, CampActPlace, arg)
	b.refused(t, camps.RefuseOtherCamp)
	b.interact(InteractCamp, door, CampActUse, 0)
	b.refused(t, camps.RefuseLocked)
	b.interact(InteractCamp, wall, CampActPickup, 0)
	b.refused(t, camps.RefuseNotYours)
	b.interact(InteractCamp, wall, CampActRepair, 0)
	b.refused(t, camps.RefuseNotYours)
	// Shared with the party: B may open the door.
	r.do(func() {
		r.srv.setParty(r.srv.byChar[A].ent, "party-9")
		r.srv.setParty(r.srv.byChar[B].ent, "party-9")
	})
	a.interact(InteractCamp, 0, CampActShare, 1)
	a.take(EventBuildInfo, 3*time.Second)
	b.interact(InteractCamp, door, CampActUse, 0)
	if ev := b.takeFor(EventCampPiece, 0, 3*time.Second); ev == nil {
		t.Fatal("B could not close the shared door")
	}
	a.interact(InteractCamp, 0, CampActShare, 0)

	// Repair: a worn piece is restored for materials; a fresh one is left alone.
	var cost []campdefs.Cost
	r.do(func() {
		p := r.srv.camp.pieces[wall]
		p.Cond, p.CondDay = 40, r.srv.worldDay()
		cost = r.srv.buildRepairCost(p)
	})
	if len(cost) != 1 || cost[0].Qty < 1 {
		t.Fatalf("repair cost %+v", cost)
	}
	l1 := logs()
	a.interact(InteractCamp, wall, CampActRepair, 0)
	ev = a.take(EventCampPiece, 3*time.Second)
	if _, cond := recState(ev); cond != 100 {
		t.Fatalf("repaired condition %d", cond)
	}
	if got := logs(); got != l1-cost[0].Qty {
		t.Fatalf("repair spent %d logs, want %d", l1-got, cost[0].Qty)
	}

	// Deconstruct refunds 80 %: the bench (3 logs -> 2).
	var bench uint64
	r.do(func() {
		for id, p := range r.srv.camp.pieces {
			if p.Kind == bkind("bench") {
				bench = id
			}
		}
	})
	l2 := logs()
	a.interact(InteractCamp, bench, CampActPickup, 0)
	gone := a.take(EventCampRemoved, 3*time.Second)
	if binary.LittleEndian.Uint64(gone.Data) != bench {
		t.Fatalf("removed %+v", gone)
	}
	r.store.waitFor(t, bench, false)
	if got := logs(); got != l2+2 {
		t.Fatalf("refund: logs %d -> %d, want +2", l2, got)
	}

	// The warding hearth is a permanent fire with its own radius for the night hooks.
	_, fy3 := a.buildPlaced(t, "foundation_wood", 0, gx-2, gz, 0)
	hearth, _ := a.buildPlaced(t, "hearth", 0, gx-2, gz, fy3)
	_ = hearth
	_ = found2
	r.do(func() {
		s := r.srv
		if !s.campSafeAt(gx+15, gz, 0) || s.campSafeAt(gx+30, gz, 0) {
			t.Errorf("hearth ward: inside %v outside %v", s.campSafeAt(gx+15, gz, 0), s.campSafeAt(gx+30, gz, 0))
		}
	})
}

func TestBuildCondWearsAndMends(t *testing.T) {
	r := campHarness(t, nil, 12)
	r.do(func() {
		s := r.srv
		s.campInit()
		p := &campPiece{ID: 5, Kind: bkind("wall_wood"), Cond: 100, CondDay: s.worldDay() - 10}
		// Wood wears 1 percent a day: 10 days -> 90.
		if c := s.buildCond(p); math.Abs(c-90) > 0.5 {
			t.Fatalf("wood after 10 days: %v", c)
		}
		p.Kind = bkind("wall_sunsteel")
		if c := s.buildCond(p); c < 98.9 {
			t.Fatalf("sunsteel after 10 days: %v", c)
		}
		// Never below the floor.
		p.Kind, p.Cond, p.CondDay = bkind("wall_wood"), 100, s.worldDay()-1000
		if c := s.buildCond(p); c != campdefs.D.Build.WeatherFloor {
			t.Fatalf("wood after 1000 days: %v, want the floor", c)
		}
		// Inside a hearth's ward it mends instead.
		s.camp.fires = []fireSpot{{x: 0, z: 0, until: math.Inf(1), r: 20}}
		p.Cond, p.CondDay = 40, s.worldDay()-5
		if c := s.buildCond(p); math.Abs(c-(40+5*campdefs.D.Build.MendPerDay)) > 0.5 {
			t.Fatalf("mended: %v", c)
		}
		_ = constants.DayLengthS
	})
}

func TestBuildBudgetAndPersistence(t *testing.T) {
	store := &memCampStore{rows: map[uint64]CampRow{}}
	r := campHarness(t, store, 12)
	x, z := r.openSpot(t)
	const A = "c0000000-0000-0000-0000-0000000000a2"
	gx, gz := math.Floor(x/2)*2+1, math.Floor(z/2)*2+1
	a := r.join(t, A, "Cap", gx-3, gz)
	a.interact(InteractCamp, 0, CampActDev, 0)
	a.inventory(t)
	old := campdefs.D.Build.Budget
	campdefs.D.Build.Budget = 2
	defer func() { campdefs.D.Build.Budget = old }()
	f1, fy := a.buildPlaced(t, "foundation_stone", 0, gx, gz, 0)
	a.buildPlaced(t, "foundation_stone", 0, gx+2, gz, fy)
	tid, arg := bplace("foundation_stone", 0, gx, gz+2, fy)
	a.interact(InteractCamp, tid, CampActPlace, arg)
	a.refused(t, camps.RefuseBudget)
	// No materials: refused with the list of what is missing.
	campdefs.D.Build.Budget = old
	const C = "c0000000-0000-0000-0000-0000000000c2"
	c := r.join(t, C, "Poor", gx-3, gz+10)
	tid, arg = bplace("foundation_wood", 0, gx-3, gz+9, 0)
	c.interact(InteractCamp, tid, CampActPlace, arg)
	var miss []map[string]any
	if err := json.Unmarshal(c.take(EventBuildMissing, 3*time.Second).Data, &miss); err != nil || len(miss) != 1 || miss[0]["item"] != "wood:log" || miss[0]["qty"].(float64) != 6 {
		t.Fatalf("missing %+v (%v)", miss, err)
	}
	c.refused(t, camps.RefuseMaterials)
	time.Sleep(200 * time.Millisecond)
	store.waitFor(t, f1, true)
	// A restart restores the stone foundation and its height.
	r2 := campHarness(t, store, 12)
	r2.do(func() {
		p := r2.srv.camp.pieces[f1]
		if p == nil || p.Kind != bkind("foundation_stone") || p.YCm != fy || p.Cond != 100 {
			t.Fatalf("restored %+v", p)
		}
		if r2.srv.camp.set.Len() != 0 || !r2.srv.camp.set.HasSurfaces() {
			t.Fatalf("restored set: %d boxes surfaces %v", r2.srv.camp.set.Len(), r2.srv.camp.set.HasSurfaces())
		}
		if r2.srv.camp.nBuild[A] != 2 {
			t.Fatalf("budget counter after restore: %d", r2.srv.camp.nBuild[A])
		}
	})
}
