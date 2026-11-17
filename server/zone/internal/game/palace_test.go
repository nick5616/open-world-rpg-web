package game

// CR 044: the sky palace on the official world (seed 20261108): walking in
// through the gate, the floors and walls, the atrium's updraft, the trial
// (wards, the guardian, the chest) over the wire.

import (
	"context"
	"io"
	"log/slog"
	"math"
	"testing"
	"time"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/palace"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/vertical"
	"lodestone/server/pkg/writebehind"
	"lodestone/server/zone/internal/combat"
)

func firstPalace(t *testing.T, ct interface{ Vertical() *vertical.World }) palace.Site {
	t.Helper()
	s := palace.SitesOf(ct.Vertical())
	if len(s) == 0 {
		t.Skip("no sky palace on this world")
	}
	return s[0]
}

// The floor under the gate, the colonnade and the wards is the palace floor;
// the doorways are open and the walls are not.
func TestPalaceWalkable(t *testing.T) {
	_, g, ct := testVerticalTowns(t)
	ps := firstPalace(t, ct)
	at := func(lx, lz, ly float64) (float64, float64, float64) {
		x, z := ps.World(lx, lz)
		return x, ps.Floor + ly, z
	}
	floorAt := func(lx, lz, ly float64) float64 {
		x, y, z := at(lx, lz, ly)
		ct.Layers.Ensure(x, z, 2)
		return movement.GroundAt(g, x, y+0.3, z)
	}
	for _, p := range [][3]float64{{0, 38, 0}, {0, 16, 0}, {-21, 15, 0}, {21, 15, 0}, {0, -5, 0}, {-12, -4.5, palace.D.RingY}, {0, -27, palace.D.RingY}, {0, -37, palace.D.RingY}} {
		if f := floorAt(p[0], p[1], p[2]); math.Abs(f-(ps.Floor+p[2])) > 0.01 {
			t.Errorf("floor at local %v is %v, want %v", p, f, ps.Floor+p[2])
		}
	}
	// A path from the steps through the gate, the vestibule, the colonnade, into the sun gallery: no wall in the way.
	collide := func(lx, lz, ly float64) movement.CollideResult {
		x, y, z := at(lx, lz, ly)
		return movement.AtLevel(g, y).(movement.Collider).Collide(x, y, z)
	}
	walk := func(name string, pts [][2]float64) {
		for i := 0; i+1 < len(pts); i++ {
			a, b := pts[i], pts[i+1]
			n := int(math.Hypot(b[0]-a[0], b[1]-a[1]) * 4)
			for k := 0; k <= n; k++ {
				f := float64(k) / float64(max(1, n))
				lx, lz := a[0]+(b[0]-a[0])*f, a[1]+(b[1]-a[1])*f
				if r := collide(lx, lz, 0); r.PushX != 0 || r.PushZ != 0 {
					t.Fatalf("%s: a wall at local (%.2f, %.2f)", name, lx, lz)
				}
			}
		}
	}
	walk("gate to the sun gallery", [][2]float64{{0, 52}, {0, 33}, {0, 16}, {-10, 16}, {-21, 16}})
	walk("colonnade to the moon gallery", [][2]float64{{0, 16}, {21, 16}})
	walk("colonnade to the atrium to the west wing", [][2]float64{{0, 16}, {0, 0}, {0, -5}, {-10, -5}, {-21, -5}})
	walk("vestibule to the east annex", [][2]float64{{0, 33}, {21, 33}})
	for _, p := range [][2]float64{{-27, 10}, {27, 10}, {0, -39}, {-8, 4}, {-14, 22}, {14, -12}} {
		if r := collide(p[0], p[1], 0); r.PushX == 0 && r.PushZ == 0 {
			t.Errorf("no wall at local %v", p)
		}
	}
}

// A glider in the atrium shaft is carried to the upper gallery; the gallery
// reaches the throne hall.
func TestPalaceShaftLiftsToTheRing(t *testing.T) {
	_, _, ct := testVerticalTowns(t)
	ps := firstPalace(t, ct)
	cols := palace.Wind(palace.SitesOf(ct.Vertical()))
	x, z := ps.World(palace.D.Shaft.X, palace.D.Shaft.Z)
	if l := cols.LiftAt(x, ps.Floor+3, z); l < constants.UpdraftFreeLift {
		t.Fatalf("lift at the shaft %v", l)
	}
	if l := cols.LiftAt(x, ps.Floor+palace.D.RingY+8, z); l != 0 {
		t.Fatalf("lift above the shaft's top: %v", l)
	}
	x2, z2 := ps.World(palace.D.Shaft.X+palace.D.Shaft.R+2, palace.D.Shaft.Z)
	if l := cols.LiftAt(x2, ps.Floor+3, z2); l != 0 {
		t.Fatalf("lift beside the shaft: %v", l)
	}
}

