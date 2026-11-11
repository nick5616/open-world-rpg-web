package game

import (
	"context"
	"testing"
	"time"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/zone/internal/difficulty"
	"lodestone/server/zone/internal/items"
)

// fixedContainers lists the same chests wherever the player stands, all
// carrying worldgen's fallback level 9 (the old region-danger curve).
type fixedContainers struct{ list []ContainerInfo }

func (c *fixedContainers) ContainersNear(x, z, r float64) []ContainerInfo { return c.list }

const fallbackChestLevel = 9

func lootLevelHarness(t *testing.T, withDifficulty bool) *harness {
	t.Helper()
	src := &fixedContainers{list: []ContainerInfo{
		{ID: 501, X: havenX + 2, Y: 0, Z: havenZ, Kind: 0, Level: fallbackChestLevel, Element: -1},
		{ID: 502, X: 3502, Y: 0, Z: 3500, Kind: 0, Level: fallbackChestLevel, Element: -1},
	}}
	h := newHarness(t, func(c *Config) {
		c.Items = &ItemsSetup{Containers: src}
		if withDifficulty {
			m := difficulty.New(&combatdefs.D.Difficulty, 4096, havenX, havenZ, func(x, z float64) float64 { return 0 })
			c.Difficulty = &DifficultySetup{Map: m}
		}
	})
	if withDifficulty {
		// A hard area someone discovered long ago (stamps never change).
		_ = h.srv.Do(context.Background(), func() {
			m := h.srv.diff.m
			m.Set(difficulty.Stamp{Cell: m.Cell(3500, 3500), Level: 14, By: "veteran", ByName: "Veteran", ByLevel: 14}, h.srv.tick)
		})
	}
	return h
}

// openChestLevels opens chest id from (x, z) and returns the item levels of
// the equipment it granted.
func openChestLevels(t *testing.T, h *harness, char string, x, z float64, id uint64) []int {
	t.Helper()
	cl := h.dial(spawnAt(x, z))
	w := cl.join(h, char, char)
	cl.pump(300 * time.Millisecond)
	cl.interact(InteractContainer, id, ActionUse, 0)
	if ev := cl.lastEvent(EventContainerOpened, 3*time.Second); ev == nil {
		t.Fatal("not opened")
	}
	// Playtest 2 ground loot: the chest's items lie on the ground around it.
	var levels []int
	for _, it := range ownDrops(t, h, w.EntityID) {
		if d := items.D.Item(it.Base); d != nil && (d.Kind == "weapon" || d.Kind == "armor") {
			levels = append(levels, it.Level)
		}
	}
	if len(levels) == 0 {
		t.Fatalf("%s: the chest gave no equipment", char)
	}
	return levels
}

// Playtest polish: chests roll at the area's discovery-stamped level, the
// level its enemies have: the Haven's chests give starter gear, a hard
// stamped area better gear, whatever worldgen's danger curve says.
func TestChestItemLevelFollowsAreaDifficulty(t *testing.T) {
	h := lootLevelHarness(t, true)
	for _, l := range openChestLevels(t, h, "newbie", havenX, havenZ, 501) {
		if l != 1 {
			t.Fatalf("Haven chest gave item level %d, want 1", l)
		}
	}
	for _, l := range openChestLevels(t, h, "veteran", 3500, 3500, 502) {
		if l != 14 {
			t.Fatalf("level-14 area chest gave item level %d, want 14", l)
		}
	}
}

// Without discovery-stamped difficulty (LODESTONE_ZONE_NO_DIFFICULTY) the
// container keeps worldgen's level.
func TestChestItemLevelWithoutDifficultyKeepsWorldgenLevel(t *testing.T) {
	h := lootLevelHarness(t, false)
	for _, l := range openChestLevels(t, h, "newbie", havenX, havenZ, 501) {
		if l != fallbackChestLevel {
			t.Fatalf("chest gave item level %d, want worldgen's %d", l, fallbackChestLevel)
		}
	}
}
