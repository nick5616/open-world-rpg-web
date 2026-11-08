// Package firebase verifies Firebase Auth ID tokens server-side, without the
// Admin SDK (spec 13: no provider SDKs in game code; the check is small).
//
// Rules follow Firebase's "Verify ID tokens using a third-party JWT library":
// header alg RS256 with a kid from Google's securetoken key set; payload iss =
// https://securetoken.google.com/<project>, aud = <project>, exp in the
// future, iat and auth_time in the past, sub a non-empty string of at most
// 128 characters. Keys rotate daily, so the JWKS is cached for the response's
// Cache-Control max-age and refetched early only when an unknown kid shows up.
package firebase

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// GoogleJWKSURL publishes the public keys that sign Firebase ID tokens.
const GoogleJWKSURL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"

// ClockSkew tolerates small client/server clock differences on exp/iat, the
// same allowance the official Admin SDKs use.
const ClockSkew = 5 * time.Minute

// refetchFloor stops a stream of tokens with junk kids from turning into a
// stream of JWKS fetches.
const refetchFloor = time.Minute

// Token is a verified ID token.
type Token struct {
	UID      string // Firebase uid (sub): stable per Firebase user
	Provider string // firebase.sign_in_provider, e.g. "google.com"
	Email    string
	Name     string
	IssuedAt time.Time
	Expires  time.Time
}

// Verification errors (wrapped with detail).
var (
	ErrMalformed = errors.New("firebase: malformed token")
	ErrSignature = errors.New("firebase: bad signature")
	ErrClaims    = errors.New("firebase: invalid claims")
	ErrKeys      = errors.New("firebase: signing keys unavailable")
)

// Verifier checks ID tokens for one Firebase project.
type Verifier struct {
	ProjectID string
	JWKSURL   string       // default GoogleJWKSURL; tests point it at a local server
	HTTP      *http.Client // default: 10 s timeout
	Now       func() time.Time

	mu        sync.Mutex
	keys      map[string]*rsa.PublicKey
	expires   time.Time
	lastFetch time.Time
}

func (v *Verifier) now() time.Time {
	if v.Now != nil {
		return v.Now()
	}
	return time.Now()
}

type header struct {
	Alg string `json:"alg"`
	Kid string `json:"kid"`
}

type claims struct {
	Iss      string  `json:"iss"`
	Aud      string  `json:"aud"`
	Sub      string  `json:"sub"`
	Iat      float64 `json:"iat"`
	Exp      float64 `json:"exp"`
	AuthTime float64 `json:"auth_time"`
	Email    string  `json:"email"`
	Name     string  `json:"name"`
	Firebase struct {
		SignInProvider string `json:"sign_in_provider"`
	} `json:"firebase"`
}

// Verify checks an ID token and returns its identity.
func (v *Verifier) Verify(ctx context.Context, idToken string) (Token, error) {
	if v.ProjectID == "" {
		return Token{}, errors.New("firebase: no project id configured")
	}
	parts := strings.Split(idToken, ".")
	if len(parts) != 3 {
		return Token{}, ErrMalformed
	}
	var h header
	if err := decodeSegment(parts[0], &h); err != nil {
		return Token{}, err
	}
	// Pin the algorithm: accepting "none" or HS256 here is the classic JWT hole.
	if h.Alg != "RS256" || h.Kid == "" {
		return Token{}, fmt.Errorf("%w: alg %q kid %q", ErrMalformed, h.Alg, h.Kid)
	}
	key, err := v.key(ctx, h.Kid)
	if err != nil {
		return Token{}, err
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return Token{}, ErrMalformed
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], sig); err != nil {
		return Token{}, ErrSignature
	}
	var c claims
	if err := decodeSegment(parts[1], &c); err != nil {
		return Token{}, err
	}
	now := v.now()
	iat, exp, authTime := unix(c.Iat), unix(c.Exp), unix(c.AuthTime)
	switch {
	case c.Aud != v.ProjectID:
		return Token{}, fmt.Errorf("%w: aud %q", ErrClaims, c.Aud)
	case c.Iss != "https://securetoken.google.com/"+v.ProjectID:
		return Token{}, fmt.Errorf("%w: iss %q", ErrClaims, c.Iss)
	case c.Sub == "" || len(c.Sub) > 128:
		return Token{}, fmt.Errorf("%w: sub", ErrClaims)
	case c.Exp == 0 || !now.Before(exp.Add(ClockSkew)):
		return Token{}, fmt.Errorf("%w: expired", ErrClaims)
	case c.Iat == 0 || iat.After(now.Add(ClockSkew)):
		return Token{}, fmt.Errorf("%w: issued in the future", ErrClaims)
	case c.AuthTime == 0 || authTime.After(now.Add(ClockSkew)):
		return Token{}, fmt.Errorf("%w: auth_time in the future", ErrClaims)
	}
	return Token{UID: c.Sub, Provider: c.Firebase.SignInProvider, Email: c.Email, Name: c.Name, IssuedAt: iat, Expires: exp}, nil
}

