package game

// Playtest 2: "when i added my friend, it teleported us to our respective
// spawns". Adding a friend never touches the zone; what moved them was the
// reconnect that happened at the same time (the live zone was restarted /
// redeployed while they played). Local profiles (everyone on the live
// deploy: no Google sign-in yet) carry their position in the signed save
// blob they present on connect, and the zone only re-issued that blob when
// other progress changed, never on its way down: so any reconnect, zone
// restart or page reload put a player who had only walked around back at
// the position of their first blob, their spawn. Now a local profile who
// moved gets a new blob at the checkpoint, and a shutting-down zone sends
// every local profile a last blob before the kick.

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/env"
	"lodestone/server/pkg/localsave"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/ticket"
	"lodestone/server/pkg/writebehind"
)

func localSavesForTest(t *testing.T) (*localsave.Store, *redis.Client) {
	t.Helper()
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
	return &localsave.Store{RDB: rdb, Priv: priv, Pub: priv.Public().(ed25519.PublicKey), AdoptMissing: true}, rdb
}

// blobPos waits for a SaveBlob and returns it with its position.
func blobPos(t *testing.T, cl *client, timeout time.Duration) ([]byte, localsave.Vec3) {
	t.Helper()
	sb := cl.next(proto.MsgSaveBlob, timeout).(*proto.SaveBlob)
	var b localsave.Blob
	if err := json.Unmarshal(sb.Blob, &b); err != nil {
		t.Fatal(err)
	}
	st, err := b.DecodeState()
	if err != nil {
		t.Fatal(err)
	}
	return sb.Blob, st.Position
}

func TestLocalProfilePositionSurvivesReconnectAndRestart(t *testing.T) {
	saves, rdb := localSavesForTest(t)
	newQ := func() (*writebehind.Queue, context.CancelFunc) {
		q := writebehind.New(100)
		q.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
		ctx, stop := context.WithCancel(context.Background())
		go q.Run(ctx)
		return q, stop
	}
	q1, stop1 := newQ()
	defer stop1()
	h := exploreHarness(t, func(c *Config) { c.Saves = saves; c.Queue = q1; c.SaveInterval = 300 * time.Millisecond })

	profile, char := "pt2-pos-profile-"+time.Now().Format("150405.000"), "pt2-pos-char"
	defer rdb.Del(context.Background(), localsave.Key(profile))
	start := localsave.Vec3{X: 1700, Y: 0, Z: 1700}
	st := localsave.NewCharacterState(char, testWorld, "Walker", start, nil)
	ctx := context.Background()
	b0, err := saves.Issue(ctx, profile, char, testWorld, st.Marshal())
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(b0)
	hello := func(h *harness, blob []byte) *client {
		cl := h.dial("")
		cl.send(&proto.Hello{ProtocolVersion: proto.ProtocolVersion, Transport: proto.TransportWebsocket, SaveBlob: blob,
			Ticket: h.ticket(char, "Walker", func(c *ticket.Claims) { c.AccountID = ""; c.ProfileID = profile; c.IsLocalProfile = true })})
		return cl
	}
	a := hello(h, raw)
	w := a.next(proto.MsgWelcome, 3*time.Second).(*proto.Welcome)
	if math.Abs(proto.CmToMeters(w.X)-start.X) > 0.5 {
		t.Fatalf("spawned at %+v", w.ToJSON())
	}

	// 1. Only walk (no discovery, no item, no quest change): the next
	// checkpoint issues a blob at the new spot.
	moveTo := func(x, z float64) {
		_ = h.srv.Do(ctx, func() {
			e := h.srv.byChar[char].ent
			h.srv.Teleport(e, movement.Vec3{X: x, Y: h.srv.cfg.Ground.HeightAt(x, z), Z: z})
		})
	}
	moveTo(start.X+30, start.Z)
	var last []byte
	deadline := time.Now().Add(5 * time.Second)
	for {
		blob, p := blobPos(t, a, 5*time.Second)
		last = blob
		if math.Abs(p.X-(start.X+30)) < 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no blob at the walked-to spot (last %+v)", p)
		}
	}
	a.c.Close(1000, "")
	time.Sleep(200 * time.Millisecond)
	b := hello(h, last)
	w = b.next(proto.MsgWelcome, 3*time.Second).(*proto.Welcome)
	if math.Abs(proto.CmToMeters(w.X)-(start.X+30)) > 1 || math.Abs(proto.CmToMeters(w.Z)-start.Z) > 1 {
		t.Fatalf("reconnected at (%.1f, %.1f), want where the player walked to (%.1f, %.1f)", proto.CmToMeters(w.X), proto.CmToMeters(w.Z), start.X+30, start.Z)
	}

	// 2. A zone restart right after a move (before any checkpoint): the
	// shutdown's last blob carries the spot; the next zone spawns there.
	for len(b.msgs) > 0 { // drop the join-time blobs
		<-b.msgs
	}
	_ = h.srv.Do(ctx, func() { h.srv.saveDiv = 1 << 30 }) // no checkpoint in between
	moveTo(start.X+30, start.Z+40)
	b.pump(100 * time.Millisecond)
	for len(b.msgs) > 0 {
		<-b.msgs
	}
	go h.srv.Stop(ctx)
	var final []byte
	deadline = time.Now().Add(5 * time.Second)
	for final == nil && time.Now().Before(deadline) {
		m, ok := <-b.msgs
		if !ok {
			break
		}
		if sb, ok := m.(*proto.SaveBlob); ok {
			var nb localsave.Blob
			_ = json.Unmarshal(sb.Blob, &nb)
			if ns, err := nb.DecodeState(); err == nil && math.Abs(ns.Position.Z-(start.Z+40)) < 1 {
				final = sb.Blob
			}
		}
	}
	if final == nil {
		t.Fatal("no final blob at the last position before the shutdown kick")
	}
	q2, stop2 := newQ()
	defer stop2()
	h2 := exploreHarness(t, func(c *Config) { c.Saves = saves; c.Queue = q2 })
	c := hello(h2, final)
	w = c.next(proto.MsgWelcome, 3*time.Second).(*proto.Welcome)
	if math.Abs(proto.CmToMeters(w.Z)-(start.Z+40)) > 1 {
		t.Fatalf("after the restart at (%.1f, %.1f), want z %.1f", proto.CmToMeters(w.X), proto.CmToMeters(w.Z), start.Z+40)
	}
}
