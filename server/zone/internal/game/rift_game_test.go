package game

// CR 040 rift runs in process on the official world: a dev rift, a run's
// first rooms over the wire (the arena ground with no corrections, volleys,
// a cleared room's reward and door, the next room), the instance (a player
// outside never sees the run, the run never sees the world), a real kill
// through combat, a disconnect saved at the portal, the schedule.

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"testing"
	"time"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/rift"
)

func riftArg(sub, chapter, stage int) uint32 { return uint32(sub | chapter<<4 | stage<<8) }

func TestRiftRunOverTheWire(t *testing.T) {
	h := devHarness(t)
	var sx, sz float64
	h.do(func() {
		st := &h.srv.cfg.Towns.T.Settlements[0]
		sx, sz = st.X+st.Radius+40, st.Z
	})
	store := h.srv.cfg.Store.(*mountStore).fakeStore
	store.mu.Lock()
	store.rows["rift-a"] = movement.Vec3{X: sx, Z: sz}
	store.mu.Unlock()
	a := h.dial(spawnAt(sx, sz))
	wa := a.join(h, "rift-a", "Ayla")
	b := h.dial(spawnAt(sx+6, sz))
	b.join(h, "rift-b", "Bram")
	a.drainFor(300 * time.Millisecond)
	b.drainFor(100 * time.Millisecond)

	a.devOK(t, DevActRift, 0, riftArg(DevRiftGo, 1, 1))
	st := a.evOf(EventRiftStage, 3*time.Second)
	var stage struct {
		Run, Chapter, Stage, Kind int
		OX                        int32 `json:"ox"`
		OY                        int32 `json:"oy"`
		OZ                        int32 `json:"oz"`
		Name                      string `json:"chapterName"`
	}
	if err := json.Unmarshal(st.Data, &stage); err != nil || stage.Chapter != 1 || stage.Stage != 1 || stage.Name != "Emberglass Steps" {
		t.Fatalf("stage %s", st.Data)
	}
	o := movement.Vec3{X: proto.CmToMeters(stage.OX), Y: proto.CmToMeters(stage.OY), Z: proto.CmToMeters(stage.OZ)}
	if o.Y < RiftBaseY {
		t.Fatalf("arena floor %v", o.Y)
	}
	a.evOf(EventTeleport, 2*time.Second)
	a.drainFor(300 * time.Millisecond)

	// The arena ground: walk north toward the door; the zone agrees to the cm.
	l := rift.StageLayout(1, 1)
	g := &riftGround{inner: h.srv.cfg.Ground, o: o, l: &l}
	self := a.ackedSelf(t)
	sim := movement.NewState(movement.Vec3{X: proto.CmToMeters(self.X), Y: proto.CmToMeters(self.Y), Z: proto.CmToMeters(self.Z)})
	h.do(func() { sim = h.srv.entityByID(wa.EntityID).Move })
	a.walkOn(60, proto.InputFlagForward, 0, &sim, g)
	got := a.ackedSelf(t)
	if math.Abs(proto.CmToMeters(got.Z)-sim.Pos.Z) > 0.02 || math.Abs(proto.CmToMeters(got.Y)-o.Y) > 0.05 {
		t.Fatalf("zone %v,%v vs predicted %v,%v (floor %v)", proto.CmToMeters(got.Z), proto.CmToMeters(got.Y), sim.Pos.Z, sim.Pos.Y, o.Y)
	}
	if proto.CmToMeters(got.Z)-o.Z > rift.StartZ-2 {
		t.Fatalf("did not walk: z %v", proto.CmToMeters(got.Z)-o.Z)
	}

	// The room fires telegraphed volleys at us.
	v := a.evOf(EventRiftVolley, 6*time.Second)
	if len(v.Data) < 36 || v.Data[0] < rift.KindRing || v.Data[0] > rift.KindRain || binary.LittleEndian.Uint16(v.Data[5:]) < 450 {
		t.Fatalf("volley % x", v.Data)
	}

	// The instance: A sees its room's enemies, B (outside) sees neither A nor them.
	var foes []uint32
	h.do(func() {
		rr := h.srv.rift.byPlayer[wa.EntityID]
		for id := range rr.enemies {
			foes = append(foes, id)
		}
	})
	if len(foes) == 0 {
		t.Fatal("no enemies in the room")
	}
	a.drainFor(500 * time.Millisecond)
	b.drainFor(500 * time.Millisecond)
	if !a.sees(foes[0]) {
		t.Fatal("A does not see its room's enemy")
	}
	if b.sees(foes[0]) || b.sees(wa.EntityID) {
		t.Fatal("B (outside) sees into the rift")
	}

	// A real kill through combat counts: the run sees the body die.
	h.do(func() {
		rr := h.srv.rift.byPlayer[wa.EntityID]
		for _, en := range rr.enemies {
			h.srv.cbt.w.ApplyDevDamage(en, wa.EntityID, en.HP+1)
			break
		}
	})
	a.drainFor(300 * time.Millisecond)
	h.do(func() {
		rr := h.srv.rift.byPlayer[wa.EntityID]
		alive := 0
		for _, e := range rr.run.Enemies {
			if h.srv.cbt.w.Enemy(e.ID) != nil && h.srv.cbt.w.Enemy(e.ID).Alive() {
				alive++
			}
		}
		if alive != len(foes)-1 {
			t.Errorf("after one kill %d of %d alive", alive, len(foes))
		}
	})

	// Win the room: cleared, the reward, the door; walk through: stage 2.
	a.devOK(t, DevActRift, 0, riftArg(DevRiftWin, 0, 0))
	if c := a.evOf(EventRiftClear, 2*time.Second); c.Value != 1 {
		t.Fatalf("clear %+v", c.ToJSON())
	}
	rw := a.evOf(EventRiftReward, 2*time.Second)
	var reward struct{ Gold, Spoils int }
	_ = json.Unmarshal(rw.Data, &reward)
	if reward.Gold <= 0 || reward.Spoils != reward.Gold {
		t.Fatalf("reward %s", rw.Data)
	}
	a.evOf(EventRiftDoor, 2*time.Second)
	h.do(func() {
		e := h.srv.entityByID(wa.EntityID)
		h.srv.Teleport(e, movement.Vec3{X: o.X, Y: o.Y, Z: o.Z + rift.DoorZ + 0.3})
	})
	if s2 := a.evOf(EventRiftStage, 3*time.Second); s2.Value != 2 {
		t.Fatalf("next room %d", s2.Value)
	}

	// Disconnect inside the rift: saved at the portal, never in the sky.
	var portal riftPortal
	h.do(func() { portal = h.srv.rift.byPlayer[wa.EntityID].portal })
	a.c.Close(1000, "")
	deadline := time.Now().Add(3 * time.Second)
	for {
		var pos movement.Vec3
		var ok bool
		store.mu.Lock()
		pos, ok = store.saves["rift-a"]
		store.mu.Unlock()
		if ok && math.Hypot(pos.X-portal.X, pos.Z-portal.Z) < 6 && pos.Y < 1000 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("saved at %+v (portal %v,%v)", pos, portal.X, portal.Z)
		}
		time.Sleep(50 * time.Millisecond)
	}
	h.do(func() {
		if len(h.srv.rift.runs) != 0 {
			t.Errorf("%d runs left after the last player left", len(h.srv.rift.runs))
		}
	})
}

