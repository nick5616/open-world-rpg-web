// Package localsave builds, signs and verifies local-profile save blobs
// (spec 11, "Why a local save can't be tampered with").
//
// A local profile keeps its character in the browser's IndexedDB. The game is
// still server-authoritative: at each save point the server signs the
// character state together with the profile id, character id, world id and a
// counter, and hands the blob to the browser. On connect the browser presents
// its latest blob back:
//
//   - an edited blob fails the Ed25519 signature;
//   - an old blob (say, from before you dropped an item for a friend) fails the
//     counter, because Redis remembers the newest counter we issued
//     (`localsave:{profileId}`, kept LOCALSAVE_TTL_DAYS after last use).
//
// Counters are per character, stored as fields of the per-profile hash: a
// profile can own several characters and saving one must not invalidate the
// others' blobs.
//
// The account service issues the first blob when a local profile creates a
// character. Zone servers call Store.Issue at save points (WP06/WP14) and
// Store.Verify on connect.
package localsave

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/env"
)

// Format identifies a save blob in exported files and IndexedDB.
const Format = "lodestone-save"

// Version of the blob layout. Bump (and keep verifying old versions) if the
// signed byte layout ever changes; exported files can be years old.
const Version = 1

// domain separates save signatures from ticket and session signatures, so one
// can never be passed off as another even if an operator reuses a key.
const domain = "lodestone-localsave-v1\x00"

// Blob is a signed save as stored in the browser and exported to files.
//
// State is the character state as JSON *text*, signed byte for byte. Keeping
// it a string (rather than a nested object) means browsers and tools can
// round-trip the blob through JSON.parse/stringify without reordering keys or
// changing number formatting, either of which would break the signature.
type Blob struct {
	Format      string `json:"format"`
	V           int    `json:"v"`
	ProfileID   string `json:"profileId"`
	CharacterID string `json:"characterId"`
	WorldID     string `json:"worldId"`
	Counter     uint64 `json:"counter"`
	IssuedAt    int64  `json:"issuedAt"` // unix ms
	State       string `json:"state"`
	Sig         string `json:"sig"` // base64url Ed25519 signature over signedBytes()
}

// Errors returned by verification.
var (
	ErrMalformed = errors.New("localsave: malformed blob")
	ErrSignature = errors.New("localsave: bad signature")
	ErrStale     = errors.New("localsave: stale blob (a newer save exists)")
	ErrNoRecord  = errors.New("localsave: no counter record for this profile")
)

// signedBytes is the exact byte string the signature covers: a domain tag,
// then every field length-prefixed (u32 big-endian) so no two different
// blobs can serialize to the same bytes.
func (b Blob) signedBytes() []byte {
	out := make([]byte, 0, len(domain)+64+len(b.State)+len(b.ProfileID)+len(b.CharacterID)+len(b.WorldID))
	out = append(out, domain...)
	out = binary.BigEndian.AppendUint32(out, uint32(b.V))
	for _, s := range []string{b.ProfileID, b.CharacterID, b.WorldID} {
		out = binary.BigEndian.AppendUint32(out, uint32(len(s)))
		out = append(out, s...)
	}
	out = binary.BigEndian.AppendUint64(out, b.Counter)
	out = binary.BigEndian.AppendUint64(out, uint64(b.IssuedAt))
	out = binary.BigEndian.AppendUint32(out, uint32(len(b.State)))
	out = append(out, b.State...)
	return out
}

// Build signs a blob for the given counter. Most callers want Store.Issue,
// which also advances the counter in Redis.
func Build(priv ed25519.PrivateKey, profileID, characterID, worldID string, counter uint64, state []byte, now time.Time) Blob {
	b := Blob{
		Format: Format, V: Version, ProfileID: profileID, CharacterID: characterID, WorldID: worldID,
		Counter: counter, IssuedAt: now.UnixMilli(), State: string(state),
	}
	b.Sig = base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, b.signedBytes()))
	return b
}

// VerifySignature checks shape and signature only (no counter check). Use it
// where Redis is unavailable or irrelevant, e.g. reading an imported file.
func VerifySignature(pub ed25519.PublicKey, b Blob) error {
	if b.Format != Format || b.V != Version || b.ProfileID == "" || b.CharacterID == "" || b.WorldID == "" || b.Counter == 0 {
		return ErrMalformed
	}
	sig, err := base64.RawURLEncoding.DecodeString(b.Sig)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return ErrMalformed
	}
	if !ed25519.Verify(pub, b.signedBytes(), sig) {
		return ErrSignature
	}
	return nil
}

// DecodeState parses the signed state. Call only after verification.
func (b Blob) DecodeState() (State, error) {
	var s State
	if err := json.Unmarshal([]byte(b.State), &s); err != nil {
		return State{}, fmt.Errorf("%w: state: %v", ErrMalformed, err)
	}
	return s, nil
}

// Key is the Redis key holding a profile's newest counters (one hash field per character).
func Key(profileID string) string { return "localsave:" + profileID }

