package game

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/snapshot"
	"lodestone/server/pkg/ticket"
	"lodestone/server/pkg/transport"
	"lodestone/server/pkg/writebehind"
)

const (
	testZone  = "zone-test"
	testWorld = "world-test"
)

type harness struct {
	t    *testing.T
	srv  *Server
	url  string
	priv ed25519.PrivateKey
}

func newHarness(t *testing.T, mod func(*Config)) *harness {
	t.Helper()
	priv, _, _ := ticket.PrivateKeyFromEnv()
	pub, _, _ := ticket.PublicKeyFromEnv()
	cfg := Config{ZoneID: testZone, WorldID: testWorld, Seed: 42, GenVersion: "g1", TicketKey: pub, DevSpawn: true,
		SpinTail: time.Millisecond, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	dry := false
	cfg.Rain = &dry // WP10: deterministic weather (the stub would follow the wall clock)
	if mod != nil {
		mod(&cfg)
	}
	srv := New(cfg)
	srv.Start()
	hs := httptest.NewServer(srv.Handler(&transport.WebSocket{}))
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		srv.Stop(ctx)
		hs.Close()
	})
	return &harness{t: t, srv: srv, url: "ws" + strings.TrimPrefix(hs.URL, "http") + "/ws", priv: priv}
}

func (h *harness) ticket(char, name string, mod func(*ticket.Claims)) []byte {
	c := ticket.Claims{AccountID: "acct-" + char, CharacterID: char, CharacterName: name, WorldID: testWorld, Audience: ticket.AudienceZone(testZone)}
	if mod != nil {
		mod(&c)
	}
	return []byte(ticket.Sign(h.priv, c))
}

type client struct {
	t     *testing.T
	c     transport.Conn
	msgs  chan proto.Message
	err   chan error
	dec   snapshot.Decoder
	seq   uint32
	frame *snapshot.Frame
	snap  *proto.Snapshot
	welc  *proto.Welcome
}

func (h *harness) dial(query string) *client {
	h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := transport.DialWebSocket(ctx, h.url+query)
	if err != nil {
		h.t.Fatal(err)
	}
	cl := &client{t: h.t, c: c, msgs: make(chan proto.Message, 4096), err: make(chan error, 1)}
	go func() {
		for {
			b, err := c.Recv(context.Background())
			if err != nil {
				cl.err <- err
				close(cl.msgs)
				return
			}
			m, err := proto.DecodeMessage(b)
			if err != nil {
				cl.err <- err
				close(cl.msgs)
				return
			}
			cl.msgs <- m
		}
	}()
	h.t.Cleanup(func() { c.Close(transport.CloseNormal, "") })
	return cl
}

func (cl *client) send(m proto.Message) {
	if err := cl.c.SendReliable(proto.Encode(m)); err != nil {
		cl.t.Fatal(err)
	}
}

func (cl *client) hello(tk []byte, version uint16) {
	cl.send(&proto.Hello{ProtocolVersion: version, Ticket: tk, ClientTime: 1, Transport: proto.TransportWebsocket})
}

// next returns the next message of the wanted id, applying snapshots on the
// way (so the client always acks what it has).
func (cl *client) next(want uint8, timeout time.Duration) proto.Message {
	cl.t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case m, ok := <-cl.msgs:
			if !ok {
				cl.t.Fatalf("connection closed waiting for %s", proto.MessageName(want))
			}
			if s, ok := m.(*proto.Snapshot); ok {
				f, err := cl.dec.Apply(s)
				if err != nil {
					cl.t.Fatalf("apply snapshot: %v", err)
				}
				cl.frame, cl.snap = f, s
			}
			if w, ok := m.(*proto.Welcome); ok {
				cl.welc = w
			}
			if m.MsgID() == want {
				return m
			}
		case <-deadline:
			cl.t.Fatalf("timeout waiting for %s", proto.MessageName(want))
		}
	}
}

func (cl *client) join(h *harness, char, name string) *proto.Welcome {
	cl.hello(h.ticket(char, name, nil), proto.ProtocolVersion)
	return cl.next(proto.MsgWelcome, 3*time.Second).(*proto.Welcome)
}

