package game

// Playtest 1 (CR 012): discovery-stamped difficulty, demon pacing, leveling
// and tower attunement, in process.

import (
	"context"
	"encoding/binary"
	"io"
	"log/slog"
	"math"
	"testing"
	"time"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/writebehind"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/difficulty"
	"lodestone/server/zone/internal/explore"
	"lodestone/server/zone/internal/night"
)

// xpForLevel is the total XP that reaches level (explore curve).
func xpForLevel(level int) int64 {
	var xp int64
	for l := 1; l < level; l++ {
		xp += explore.XPForNextLevel(l)
	}
	return xp
}

// spawn of the test world's Haven.
const havenX, havenZ = 1000.0, 1000.0

// diffHarness: exploreWorld's towers and village, combat without atlas
// groups, night at 22:00 under a new moon's worth of demons, a town at
// (500, 500), discovery-stamped difficulty with the Haven around (1000,
// 1000), a progress store with a level-15 character "hi".
func diffHarness(t *testing.T, store difficulty.Store) (*harness, *progressStore) {
	t.Helper()
	ps := &progressStore{fakeStore: fakeStore{saves: map[string]movement.Vec3{}, rows: map[string]movement.Vec3{"hi": {X: 3500, Z: 3500}, "lo": {X: havenX, Z: havenZ}}}, prog: map[string]ProgressSnapshot{
		"hi": {Level: 15, XP: xpForLevel(15), Towers: []byte{}, Waypoints: []byte{}, Discoveries: []byte{}, Pins: []byte("[]")},
	}}
	q := writebehind.New(100)
	q.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	qctx, stopQ := context.WithCancel(context.Background())
	t.Cleanup(stopQ)
	go q.Run(qctx)
	base := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	start := time.Now()
	m := difficulty.New(&combatdefs.D.Difficulty, 4096, havenX, havenZ, func(x, z float64) float64 { return 0 })
	h := exploreHarness(t, func(c *Config) {
		c.Store, c.Queue = ps, q
		c.Now = func() time.Time { return base.Add(time.Since(start)) }
		c.TimeOffsetS = 22 * 150 // 22:00 world time
		nw := &night.World{Seed: 7, Intensity: 1.0, Towns: []night.Town{{Index: 0, Name: "Testholm", X: 500, Z: 500, Radius: 30, GardenX: 505, GardenZ: 500, Element: 8}}}
		c.Night = &NightSetup{World: nw, Force: -1}
		c.Combat = &CombatSetup{Dev: true, Config: combat.Config{Seed: 42, NoWildPacks: true}}
		c.Difficulty = &DifficultySetup{Map: m, Store: store}
	})
	return h, ps
}

func (h *harness) demonsAndEnemies() (demons int, enemies []*combat.Enemy) {
	_ = h.srv.Do(context.Background(), func() {
		for _, e := range h.srv.cbt.w.Enemies() {
			if !e.Alive() {
				continue
			}
			if e.IsDemon() {
				demons++
			} else {
				enemies = append(enemies, e)
			}
		}
	})
	return
}

func (h *harness) addPack(x, z float64) {
	_ = h.srv.Do(context.Background(), func() {
		w := h.srv.cbt.w
		w.AddGroup(&combat.Group{Kind: combat.GroupPack, Anchor: movement.Vec3{X: x, Z: z}, Radius: 10, Biome: 0, Element: 8, Level: 1, Site: -1, AreaLevel: true})
	})
}

func decodeArea(ev *proto.Event) (level, tier, flags int, by string) {
	return int(ev.Value), int(ev.Data[1]), int(ev.Data[2]), string(ev.Data[7:])
}

// A fresh level-1 character at the world spawn: the Haven, slimes only, and
// no demons all night.
func TestHavenAtNightHasSlimesAndNoDemons(t *testing.T) {
	h, _ := diffHarness(t, nil)
	h.addPack(havenX+40, havenZ)
	cl := h.dial("?spawn=1000,1000")
	cl.join(h, "lo", "Newbie")
	ar := cl.nextEvent(EventArea, 3*time.Second)
	if lvl, tier, flags, _ := decodeArea(ar); lvl != 1 || tier != 0 || flags&AreaFlagHaven == 0 {
		t.Fatalf("area at the spawn: level %d tier %d flags %b", lvl, tier, flags)
	}
	cl.keep(7 * time.Second) // more than one demon top-up (DEMON_SPAWN_EVERY_S)
	demons, enemies := h.demonsAndEnemies()
	if demons != 0 {
		t.Fatalf("%d demons in the Haven at night", demons)
	}
	if len(enemies) == 0 {
		t.Fatal("the Haven pack never spawned")
	}
	for _, e := range enemies {
		if e.Def.Family != "slime" || e.Level != 1 || e.Elite() {
			t.Fatalf("Haven enemy %s family %s level %d elite %v", e.Def.Key, e.Def.Family, e.Level, e.Elite())
		}
	}
}

