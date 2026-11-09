package game

// Building doors in-process on the official world (real wasm towns layer):
// a player closes the inn's door, walks into it (blocked), opens it, walks
// in, closes it behind them from inside, pushes against it (blocked), and a
// second player trying to close it on them while they stand in the doorway
// is refused; both players get every change (970) and a late joiner gets
// the baseline (971). The "client" predicts on the same ground with the
// doors stamped exactly as the events say, frame by frame, and must equal
// the server to the centimetre.

import (
	"encoding/binary"
	"math"
	"testing"
	"time"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/towns"
)

// predDoors is the client's door model (client/src/world/buildings/doors.ts).
type predDoors struct {
	was, to []bool
	at      []uint32
	seq     uint32
}

func newPredDoors(n int) *predDoors {
	p := &predDoors{was: make([]bool, n), to: make([]bool, n), at: make([]uint32, n)}
	for i := range p.was {
		p.was[i], p.to[i] = true, true
	}
	return p
}

func (p *predDoors) DoorClosed(d int) bool {
	if p.at[d] != 0 && p.seq >= p.at[d] {
		return !p.to[d]
	}
	return !p.was[d]
}

func (p *predDoors) apply(ds *towns.Doors, ev *proto.Event) {
	d := ds.ByPropIdx[int(ev.TargetID)]
	step := binary.LittleEndian.Uint32(ev.Data[8:12])
	if p.at[d] != 0 {
		p.was[d] = p.to[d]
	}
	p.to[d], p.at[d] = ev.Value == 1, step
}

type predGround struct {
	inner movement.Ground
	s     *towns.Doors
	v     towns.DoorView
}

func (g predGround) HeightAt(x, z float64) float64 { return g.inner.HeightAt(x, z) }
func (g predGround) WaterAt(x, z float64) float64  { return movement.WaterAt(g.inner, x, z) }
func (g predGround) AtLevel(y float64) movement.Ground {
	return towns.WithDoors(movement.AtLevel(g.inner, y), g.s, g.v)
}

// walkDoors is walk() predicting on the door ground, keeping Events.
func (cl *client) walkDoors(n int, flags uint16, yaw float64, sim *movement.State, g predGround, pd *predDoors) {
	var prev *proto.InputFrame
	for i := 0; i < n; i += 2 {
		var frames []proto.InputFrame
		if prev != nil {
			frames = append(frames, *prev)
		}
		for k := 0; k < 2 && i+k < n; k++ {
			cl.seq++
			f := proto.InputFrame{Seq: cl.seq, Flags: flags, Yaw: proto.YawToU16(yaw)}
			frames = append(frames, f)
			pd.seq = f.Seq
			*sim = movement.StepFrame(*sim, f, g)
			prev = &frames[len(frames)-1]
		}
		cl.send(&proto.Input{AckTick: cl.dec.Latest(), Frames: frames})
		cl.keep(33 * time.Millisecond)
	}
}

// doorEvent waits for a door_state (970), failing on a refusal (972).
func (cl *client) doorEvent(t *testing.T) *proto.Event {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		cl.keep(20 * time.Millisecond)
		backlogMu.Lock()
		for i, ev := range backlog[cl] {
			if ev.Kind == EventDoorState || ev.Kind == EventDoorRefuse {
				backlog[cl] = append(backlog[cl][:i:i], backlog[cl][i+1:]...)
				backlogMu.Unlock()
				if ev.Kind == EventDoorRefuse {
					t.Fatalf("door refused: reason %d", ev.Value)
				}
				return ev
			}
		}
		backlogMu.Unlock()
	}
	t.Fatal("no door event")
	return nil
}

func (cl *client) ackedSelf(t *testing.T) proto.SelfState {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for cl.snap == nil || cl.snap.AckInputSeq != cl.seq {
		if time.Now().After(deadline) {
			t.Fatalf("never acked seq %d", cl.seq)
		}
		cl.keep(20 * time.Millisecond)
	}
	return cl.frame.Self
}

