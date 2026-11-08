package game

// WP16 in-process tests: two (or three) zones in one process joined by an
// in-memory Cluster (memHub), real WebSocket clients that follow the
// handoff protocol the browser client and the bots implement.

import (
	"context"
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
	"lodestone/server/pkg/zoneregistry"
	"lodestone/server/zone/internal/explore"
)

// ---- in-memory cluster ----

type memHub struct {
	mu       sync.Mutex
	kv       map[string][]byte
	zones    map[string]*memZone
	ids      map[string]uint32
	next     uint32
	presence map[string][]byte
	live     []zoneregistry.Entry
}

func newMemHub() *memHub {
	return &memHub{kv: map[string][]byte{}, zones: map[string]*memZone{}, ids: map[string]uint32{}, next: 1 << 30, presence: map[string][]byte{}}
}

type memZone struct {
	h      *memHub
	id     string
	ch     chan ClusterMsg
	owners *Owners
}

func (h *memHub) zone(id string) *memZone {
	h.mu.Lock()
	defer h.mu.Unlock()
	z := &memZone{h: h, id: id, ch: make(chan ClusterMsg, 4096)}
	h.zones[id] = z
	return z
}

// setLive recomputes every zone's ownership table.
func (h *memHub) setLive(live []zoneregistry.Entry) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.live = live
	for id, z := range h.zones {
		z.owners = OwnersFrom(id, live, time.Now())
	}
}

func (z *memZone) Send(_ context.Context, to string, msg []byte) error {
	z.h.mu.Lock()
	t := z.h.zones[to]
	z.h.mu.Unlock()
	if t == nil {
		return fmt.Errorf("no zone %s", to)
	}
	t.ch <- ClusterMsg{Data: append([]byte(nil), msg...)}
	return nil
}

func (z *memZone) Broadcast(_ context.Context, frame []byte) error {
	z.h.mu.Lock()
	defer z.h.mu.Unlock()
	for id, t := range z.h.zones {
		if id != z.id {
			select {
			case t.ch <- ClusterMsg{Ghost: true, Data: frame}:
			default:
			}
		}
	}
	return nil
}

func (z *memZone) Recv() <-chan ClusterMsg { return z.ch }

func (z *memZone) Put(_ context.Context, k string, v []byte, _ time.Duration) error {
	z.h.mu.Lock()
	defer z.h.mu.Unlock()
	z.h.kv[k] = append([]byte(nil), v...)
	return nil
}

func (z *memZone) Take(_ context.Context, k string) ([]byte, error) {
	z.h.mu.Lock()
	defer z.h.mu.Unlock()
	v := z.h.kv[k]
	delete(z.h.kv, k)
	return v, nil
}

func (z *memZone) Swap(_ context.Context, k string, v []byte, _ time.Duration) ([]byte, error) {
	z.h.mu.Lock()
	defer z.h.mu.Unlock()
	old := z.h.kv[k]
	z.h.kv[k] = append([]byte(nil), v...)
	return old, nil
}

func (z *memZone) DelIf(_ context.Context, k string, v []byte) error {
	z.h.mu.Lock()
	defer z.h.mu.Unlock()
	if string(z.h.kv[k]) == string(v) {
		delete(z.h.kv, k)
	}
	return nil
}

func (z *memZone) EntityID(_ context.Context, char string) (uint32, error) {
	z.h.mu.Lock()
	defer z.h.mu.Unlock()
	if id, ok := z.h.ids[char]; ok {
		return id, nil
	}
	z.h.next++
	z.h.ids[char] = z.h.next
	return z.h.next, nil
}

func (z *memZone) WritePresence(_ context.Context, put map[string][]byte, del []string) error {
	z.h.mu.Lock()
	defer z.h.mu.Unlock()
	for k, v := range put {
		z.h.presence[k] = v
	}
	for _, k := range del {
		delete(z.h.presence, k)
	}
	return nil
}

func (z *memZone) ReadPresence(context.Context) (map[string][]byte, error) {
	z.h.mu.Lock()
	defer z.h.mu.Unlock()
	m := make(map[string][]byte, len(z.h.presence))
	for k, v := range z.h.presence {
		m[k] = v
	}
	return m, nil
}

