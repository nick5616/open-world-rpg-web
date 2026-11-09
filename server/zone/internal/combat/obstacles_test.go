package combat

import (
	"math"
	"testing"

	"lodestone/server/pkg/movement"
)

// wallAt510 is a 1 m thick wall along z 470..530 at x 509.5..510.5.
func wallAt510(x, y, z, r, h float64) bool {
	return math.Abs(x-510) < 0.5+r && z > 470-r && z < 530+r
}

// chaseAcrossWall: a wolf at (503, 500) hunts a player at (525, 500) on the
// other side of the wall for 3 s; returns the wolf's largest x and whether
// it ever overlapped the wall.
func chaseAcrossWall(t *testing.T, obstacles func(x, y, z, r, h float64) bool) (maxX float64, overlapped bool) {
	t.Helper()
	w, _ := newWorld()
	w.Obstacles = obstacles
	h := newHand(w, 1, movement.Vec3{X: 525, Z: 500}, "sword")
	e := spawnOne(w, "wolf", movement.Vec3{X: 503, Z: 500})
	e.Pos.X, e.Pos.Z = 503, 500
	e.Target, e.State = h.p.ID, Chase
	maxX = e.Pos.X
	for i := 0; i < 90; i++ {
		h.idle(2)
		w.Step(w.tick + 1)
		w.Drain()
		if e.Target == 0 {
			e.Target, e.State = h.p.ID, Chase
		}
		maxX = math.Max(maxX, e.Pos.X)
		if wallAt510(e.Pos.X, e.Pos.Y, e.Pos.Z, e.Radius(), 1) {
			overlapped = true
		}
	}
	return maxX, overlapped
}

// Enemies respect World.Obstacles (the zone's building boxes): a wolf
// chasing a player behind a wall stops at it instead of walking through;
// without obstacles it walks straight across.
func TestEnemyChaseStopsAtObstacle(t *testing.T) {
	if maxX, _ := chaseAcrossWall(t, nil); maxX < 515 {
		t.Fatalf("control: without obstacles the wolf should cross the wall line (max x %.2f)", maxX)
	}
	maxX, overlapped := chaseAcrossWall(t, wallAt510)
	if overlapped || maxX > 509.5-0.45 {
		t.Fatalf("the wolf walked into the wall: max x %.2f, overlapped %v", maxX, overlapped)
	}
	if maxX < 508.5 {
		t.Fatalf("the wolf never reached the wall (max x %.2f): blocked too early", maxX)
	}
}

// An enemy that is already inside an obstacle (spawned or knocked there) is
// never frozen: it can still move.
func TestEnemyInsideObstacleCanLeave(t *testing.T) {
	w, _ := newWorld()
	w.Obstacles = func(x, y, z, r, h float64) bool { return math.Hypot(x-500, z-500) < 3+r }
	h := newHand(w, 1, movement.Vec3{X: 520, Z: 500}, "sword")
	e := spawnOne(w, "wolf", movement.Vec3{X: 500, Z: 500})
	e.Pos.X, e.Pos.Z = 500.5, 500
	e.Target, e.State = h.p.ID, Chase
	for i := 0; i < 60; i++ {
		h.idle(2)
		w.Step(w.tick + 1)
		w.Drain()
	}
	if math.Hypot(e.Pos.X-500, e.Pos.Z-500) < 3+e.Radius() {
		t.Fatalf("the wolf stayed stuck inside the obstacle at (%.2f, %.2f)", e.Pos.X, e.Pos.Z)
	}
}
