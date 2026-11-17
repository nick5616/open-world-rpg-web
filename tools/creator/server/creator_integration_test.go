package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"lodestone/server/pkg/accountapi/dbtest"
	"lodestone/tools/creator/server/internal/vibe"
	"lodestone/tools/creator/server/internal/vibe/vibetest"
)

// TestCreatorProcess crosses the process boundary: it builds the creator
// binary and runs it against a scratch Postgres database, the shared Redis
// and a fake Messages API living in this test process. It mints a world from
// the seed only, from sliders and (flag on) from vibe text, checks the rows,
// then restarts with the flag off and checks the fake model sees nothing.
func TestCreatorProcess(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and runs the binary")
	}
	wasm := filepath.Join("..", "..", "..", "worldgen", "pkg", "worldgen.wasm")
	if _, err := os.Stat(wasm); err != nil {
		if os.Getenv("LODESTONE_REQUIRE_WASM") == "1" {
			t.Fatal(err)
		}
		t.Skip("worldgen.wasm not built")
	}
	pool, dbURL := dbtest.Postgres(t)
	rdb := dbtest.Redis(t)

	bin := filepath.Join(t.TempDir(), "creator")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	fake := &vibetest.Fake{WantKey: "sk-integration"}
	model := httptest.NewServer(fake)
	defer model.Close()
	schema, _ := filepath.Abs(filepath.Join("..", "..", "..", "contracts", "worldspec.schema.json"))
	wasmAbs, _ := filepath.Abs(wasm)

	start := func(llm string) (string, func() string) {
		port := freePort(t)
		cmd := exec.Command(bin)
		var logs bytes.Buffer
		cmd.Stdout, cmd.Stderr = &logs, &logs
		cmd.Env = append(os.Environ(),
			"LODESTONE_CREATOR_PORT="+port,
			"LODESTONE_PG_URL="+dbURL,
			"LODESTONE_WORLDSPEC_SCHEMA="+schema,
			"LODESTONE_WORLDGEN_WASM="+wasmAbs,
			"LODESTONE_CREATOR_LLM="+llm,
			"ANTHROPIC_API_KEY=sk-integration",
			"LODESTONE_CREATOR_LLM_BASE_URL="+model.URL,
		)
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		base := "http://127.0.0.1:" + port
		deadline := time.Now().Add(30 * time.Second)
		for {
			resp, err := http.Get(base + "/healthz")
			if err == nil {
				resp.Body.Close()
				break
			}
			if time.Now().After(deadline) {
				_ = cmd.Process.Kill()
				t.Fatalf("creator did not start:\n%s", logs.String())
			}
			time.Sleep(100 * time.Millisecond)
		}
		return base, func() string {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			return logs.String()
		}
	}

	var rb [4]byte
	_, _ = rand.Read(rb[:])
	prompt := "drowned cathedral archipelago, cold, lots of caves " + hex.EncodeToString(rb[:])
	cacheKey := "creator:vibe:" + vibe.CacheKey(vibe.NormalizePrompt(prompt), 1)
	defer rdb.Del(context.Background(), cacheKey)

	// Flag on.
	base, stop := start("1")
	if _, cfg := call(t, "GET", base+"/v1/config", nil); cfg["llm"] != true || cfg["genVersion"] != "4" {
		t.Fatalf("config %v", cfg)
	}
	code, seedMint := call(t, "POST", base+"/v1/mint", map[string]string{"seed": "1234"})
	if code != 201 || seedMint["world"].(map[string]any)["atlasHash"] != "3296986ffd1a2fb7" {
		t.Fatalf("seed mint %d %v", code, seedMint)
	}
	slider := seedMint["world"].(map[string]any)["spec"].(map[string]any)
	slider["mountainHeight"], slider["name"], slider["palette"] = 0.95, "Integration Highlands", "frost"
	code, sliderMint := call(t, "POST", base+"/v1/mint", map[string]any{"spec": slider, "source": "sliders"})
	if code != 201 || sliderMint["source"] != "sliders" {
		t.Fatalf("slider mint %d %v", code, sliderMint)
	}
	code, v := call(t, "POST", base+"/v1/vibe", map[string]string{"prompt": prompt, "seed": "5150"})
	if code != 200 || v["cached"] != false || fake.Requests.Load() != 1 {
		t.Fatalf("vibe %d %v (requests %d)", code, v, fake.Requests.Load())
	}
	if n, _ := rdb.Exists(context.Background(), cacheKey).Result(); n != 1 {
		t.Fatal("vibe result not cached in Redis")
	}
	code, vibeMint := call(t, "POST", base+"/v1/mint", map[string]any{"spec": v["spec"], "source": "vibe"})
	if code != 201 || vibeMint["world"].(map[string]any)["seed"] != "5150" {
		t.Fatalf("vibe mint %d %v", code, vibeMint)
	}
	// Cached the second time: no new model request.
	if code, v2 := call(t, "POST", base+"/v1/vibe", map[string]string{"prompt": strings.ToUpper(prompt), "seed": "5150"}); code != 200 || v2["cached"] != true || fake.Requests.Load() != 1 {
		t.Fatalf("cached vibe %d %v", code, v2)
	}
	logsOn := stop()

	// The rows are the worlds.
	rows, err := pool.Query(context.Background(), `SELECT name, seed::text, gen_version, atlas_hash, official, spec->>'seed' FROM worlds ORDER BY created_at`)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for rows.Next() {
		var name, seed, gv, ah, specSeed string
		var official bool
		if err := rows.Scan(&name, &seed, &gv, &ah, &official, &specSeed); err != nil {
			t.Fatal(err)
		}
		if official || gv != "4" || len(ah) != 16 || specSeed != seed {
			t.Fatalf("row %s %s %s %s %v %s", name, seed, gv, ah, official, specSeed)
		}
		got = append(got, name+"/"+seed)
	}
	if len(got) != 3 || got[1] != "Integration Highlands/1234" || got[2] != "The Drowned Cathedral Archipelago/5150" {
		t.Fatalf("rows %v", got)
	}
	vibeLogged := false
	for _, line := range strings.Split(logsOn, "\n") {
		vibeLogged = vibeLogged || (strings.Contains(line, `"msg":"minted world"`) && strings.Contains(line, `"source":"vibe"`))
	}
	if !vibeLogged {
		t.Fatalf("no vibe mint log:\n%s", logsOn)
	}

	// Flag off: same key, same reachable fake, zero model requests.
	before := fake.Requests.Load()
	base, stop = start("0")
	if _, cfg := call(t, "GET", base+"/v1/config", nil); cfg["llm"] != false {
		t.Fatalf("config %v", cfg)
	}
	if code, body := call(t, "POST", base+"/v1/vibe", map[string]string{"prompt": "frozen isles " + hex.EncodeToString(rb[:]), "seed": "1"}); code != 503 || body["error"] != "llm_disabled" {
		t.Fatalf("vibe with flag off: %d %v", code, body)
	}
	if code, _ := call(t, "POST", base+"/v1/mint", map[string]string{"seed": "99"}); code != 201 {
		t.Fatal("seed mint with flag off failed")
	}
	stop()
	if fake.Requests.Load() != before {
		t.Fatalf("flag off made %d model requests", fake.Requests.Load()-before)
	}
}

func freePort(t *testing.T) string {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return fmt.Sprint(l.Addr().(*net.TCPAddr).Port)
}

func call(t *testing.T, method, url string, body any) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	if body == nil {
		b = nil
	}
	req, _ := http.NewRequest(method, url, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}