func TestPalaceTrialOverTheWire(t *testing.T) {
	w, g, ct := testVerticalTowns(t)
	ps := firstPalace(t, ct)
	ex := realExplore(t, g)
	store := &contentStore{questStore: questStore{fakeStore: fakeStore{saves: map[string]movement.Vec3{}, rows: map[string]movement.Vec3{}}, logs: map[string][]byte{}}, data: map[string][]byte{}}
	q := writebehind.New(100)
	q.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	qctx, stopQ := context.WithCancel(context.Background())
	t.Cleanup(stopQ)
	go q.Run(qctx)
	grants := &memGrants{}
	h := newHarness(t, func(c *Config) {
		c.Ground = g
		c.Towns = w
		c.Explore = ex
		c.Store = store
		c.Queue = q
		c.Granter = grants
		c.TimeOffsetS = offsetFor(12)
		raw := testTerrain(t).World().Atlas
		a, err := structures.ParseAtlas(raw)
		if err != nil {
			t.Fatal(err)
		}
		c.Combat = &CombatSetup{Atlas: combat.ParseAtlas(raw, a), Config: combat.Config{Seed: 42, NoWildPacks: true}}
	})
	h.srv.SetWorldEvents(false)
	const char = "66666666-4444-5555-6666-777777777777"
	gx, gz := ps.World(0, 36)
	store.rows[char] = movement.Vec3{X: gx, Y: ps.Floor + 0.2, Z: gz}
	a := h.dial("")
	a.join(h, char, "Skywalker")
	a.pump(300 * time.Millisecond)
	a.send(&proto.Interact{TargetKind: InteractPalace, TargetID: uint64(ps.Index), Action: 1})
	if ev := a.nextEvent(EventPalaceDoor, 3*time.Second); ev.TargetID != uint32(ps.Index) {
		t.Fatalf("door event %+v", ev)
	}
	var lp *livePalace
	h.do(func() {
		lp = h.srv.pal.live[ps.Index]
		if lp == nil {
			t.Fatal("the palace did not wake")
		}
		if len(lp.packs) != len(palace.D.Packs) || lp.phase != PalaceTrial {
			t.Fatalf("awake: %d packs, phase %d", len(lp.packs), lp.phase)
		}
		for _, g := range lp.packs { // the guards would interrupt: clear them
			h.srv.cbt.w.RetireGroup(g)
		}
	})
	strike := func(i int) {
		w := palace.D.Wards[i]
		wx, wz := ps.World(w.X, w.Z)
		h.do(func() {
			h.srv.Teleport(h.srv.byChar[char].ent, movement.Vec3{X: wx + 0.5, Y: ps.Floor + w.Y + 0.05, Z: wz + 0.5})
		})
		a.pump(150 * time.Millisecond)
		a.send(&proto.Interact{TargetKind: InteractPalacePart, TargetID: uint64(ps.Index)<<4 | uint64(i+1), Action: 1})
		a.pump(250 * time.Millisecond)
	}
	// Out of reach: nothing.
	a.send(&proto.Interact{TargetKind: InteractPalacePart, TargetID: uint64(ps.Index)<<4 | 1, Action: 1})
	a.pump(200 * time.Millisecond)
	h.do(func() {
		if wardCount(lp) != 0 {
			t.Fatal("a ward was struck from afar")
		}
	})
	strike(0)
	strike(1)
	h.do(func() {
		if wardCount(lp) != 2 || lp.phase != PalaceTrial || lp.boss != nil {
			t.Fatalf("two wards: %d, phase %d", wardCount(lp), lp.phase)
		}
	})
	strike(2)
	h.do(func() {
		if lp.phase != PalaceBoss || lp.boss == nil || lp.boss.Boss != palace.D.Boss || lp.boss.Layer != int(vertical.LayerSky) {
			t.Fatalf("three wards: phase %d boss %+v", lp.phase, lp.boss)
		}
	})
	// The chest is sealed while the guardian stands.
	cx, cz := ps.World(palace.D.Chest.X, palace.D.Chest.Z)
	h.do(func() {
		h.srv.Teleport(h.srv.byChar[char].ent, movement.Vec3{X: cx + 0.5, Y: ps.Floor + palace.D.Chest.Y + 0.05, Z: cz + 0.5})
	})
	a.pump(150 * time.Millisecond)
	a.send(&proto.Interact{TargetKind: InteractPalacePart, TargetID: uint64(ps.Index)<<4 | 4, Action: 1})
	noteWith := func(v int32) *proto.Event {
		for i := 0; i < 8; i++ {
			if ev := a.take(EventPalaceNote, 3*time.Second); ev.Value == v {
				return ev
			}
		}
		t.Fatalf("no palace note %d", v)
		return nil
	}
	noteWith(4)
	// The guardian falls: the palace is cleared; the chest pays once.
	h.do(func() { h.srv.cbt.w.RetireGroup(lp.boss) })
	var note *proto.Event
	for i := 0; i < 10 && note == nil; i++ {
		a.pump(200 * time.Millisecond)
		h.do(func() {
			if lp.phase == PalaceCleared {
				note = &proto.Event{}
			}
		})
	}
	if note == nil {
		t.Fatal("the palace was not cleared")
	}
	a.send(&proto.Interact{TargetKind: InteractPalacePart, TargetID: uint64(ps.Index)<<4 | 4, Action: 1})
	noteWith(5)
	a.send(&proto.Interact{TargetKind: InteractPalacePart, TargetID: uint64(ps.Index)<<4 | 4, Action: 1})
	noteWith(4)
	// Nobody near for resetS: it sleeps again.
	h.do(func() {
		h.srv.Teleport(h.srv.byChar[char].ent, movement.Vec3{X: gx, Y: ps.Floor + 600, Z: gz})
		lp.lastNear = h.srv.tick - uint32(palace.D.ResetS*constants.TickRateHz) - 1
	})
	a.pump(1200 * time.Millisecond)
	h.do(func() {
		if h.srv.pal.live[ps.Index] != nil {
			t.Fatal("the abandoned palace stayed awake")
		}
	})
}
