package game

// Mounts (CR 027) in-process on the official world: no whistle, no steed;
// the whistle bonds and calls it (persisted); others hear about it; mounting
// out of reach is refused; riding is the shared step (the client's
// prediction and the zone agree, gallop speeds pass validation only in the
// saddle, no dodges or melee from the saddle); others see the riding bit;
// E gets off and the steed stands; hits and demons at night throw the
// rider (a spook bolts the steed and starts the cooldown); a fast travel
// leaves the steed behind; name and colour persist through a restart.

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"sync"
	"testing"
	"time"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/writebehind"
	"lodestone/server/zone/internal/chem"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/night"
)

// mountStore is the character store plus character_mounts in memory.
type mountStore struct {
	*fakeStore
	mu     sync.Mutex
	steeds map[string][]SteedRec
}

func (m *mountStore) LoadMounts(_ context.Context, id string) ([]SteedRec, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]SteedRec(nil), m.steeds[id]...), nil
}

func (m *mountStore) SaveMounts(_ context.Context, id string, s []SteedRec, _ int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.steeds[id] = append([]SteedRec(nil), s...)
	return nil
}

func (m *mountStore) get(id string) []SteedRec {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]SteedRec(nil), m.steeds[id]...)
}

type mountRig struct {
	*harness
	store *mountStore
}

func mountHarness(t *testing.T, store *mountStore, hour float64) *mountRig {
	t.Helper()
	w, g := testTowns(t)
	ex := realExplore(t, g)
	if store == nil {
		store = &mountStore{fakeStore: &fakeStore{saves: map[string]movement.Vec3{}, rows: map[string]movement.Vec3{}}, steeds: map[string][]SteedRec{}}
	}
	q := writebehind.New(100)
	q.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	qctx, stopQ := context.WithCancel(context.Background())
	t.Cleanup(stopQ)
	go q.Run(qctx)
	h := newHarness(t, func(c *Config) {
		c.Ground = g
		c.Towns = w
		c.Explore = ex
		c.Store = store
		c.Queue = q
		c.TimeOffsetS = offsetFor(hour)
		c.Night = &NightSetup{World: &night.World{Seed: 42, Intensity: 0.5}, Overlay: &chem.Overlay{}, WindDeg: 270, Dev: true, NoDemons: true, Force: -1}
		c.Combat = &CombatSetup{Dev: true, Config: combat.Config{Seed: 42, NoWildPacks: true}}
	})
	h.srv.SetWorldEvents(false)
	return &mountRig{harness: h, store: store}
}

// flatSpot: open, gentle, dry ground outside every settlement (room to gallop east).
func (r *mountRig) flatSpot(t *testing.T) (float64, float64) {
	t.Helper()
	var x, z float64
	found := false
	r.do(func() {
		s := r.srv
		for si := range s.cfg.Towns.T.Settlements {
			st := &s.cfg.Towns.T.Settlements[si]
			for k := 0; k < 36 && !found; k++ {
				a := float64(k) / 36 * 2 * math.Pi
				cx, cz := st.X+math.Cos(a)*(st.Radius+60), st.Z+math.Sin(a)*(st.Radius+60)
				ok := true
				for d := -6.0; d <= 60 && ok; d += 2 {
					ok = s.steedSpotOK(cx+d, cz) && movement.SlopeAt(s.cfg.Ground, cx+d, cz).T2 < 0.05 && s.steedSpotOK(cx+d, cz+3) && s.steedSpotOK(cx+d, cz-3)
				}
				if ok {
					x, z, found = cx, cz, true
				}
			}
			if found {
				break
			}
		}
	})
	if !found {
		t.Fatal("no flat open ground on the official world")
	}
	return x, z
}

func (r *mountRig) join(t *testing.T, char, name string, x, z float64) *client {
	t.Helper()
	r.store.rows[char] = movement.Vec3{X: x, Y: r.srv.cfg.Ground.HeightAt(x, z), Z: z}
	c := r.dial("")
	c.join(r.harness, char, name)
	c.take(EventSteedSync, 3*time.Second)
	return c
}

