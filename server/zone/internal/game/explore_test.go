package game

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/env"
	"lodestone/server/pkg/localsave"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/ticket"
	"lodestone/server/pkg/writebehind"
	"lodestone/server/zone/internal/explore"
)

// exploreWorld: flat ground at y = 0 with a region-0 tower at (100, 100), a
// waypoint at (300, 100), a village at (500, 500) and a region-5 tower.
func exploreWorld() (*explore.World, movement.Ground) {
	a := &structures.Atlas{WorldSize: 4096, RegionsPerEdge: 4, Sites: []structures.Site{
		{Index: 0, ID: 9000, Category: structures.CategoryPOI, Kind: structures.POITower, Region: 0, X: 100, Z: 100, Name: "Test Tower"},
		{Index: 1, ID: 9001, Category: structures.CategoryPOI, Kind: structures.POIWaypoint, Region: 0, X: 300, Z: 100, Name: "Test Stone"},
		{Index: 2, ID: 9002, Category: structures.CategorySettlement, Region: 0, X: 500, Z: 500, Radius: 80, Name: "Testby"},
		{Index: 3, ID: 9003, Category: structures.CategoryPOI, Kind: structures.POITower, Region: 5, X: 1500, Z: 1500},
	}}
	a.Regions = []structures.Region{{Index: 0, Name: "Testshire", Tower: 0}}
	base := movement.Flat{}
	o, sites := structures.Towers(a, base)
	g := structures.Wrap(base, o)
	return explore.NewWorld(a, g, sites), g
}

type fakeParties struct {
	mu    sync.Mutex
	of    map[string]string
	saved map[string][]PartyPin
}

func (f *fakeParties) Lookup(_ context.Context, ids []string) (map[string]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]string{}
	for _, id := range ids {
		out[id] = f.of[id]
	}
	return out, nil
}

func (f *fakeParties) LoadPins(_ context.Context, p string) ([]PartyPin, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.saved[p], nil
}

func (f *fakeParties) SavePins(_ context.Context, p string, pins []PartyPin) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.saved[p] = pins
	return nil
}

// progressStore is a fakeStore with progress rows.
type progressStore struct {
	fakeStore
	prog map[string]ProgressSnapshot
}

func (p *progressStore) LoadProgress(_ context.Context, id string, sites []uint64) (*explore.Progress, bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	s, ok := p.prog[id]
	if !ok {
		return nil, false, nil
	}
	pr := explore.NewProgress()
	pr.XP, pr.Level = s.XP, s.Level
	pr.Towers, pr.Waypoints, pr.Discoveries = s.Towers, s.Waypoints, s.Discoveries
	pr.LoadPinsJSON(s.Pins)
	if s.LastWaypoint != nil {
		for i, sid := range sites {
			if int64(sid) == *s.LastWaypoint {
				pr.LastWaypoint = i
			}
		}
	}
	return pr, true, nil
}

func (p *progressStore) SaveProgress(_ context.Context, id string, s ProgressSnapshot) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, ok := p.rows[id]; !ok {
		return ErrNoRow
	}
	p.prog[id] = s
	return nil
}

func exploreHarness(t *testing.T, mod func(*Config)) *harness {
	w, g := exploreWorld()
	return newHarness(t, func(c *Config) {
		c.Explore = w
		c.Ground = g
		if mod != nil {
			mod(c)
		}
	})
}

// backlog keeps Events that arrived while a helper was draining (walk and
// drainFor from game_test.go discard non-snapshot messages).
var (
	backlogMu sync.Mutex
	backlog   = map[*client][]*proto.Event{}
)

// stepWalk is walk() that keeps Events for nextEvent.
func (cl *client) stepWalk(n int, flags uint16, yaw float64) {
	var prev *proto.InputFrame
	for i := 0; i < n; i += 2 {
		var frames []proto.InputFrame
		if prev != nil {
			frames = append(frames, *prev)
		}
		for k := 0; k < 2 && i+k < n; k++ {
			cl.seq++
			frames = append(frames, proto.InputFrame{Seq: cl.seq, Flags: flags, Yaw: proto.YawToU16(yaw)})
			prev = &frames[len(frames)-1]
		}
		cl.send(&proto.Input{AckTick: cl.dec.Latest(), Frames: frames})
		cl.keep(33 * time.Millisecond)
	}
}

