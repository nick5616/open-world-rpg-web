package main

// Playtest 1 acceptance across process boundaries (CR 012, decision 0021):
// the real zone binary on the official world (seed 20261108) with its atlas
// enemies, night and discovery-stamped difficulty, a scratch Postgres with
// real character rows, clients over WebSocket, the world clock at 22:00.
//
//   - A fresh level-1 character at a Haven camp near the world spawn sees
//     only beginner enemies (slimes) at level 1 and no demon all night.
//   - A level-15 character discovering a far, unstamped area stamps it at
//     their level (Postgres area_difficulty), meets level-15+ enemies there
//     and demons hunt them.
//   - Two zone processes on the same database agree on every stamp: one
//     stamped area read back by the other zone, and an area claimed by both
//     zones at the same moment (different player levels) has one stamp.
//
// Set LODESTONE_EVIDENCE=1 to print the step log (docs/evidence/pt-progression-process.txt).

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/zone/internal/game"
)

type diffDebug struct {
	CellM   float64 `json:"cellM"`
	PerEdge int     `json:"perEdge"`
	Won     int64   `json:"won"`
	Lost    int64   `json:"lost"`
	Areas   []struct {
		Cell  int    `json:"cell"`
		CX    int    `json:"cx"`
		CZ    int    `json:"cz"`
		Level int    `json:"level"`
		Tier  string `json:"tier"`
		Haven bool   `json:"haven"`
		By    string `json:"by"`
	} `json:"areas"`
}

func getJSON(t *testing.T, url string, v any) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		t.Fatal(err)
	}
}

func combatGroups(t *testing.T, port int) []game.CombatGroupDebug {
	var d game.CombatDebugInfo
	getJSON(t, fmt.Sprintf("http://127.0.0.1:%d/debug/combat", port), &d)
	return d.Groups
}

func difficultyOf(t *testing.T, port int) diffDebug {
	var d diffDebug
	getJSON(t, fmt.Sprintf("http://127.0.0.1:%d/debug/difficulty", port), &d)
	return d
}

// nightOffset puts the world clock at 22:00 now (a 3600 s day, 150 s an hour).
func nightOffset() float64 {
	now := float64(time.Now().Unix() % 3600)
	return math.Mod(22*150-now+3600, 3600)
}

func (w *itemClient) area(t *testing.T, d time.Duration) (cell uint32, level int, tier int, flags int, by string) {
	t.Helper()
	ev := w.last(game.EventArea, d)
	return ev.TargetID, int(ev.Value), int(ev.Data[1]), int(ev.Data[2]), string(ev.Data[7:])
}

