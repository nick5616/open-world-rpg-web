package game

// CR 044: the Glide Ring Race on the official world's sky towns: courses are
// clear of the islands, a run over the wire (arm, fly the rings, finish, the
// board, the stored time), and the ways a run ends early.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"testing"
	"time"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/towns"
	"lodestone/server/pkg/worldhost"
	"lodestone/server/zone/internal/npc"
)

func skyStands(w *npc.World, ct *worldhost.CaveTerrain) []towns.Prop {
	var out []towns.Prop
	for i := range w.T.Settlements {
		if w.SkySettlement(i, ct.HeightAt) {
			if p := propOf(w, i, 31); p != nil {
				out = append(out, *p)
			}
		}
	}
	return out
}

func TestRaceCoursesAreClearAndDescend(t *testing.T) {
	w, g, ct := testVerticalTowns(t)
	h := newHarness(t, func(c *Config) {
		c.Ground = g
		c.Towns = w
	})
	stands := skyStands(w, ct)
	if len(stands) == 0 {
		t.Skip("no sky town")
	}
	for _, p := range stands {
		var c *raceCourse
		h.do(func() { c = h.srv.raceCourseFor(p.ID, p.X, p.Y, p.Z) })
		if c == nil || len(c.rings) != raceRings {
			t.Fatalf("stand %d: no course (%v)", p.ID, c)
		}
		v := ct.Vertical()
		for k, r := range c.rings {
			if k > 0 && math.Abs((c.rings[k-1].Y-r.Y)-raceDrop) > 1e-9 {
				t.Fatalf("ring %d does not descend by %v", k, raceDrop)
			}
			if k > 0 {
				if d := math.Hypot(r.X-c.rings[k-1].X, r.Z-c.rings[k-1].Z); d < raceSpacing*0.9 || d > raceSpacing*1.05 {
					t.Fatalf("ring %d is %v m from the last", k, d)
				}
			}
			for i := range v.Islands {
				is := &v.Islands[i]
				if math.Hypot(r.X-is.X, r.Z-is.Z) < is.R+8 && r.Y > is.Top-is.Thick-10 && r.Y < is.Top+12 {
					t.Fatalf("stand %d ring %d is inside island %d", p.ID, k, i)
				}
			}
		}
		// The first ring is within a glide of the stand's island top.
		if d := c.rings[0].Y - p.Y; d < -8 || d > 14 {
			t.Fatalf("first ring %v m from the stand's height", d)
		}
	}
}

func TestRaceOverTheWire(t *testing.T) {
	w, g, ct := testVerticalTowns(t)
	stands := skyStands(w, ct)
	if len(stands) == 0 {
		t.Skip("no sky town")
	}
	p := stands[0]
	store := NewMemRaceStore()
	h := newHarness(t, func(c *Config) {
		c.Ground = g
		c.Towns = w
		c.RaceStore = store
		c.TimeOffsetS = offsetFor(12)
	})
	a := h.dial(fmt.Sprintf("?spawn=%v,%v,%v", p.X+1, p.Y+3, p.Z))
	a.join(h, "racer-1", "Racer")
	a.pump(300 * time.Millisecond)
	a.send(&proto.Interact{TargetKind: InteractActivity, TargetID: p.ID, Action: 1})
	arm := a.nextEvent(EventRaceState, 3*time.Second)
	if arm.Value != RaceArmed {
		t.Fatalf("armed: %+v", arm)
	}
	var wire raceWire
	if err := json.Unmarshal(arm.Data, &wire); err != nil || len(wire.Rings) != raceRings || wire.Gold <= 0 || wire.Gold >= wire.Silv {
		t.Fatalf("course %v %+v", err, wire)
	}
	var ent *Entity
	h.do(func() { ent = h.srv.byChar["racer-1"].ent })
	fly := func(k int, tickGap uint32) {
		r := wire.Rings[k]
		h.do(func() {
			h.srv.Teleport(ent, movement.Vec3{X: r[0], Y: r[1], Z: r[2]})
			ent.Move.Mode = movement.ModeGlide
			h.srv.tick += tickGap // the test's clock: the run's time is ticks
		})
		time.Sleep(120 * time.Millisecond)
	}
	// Ring 0 starts the clock; skipping ahead does nothing.
	fly(3, 0)
	h.do(func() {
		if h.srv.race.live[ent.ID].next != 0 {
			t.Fatal("a ring out of order counted")
		}
	})
	for k := 0; k < raceRings; k++ {
		fly(k, 40)
	}
	var fin *proto.Event
	for i := 0; i < 40 && fin == nil; i++ {
		ev := a.nextEvent(EventRaceState, 3*time.Second)
		if ev.Value == RaceFinished {
			fin = ev
		} else if ev.Value != RaceRing {
			t.Fatalf("event %d %q", ev.Value, ev.Data)
		}
	}
	if fin == nil {
		t.Fatal("the run did not finish")
	}
	var res raceResult
	if err := json.Unmarshal(fin.Data, &res); err != nil || res.MS <= 0 || res.Rank != 1 || !res.PB || len(res.Board) != 1 {
		t.Fatalf("result %v %+v", err, res)
	}
	// Stored (in the background) and the next arming shows it.
	time.Sleep(200 * time.Millisecond)
	rows, _ := store.LoadRaces(context.Background(), testWorld)
	if len(rows) != 1 || rows[0].MS != res.MS || rows[0].Stand != p.ID {
		t.Fatalf("stored %+v", rows)
	}
	h.do(func() { h.srv.Teleport(ent, movement.Vec3{X: p.X + 1, Y: p.Y + 0.5, Z: p.Z}) })
	time.Sleep(150 * time.Millisecond)
	a.send(&proto.Interact{TargetKind: InteractActivity, TargetID: p.ID, Action: 1})
	var arm2 raceWire
	for i := 0; i < 20; i++ {
		ev := a.nextEvent(EventRaceState, 3*time.Second)
		if ev.Value == RaceArmed {
			if err := json.Unmarshal(ev.Data, &arm2); err != nil {
				t.Fatal(err)
			}
			break
		}
	}
	if arm2.Best != res.MS || len(arm2.Board) != 1 {
		t.Fatalf("second arming best %d board %v, want %d", arm2.Best, arm2.Board, res.MS)
	}
	// Landing after the first ring ends the run.
	fly(0, 0)
	h.do(func() { ent.Move.Mode = movement.ModeGround })
	var failed bool
	for i := 0; i < 20 && !failed; i++ {
		failed = a.nextEvent(EventRaceState, 3*time.Second).Value == RaceFailed
	}
	if !failed {
		t.Fatal("touching down did not end the run")
	}
}
