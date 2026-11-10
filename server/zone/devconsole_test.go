package main

// CR 032: the dev console is local only. No deploy may turn it on, and a
// zone that verifies real tickets refuses it even if the variable leaks in.

import (
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestDevConsoleNeedsTheFlagAndTheDevKey(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	for _, c := range []struct {
		flag, devKey, want bool
	}{{false, false, false}, {false, true, false}, {true, false, false}, {true, true, true}} {
		if got := devConsoleFrom(c.flag, c.devKey, log); got != c.want {
			t.Errorf("flag %v devKey %v: %v, want %v", c.flag, c.devKey, got, c.want)
		}
	}
	t.Setenv("LODESTONE_ZONE_DEV", "")
	if devConsole(log, true) {
		t.Error("dev console on without LODESTONE_ZONE_DEV")
	}
}

// The variable itself (LODESTONE_ZONE_DEV_SPAWN and friends are other switches).
var devVar = regexp.MustCompile(`LODESTONE_ZONE_DEV([^_A-Za-z0-9]|$)`)

func TestNoDeployEnablesTheDevConsole(t *testing.T) {
	root := filepath.Join("..", "..")
	infra := filepath.Join(root, "infra")
	files := 0
	err := filepath.WalkDir(infra, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		files++
		if loc := devVar.FindIndex(b); loc != nil {
			t.Errorf("%s sets or mentions LODESTONE_ZONE_DEV (the dev console must never be on in a deploy): %q", p, b[max(0, loc[0]-20):min(len(b), loc[1]+20)])
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if files < 10 {
		t.Fatalf("read only %d files under %s", files, infra)
	}
	// And `npm run dev` does turn it on (scripts/dev.mjs), for the zone only.
	dev, err := os.ReadFile(filepath.Join(root, "scripts", "dev.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(dev), "LODESTONE_ZONE_DEV: process.env.LODESTONE_ZONE_DEV ?? '1'") {
		t.Error("scripts/dev.mjs no longer turns the dev console on for `npm run dev`")
	}
}
