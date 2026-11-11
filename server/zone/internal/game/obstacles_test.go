package game

import (
	"context"
	"math"
	"testing"
	"time"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/towns"
	"lodestone/server/zone/internal/combat"
)

// Enemies respect buildings, in-process on the official world (real wasm
// towns layer): wolves behind a house of the spawn town hunt a player
// standing at its front door. They must never overlap a wall (the same
// boxes the player's movement collides with) nor get inside the house
// (control). Playtest 2 pathfinding: they come up to the back wall, then
// round the house to the player (they used to wait at the wall).
// (control).
func TestEnemiesDoNotWalkThroughBuildings(t *testing.T) {
	w, g := testTowns(t)
	ds := towns.NewDoors(w.T)
	si := spawnSettlement(t, w)
	blk := towns.NewBlocker(towns.NewCollision(&w.T.Boxes), float64(constants.WorldSizeM))
	// A house with a door whose back is within a wolf's aggro of its front
	// step, with open ground behind it.
	st := &w.T.Settlements[si]
	bi, d := -1, -1
	for b := st.BuildingFirst; b < st.BuildingFirst+st.Buildings && bi < 0; b++ {
		bd := &w.T.Buildings[b]
		dd, ok := ds.ByBuilding[b]
		if !ok || 2*bd.HZ+8 > 19 {
			continue
		}
		bx, bz := bd.Local(0, bd.HZ+5)
		if blk.Near(bx, bz) && blk.Blocked(bx, g.HeightAt(bx, bz), bz, 1.5, 2) {
			continue
		}
		bi, d = b, dd
	}
	if bi < 0 {
		t.Fatal("no suitable house in the spawn settlement")
	}
	bd := w.T.Buildings[bi]
	inside := func(p movement.Vec3) bool {
		dx, dz := p.X-bd.X, p.Z-bd.Z
		u, v := dx*bd.C+dz*bd.S, dz*bd.C-dx*bd.S
		return math.Abs(u) < bd.HX-0.3 && math.Abs(v) < bd.HZ-0.3
	}
	run := func(t *testing.T, hook bool) (crossed, overlapped, reachedWall, reachedBait bool) {
		h := newHarness(t, func(c *Config) {
			c.Ground = g
			c.Towns = w
			c.TimeOffsetS = offsetFor(12)
			c.Combat = &CombatSetup{Config: combat.Config{Seed: 42, NoWildPacks: true}}
		})
		fx, fz := bd.Door(3.2) // outside the door, on the street side
		cl := h.dial(spawnAt(math.Round(fx*100)/100, math.Round(fz*100)/100))
		cl.join(h, "bait", "Bait")
		bx, bz := bd.Local(0, bd.HZ+5)
		_ = h.srv.Do(context.Background(), func() {
			h.srv.doorSchedule(d, false, 0) // the door is shut
			if !hook {
				h.srv.cbt.w.Obstacles = nil
			}
			h.srv.cbt.w.TestGroup(movement.Vec3{X: bx, Z: bz}, []string{"wolf", "wolf"}, 1, "")
		})
		wasClear := map[uint32]bool{} // spawned members may land on a neighbour's box; only moving into one counts
		deadline := time.Now().Add(8 * time.Second)
		for time.Now().Before(deadline) && !crossed {
			cl.keep(100 * time.Millisecond)
			_ = h.srv.Do(context.Background(), func() {
				for _, e := range h.srv.cbt.w.Enemies() {
					if !e.Alive() || e.Group == nil || e.Group.Kind != combat.GroupTest {
						continue
					}
					if inside(e.Pos) {
						crossed = true
					}
					if blk.Blocked(e.Pos.X, e.Pos.Y, e.Pos.Z, e.Radius(), e.Height()*2) {
						overlapped = overlapped || wasClear[e.ID]
					} else {
						wasClear[e.ID] = true
					}
					dx, dz := e.Pos.X-bd.X, e.Pos.Z-bd.Z
					if v := dz*bd.C - dx*bd.S; v < bd.HZ+e.Radius()+0.8 && v > 0 {
						reachedWall = true
					}
					if math.Hypot(e.Pos.X-fx, e.Pos.Z-fz) < 3.5 {
						reachedBait = true // round the house to the player (pathfinding)
					}
				}
			})
		}
		return
	}
	t.Run("control", func(t *testing.T) {
		if crossed, _, _, _ := run(t, false); !crossed {
			t.Fatal("without the hook the wolves should walk through the house (the test would prove nothing)")
		}
	})
	t.Run("buildings", func(t *testing.T) {
		crossed, overlapped, reached, bait := run(t, true)
		if crossed || overlapped {
			t.Fatalf("wolves got into the house (%v) or overlapped its walls (%v)", crossed, overlapped)
		}
		if !reached {
			t.Fatal("the wolves never came up to the back wall")
		}
		if !bait {
			t.Fatal("the wolves never came round the house to the player at its door (pathfinding)")
		}
	})
}