func unix(f float64) time.Time { return time.Unix(int64(f), 0) }

func decodeSegment(s string, out any) error {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return ErrMalformed
	}
	if err := json.Unmarshal(b, out); err != nil {
		return ErrMalformed
	}
	return nil
}

// key returns the public key for kid, fetching the JWKS when the cache is
// expired or (rate-limited) when the kid is unknown, which is what happens
// for a few minutes after Google rotates keys.
func (v *Verifier) key(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	now := v.now()
	if k, ok := v.keys[kid]; ok && now.Before(v.expires) {
		return k, nil
	}
	if v.keys == nil || !now.Before(v.expires) || now.Sub(v.lastFetch) >= refetchFloor {
		if err := v.fetch(ctx, now); err != nil {
			// Keep serving the old set if a refresh fails; Google keys overlap
			// by days, so a stale set still verifies nearly every token.
			if v.keys == nil {
				return nil, err
			}
		}
	}
	if k, ok := v.keys[kid]; ok {
		return k, nil
	}
	return nil, fmt.Errorf("%w: unknown kid %q", ErrSignature, kid)
}

var maxAgeRe = regexp.MustCompile(`max-age=(\d+)`)

type jwks struct {
	Keys []struct {
		Kty string `json:"kty"`
		Kid string `json:"kid"`
		N   string `json:"n"`
		E   string `json:"e"`
	} `json:"keys"`
}

func (v *Verifier) fetch(ctx context.Context, now time.Time) error {
	v.lastFetch = now
	url := v.JWKSURL
	if url == "" {
		url = GoogleJWKSURL
	}
	client := v.HTTP
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrKeys, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%w: status %d", ErrKeys, resp.StatusCode)
	}
	var set jwks
	if err := json.NewDecoder(resp.Body).Decode(&set); err != nil {
		return fmt.Errorf("%w: %v", ErrKeys, err)
	}
	keys := map[string]*rsa.PublicKey{}
	for _, k := range set.Keys {
		if k.Kty != "RSA" || k.Kid == "" {
			continue
		}
		n, err1 := base64.RawURLEncoding.DecodeString(k.N)
		e, err2 := base64.RawURLEncoding.DecodeString(k.E)
		if err1 != nil || err2 != nil || len(e) == 0 || len(e) > 4 {
			continue
		}
		keys[k.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
	}
	if len(keys) == 0 {
		return fmt.Errorf("%w: empty key set", ErrKeys)
	}
	ttl := time.Hour // Google sends ~6 h; an hour is a safe floor without the header
	if m := maxAgeRe.FindStringSubmatch(resp.Header.Get("Cache-Control")); m != nil {
		if s, err := strconv.Atoi(m[1]); err == nil && s > 0 {
			ttl = time.Duration(s) * time.Second
		}
	}
	v.keys, v.expires = keys, now.Add(ttl)
	return nil
}