// Store pairs a key pair with the Redis counter record.
type Store struct {
	RDB  *redis.Client
	Priv ed25519.PrivateKey // nil for verify-only users (e.g. the director)
	Pub  ed25519.PublicKey
	TTL  time.Duration // record retention after last use; default LOCALSAVE_TTL_DAYS
	// AdoptMissing decides what happens when a correctly signed blob arrives
	// but Redis has no counter for it (record expired after 180 idle days, or
	// Redis was restarted: local Redis is ephemeral by design, spec 11). true
	// accepts the blob and records its counter, so players don't lose their
	// characters when Redis restarts; the cost is that one rollback to any
	// earlier signed blob is possible right after a Redis loss. false rejects
	// with ErrNoRecord. The account service and zone use true; see STATUS.
	AdoptMissing bool
	Now          func() time.Time
}

func (s *Store) ttl() time.Duration {
	if s.TTL > 0 {
		return s.TTL
	}
	return time.Duration(constants.LocalsaveTtlDays) * 24 * time.Hour
}

func (s *Store) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// Issue advances the character's counter and returns a freshly signed blob.
// HINCRBY makes the increment atomic, so two zone servers saving the same
// character at once still produce distinct counters, and only the later one
// verifies.
func (s *Store) Issue(ctx context.Context, profileID, characterID, worldID string, state []byte) (Blob, error) {
	if s.Priv == nil {
		return Blob{}, errors.New("localsave: store has no private key")
	}
	pipe := s.RDB.TxPipeline()
	incr := pipe.HIncrBy(ctx, Key(profileID), characterID, 1)
	pipe.Expire(ctx, Key(profileID), s.ttl())
	if _, err := pipe.Exec(ctx); err != nil {
		return Blob{}, err
	}
	return Build(s.Priv, profileID, characterID, worldID, uint64(incr.Val()), state, s.now()), nil
}

// checkScript compares a presented counter with the stored one atomically.
// Returns {status, counter}: 1 ok, 2 stale, 0 missing (and not adopted).
// A presented counter *above* the stored one is accepted and recorded: the
// signature proves we issued it, so the record is the thing that is behind
// (e.g. it was adopted from an older blob after a Redis restart).
var checkScript = redis.NewScript(`
local cur = redis.call('HGET', KEYS[1], ARGV[1])
local c = tonumber(ARGV[2])
if not cur then
  if ARGV[4] == '1' then
    redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
    redis.call('EXPIRE', KEYS[1], ARGV[3])
    return {1, c}
  end
  return {0, 0}
end
cur = tonumber(cur)
if c < cur then return {2, cur} end
if c > cur then redis.call('HSET', KEYS[1], ARGV[1], ARGV[2]) end
redis.call('EXPIRE', KEYS[1], ARGV[3])
return {1, c}
`)

// Verify checks the signature, then that the blob carries the newest counter
// issued for its character. It refreshes the record's TTL on success.
func (s *Store) Verify(ctx context.Context, b Blob) error {
	if err := VerifySignature(s.Pub, b); err != nil {
		return err
	}
	adopt := "0"
	if s.AdoptMissing {
		adopt = "1"
	}
	res, err := checkScript.Run(ctx, s.RDB, []string{Key(b.ProfileID)},
		b.CharacterID, strconv.FormatUint(b.Counter, 10), int64(s.ttl()/time.Second), adopt).Int64Slice()
	if err != nil {
		return err
	}
	switch res[0] {
	case 1:
		return nil
	case 2:
		return fmt.Errorf("%w: presented %d, newest %d", ErrStale, b.Counter, res[1])
	default:
		return ErrNoRecord
	}
}

// Latest returns the newest counter recorded for a character (0 if none).
func (s *Store) Latest(ctx context.Context, profileID, characterID string) (uint64, error) {
	v, err := s.RDB.HGet(ctx, Key(profileID), characterID).Uint64()
	if errors.Is(err, redis.Nil) {
		return 0, nil
	}
	return v, err
}

func devSeed() []byte {
	h := sha256.Sum256([]byte("lodestone-dev-localsave-key-NOT-FOR-PRODUCTION"))
	return h[:]
}

// PrivateKeyFromEnv reads LODESTONE_SAVE_PRIVATE_KEY (base64 32-byte seed).
// usedDev reports the insecure development fallback (log a warning; refuse in
// production). Account and zone servers both need the private key.
func PrivateKeyFromEnv() (priv ed25519.PrivateKey, usedDev bool, err error) {
	s := env.Str("LODESTONE_SAVE_PRIVATE_KEY", "")
	if s == "" {
		return ed25519.NewKeyFromSeed(devSeed()), true, nil
	}
	seed, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, false, errors.New("localsave: LODESTONE_SAVE_PRIVATE_KEY must be base64 of a 32-byte seed")
	}
	return ed25519.NewKeyFromSeed(seed), false, nil
}

// PublicKeyFromEnv reads LODESTONE_SAVE_PUBLIC_KEY (base64 32 bytes) for
// verify-only services such as the director.
func PublicKeyFromEnv() (pub ed25519.PublicKey, usedDev bool, err error) {
	s := env.Str("LODESTONE_SAVE_PUBLIC_KEY", "")
	if s == "" {
		return ed25519.NewKeyFromSeed(devSeed()).Public().(ed25519.PublicKey), true, nil
	}
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, false, errors.New("localsave: LODESTONE_SAVE_PUBLIC_KEY must be base64 of a 32-byte key")
	}
	return ed25519.PublicKey(b), false, nil
}
