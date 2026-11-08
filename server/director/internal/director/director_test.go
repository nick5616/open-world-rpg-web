package director

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"lodestone/server/pkg/accountapi"
	"lodestone/server/pkg/accountapi/dbtest"
	"lodestone/server/pkg/localsave"
	"lodestone/server/pkg/svc"
	"lodestone/server/pkg/ticket"
	"lodestone/server/pkg/zoneregistry"
)

// Integration: real HTTP server, scratch Postgres, shared Redis. Zones are
// faked by announcing registry entries, exactly what WP03's zone does.

type harness struct {
	t         *testing.T
	srv       *httptest.Server
	d         *Director
	sessPriv  ed25519.PrivateKey
	ticketPub ed25519.PublicKey
	saves     *localsave.Store // with the private key, standing in for account/zone
	world     accountapi.World
}

func newHarness(t *testing.T) *harness {
	pool, _ := dbtest.Postgres(t)
	rdb := dbtest.Redis(t)
	sessPub, sessPriv, _ := ed25519.GenerateKey(rand.Reader)
	tPub, tPriv, _ := ed25519.GenerateKey(rand.Reader)
	sPub, sPriv, _ := ed25519.GenerateKey(rand.Reader)
	db := accountapi.DB{Pool: pool}
	w, _, err := db.EnsureOfficialWorld(context.Background(), accountapi.World{Name: "T", Seed: "1", Spec: json.RawMessage(`{}`), GenVersion: "p", AtlasHash: "p"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { rdb.Del(context.Background(), zoneregistry.Key(w.ID)) })
	d := &Director{
		DB: db, RDB: rdb, SessionPub: sessPub, TicketPriv: tPriv,
		Saves:          &localsave.Store{RDB: rdb, Pub: sPub, AdoptMissing: true},
		SocialEndpoint: "ws://social.test/ws",
		Log:            slog.New(slog.NewTextHandler(io.Discard, nil)), Metrics: svc.NewMetrics(),
	}
	mux := http.NewServeMux()
	d.Register(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return &harness{t: t, srv: srv, d: d, sessPriv: sessPriv, ticketPub: tPub, world: w,
		saves: &localsave.Store{RDB: rdb, Priv: sPriv, Pub: sPub, AdoptMissing: true}}
}

func (h *harness) session(kind, subject string) string {
	tok, _ := accountapi.SignSession(h.sessPriv, accountapi.Session{Kind: kind, Subject: subject, Provider: "dev"}, time.Now(), time.Hour)
	return tok
}

func (h *harness) post(path, tok string, body any, out any) (int, http.Header) {
	h.t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", h.srv.URL+path, bytes.NewReader(b))
	if tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			h.t.Fatalf("decode %q: %v", raw, err)
		}
	}
	return resp.StatusCode, resp.Header
}

func (h *harness) announce(e zoneregistry.Entry) {
	if err := zoneregistry.Announce(context.Background(), h.d.RDB, h.world.ID, e); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) accountCharacter(user, name string, pos localsave.Vec3) (string, accountapi.Character) {
	ctx := context.Background()
	acc, _ := h.d.DB.UpsertAccount(ctx, "dev", user)
	c, err := h.d.DB.CreateCharacter(ctx, accountapi.Owner{Kind: accountapi.KindAccount, ID: acc.ID}, h.world.ID, name, nil, pos)
	if err != nil {
		h.t.Fatal(err)
	}
	return h.session(accountapi.KindAccount, acc.ID), c
}

func TestConnectWakingWorld(t *testing.T) {
	h := newHarness(t)
	tok, c := h.accountCharacter("alice", "Nicole", accountapi.SpawnPosition())
	var e apiError
	st, hdr := h.post("/v1/connect", tok, ConnectRequest{CharacterID: c.ID}, &e)
	if st != 503 || e.Error != "waking_world" || e.RetryAfterS != 5 || hdr.Get("Retry-After") != "5" {
		t.Fatal(st, e, hdr)
	}
	// A stale entry (crashed zone) is the same as none.
	h.announce(zoneregistry.Entry{ZoneID: "dead", Endpoint: "ws://dead"})
	_, _ = h.d.RDB.HSet(context.Background(), zoneregistry.Key(h.world.ID), "dead", `{"zoneId":"dead","endpoint":"ws://dead","heartbeatMs":1}`).Result()
	if st, _ := h.post("/v1/connect", tok, ConnectRequest{CharacterID: c.ID}, nil); st != 503 {
		t.Fatal("stale zone used", st)
	}
}

