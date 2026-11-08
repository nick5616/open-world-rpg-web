// Package ticket implements connect tickets (spec 9, security): the director
// signs who you are and where you may connect with Ed25519; zone servers and
// the social service verify offline with the public key. 60 s lifetime.
//
// Wire form: base64url(payload || signature[64]). The payload uses the zone
// codec's primitive Writer so it is compact and language-neutral; clients
// treat the whole string as opaque.
package ticket

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/env"
	"lodestone/server/pkg/proto"
)

const formatVersion = 1

// Audience values: "zone:<zoneId>" for a zone server, "social" for the social service.
const AudienceSocial = "social"

// AudienceZone returns the audience string for a zone id.
func AudienceZone(zoneID string) string { return "zone:" + zoneID }

// Claims is what a ticket asserts.
type Claims struct {
	AccountID      string // empty for local profiles
	ProfileID      string // local profile id (empty for accounts)
	CharacterID    string
	CharacterName  string
	WorldID        string
	Audience       string
	IsLocalProfile bool
	IssuedAt       time.Time
	ExpiresAt      time.Time
}

var (
	ErrMalformed = errors.New("ticket: malformed")
	ErrSignature = errors.New("ticket: bad signature")
	ErrExpired   = errors.New("ticket: expired")
	ErrAudience  = errors.New("ticket: wrong audience")
)

// Sign encodes and signs claims. If ExpiresAt is zero it is IssuedAt + TICKET_TTL_S.
func Sign(priv ed25519.PrivateKey, c Claims) string {
	if c.IssuedAt.IsZero() {
		c.IssuedAt = time.Now()
	}
	if c.ExpiresAt.IsZero() {
		c.ExpiresAt = c.IssuedAt.Add(constants.TicketTtlS * time.Second)
	}
	var w proto.Writer
	w.U8(formatVersion)
	w.Str(c.AccountID)
	w.Str(c.ProfileID)
	w.Str(c.CharacterID)
	w.Str(c.CharacterName)
	w.Str(c.WorldID)
	w.Str(c.Audience)
	w.Bool(c.IsLocalProfile)
	w.I64(c.IssuedAt.UnixMilli())
	w.I64(c.ExpiresAt.UnixMilli())
	sig := ed25519.Sign(priv, w.B)
	return base64.RawURLEncoding.EncodeToString(append(w.B, sig...))
}

// Verify checks signature, expiry and audience (audience "" skips the check).
func Verify(pub ed25519.PublicKey, s string, audience string, now time.Time) (Claims, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil || len(raw) < ed25519.SignatureSize+1 {
		return Claims{}, ErrMalformed
	}
	payload, sig := raw[:len(raw)-ed25519.SignatureSize], raw[len(raw)-ed25519.SignatureSize:]
	if !ed25519.Verify(pub, payload, sig) {
		return Claims{}, ErrSignature
	}
	r := proto.Reader{B: payload}
	if r.U8() != formatVersion {
		return Claims{}, ErrMalformed
	}
	c := Claims{
		AccountID: r.Str(), ProfileID: r.Str(), CharacterID: r.Str(), CharacterName: r.Str(),
		WorldID: r.Str(), Audience: r.Str(), IsLocalProfile: r.Bool(),
	}
	c.IssuedAt = time.UnixMilli(r.I64())
	c.ExpiresAt = time.UnixMilli(r.I64())
	if r.Err != nil || r.Off != len(payload) {
		return Claims{}, ErrMalformed
	}
	if now.After(c.ExpiresAt) {
		return c, ErrExpired
	}
	if audience != "" && c.Audience != audience {
		return c, fmt.Errorf("%w: got %q want %q", ErrAudience, c.Audience, audience)
	}
	return c, nil
}

// devSeed derives the well-known development key. It is only used when the
// env var is unset, and services log a warning when they fall back to it.
func devSeed() []byte {
	h := sha256.Sum256([]byte("lodestone-dev-ticket-key-NOT-FOR-PRODUCTION"))
	return h[:]
}

// PrivateKeyFromEnv reads LODESTONE_TICKET_PRIVATE_KEY (base64 32-byte seed).
// usedDev reports whether the insecure development key was used.
func PrivateKeyFromEnv() (priv ed25519.PrivateKey, usedDev bool, err error) {
	s := env.Str("LODESTONE_TICKET_PRIVATE_KEY", "")
	if s == "" {
		return ed25519.NewKeyFromSeed(devSeed()), true, nil
	}
	seed, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, false, errors.New("ticket: LODESTONE_TICKET_PRIVATE_KEY must be base64 of a 32-byte seed")
	}
	return ed25519.NewKeyFromSeed(seed), false, nil
}

// PublicKeyFromEnv reads LODESTONE_TICKET_PUBLIC_KEY (base64 32 bytes).
func PublicKeyFromEnv() (pub ed25519.PublicKey, usedDev bool, err error) {
	s := env.Str("LODESTONE_TICKET_PUBLIC_KEY", "")
	if s == "" {
		return ed25519.NewKeyFromSeed(devSeed()).Public().(ed25519.PublicKey), true, nil
	}
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, false, errors.New("ticket: LODESTONE_TICKET_PUBLIC_KEY must be base64 of a 32-byte key")
	}
	return ed25519.PublicKey(b), false, nil
}