// A level-15 character discovering a new area far from everything stamps it
// at their level: harder enemies there, and demons hunt them at night.
func TestHighLevelExplorerStampsAHarderArea(t *testing.T) {
	store := difficulty.NewMemStore()
	h, _ := diffHarness(t, store)
	h.addPack(3530, 3500)
	cl := h.dial("?spawn=3500,3500")
	cl.join(h, "hi", "Veteran")
	st := cl.nextEvent(EventCharacterStats, 3*time.Second)
	if st.Value != 15 {
		t.Fatalf("stats level %d", st.Value)
	}
	ar := cl.nextEvent(EventArea, 3*time.Second)
	lvl, tier, flags, by := decodeArea(ar)
	if lvl < 15 || tier < 4 || flags&AreaFlagStampedByYou == 0 || by != "Veteran" {
		t.Fatalf("stamped area: level %d tier %d flags %b by %q", lvl, tier, flags, by)
	}
	cl.keep(7 * time.Second)
	demons, enemies := h.demonsAndEnemies()
	if len(enemies) == 0 {
		t.Fatal("the pack never spawned")
	}
	for _, e := range enemies {
		if e.Def.Family == "slime" || e.Level < 15 {
			t.Fatalf("enemy %s level %d in a level-%d area", e.Def.Key, e.Level, lvl)
		}
	}
	if demons == 0 {
		t.Fatal("no demons hunt a level-15 player in a dread area at night")
	}
	// The stamp is persistent: in the store, and immutable.
	all, _ := store.LoadAll(context.Background(), h.srv.diff.geo)
	found := false
	for _, s := range all {
		if s.Cell == int(ar.TargetID) && s.Level == lvl && s.By == "hi" {
			found = true
		}
	}
	if !found {
		t.Fatalf("stamp not stored: %+v", all)
	}
}

// Next to the Haven a level-1 character stamps quiet lands: beasts mixed
// with slimes, no elites and still no demons.
func TestQuietLandsNextToTheHaven(t *testing.T) {
	h, _ := diffHarness(t, nil)
	cl := h.dial("?spawn=1600,1000") // beyond the Haven's 420 m
	cl.join(h, "lo", "Newbie")
	ar := cl.nextEvent(EventArea, 3*time.Second)
	if lvl, tier, _, _ := decodeArea(ar); lvl > 3 || tier != 1 {
		t.Fatalf("quiet lands: level %d tier %d", lvl, tier)
	}
	cl.keep(6 * time.Second)
	if demons, _ := h.demonsAndEnemies(); demons != 0 {
		t.Fatalf("%d demons in quiet lands", demons)
	}
}

// Two zones sharing one store (two processes sharing Postgres) agree on an
// area claimed by players of very different levels at the same time.
func TestTwoZonesAgreeOnAStamp(t *testing.T) {
	store := difficulty.NewMemStore()
	store.Delay = 20 * time.Millisecond
	a, _ := diffHarness(t, store)
	b, _ := diffHarness(t, store)
	ca := a.dial("?spawn=3000,600")
	ca.join(a, "hi", "Veteran")
	cb := b.dial("?spawn=3000,600")
	cb.join(b, "lo", "Newbie")
	ea := ca.nextEvent(EventArea, 3*time.Second)
	eb := cb.nextEvent(EventArea, 3*time.Second)
	if ea.TargetID != eb.TargetID || ea.Value != eb.Value {
		t.Fatalf("zones disagree: area %d level %d vs area %d level %d", ea.TargetID, ea.Value, eb.TargetID, eb.Value)
	}
	_, _, fa, _ := decodeArea(ea)
	_, _, fb, _ := decodeArea(eb)
	if (fa&AreaFlagStampedByYou != 0) == (fb&AreaFlagStampedByYou != 0) {
		t.Fatalf("exactly one zone's player stamped it (flags %b %b)", fa, fb)
	}
}

