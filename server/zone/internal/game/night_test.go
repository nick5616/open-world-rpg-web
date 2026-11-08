package game

import (
	"context"
	"encoding/binary"
	"math"
	"sync/atomic"
	"testing"
	"time"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/weather"
	"lodestone/server/zone/internal/chem"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/night"
)

type grass struct{}

func (grass) Material(ix, iz int) uint8 {
	if dx, dz := ix-150, iz-150; dx*dx+dz*dz > 40*40 {
		return chem.MatNone
	}
	return chem.MatGrass
}
func (grass) Height(ix, iz int) float64 { return 0 }
func (grass) Water(ix, iz int) float64  { return math.Inf(-1) }

// nightHarness: flat world, one town at (500, 500), chemistry on a grass
// patch around (300, 300), a controllable wall clock (skip moves it).
func nightHarness(t *testing.T) (*harness, *atomic.Int64) {
	var skip atomic.Int64
	base := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	start := time.Now()
	h := newHarness(t, func(c *Config) {
		c.Now = func() time.Time { return base.Add(time.Since(start) + time.Duration(skip.Load())) }
		// Night: 20:00 world time (base is a whole hour: 0 s into the day).
		c.TimeOffsetS = 20 * 150
		nw := &night.World{Seed: 42, Intensity: 0.5, Towns: []night.Town{{Index: 0, Name: "Testholm", X: 500, Z: 500, Radius: 30, GardenX: 505, GardenZ: 500, Element: 8}}}
		sim := chem.NewSim(42, 270, grass{}, 0)
		c.Night = &NightSetup{World: nw, Chem: sim, Overlay: &chem.Overlay{}, WindDeg: 270, Dev: true, NoDemons: true, Force: -1}
		c.Combat = &CombatSetup{Dev: true, Config: combat.Config{Seed: 42, NoWildPacks: true}}
	})
	return h, &skip
}

func (cl *client) event(kind uint16, timeout time.Duration) *proto.Event {
	cl.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		m := cl.next(proto.MsgEvent, time.Until(deadline))
		if e := m.(*proto.Event); e.Kind == kind {
			return e
		}
	}
	cl.t.Fatalf("no event %d", kind)
	return nil
}

func TestWorldClockIsAnnouncedAndShared(t *testing.T) {
	h, _ := nightHarness(t)
	cl := h.dial("?spawn=300,300")
	cl.join(h, "c1", "Ana")
	ev := cl.event(EventWorldClock, 3*time.Second)
	off := math.Float64frombits(binary.LittleEndian.Uint64(ev.Data[1:]))
	if ev.Data[0] != 1 || off != 20*150 || ev.Data[12] != ChemModeEvents {
		t.Fatalf("clock event %+v offset %v", ev, off)
	}
	var tod float64
	var isNight bool
	_ = h.srv.Do(context.Background(), func() { tod = h.srv.timeOfDay(time.Now()); isNight = weather.IsNight(h.srv.worldTimeS()) })
	if !isNight || math.Abs(weather.Hour(tod)-20) > 0.1 {
		t.Fatalf("NPC clock %v h, night %v: one clock for sky, NPCs and demons", weather.Hour(tod), isNight)
	}
}

func TestChemOpsReachClientsAndBaselinesResync(t *testing.T) {
	h, _ := nightHarness(t)
	a := h.dial("?spawn=300,300")
	a.join(h, "ca", "Ana")
	b := h.dial("?spawn=310,300")
	b.join(h, "cb", "Bo")
	// Dev ignite at (300, 300) with radius 1.
	a.send(&proto.Interact{TargetKind: InteractChem, Action: 1, TargetID: uint64(uint32(30000)) | uint64(uint32(30000))<<32, Arg: 1})
	for _, cl := range []*client{a, b} {
		ev := cl.event(chem.EvIgnite, 3*time.Second)
		op, err := chem.DecodeOp(ev)
		if err != nil || op.Kind != chem.OpIgnite || op.Cell != chem.CellID(150, 150) || op.Radius != 1 {
			t.Fatalf("ignite op %+v %v", op, err)
		}
	}
	time.Sleep(2 * time.Second)
	// A late joiner gets the burning chunk as a baseline that reproduces the zone's state.
	c := h.dial("?spawn=305,305")
	c.join(h, "cc", "Cy")
	ev := c.event(chem.EvBaseline, 3*time.Second)
	step, cells, err := chem.DecodeBaseline(ev.TargetID, ev.Data)
	if err != nil || len(cells) == 0 {
		t.Fatalf("baseline %v (%d cells)", err, len(cells))
	}
	sim := chem.NewSim(42, 270, grass{}, step)
	sim.Rain = new(bool)
	sim.LoadChunk(ev.TargetID, cells)
	var zoneHash uint32
	var ok bool
	_ = h.srv.Do(context.Background(), func() {
		zs := h.srv.night.cfg.Chem
		// Compare at the baseline's step: replay the zone's history from its digest ring.
		for _, hh := range h.srv.night.hashes {
			if hh.Step == step {
				zoneHash, ok = hh.Hash, true
			}
		}
		_ = zs
	})
	if !ok || zoneHash != sim.Hash() {
		t.Fatalf("baseline at step %d: client %08x zone %08x (found %v)", step, sim.Hash(), zoneHash, ok)
	}
}