func sameCm(t *testing.T, what string, self proto.SelfState, sim movement.State) {
	t.Helper()
	if self.X != proto.MetersToCm(sim.Pos.X) || self.Y != proto.MetersToCm(sim.Pos.Y) || self.Z != proto.MetersToCm(sim.Pos.Z) {
		t.Fatalf("%s: server (%d, %d, %d) cm vs predicted (%.3f, %.3f, %.3f)", what, self.X, self.Y, self.Z, sim.Pos.X, sim.Pos.Y, sim.Pos.Z)
	}
}

func TestDoorsOpenCloseWalkThroughAndRefuse(t *testing.T) {
	w, g := testTowns(t)
	h := newHarness(t, func(c *Config) {
		c.Ground = g
		c.Towns = w
		c.TimeOffsetS = offsetFor(12)
	})
	ds := towns.NewDoors(w.T)
	si := spawnSettlement(t, w)
	inn := -1
	for b := w.T.Settlements[si].BuildingFirst; b < w.T.Settlements[si].BuildingFirst+w.T.Settlements[si].Buildings; b++ {
		if w.T.Buildings[b].Role == towns.BuildingInn {
			inn = b
		}
	}
	d, ok := ds.ByBuilding[inn]
	if !ok {
		t.Fatal("the spawn settlement's inn has no door")
	}
	dr := ds.D[d]
	b := w.T.Buildings[inn]
	vx, vz := -b.S, b.C // inward
	in := math.Atan2(-vx, -vz)
	out := math.Atan2(vx, vz)
	vOf := func(p movement.Vec3) float64 { return (p.X-dr.X)*vx + (p.Z-dr.Z)*vz } // along v from the door's mid-plane
	half := dr.Thick / 2

	// A: 2.6 m outside the door (porch included), facing it. B: beside A.
	ax, az := dr.X-2.6*vx, dr.Z-2.6*vz
	if b.Flags&1 != 0 {
		ax, az = dr.X-4.4*vx, dr.Z-4.4*vz
	}
	ax, az = math.Round(ax*100)/100, math.Round(az*100)/100
	a := h.dial(spawnAt(ax, az))
	a.join(h, "door-a", "Doorman")
	bx, bz := ax+1.5*b.C, az+1.5*b.S
	bx, bz = math.Round(bx*100)/100, math.Round(bz*100)/100
	bc := h.dial(spawnAt(bx, bz))
	bc.join(h, "door-b", "Neighbour")
	pd := newPredDoors(ds.Len())
	pg := predGround{inner: g, s: ds, v: pd}
	y0 := g.HeightAt(ax, az)
	sim := movement.NewState(movement.Vec3{X: ax, Y: movement.GroundAt(g, ax, y0, az), Z: az})
	a.walkDoors(10, 0, in, &sim, pg, pd) // settle
	sameCm(t, "spawn", a.ackedSelf(t), sim)

	// 1. Close the door (from the street).
	a.interact(InteractDoor, dr.ID, DoorActClose, 0)
	ev := a.doorEvent(t)
	if ev.Value != 0 || ev.TargetID != uint32(dr.Prop) || ev.EntityID == 0 {
		t.Fatalf("close event %+v", ev)
	}
	stamp := binary.LittleEndian.Uint32(ev.Data[8:12])
	if stamp <= a.seq {
		t.Fatalf("stamp %d not ahead of the client's seq %d", stamp, a.seq)
	}
	pd.apply(ds, ev)
	if evB := bc.nextEvent(EventDoorState, 2*time.Second); evB.Value != 0 || evB.TargetID != uint32(dr.Prop) {
		t.Fatalf("B's close event %+v", evB)
	}
	bc.stepWalk(80, 0, 0)
	// 2. Walk into it: stopped outside.
	a.walkDoors(150, proto.InputFlagForward, in, &sim, pg, pd)
	self := a.ackedSelf(t)
	sameCm(t, "against the closed door", self, sim)
	if v := vOf(sim.Pos); v > -half-0.39 {
		t.Fatalf("walked through a closed door: v %.3f (outer face %.3f)", v, -half)
	}
	var open bool
	_ = h.srv.Do(t.Context(), func() { open, _ = h.srv.DoorOpen(d) })
	if open {
		t.Fatal("door still open on the server")
	}

	// 3. Open it and walk in.
	a.interact(InteractDoor, dr.ID, DoorActOpen, 0)
	ev = a.doorEvent(t)
	if ev.Value != 1 {
		t.Fatalf("open event %+v", ev)
	}
	pd.apply(ds, ev)
	bc.nextEvent(EventDoorState, 2*time.Second)
	bc.stepWalk(80, 0, 0) // B idles: its stamp passes, the change settles
	for k := 0; k < 200 && vOf(sim.Pos) < half+1.3; k += 2 {
		a.walkDoors(2, proto.InputFlagForward, in, &sim, pg, pd)
	}
	sameCm(t, "inside", a.ackedSelf(t), sim)
	if vOf(sim.Pos) < half+1.3 {
		t.Fatalf("never got inside: v %.3f", vOf(sim.Pos))
	}

	// 4. Close it behind us from inside, push against it.
	a.walkDoors(20, 0, out, &sim, pg, pd)
	a.interact(InteractDoor, dr.ID, DoorActClose, 0)
	ev = a.doorEvent(t)
	if ev.Value != 0 {
		t.Fatalf("close-from-inside event %+v", ev)
	}
	pd.apply(ds, ev)
	bc.nextEvent(EventDoorState, 2*time.Second)
	bc.stepWalk(80, 0, 0) // B idles: its stamp passes, the change settles
	a.walkDoors(120, proto.InputFlagForward, out, &sim, pg, pd)
	sameCm(t, "pushing against the closed door from inside", a.ackedSelf(t), sim)
	if v := vOf(sim.Pos); v < half+0.39 {
		t.Fatalf("pushed through a closed door from inside: v %.3f", v)
	}

	// 5. Open, step into the doorway; B can't close it on A.
	a.interact(InteractDoor, dr.ID, DoorActOpen, 0)
	ev = a.doorEvent(t)
	pd.apply(ds, ev)
	bc.nextEvent(EventDoorState, 2*time.Second)
	bc.stepWalk(80, 0, 0) // B idles: its stamp passes, the change settles
	for k := 0; k < 120 && vOf(sim.Pos) > 0.05; k += 2 {
		a.walkDoors(2, proto.InputFlagForward, out, &sim, pg, pd)
	}
	a.walkDoors(10, 0, out, &sim, pg, pd)
	sameCm(t, "in the doorway", a.ackedSelf(t), sim)
	// B (beside the door, in reach) tries to close it on A.
	bc.interact(InteractDoor, dr.ID, DoorActClose, 0)
	ref := bc.nextEvent(EventDoorRefuse, 2*time.Second)
	if ref.Value != DoorRefuseBody {
		t.Fatalf("B closing on A: refusal %d, want %d (someone in the doorway)", ref.Value, DoorRefuseBody)
	}
	// Opening an open door: already.
	bc.interact(InteractDoor, dr.ID, DoorActOpen, 0)
	if ref := bc.nextEvent(EventDoorRefuse, 2*time.Second); ref.Value != DoorRefuseAlready {
		t.Fatalf("refusal %d, want already", ref.Value)
	}

	// 6. Walk out; then close it from the street and let a late joiner see it.
	for k := 0; k < 200 && vOf(sim.Pos) > -half-1.4; k += 2 {
		a.walkDoors(2, proto.InputFlagForward, out, &sim, pg, pd)
	}
	a.walkDoors(20, 0, in, &sim, pg, pd)
	sameCm(t, "out again", a.ackedSelf(t), sim)
	a.interact(InteractDoor, dr.ID, DoorActClose, 0)
	ev = a.doorEvent(t)
	pd.apply(ds, ev)
	a.walkDoors(40, 0, out, &sim, pg, pd)
	c := h.dial(spawnAt(bx+2*b.C, bz+2*b.S))
	c.join(h, "door-c", "Latecomer")
	base := c.nextEvent(EventDoorBase, 3*time.Second)
	if base.TargetID != uint32(si) || len(base.Data) < 3 || base.Data[0] != 1 {
		t.Fatalf("baseline %+v", base)
	}
	n := int(binary.LittleEndian.Uint16(base.Data[1:3]))
	found := false
	for k := 0; k < n; k++ {
		o := 3 + k*10
		if binary.LittleEndian.Uint32(base.Data[o:]) == uint32(dr.Prop) && base.Data[o+5] == 0 {
			found = true
		}
	}
	if !found {
		t.Fatalf("baseline of %d doors lacks the closed inn door", n)
	}
	if v := h.srv.m.speedViolations.Load(); v != 0 {
		t.Fatalf("%d validation rejections", v)
	}
	// Unknown and far doors.
	far := (d + ds.Len()/2) % ds.Len()
	a.interact(InteractDoor, ds.D[far].ID, DoorActOpen, 0)
	if ref := a.nextEvent(EventDoorRefuse, 2*time.Second); ref.Value != DoorRefuseTooFar && ref.Value != DoorRefuseAlready {
		t.Fatalf("far door refusal %d", ref.Value)
	}
	a.interact(InteractDoor, 12345, DoorActOpen, 0)
	if ref := a.nextEvent(EventDoorRefuse, 2*time.Second); ref.Value != DoorRefuseUnknown {
		t.Fatalf("unknown door refusal %d", ref.Value)
	}
}