// A level-up gives health, stamina and damage, refills, and says so.
func TestLevelUpGivesStatsAndAFanfareEvent(t *testing.T) {
	h, _ := diffHarness(t, nil)
	cl := h.dial("?spawn=1000,1000")
	cl.join(h, "lo", "Newbie")
	s0 := cl.nextEvent(EventCharacterStats, 3*time.Second)
	if s0.Data[1] != StatsSync || s0.Value != 1 {
		t.Fatalf("join stats %+v", s0.ToJSON())
	}
	hp0 := binary.LittleEndian.Uint16(s0.Data[22:])
	st0 := binary.LittleEndian.Uint16(s0.Data[26:])
	_ = h.srv.Do(context.Background(), func() {
		h.srv.grantCombatXP(combat.XPGrant{Player: cl.welc.EntityID, XP: xpForLevel(4), Reason: "test"})
	})
	if up := cl.nextEvent(EventLevelUp, 2*time.Second); up.Value != 4 {
		t.Fatalf("level up %d", up.Value)
	}
	s1 := cl.nextEvent(EventCharacterStats, 2*time.Second)
	if s1.Data[1] != StatsLevelUp || s1.Value != 4 || binary.LittleEndian.Uint16(s1.Data[4:]) != 1 {
		t.Fatalf("level-up stats %+v", s1.ToJSON())
	}
	hp1 := binary.LittleEndian.Uint16(s1.Data[22:])
	st1 := binary.LittleEndian.Uint16(s1.Data[26:])
	dmg := binary.LittleEndian.Uint16(s1.Data[28:])
	lv := &combatdefs.D.Leveling
	if float64(hp1-hp0) != 3*lv.Health.PerLevel || float64(st1-st0) != 3*lv.Stamina.PerLevel || float64(dmg) != 3*lv.DamagePctPerLevel*10 {
		t.Fatalf("gains: hp %d->%d stamina %d->%d damage %d", hp0, hp1, st0, st1, dmg)
	}
	if free := s1.Data[30]; int(free) != combat.SkillPoints(4) {
		t.Fatalf("skill points %d", free)
	}
	cl.drainFor(200 * time.Millisecond)
	self := cl.frame.Self
	if int(self.StaminaMax) != int(st1)*10 || int(self.Stamina) != int(st1)*10 {
		t.Fatalf("SelfState stamina %d/%d (x10), want full %d", self.Stamina, self.StaminaMax, int(st1)*10)
	}
	if self.HealthMax != hp1 || self.Health != hp1 {
		t.Fatalf("health %d/%d want full %d", self.Health, self.HealthMax, hp1)
	}
}

// The crystal: attuning on the top gives the boon once and Event 902.
func TestTowerAttunementBoonOnce(t *testing.T) {
	h, ps := diffHarness(t, nil)
	tw := h.srv.cfg.Explore.Towers[0].Shape
	ps.mu.Lock()
	ps.rows["att"] = movement.Vec3{X: tw.CX, Y: tw.TopY, Z: tw.CZ}
	ps.mu.Unlock()
	cl := h.dial("") // saved position: the top of the tower (site 0)
	cl.join(h, "att", "Attuner")
	s0 := cl.nextEvent(EventCharacterStats, 3*time.Second)
	cl.nextEvent(EventTowerUnlocked, 2*time.Second)
	// Attuning another tower from here is refused.
	cl.send(&proto.Interact{TargetKind: InteractSite, TargetID: 3, Action: ActionAttune})
	if r := cl.nextEvent(EventAttuneRefused, time.Second); r.Value != int32(explore.AttuneNotThere) {
		t.Fatalf("refused %+v", r.ToJSON())
	}
	cl.send(&proto.Interact{TargetKind: InteractSite, TargetID: 0, Action: ActionAttune})
	at := cl.nextEvent(EventTowerAttuned, time.Second)
	if at.TargetID != 0 || at.Value != 0 || string(at.Data) != "Testshire" || at.Y != proto.MetersToCm(tw.TopY) {
		t.Fatalf("attuned %+v", at.ToJSON())
	}
	var s1 *proto.Event
	for s1 == nil || s1.Data[1] != StatsAttuned {
		s1 = cl.nextEvent(EventCharacterStats, time.Second)
	}
	lv := &combatdefs.D.Leveling
	if s1.Data[32] != 1 || binary.LittleEndian.Uint16(s1.Data[26:])-binary.LittleEndian.Uint16(s0.Data[26:]) < uint16(lv.Attune.Stamina) {
		t.Fatalf("boon: attuned %d stamina %d -> %d", s1.Data[32], binary.LittleEndian.Uint16(s0.Data[26:]), binary.LittleEndian.Uint16(s1.Data[26:]))
	}
	if tot := int(s1.Data[31]); tot != combat.SkillPoints(int(s1.Value))+lv.Attune.SkillPoints {
		t.Fatalf("skill points total %d at level %d", tot, s1.Value)
	}
	cl.send(&proto.Interact{TargetKind: InteractSite, TargetID: 0, Action: ActionAttune})
	if r := cl.nextEvent(EventAttuneRefused, time.Second); r.Value != int32(explore.AttuneAlready) {
		t.Fatalf("second attune %+v", r.ToJSON())
	}
	// Saved with the progress.
	cl.c.Close(1000, "")
	deadline := time.Now().Add(3 * time.Second)
	for {
		ps.mu.Lock()
		s, ok := ps.prog["att"]
		ps.mu.Unlock()
		if ok && explore.Bitset(s.Attuned).Has(0) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("attunement never saved")
		}
		time.Sleep(20 * time.Millisecond)
	}
	_ = structures.TowerTopRadius
}

