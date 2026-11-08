// Package accountapi is what the account service, the director and (later)
// the social service share about players: session tokens and the Postgres
// queries for accounts, local profiles, worlds and characters (spec 11).
//
// Session tokens are issued by the account service after sign-in and verified
// offline by the director (and anyone else holding the public key), so the
// director never needs to call the account service on the connect path.
package accountapi

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"lodestone/server/pkg/env"
)

// Session kinds.
const (
	KindAccount = "account"
	KindLocal   = "local"
)

// DefaultSessionTTL: long enough for an evening of play without re-signing in,
// short enough that a stolen token dies by tomorrow. Connect tickets (60 s) are
// what zones actually trust; the session only lets you ask for tickets.
const DefaultSessionTTL = 12 * time.Hour

// sessionPrefix is both the wire prefix and the signature domain separator,
// so a session signature can never be replayed as a ticket or save signature
// even if an operator reuses one key for all three.
const sessionPrefix = "lss1"

// Session is what a session token asserts.
type Session struct {
	Kind     string    `json:"k"`              // KindAccount or KindLocal
	Subject  string    `json:"sub"`            // account id (uuid) or local profile id (uuid)
	Provider string    `json:"prov"`           // "google", "dev", ... or "local"
	Name     string    `json:"name,omitempty"` // display name hint for UIs; never used for authz
	IssuedAt time.Time `json:"-"`
	Expires  time.Time `json:"-"`
}

type sessionWire struct {
	Session
	Iat int64 `json:"iat"` // unix ms
	Exp int64 `json:"exp"` // unix ms
}

// Session token errors.
var (
	ErrSessionMalformed = errors.New("session: malformed")
	ErrSessionSignature = errors.New("session: bad signature")
	ErrSessionExpired   = errors.New("session: expired")
)

// SignSession returns "lss1.<base64url(json)>.<base64url(sig)>".
func SignSession(priv ed25519.PrivateKey, s Session, now time.Time, ttl time.Duration) (string, time.Time) {
	if ttl <= 0 {
		ttl = DefaultSessionTTL
	}
	exp := now.Add(ttl)
	b, _ := json.Marshal(sessionWire{Session: s, Iat: now.UnixMilli(), Exp: exp.UnixMilli()})
	payload := base64.RawURLEncoding.EncodeToString(b)
	sig := ed25519.Sign(priv, []byte(sessionPrefix+"."+payload))
	return sessionPrefix + "." + payload + "." + base64.RawURLEncoding.EncodeToString(sig), exp
}

// VerifySession checks the signature and expiry.
func VerifySession(pub ed25519.PublicKey, tok string, now time.Time) (Session, error) {
	parts := strings.Split(tok, ".")
	if len(parts) != 3 || parts[0] != sessionPrefix {
		return Session{}, ErrSessionMalformed
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(sig) != ed25519.SignatureSize {
		return Session{}, ErrSessionMalformed
	}
	if !ed25519.Verify(pub, []byte(sessionPrefix+"."+parts[1]), sig) {
		return Session{}, ErrSessionSignature
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return Session{}, ErrSessionMalformed
	}
	var w sessionWire
	if err := json.Unmarshal(raw, &w); err != nil || w.Subject == "" || (w.Kind != KindAccount && w.Kind != KindLocal) {
		return Session{}, ErrSessionMalformed
	}
	s := w.Session
	s.IssuedAt, s.Expires = time.UnixMilli(w.Iat), time.UnixMilli(w.Exp)
	if !now.Before(s.Expires) {
		return s, ErrSessionExpired
	}
	return s, nil
}

// IsProduction reports LODESTONE_ENV=production. Production refuses the dev
// auth provider and every well-known development key.
func IsProduction() bool { return env.Str("LODESTONE_ENV", "development") == "production" }

func devSessionSeed() []byte {
	h := sha256.Sum256([]byte("lodestone-dev-session-key-NOT-FOR-PRODUCTION"))
	return h[:]
}

// SessionPrivateKeyFromEnv reads LODESTONE_SESSION_PRIVATE_KEY (base64 32-byte
// seed). usedDev reports the insecure development fallback; callers log a
// warning, and refuse to start in production.
func SessionPrivateKeyFromEnv() (priv ed25519.PrivateKey, usedDev bool, err error) {
	s := env.Str("LODESTONE_SESSION_PRIVATE_KEY", "")
	if s == "" {
		return ed25519.NewKeyFromSeed(devSessionSeed()), true, nil
	}
	seed, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, false, errors.New("session: LODESTONE_SESSION_PRIVATE_KEY must be base64 of a 32-byte seed")
	}
	return ed25519.NewKeyFromSeed(seed), false, nil
}

// SessionPublicKeyFromEnv reads LODESTONE_SESSION_PUBLIC_KEY (base64 32 bytes).
func SessionPublicKeyFromEnv() (pub ed25519.PublicKey, usedDev bool, err error) {
	s := env.Str("LODESTONE_SESSION_PUBLIC_KEY", "")
	if s == "" {
		return ed25519.NewKeyFromSeed(devSessionSeed()).Public().(ed25519.PublicKey), true, nil
	}
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, false, errors.New("session: LODESTONE_SESSION_PUBLIC_KEY must be base64 of a 32-byte key")
	}
	return ed25519.PublicKey(b), false, nil
}

// BearerToken extracts the token from "Authorization: Bearer <tok>".
func BearerToken(h string) string {
	if len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}