func TestRiftScheduleOnTheOfficialWorld(t *testing.T) {
	h := devHarness(t)
	h.srv.SetWorldEvents(true)
	h.srv.SetRifts(true)
	var first, again []riftPortal
	h.do(func() {
		h.srv.riftInit()
		h.srv.riftPortalsTick()
		first = h.srv.RiftPortals()
		h.srv.rift.window = -1
		h.srv.rift.portals = nil
		h.srv.riftPortalsTick()
		again = h.srv.RiftPortals()
	})
	if len(first) != rift.ActivePortals || len(again) != len(first) {
		t.Fatalf("portals %d / %d", len(first), len(again))
	}
	for i := range first {
		p, q := first[i], again[i]
		if p.X != q.X || p.Z != q.Z || p.Chapter != q.Chapter {
			t.Fatalf("not deterministic: %+v %+v", p, q)
		}
		var ok bool
		h.do(func() { ok = h.srv.eventSpotOK(p.X, p.Z) })
		if !ok || p.Chapter < 1 || p.Level < 1 {
			t.Fatalf("portal %+v not on open ground", p)
		}
	}
}

func (cl *client) sees(id uint32) bool {
	if cl.frame == nil {
		return false
	}
	for _, e := range cl.frame.Ents {
		if e.ID == id {
			return true
		}
	}
	return false
}

// evOf takes the first recorded Event of kind (pumping until it comes).
func (cl *client) evOf(kind uint16, timeout time.Duration) *proto.Event {
	cl.t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		for i, e := range cl.evs {
			if e.Kind == kind {
				cl.evs = append(cl.evs[:i:i], cl.evs[i+1:]...)
				return e
			}
		}
		if time.Now().After(deadline) {
			cl.t.Fatalf("timeout waiting for event %d", kind)
		}
		cl.pump(40 * time.Millisecond)
	}
}
