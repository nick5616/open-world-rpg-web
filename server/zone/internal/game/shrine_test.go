package game

// CR 044: the Depths demon shrine fight (shrine.go): interact starts wave
// one around the shrine, each fallen wave wakes the next, the last one's
// fall cleanses it and pays everyone who fought near it.

import (
	"fmt"
	"testing"
	"time"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/vertical"
	"lodestone/server/zone/internal/chem"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/night"
)

func TestShrineWavesAreContractEnemies(t *testing.T) {
	for i, w := range shrineWaves {
		for _, k := range w {
			if combatdefs.D.EnemyByKey(k) == nil {
				t.Errorf("wave %d: %q is not in combat.yaml", i, k)
			}
		}
	}
	for _, l := range [][]string{combat.LayerTables[vertical.LayerSky], combat.LayerTables[vertical.LayerDepths]} {
		for _, k := range l {
			if combatdefs.D.EnemyByKey(k) == nil {
				t.Errorf("layer table kind %q is not in combat.yaml", k)
			}
		}
	}
	if shrineMarker(3, 0) == shrineMarker(3, int64(shrineCooldownH*3600e3)) || shrineMarker(3, 5) != shrineMarker(3, 9) || shrineMarker(3, 5) == shrineMarker(4, 5) {
		t.Fatal("shrine marker windows")
	}
}

func TestShrineCleansing(t *testing.T) {
	w, g, ct := testVerticalTowns(t)
	raw := testTerrain(t).World().Atlas
	sa, _ := structures.ParseAtlas(raw)
	ca := combat.ParseAtlas(raw, sa)
	h := newHarness(t, func(c *Config) {
		c.Dev = true
		c.Ground = g
		c.Towns = w
		c.Explore = realExplore(t, g)
		c.TimeOffsetS = offsetFor(12)
		c.Night = &NightSetup{World: &night.World{Seed: 42, Intensity: 0.5}, Overlay: &chem.Overlay{}, WindDeg: 270, NoDemons: true, Force: -1}
		c.Combat = &CombatSetup{Atlas: ca, Config: combat.Config{Seed: 42, NoWildPacks: true}}
	})
	h.srv.SetWorldEvents(false)
	var shrine *vertical.Deco
	for i := range ct.Vertical().Decos {
		d := &ct.Vertical().Decos[i]
		if d.Kind == decoShrine {
			ct.Layers.Ensure(d.X, d.Z, 2)
			if ct.LayerAt(d.X, d.Y+0.5, d.Z) == vertical.LayerDepths {
				shrine = d
				break
			}
		}
	}
	if shrine == nil {
		t.Skip("no Depths shrine in the test world")
	}
	a := h.dial(fmt.Sprintf("?spawn=%v,%v,%v", shrine.X+shrine.Size, shrine.Y+0.5, shrine.Z))
	a.join(h, "cleanser", "Cleanser")
	a.pump(300 * time.Millisecond)
	// Too far: nothing happens.
	a.send(&proto.Interact{TargetKind: InteractShrine, TargetID: uint64(shrine.Aux + 1000), Action: 1})
	a.pump(200 * time.Millisecond)
	a.send(&proto.Interact{TargetKind: InteractShrine, TargetID: uint64(shrine.Aux), Action: 1})
	ev := a.nextEvent(EventShrineState, 3*time.Second)
	if ev.Value != ShrineStateStarted || ev.Data[0] != 1 || int(ev.Data[1]) != len(shrineWaves) {
		t.Fatalf("start event %+v", ev)
	}
	var groups int
	h.do(func() { groups = len(h.srv.shrines) })
	if groups != 1 {
		t.Fatalf("%d live shrines", groups)
	}
	// Each wave falls (the group is retired as if its members were put down).
	tick := uint32(constants.TickRateHz) * 100
	for wave := 1; wave < len(shrineWaves); wave++ {
		h.do(func() {
			h.srv.shrines[shrine.Aux].group.Retired = true
			h.srv.shrinesTick(tick)
			tick += uint32(constants.TickRateHz)
		})
		ev = a.nextEvent(EventShrineState, 3*time.Second)
		if ev.Value != ShrineStateWaveDone || int(ev.Data[0]) != wave+1 {
			t.Fatalf("wave %d event %+v", wave, ev)
		}
	}
	h.do(func() { h.srv.shrines[shrine.Aux].group.Retired = true; h.srv.shrinesTick(tick) })
	ev = a.nextEvent(EventShrineState, 3*time.Second)
	if ev.Value != ShrineStateCleansed {
		t.Fatalf("cleansed event %+v", ev)
	}
	a.nextEvent(EventShrineReward, 3*time.Second)
	h.do(func() {
		if len(h.srv.shrines) != 0 {
			t.Error("the shrine is still live after the cleansing")
		}
	})
}
