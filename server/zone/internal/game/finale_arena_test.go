package game

import (
	"fmt"
	"runtime/debug"
	"testing"

	"lodestone/server/pkg/movement"
)

// Co-op polish: the Heartfall belongs to the Hush. No night hunter rises in
// it (or 40 m around it) and anything standing in it when the Hush wakes,
// or wandering in during the fight, is sent away; its own adds and bells
// stay.
func TestHeartfallKeepsNightMonstersOut(t *testing.T) {
	h, _ := storyHarness(t)
	var errs []string
	fail := func(f string, a ...any) { errs = append(errs, fmt.Sprintf(f, a...)) }
	h.do(func() {
		defer func() {
			if p := recover(); p != nil {
				fail("panic %v\n%s", p, debug.Stack())
			}
		}()
		s := h.srv
		hf := s.storyPlaces().Heartfall
		if !hf.OK {
			fail("no Heartfall")
			return
		}
		if !s.storyArenaAt(hf.X+5, hf.Z) || !s.storyArenaAt(hf.X+hf.R+30, hf.Z) || s.storyArenaAt(hf.X+hf.R+50, hf.Z) { // spawnSpot and huntTopUp ask it
			fail("arena rules: centre %v, edge %v, outside %v", s.storyArenaAt(hf.X+5, hf.Z), s.storyArenaAt(hf.X+hf.R+30, hf.Z), s.storyArenaAt(hf.X+hf.R+50, hf.Z))
		}
		w := s.cbt.w
		g := w.SpawnDemons(movement.Vec3{X: hf.X + 6, Z: hf.Z + 4}, []string{"gloamling", "gloamling"}, 20)
		if len(g.Members) != 2 {
			fail("spawned %d", len(g.Members))
		}
		s.finaleArm(nil)
		r := s.sty.fin.run
		if r == nil {
			fail("the Hush did not rise")
			return
		}
		for _, e := range w.EnemiesNear(hf.X, hf.Z, hf.R+10) {
			if e.Alive() && e != r.hush {
				fail("%s still in the arena at the entrance", e.Def.Key)
			}
		}
		// One wanders in mid-fight: gone at the next sweep; the Hush stays.
		w.SpawnDemons(movement.Vec3{X: hf.X - 8, Z: hf.Z}, []string{"gloamling"}, 20)
		s.finaleClearStrays(r)
		for _, e := range w.EnemiesNear(hf.X, hf.Z, hf.R+10) {
			if e.Alive() && e != r.hush {
				fail("%s wandered in and stayed", e.Def.Key)
			}
		}
		if !r.hush.Alive() {
			fail("the sweep took the Hush")
		}
		s.finaleReset("test")
	})
	for _, e := range errs {
		t.Error(e)
	}
}