func (z *memZone) Owners() *Owners {
	z.h.mu.Lock()
	defer z.h.mu.Unlock()
	return z.owners
}

// ---- zones under test ----

type testZone2 struct {
	id  string
	srv *Server
	url string
	mz  *memZone
}

func startClusterZone(t *testing.T, h *memHub, id string, idBase uint32, mod func(*Config)) *testZone2 {
	t.Helper()
	pub, _, _ := ticket.PublicKeyFromEnv()
	mz := h.zone(id)
	dry := false
	cfg := Config{ZoneID: id, WorldID: testWorld, Seed: 42, GenVersion: "g1", TicketKey: pub, DevSpawn: true,
		SpinTail: time.Millisecond, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Rain: &dry, Cluster: mz, IDBase: idBase}
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
	return &testZone2{id: id, srv: srv, url: "ws" + strings.TrimPrefix(hs.URL, "http") + "/ws", mz: mz}
}

// twoZones: A owns x < 2048 (regions x = 0, 1), B owns x >= 2048.
func twoZones(t *testing.T, mod func(*Config)) (*memHub, *testZone2, *testZone2) {
	h := newMemHub()
	a := startClusterZone(t, h, "zone-a", 1<<24, mod)
	b := startClusterZone(t, h, "zone-b", 2<<24, mod)
	west := []zoneregistry.Region{{X: 0, Z: 0}, {X: 0, Z: 1}, {X: 0, Z: 2}, {X: 0, Z: 3}, {X: 1, Z: 0}, {X: 1, Z: 1}, {X: 1, Z: 2}, {X: 1, Z: 3}}
	h.setLive([]zoneregistry.Entry{
		{ZoneID: "zone-a", Endpoint: a.url, Role: zoneregistry.RolePrimary, Regions: west},
		{ZoneID: "zone-b", Endpoint: b.url, Role: zoneregistry.RolePool, Regions: []zoneregistry.Region{{X: 2, Z: 0}, {X: 2, Z: 1}, {X: 2, Z: 2}, {X: 2, Z: 3}, {X: 3, Z: 0}, {X: 3, Z: 1}, {X: 3, Z: 2}, {X: 3, Z: 3}}},
	})
	return h, a, b
}

// ---- a client that follows the handoff protocol ----

type hoMsg struct {
	zone string
	m    proto.Message
}

type hoClient struct {
	t      *testing.T
	char   string
	msgs   chan hoMsg
	mu     sync.Mutex
	conns  map[string]transport.Conn
	active string
	dec    snapshot.Decoder
	frame  *snapshot.Frame
	snap   *proto.Snapshot
	welc   *proto.Welcome

	seq        uint32
	sim        movement.State
	pred       map[uint32]movement.State
	sent       []proto.InputFrame
	switches   int
	mismatches int
	checks     int
	maxErrCm   int32
	switchLog  []string
	kicks      []string
}

func (c *hoClient) dialZone(zone, url, query string) transport.Conn {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := transport.DialWebSocket(ctx, url+query)
	if err != nil {
		c.t.Fatal(err)
	}
	c.mu.Lock()
	if old := c.conns[zone]; old != nil {
		old.Close(transport.CloseNormal, "replaced")
	}
	c.conns[zone] = conn
	c.mu.Unlock()
	go func() {
		for {
			b, err := conn.Recv(context.Background())
			if err != nil {
				return
			}
			m, err := proto.DecodeMessage(b)
			if err != nil {
				continue
			}
			c.msgs <- hoMsg{zone: zone, m: m}
		}
	}()
	c.t.Cleanup(func() { conn.Close(transport.CloseNormal, "") })
	return conn
}