func TestConnectIssuesVerifiableTickets(t *testing.T) {
	h := newHarness(t)
	h.announce(zoneregistry.Entry{ZoneID: "z-west", Endpoint: "ws://west/ws", Regions: []zoneregistry.Region{{X: 0, Z: 0}, {X: 1, Z: 0}}})
	h.announce(zoneregistry.Entry{ZoneID: "z-rest", Endpoint: "ws://rest/ws", WTEndpoint: "https://rest/wt"})
	tok, c := h.accountCharacter("alice", "Nicole", localsave.Vec3{X: 1500, Y: 10, Z: 200}) // region (1,0)

	var resp ConnectResponse
	if st, _ := h.post("/v1/connect", tok, ConnectRequest{CharacterID: c.ID}, &resp); st != 200 {
		t.Fatal(st)
	}
	if resp.Zone.ZoneID != "z-west" || resp.Region != (zoneregistry.Region{X: 1, Z: 0}) || resp.SocialEndpoint != "ws://social.test/ws" {
		t.Fatalf("%+v", resp)
	}
	now := time.Now()
	cl, err := ticket.Verify(h.ticketPub, resp.Ticket, ticket.AudienceZone("z-west"), now)
	if err != nil {
		t.Fatal("zone ticket:", err)
	}
	if cl.CharacterID != c.ID || cl.CharacterName != "Nicole" || cl.WorldID != h.world.ID || cl.AccountID == "" || cl.IsLocalProfile {
		t.Fatalf("%+v", cl)
	}
	if cl.ExpiresAt.Sub(cl.IssuedAt) != 60*time.Second {
		t.Fatal("ticket TTL", cl.ExpiresAt.Sub(cl.IssuedAt))
	}
	if _, err := ticket.Verify(h.ticketPub, resp.Ticket, ticket.AudienceZone("z-rest"), now); !errors.Is(err, ticket.ErrAudience) {
		t.Fatal("zone ticket valid for another zone", err)
	}
	if _, err := ticket.Verify(h.ticketPub, resp.SocialTicket, ticket.AudienceSocial, now); err != nil {
		t.Fatal("social ticket:", err)
	}
	if _, err := ticket.Verify(h.ticketPub, resp.Ticket, ticket.AudienceSocial, now); err == nil {
		t.Fatal("zone ticket accepted as social")
	}

	// A character elsewhere goes to the whole-world zone.
	tok2, c2 := h.accountCharacter("bob", "Faraway", localsave.Vec3{X: 4000, Z: 4000})
	if st, _ := h.post("/v1/connect", tok2, ConnectRequest{CharacterID: c2.ID}, &resp); st != 200 || resp.Zone.ZoneID != "z-rest" || resp.Zone.WTEndpoint != "https://rest/wt" {
		t.Fatal(st, resp.Zone)
	}

	// Social-only re-issue.
	var soc map[string]any
	if st, _ := h.post("/v1/social-ticket", tok, map[string]string{"characterId": c.ID}, &soc); st != 200 {
		t.Fatal(st)
	}
	if _, err := ticket.Verify(h.ticketPub, soc["socialTicket"].(string), ticket.AudienceSocial, now); err != nil {
		t.Fatal(err)
	}
}

func TestConnectAuthz(t *testing.T) {
	h := newHarness(t)
	h.announce(zoneregistry.Entry{ZoneID: "z", Endpoint: "ws://z"})
	tok, c := h.accountCharacter("alice", "Nicole", accountapi.SpawnPosition())
	bobTok, _ := h.accountCharacter("bob", "Bobby", accountapi.SpawnPosition())
	var e apiError
	if st, _ := h.post("/v1/connect", "", ConnectRequest{CharacterID: c.ID}, &e); st != 401 {
		t.Fatal(st)
	}
	if st, _ := h.post("/v1/connect", bobTok, ConnectRequest{CharacterID: c.ID}, &e); st != 404 {
		t.Fatal("someone else's character", st)
	}
	if st, _ := h.post("/v1/connect", tok, ConnectRequest{CharacterID: "nope"}, &e); st != 400 {
		t.Fatal(st)
	}
	expired, _ := accountapi.SignSession(h.sessPriv, accountapi.Session{Kind: "account", Subject: c.AccountID}, time.Now().Add(-2*time.Hour), time.Hour)
	if st, _ := h.post("/v1/connect", expired, ConnectRequest{CharacterID: c.ID}, &e); st != 401 {
		t.Fatal("expired session", st)
	}
	_, _ = h.d.DB.Pool.Exec(context.Background(), `UPDATE accounts SET status = 'banned' WHERE id = $1`, c.AccountID)
	if st, _ := h.post("/v1/connect", tok, ConnectRequest{CharacterID: c.ID}, &e); st != 403 || e.Error != "account_banned" {
		t.Fatal("banned account got a ticket", st, e)
	}
}

