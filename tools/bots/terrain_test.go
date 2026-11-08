package main

import (
	"context"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"os"
	"strconv"
	"testing"
	"time"

	"lodestone/server/pkg/worldhost"
)

func botTerrain(t *testing.T) *worldhost.Terrain {
	t.Helper()
	mod, err := worldhost.LoadFromEnv(context.Background())
	if err != nil {
		if errors.Is(err, worldhost.ErrNoWasm) && os.Getenv("LODESTONE_REQUIRE_WASM") != "1" {
			t.Skipf("skipping: %v", err)
		}
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = mod.Close(context.Background()) })
	mt, err := mod.Mint(20261108, nil, worldhost.WorldOptions{MaxInstances: 2})
	if err != nil {
		t.Fatal(err)
	}
	// What the zone would report in /debug/zone for this world.
	tr, err := openTerrain(zoneInfo{Seed: 20261108, GenVersion: mt.GenVersion, Spec: mt.Spec, AtlasHash: mt.AtlasHash}, "on")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(tr.Close)
	if _, err := openTerrain(zoneInfo{Seed: 20261108, GenVersion: mt.GenVersion, Spec: mt.Spec, AtlasHash: "0000000000000000"}, "on"); err == nil {
		t.Fatal("bots accepted a world whose atlas hash differs from the zone's")
	}
	if tr2, err := openTerrain(zoneInfo{}, "auto"); err != nil || tr2 != nil {
		t.Fatalf("auto against a flat zone: %v %v", tr2, err)
	}
	return tr
}

func TestLandSpawnsAreDryAndExact(t *testing.T) {
	tr := botTerrain(t)
	rng := rand.New(rand.NewSource(3))
	draw := func() (float64, float64) { return 100 + rng.Float64()*3896, 100 + rng.Float64()*3896 }
	for i := 0; i < 40; i++ {
		x, z := landSpawn(tr, draw)
		if _, ok := tr.DryPoint(x, z); !ok {
			t.Fatalf("spawn (%v, %v) is wet", x, z)
		}
		// The spawn query carries %.2f; it must round-trip exactly or the
		// bot would predict from a different point than the server spawned.
		qx, _ := strconv.ParseFloat(fmt.Sprintf("%.2f", x), 64)
		qz, _ := strconv.ParseFloat(fmt.Sprintf("%.2f", z), 64)
		if qx != x || qz != z {
			t.Fatalf("spawn (%v, %v) does not survive %%.2f", x, z)
		}
	}
}

func TestBotTurnsBackFromTheSea(t *testing.T) {
	tr := botTerrain(t)
	cfg := &botConfig{worldM: 4096, terrain: tr}
	b := newBot(1, cfg, 1, 0, 0)
	sea := float64(tr.World().Header.SeaLevel)
	// Find a coast: dry here, sea 12 m to the north (-z, yaw 0).
	for x := 200.0; x < 3900; x += 37 {
		for z := 200.0; z < 3900; z += 41 {
			if tr.HeightAt(x, z) > sea+1 && tr.HeightAt(x, z-12) < sea {
				b.yaw, b.heading = 0, 0
				b.avoidWater(x, z)
				if math.Abs(math.Remainder(b.heading-math.Pi, 2*math.Pi)) > 0.51 {
					t.Fatalf("heading %v at the coast (%v, %v), want ~pi", b.heading, x, z)
				}
				b.state.Pos.X, b.state.Pos.Z = x, z
				b.decide(time.Now()) // also asks the cache for chunks
				return
			}
		}
	}
	t.Skip("no coast found in this world")
}
