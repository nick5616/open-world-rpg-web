package firebase

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const project = "lodestone-test"

// mockGoogle serves a JWKS like Google's securetoken endpoint.
type mockGoogle struct {
	srv     *httptest.Server
	keys    map[string]*rsa.PrivateKey
	fetches atomic.Int32
}

func newMock(t *testing.T, kids ...string) *mockGoogle {
	m := &mockGoogle{keys: map[string]*rsa.PrivateKey{}}
	for _, kid := range kids {
		k, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			t.Fatal(err)
		}
		m.keys[kid] = k
	}
	m.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		m.fetches.Add(1)
		var set jwks
		for kid, k := range m.keys {
			set.Keys = append(set.Keys, struct {
				Kty string `json:"kty"`
				Kid string `json:"kid"`
				N   string `json:"n"`
				E   string `json:"e"`
			}{"RSA", kid, b64(k.N.Bytes()), b64(big.NewInt(int64(k.E)).Bytes())})
		}
		w.Header().Set("Cache-Control", "public, max-age=21600, must-revalidate, no-transform")
		_ = json.NewEncoder(w).Encode(set)
	}))
	t.Cleanup(m.srv.Close)
	return m
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func sign(t *testing.T, k *rsa.PrivateKey, hdr map[string]any, claims map[string]any) string {
	h, _ := json.Marshal(hdr)
	c, _ := json.Marshal(claims)
	input := b64(h) + "." + b64(c)
	d := sha256.Sum256([]byte(input))
	sig, err := rsa.SignPKCS1v15(rand.Reader, k, crypto.SHA256, d[:])
	if err != nil {
		t.Fatal(err)
	}
	return input + "." + b64(sig)
}

func goodClaims(now time.Time) map[string]any {
	return map[string]any{
		"iss": "https://securetoken.google.com/" + project, "aud": project, "sub": "uid-abc",
		"iat": now.Add(-time.Minute).Unix(), "exp": now.Add(59 * time.Minute).Unix(), "auth_time": now.Add(-time.Minute).Unix(),
		"email": "n@example.com", "name": "Nicole",
		"firebase": map[string]any{"sign_in_provider": "google.com"},
	}
}

func TestVerify(t *testing.T) {
	m := newMock(t, "k1", "k2")
	now := time.Unix(1_762_560_000, 0)
	v := &Verifier{ProjectID: project, JWKSURL: m.srv.URL, Now: func() time.Time { return now }}
	ctx := context.Background()

	tok := sign(t, m.keys["k1"], map[string]any{"alg": "RS256", "kid": "k1", "typ": "JWT"}, goodClaims(now))
	got, err := v.Verify(ctx, tok)
	if err != nil {
		t.Fatal(err)
	}
	if got.UID != "uid-abc" || got.Provider != "google.com" || got.Name != "Nicole" {
		t.Fatalf("%+v", got)
	}
	// Second key from the same cached set: no refetch.
	if _, err := v.Verify(ctx, sign(t, m.keys["k2"], map[string]any{"alg": "RS256", "kid": "k2"}, goodClaims(now))); err != nil {
		t.Fatal(err)
	}
	if n := m.fetches.Load(); n != 1 {
		t.Fatal("JWKS must be cached, fetches:", n)
	}

	mut := func(f func(c map[string]any)) map[string]any {
		c := goodClaims(now)
		f(c)
		return c
	}
	bad := map[string]struct {
		hdr    map[string]any
		claims map[string]any
		want   error
	}{
		"wrong aud":         {nil, mut(func(c map[string]any) { c["aud"] = "other-project" }), ErrClaims},
		"wrong iss":         {nil, mut(func(c map[string]any) { c["iss"] = "https://evil.example/" + project }), ErrClaims},
		"expired":           {nil, mut(func(c map[string]any) { c["exp"] = now.Add(-10 * time.Minute).Unix() }), ErrClaims},
		"iat in future":     {nil, mut(func(c map[string]any) { c["iat"] = now.Add(time.Hour).Unix() }), ErrClaims},
		"auth_time future":  {nil, mut(func(c map[string]any) { c["auth_time"] = now.Add(time.Hour).Unix() }), ErrClaims},
		"empty sub":         {nil, mut(func(c map[string]any) { c["sub"] = "" }), ErrClaims},
		"long sub":          {nil, mut(func(c map[string]any) { c["sub"] = strings.Repeat("x", 129) }), ErrClaims},
		"alg none":          {map[string]any{"alg": "none", "kid": "k1"}, goodClaims(now), ErrMalformed},
		"alg HS256":         {map[string]any{"alg": "HS256", "kid": "k1"}, goodClaims(now), ErrMalformed},
		"missing kid":       {map[string]any{"alg": "RS256"}, goodClaims(now), ErrMalformed},
		"unknown kid":       {map[string]any{"alg": "RS256", "kid": "nope"}, goodClaims(now), ErrSignature},
		"signed by wrong k": {map[string]any{"alg": "RS256", "kid": "k2"}, goodClaims(now), ErrSignature},
	}
	for name, c := range bad {
		hdr := c.hdr
		if hdr == nil {
			hdr = map[string]any{"alg": "RS256", "kid": "k1"}
		}
		tok := sign(t, m.keys["k1"], hdr, c.claims)
		if _, err := v.Verify(ctx, tok); !errors.Is(err, c.want) {
			t.Errorf("%s: want %v, got %v", name, c.want, err)
		}
	}
	// Payload swapped after signing.
	parts := strings.Split(tok, ".")
	evil, _ := json.Marshal(mut(func(c map[string]any) { c["sub"] = "someone-else" }))
	if _, err := v.Verify(ctx, parts[0]+"."+b64(evil)+"."+parts[2]); !errors.Is(err, ErrSignature) {
		t.Error("swapped payload:", err)
	}
	for _, junk := range []string{"", "a.b", "a.b.c", "!!.!!.!!"} {
		if _, err := v.Verify(ctx, junk); err == nil {
			t.Errorf("%q accepted", junk)
		}
	}
	// Within clock skew: a token that expired 2 minutes ago still verifies.
	if _, err := v.Verify(ctx, sign(t, m.keys["k1"], map[string]any{"alg": "RS256", "kid": "k1"}, mut(func(c map[string]any) { c["exp"] = now.Add(-2 * time.Minute).Unix() }))); err != nil {
		t.Error("skew:", err)
	}
}

