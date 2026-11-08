package vibe

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/redis/go-redis/v9"

	"lodestone/tools/creator/server/internal/spec"
)

// MaxPromptRunes bounds the creator's text: a vibe is a sentence, not a
// document, and the bound keeps the request small and cheap.
const MaxPromptRunes = 500

// Cache stores normalized specs by key.
type Cache interface {
	Get(ctx context.Context, key string) ([]byte, bool, error)
	Set(ctx context.Context, key string, val []byte) error
}

// RedisCache keeps entries in Redis under creator:vibe:<key> for TTL.
// Losing the cache (local Redis has no persistence) only costs a model call.
type RedisCache struct {
	R   *redis.Client
	TTL time.Duration
}

func (c RedisCache) Get(ctx context.Context, key string) ([]byte, bool, error) {
	b, err := c.R.Get(ctx, "creator:vibe:"+key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	return b, err == nil, err
}

func (c RedisCache) Set(ctx context.Context, key string, val []byte) error {
	return c.R.Set(ctx, "creator:vibe:"+key, val, c.TTL).Err()
}

// MemoryCache is a Cache for tests and Redis-less local runs.
type MemoryCache struct {
	mu sync.Mutex
	m  map[string][]byte
}

func (c *MemoryCache) Get(_ context.Context, key string) ([]byte, bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	b, ok := c.m[key]
	return b, ok, nil
}

func (c *MemoryCache) Set(_ context.Context, key string, val []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.m == nil {
		c.m = map[string][]byte{}
	}
	c.m[key] = append([]byte(nil), val...)
	return nil
}

// Generator is what Service needs from the model client (Client satisfies it).
type Generator interface {
	Generate(ctx context.Context, prompt string) ([]byte, error)
}

// Service turns vibe text into a normalized spec.
type Service struct {
	Gen   Generator
	Gate  *spec.Gate
	Cache Cache
}

// Result is a vibe outcome.
type Result struct {
	spec.Result
	Cached   bool
	Attempts int // model calls made (0 on a cache hit)
	CacheKey string
}

// FailedError is returned when both attempts failed (call or validation).
type FailedError struct{ Reasons []string }

func (e *FailedError) Error() string {
	return "the model did not produce a valid WorldSpec: " + strings.Join(e.Reasons, " | ")
}

// NormalizePrompt lowercases, collapses whitespace and trims, so trivially
// different phrasings of the same vibe share a cache entry.
func NormalizePrompt(p string) string { return strings.Join(strings.Fields(strings.ToLower(p)), " ") }

// CacheKey is sha256(normalized prompt + specVersion) in hex (spec 6).
func CacheKey(normalizedPrompt string, specVersion int) string {
	sum := sha256.Sum256([]byte(normalizedPrompt + "\n" + strconv.Itoa(specVersion)))
	return hex.EncodeToString(sum[:])
}

// ErrBadPrompt is a 400: empty or too long.
var ErrBadPrompt = fmt.Errorf("prompt must be 1 to %d characters", MaxPromptRunes)

// Vibe returns a normalized spec for prompt with the creator's seed. The
// model never chooses the seed: the cached entry and every model answer get
// the requested seed before normalizing, so a cached vibe re-used with a new
// seed gives a new world with the same character.
func (s *Service) Vibe(ctx context.Context, prompt, seed string) (Result, error) {
	np := NormalizePrompt(prompt)
	if np == "" || utf8.RuneCountInString(np) > MaxPromptRunes {
		return Result{}, ErrBadPrompt
	}
	key := CacheKey(np, s.Gate.SpecVersion)
	if b, ok, err := s.Cache.Get(ctx, key); err == nil && ok {
		if res, err := s.normalizeWithSeed(b, seed); err == nil {
			return Result{Result: res, Cached: true, CacheKey: key}, nil
		}
		// A stale entry (schema changed under it) falls through to the model.
	}
	var reasons []string
	// One call plus at most one retry: no repair loop (spec 6).
	for attempt := 1; attempt <= 2; attempt++ {
		raw, err := s.Gen.Generate(ctx, prompt)
		if err != nil {
			reasons = append(reasons, fmt.Sprintf("attempt %d: %v", attempt, err))
			continue
		}
		res, err := s.normalizeWithSeed(raw, seed)
		if err != nil {
			reasons = append(reasons, fmt.Sprintf("attempt %d: %v", attempt, err))
			continue
		}
		// Cache the normalized spec (seed included; it is replaced on reuse).
		// A cache write failure is not the creator's problem.
		_ = s.Cache.Set(ctx, key, res.JSON)
		return Result{Result: res, Attempts: attempt, CacheKey: key}, nil
	}
	return Result{}, &FailedError{reasons}
}

// normalizeWithSeed sets "seed" on a JSON object (if it is one) and runs the
// normalize gate. Non-objects are left as they are and fail validation.
func (s *Service) normalizeWithSeed(raw []byte, seed string) (spec.Result, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err == nil && obj != nil {
		obj["seed"], _ = json.Marshal(seed)
		raw, _ = json.Marshal(obj)
	}
	return s.Gate.Normalize(raw)
}
