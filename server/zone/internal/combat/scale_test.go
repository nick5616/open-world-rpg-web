package combat

import (
	"math"
	"testing"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

// WP19: windupsOn walks an index of winding enemies instead of every enemy.
// It must count exactly what the old full scan counted, at every call
// (including enemies that started winding earlier in the same Step), so
// the "at most two wind-ups on one player" rule is unchanged.
func TestWindupIndexMatchesFullScan(t *testing.T) {
	w, _ := newWorld()
	var players []*handPlayer
	for i := 0; i < 6; i++ {
		players = append(players, newHand(w, uint32(1+i), movement.Vec3{X: 2000 + float64(i)*3, Z: 2000}, "sword"))
	}
	for g := 0; g < 30; g++ {
		a := float64(g) * 2.4
		r := 4 + float64(g%5)*3
		w.TestGroup(movement.Vec3{X: 2000 + r*math.Cos(a), Z: 2000 + r*math.Sin(a)}, []string{"boar", "wolf", "cutthroat", "archer"}, 1, "")
	}
	full := func(target uint32) int {
		n := 0
		for _, id := range w.order {
			if o := w.enemies[id]; o != nil && o.State == Windup && o.Target == target {
				n++
			}
		}
		return n
	}
	windups, maxOn := 0, 0
	for tick := uint32(1); tick <= 30*40; tick++ {
		for _, h := range players {
			h.idle(2)
		}
		w.Step(tick)
		w.Drain()
		for _, h := range players {
			got, want := w.windupsOn(h.p.ID), full(h.p.ID)
			if got != want {
				t.Fatalf("tick %d player %d: index %d, full scan %d", tick, h.p.ID, got, want)
			}
			maxOn = max(maxOn, got)
			if got > maxWindupsOnOne {
				t.Fatalf("tick %d: %d wind-ups on player %d", tick, got, h.p.ID)
			}
		}
		for _, o := range w.winding {
			if o.State == Windup {
				windups++
			}
		}
	}
	if windups == 0 || maxOn < maxWindupsOnOne {
		t.Fatalf("scenario too quiet: %d winding samples, max %d on one player", windups, maxOn)
	}
}

// WP19: acquire, playersNear and the wake rule look players up in a grid
// during Step. They must answer exactly what the full scans answered.
func TestPlayerGridMatchesFullScan(t *testing.T) {
	w, _ := newWorld()
	var players []*handPlayer
	for i := 0; i < 60; i++ {
		a, r := float64(i)*2.4, 5+float64(i%12)*9
		players = append(players, newHand(w, uint32(1+i), movement.Vec3{X: 2000 + r*math.Cos(a), Z: 2000 + r*math.Sin(a)}, "sword"))
	}
	// One player at the world edge and one outside it (clamped cells).
	players = append(players, newHand(w, 900, movement.Vec3{X: 1, Z: 2000}, "sword"), newHand(w, 901, movement.Vec3{X: -40, Z: 2010}, "sword"))
	for g := 0; g < 40; g++ {
		a, r := float64(g)*2.4, 3+float64(g%9)*11
		w.TestGroup(movement.Vec3{X: 2000 + r*math.Cos(a), Z: 2000 + r*math.Sin(a)}, []string{"boar", "wolf", "archer"}, 1, "")
	}
	w.TestGroup(movement.Vec3{X: 20, Z: 2000}, []string{"wolf"}, 1, "")
	checked := 0
	for tick := uint32(1); tick <= 30*20; tick++ {
		for i, h := range players {
			h.frame(proto.InputFlagForward, 0, float64(tick+uint32(i))*0.05)
		}
		w.Step(tick)
		w.Drain()
		if tick%10 != 0 {
			continue
		}
		w.buildPlayerGrid()
		for _, e := range w.Enemies() {
			for _, mult := range []float64{1, 1.5} {
				fast := w.acquire(e, mult)
				w.pg.valid = false
				slow := w.acquire(e, mult)
				w.pg.valid = true
				if fast != slow {
					t.Fatalf("tick %d enemy %d mult %v: grid picked %v, scan %v", tick, e.ID, mult, fast, slow)
				}
				checked++
			}
			for _, r := range []float64{3, 30, 96, 130} {
				fast := w.playersNear(e.Pos, r)
				w.pg.valid = false
				slow := w.playersNear(e.Pos, r)
				w.pg.valid = true
				if len(fast) != len(slow) {
					t.Fatalf("tick %d playersNear r=%v: %d vs %d", tick, r, len(fast), len(slow))
				}
				for i := range fast {
					if fast[i] != slow[i] {
						t.Fatalf("tick %d playersNear r=%v differs", tick, r)
					}
				}
			}
		}
		w.pg.valid = false
	}
	if checked < 1000 {
		t.Fatalf("only %d acquire checks", checked)
	}
}
