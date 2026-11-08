package zoneregistry

import (
	"testing"
	"time"
)

func TestPick(t *testing.T) {
	es := []Entry{
		{ZoneID: "a", Regions: []Region{{0, 0}}, Players: 5},
		{ZoneID: "b", Players: 9}, // whole world
		{ZoneID: "c", Regions: []Region{{0, 0}, {1, 0}}, Players: 2},
	}
	if e, ok := Pick(es, Region{0, 0}); !ok || e.ZoneID != "c" {
		t.Fatal("want c", e)
	}
	if e, ok := Pick(es, Region{3, 3}); !ok || e.ZoneID != "b" {
		t.Fatal("want b", e)
	}
	if _, ok := Pick(es[:1], Region{2, 2}); ok {
		t.Fatal("want none")
	}
}

func TestOwner(t *testing.T) {
	es := []Entry{
		{ZoneID: "p", Role: RolePrimary},
		{ZoneID: "b", Role: RolePool, Regions: []Region{{0, 0}, {1, 0}}},
		{ZoneID: "a", Role: RolePool, Regions: []Region{{1, 0}}}, // overlap: lowest id wins
		{ZoneID: "e", Role: RolePool},                            // nothing assigned yet: owns nothing
	}
	for _, c := range []struct {
		r    Region
		want string
	}{{Region{0, 0}, "b"}, {Region{1, 0}, "a"}, {Region{3, 3}, "p"}} {
		if e, ok := Owner(es, c.r); !ok || e.ZoneID != c.want {
			t.Fatalf("owner(%v) = %q, want %q", c.r, e.ZoneID, c.want)
		}
	}
	// Without the primary, unclaimed regions have no owner; a pool zone with
	// no regions never becomes a fallback.
	if e, ok := Owner(es[1:], Region{3, 3}); ok {
		t.Fatal("want none, got", e.ZoneID)
	}
	// Legacy whole-world zones (no role, no regions) still fall back, lowest id first.
	if e, _ := Owner([]Entry{{ZoneID: "z2"}, {ZoneID: "z1"}}, Region{2, 2}); e.ZoneID != "z1" {
		t.Fatal("want z1, got", e.ZoneID)
	}
}

func TestLiveTTL(t *testing.T) {
	now := time.UnixMilli(100_000)
	if !(Entry{HeartbeatMs: 90_000}).LiveAt(now) {
		t.Fatal("default 15 s staleness")
	}
	if (Entry{HeartbeatMs: 96_000, TTLMs: 3000}).LiveAt(now) {
		t.Fatal("own ttl of 3 s")
	}
}

func TestRegionAt(t *testing.T) {
	if r := RegionAt(1023.9, 1024); r != (Region{0, 1}) {
		t.Fatal(r)
	}
	if r := RegionAt(-5, 9999); r != (Region{0, 3}) {
		t.Fatal(r)
	}
}

func TestPlan(t *testing.T) {
	live := []Entry{{ZoneID: "p", Role: RolePrimary}, {ZoneID: "b", Role: RolePool}, {ZoneID: "c", Role: RolePool}}
	a := Plan(live, nil)
	// b: ceil(16/3) = 6 regions, c: ceil(10/2) = 5, primary keeps 5.
	if len(a["b"]) != 6 || len(a["c"]) != 5 {
		t.Fatalf("plan %v", a)
	}
	if a["b"][0] != (Region{0, 0}) || a["c"][0] != (Region{1, 2}) {
		t.Fatalf("x-major stripes expected: %v", a)
	}
	// Sticky: replanning changes nothing.
	b := Plan(live, a)
	if len(b["b"]) != 6 || b["c"][0] != a["c"][0] {
		t.Fatalf("not sticky: %v", b)
	}
	// c dies: its regions go back to the primary (dropped from the map).
	d := Plan(live[:2], b)
	if _, ok := d["c"]; ok || len(d["b"]) != 6 {
		t.Fatalf("dead zone kept regions: %v", d)
	}
	// No primary: unchanged.
	if e := Plan(live[1:2], b); len(e["c"]) != 5 {
		t.Fatalf("changed without a primary: %v", e)
	}
	// Two pool zones, both empty: halves of the remaining shares.
	f := Plan([]Entry{{ZoneID: "p", Role: RolePrimary}, {ZoneID: "x", Role: RolePool}, {ZoneID: "y", Role: RolePool}, {ZoneID: "pin", Regions: []Region{{0, 0}}}}, nil)
	for _, rs := range f {
		for _, r := range rs {
			if r == (Region{0, 0}) {
				t.Fatal("assigned a pinned region")
			}
		}
	}
}
