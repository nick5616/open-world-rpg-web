package game

import (
	"context"
	"errors"
	"math"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"lodestone/server/pkg/accountapi"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/worldhost"
)

var terrainOnce struct {
	sync.Once
	w   *worldhost.World
	err error
}

// testTerrain opens WP04's default official world (seed 20261108) with the
// built worldgen.wasm; skipped without it unless LODESTONE_REQUIRE_WASM=1.
func testTerrain(t *testing.T) *worldhost.Terrain {
	t.Helper()
	terrainOnce.Do(func() {
		mod, err := worldhost.LoadFromEnv(context.Background())
		if err != nil {
			terrainOnce.err = err
			return
		}
		mt, err := mod.Mint(20261108, nil, worldhost.WorldOptions{})
		terrainOnce.w, terrainOnce.err = mt.World, err
	})
	if terrainOnce.err != nil {
		if errors.Is(terrainOnce.err, worldhost.ErrNoWasm) && os.Getenv("LODESTONE_REQUIRE_WASM") != "1" {
			t.Skipf("skipping: %v", terrainOnce.err)
		}
		t.Fatal(terrainOnce.err)
	}
	tr := worldhost.NewTerrain(terrainOnce.w, worldhost.TerrainOptions{Workers: 2})
	t.Cleanup(tr.Close)
	return tr
}

// walkOn is client.walk with prediction on a given ground.
func (cl *client) walkOn(n int, flags uint16, yaw float64, sim *movement.State, g movement.Ground) {
	var prev *proto.InputFrame
	for i := 0; i < n; i += 2 {
		var frames []proto.InputFrame
		if prev != nil {
			frames = append(frames, *prev)
		}
		for k := 0; k < 2 && i+k < n; k++ {
			cl.seq++
			f := proto.InputFrame{Seq: cl.seq, Flags: flags, Yaw: proto.YawToU16(yaw)}
			frames = append(frames, f)
			*sim = movement.StepFrame(*sim, f, g)
			prev = &frames[len(frames)-1]
		}
		cl.send(&proto.Input{AckTick: cl.dec.Latest(), Frames: frames})
		cl.drainFor(33 * time.Millisecond)
	}
}

func (cl *client) waitAck(t *testing.T) proto.SelfState {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for cl.snap == nil || cl.snap.AckInputSeq != cl.seq {
		if time.Now().After(deadline) {
			t.Fatalf("never acked seq %d", cl.seq)
		}
		cl.drainFor(20 * time.Millisecond)
	}
	return cl.frame.Self
}

// TestTerrainMovementMatchesPrediction: a client predicting with its own
// Terrain (same wasm, separate cache) and the zone agree to the centimeter
// while walking, sprinting and jumping over generated hills.
func TestTerrainMovementMatchesPrediction(t *testing.T) {
	ground := testTerrain(t)
	h := newHarness(t, func(c *Config) { c.Ground = ground })
	// A hillside near spawn: the steepest walkable-looking point on a 50 m
	// grid within 600 m, so the walk really climbs (spawn itself is a
	// pre-flattened settlement).
	wd := ground.World()
	sx, sz := float64(wd.Header.SpawnX), float64(wd.Header.SpawnZ)
	bestSlope := -1.0
	for dx := -600.0; dx <= 600; dx += 50 {
		for dz := -600.0; dz <= 600; dz += 50 {
			_, slope, err := wd.GroundNormal(sx+dx, sz+dz)
			if err == nil && slope < 35 && slope > bestSlope && wd.CollisionHeight(sx+dx, sz+dz) > float64(wd.Header.SeaLevel)+2 {
				bestSlope, sx, sz = slope, sx+dx, sz+dz
			}
		}
	}
	cl := h.dial("?spawn=" + ftoa(sx) + "," + ftoa(sz))
	w := cl.join(h, "hill", "Climber")
	local := testTerrain(t) // the "client": its own cache, cold
	// Welcome is cm-quantized; a client spawned by hint knows the exact
	// point and snaps to its own ground, as the server did.
	sim := movement.NewState(movement.Vec3{X: sx, Y: local.HeightAt(sx, sz), Z: sz})
	if w.X != proto.MetersToCm(sx) || w.Y != proto.MetersToCm(sim.Pos.Y) || w.Z != proto.MetersToCm(sz) {
		t.Fatalf("spawn not on the ground: welcome %+v, ground %v", w.ToJSON(), sim.Pos.Y)
	}
	startY := sim.Pos.Y
	cl.walkOn(120, proto.InputFlagForward|proto.InputFlagSprint, 0.7, &sim, local)
	cl.walkOn(40, proto.InputFlagForward|proto.InputFlagJump, 2.0, &sim, local)
	cl.walkOn(60, proto.InputFlagForward|proto.InputFlagRight, -1.2, &sim, local)
	self := cl.waitAck(t)
	for _, c := range []struct {
		got  int32
		want float64
	}{{self.X, sim.Pos.X}, {self.Y, sim.Pos.Y}, {self.Z, sim.Pos.Z}} {
		if c.got != proto.MetersToCm(c.want) {
			t.Fatalf("server %v cm vs predicted %v m (sim %+v, self %+v)", c.got, c.want, sim, self)
		}
	}
	if math.Abs(sim.Pos.Y-startY) < 0.05 {
		t.Fatalf("walk never changed height (%v -> %v): not exercising terrain", startY, sim.Pos.Y)
	}
	if v := h.srv.m.speedViolations.Load(); v != 0 {
		t.Fatalf("%d validation rejections on legit terrain movement", v)
	}
	// The zone asked for chunks around the player.
	if st := ground.Stats(); st.Generated == 0 || st.Hits == 0 {
		t.Fatalf("terrain cache unused: %+v", st)
	}
	t.Logf("climbed %.2f m -> %.2f m; server cache %+v", startY, sim.Pos.Y, ground.Stats())
}

