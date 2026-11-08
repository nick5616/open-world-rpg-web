package combat

import (
	"math"
	"testing"

	"lodestone/server/pkg/movement"
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
