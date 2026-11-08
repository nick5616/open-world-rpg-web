package api

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"lodestone/server/account/internal/firebase"
	"lodestone/server/pkg/accountapi"
	"lodestone/server/pkg/accountapi/dbtest"
	"lodestone/server/pkg/localsave"
	"lodestone/server/pkg/svc"
)

// Integration tests: a real HTTP server (httptest, over TCP) in front of the
// handlers, a scratch Postgres database and the shared Redis.

type harness struct {
	t   *testing.T
	srv *httptest.Server
	api *API
}

func newHarness(t *testing.T, mut func(*API)) *harness {
	pool, _ := dbtest.Postgres(t)
	rdb := dbtest.Redis(t)
	sessPub, sessPriv, _ := ed25519.GenerateKey(rand.Reader)
	savePub, savePriv, _ := ed25519.GenerateKey(rand.Reader)
	a := &API{
		DB:          accountapi.DB{Pool: pool},
		Saves:       &localsave.Store{RDB: rdb, Priv: savePriv, Pub: savePub, AdoptMissing: true},
		SessionPriv: sessPriv, SessionPub: sessPub,
		Providers: map[string]string{"google.com": "google"},
		DevAuth:   true,
		Log:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		Metrics:   svc.NewMetrics(),
	}
	if mut != nil {
		mut(a)
	}
	if _, _, err := a.DB.EnsureOfficialWorld(context.Background(), accountapi.World{Name: "Lodestone", Seed: "20261108", Spec: json.RawMessage(`{}`), GenVersion: "placeholder", AtlasHash: "placeholder"}); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	a.Register(mux)
	srv := httptest.NewServer(svc.CORS("*", mux))
	t.Cleanup(srv.Close)
	return &harness{t: t, srv: srv, api: a}
}

// do sends a JSON request and decodes the JSON response into out (if non-nil).
func (h *harness) do(method, path, token string, body any, out any) int {
	h.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, h.srv.URL+path, rd)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			h.t.Fatalf("%s %s: decode %q: %v", method, path, raw, err)
		}
	}
	return resp.StatusCode
}

func (h *harness) errCode(method, path, token string, body any) (int, string) {
	var e apiError
	st := h.do(method, path, token, body, &e)
	return st, e.Error
}

func (h *harness) worldID() string {
	var ws struct{ Worlds []accountapi.World }
	if st := h.do("GET", "/v1/worlds", "", nil, &ws); st != 200 || len(ws.Worlds) == 0 {
		h.t.Fatal("worlds", st, ws)
	}
	return ws.Worlds[0].ID
}

func (h *harness) devSignIn(user string) SessionResponse {
	var s SessionResponse
	if st := h.do("POST", "/v1/auth/dev", "", map[string]string{"username": user}, &s); st != 200 {
		h.t.Fatal("dev sign-in", st)
	}
	return s
}

func secret() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func TestAccountFlow(t *testing.T) {
	h := newHarness(t, nil)
	var cfg AuthConfig
	h.do("GET", "/v1/auth/config", "", nil, &cfg)
	if !cfg.DevAuth || cfg.Firebase != nil || !cfg.Local {
		t.Fatal(cfg)
	}
	s := h.devSignIn("Alice")
	if s.Kind != "account" || s.Account == nil || s.Account.Provider != "dev" || !strings.HasPrefix(s.Session, "lss1.") {
		t.Fatal(s)
	}
	if again := h.devSignIn("alice"); again.Account.ID != s.Account.ID {
		t.Fatal("dev username must map to one account case-insensitively")
	}
	world := h.worldID()

	var me map[string]any
	if st := h.do("GET", "/v1/me", s.Session, nil, &me); st != 200 || me["subject"] != s.Account.ID {
		t.Fatal(st, me)
	}
	if st, code := h.errCode("GET", "/v1/me", "", nil); st != 401 || code != "unauthorized" {
		t.Fatal(st, code)
	}
	if st, _ := h.errCode("GET", "/v1/me", s.Session+"x", nil); st != 401 {
		t.Fatal("tampered session accepted", st)
	}

	var created CreateCharacterResponse
	if st := h.do("POST", "/v1/characters", s.Session, map[string]any{"worldId": world, "name": "Nicole", "appearance": map[string]int{"hair": 3}}, &created); st != 201 {
		t.Fatal("create", st)
	}
	if created.Character.Name != "Nicole" || created.Character.Local || created.Save != nil {
		t.Fatal(created)
	}
	if st, code := h.errCode("POST", "/v1/characters", s.Session, map[string]any{"worldId": world, "name": "nicole"}); st != 409 || code != "name_taken" {
		t.Fatal(st, code)
	}
	if st, code := h.errCode("POST", "/v1/characters", s.Session, map[string]any{"worldId": world, "name": "x y"}); st != 400 || code != "invalid_name" {
		t.Fatal(st, code)
	}
	if st, code := h.errCode("POST", "/v1/characters", s.Session, map[string]any{"worldId": accountapi.NewUUID(), "name": "Valid"}); st != 404 || code != "world_not_found" {
		t.Fatal(st, code)
	}
	var list struct{ Characters []accountapi.Character }
	h.do("GET", "/v1/characters?worldId="+world, s.Session, nil, &list)
	if len(list.Characters) != 1 || list.Characters[0].ID != created.Character.ID {
		t.Fatal(list)
	}
	// Another account sees none of Alice's characters.
	bob := h.devSignIn("bob")
	h.do("GET", "/v1/characters", bob.Session, nil, &list)
	if len(list.Characters) != 0 {
		t.Fatal("leak", list)
	}
}

