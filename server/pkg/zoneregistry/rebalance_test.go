package zoneregistry

import (
	"slices"
	"testing"
)

// loads builds a Load report from "x,z -> players" entries.
func loads(m map[Region]int) []RegionLoad {
	var out []RegionLoad
	for r, n := range m {
		out = append(out, RegionLoad{X: r.X, Z: r.Z, Players: n})
	}
	return out
}

func zoneLoads(live []Entry, plan map[string][]Region) map[string]int {
	out := map[string]int{}
	owner := map[Region]string{}
	for z, rs := range plan {
		for _, r := range rs {
			owner[r] = z
		}
	}
	for _, e := range live {
		for _, l := range e.Load {
			o := owner[Region{X: l.X, Z: l.Z}]
			if o == "" {
				o = "a-primary"
			}
			out[o] += l.Players
		}
	}
	return out
}

// The WP19 thailand failover shape: a pool zone died, its regions went to
// the primary, which now holds far more than its share. Repeated calls
// (the director's loop) move regions until no move is worth it; the loads
// even out and every region still has exactly one owner.
func TestRebalanceAfterFailover(t *testing.T) {
	// Primary owns rows z=0..1 plus the dead zone's z=3; pools b and c own
	// z=2 split in two halves... simpler: b owns (0..1,2), c owns (2..3,2).
	plan := map[string][]Region{
		"b-pool": {{0, 2}, {1, 2}},
		"c-pool": {{2, 2}, {3, 2}},
	}
	regionLoad := map[Region]int{}
	for x := 0; x < 4; x++ {
		regionLoad[Region{x, 0}] = 50
		regionLoad[Region{x, 1}] = 50
		regionLoad[Region{x, 2}] = 60
		regionLoad[Region{x, 3}] = 55 // the dead zone's crowd, now on the primary
	}
	live := []Entry{
		{ZoneID: "a-primary", Role: RolePrimary},
		{ZoneID: "b-pool", Role: RolePool},
		{ZoneID: "c-pool", Role: RolePool},
	}
	// Each zone reports the regions it owns (any split works: they are summed).
	live[0].Load = loads(regionLoad)
	before := zoneLoads(live, plan)
	if before["a-primary"] != 620 {
		t.Fatalf("setup: primary load %d", before["a-primary"])
	}
	moves := 0
	for i := 0; i < 20; i++ {
		next, m := Rebalance(live, plan, DefaultRebalance)
		if m == nil {
			break
		}
		moves++
		plan = next
	}
	after := zoneLoads(live, plan)
	hi := max(after["a-primary"], after["b-pool"], after["c-pool"])
	if moves == 0 || hi > 400 {
		t.Fatalf("after %d moves: loads %v (before %v)", moves, after, before)
	}
	seen := map[Region]bool{}
	for _, rs := range plan {
		for _, r := range rs {
			if seen[r] {
				t.Fatalf("region %v assigned twice: %v", r, plan)
			}
			seen[r] = true
		}
	}
	t.Logf("%d moves: %v -> %v", moves, before, after)
}

// Balanced worlds, quiet zones and worlds without pool zones never move.
func TestRebalanceLeavesBalancedAlone(t *testing.T) {
	plan := map[string][]Region{"b-pool": {{2, 0}, {3, 0}, {2, 1}, {3, 1}, {2, 2}, {3, 2}, {2, 3}, {3, 3}}}
	even := map[Region]int{}
	for x := 0; x < 4; x++ {
		for z := 0; z < 4; z++ {
			even[Region{x, z}] = 30
		}
	}
	live := []Entry{{ZoneID: "a-primary", Role: RolePrimary, Load: loads(even)}, {ZoneID: "b-pool", Role: RolePool}}
	if _, m := Rebalance(live, plan, DefaultRebalance); m != nil {
		t.Fatalf("balanced world moved %v", m)
	}
	// Uneven but under the floor: no move.
	quiet := map[Region]int{{0, 0}: 150}
	live[0].Load = loads(quiet)
	if _, m := Rebalance(live, plan, DefaultRebalance); m != nil {
		t.Fatalf("quiet world moved %v", m)
	}
	// One crowded region can't be split: no move either.
	crowd := map[Region]int{{0, 0}: 900}
	live[0].Load = loads(crowd)
	next, m := Rebalance(live, plan, DefaultRebalance)
	if m != nil {
		t.Fatalf("moving the only crowded region just moves the crowd: %v", m)
	}
	if !slices.Equal(next["b-pool"], plan["b-pool"]) {
		t.Fatal("plan changed without a move")
	}
	// No pool zone: nothing to balance with.
	if _, m := Rebalance([]Entry{{ZoneID: "a-primary", Role: RolePrimary, Load: loads(map[Region]int{{0, 0}: 400, {1, 0}: 400})}}, nil, DefaultRebalance); m != nil {
		t.Fatalf("no pool zone, moved %v", m)
	}
}

// A pool zone that comes back (empty, Plan gave it a stripe by region
// count) is evened out by load: the crowd's regions move to it.
func TestRebalancePoolComesBack(t *testing.T) {
	live := []Entry{{ZoneID: "a-primary", Role: RolePrimary}, {ZoneID: "b-pool", Role: RolePool}}
	crowd := map[Region]int{{3, 3}: 200, {3, 2}: 200, {0, 0}: 20}
	live[0].Load = loads(crowd)
	plan := Plan(live, nil) // b gets ceil(16/2) = 8 regions in x-major order: x = 0..1
	_, m := Rebalance(live, plan, DefaultRebalance)
	if m == nil || m.To != "b-pool" || m.From != "a-primary" || m.Players != 200 {
		t.Fatalf("want one 200-player region moved to the returning pool zone, got %v", m)
	}
}
