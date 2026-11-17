package game

// CR 050 zone side: the dusk call of a guard (Event 1930) and the town bell
// (Event 1931), once per town per evening, and the rain flag the schedules
// read.

import (
	"context"
	"math"
	"slices"
	"testing"
	"time"

	"lodestone/server/pkg/towns"
	"lodestone/server/zone/internal/npc"
)

// guardTown is a settlement with a guard, a bell (village or larger) and the guard's post.
func guardTown(w *npc.World) (si, guard int) {
	for si := range w.T.Settlements {
		st := &w.T.Settlements[si]
		if st.Size < 1 {
			continue
		}
		for i := st.NPCFirst; i < st.NPCFirst+st.NPCs; i++ {
			if w.T.NPCs[i].Role == towns.RoleGuard {
				return si, i
			}
		}
	}
	return -1, -1
}

func TestDuskGuardCallAndTownBellOncePerEvening(t *testing.T) {
	w, g := testTowns(t)
	h := newHarness(t, func(c *Config) {
		c.Ground = g
		c.Towns = w
		c.TimeOffsetS = offsetFor(18) // before dusk: the guard is at his post
	})
	si, guard := guardTown(w)
	if guard < 0 {
		t.Skip("no settlement with a guard in the test world")
	}
	gd := w.T.NPCs[guard]
	a := h.dial(spawnAt(gd.WorkX+3, gd.WorkZ))
	a.join(h, "dusk-a", "Lamplighter")
	gid := a.npcEntityID(h, guard)
	if gid == 0 {
		t.Fatal("the guard is not active")
	}
	a.pump(300 * time.Millisecond)

	dusk := func(idx int64) {
		_ = h.srv.Do(context.Background(), func() { h.srv.townsDusk(idx) })
	}
	dusk(5)
	bark := a.nextEvent(EventNPCBark, 3*time.Second)
	if bark.EntityID != gid || !slices.Contains(npc.DuskLines, string(bark.Data)) || bark.TargetID != 0 {
		t.Fatalf("dusk bark %+v (guard entity %d)", bark, gid)
	}
	if string(bark.Data) != npc.DuskLine(si, 5) {
		t.Fatalf("the call for this night is %q, got %q", npc.DuskLine(si, 5), bark.Data)
	}
	bell := a.nextEvent(EventTownBell, 3*time.Second)
	st := &w.T.Settlements[si]
	if bell.Value != townBellStrokes || math.Abs(float64(bell.X)/100-st.X) > 0.02 || math.Abs(float64(bell.Z)/100-st.Z) > 0.02 {
		t.Fatalf("town bell %+v at the square (%.1f, %.1f)", bell, st.X, st.Z)
	}
	// The same evening again: nothing (once per town per evening).
	dusk(5)
	a.noEvent(EventNPCBark, 400*time.Millisecond)
	a.noEvent(EventTownBell, 100*time.Millisecond)
	// The next evening: again.
	dusk(6)
	if b := a.nextEvent(EventNPCBark, 3*time.Second); b.EntityID != gid || string(b.Data) != npc.DuskLine(si, 6) {
		t.Fatalf("next evening: %+v", b)
	}
}

func TestRainFlagFollowsTheWeather(t *testing.T) {
	w, g := testTowns(t)
	h := newHarness(t, func(c *Config) {
		c.Ground = g
		c.Towns = w
		c.TimeOffsetS = offsetFor(10)
	})
	si := spawnSettlement(t, w)
	md := w.T.NPCs[npcOf(w, si, towns.RoleMerchant)]
	a := h.dial(spawnAt(md.WorkX+2, md.WorkZ))
	a.join(h, "rain-a", "Umbrella")
	a.pump(500 * time.Millisecond)
	_ = h.srv.Do(context.Background(), func() {
		h.srv.env.Raining = true
		h.srv.townsTick(1, time.Now())
		if !w.Rain {
			t.Error("rain did not reach the schedules")
		}
		h.srv.env.Raining = false
		h.srv.townsTick(2, time.Now())
		if w.Rain {
			t.Error("rain flag stuck")
		}
	})
}