func newHoClient(t *testing.T, z *testZone2, char, name string, x, zz float64) *hoClient {
	t.Helper()
	c := &hoClient{t: t, char: char, msgs: make(chan hoMsg, 8192), conns: map[string]transport.Conn{}, pred: map[uint32]movement.State{}}
	conn := c.dialZone(z.id, z.url, fmt.Sprintf("?spawn=%.2f,%.2f", x, zz))
	priv, _, _ := ticket.PrivateKeyFromEnv()
	tk := ticket.Sign(priv, ticket.Claims{AccountID: "acct-" + char, CharacterID: char, CharacterName: name, WorldID: testWorld, Audience: ticket.AudienceZone(z.id)})
	_ = conn.SendReliable(proto.Encode(&proto.Hello{ProtocolVersion: proto.ProtocolVersion, Ticket: []byte(tk), ClientTime: 1, Transport: proto.TransportWebsocket}))
	c.active = z.id
	deadline := time.After(3 * time.Second)
	for c.welc == nil {
		select {
		case hm := <-c.msgs:
			c.handle(hm)
		case <-deadline:
			t.Fatal("no welcome")
		}
	}
	c.sim = movement.NewState(movement.Vec3{X: x, Z: zz})
	return c
}

// handle applies one message (the browser's zoneSession logic in Go).
func (c *hoClient) handle(hm hoMsg) {
	switch m := hm.m.(type) {
	case *proto.Welcome:
		if c.welc != nil && hm.zone != c.active {
			// The standby connection's Welcome: ownership moved there.
			if m.EntityID != c.welc.EntityID {
				c.t.Errorf("entity id changed across the handoff: %d -> %d", c.welc.EntityID, m.EntityID)
			}
			c.switchLog = append(c.switchLog, fmt.Sprintf("%s->%s at seq %d", c.active, hm.zone, c.seq))
			c.active = hm.zone
			c.dec = snapshot.Decoder{}
			c.switches++
			// Resend what the old owner may not have applied.
			var frames []proto.InputFrame
			for _, f := range c.sent {
				if c.snap == nil || f.Seq > c.snap.AckInputSeq {
					frames = append(frames, f)
				}
			}
			c.snap = nil
			for len(frames) > 0 {
				n := min(16, len(frames))
				c.sendActive(&proto.Input{Frames: frames[:n]})
				frames = frames[n:]
			}
		}
		c.welc = m
	case *proto.Snapshot:
		if hm.zone != c.active {
			return
		}
		f, err := c.dec.Apply(m)
		if err != nil {
			return
		}
		c.frame, c.snap = f, m
		if p, ok := c.pred[m.AckInputSeq]; ok {
			c.checks++
			e := max(abs32(f.Self.X-proto.MetersToCm(p.Pos.X)), abs32(f.Self.Y-proto.MetersToCm(p.Pos.Y)), abs32(f.Self.Z-proto.MetersToCm(p.Pos.Z)))
			if e > c.maxErrCm {
				c.maxErrCm = e
			}
			if e > 0 {
				c.mismatches++
			}
		}
	case *proto.ZoneTransfer:
		if m.Kind == 1 {
			c.mu.Lock()
			if conn := c.conns[m.ZoneID]; conn != nil && m.ZoneID != c.active {
				conn.Close(transport.CloseNormal, "cancel")
				delete(c.conns, m.ZoneID)
			}
			c.mu.Unlock()
			return
		}
		conn := c.dialZone(m.ZoneID, m.Endpoint, "")
		_ = conn.SendReliable(proto.Encode(&proto.Hello{ProtocolVersion: proto.ProtocolVersion, Ticket: m.Ticket, ClientTime: 1, Transport: proto.TransportWebsocket}))
	case *proto.Kick:
		c.kicks = append(c.kicks, fmt.Sprintf("%s:%d %s", hm.zone, m.Code, m.Reason))
	}
}

func (c *hoClient) sendActive(m proto.Message) {
	c.mu.Lock()
	conn := c.conns[c.active]
	c.mu.Unlock()
	if conn != nil {
		_ = conn.SendReliable(proto.Encode(m))
	}
}