// ride sends n frames (predicting them) and keeps Events.
func (cl *client) ride(n int, flags uint16, yaw float64, sim *movement.State, g movement.Ground) {
	var prev *proto.InputFrame
	for i := 0; i < n; i += 2 {
		var frames []proto.InputFrame
		if prev != nil {
			frames = append(frames, *prev)
		}
		for k := 0; k < 2 && i+k < n; k++ {
			cl.seq++
			f := proto.InputFrame{Seq: cl.seq, Flags: flags, Yaw: proto.YawToU16(yaw)}
			if k > 0 || i > 0 {
				f.Flags &^= proto.InputFlagJumpEdge
			}
			frames = append(frames, f)
			if sim != nil {
				*sim = movement.StepFrame(*sim, f, g)
			}
			prev = &frames[len(frames)-1]
		}
		cl.send(&proto.Input{AckTick: cl.dec.Latest(), Frames: frames})
		cl.pump(33 * time.Millisecond)
	}
}

func (cl *client) ackedState(t *testing.T) proto.SelfState {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for cl.snap == nil || cl.snap.AckInputSeq != cl.seq {
		if time.Now().After(deadline) {
			t.Fatalf("never acked seq %d", cl.seq)
		}
		cl.pump(20 * time.Millisecond)
	}
	return cl.frame.Self
}

func steedState(t *testing.T, e *proto.Event) steedStateJSON {
	t.Helper()
	var j steedStateJSON
	if err := json.Unmarshal(e.Data, &j); err != nil {
		t.Fatal(err)
	}
	return j
}

