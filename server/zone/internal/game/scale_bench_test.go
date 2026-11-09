package game

// WP19 scale benchmarks: the whole zone tick (inputs, movement, combat AI,
// grid, snapshots) driven in-process at spec 14 scenario 1's size, 300
// players in one region plus 2,000 awake enemies, on flat ground with fake
// connections. No sockets and no wazero, so `go test -cpuprofile` is safe on
// Windows (the zone's live profiler once crashed unwinding wazero JIT frames,
// WP16), and the numbers isolate the tick from the machine's network stack.
//
//	go test ./internal/game -run '^$' -bench Scale -benchtime 600x -cpu 4
//	go test ./internal/game -run '^$' -bench 'Scale/p300_e2000' -benchtime 900x -cpu 4 -cpuprofile cpu.out
//
// -cpu 4 matches spec 9's "4 vCPU" budget line. Each op is one tick; the
// benchmark reports tick p50/p99/max in ms next to ns/op.

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"math"
	"math/rand"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/ratelimit"
	"lodestone/server/pkg/ticket"
	"lodestone/server/pkg/transport"
)

// benchConn is a transport.Conn that counts what the zone sends.
type benchConn struct {
	stats transport.Stats
	done  chan struct{}
}

func newBenchConn() *benchConn { return &benchConn{done: make(chan struct{})} }

func (c *benchConn) Kind() proto.Transport { return proto.TransportWebsocket }
func (c *benchConn) RemoteAddr() string    { return "bench" }
func (c *benchConn) Recv(ctx context.Context) ([]byte, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}
func (c *benchConn) SendReliable(b []byte) error {
	c.stats.BytesOut.Add(int64(len(b)))
	c.stats.FramesOut.Add(1)
	return nil
}
func (c *benchConn) SendUnreliable(b []byte) bool {
	c.stats.BytesOut.Add(int64(len(b)))
	c.stats.FramesOut.Add(1)
	return true
}
func (c *benchConn) SetReadLimit(int64)      {}
func (c *benchConn) Close(int, string)       {}
func (c *benchConn) Done() <-chan struct{}   { return c.done }
func (c *benchConn) Stats() *transport.Stats { return &c.stats }

// benchBot is a scripted walker: heading changes every 2-6 s, steering back
// into the disc, like tools/bots' walker persona.
type benchBot struct {
	sess     *session
	seq      uint32
	yaw      float64
	heading  float64
	nextTurn int
	idle     bool
}

type scaleWorld struct {
	srv    *Server
	bots   []*benchBot
	rng    *rand.Rand
	cx, cz float64
	radius float64
	// ackLag is how many ticks behind the newest snapshot each client's ack
	// is (a ~100 ms round trip at 30 Hz).
	ackLag uint32
}

// newScaleWorld builds a zone with players walking in a disc and enemy
// camps of four spread over the same disc (so every camp has a player
// within ENEMY_WAKE_M and stays awake).
func newScaleWorld(tb testing.TB, players, enemies int, radius float64) *scaleWorld {
	return newScaleWorldConn(tb, players, enemies, radius, func() transport.Conn { return newBenchConn() })
}

// newScaleWorldConn is newScaleWorld with a connection factory. The zone
// clock is simulated (one tick = 1/30 s) and the frame budget is lifted, so
// a run is deterministic however fast the machine ticks.
func newScaleWorldConn(tb testing.TB, players, enemies int, radius float64, mk func() transport.Conn) *scaleWorld {
	tb.Helper()
	dry := false
	clock := time.Unix(1_800_000_000, 0)
	var srv *Server
	cfg := Config{ZoneID: testZone, WorldID: testWorld, Seed: 42, GenVersion: "g1", DevSpawn: true,
		MaxPlayers: players + 10, DownBudgetKbps: 150, Rain: &dry,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Now: func() time.Time { return clock.Add(time.Duration(srv.tick) * time.Second / 30) }}
	srv = New(cfg)
	w := &scaleWorld{srv: srv, rng: rand.New(rand.NewSource(7)), cx: 1536, cz: 1536, radius: radius, ackLag: 3}
	keys := [][]string{{"boar", "boar", "wolf", "wolf"}, {"cutthroat", "archer", "cutthroat", "brute"}, {"ember_imp", "mud_golem", "shade", "void_mite"}, {"ram", "stalker", "scuttler", "lurker"}}
	groups := enemies / 4
	for g := 0; g < groups; g++ {
		// Sunflower spiral: even coverage of the disc.
		r := radius * math.Sqrt((float64(g)+0.5)/float64(groups))
		a := float64(g) * 2.399963229728653
		at := movement.Vec3{X: w.cx + r*math.Cos(a), Z: w.cz + r*math.Sin(a)}
		srv.CombatWorld().TestGroup(at, keys[g%len(keys)], 3, "")
	}
	for i := 0; i < players; i++ {
		r := radius * math.Sqrt(w.rng.Float64())
		a := w.rng.Float64() * 2 * math.Pi
		spawn := movement.Vec3{X: w.cx + r*math.Cos(a), Z: w.cz + r*math.Sin(a)}
		sess := &session{conn: mk(), joined: make(chan struct{}), buckets: newBuckets(),
			frameBudget: ratelimit.New(1e12, 1e12), spawn: spawn,
			claims: ticket.Claims{CharacterID: fmt.Sprintf("bench-%04d", i), CharacterName: fmt.Sprintf("Bench%04d", i)}}
		srv.join(sess)
		b := &benchBot{sess: sess, yaw: a, heading: a, idle: i%5 == 4}
		w.bots = append(w.bots, b)
	}
	return w
}