func ftoa(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

// TestTerrainSpawns: new characters (no row, or WP04's creation placeholder)
// start dry near the atlas spawn; saved positions are respected and lifted
// onto the ground when below it.
func TestTerrainSpawns(t *testing.T) {
	ground := testTerrain(t)
	wp4 := accountapi.SpawnPosition()
	store := &fakeStore{saves: map[string]movement.Vec3{}, rows: map[string]movement.Vec3{
		"fresh": {X: wp4.X, Y: wp4.Y, Z: wp4.Z},
		"saved": {X: 1500.25, Y: -400, Z: 2600.75}, // far below any ground
	}}
	h := newHarness(t, func(c *Config) { c.Ground = ground; c.Store = store })
	hdr := ground.World().Header
	for _, char := range []string{"fresh", "norow"} {
		cl := h.dial("")
		w := cl.join(h, char, char)
		x, y, z := proto.CmToMeters(w.X), proto.CmToMeters(w.Y), proto.CmToMeters(w.Z)
		if d := math.Hypot(x-float64(hdr.SpawnX), z-float64(hdr.SpawnZ)); d > worldhost.SpawnRadiusM*7 {
			t.Fatalf("%s spawned %v m from the atlas spawn (%v, %v)", char, d, x, z)
		}
		if math.Abs(y-ground.HeightAt(x, z)) > 0.011 || y < float64(hdr.SeaLevel) {
			t.Fatalf("%s spawned off the ground or under the sea: y %v ground %v sea %v", char, y, ground.HeightAt(x, z), hdr.SeaLevel)
		}
	}
	cl := h.dial("")
	w := cl.join(h, "saved", "saved")
	if w.X != proto.MetersToCm(1500.25) || w.Z != proto.MetersToCm(2600.75) || w.Y != proto.MetersToCm(ground.HeightAt(1500.25, 2600.75)) {
		t.Fatalf("saved position not respected / lifted: %+v", w.ToJSON())
	}
}

func TestVerticalOK(t *testing.T) {
	g := movement.Flat{Y: 10}
	on := movement.State{Pos: movement.Vec3{Y: 10}}
	jump := constants.JumpForce * movement.Dt
	cases := []struct {
		name       string
		prev, next movement.State
		ok         bool
	}{
		{"standing", on, on, true},
		{"jump step", on, movement.State{Pos: movement.Vec3{Y: 10 + jump}}, true},
		{"rising faster than a jump", on, movement.State{Pos: movement.Vec3{Y: 10 + 3*jump}}, false},
		{"below ground", on, movement.State{Pos: movement.Vec3{Y: 9.5}}, false},
		{"falling", movement.State{Pos: movement.Vec3{Y: 30}, Vel: movement.Vec3{Y: -5}}, movement.State{Pos: movement.Vec3{Y: 29.9}}, true},
	}
	for _, c := range cases {
		if got := verticalOK(c.prev, c.next, g); got != c.ok {
			t.Errorf("%s: got %v want %v", c.name, got, c.ok)
		}
	}
	// Snapping up onto the ground is legal for validation (the step decides
	// what is walkable; WP10 slope rules live there, identical to the client).
	if !verticalOK(movement.State{Pos: movement.Vec3{Y: 0}}, movement.State{Pos: movement.Vec3{Y: 10}}, g) {
		t.Error("ground snap onto higher terrain rejected")
	}
	// Every real Step on real terrain passes.
	tr := testTerrain(t)
	s := tr.SpawnPoint("v")
	st := movement.NewState(s)
	for i := 0; i < 600; i++ {
		flags := uint16(proto.InputFlagForward | proto.InputFlagSprint)
		if i%50 == 0 {
			flags |= proto.InputFlagJump | proto.InputFlagJumpEdge
		}
		next := movement.Step(st, flags, float64(i)/100, tr)
		if !verticalOK(st, next, tr) {
			t.Fatalf("step %d rejected: %+v -> %+v", i, st, next)
		}
		st = next
	}
}