func TestDevAuthDisabled(t *testing.T) {
	h := newHarness(t, func(a *API) { a.DevAuth = false })
	if st, code := h.errCode("POST", "/v1/auth/dev", "", map[string]string{"username": "alice"}); st != 403 || code != "dev_auth_disabled" {
		t.Fatal(st, code)
	}
	if st := h.do("POST", "/v1/dev/local/resave", "", map[string]any{}, nil); st != 404 && st != 405 {
		t.Fatal("dev resave must not be mounted", st)
	}
	if st, code := h.errCode("POST", "/v1/auth/firebase", "", map[string]string{"idToken": "x"}); st != 404 || code != "firebase_disabled" {
		t.Fatal(st, code)
	}
}

// Spec 11 local-profile path end to end over HTTP: create profile and
// character, receive blob, tamper fails, old counter fails, upgrade works.
func TestLocalProfileFlow(t *testing.T) {
	h := newHarness(t, nil)
	world := h.worldID()
	profileID, sec := accountapi.NewUUID(), secret()
	t.Cleanup(func() { h.api.Saves.RDB.Del(context.Background(), localsave.Key(profileID)) })

	var ls SessionResponse
	if st := h.do("POST", "/v1/local/session", "", map[string]string{"profileId": profileID, "profileSecret": sec}, &ls); st != 200 || ls.Kind != "local" || ls.Profile.ID != profileID {
		t.Fatal(st, ls)
	}
	if st, code := h.errCode("POST", "/v1/local/session", "", map[string]string{"profileId": profileID, "profileSecret": secret()}); st != 403 || code != "profile_secret" {
		t.Fatal("someone else's secret", st, code)
	}
	if st, _ := h.errCode("POST", "/v1/local/session", "", map[string]string{"profileId": "not-a-uuid", "profileSecret": sec}); st != 400 {
		t.Fatal(st)
	}

	var cr CreateCharacterResponse
	if st := h.do("POST", "/v1/characters", ls.Session, map[string]any{"worldId": world, "name": "Wanderer"}, &cr); st != 201 {
		t.Fatal(st)
	}
	if !cr.Character.Local || cr.Save == nil || cr.Save.Counter != 1 || cr.Save.ProfileID != profileID {
		t.Fatal(cr)
	}
	blob1 := *cr.Save
	var ok map[string]any
	if st := h.do("POST", "/v1/local/saves/verify", ls.Session, map[string]any{"save": blob1}, &ok); st != 200 || ok["ok"] != true {
		t.Fatal(st, ok)
	}

	// Tamper: give yourself level 99.
	tampered := blob1
	tampered.State = strings.Replace(tampered.State, `"level":1`, `"level":99`, 1)
	if st, code := h.errCode("POST", "/v1/local/saves/verify", ls.Session, map[string]any{"save": tampered}); st != 400 || code != "bad_signature" {
		t.Fatal("tampered", st, code)
	}

	// A save point (zone stand-in) issues counter 2 with progress.
	var rs struct{ Save localsave.Blob }
	if st := h.do("POST", "/v1/dev/local/resave", ls.Session, map[string]any{"save": blob1, "set": map[string]any{"level": 5, "xp": 1234}}, &rs); st != 200 || rs.Save.Counter != 2 {
		t.Fatal(st, rs)
	}
	if st, code := h.errCode("POST", "/v1/local/saves/verify", ls.Session, map[string]any{"save": blob1}); st != 409 || code != "stale_save" {
		t.Fatal("old counter", st, code)
	}

	// Another profile cannot present this profile's blob.
	other := accountapi.NewUUID()
	t.Cleanup(func() { h.api.Saves.RDB.Del(context.Background(), localsave.Key(other)) })
	var os SessionResponse
	h.do("POST", "/v1/local/session", "", map[string]string{"profileId": other, "profileSecret": secret()}, &os)
	if st, code := h.errCode("POST", "/v1/local/saves/verify", os.Session, map[string]any{"save": rs.Save}); st != 403 || code != "wrong_profile" {
		t.Fatal(st, code)
	}

	// Upgrade into a fresh account: with the stale blob it fails, with the newest it works.
	acc := h.devSignIn("upgrader")
	if st, code := h.errCode("POST", "/v1/local/upgrade", acc.Session, map[string]any{"localSession": ls.Session, "saves": []any{blob1}}); st != 409 || code != "stale_save" {
		t.Fatal(st, code)
	}
	if st, code := h.errCode("POST", "/v1/local/upgrade", ls.Session, map[string]any{"localSession": ls.Session, "saves": []any{rs.Save}}); st != 403 || code != "account_only" {
		t.Fatal(st, code)
	}
	var up struct {
		AccountID  string
		Characters []accountapi.Character
	}
	if st := h.do("POST", "/v1/local/upgrade", acc.Session, map[string]any{"localSession": ls.Session, "saves": []any{rs.Save}}, &up); st != 200 || len(up.Characters) != 1 {
		t.Fatal("upgrade", st, up)
	}
	var list struct{ Characters []accountapi.Character }
	h.do("GET", "/v1/characters", acc.Session, nil, &list)
	if len(list.Characters) != 1 || list.Characters[0].Level != 5 || list.Characters[0].XP != 1234 || list.Characters[0].Local {
		t.Fatal("progress not imported", list)
	}
	// The local profile is retired: no new sessions, and old sessions can't create.
	if st, code := h.errCode("POST", "/v1/local/session", "", map[string]string{"profileId": profileID, "profileSecret": sec}); st != 410 || code != "profile_upgraded" {
		t.Fatal(st, code)
	}
	if st, code := h.errCode("POST", "/v1/characters", ls.Session, map[string]any{"worldId": world, "name": "Second"}); st != 410 || code != "profile_upgraded" {
		t.Fatal(st, code)
	}
	if n, _ := h.api.Saves.RDB.Exists(context.Background(), localsave.Key(profileID)).Result(); n != 0 {
		t.Fatal("localsave record should be dropped after upgrade")
	}
}