func TestConnectLocalProfile(t *testing.T) {
	h := newHarness(t)
	h.announce(zoneregistry.Entry{ZoneID: "z-ne", Endpoint: "ws://ne", Regions: []zoneregistry.Region{{X: 3, Z: 3}}})
	h.announce(zoneregistry.Entry{ZoneID: "z-all", Endpoint: "ws://all"})
	ctx := context.Background()
	profile := accountapi.NewUUID()
	t.Cleanup(func() { h.d.RDB.Del(context.Background(), localsave.Key(profile)) })
	if _, _, err := h.d.DB.ClaimLocalProfile(ctx, profile, []byte("hash")); err != nil {
		t.Fatal(err)
	}
	c, err := h.d.DB.CreateCharacter(ctx, accountapi.Owner{Kind: accountapi.KindLocal, ID: profile}, h.world.ID, "Wanderer", nil, accountapi.SpawnPosition())
	if err != nil {
		t.Fatal(err)
	}
	tok := h.session(accountapi.KindLocal, profile)
	st1 := localsave.NewCharacterState(c.ID, h.world.ID, c.Name, accountapi.SpawnPosition(), nil)
	b1, _ := h.saves.Issue(ctx, profile, c.ID, h.world.ID, st1.Marshal())
	moved := st1
	moved.Position = localsave.Vec3{X: 3900, Z: 3900} // walked to region (3,3)
	b2, _ := h.saves.Issue(ctx, profile, c.ID, h.world.ID, moved.Marshal())

	var resp ConnectResponse
	if st, _ := h.post("/v1/connect", tok, ConnectRequest{CharacterID: c.ID, Save: &b2}, &resp); st != 200 {
		t.Fatal(st)
	}
	if resp.Zone.ZoneID != "z-ne" || !resp.IsLocalProfile {
		t.Fatal("save position must pick the region", resp.Zone, resp.Region)
	}
	cl, err := ticket.Verify(h.ticketPub, resp.Ticket, ticket.AudienceZone("z-ne"), time.Now())
	if err != nil || !cl.IsLocalProfile || cl.ProfileID != profile || cl.AccountID != "" {
		t.Fatal(cl, err)
	}
	// Without a save: spawn region, any zone that owns it.
	if st, _ := h.post("/v1/connect", tok, ConnectRequest{CharacterID: c.ID}, &resp); st != 200 || resp.Zone.ZoneID != "z-all" {
		t.Fatal(st, resp.Zone)
	}
	var e apiError
	if st, _ := h.post("/v1/connect", tok, ConnectRequest{CharacterID: c.ID, Save: &b1}, &e); st != 409 || e.Error != "stale_save" {
		t.Fatal("old save", st, e)
	}
	bad := b2
	bad.State = strings.Replace(bad.State, `"level":1`, `"level":50`, 1)
	if st, _ := h.post("/v1/connect", tok, ConnectRequest{CharacterID: c.ID, Save: &bad}, &e); st != 400 || e.Error != "bad_signature" {
		t.Fatal("tampered save", st, e)
	}
	// Upgraded profiles get no more local tickets.
	acc, _ := h.d.DB.UpsertAccount(ctx, "dev", "upg")
	if _, err := h.d.DB.UpgradeLocalProfile(ctx, profile, acc.ID, map[string]localsave.State{c.ID: moved}); err != nil {
		t.Fatal(err)
	}
	if st, _ := h.post("/v1/connect", tok, ConnectRequest{CharacterID: c.ID}, &e); st != 410 {
		t.Fatal("upgraded profile", st, e)
	}
}

func TestWorldsAndStatus(t *testing.T) {
	h := newHarness(t)
	get := func(path string, out any) int {
		resp, err := http.Get(h.srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		_ = json.NewDecoder(resp.Body).Decode(out)
		return resp.StatusCode
	}
	var ws struct{ Worlds []accountapi.World }
	if get("/v1/worlds", &ws) != 200 || len(ws.Worlds) != 1 {
		t.Fatal(ws)
	}
	var s map[string]any
	get("/v1/worlds/"+h.world.ID+"/status", &s)
	if s["awake"] != false {
		t.Fatal(s)
	}
	h.announce(zoneregistry.Entry{ZoneID: "z", Endpoint: "ws://z", Players: 3})
	get("/v1/worlds/"+h.world.ID+"/status", &s)
	if s["awake"] != true || s["players"] != float64(3) {
		t.Fatal(s)
	}
}
