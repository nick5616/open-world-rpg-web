package zoneregistry

import "testing"

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
