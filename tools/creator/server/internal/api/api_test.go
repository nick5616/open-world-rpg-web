package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"lodestone/tools/creator/server/internal/spec"
	"lodestone/tools/creator/server/internal/store"
	"lodestone/tools/creator/server/internal/vibe/vibetest"
	"lodestone/tools/creator/server/internal/worldgen"
)

// memStore is an in-memory WorldStore with the same dedupe rule as store.Store.
type memStore struct {
	mu     sync.Mutex
	worlds []store.World
}

func (m *memStore) Insert(_ context.Context, w store.World) (store.World, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, e := range m.worlds {
		if e.Seed == w.Seed && e.GenVersion == w.GenVersion && e.AtlasHash == w.AtlasHash {
			return e, true, nil
		}
	}
	w.ID = "w" + string(rune('a'+len(m.worlds)))
	w.CreatedAt = time.Now()
	m.worlds = append(m.worlds, w)
	return w, false, nil
}

func (m *memStore) List(context.Context, int) ([]store.World, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]store.World(nil), m.worlds...), nil
}

// countingTransport records every outbound request the process makes.
type countingTransport struct {
	n    atomic.Int64
	next http.RoundTripper
}

func (c *countingTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	c.n.Add(1)
	return c.next.RoundTrip(r)
}

var (
	modOnce sync.Once
	mod     *worldgen.Module
	modErr  error
)

func testDeps(t *testing.T) Deps {
	t.Helper()
	wasm := filepath.Join("..", "..", "..", "..", "..", "worldgen", "pkg", "worldgen.wasm")
	if _, err := os.Stat(wasm); err != nil {
		if os.Getenv("LODESTONE_REQUIRE_WASM") == "1" {
			t.Fatal(err)
		}
		t.Skip("worldgen.wasm not built (npm run build:wasm)")
	}
	modOnce.Do(func() { mod, modErr = worldgen.Load(context.Background(), wasm) })
	if modErr != nil {
		t.Fatal(modErr)
	}
	p, err := spec.FindRepoFile(spec.SchemaRel, ".")
	if err != nil {
		t.Fatal(err)
	}
	g, err := spec.LoadGate(p)
	if err != nil {
		t.Fatal(err)
	}
	return Deps{Gate: g, Module: mod, Store: &memStore{}}
}

type harness struct {
	srv   *httptest.Server
	fake  *vibetest.Fake
	trans *countingTransport
	s     *Server
}

