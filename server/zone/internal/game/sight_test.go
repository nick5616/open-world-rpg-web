package game

import (
	"context"
	"math"
	"testing"

	"lodestone/server/pkg/camps"
	"lodestone/server/pkg/campdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/towns"
	"lodestone/server/zone/internal/combat"
)

// CR 056 on the real geometry (the official world's wasm): a house of the
// spawn town, a base wall (CR 041 collision piece), and cave rock all stop the
// monsters' line of sight; open ground does not. The rules themselves are
// tested against fake geometry in internal/combat/sight_test.go.

func eye(p movement.Vec3) movement.Vec3 { return movement.Vec3{X: p.X, Y: p.Y + 1.2, Z: p.Z} }

func TestLineOfSightTownWall(t *testing.T) {
	w, g := testTowns(t)
	ds := towns.NewDoors(w.T)
	si := spawnSettlement(t, w)
	blk := towns.NewBlocker(towns.NewCollision(&w.T.Boxes), float64(constants.WorldSizeM))
	h := newHarness(t, func(c *Config) {
		c.Ground = g
		c.Towns = w
		c.Combat = &CombatSetup{Config: combat.Config{Seed: 42, NoWildPacks: true}}
	})
	st := &w.T.Settlements[si]
	tried := 0
	for b := st.BuildingFirst; b < st.BuildingFirst+st.Buildings && tried < 3; b++ {
		bd := &w.T.Buildings[b]
		d, ok := ds.ByBuilding[b]
		if !ok {
			continue
		}
		// outside the door, and straight through the house at its back
		fx, fz := bd.Door(3.2)
		bx, bz := bd.Local(0, bd.HZ+4)
		// the control line (along the back wall) must be open by the box index
		cx, cz := bd.Local(6, bd.HZ+4)
		open := func(ax, az, ex, ez float64) bool {
			for k := 0; k <= 40; k++ {
				x, z := ax+(ex-ax)*float64(k)/40, az+(ez-az)*float64(k)/40
				if blk.Blocked(x, g.HeightAt(x, z), z, 0.4, 2) {
					return false
				}
			}
			return true
		}
		if open(fx, fz, bx, bz) || !open(bx, bz, cx, cz) {
			continue // the line does not cross the house, or the control line is not open
		}
		tried++
		_ = h.srv.Do(context.Background(), func() {
			h.srv.doorSchedule(d, false, 0) // shut
			cw := h.srv.cbt.w
			a := movement.Vec3{X: fx, Y: g.HeightAt(fx, fz), Z: fz}
			bk := movement.Vec3{X: bx, Y: g.HeightAt(bx, bz), Z: bz}
			c := movement.Vec3{X: cx, Y: g.HeightAt(cx, cz), Z: cz}
			if cw.LineClear(eye(a), eye(bk)) {
				t.Errorf("building %d: the line through the house is clear", b)
			}
			if !cw.LineClear(eye(bk), eye(c)) {
				t.Errorf("building %d: the line along the back wall is blocked", b)
			}
		})
	}
	if tried == 0 {
		t.Fatal("no house in the spawn settlement to test with")
	}
}

func TestLineOfSightBaseWall(t *testing.T) {
	w, g := testTowns(t)
	h := newHarness(t, func(c *Config) {
		c.Ground = g
		c.Towns = w
		c.Combat = &CombatSetup{Config: combat.Config{Seed: 42, NoWildPacks: true}}
	})
	st := &w.T.Settlements[spawnSettlement(t, w)]
	x, z := st.X+st.Radius+60, st.Z // open ground outside the town
	y := g.HeightAt(x, z)
	wall := camps.SolidPiece{ID: 1, Kind: campdefs.D.ByKey("wall_wood").ID, X: x, Y: y, Z: z}
	_ = h.srv.Do(context.Background(), func() {
		s := h.srv
		cw := s.cbt.w
		at := func(dx, dz float64) movement.Vec3 {
			return movement.Vec3{X: x + dx, Y: g.HeightAt(x+dx, z+dz) + 1.2, Z: z + dz}
		}
		if !cw.LineClear(at(-6, 0), at(6, 0)) || !cw.LineClear(at(0, -6), at(0, 6)) {
			t.Fatal("no wall yet and the line is blocked")
		}
		s.camp.set = camps.NewSet([]camps.SolidPiece{wall})
		// a wall runs along one axis: the line across it is blocked, in at least one of the two directions
		bx, bz := !cw.LineClear(at(-6, 0), at(6, 0)), !cw.LineClear(at(0, -6), at(0, 6))
		if !bx && !bz {
			t.Fatal("a base wall does not block the line of sight")
		}
		if !cw.LineClear(at(-6, 6), at(6, 6)) {
			t.Error("a line 6 m beside the wall is blocked")
		}
		s.camp.set = camps.NewSet(nil)
		if !cw.LineClear(at(-6, 0), at(6, 0)) || !cw.LineClear(at(0, -6), at(0, 6)) {
			t.Error("the wall is gone and the line is still blocked")
		}
	})
}

func TestLineOfSightCaveRock(t *testing.T) {
	ct := testCaveTerrain(t)
	h := newHarness(t, func(c *Config) {
		c.Ground = ct
		c.Combat = &CombatSetup{Config: combat.Config{Seed: 42, NoWildPacks: true}}
	})
	g := ct.CaveGraph()
	s := g.Systems[0]
	deep := g.Chambers[s.FirstChamber+s.Deepest]
	ct.Caves.Ensure(deep.X, deep.Floor, deep.Z, 48)
	_ = h.srv.Do(context.Background(), func() {
		cw := h.srv.cbt.w
		in := movement.Vec3{X: deep.X, Y: ct.FloorAt(deep.X, deep.Floor+1, deep.Z) + 1.2, Z: deep.Z}
		up := movement.Vec3{X: deep.X + 0.5, Y: ct.HeightAt(deep.X, deep.Z) + 1.5, Z: deep.Z}
		if math.Abs(up.Y-in.Y) < 12 {
			t.Skip("the deepest chamber is too shallow to tell rock from air")
		}
		if cw.LineClear(in, up) {
			t.Error("a monster on the surface sees a player in the chamber through the rock above")
		}
		near := movement.Vec3{X: deep.X + 2.5, Y: ct.FloorAt(deep.X+2.5, deep.Floor+1, deep.Z) + 1.2, Z: deep.Z}
		if !cw.LineClear(in, near) {
			t.Error("two points in the same chamber do not see each other")
		}
	})
}