// steedFor waits for a 1141 about owner with phase p.
func (cl *client) steedFor(t *testing.T, owner uint32, p int) steedStateJSON {
	t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	for {
		for i, e := range cl.evs {
			if e.Kind == EventSteedState && e.EntityID == owner && int(e.Value) == p {
				cl.evs = append(cl.evs[:i:i], cl.evs[i+1:]...)
				return steedState(t, e)
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("no steed phase %d for %d", p, owner)
		}
		cl.pump(40 * time.Millisecond)
	}
}

func (cl *client) steedRefused(t *testing.T, want int) {
	t.Helper()
	if e := cl.take(EventSteedRefused, 3*time.Second); int(e.Value) != want {
		t.Fatalf("refusal %d, want %d", e.Value, want)
	}
}

func TestSteedLifecycleRidingAndValidation(t *testing.T) {
	r := mountHarness(t, nil, 12)
	x, z := r.flatSpot(t)
	const A, B = "c0000000-0000-0000-0000-0000000000a1", "c0000000-0000-0000-0000-0000000000b1"
	a := r.join(t, A, "Ash", x, z)
	b := r.join(t, B, "Birch", x-8, z+6)
	aid := a.welc.EntityID

	// No whistle: nothing to call.
	a.interact(InteractSteed, 0, SteedActSummon, 0)
	a.steedRefused(t, SteedRefuseNoSteed)

	// A whistle bonds the steed (persisted) and calls it; B hears it arrive.
	addItems(t, r.harness, A, steedWhistle, 1)
	a.interact(InteractSteed, 0, SteedActSummon, 0)
	arr := a.steedFor(t, aid, SteedArriving)
	if arr.Name != steedDefaultName || arr.Ms <= 0 || math.Hypot(arr.FX-arr.X, arr.FZ-arr.Z) < 10 {
		t.Fatalf("arrival %+v (want a gallop in from afar)", arr)
	}
	b.steedFor(t, aid, SteedArriving)
	deadline := time.Now().Add(3 * time.Second)
	for len(r.store.get(A)) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("bonded steed never saved")
		}
		time.Sleep(20 * time.Millisecond)
	}

	// Too far to mount; then beside it, mount (the zone sets the flag).
	r.teleport(A, arr.X+8, arr.Z)
	a.pump(100 * time.Millisecond)
	a.interact(InteractSteed, 0, SteedActMount, 0)
	a.steedRefused(t, SteedRefuseFar)
	r.teleport(A, arr.X+1.5, arr.Z)
	a.ride(10, 0, 0, nil, nil) // land (the teleport puts you 5 cm up)
	a.steedFor(t, aid, SteedStanding)
	a.interact(InteractSteed, 0, SteedActMount, 0)
	a.steedFor(t, aid, SteedRidden)
	self := a.ackedState(t)
	if self.Flags&movement.FlagMounted == 0 {
		t.Fatalf("SelfState flags %b: not mounted", self.Flags)
	}
	sim := movement.FromSelf(self)
	sim.Pos.Y = movement.GroundAt(r.srv.cfg.Ground, sim.Pos.X, sim.Pos.Y, sim.Pos.Z)

	// Gallop east: predicted == authoritative, no violations, faster than any sprint.
	var before int64
	r.do(func() { before = r.srv.m.speedViolations.Load() })
	east := -math.Pi / 2
	g := r.srv.cfg.Ground
	a.ride(30, proto.InputFlagForward, east, &sim, g)
	a.ride(1, proto.InputFlagForward|proto.InputFlagSprint, east, &sim, g)
	a.ride(1, proto.InputFlagForward, east, &sim, g)
	a.ride(1, proto.InputFlagForward|proto.InputFlagSprint, east, &sim, g) // a second spur: the burst
	a.ride(20, proto.InputFlagForward, east, &sim, g)
	a.ride(1, proto.InputFlagForward|proto.InputFlagDodge, east, &sim, g) // dodging in the saddle: stripped (the step ignores it too)
	a.ride(40, proto.InputFlagForward, east, &sim, g)
	self = a.ackedState(t)
	got := movement.FromSelf(self)
	if d := math.Hypot(got.Pos.X-sim.Pos.X, got.Pos.Z-sim.Pos.Z); d > 0.02 {
		t.Fatalf("zone %+v vs predicted %+v (%.3f m)", got.Pos, sim.Pos, d)
	}
	if sp := movement.HorizontalSpeed(got); sp < constants.RideGallopSpeed-0.1 || got.Dash != 0 {
		t.Fatalf("not galloping: %.2f m/s dash %d", sp, got.Dash)
	}
	var after int64
	r.do(func() { after = r.srv.m.speedViolations.Load() })
	if after != before {
		t.Fatalf("%d speed violations while riding", after-before)
	}
	// B sees A riding (typeId bit 14).
	deadline = time.Now().Add(3 * time.Second)
	for {
		b.pump(40 * time.Millisecond)
		if b.frame != nil {
			if e := b.frame.Find(aid); e != nil && e.TypeID&TypeRiding != 0 {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("B never saw A riding")
		}
	}

	// The same gallop without the flag is a violation (anti speed hack).
	r.do(func() {
		e := r.srv.byChar[A].ent
		forged := movement.Dismount(e.Move)
		next := forged
		next.Pos.X += 15 * movement.Dt
		next.Vel = movement.Vec3{X: 15}
		forged.Vel = movement.Vec3{X: 2}
		if horizontalOK(forged, next) {
			t.Error("a 15 m/s ground step on foot passed validation")
		}
		if !horizontalOK(e.Move, e.Move) {
			t.Error("the rider's own state failed validation")
		}
	})

	// A sword can't swing from the saddle; a bow can (the frame keeps its attack).
	r.do(func() {
		e := r.srv.byChar[A].ent
		f := mountedFrame(e, proto.InputFrame{Flags: proto.InputFlagAttack | proto.InputFlagAltAttack | proto.InputFlagDodge, CastSlot: 3})
		w := e.cbt.Weapon()
		melee := w != nil && (w.Key == "sword" || w.Key == "spear")
		if f.Flags&proto.InputFlagDodge != 0 || (melee && f.Flags&proto.InputFlagAttack != 0) || (!melee && f.Flags&proto.InputFlagAttack == 0) {
			t.Errorf("mounted frame %+v with %v", f, w)
		}
	})

	// E: off, the steed stands beside; B sees the bit go.
	a.interact(InteractSteed, 0, SteedActDismount, 0)
	st := a.steedFor(t, aid, SteedStanding)
	a.take(EventSteedThrown, 3*time.Second)
	self = a.ackedState(t)
	a.ride(2, 0, east, nil, nil)
	self = a.ackedState(t)
	if self.Flags&movement.FlagMounted != 0 {
		t.Fatal("still mounted after E")
	}
	if p := movement.FromSelf(self).Pos; math.Hypot(p.X-st.X, p.Z-st.Z) > 3 {
		t.Fatalf("steed stands %.1f m away", math.Hypot(p.X-st.X, p.Z-st.Z))
	}
	deadline = time.Now().Add(3 * time.Second)
	for {
		b.pump(40 * time.Millisecond)
		if e := b.frame.Find(aid); e != nil && e.TypeID&TypeRiding == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("B still sees A riding")
		}
	}

	// Hits throw a rider sooner or later (STEED_HIT_DISMOUNT_CHANCE each).
	a.interact(InteractSteed, 0, SteedActMount, 0)
	a.steedFor(t, aid, SteedRidden)
	thrown := false
	for i := 0; i < 60 && !thrown; i++ {
		r.do(func() {
			e := r.srv.byChar[A].ent
			e.Health -= 1
			r.srv.riderTick(r.srv.byChar[A], 1, r.srv.cfg.Now(), false)
			thrown = !movement.Mounted(e.Move)
		})
	}
	if !thrown {
		t.Fatal("60 hits never threw the rider")
	}
	if e := a.take(EventSteedThrown, 3*time.Second); e.Value != ThrownHit {
		t.Fatalf("thrown cause %d", e.Value)
	}

	// A fast travel while riding leaves the steed behind (it fades).
	a.interact(InteractSteed, 0, SteedActMount, 0)
	a.steedFor(t, aid, SteedRidden)
	r.teleport(A, x+300, z)
	a.steedFor(t, aid, SteedGone)
}

