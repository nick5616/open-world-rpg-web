package explore

import (
	"encoding/hex"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/structures"
)

var update = flag.Bool("update", false, "rewrite testdata/events_vectors.json")

// testWorld: flat ground at y=10, one region-0 tower at (100, 100), a
// waypoint at (300, 100) facing +x, a hamlet at (500, 500), a ruin, a cave
// mouth and an enemy camp.
func testWorld(t *testing.T) *World {
	t.Helper()
	a := &structures.Atlas{WorldSize: 4096, RegionsPerEdge: 4, Sites: []structures.Site{
		{Index: 0, ID: 1000, Category: structures.CategoryPOI, Kind: structures.POITower, Region: 0, X: 100, Y: 10, Z: 100, Name: "Tower of Tests"},
		{Index: 1, ID: 1001, Category: structures.CategoryPOI, Kind: structures.POIWaypoint, Region: 0, X: 300, Y: 10, Z: 100, Yaw: 0, Name: "Stone"},
		{Index: 2, ID: 1002, Category: structures.CategorySettlement, Region: 0, Size: 1, X: 500, Y: 10, Z: 500, Radius: 80, Name: "Testby"},
		{Index: 3, ID: 1003, Category: structures.CategoryStructure, Kind: 0, Size: 2, Region: 0, X: 700, Y: 10, Z: 100, Radius: 12},
		{Index: 4, ID: 1004, Category: structures.CategoryPOI, Kind: structures.POICaveMouth, Region: 0, X: 900, Y: 10, Z: 100},
		{Index: 5, ID: 1005, Category: structures.CategoryPOI, Kind: structures.POIEnemyCamp, Region: 0, X: 900, Y: 10, Z: 300},
		{Index: 6, ID: 1006, Category: structures.CategoryPOI, Kind: structures.POITower, Region: 5, X: 1500, Y: 10, Z: 1500},
	}}
	a.Regions = []structures.Region{{Index: 0, Name: "Testshire", Tower: 0}}
	base := movement.Flat{Y: 10}
	o, sites := structures.Towers(a, base)
	return NewWorld(a, structures.Wrap(base, o), sites)
}

func at(w *World, x, z float64) movement.Vec3 {
	return movement.Vec3{X: x, Y: w.Ground.HeightAt(x, z), Z: z}
}

func TestDiscoveryOncePerCharacter(t *testing.T) {
	w := testWorld(t)
	p := NewProgress()
	h := w.Check(p, at(w, 500+70, 500), nil) // inside the village footprint (80 m)
	if len(h) != 1 || h[0].Kind != Discovered || h[0].Site != 2 || h[0].XP != 80 {
		t.Fatalf("village discovery: %+v", h)
	}
	if p.XP != 80 || !p.Dirty() || p.Level != 1 {
		t.Fatalf("xp %d level %d dirty %v", p.XP, p.Level, p.Dirty())
	}
	if h := w.Check(p, at(w, 500, 500), nil); len(h) != 0 {
		t.Fatalf("second visit must grant nothing: %+v", h)
	}
	// Structure: max(radius 12, 15) + 10 = 25 m; tier 2 = 100 XP -> level 2 (100 to level 2).
	if h := w.Check(p, at(w, 700+26, 100), nil); len(h) != 0 {
		t.Fatalf("outside 25 m: %+v", h)
	}
	if h := w.Check(p, at(w, 700+24, 100), nil); len(h) != 1 || h[0].XP != 100 || p.Level != 2 {
		t.Fatalf("ruin discovery: %+v level %d", h, p.Level)
	}
	// Cave mouth 20 m; enemy camps are not discoveries.
	if h := w.Check(p, at(w, 900, 100+19), nil); len(h) != 1 || h[0].Site != 4 {
		t.Fatalf("cave: %+v", h)
	}
	if h := w.Check(p, at(w, 900, 300), nil); len(h) != 0 {
		t.Fatalf("camp must not be a discovery: %+v", h)
	}
	// A different character discovers the same place again.
	if h := w.Check(NewProgress(), at(w, 500, 500), nil); len(h) != 1 {
		t.Fatal("discovery is per character")
	}
}