func TestZoneProcessDiscoveryDifficulty(t *testing.T) {
	f := newItemFixture(t)
	evidence := os.Getenv("LODESTONE_EVIDENCE") != ""
	ctx := context.Background()
	off := fmt.Sprintf("LODESTONE_ZONE_TIME_OFFSET_S=%.0f", nightOffset())
	portA := freePort(t)
	za := startItemZone(t, f.bin, f.wasm, f.dbURL, f.world, portA, "LODESTONE_ZONE_NO_ATLAS_ENEMIES=0", off, "LODESTONE_ZONE_EXIT_AFTER=240s")
	za.waitLog(t, "difficulty stamps loaded", 30*time.Second)
	f.logf("zone A up on %d (world %s), world clock 22:00", portA, f.world)
	def := &combatdefs.D.Difficulty
	cellOf := func(x, z float64) (int, int) {
		return int(math.Floor(x / def.CellM)), int(math.Floor(z / def.CellM))
	}
	dd := difficultyOf(t, portA)
	haven := map[[2]int]bool{}
	for _, a := range dd.Areas {
		if a.Haven {
			haven[[2]int{a.CX, a.CZ}] = true
		}
	}
	f.logf("Haven: %d areas of %.0f m around the spawn (%.0f, %.0f)", len(haven), dd.CellM, f.spawnX, f.spawnZ)
	if len(haven) == 0 {
		t.Fatal("no Haven")
	}
	groups := combatGroups(t, portA)
	// A camp or pack in the Haven, and one far from the spawn.
	var havenG, farG *game.CombatGroupDebug
	for i := range groups {
		g := &groups[i]
		if g.Kind == "boss" {
			continue
		}
		cx, cz := cellOf(g.X, g.Z)
		d := math.Hypot(g.X-f.spawnX, g.Z-f.spawnZ)
		if haven[[2]int{cx, cz}] && (havenG == nil || d < math.Hypot(havenG.X-f.spawnX, havenG.Z-f.spawnZ)) {
			havenG = g
		}
		if d > 1500 && (farG == nil || d > math.Hypot(farG.X-f.spawnX, farG.Z-f.spawnZ)) {
			farG = g
		}
	}
	if havenG == nil || farG == nil {
		t.Fatalf("groups: haven %v far %v", havenG, farG)
	}

	// 1. A fresh level-1 character at a Haven camp at night.
	lo := f.character("Newbie")
	cl := dialItems(t, portA, f.world, lo, "Newbie", havenG.X+25, havenG.Z)
	_, lvl, tier, flags, _ := cl.area(t, 5*time.Second)
	f.logf("Newbie (level 1) at the Haven %s #%d (%.0f, %.0f), %.0f m from the spawn: area level %d tier %d flags %b",
		havenG.Kind, havenG.ID, havenG.X, havenG.Z, math.Hypot(havenG.X-f.spawnX, havenG.Z-f.spawnZ), lvl, tier, flags)
	if lvl != 1 || tier != 0 || flags&game.AreaFlagHaven == 0 {
		t.Fatalf("Haven area: level %d tier %d flags %b", lvl, tier, flags)
	}
	cl.pump(12 * time.Second) // two demon top-ups (DEMON_SPAWN_EVERY_S = 5)
	beginner := map[string]bool{}
	for _, k := range combatdefs.D.Tables.Beginner {
		beginner[k] = true
	}
	var seen []string
	demonsNear := func(x, z, r float64) int {
		n := 0
		for _, g := range combatGroups(t, portA) {
			if g.Kind == "demon" && g.Alive > 0 && math.Hypot(g.X-x, g.Z-z) < r {
				n += g.Alive
			}
		}
		return n
	}
	for _, g := range combatGroups(t, portA) {
		if g.ID != havenG.ID {
			continue
		}
		if !g.Spawned || len(g.Enemies) == 0 {
			t.Fatalf("the Haven group never spawned: %+v", g)
		}
		for _, e := range g.Enemies {
			seen = append(seen, e.Key)
			if !beginner[e.Key] {
				t.Fatalf("a %s in the Haven", e.Key)
			}
		}
		if g.Level != 1 {
			t.Fatalf("Haven group level %d", g.Level)
		}
	}
	if n := demonsNear(havenG.X, havenG.Z, 300); n != 0 {
		t.Fatalf("%d demons near a level-1 player in the Haven at night", n)
	}
	f.logf("  12 s of night: group level 1, members %v (beginner table only), 0 demons within 300 m: PASS", seen)

	// 2. A level-15 character discovers a far, unstamped area.
	hi := f.character("Veteran")
	if _, err := f.pool.Exec(ctx, `UPDATE characters SET xp = $2, level = 15 WHERE id = $1::uuid`, hi, int64(5040)); err != nil {
		t.Fatal(err)
	}
	ch := dialItems(t, portA, f.world, hi, "Veteran", farG.X+25, farG.Z)
	cell, lvl, tier, flags, by := ch.area(t, 5*time.Second)
	f.logf("Veteran (level 15) discovers the area of %s #%d (%.0f, %.0f), %.0f m from the spawn: area %d level %d tier %d flags %b by %q",
		farG.Kind, farG.ID, farG.X, farG.Z, math.Hypot(farG.X-f.spawnX, farG.Z-f.spawnZ), cell, lvl, tier, flags, by)
	if lvl < 15 || flags&game.AreaFlagStampedByYou == 0 || by != "Veteran" {
		t.Fatalf("stamp: level %d flags %b by %q", lvl, flags, by)
	}
	var dbLevel, dbByLevel int
	var dbBy string
	cx, cz := int(cell)%dd.PerEdge, int(cell)/dd.PerEdge
	if err := f.pool.QueryRow(ctx, `SELECT level, stamped_by, stamped_by_level FROM area_difficulty WHERE world_id = $1::uuid AND cell_m = $2 AND cell_x = $3 AND cell_z = $4`,
		f.world, int(def.CellM), cx, cz).Scan(&dbLevel, &dbBy, &dbByLevel); err != nil {
		t.Fatal(err)
	}
	if dbLevel != lvl || dbBy != hi || dbByLevel != 15 {
		t.Fatalf("Postgres stamp level %d by %s (level %d)", dbLevel, dbBy, dbByLevel)
	}
	f.logf("  Postgres area_difficulty (%d, %d): level %d, stamped by the Veteran at level %d", cx, cz, dbLevel, dbByLevel)
	ch.pump(12 * time.Second)
	var keys []string
	for _, g := range combatGroups(t, portA) {
		if g.ID != farG.ID {
			continue
		}
		if !g.Spawned || g.Level < 15 {
			t.Fatalf("far group: spawned %v level %d", g.Spawned, g.Level)
		}
		for _, e := range g.Enemies {
			keys = append(keys, e.Key)
			if beginner[e.Key] {
				t.Fatalf("a beginner %s in a level-%d area", e.Key, lvl)
			}
		}
	}
	nd := demonsNear(farG.X, farG.Z, 200)
	f.logf("  12 s of night: group level >= 15, members %v; %d demons hunting the Veteran", keys, nd)
	if nd == 0 {
		t.Fatal("no demons hunt a level-15 player at night in a level-15 area")
	}

	// 3. A second zone process on the same database.
	portB := freePort(t)
	zb := startItemZone(t, f.bin, f.wasm, f.dbURL, f.world, portB, "LODESTONE_ZONE_NO_ATLAS_ENEMIES=0", off, "LODESTONE_ZONE_EXIT_AFTER=240s")
	zb.waitLog(t, "difficulty stamps loaded", 30*time.Second)
	lo2 := f.character("Visitor")
	cb := dialItems(t, portB, f.world, lo2, "Visitor", farG.X+20, farG.Z+5)
	cellB, lvlB, _, flagsB, byB := cb.area(t, 5*time.Second)
	f.logf("zone B: Visitor (level 1) walks into the Veteran's area: area %d level %d flags %b by %q", cellB, lvlB, flagsB, byB)
	if cellB != cell || lvlB != lvl || flagsB&game.AreaFlagStampedByYou != 0 || byB != "Veteran" {
		t.Fatalf("zone B disagrees: area %d level %d by %q", cellB, lvlB, byB)
	}
	// Both zones claim one fresh area at the same moment with different levels.
	var fresh *game.CombatGroupDebug
	stamped := map[int]bool{}
	for _, a := range difficultyOf(t, portA).Areas {
		stamped[a.Cell] = true
	}
	for _, a := range difficultyOf(t, portB).Areas {
		stamped[a.Cell] = true
	}
	for i := range groups {
		g := &groups[i]
		gx, gz := cellOf(g.X, g.Z)
		free := true
		for dz := -2; dz <= 2; dz++ {
			for dx := -2; dx <= 2; dx++ {
				if stamped[(gz+dz)*dd.PerEdge+gx+dx] {
					free = false
				}
			}
		}
		if g.Kind != "boss" && free && math.Hypot(g.X-farG.X, g.Z-farG.Z) > 900 && math.Hypot(g.X-f.spawnX, g.Z-f.spawnZ) > 900 {
			fresh = g
			break
		}
	}
	if fresh == nil {
		t.Fatal("no fresh area left to race on")
	}
	mid := f.character("Racer")
	if _, err := f.pool.Exec(ctx, `UPDATE characters SET xp = $2, level = 9 WHERE id = $1::uuid`, mid, int64(1800)); err != nil {
		t.Fatal(err)
	}
	newb := f.character("Rookie")
	var wg sync.WaitGroup
	var ra, rb *itemClient
	wg.Add(2)
	go func() { defer wg.Done(); ra = dialItems(t, portA, f.world, mid, "Racer", fresh.X, fresh.Z) }()
	go func() { defer wg.Done(); rb = dialItems(t, portB, f.world, newb, "Rookie", fresh.X+3, fresh.Z) }()
	wg.Wait()
	ca, la, _, fa, ba := ra.area(t, 5*time.Second)
	cbb, lb, _, fb, bb := rb.area(t, 5*time.Second)
	f.logf("race for the area of %s #%d (%.0f, %.0f): zone A Racer (level 9) sees area %d level %d by %q flags %b; zone B Rookie (level 1) sees area %d level %d by %q flags %b",
		fresh.Kind, fresh.ID, fresh.X, fresh.Z, ca, la, ba, fa, cbb, lb, bb, fb)
	if ca != cbb || la != lb || ba != bb || (fa&game.AreaFlagStampedByYou != 0) == (fb&game.AreaFlagStampedByYou != 0) {
		t.Fatal("the zones disagree on a raced stamp")
	}
	var rows int
	fx, fz := cellOf(fresh.X, fresh.Z)
	_ = f.pool.QueryRow(ctx, `SELECT count(*) FROM area_difficulty WHERE world_id = $1::uuid AND cell_x = $2 AND cell_z = $3`, f.world, fx, fz).Scan(&rows)
	if rows != 1 {
		t.Fatalf("%d rows for one area", rows)
	}
	// Every area either zone knows has the same level in both.
	time.Sleep(1500 * time.Millisecond)
	da, db := difficultyOf(t, portA), difficultyOf(t, portB)
	byCell := map[int]int{}
	for _, a := range da.Areas {
		byCell[a.Cell] = a.Level
	}
	common := 0
	for _, a := range db.Areas {
		if l, ok := byCell[a.Cell]; ok {
			common++
			if l != a.Level {
				t.Fatalf("area %d: zone A level %d, zone B level %d", a.Cell, l, a.Level)
			}
		}
	}
	var total int
	_ = f.pool.QueryRow(ctx, `SELECT count(*) FROM area_difficulty WHERE world_id = $1::uuid`, f.world).Scan(&total)
	f.logf("zones agree on all %d areas both know; Postgres holds %d stamps; zone A won %d claims, zone B won %d (lost %d)", common, total, da.Won, db.Won, db.Lost)
	f.logf("ALL PASS")
	if evidence {
		fmt.Println(strings.TrimSpace(f.log.String()))
	}
}