// The wilds (area level 4-7) at night: a straggler or two, slowed below a
// walking player's speed, and none at all for a low-level player near a
// town (playtest 1: early nights are survivable without sunsteel or Light).
func TestWildsNightIsSurvivable(t *testing.T) {
	store := difficulty.NewMemStore()
	m := difficulty.New(&combatdefs.D.Difficulty, 4096, havenX, havenZ, nil)
	g := m.Geometry(testWorld)
	for _, p := range [][2]float64{{3000, 3000}, {560, 500}} {
		c := m.Cell(p[0], p[1])
		for _, n := range append(m.Neighbours(c), c) {
			if _, err := store.Claim(context.Background(), g, difficulty.Claim{Cell: n, PlayerLevel: 5, CharID: "seed", Name: "Seeder"}); err != nil {
				t.Fatal(err)
			}
		}
	}
	h, ps := diffHarness(t, store)
	ps.mu.Lock()
	ps.prog["mid"] = ProgressSnapshot{Level: 5, XP: xpForLevel(5), Pins: []byte("[]")}
	ps.rows["mid"] = movement.Vec3{X: 3000, Z: 3000}
	ps.mu.Unlock()
	near := h.dial("?spawn=560,500")
	near.join(h, "lo", "Newbie")
	if lvl, tier, _, _ := decodeArea(near.nextEvent(EventArea, 3*time.Second)); lvl < 4 || lvl > 7 || tier != 2 {
		t.Fatalf("wilds by the town: level %d tier %d", lvl, tier)
	}
	near.keep(6 * time.Second)
	if d, _ := h.demonsAndEnemies(); d != 0 {
		t.Fatalf("%d demons hunt a level-1 player beside a town", d)
	}
	cl := h.dial("?spawn=3000,3000")
	cl.join(h, "mid", "Wanderer")
	var demons []*combat.Enemy
	deadline := time.Now().Add(20 * time.Second)
	for len(demons) == 0 && time.Now().Before(deadline) {
		cl.keep(time.Second)
		_ = h.srv.Do(context.Background(), func() {
			demons = demons[:0]
			for _, e := range h.srv.cbt.w.Enemies() {
				if e.Alive() && e.IsDemon() {
					demons = append(demons, e)
				}
			}
		})
	}
	var want int
	var scale float64
	_ = h.srv.Do(context.Background(), func() {
		scale = h.srv.night.cfg.World.Scale(h.srv.night.nightIdx)
		want = int(math.Round(constants.DemonPerPlayer * scale * combatdefs.D.Difficulty.Tiers[2].Demons))
	})
	if want > 0 && len(demons) == 0 {
		t.Fatalf("no demons in the wilds (want %d, scale %.2f)", want, scale)
	}
	if len(demons) > max(want, 1)+1 {
		t.Fatalf("%d demons in the wilds (tier allows %d)", len(demons), want)
	}
	walk := constants.BaseMoveSpeed
	for _, e := range demons {
		if e.Def.Demon.Rank != "lesser" {
			t.Fatalf("a %s demon in the wilds", e.Def.Demon.Rank)
		}
		if sp := e.Def.Speed * e.SpeedMult; sp >= walk || e.SpeedMult >= 1 {
			t.Fatalf("demon speed %.2f (mult %.2f): must be slower than walking (%.1f)", sp, e.SpeedMult, walk)
		}
	}
}