// walk plays n frames at 60 Hz (30 packets/s) toward yaw.
func (c *hoClient) walk(n int, flags uint16, yaw float64) {
	for i := 0; i < n; i += 2 {
		for k := 0; k < 2; k++ {
			c.seq++
			f := proto.InputFrame{Seq: c.seq, Flags: flags, Yaw: proto.YawToU16(yaw)}
			c.sim = movement.StepFrame(c.sim, f, movement.Flat{})
			c.pred[f.Seq] = c.sim
			c.sent = append(c.sent, f)
			if len(c.sent) > 64 {
				c.sent = c.sent[1:]
			}
		}
		frames := c.sent[max(0, len(c.sent)-3):]
		ack := uint32(0)
		if c.snap != nil {
			ack = c.dec.Latest()
		}
		c.sendActive(&proto.Input{AckTick: ack, Frames: frames})
		c.pump(33 * time.Millisecond)
	}
}

func (c *hoClient) pump(d time.Duration) {
	deadline := time.After(d)
	for {
		select {
		case hm := <-c.msgs:
			c.handle(hm)
		case <-deadline:
			return
		}
	}
}

// settle pumps until the active zone acked our newest frame.
func (c *hoClient) settle() {
	deadline := time.Now().Add(3 * time.Second)
	for c.snap == nil || c.snap.AckInputSeq != c.seq {
		if time.Now().After(deadline) {
			c.t.Fatalf("seq %d never acked (snap %v)", c.seq, c.snap)
		}
		c.pump(20 * time.Millisecond)
	}
}

const eastYaw = -math.Pi / 2 // yaw facing +x (forward = (-sin, -cos))

// ---- tests ----

func TestHandoffAcrossBorderKeepsPredictionAndIdentity(t *testing.T) {
	_, a, b := twoZones(t, nil)
	p := newHoClient(t, a, "char-p", "Pat", 2020, 1000)
	id := p.welc.EntityID
	if id < 1<<30 {
		t.Fatalf("expected a world-stable id from the allocator, got %d", id)
	}
	// An observer standing on B's side, 30 m from the border.
	o := newHoClient(t, b, "char-o", "Obs", 2078, 1000)
	seenOnB := 0
	// Walk east across x = 2048 (and well past the 2 m transfer depth).
	for i := 0; i < 14; i++ {
		p.walk(30, proto.InputFlagForward, eastYaw)
		o.pump(time.Millisecond)
		if o.frame != nil && o.frame.Find(id) != nil {
			seenOnB++
		}
	}
	p.settle()
	if p.active != "zone-b" || p.switches != 1 {
		t.Fatalf("expected one switch to zone-b, active %s switches %d log %v kicks %v", p.active, p.switches, p.switchLog, p.kicks)
	}
	if p.mismatches != 0 || p.maxErrCm != 0 {
		t.Fatalf("prediction diverged across the handoff: %d mismatches, max %d cm over %d checks (%v)", p.mismatches, p.maxErrCm, p.checks, p.switchLog)
	}
	if p.sim.Pos.X < 2050 {
		t.Fatalf("did not walk far enough: %v", p.sim.Pos)
	}
	// The observer on B saw P as a mirror before the handoff and as a local
	// entity after, under the same id.
	if seenOnB < 10 {
		t.Fatalf("observer on B saw P in only %d of 14 samples", seenOnB)
	}
	st := b.srv.ClusterStats()
	if st["handoffs_in"] != 1 || a.srv.ClusterStats()["handoffs_out"] != 1 {
		t.Fatalf("stats a %v b %v", a.srv.ClusterStats(), st)
	}
	if a.srv.Players() != 0 || b.srv.Players() != 2 {
		t.Fatalf("players a %d b %d", a.srv.Players(), b.srv.Players())
	}

	// Walk back: A kept the old connection as a standby, no new pre-connect.
	pre := a.srv.ClusterStats()["preconnects"]
	for i := 0; i < 10; i++ {
		p.walk(30, proto.InputFlagForward, -eastYaw)
	}
	p.settle()
	if p.active != "zone-a" || p.switches != 2 {
		t.Fatalf("expected a switch back to zone-a, active %s switches %d log %v", p.active, p.switches, p.switchLog)
	}
	if p.mismatches != 0 {
		t.Fatalf("prediction diverged on the way back: %d mismatches, max %d cm", p.mismatches, p.maxErrCm)
	}
	if got := a.srv.ClusterStats()["preconnects"]; got != pre {
		t.Fatalf("A issued %d new pre-connects for the way back (its standby should have been reused)", got-pre)
	}
}