func TestTownDefenseRunsStartToFinish(t *testing.T) {
	h, skip := nightHarness(t)
	a := h.dial("?spawn=520,500")
	a.join(h, "da", "Ana")
	b := h.dial("?spawn=480,500")
	b.join(h, "db", "Bo")
	time.Sleep(200 * time.Millisecond)
	var started bool
	_ = h.srv.Do(context.Background(), func() { started = h.srv.StartDefense(0) })
	if !started {
		t.Fatal("defense did not start")
	}
	a.event(EventDefenseWarning, 3*time.Second)
	waves := 0
	for waves < constants.DefenseWaves {
		skip.Add(int64(time.Duration(constants.DefenseWarningS+1) * time.Second)) // past the warning / lull
		ev := a.event(EventDefenseWave, 5*time.Second)
		waves = int(ev.Value)
		// The defenders "win" the wave: sunsteel stands in as KillDemon here (the
		// real fight runs in the nightbots acceptance against the zone process).
		time.Sleep(150 * time.Millisecond)
		_ = h.srv.Do(context.Background(), func() {
			d := h.srv.night.defs[0]
			if d == nil {
				return
			}
			if d.part == nil || len(d.part) < 2 {
				t.Errorf("participants %d", len(d.part))
			}
			for _, g := range d.groups {
				for _, e := range g.Members {
					if e.Demon == nil || e.Demon.Goal == nil {
						t.Errorf("wave demon without a ward goal")
					}
					h.srv.cbt.w.KillDemon(e)
				}
			}
		})
		time.Sleep(200 * time.Millisecond) // let the zone see the wave fall before the clock skips
	}
	end := a.event(EventDefenseEnded, 5*time.Second)
	if end.Value != DefenseHeld {
		t.Fatalf("defense result %d", end.Value)
	}
	if r := b.event(EventDefenseReward, 3*time.Second); r.Value <= 0 {
		t.Fatal("no reward")
	}
}

func TestDemonsNeverHuntInsideAWardAndBurnAtDawn(t *testing.T) {
	h, skip := nightHarness(t)
	a := h.dial("?spawn=300,300")
	a.join(h, "na", "Ana")
	time.Sleep(200 * time.Millisecond)
	var g *combat.Group
	_ = h.srv.Do(context.Background(), func() {
		g = h.srv.cbt.w.SpawnDemons(movement.Vec3{X: 330, Z: 300}, []string{"gloamling", "gloamling"}, 1)
		h.srv.trackDemons(g, 0, "lesser", -1)
	})
	// Fast-forward to dawn (06:00 world time is 10 in-game hours later).
	skip.Add(int64(10*150*time.Second + time.Second))
	ev := a.event(EventDawn, 5*time.Second)
	if ev.Value+int32(ev.TargetID) != 2 {
		t.Fatalf("dawn burned %d fled %d, want 2 demons", ev.Value, ev.TargetID)
	}
	time.Sleep(2500 * time.Millisecond)
	var left int
	_ = h.srv.Do(context.Background(), func() { left = len(h.srv.night.groups) + len(h.srv.cbt.w.Enemies()) })
	if left != 0 {
		t.Fatalf("%d demon groups/enemies left after dawn", left)
	}
	// Wards: the town blocks demons, a player inside is sheltered.
	_ = h.srv.Do(context.Background(), func() {
		e := &combat.Enemy{Demon: &combat.DemonState{Rank: "lesser"}}
		if !h.srv.demonBlocked(e, 500, 500) || h.srv.demonBlocked(e, 600, 600) {
			t.Error("ward block")
		}
	})
}