// walk sends n frames (2 new per packet, plus 1 repeat, 30 packets/s).
func (cl *client) walk(n int, flags uint16, yaw float64, sim *movement.State) {
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
			if sim != nil {
				*sim = movement.StepFrame(*sim, f, movement.Flat{})
			}
			prev = &frames[len(frames)-1]
		}
		cl.send(&proto.Input{AckTick: cl.dec.Latest(), Frames: frames})
		cl.drainFor(33 * time.Millisecond)
	}
}

// drainFor applies whatever arrives for d.
func (cl *client) drainFor(d time.Duration) {
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
		case <-deadline:
			return
		}
	}
}

func (cl *client) expectKick(code proto.KickCode) {
	cl.t.Helper()
	k := cl.next(proto.MsgKick, 3*time.Second).(*proto.Kick)
	if k.Code != code {
		cl.t.Fatalf("kick code %d (%s), want %d", k.Code, k.Reason, code)
	}
}

func TestVersionMismatchIsKicked(t *testing.T) {
	h := newHarness(t, nil)
	cl := h.dial("")
	cl.hello(h.ticket("c1", "A", nil), proto.ProtocolVersion+1)
	cl.expectKick(proto.KickCodeVersionMismatch)
}

func TestBadTicketsAreKicked(t *testing.T) {
	h := newHarness(t, nil)
	otherPriv := ed25519.NewKeyFromSeed(make([]byte, 32))
	cases := map[string][]byte{
		"garbage":        []byte("not-a-ticket"),
		"wrong audience": h.ticket("c1", "A", func(c *ticket.Claims) { c.Audience = ticket.AudienceZone("other") }),
		"wrong world":    h.ticket("c1", "A", func(c *ticket.Claims) { c.WorldID = "elsewhere" }),
		"expired":        h.ticket("c1", "A", func(c *ticket.Claims) { c.IssuedAt = time.Now().Add(-2 * time.Minute) }),
		"wrong key":      []byte(ticket.Sign(otherPriv, ticket.Claims{CharacterID: "c1", WorldID: testWorld, Audience: ticket.AudienceZone(testZone)})),
	}
	for name, tk := range cases {
		t.Run(name, func(t *testing.T) {
			cl := h.dial("")
			cl.hello(tk, proto.ProtocolVersion)
			cl.expectKick(proto.KickCodeBadTicket)
		})
	}
}

func TestWelcomeThenAuthoritativeMovementMatchesPrediction(t *testing.T) {
	h := newHarness(t, nil)
	cl := h.dial("?spawn=100,200")
	w := cl.join(h, "c1", "Nicole")
	if w.WorldID != testWorld || w.Seed != 42 || w.GenVersion != "g1" || w.Name != "Nicole" || w.TickRate != 30 ||
		w.X != 10000 || w.Z != 20000 || w.EntityID == 0 || w.ProtocolVersion != proto.ProtocolVersion {
		t.Fatalf("welcome %+v", w.ToJSON())
	}
	sim := movement.NewState(movement.Vec3{X: 100, Z: 200})
	cl.walk(60, proto.InputFlagForward|proto.InputFlagSprint, 0.7, &sim)
	cl.walk(20, proto.InputFlagForward|proto.InputFlagJump, 0.7, &sim)
	// Wait for the snapshot acking our last frame.
	deadline := time.Now().Add(2 * time.Second)
	for cl.snap == nil || cl.snap.AckInputSeq != cl.seq {
		if time.Now().After(deadline) {
			t.Fatalf("never acked seq %d (last ack %v)", cl.seq, cl.snap)
		}
		cl.drainFor(20 * time.Millisecond)
	}
	self := cl.frame.Self
	for _, c := range []struct {
		got  int32
		want float64
	}{{self.X, sim.Pos.X}, {self.Y, sim.Pos.Y}, {self.Z, sim.Pos.Z}} {
		if c.got != proto.MetersToCm(c.want) {
			t.Fatalf("server %v cm vs predicted %v m (sim %+v, self %+v)", c.got, c.want, sim, self)
		}
	}
	if self.Health != 100 || self.HealthMax != 100 || self.StaminaMax != 1000 {
		t.Fatalf("self vitals %+v", self)
	}
}