// NPCs leaving home for work through a door someone closed open it, walk
// through and close it behind them.
func TestDoorsNPCOpensAndClosesBehind(t *testing.T) {
	w, g := testTowns(t)
	h := newHarness(t, func(c *Config) {
		c.Ground = g
		c.Towns = w
		c.TimeOffsetS = offsetFor(6.99) // workers leave home at 07:00, in ~1.5 s
	})
	si := spawnSettlement(t, w)
	st := w.T.Settlements[si]
	a := h.dial(spawnAt(math.Round(st.X*100)/100, math.Round(st.Z*100)/100))
	a.join(h, "door-npc", "Watcher")
	for k := 0; k < 30 && !a.seesKind(proto.EntityKindNpc); k++ {
		a.pump(100 * time.Millisecond)
	}
	// Close every door of the settlement through the server (the test's
	// hand on the latch), then watch the townsfolk walk home through them.
	var ds *towns.Doors
	_ = h.srv.Do(t.Context(), func() {
		ds = h.srv.Doors()
		for _, d := range ds.D {
			if d.Settlement == si {
				h.srv.doorSchedule(d.Index, false, 0)
			}
		}
	})
	opened, closed := map[uint32]int{}, map[uint32]int{}
	deadline := time.Now().Add(40 * time.Second)
	for time.Now().Before(deadline) {
		a.stepWalk(12, 0, 0) // idle frames: the stamped changes settle
		backlogMu.Lock()
		evs := backlog[a]
		backlog[a] = nil
		backlogMu.Unlock()
		for _, ev := range evs {
			if ev.Kind != EventDoorState || ev.EntityID == 0 {
				continue
			}
			if ev.Value == 1 {
				opened[ev.TargetID]++
			} else {
				closed[ev.TargetID]++
			}
		}
		both := 0
		for p := range opened {
			if closed[p] > 0 {
				both++
			}
		}
		if both >= 2 {
			break
		}
	}
	both := 0
	for p := range opened {
		if closed[p] > 0 {
			both++
		}
	}
	t.Logf("NPCs opened %d doors and closed %d behind them", len(opened), both)
	if len(opened) == 0 || both == 0 {
		t.Fatalf("no NPC opened and closed a door (opened %v closed %v)", opened, closed)
	}
}
