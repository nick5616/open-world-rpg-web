package social

import (
	"context"
	"crypto/ed25519"
	"log/slog"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/accountapi"
	"lodestone/server/pkg/accountapi/dbtest"
	sp "lodestone/server/pkg/socialproto"
	"lodestone/server/pkg/ticket"
	"lodestone/server/social/internal/client"
)

// testEnv is one in-process social hub on a scratch Postgres database and the
// shared Redis, with its own random world id so parallel agents and tests
// never see each other's keys.
type testEnv struct {
	t     *testing.T
	hub   *Hub
	url   string
	world string
	rdb   *redis.Client
	pool  *pgxpool.Pool
	priv  ed25519.PrivateKey
	chars []string
}

type player struct {
	ID, Name  string
	AccountID string
	ProfileID string
	Local     bool
}

func newEnv(t *testing.T, mod func(*Config)) *testEnv {
	t.Helper()
	pool, _ := dbtest.Postgres(t)
	rdb := dbtest.Redis(t)
	priv, _, _ := ticket.PrivateKeyFromEnv()
	cfg := Config{TicketPub: priv.Public().(ed25519.PublicKey), PingEvery: 5 * time.Second}
	if mod != nil {
		mod(&cfg)
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	hub := NewHub(cfg, rdb, &Store{Pool: pool}, log, nil)
	hub.Start()
	srv := httptest.NewServer(hub.Handler())
	e := &testEnv{t: t, hub: hub, url: "ws" + strings.TrimPrefix(srv.URL, "http"), world: accountapi.NewUUID(), rdb: rdb, pool: pool, priv: priv}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		hub.Stop(ctx)
		srv.Close()
		cleanupRedis(ctx, rdb, e.world, e.chars)
	})
	return e
}

// cleanupRedis removes every key a test world left behind in the shared Redis.
func cleanupRedis(ctx context.Context, rdb *redis.Client, world string, chars []string) {
	var keys []string
	iter := rdb.Scan(ctx, 0, "*"+world+"*", 1000).Iterator()
	for iter.Next(ctx) {
		keys = append(keys, iter.Val())
	}
	for _, c := range chars {
		keys = append(keys, keyPresence(c), keyCharName(c), keyPartyOf(c), keyPartyInv(c))
	}
	if len(keys) > 0 {
		rdb.Del(ctx, keys...)
	}
	rdb.SRem(ctx, keyWorlds, world)
}

func (e *testEnv) player(name string) *player {
	p := &player{ID: accountapi.NewUUID(), Name: name, AccountID: accountapi.NewUUID()}
	e.chars = append(e.chars, p.ID)
	return p
}

func (e *testEnv) localPlayer(name string) *player {
	p := &player{ID: accountapi.NewUUID(), Name: name, ProfileID: accountapi.NewUUID(), Local: true}
	e.chars = append(e.chars, p.ID)
	return p
}

func (e *testEnv) ticket(p *player) string {
	return ticket.Sign(e.priv, ticket.Claims{AccountID: p.AccountID, ProfileID: p.ProfileID, CharacterID: p.ID,
		CharacterName: p.Name, WorldID: e.world, Audience: ticket.AudienceSocial, IsLocalProfile: p.Local})
}

func signZoneTicket(e *testEnv, p *player) string {
	return ticket.Sign(e.priv, ticket.Claims{AccountID: p.AccountID, CharacterID: p.ID, CharacterName: p.Name,
		WorldID: e.world, Audience: ticket.AudienceZone("zone-1")})
}

func (e *testEnv) connect(p *player) *client.Client {
	e.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, w, err := client.Connect(ctx, e.url, e.ticket(p))
	if err != nil {
		e.t.Fatalf("connect %s: %v", p.Name, err)
	}
	if w.CharacterID != p.ID || w.Name != p.Name || w.IsLocalProfile != p.Local {
		e.t.Fatalf("welcome %+v for %+v", w, p)
	}
	e.t.Cleanup(c.Close)
	return c
}

func ctx5(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func send(t *testing.T, c *client.Client, v any) {
	t.Helper()
	if err := c.Send(ctx5(t), v); err != nil {
		t.Fatal(err)
	}
}

func must(t *testing.T, c *client.Client, what string, match func(client.Frame) bool) client.Frame {
	t.Helper()
	f, err := c.WaitFor(ctx5(t), match)
	if err != nil {
		t.Fatalf("waiting for %s: %v", what, err)
	}
	return f
}

func mustNew(t *testing.T, c *client.Client, from int, what string, match func(client.Frame) bool) client.Frame {
	t.Helper()
	f, err := c.WaitNew(ctx5(t), from, match)
	if err != nil {
		t.Fatalf("waiting for %s: %v", what, err)
	}
	return f
}

// never asserts no frame matching arrives within d.
func never(t *testing.T, c *client.Client, what string, d time.Duration, match func(client.Frame) bool) {
	t.Helper()
	time.Sleep(d)
	if n := c.Count(match); n > 0 {
		t.Fatalf("%s: got %d unexpected frame(s)", what, n)
	}
}

func chat(ch sp.Channel, text string) sp.C2SChatSend {
	return sp.C2SChatSend{Type: sp.C2STypeChatSend, Channel: ch, Text: text}
}

func presence(region string, x, z float64, zone string) sp.C2SPresence {
	return sp.C2SPresence{Type: sp.C2STypePresence, Region: region, X: x, Z: z, ZoneID: zone}
}

func partyStateWith(n int, leader string) func(client.Frame) bool {
	return func(f client.Frame) bool {
		if f.Type != sp.S2CTypePartyState {
			return false
		}
		var ps sp.S2CPartyState
		return f.Decode(&ps) == nil && len(ps.Members) == n && (leader == "" || ps.LeaderID == leader)
	}
}

func lastPartyState(c *client.Client) (sp.S2CPartyState, bool) {
	var ps sp.S2CPartyState
	ok := false
	for _, f := range c.Frames() {
		if f.Type == sp.S2CTypePartyState {
			_ = f.Decode(&ps)
			ok = true
		}
		if f.Type == sp.S2CTypePartyLeft {
			ok = false
		}
	}
	return ps, ok
}

func partyInvite(c *client.Client, t *testing.T) sp.S2CPartyInvite {
	t.Helper()
	var inv sp.S2CPartyInvite
	_ = must(t, c, "party invite", client.Type(sp.S2CTypePartyInvite)).Decode(&inv)
	return inv
}
