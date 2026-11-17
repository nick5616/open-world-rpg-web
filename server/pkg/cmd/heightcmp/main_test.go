package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"lodestone/server/pkg/worldhost"
)

// TestGoMatchesNode runs the comparison against the Node host in a child
// process (a smaller N than the 10,000-point evidence run, to keep `go test`
// quick). Chromium joins with LODESTONE_HEIGHTCMP_CHROMIUM=1.
func TestGoMatchesNode(t *testing.T) {
	if testing.Short() {
		t.Skip("spawns node")
	}
	if _, err := worldhost.ResolvePath(os.Getenv(worldhost.EnvWasmPath)); errors.Is(err, worldhost.ErrNoWasm) && os.Getenv("LODESTONE_REQUIRE_WASM") != "1" {
		t.Skipf("skipping: %v", err)
	}
	root, err := repoRoot()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "node_modules", "vite-node")); err != nil {
		t.Skip("node_modules not installed (npm install)")
	}
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not on PATH")
	}
	var log strings.Builder
	rep, err := run(context.Background(), config{seed: 7, n: 400, pointsSd: 11, node: true,
		chromium: os.Getenv("LODESTONE_HEIGHTCMP_CHROMIUM") == "1", root: root, log: &log})
	if err != nil {
		t.Fatal(err)
	}
	t.Log(log.String())
	if len(rep.columns) < 4 {
		t.Fatalf("expected go-wasm, go-fast, node-wasm, node-chunk; got %d columns", len(rep.columns))
	}
	for _, c := range rep.columns[1:] {
		if c.match != len(rep.points) {
			t.Fatalf("%s: %d/%d match", c.name, c.match, len(rep.points))
		}
	}
	// Golden world seed-7's atlas: every host built the same one.
	for host, h := range rep.atlasHash {
		if h != "ce0b6451009659fd" {
			t.Fatalf("%s atlas %s", host, h)
		}
	}
	if !strings.Contains(log.String(), "RESULT: PASS") {
		t.Fatal("no PASS line")
	}
}