func TestSteedSpookedByDemonsAtNight(t *testing.T) {
	r := mountHarness(t, nil, 23)
	x, z := r.flatSpot(t)
	const A = "c0000000-0000-0000-0000-0000000000a2"
	a := r.join(t, A, "Wren", x, z)
	aid := a.welc.EntityID
	addItems(t, r.harness, A, steedWhistle, 1)
	a.interact(InteractSteed, 0, SteedActSummon, 0)
	arr := a.steedFor(t, aid, SteedArriving)
	r.teleport(A, arr.X+1, arr.Z)
	a.ride(10, 0, 0, nil, nil)
	a.pump(100 * time.Millisecond)
	a.interact(InteractSteed, 0, SteedActMount, 0)
	a.steedFor(t, aid, SteedRidden)
	// A demon 6 m away (a stand-in entity: the spook check only reads demons near you).
	spooked := false
	r.do(func() {
		s := r.srv
		e := s.byChar[A].ent
		if s.demonNear(e.Move.Pos, constants.SteedSpookRadiusM) {
			t.Fatal("a demon before there is one")
		}
		d := &Entity{ID: 9_000_001, Kind: proto.EntityKindEnemy, npc: &combat.Enemy{Demon: &combat.DemonState{Rank: "lesser"}, State: combat.Idle, Pos: movement.Vec3{X: e.Move.Pos.X + 6, Y: e.Move.Pos.Y, Z: e.Move.Pos.Z}}}
		s.insertEntity(d)
		defer s.removeEntity(d)
		for tick := uint32(0); tick < 30*120 && !spooked; tick += steedSpookEvery {
			s.riderTick(s.byChar[A], tick-e.ID%steedSpookEvery+steedSpookEvery, s.cfg.Now(), true)
			spooked = !movement.Mounted(e.Move)
		}
	})
	if !spooked {
		t.Fatal("two minutes beside a demon at night and the steed never shied")
	}
	if e := a.take(EventSteedThrown, 3*time.Second); e.Value != ThrownSpook {
		t.Fatalf("thrown cause %d", e.Value)
	}
	a.steedFor(t, aid, SteedBolting)
	a.interact(InteractSteed, 0, SteedActSummon, 0)
	if e := a.take(EventSteedRefused, 3*time.Second); e.Value != SteedRefuseCooldown || e.TargetID == 0 {
		t.Fatalf("summon after a spook: %+v", e)
	}
}

func TestSteedNameColourPersist(t *testing.T) {
	r := mountHarness(t, nil, 12)
	x, z := r.flatSpot(t)
	const A = "c0000000-0000-0000-0000-0000000000a3"
	a := r.join(t, A, "Rook", x, z)
	addItems(t, r.harness, A, steedWhistle, 1)
	a.interact(InteractSteed, 0, SteedActSummon, 0)
	a.take(EventSteedSync, 3*time.Second)
	for i, chunk := range []uint32{'M' | 'i'<<8 | 's'<<16 | 't'<<24, 'y'} {
		a.interact(InteractSteed, uint64(i), SteedActName, chunk)
	}
	a.interact(InteractSteed, 0, SteedActColour, 3)
	a.interact(InteractSteed, 0, SteedActName, '!')
	a.steedRefused(t, SteedRefuseName)
	deadline := time.Now().Add(3 * time.Second)
	for {
		if s := r.store.get(A); len(s) == 1 && s[0].Name == "Misty" && s[0].Colour == 3 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("saved %+v", r.store.get(A))
		}
		time.Sleep(20 * time.Millisecond)
	}
	// A restart: the steed is still bonded (no whistle needed to know it).
	r2 := mountHarness(t, r.store, 12)
	c := r2.dial("")
	r2.store.rows[A] = movement.Vec3{X: x, Y: r2.srv.cfg.Ground.HeightAt(x, z), Z: z}
	c.join(r2.harness, A, "Rook")
	var j steedSyncJSON
	if err := json.Unmarshal(c.take(EventSteedSync, 3*time.Second).Data, &j); err != nil || !j.Owned || j.Name != "Misty" || j.Colour != 3 {
		t.Fatalf("after restart %+v %v", j, err)
	}
}