// keep applies snapshots and stores Events for d.
func (cl *client) keep(d time.Duration) {
	deadline := time.After(d)
	for {
		select {
		case m, ok := <-cl.msgs:
			if !ok {
				return
			}
			switch v := m.(type) {
			case *proto.Snapshot:
				if f, err := cl.dec.Apply(v); err == nil {
					cl.frame, cl.snap = f, v
				}
			case *proto.Event:
				backlogMu.Lock()
				backlog[cl] = append(backlog[cl], v)
				backlogMu.Unlock()
			}
		case <-deadline:
			return
		}
	}
}

// nextEvent waits for an Event of kind (skipping others), first from the backlog.
func (cl *client) nextEvent(kind uint16, timeout time.Duration) *proto.Event {
	cl.t.Helper()
	backlogMu.Lock()
	for i, ev := range backlog[cl] {
		if ev.Kind == kind {
			backlog[cl] = append(backlog[cl][:i:i], backlog[cl][i+1:]...)
			backlogMu.Unlock()
			return ev
		}
	}
	backlogMu.Unlock()
	deadline := time.Now().Add(timeout)
	for {
		left := time.Until(deadline)
		if left <= 0 {
			cl.t.Fatalf("timeout waiting for event %d", kind)
		}
		ev := cl.next(proto.MsgEvent, left).(*proto.Event)
		if ev.Kind == kind {
			return ev
		}
	}
}

// noEvent asserts no Event of kind arrives within d.
func (cl *client) noEvent(kind uint16, d time.Duration) {
	cl.t.Helper()
	deadline := time.After(d)
	for {
		select {
		case m, ok := <-cl.msgs:
			if !ok {
				return
			}
			if s, ok := m.(*proto.Snapshot); ok {
				if f, err := cl.dec.Apply(s); err == nil {
					cl.frame, cl.snap = f, s
				}
			}
			if ev, ok := m.(*proto.Event); ok && ev.Kind == kind {
				cl.t.Fatalf("unexpected event %d: %+v", kind, ev.ToJSON())
			}
		case <-deadline:
			return
		}
	}
}

const east = -math.Pi / 2 // yaw facing +x (forward = (-sin, -cos))

func TestTowerClimbRevealsRegionThenFastTravel(t *testing.T) {
	h := exploreHarness(t, nil)
	cl := h.dial("?spawn=86,100") // 14 m west of the tower's axis, outside its footprint
	cl.join(h, "c1", "Climber")
	p0 := cl.nextEvent(EventProgress, 2*time.Second)
	if pr, rev, err := explore.DecodeProgress(p0.Data); err != nil || rev != 0 || pr.Level != 1 || pr.LastWaypoint != -1 {
		t.Fatalf("initial progress %+v %v %v", pr, rev, err)
	}
	cl.nextEvent(EventPins, time.Second)

	// Walk east into the tower: the walls are part of the ground, so (until
	// WP10 adds slope limits) the ground snap carries the player up them,
	// exactly as prediction does on the client.
	cl.stepWalk(150, proto.InputFlagForward, east)
	disc := cl.nextEvent(EventDiscovery, 2*time.Second)
	if disc.TargetID != 0 || disc.Value != 40 || string(disc.Data) != "Test Tower" {
		t.Fatalf("tower discovery %+v", disc.ToJSON())
	}
	up := cl.nextEvent(EventTowerUnlocked, 2*time.Second)
	if up.TargetID != 0 || up.Value != 0 || string(up.Data) != "Testshire" {
		t.Fatalf("tower unlocked %+v", up.ToJSON())
	}
	// One progress_sync follows each batch of happenings; the latest wins.
	var pr *explore.Progress
	var rev uint32
	for range 3 {
		if pr, rev, _ = explore.DecodeProgress(cl.nextEvent(EventProgress, time.Second).Data); rev == 1 {
			break
		}
	}
	if rev != 1 || !pr.Towers.Has(0) || pr.XP != 40+explore.TowerClimbXP || pr.Level != 2 {
		t.Fatalf("progress after climbing: rev %b %+v", rev, pr)
	}

	// The locked waypoint is refused; the unlocked tower works.
	cl.send(&proto.Interact{TargetKind: InteractSite, TargetID: 1, Action: ActionFastTravel})
	if d := cl.nextEvent(EventFastTravelDenied, time.Second); d.Value != int32(explore.TravelLocked) {
		t.Fatalf("denied %+v", d.ToJSON())
	}
	cl.stepWalk(60, proto.InputFlagForward, east) // away from the tower
	cl.send(&proto.Interact{TargetKind: InteractSite, TargetID: 0, Action: ActionFastTravel})
	tp := cl.nextEvent(EventTeleport, time.Second)
	top := h.srv.cfg.Explore.Towers[0].Shape.TopY
	if tp.EntityID != cl.welc.EntityID || tp.X != 10000 || tp.Z != 10000 || tp.Y != proto.MetersToCm(top) {
		t.Fatalf("teleport %+v (top %v)", tp.ToJSON(), top)
	}
	cl.drainFor(150 * time.Millisecond)
	if s := cl.frame.Self; math.Abs(float64(s.X)-10000) > 1 || math.Abs(float64(s.Y)-top*100) > 1 {
		t.Fatalf("self after travel %+v", s)
	}
	// Cooldown.
	cl.send(&proto.Interact{TargetKind: InteractSite, TargetID: 0, Action: ActionFastTravel})
	if d := cl.nextEvent(EventFastTravelDenied, time.Second); d.Value != int32(explore.TravelCooldown) {
		t.Fatalf("cooldown %+v", d.ToJSON())
	}
}