func TestObserverOnOldZoneKeepsTrackOfTransferredPlayer(t *testing.T) {
	_, a, b := twoZones(t, nil)
	p := newHoClient(t, a, "char-p", "Pat", 2030, 1500)
	o := newHoClient(t, a, "char-o", "Obs", 2020, 1500) // stays on A, watching P walk east
	id := p.welc.EntityID
	missing := 0
	for i := 0; i < 20; i++ {
		p.walk(20, proto.InputFlagForward, eastYaw)
		o.walk(2, 0, 0)
		if o.frame == nil || o.frame.Find(id) == nil {
			missing++
		}
		for _, r := range o.snapRemoved() {
			if r == id {
				t.Fatalf("observer got a removal for P at sample %d (%v)", i, p.switchLog)
			}
		}
	}
	if p.active != "zone-b" {
		t.Fatalf("P was not handed off: %v", p.switchLog)
	}
	if missing > 1 { // the very first sample can predate first sight
		t.Fatalf("observer lost P in %d samples", missing)
	}
	_ = b
}

func (c *hoClient) snapRemoved() []uint32 {
	if c.snap == nil {
		return nil
	}
	return c.snap.Removed
}

func TestPlayerWithoutPreconnectStaysWithOldOwner(t *testing.T) {
	_, a, _ := twoZones(t, nil)
	p := newHoClient(t, a, "char-p", "Pat", 2040, 1000)
	p.ignoreTransfers()
	for i := 0; i < 10; i++ {
		p.walk(30, proto.InputFlagForward, eastYaw)
	}
	p.settle()
	if p.active != "zone-a" || a.srv.Players() != 1 {
		t.Fatalf("a player who never pre-connected must stay with A (active %s)", p.active)
	}
	if p.sim.Pos.X < 2060 || p.mismatches != 0 {
		t.Fatalf("A must keep simulating past its border: x %v mismatches %d", p.sim.Pos.X, p.mismatches)
	}
}

// ignoreTransfers drops ZoneTransfer messages (a client that cannot reach
// the neighbor zone).
func (c *hoClient) ignoreTransfers() {
	inner := c.msgs
	out := make(chan hoMsg, 8192)
	go func() {
		for hm := range inner {
			if _, ok := hm.m.(*proto.ZoneTransfer); ok {
				continue
			}
			out <- hm
		}
	}()
	c.msgs = out
}

func TestDuplicateLoginAcrossZonesTakesLiveState(t *testing.T) {
	_, a, b := twoZones(t, nil)
	p := newHoClient(t, a, "char-p", "Pat", 1000, 1000)
	p.walk(60, proto.InputFlagForward|proto.InputFlagSprint, 0.5)
	p.settle()
	live := p.sim.Pos
	// The same character logs in on B (e.g. a reconnect routed there).
	q := newHoClient(t, b, "char-p", "Pat", 3000, 3000)
	if math.Abs(proto.CmToMeters(q.welc.X)-live.X) > 0.01 || math.Abs(proto.CmToMeters(q.welc.Z)-live.Z) > 0.01 {
		t.Fatalf("B should continue from the live state %v, welcomed at %d,%d", live, q.welc.X, q.welc.Z)
	}
	if q.welc.EntityID != p.welc.EntityID {
		t.Fatalf("entity id %d vs %d", q.welc.EntityID, p.welc.EntityID)
	}
	p.pump(200 * time.Millisecond)
	if len(p.kicks) == 0 || !strings.Contains(p.kicks[0], fmt.Sprintf(":%d ", proto.KickCodeDuplicateLogin)) {
		t.Fatalf("old session should be kicked duplicate_login: %v", p.kicks)
	}
	if a.srv.Players() != 0 || b.srv.Players() != 1 {
		t.Fatalf("players a %d b %d", a.srv.Players(), b.srv.Players())
	}
	if b.srv.ClusterStats()["handoffs_in"] != 0 || a.srv.ClusterStats()["released"] != 1 {
		t.Fatalf("stats a %v b %v", a.srv.ClusterStats(), b.srv.ClusterStats())
	}
}