// Firebase sign-in through the HTTP endpoint with a mock Google JWKS.
func TestFirebaseSignIn(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, `{"keys":[{"kty":"RSA","kid":"k1","alg":"RS256","n":%q,"e":%q}]}`,
			base64.RawURLEncoding.EncodeToString(key.N.Bytes()), base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()))
	}))
	defer jwks.Close()
	h := newHarness(t, func(a *API) {
		a.Firebase = &firebase.Verifier{ProjectID: "lodestone-test", JWKSURL: jwks.URL}
	})
	mk := func(provider string) string {
		now := time.Now()
		hdr, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": "k1"})
		cl, _ := json.Marshal(map[string]any{"iss": "https://securetoken.google.com/lodestone-test", "aud": "lodestone-test", "sub": "firebase-uid-1",
			"iat": now.Unix(), "exp": now.Add(time.Hour).Unix(), "auth_time": now.Unix(), "name": "Nicole B", "firebase": map[string]string{"sign_in_provider": provider}})
		in := base64.RawURLEncoding.EncodeToString(hdr) + "." + base64.RawURLEncoding.EncodeToString(cl)
		d := sha256.Sum256([]byte(in))
		sig, _ := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, d[:])
		return in + "." + base64.RawURLEncoding.EncodeToString(sig)
	}
	var cfg AuthConfig
	h.do("GET", "/v1/auth/config", "", nil, &cfg)
	if cfg.Firebase == nil || cfg.Firebase.ProjectID != "lodestone-test" {
		t.Fatal(cfg)
	}
	var s SessionResponse
	if st := h.do("POST", "/v1/auth/firebase", "", map[string]string{"idToken": mk("google.com")}, &s); st != 200 {
		t.Fatal(st)
	}
	if s.Account.Provider != "google" || s.Name != "Nicole B" {
		t.Fatal(s)
	}
	var subject string
	_ = h.api.DB.Pool.QueryRow(context.Background(), `SELECT auth_subject FROM accounts WHERE id = $1`, s.Account.ID).Scan(&subject)
	if subject != "firebase-uid-1" {
		t.Fatal("auth_subject must be the Firebase uid", subject)
	}
	if st, code := h.errCode("POST", "/v1/auth/firebase", "", map[string]string{"idToken": mk("anonymous")}); st != 403 || code != "provider_not_allowed" {
		t.Fatal(st, code)
	}
	if st, code := h.errCode("POST", "/v1/auth/firebase", "", map[string]string{"idToken": mk("google.com") + "x"}); st != 401 || code != "invalid_token" {
		t.Fatal(st, code)
	}
	// Suspended accounts cannot sign in.
	_, _ = h.api.DB.Pool.Exec(context.Background(), `UPDATE accounts SET status = 'suspended' WHERE id = $1`, s.Account.ID)
	if st, code := h.errCode("POST", "/v1/auth/firebase", "", map[string]string{"idToken": mk("google.com")}); st != 403 || code != "account_suspended" {
		t.Fatal(st, code)
	}
}