func TestWaypointTouchSetsRespawnPoint(t *testing.T) {
	h := exploreHarness(t, nil)
	cl := h.dial("?spawn=296,100")
	cl.join(h, "c1", "Walker")
	cl.stepWalk(30, proto.InputFlagForward, east)
	wp := cl.nextEvent(EventWaypoint, 2*time.Second)
	rp := cl.nextEvent(EventRespawnPoint, time.Second)
	if wp.TargetID != 1 || rp.TargetID != 1 {
		t.Fatalf("waypoint %+v respawn %+v", wp.ToJSON(), rp.ToJSON())
	}
	e := h.srv.byChar["c1"].ent // read after the tick wrote it; the test is the only other reader
	if p := h.srv.RespawnPoint(e); p.X != 300+explore.ArrivalOffsetM || p.Z != 100 {
		t.Fatalf("respawn point %+v", p)
	}
}

func TestPartyRingAndPartyPins(t *testing.T) {
	parties := &fakeParties{of: map[string]string{"alice": "party-1", "bob": "party-1"}, saved: map[string][]PartyPin{}}
	q := writebehind.New(100)
	q.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	h := exploreHarness(t, func(c *Config) { c.Parties = parties; c.Queue = q })
	qctx, stopQ := context.WithCancel(context.Background())
	defer stopQ()
	go q.Run(qctx)

	a := h.dial("?spawn=200,1000")
	aw := a.join(h, "alice", "Alice")
	b := h.dial("?spawn=3000,3000") // 3 km away: far beyond the 600 m far ring
	b.join(h, "bob", "Bob")
	pa := a.nextEvent(EventParty, 4*time.Second)
	b.nextEvent(EventParty, 4*time.Second)
	if uint32(pa.Value) != PartyHash("party-1") || pa.Value == 0 {
		t.Fatalf("party event %+v", pa.ToJSON())
	}
	// Bob's snapshots carry Alice through the party ring (2 Hz).
	deadline := time.Now().Add(3 * time.Second)
	for {
		b.drainFor(100 * time.Millisecond)
		if b.frame != nil {
			if es := b.frame.Find(aw.EntityID); es != nil && es.PartyID == PartyHash("party-1") && es.X == 20000 {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("bob never received alice in the party ring")
		}
	}

	// Alice's personal pin is hers alone; her party pin reaches Bob.
	a.send(&proto.Interact{TargetKind: InteractPin, TargetID: explore.PackPinPos(150000, 160000), Action: ActionPinSet, Arg: 0 | 3<<8})
	pins := a.waitPins(func(p []explore.PinView) bool { return len(p) == 1 })
	if len(pins) != 1 || pins[0].Party || pins[0].XCm != 150000 || pins[0].Color != 3 {
		t.Fatalf("alice personal pins %+v", pins)
	}
	b.keep(300 * time.Millisecond)
	backlogMu.Lock()
	for _, ev := range backlog[b] {
		if ev.Kind == EventPins {
			if p, _ := explore.DecodePins(ev.Data); len(p) > 0 {
				t.Fatalf("bob got pins %+v", p)
			}
		}
	}
	backlogMu.Unlock()
	a.send(&proto.Interact{TargetKind: InteractPin, TargetID: explore.PackPinPos(250000, 260000), Action: ActionPartyPinSet, Arg: 2})
	bp := b.waitPins(func(p []explore.PinView) bool { return len(p) == 1 })
	if len(bp) != 1 || !bp[0].Party || bp[0].Owner != "Alice" || bp[0].XCm != 250000 || bp[0].ZCm != 260000 {
		t.Fatalf("bob party pins %+v", bp)
	}
	ap := a.waitPins(func(p []explore.PinView) bool { return len(p) == 2 })
	if len(ap) != 2 {
		t.Fatalf("alice sees her personal and the party pin: %+v", ap)
	}
	// Stored next to the party for other zones / reconnects.
	deadline = time.Now().Add(2 * time.Second)
	for {
		parties.mu.Lock()
		n := len(parties.saved["party-1"])
		parties.mu.Unlock()
		if n == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("party pins never stored")
		}
		time.Sleep(20 * time.Millisecond)
	}
	// Bob leaves the party: no more party ring or pins for him.
	parties.mu.Lock()
	parties.of["bob"] = ""
	parties.mu.Unlock()
	if ev := b.nextEvent(EventParty, 4*time.Second); ev.Value != 0 {
		t.Fatalf("left party %+v", ev.ToJSON())
	}
	if bp := b.waitPins(func(p []explore.PinView) bool { return len(p) == 0 }); len(bp) != 0 {
		t.Fatalf("pins after leaving %+v", bp)
	}
}