// After Google rotates keys a token may carry a kid we have not seen; one
// early refetch (rate-limited) picks it up. Cache expiry also refetches.
func TestKeyRotation(t *testing.T) {
	m := newMock(t, "old")
	now := time.Unix(1_762_560_000, 0)
	clock := now
	v := &Verifier{ProjectID: project, JWKSURL: m.srv.URL, Now: func() time.Time { return clock }}
	ctx := context.Background()
	if _, err := v.Verify(ctx, sign(t, m.keys["old"], map[string]any{"alg": "RS256", "kid": "old"}, goodClaims(now))); err != nil {
		t.Fatal(err)
	}
	k, _ := rsa.GenerateKey(rand.Reader, 2048)
	m.keys["new"] = k
	newTok := sign(t, k, map[string]any{"alg": "RS256", "kid": "new"}, goodClaims(now))
	// Within the refetch floor: unknown kid is rejected without hammering Google.
	if _, err := v.Verify(ctx, newTok); !errors.Is(err, ErrSignature) || m.fetches.Load() != 1 {
		t.Fatal("expected rate-limited rejection", err, m.fetches.Load())
	}
	clock = now.Add(2 * time.Minute)
	if _, err := v.Verify(ctx, newTok); err != nil {
		t.Fatal("rotated key not picked up:", err)
	}
	if m.fetches.Load() != 2 {
		t.Fatal("fetches", m.fetches.Load())
	}
	// Cache max-age (6 h) elapses: next verify refetches even for a known kid.
	clock = now.Add(7 * time.Hour)
	_, _ = v.Verify(ctx, newTok) // token itself is expired by now; we only care about the fetch
	if m.fetches.Load() != 3 {
		t.Fatal("expired cache not refreshed", m.fetches.Load())
	}
}

func TestKeysUnavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(500) }))
	defer srv.Close()
	v := &Verifier{ProjectID: project, JWKSURL: srv.URL}
	k, _ := rsa.GenerateKey(rand.Reader, 2048)
	if _, err := v.Verify(context.Background(), sign(t, k, map[string]any{"alg": "RS256", "kid": "x"}, goodClaims(time.Now()))); !errors.Is(err, ErrKeys) {
		t.Fatal(err)
	}
}