func TestWaypointTouchAndRespawn(t *testing.T) {
	w := testWorld(t)
	p := NewProgress()
	if _, ok := w.RespawnPoint(p); ok {
		t.Fatal("no waypoint touched yet")
	}
	if h := w.Check(p, at(w, 300+3.2, 100), nil); len(h) != 0 {
		t.Fatalf("3.2 m is not a touch: %+v", h)
	}
	h := w.Check(p, at(w, 300+2.5, 100), nil)
	if len(h) != 2 || h[0].Kind != WaypointActivated || h[1].Kind != RespawnPointSet || p.LastWaypoint != 1 || !p.Waypoints.Has(1) {
		t.Fatalf("touch: %+v last %d", h, p.LastWaypoint)
	}
	if h := w.Check(p, at(w, 300, 100), nil); len(h) != 0 {
		t.Fatalf("touching again: %+v", h)
	}
	// Flying over the stone 10 m up is not a touch.
	q := NewProgress()
	if h := w.Check(q, movement.Vec3{X: 300, Y: 20, Z: 100}, nil); len(h) != 0 {
		t.Fatalf("10 m above: %+v", h)
	}
	r, ok := w.RespawnPoint(p)
	if !ok || r.X != 300+ArrivalOffsetM || r.Z != 100 || r.Y != 10 {
		t.Fatalf("respawn beside the stone, on the side it faces: %+v", r)
	}
}

func TestTowerTopRevealsRegion(t *testing.T) {
	w := testWorld(t)
	p := NewProgress()
	tw := w.Towers[0].Shape
	// At the foot (discovery radius 40) but not on top.
	h := w.Check(p, at(w, 100+30, 100), nil)
	if len(h) != 1 || h[0].Kind != Discovered || h[0].XP != 40 || p.Towers.Has(0) {
		t.Fatalf("foot of the tower: %+v", h)
	}
	// On the ledge: not the top.
	r, _ := structures.TowerProfile()
	if h := w.Check(p, at(w, 100+r[1]+0.5, 100), nil); len(h) != 0 || w.RevealedRegions(p) != 0 {
		t.Fatalf("ledge: %+v", h)
	}
	// On the top platform: unlocked, region 0 revealed.
	pos := at(w, 100+2, 100)
	if pos.Y != tw.TopY {
		t.Fatalf("ground at the top is the platform: %v vs %v", pos.Y, tw.TopY)
	}
	h = w.Check(p, pos, nil)
	if len(h) != 1 || h[0].Kind != TowerUnlocked || h[0].Region != 0 || h[0].XP != TowerClimbXP || !p.Towers.Has(0) {
		t.Fatalf("top: %+v", h)
	}
	if w.RevealedRegions(p) != 1 {
		t.Fatalf("revealed %b", w.RevealedRegions(p))
	}
	// A player hovering above the top (glide) is not standing on it... but
	// a hop on the platform is: TowerTopSlackM below, any height above.
	q := NewProgress()
	if h := w.Check(q, movement.Vec3{X: 100, Y: tw.TopY - 1, Z: 100}, nil); len(h) != 1 || h[0].Kind != Discovered {
		t.Fatalf("1 m under the platform surface (impossible on the server, but): %+v", h)
	}
}

func TestFastTravelValidation(t *testing.T) {
	w := testWorld(t)
	p := NewProgress()
	if e := w.CanTravel(p, 0); e != TravelLocked {
		t.Fatalf("locked tower: %v", e)
	}
	if e := w.CanTravel(p, 2); e != TravelUnknown {
		t.Fatalf("a village is not a fast travel point: %v", e)
	}
	if e := w.CanTravel(p, 99); e != TravelUnknown {
		t.Fatalf("bad index: %v", e)
	}
	w.Check(p, at(w, 100, 100), nil)
	w.Check(p, at(w, 300, 100), nil)
	if w.CanTravel(p, 0) != TravelOK || w.CanTravel(p, 1) != TravelOK {
		t.Fatal("unlocked points travel")
	}
	d, ok := w.Destination(0)
	if !ok || d.X != 100 || d.Z != 100 || d.Y != w.Towers[0].Shape.TopY {
		t.Fatalf("tower destination is its top: %+v", d)
	}
}

func TestLevelCurve(t *testing.T) {
	for _, c := range []struct {
		xp    int64
		level int
	}{{0, 1}, {99, 1}, {100, 2}, {239, 2}, {240, 3}, {420, 4}} {
		if got := LevelForXP(c.xp); got != c.level {
			t.Errorf("LevelForXP(%d) = %d, want %d", c.xp, got, c.level)
		}
	}
	p := NewProgress()
	if !p.AddXP(100) || p.Level != 2 || p.AddXP(0) {
		t.Fatal("level up")
	}
}