func TestProgressPersistsAndXPIsGrantedOnce(t *testing.T) {
	store := &progressStore{fakeStore: fakeStore{saves: map[string]movement.Vec3{}, rows: map[string]movement.Vec3{"known": {X: 100, Z: 100}}}, prog: map[string]ProgressSnapshot{}}
	q := writebehind.New(100)
	q.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	h := exploreHarness(t, func(c *Config) { c.Store = store; c.Queue = q })
	qctx, stopQ := context.WithCancel(context.Background())
	defer stopQ()
	go q.Run(qctx)

	cl := h.dial("") // the store's saved position: on the tower top (lifted onto the ground)
	cl.join(h, "known", "Saver")
	cl.nextEvent(EventTowerUnlocked, 2*time.Second)
	cl.c.Close(1000, "")
	deadline := time.Now().Add(3 * time.Second)
	for {
		store.mu.Lock()
		s, ok := store.prog["known"]
		store.mu.Unlock()
		if ok && len(s.Towers) > 0 && s.Towers[0]&1 == 1 {
			if s.XP != 40+explore.TowerClimbXP || s.Level != 2 || string(s.Pins) != "[]" {
				t.Fatalf("saved %+v", s)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("progress never saved on logout")
		}
		time.Sleep(20 * time.Millisecond)
	}
	// Back on the same tower: progress is loaded, nothing is granted twice.
	cl2 := h.dial("")
	cl2.join(h, "known", "Saver")
	pr, rev, _ := explore.DecodeProgress(cl2.nextEvent(EventProgress, 2*time.Second).Data)
	if rev != 1 || pr.XP != 190 || pr.Level != 2 {
		t.Fatalf("reloaded %+v rev %b", pr, rev)
	}
	cl2.noEvent(EventTowerUnlocked, 500*time.Millisecond)
	cl2.noEvent(EventDiscovery, 10*time.Millisecond)
}

// Local profiles: progress rides the signed save blob (needs the shared
// Redis for the counter; skipped without it).
func TestLocalProfileProgressInSaveBlob(t *testing.T) {
	rdb := redis.NewClient(&redis.Options{Addr: env.RedisAddr()})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		if env.Bool("LODESTONE_REQUIRE_INFRA", false) {
			t.Fatal(err)
		}
		t.Skip("redis not available")
	}
	priv, _, _ := localsave.PrivateKeyFromEnv()
	saves := &localsave.Store{RDB: rdb, Priv: priv, Pub: priv.Public().(ed25519.PublicKey), AdoptMissing: true}
	q := writebehind.New(100)
	q.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	h := exploreHarness(t, func(c *Config) { c.Saves = saves; c.Queue = q })
	qctx, stopQ := context.WithCancel(context.Background())
	defer stopQ()
	go q.Run(qctx)

	profile, char := "wp12-test-profile-"+time.Now().Format("150405.000"), "wp12-local-char"
	defer rdb.Del(context.Background(), localsave.Key(profile))
	st := localsave.NewCharacterState(char, testWorld, "Locally", localsave.Vec3{X: 100, Y: 0, Z: 100}, nil)
	st.Progress.Pins = json.RawMessage(`[{"slot":4,"color":1,"x":5000,"z":6000}]`)
	blob, err := saves.Issue(ctx, profile, char, testWorld, st.Marshal())
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(blob)
	cl := h.dial("")
	cl.send(&proto.Hello{ProtocolVersion: proto.ProtocolVersion, Transport: proto.TransportWebsocket, SaveBlob: raw,
		Ticket: h.ticket(char, "Locally", func(c *ticket.Claims) { c.AccountID = ""; c.ProfileID = profile; c.IsLocalProfile = true })})
	w := cl.next(proto.MsgWelcome, 3*time.Second).(*proto.Welcome)
	if w.X != 10000 || w.Z != 10000 {
		t.Fatalf("spawn from the blob's position: %+v", w.ToJSON())
	}
	pins, _ := explore.DecodePins(cl.nextEvent(EventPins, time.Second).Data)
	if len(pins) != 1 || pins[0].Slot != 4 {
		t.Fatalf("pins from the blob %+v", pins)
	}
	cl.nextEvent(EventTowerUnlocked, 2*time.Second) // spawned on the tower top
	sb := cl.next(proto.MsgSaveBlob, 3*time.Second).(*proto.SaveBlob)
	var nb localsave.Blob
	if err := json.Unmarshal(sb.Blob, &nb); err != nil {
		t.Fatal(err)
	}
	if err := saves.Verify(ctx, nb); err != nil || nb.Counter != blob.Counter+1 {
		t.Fatalf("new blob verify %v counter %d", err, nb.Counter)
	}
	ns, _ := nb.DecodeState()
	if ns.XP != 190 || ns.Level != 2 || len(ns.Progress.Towers) == 0 || ns.Progress.Towers[0]&1 != 1 || string(ns.Progress.Pins) == "" {
		t.Fatalf("new state %+v", ns)
	}
	// The old blob is now stale: presenting it again is refused, and the
	// session is read-only for progress (with a notice).
	cl2 := h.dial("")
	cl2.send(&proto.Hello{ProtocolVersion: proto.ProtocolVersion, Transport: proto.TransportWebsocket, SaveBlob: raw,
		Ticket: h.ticket(char, "Locally", func(c *ticket.Claims) { c.AccountID = ""; c.ProfileID = profile; c.IsLocalProfile = true })})
	n := cl2.nextEvent(1, 3*time.Second)
	if len(n.Data) == 0 {
		t.Fatal("notice text")
	}
}

// waitPins waits for a pins Event whose list satisfies ok (older ones skipped).
func (cl *client) waitPins(ok func([]explore.PinView) bool) []explore.PinView {
	cl.t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	var last []explore.PinView
	for time.Now().Before(deadline) {
		p, err := explore.DecodePins(cl.nextEvent(EventPins, time.Until(deadline)).Data)
		if err != nil {
			cl.t.Fatal(err)
		}
		last = p
		if ok(p) {
			return p
		}
	}
	cl.t.Fatalf("pins never matched; last %+v", last)
	return nil
}
