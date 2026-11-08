package ticket

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestSignVerifyRoundTrip(t *testing.T) {
	priv, dev, err := PrivateKeyFromEnv()
	if err != nil || !dev {
		t.Fatal("expected dev key", err)
	}
	pub, _, _ := PublicKeyFromEnv()
	now := time.UnixMilli(1_731_000_000_000)
	s := Sign(priv, Claims{AccountID: "a1", CharacterID: "c1", CharacterName: "Nicole", WorldID: "w1", Audience: AudienceZone("z1"), IssuedAt: now})
	c, err := Verify(pub, s, AudienceZone("z1"), now.Add(30*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if c.CharacterName != "Nicole" || c.WorldID != "w1" || c.ExpiresAt.Sub(c.IssuedAt) != 60*time.Second {
		t.Fatalf("bad claims %+v", c)
	}
	if _, err := Verify(pub, s, AudienceZone("z1"), now.Add(61*time.Second)); !errors.Is(err, ErrExpired) {
		t.Fatal("expected expiry", err)
	}
	if _, err := Verify(pub, s, AudienceSocial, now); !errors.Is(err, ErrAudience) {
		t.Fatal("expected audience error", err)
	}
	// Flip one character in the payload: signature must fail.
	b := []byte(s)
	if b[5] == 'A' {
		b[5] = 'B'
	} else {
		b[5] = 'A'
	}
	if _, err := Verify(pub, string(b), "", now); err == nil {
		t.Fatal("tampered ticket accepted")
	}
	if _, err := Verify(pub, strings.Repeat("x", 10), "", now); !errors.Is(err, ErrMalformed) {
		t.Fatal("expected malformed")
	}
}
