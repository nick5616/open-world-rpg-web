package vibe

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"lodestone/tools/creator/server/internal/spec"
	"lodestone/tools/creator/server/internal/vibe/vibetest"
)

func gate(t *testing.T) *spec.Gate {
	t.Helper()
	p, err := spec.FindRepoFile(spec.SchemaRel, ".")
	if err != nil {
		t.Fatal(err)
	}
	g, err := spec.LoadGate(p)
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func setup(t *testing.T) (*Service, *vibetest.Fake) {
	t.Helper()
	fake := &vibetest.Fake{WantKey: "sk-test"}
	srv := httptest.NewServer(fake)
	t.Cleanup(srv.Close)
	g := gate(t)
	c, err := NewClient(Config{Enabled: true, APIKey: "sk-test", BaseURL: srv.URL, HTTP: srv.Client()}, g.ModelSchema())
	if err != nil {
		t.Fatal(err)
	}
	return &Service{Gen: c, Gate: g, Cache: &MemoryCache{}}, fake
}

func TestNewClientRefusesWhenDisabled(t *testing.T) {
	for _, cfg := range []Config{{Enabled: false, APIKey: "sk-test"}, {Enabled: true, APIKey: ""}, {Enabled: true, APIKey: "  "}} {
		if c, err := NewClient(cfg, nil); c != nil || !errors.Is(err, ErrDisabled) {
			t.Fatalf("NewClient(%+v) = %v, %v", cfg, c, err)
		}
	}
}

func TestVibeClampsDropsTagsAndUsesCreatorSeed(t *testing.T) {
	s, fake := setup(t)
	ctx := context.Background()
	res, err := s.Vibe(ctx, "drowned cathedral archipelago, cold, lots of caves", "424242")
	if err != nil {
		t.Fatal(err)
	}
	if res.Cached || res.Attempts != 1 || fake.Requests.Load() != 1 {
		t.Fatalf("cached=%v attempts=%d requests=%d", res.Cached, res.Attempts, fake.Requests.Load())
	}
	w := res.Spec
	if w.Seed != "424242" || w.CaveDensity != 1 || w.CaveMaxDepth != 256 || w.Palette != "frost" || w.Name != "The Drowned Cathedral Archipelago" {
		t.Fatalf("spec: %s", res.JSON)
	}
	for _, tag := range w.LootThemes {
		if tag == "gothic" {
			t.Fatal("unknown tag survived")
		}
	}
	reasons := map[string]bool{}
	for _, c := range res.Changes {
		reasons[c.Path+":"+c.Reason] = true
	}
	for _, want := range []string{"caveDensity:clamped", "caveMaxDepth:clamped", "lootThemes:dropped-unknown-tag"} {
		if !reasons[want] {
			t.Errorf("missing change %s in %v", want, res.Changes)
		}
	}

	// The request carried the structured-output schema and the small model.
	var body map[string]any
	_ = json.Unmarshal(fake.LastBody, &body)
	if body["model"] != DefaultModel {
		t.Fatalf("model %v", body["model"])
	}
	if _, bad := body["temperature"]; bad {
		t.Fatal("sampling params are rejected by API version 2026-10-21")
	}

	// Same vibe, different spacing/case and a new seed: cache hit, no call.
	res2, err := s.Vibe(ctx, "  Drowned cathedral   ARCHIPELAGO, cold, lots of caves ", "7")
	if err != nil {
		t.Fatal(err)
	}
	if !res2.Cached || fake.Requests.Load() != 1 || res2.Spec.Seed != "7" || res2.Spec.Name != w.Name {
		t.Fatalf("cache: cached=%v requests=%d seed=%s", res2.Cached, fake.Requests.Load(), res2.Spec.Seed)
	}
	if res2.CacheKey != CacheKey("drowned cathedral archipelago, cold, lots of caves", 1) {
		t.Fatal("cache key is not sha256(normalized prompt + specVersion)")
	}
}

func TestVibeRetriesOnceThenSucceeds(t *testing.T) {
	s, fake := setup(t)
	res, err := s.Vibe(context.Background(), "scorched badlands [fail-once]", "1")
	if err != nil {
		t.Fatal(err)
	}
	if res.Attempts != 2 || fake.Requests.Load() != 2 || res.Spec.Palette != "ashen" {
		t.Fatalf("attempts=%d requests=%d", res.Attempts, fake.Requests.Load())
	}
}

func TestVibeGivesUpAfterOneRetry(t *testing.T) {
	for _, marker := range []string{"[fail-always]", "[refuse]", "[http500]"} {
		s, fake := setup(t)
		_, err := s.Vibe(context.Background(), "frozen isles "+marker, "1")
		var fe *FailedError
		if !errors.As(err, &fe) || len(fe.Reasons) != 2 {
			t.Fatalf("%s: err=%v", marker, err)
		}
		if fake.Requests.Load() != 2 {
			t.Fatalf("%s: %d requests, want exactly 2 (one retry, no repair loop)", marker, fake.Requests.Load())
		}
		// Failures are not cached.
		if b, ok, _ := s.Cache.Get(context.Background(), CacheKey(NormalizePrompt("frozen isles "+marker), 1)); ok {
			t.Fatalf("%s: failure cached: %s", marker, b)
		}
	}
}

func TestVibeRejectsBadPrompts(t *testing.T) {
	s, fake := setup(t)
	for _, p := range []string{"", "   ", strings.Repeat("a", MaxPromptRunes+1)} {
		if _, err := s.Vibe(context.Background(), p, "1"); !errors.Is(err, ErrBadPrompt) {
			t.Fatalf("%q: %v", p, err)
		}
	}
	if fake.Requests.Load() != 0 {
		t.Fatal("bad prompts reached the model")
	}
}