func TestPresenceFeedFillsFarRingAcrossZones(t *testing.T) {
	_, a, b := twoZones(t, nil)
	far := newHoClient(t, b, "char-f", "Far", 2400, 1000) // 352 m east of the border: no ghost band
	o := newHoClient(t, a, "char-o", "Obs", 1900, 1000)   // 500 m away on A
	deadline := time.Now().Add(4 * time.Second)
	for {
		o.walk(2, 0, 0)
		far.walk(2, 0, 0)
		if o.frame != nil && o.frame.Find(far.welc.EntityID) != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("far player on B never appeared on A through the presence feed")
		}
	}
}

// ---- checkpoint fencing ----

type fenceStore struct {
	mu    sync.Mutex
	epoch map[string]int64
	pos   map[string]movement.Vec3
	fence int
}

func (f *fenceStore) LoadPosition(context.Context, string) (movement.Vec3, bool, error) {
	return movement.Vec3{}, false, nil
}
func (f *fenceStore) SavePosition(_ context.Context, id string, p movement.Vec3) error {
	return f.SavePositionEpoch(context.Background(), id, p, 0)
}
func (f *fenceStore) SavePositionEpoch(_ context.Context, id string, p movement.Vec3, e int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if e < f.epoch[id] {
		f.fence++
		return ErrFenced
	}
	f.epoch[id], f.pos[id] = e, p
	return nil
}

func TestStaleCheckpointIsFencedAfterHandoff(t *testing.T) {
	store := &fenceStore{epoch: map[string]int64{}, pos: map[string]movement.Vec3{}}
	qa := writebehind.New(100)
	qb := writebehind.New(100)
	_, a, b := twoZones(t, func(c *Config) {
		c.Store = store
		c.SaveInterval = 300 * time.Millisecond // B checkpoints soon after admission
		if c.ZoneID == "zone-a" {
			c.Queue = qa
		} else {
			c.Queue = qb
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go qb.Run(ctx) // A's queue is "stuck" (Postgres slow from A) until later
	p := newHoClient(t, a, "char-p", "Pat", 2030, 1000)
	for i := 0; i < 14 && p.active != "zone-b"; i++ {
		p.walk(30, proto.InputFlagForward, eastYaw)
	}
	p.walk(30, proto.InputFlagForward, eastYaw)
	p.settle()
	if p.active != "zone-b" {
		t.Fatalf("no handoff: %v", p.switchLog)
	}
	// B checkpoints (periodically) with a newer epoch; then A's stale queue drains.
	time.Sleep(700 * time.Millisecond)
	go qa.Run(ctx)
	time.Sleep(300 * time.Millisecond)
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.fence == 0 {
		t.Fatalf("A's late checkpoint was not fenced (epoch %d, pos %v)", store.epoch["char-p"], store.pos["char-p"])
	}
	if store.pos["char-p"].X < 2050 {
		t.Fatalf("stored position regressed to A's: %v", store.pos["char-p"])
	}
	_ = b
}

// Regression (soak smoke run): a standby connection re-admitted after an
// earlier activation on the same zone must take the handed-over progress,
// not the progress it carried from that earlier activation (which lacked a
// discovery made on the other zone: granted twice).
func TestReadmissionTakesHandedOverProgress(t *testing.T) {
	s := New(Config{ZoneID: "z", WorldID: testWorld, Cluster: newMemHub().zone("z"), Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	s.cl.c = s.cfg.Cluster
	old := explore.NewProgress()
	sess := &session{ho: &sessHandoff{}, x: &exploreState{prog: old}}
	fresh := explore.NewProgress()
	fresh.XP = 50
	sess.ho.state = &HandoffState{Progress: fresh, Move: movement.NewState(movement.Vec3{X: 1, Z: 2})}
	s.resetForAdmission(sess)
	e := &Entity{CharacterID: "c"}
	s.joinState(sess, e)
	if sess.x == nil || sess.x.prog.XP != 50 {
		t.Fatalf("re-admitted session kept stale progress: %+v", sess.x)
	}
}