func TestTwoClientsSeeEachOtherThenRemoval(t *testing.T) {
	h := newHarness(t, nil)
	a := h.dial("?spawn=100,100")
	a.join(h, "ca", "Alice")
	b := h.dial("?spawn=110,100")
	wb := b.join(h, "cb", "Bob")
	a.walk(10, 0, 0, nil)
	var bob *snapshot.EntState
	for i := 0; i < 30 && bob == nil; i++ {
		a.walk(2, 0, 0, nil)
		if a.frame != nil {
			bob = a.frame.Find(wb.EntityID)
		}
	}
	if bob == nil || bob.Name != "Bob" || bob.Kind != proto.EntityKindPlayer || bob.X != 11000 || bob.HealthPct != 100 {
		t.Fatalf("alice should see bob with a full first-sight record: %+v", bob)
	}
	// Bob moves: alice's view follows.
	go b.walk(30, proto.InputFlagRight, 0, nil)
	a.walk(40, 0, 0, nil)
	if got := a.frame.Find(wb.EntityID); got == nil || got.X <= 11000 {
		t.Fatalf("bob's movement not replicated: %+v", got)
	}
	b.send(&proto.Bye{})
	for i := 0; i < 30 && a.frame.Find(wb.EntityID) != nil; i++ {
		a.walk(2, 0, 0, nil)
	}
	if a.frame.Find(wb.EntityID) != nil {
		t.Fatal("bob should be removed after leaving")
	}
}

func TestInterestRingsAndFarCutoff(t *testing.T) {
	h := newHarness(t, nil)
	a := h.dial("?spawn=1000,1000")
	a.join(h, "ca", "A")
	ids := map[string]uint32{}
	for name, x := range map[string]int{"near": 1030, "mid": 1150, "far": 1400, "gone": 1700} {
		c := h.dial(fmt.Sprintf("?spawn=%d,1000", x))
		ids[name] = c.join(h, "c-"+name, name).EntityID
	}
	a.walk(30, 0, 0, nil)
	for _, n := range []string{"near", "mid", "far"} {
		if a.frame.Find(ids[n]) == nil {
			t.Fatalf("%s entity missing from interest set", n)
		}
	}
	if a.frame.Find(ids["gone"]) != nil {
		t.Fatal("entity 700 m away must not be in the interest set")
	}
}

func TestDuplicateLoginKicksTheOldSession(t *testing.T) {
	h := newHarness(t, nil)
	old := h.dial("?spawn=50,50")
	old.join(h, "same", "Twin")
	old.walk(20, proto.InputFlagForward, 0, nil)
	nw := h.dial("")
	w := nw.join(h, "same", "Twin")
	old.expectKick(proto.KickCodeDuplicateLogin)
	// The new session continues from the old one's live position, not a
	// fresh spawn.
	if math.Abs(float64(w.X)-5000) > 1 || w.Z >= 5000 {
		t.Fatalf("new session should resume at the old position, got x=%d z=%d", w.X, w.Z)
	}
	if h.srv.Players() != 1 {
		t.Fatalf("players %d", h.srv.Players())
	}
}

func TestMessageFloodIsRateLimitedThenKicked(t *testing.T) {
	h := newHarness(t, nil)
	cl := h.dial("")
	cl.join(h, "c1", "Spam")
	for i := 0; i < 400; i++ {
		cl.send(&proto.ClockPing{T1: float64(i)})
	}
	cl.expectKick(proto.KickCodeRateLimited)
}

func TestClockPong(t *testing.T) {
	h := newHarness(t, nil)
	cl := h.dial("")
	cl.join(h, "c1", "Clock")
	cl.send(&proto.ClockPing{T1: 123.5})
	p := cl.next(proto.MsgClockPong, 2*time.Second).(*proto.ClockPong)
	now := float64(time.Now().UnixMicro()) / 1000
	if p.T1 != 123.5 || p.T2 > p.T3 || math.Abs(p.T3-now) > 1000 {
		t.Fatalf("pong %+v", p.ToJSON())
	}
}