func TestPinsPersonal(t *testing.T) {
	p := NewProgress()
	for i := 0; i < MaxPersonalPins; i++ {
		if !p.SetPin(uint8(i), 1, int32(i*100), 5) {
			t.Fatal(i)
		}
	}
	if p.SetPin(MaxPersonalPins, 0, 0, 0) {
		t.Fatal("an 11th pin is refused")
	}
	p.SetPin(3, 2, 7, 7) // move
	if len(p.Pins) != MaxPersonalPins || p.Pins[3] != (Pin{3, 2, 7, 7}) {
		t.Fatalf("%+v", p.Pins)
	}
	q := NewProgress()
	q.LoadPinsJSON(p.PinsJSON())
	if !reflect.DeepEqual(p.Pins, q.Pins) {
		t.Fatal("pins JSON roundtrip")
	}
	q.LoadPinsJSON([]byte(`[{"slot":12,"x":1,"z":1},{"slot":1},{"slot":1,"x":9}] `))
	if len(q.Pins) != 1 {
		t.Fatalf("bad slots and duplicates dropped: %+v", q.Pins)
	}
	q.LoadPinsJSON([]byte(`garbage`))
	if len(q.Pins) != 0 {
		t.Fatal("garbage = no pins")
	}
	if !p.ClearPin(3) || p.ClearPin(3) {
		t.Fatal("clear")
	}
	if _, _, ok := UnpackPinPos(PackPinPos(409600, 0), 4096); ok {
		t.Fatal("x = world size is outside")
	}
	if x, z, ok := UnpackPinPos(PackPinPos(123456, 409599), 4096); !ok || x != 123456 || z != 409599 {
		t.Fatal("pack roundtrip")
	}
}

// Event payload vectors, replayed by client/src/ui/map/events.test.ts.
type vectors struct {
	Comment  string
	Progress struct {
		Hex          string
		XP           int64
		Level        int
		LastWaypoint int
		Revealed     uint32
		Towers       []int
		Waypoints    []int
		Discoveries  []int
	}
	Pins struct {
		Hex  string
		Pins []PinView
	}
}

func TestEventPayloads(t *testing.T) {
	p := NewProgress()
	p.ensure(70)
	for _, i := range []int{0, 9, 63} {
		p.Towers.Set(i)
	}
	p.Waypoints.Set(1)
	for _, i := range []int{2, 3, 69} {
		p.Discoveries.Set(i)
	}
	p.XP, p.Level, p.LastWaypoint = 5_000_000_123, 41, 1
	b := EncodeProgress(p, 0b1001)
	q, rev, err := DecodeProgress(b)
	if err != nil || rev != 9 || q.XP != p.XP || q.Level != 41 || q.LastWaypoint != 1 || !q.Towers.Has(63) || !q.Discoveries.Has(69) || q.Towers.Count() != 3 {
		t.Fatalf("roundtrip: %+v %v", q, err)
	}
	none := NewProgress()
	if q, _, _ := DecodeProgress(EncodeProgress(none, 0)); q.LastWaypoint != -1 {
		t.Fatal("-1 = none survives")
	}
	pins := []PinView{{Slot: 0, Color: 2, XCm: 123456, ZCm: 7}, {Party: true, Slot: 1, Color: 1, XCm: 409599, ZCm: 0, Owner: "Ünïcode Bob"}}
	pb := EncodePins(pins)
	got, err := DecodePins(pb)
	if err != nil || !reflect.DeepEqual(got, pins) {
		t.Fatalf("pins roundtrip: %+v %v", got, err)
	}
	if _, err := DecodePins(pb[:len(pb)-1]); err == nil {
		t.Fatal("truncation is an error")
	}

	var v vectors
	v.Comment = "WP12 Event payloads (contracts/events.md 603 progress_sync, 605 pins); generated by go test ./internal/explore -run EventPayloads -update (server/zone)"
	v.Progress.Hex = hex.EncodeToString(b)
	v.Progress.XP, v.Progress.Level, v.Progress.LastWaypoint, v.Progress.Revealed = p.XP, p.Level, p.LastWaypoint, 9
	v.Progress.Towers, v.Progress.Waypoints, v.Progress.Discoveries = []int{0, 9, 63}, []int{1}, []int{2, 3, 69}
	v.Pins.Hex = hex.EncodeToString(pb)
	v.Pins.Pins = pins
	path := filepath.Join("testdata", "events_vectors.json")
	out, _ := json.MarshalIndent(v, "", "  ")
	if *update {
		_ = os.MkdirAll("testdata", 0o755)
		if err := os.WriteFile(path, append(out, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil || string(want) != string(out)+"\n" {
		t.Fatalf("%s out of date (run with -update): %v", path, err)
	}
}