// feed queues one Input (two new 60 Hz frames plus one repeat, like the
// client) per bot, acking a snapshot ackLag ticks old.
func (w *scaleWorld) feed() {
	tick := w.srv.tick
	for _, b := range w.bots {
		e := b.sess.ent
		if tick >= uint32(b.nextTurn) {
			b.nextTurn = int(tick) + 60 + w.rng.Intn(120)
			b.heading = w.rng.Float64() * 2 * math.Pi
		}
		dx, dz := w.cx-e.Move.Pos.X, w.cz-e.Move.Pos.Z
		if math.Hypot(dx, dz) > w.radius {
			b.heading = math.Atan2(-dx, -dz)
		}
		diff := math.Remainder(b.heading-b.yaw, 2*math.Pi)
		b.yaw += math.Max(-0.1, math.Min(0.1, diff))
		var flags uint16
		if !b.idle {
			flags = proto.InputFlagForward
		}
		in := &proto.Input{Frames: make([]proto.InputFrame, 0, 3)}
		if tick > w.ackLag {
			in.AckTick = tick - w.ackLag
		}
		if b.seq > 0 {
			in.Frames = append(in.Frames, proto.InputFrame{Seq: b.seq, Flags: flags, Yaw: proto.YawToU16(b.yaw)})
		}
		for k := 0; k < 2; k++ {
			b.seq++
			in.Frames = append(in.Frames, proto.InputFrame{Seq: b.seq, Flags: flags, Yaw: proto.YawToU16(b.yaw)})
		}
		b.sess.mu.Lock()
		b.sess.inbox = append(b.sess.inbox, in)
		b.sess.mu.Unlock()
	}
}

// step runs one tick and returns its duration.
func (w *scaleWorld) step() time.Duration {
	w.feed()
	t0 := time.Now()
	w.srv.onTick()
	return time.Since(t0)
}

func (w *scaleWorld) awakeEnemies() int {
	n := 0
	for _, e := range w.srv.CombatWorld().Enemies() {
		if e.State != 0 { // combat.Asleep
			n++
		}
	}
	return n
}

func (w *scaleWorld) bytesOut() int64 {
	var n int64
	for _, b := range w.bots {
		n += b.sess.conn.Stats().BytesOut.Load()
	}
	return n
}

var benchSink atomic.Int64

func BenchmarkScale(b *testing.B) {
	for _, c := range []struct {
		players, enemies int
		radius           float64
	}{
		{150, 0, 300},
		{300, 0, 300},
		{300, 2000, 300},
		{460, 0, 450},
	} {
		b.Run(fmt.Sprintf("p%d_e%d", c.players, c.enemies), func(b *testing.B) {
			w := newScaleWorld(b, c.players, c.enemies, c.radius)
			// Warm up: groups spawn at 1 Hz and wake at 2 Hz; first-sight
			// records and the byte budget settle in a few seconds.
			for i := 0; i < 150; i++ {
				w.step()
			}
			durs := make([]time.Duration, 0, b.N)
			bytes0 := w.bytesOut()
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				durs = append(durs, w.step())
			}
			b.StopTimer()
			slices.Sort(durs)
			q := func(p float64) float64 {
				return float64(durs[min(len(durs)-1, int(p*float64(len(durs))))].Microseconds()) / 1000
			}
			b.ReportMetric(q(0.5), "p50-ms")
			b.ReportMetric(q(0.99), "p99-ms")
			b.ReportMetric(float64(durs[len(durs)-1].Microseconds())/1000, "max-ms")
			b.ReportMetric(float64(len(w.srv.ents)), "ents")
			b.ReportMetric(float64(w.awakeEnemies()), "awake")
			secs := float64(b.N) / 30
			b.ReportMetric(float64(w.bytesOut()-bytes0)*8/1000/secs/float64(len(w.bots)), "kbps/client")
			benchSink.Add(int64(len(durs)))
		})
	}
}

// TestScaleWorldSmoke keeps the benchmark harness honest: enemies spawn and
// wake around the players and every client gets snapshots.
func TestScaleWorldSmoke(t *testing.T) {
	if testing.Short() {
		t.Skip("scale smoke")
	}
	w := newScaleWorld(t, 40, 200, 150)
	for i := 0; i < 120; i++ {
		w.step()
	}
	if got := w.awakeEnemies(); got < 150 {
		t.Fatalf("awake enemies %d, want most of 200", got)
	}
	for _, b := range w.bots {
		if b.sess.conn.Stats().FramesOut.Load() < 100 {
			t.Fatalf("client %s got %d frames", b.sess.claims.CharacterID, b.sess.conn.Stats().FramesOut.Load())
		}
	}
}