func TestFrameBudgetCapsSimulatedTime(t *testing.T) {
	h := newHarness(t, nil)
	cl := h.dial("?spawn=500,500")
	cl.join(h, "c1", "Hacker")
	// 200 frames in one packet = 3.3 s of movement delivered instantly.
	frames := make([]proto.InputFrame, 200)
	for i := range frames {
		frames[i] = proto.InputFrame{Seq: uint32(i + 1), Flags: proto.InputFlagForward | proto.InputFlagSprint}
	}
	cl.send(&proto.Input{Frames: frames})
	cl.drainFor(300 * time.Millisecond)
	moved := 500 - proto.CmToMeters(cl.frame.Self.Z)
	// Burst budget is 60 frames (1 s, decision 0006): at most ~7 m, never the ~25 m that
	// 200 frames of sprint would give.
	if moved <= 0 || moved > 8 {
		t.Fatalf("moved %v m from a 200-frame burst", moved)
	}
	if h.srv.m.framesDropped.Load() < 110 {
		t.Fatalf("dropped %d frames", h.srv.m.framesDropped.Load())
	}
}

type fakeStore struct {
	mu    sync.Mutex
	saves map[string]movement.Vec3
	rows  map[string]movement.Vec3
	fail  bool
}

func (f *fakeStore) LoadPosition(_ context.Context, id string) (movement.Vec3, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p, ok := f.rows[id]
	return p, ok, nil
}

func (f *fakeStore) SavePosition(_ context.Context, id string, p movement.Vec3) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail {
		return errors.New("db down")
	}
	if _, ok := f.rows[id]; !ok {
		return ErrNoRow
	}
	f.saves[id] = p
	return nil
}

func TestCheckpointsGoThroughWriteBehindAndFlushOnShutdown(t *testing.T) {
	store := &fakeStore{saves: map[string]movement.Vec3{}, rows: map[string]movement.Vec3{"known": {X: 300, Z: 400}}}
	q := writebehind.New(100)
	q.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	h := newHarness(t, func(c *Config) { c.Store = store; c.Queue = q; c.SaveInterval = 200 * time.Millisecond })
	qctx, stopQ := context.WithCancel(context.Background())
	defer stopQ()
	go q.Run(qctx)

	known := h.dial("") // no spawn hint: position comes from the store
	w := known.join(h, "known", "Saved")
	if w.X != 30000 || w.Z != 40000 {
		t.Fatalf("spawn should load from the character row: %+v", w.ToJSON())
	}
	missing := h.dial("")
	missing.join(h, "nobody", "New")
	known.walk(30, proto.InputFlagForward, 0, nil)
	store.mu.Lock()
	_, saved := store.saves["known"]
	store.mu.Unlock()
	if !saved {
		t.Fatal("periodic checkpoint never landed")
	}
	if q.Stats.Skipped.Load() == 0 {
		t.Fatal("character without a row should be skipped, not retried")
	}

	// Postgres goes down: the tick keeps running, the queue absorbs it.
	store.mu.Lock()
	store.fail = true
	store.mu.Unlock()
	known.walk(30, proto.InputFlagForward, 0, nil)
	if h.srv.TickStats().WinTick.Max > 20 {
		t.Fatalf("tick blocked on a failing database: %+v", h.srv.TickStats().WinTick)
	}
	store.mu.Lock()
	store.fail = false
	store.mu.Unlock()

	stopQ()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	h.srv.Stop(ctx)
	known.expectKick(proto.KickCodeShutdown)
	store.mu.Lock()
	final := store.saves["known"]
	store.mu.Unlock()
	if math.Abs(final.X-300) > 0.01 || final.Z >= 399 || q.Depth() != 0 {
		t.Fatalf("shutdown checkpoint missing or stale: %+v depth=%d", final, q.Depth())
	}
}