func newHarness(t *testing.T, env map[string]string) *harness {
	t.Helper()
	fake := &vibetest.Fake{}
	model := httptest.NewServer(fake)
	t.Cleanup(model.Close)
	trans := &countingTransport{next: http.DefaultTransport}
	get := func(k string) string {
		if k == "LODESTONE_CREATOR_LLM_BASE_URL" {
			return model.URL
		}
		return env[k]
	}
	d := testDeps(t)
	d.HTTP = &http.Client{Transport: trans}
	s, err := New(ConfigFromEnv(get), d)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	s.Register(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return &harness{srv: srv, fake: fake, trans: trans, s: s}
}

func (h *harness) do(t *testing.T, method, path string, body any) (int, map[string]any) {
	t.Helper()
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, h.srv.URL+path, rd)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func baseSpec(t *testing.T, seed uint64) map[string]any {
	t.Helper()
	b, err := mod.SpecFromSeed(context.Background(), seed)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	return m
}

// TestFlagOffNeverReachesModel is the acceptance check "with the flag off, no
// code path calls a model": with an API key present and a reachable fake
// Messages API, every route is exercised (including /v1/vibe) and neither
// the fake nor the injected transport sees a single request. The flag-on
// test below uses the same counters, proving they would notice.
func TestFlagOffNeverReachesModel(t *testing.T) {
	for _, env := range []map[string]string{
		{"ANTHROPIC_API_KEY": "sk-test"},                                 // flag unset
		{"LODESTONE_CREATOR_LLM": "0", "ANTHROPIC_API_KEY": "sk-test"},   // flag off
		{"LODESTONE_CREATOR_LLM": "yes", "ANTHROPIC_API_KEY": "sk-test"}, // not a recognized "on"
		{"LODESTONE_CREATOR_LLM": "1"},                                   // flag on, no key
	} {
		h := newHarness(t, env)
		if h.s.vibe != nil || h.s.LLMEnabled() {
			t.Fatalf("%v: vibe service constructed", env)
		}
		if code, body := h.do(t, "GET", "/v1/config", nil); code != 200 || body["llm"] != false {
			t.Fatalf("%v: config %d %v", env, code, body)
		}
		if code, body := h.do(t, "POST", "/v1/vibe", map[string]string{"prompt": "drowned cathedral archipelago", "seed": "1"}); code != 503 || body["error"] != "llm_disabled" {
			t.Fatalf("%v: vibe %d %v", env, code, body)
		}
		if code, _ := h.do(t, "POST", "/v1/normalize", map[string]any{"spec": baseSpec(t, 3)}); code != 200 {
			t.Fatalf("%v: normalize %d", env, code)
		}
		if code, _ := h.do(t, "POST", "/v1/mint", map[string]string{"seed": "3"}); code != 201 {
			t.Fatalf("%v: mint %d", env, code)
		}
		if code, _ := h.do(t, "POST", "/v1/mint", map[string]any{"spec": baseSpec(t, 4)}); code != 201 {
			t.Fatalf("%v: mint spec %d", env, code)
		}
		h.do(t, "GET", "/v1/worlds", nil)
		if n := h.fake.Requests.Load() + h.trans.n.Load(); n != 0 {
			t.Fatalf("%v: %d model requests with the flag off", env, n)
		}
	}
}

func TestFlagOnCallsModelThroughInjectedClient(t *testing.T) {
	h := newHarness(t, map[string]string{"LODESTONE_CREATOR_LLM": "1", "ANTHROPIC_API_KEY": "sk-test"})
	code, body := h.do(t, "POST", "/v1/vibe", map[string]string{"prompt": "drowned cathedral archipelago, cold, lots of caves", "seed": "99"})
	if code != 200 || body["cached"] != false {
		t.Fatalf("vibe %d %v", code, body)
	}
	if h.fake.Requests.Load() != 1 || h.trans.n.Load() != 1 {
		t.Fatalf("fake=%d transport=%d", h.fake.Requests.Load(), h.trans.n.Load())
	}
	sp := body["spec"].(map[string]any)
	if sp["seed"] != "99" || sp["caveDensity"] != 1.0 {
		t.Fatalf("spec %v", sp)
	}
	// The vibe spec mints like any slider spec.
	code, minted := h.do(t, "POST", "/v1/mint", map[string]any{"spec": sp, "source": "vibe"})
	if code != 201 || minted["source"] != "vibe" {
		t.Fatalf("mint %d %v", code, minted)
	}
	if code, body := h.do(t, "POST", "/v1/vibe", map[string]string{"prompt": "x [fail-always]", "seed": "1"}); code != 502 || body["error"] != "llm_failed" {
		t.Fatalf("failure: %d %v", code, body)
	}
}

func TestMintFromSeedMatchesGoldenAtlas(t *testing.T) {
	h := newHarness(t, nil)
	code, body := h.do(t, "POST", "/v1/mint", map[string]string{"seed": "7"})
	if code != 201 {
		t.Fatalf("mint %d %v", code, body)
	}
	w := body["world"].(map[string]any)
	// worldgen/golden/golden.json (genVersion 2), world "seed-7".
	if w["atlasHash"] != "e0e3c0c797584a62" || w["genVersion"] != "2" || w["seed"] != "7" || w["name"] != "Shores of Sonaliassver" || body["source"] != "seed" {
		t.Fatalf("world %v", w)
	}
	// Minting it again returns the same row.
	code, again := h.do(t, "POST", "/v1/mint", map[string]string{"seed": "7"})
	if code != 200 || again["existed"] != true || again["world"].(map[string]any)["id"] != w["id"] {
		t.Fatalf("re-mint %d %v", code, again)
	}
}

func TestMintFromSlidersNormalizesFirst(t *testing.T) {
	h := newHarness(t, nil)
	sp := baseSpec(t, 7)
	sp["seaLevel"] = 1.5
	sp["lootThemes"] = []string{"drowned", "nonsense"}
	sp["name"] = "Slider Isles!"
	code, body := h.do(t, "POST", "/v1/mint", map[string]any{"spec": sp})
	if code != 201 || body["source"] != "sliders" {
		t.Fatalf("mint %d %v", code, body)
	}
	stored := body["world"].(map[string]any)["spec"].(map[string]any)
	if stored["seaLevel"] != 1.0 || stored["name"] != "Slider Isles" || len(stored["lootThemes"].([]any)) != 1 {
		t.Fatalf("stored spec %v", stored)
	}
	if body["world"].(map[string]any)["atlasHash"] == "e0e3c0c797584a62" {
		t.Fatal("slider world hashed like the seed-only world")
	}
	if n := len(body["changes"].([]any)); n == 0 {
		t.Fatal("no changes reported")
	}
	// Unclampable input is a 422 with details.
	sp["palette"] = "neon"
	code, body = h.do(t, "POST", "/v1/mint", map[string]any{"spec": sp})
	if code != 422 || body["error"] != "invalid_spec" || !strings.Contains(strings.Join(toStrings(body["details"]), " "), "palette") {
		t.Fatalf("bad spec %d %v", code, body)
	}
}

func TestBadRequestsAndAuth(t *testing.T) {
	h := newHarness(t, nil)
	for _, b := range []any{map[string]string{}, map[string]string{"seed": "-1"}, map[string]string{"seed": "18446744073709551616"}} {
		if code, _ := h.do(t, "POST", "/v1/mint", b); code != 400 {
			t.Fatalf("%v: %d", b, code)
		}
	}
	ha := newHarness(t, map[string]string{"LODESTONE_CREATOR_TOKEN": "tok"})
	if code, _ := ha.do(t, "POST", "/v1/mint", map[string]string{"seed": "7"}); code != 401 {
		t.Fatalf("no token: %d", code)
	}
	if code, _ := ha.do(t, "GET", "/v1/config", nil); code != 200 {
		t.Fatal("reads are open")
	}
	if _, err := New(ConfigFromEnv(func(k string) string { return map[string]string{"LODESTONE_ENV": "production"}[k] }), testDeps(t)); err == nil {
		t.Fatal("production without a token must refuse to start")
	}
}

func toStrings(v any) []string {
	var out []string
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	return out
}
