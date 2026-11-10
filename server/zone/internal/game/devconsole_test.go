package game

// Playtest 2 dev console (CR 032) in-process: without Config.Dev every
// command is refused (Event 1401 value 1) and changes nothing; with it, each
// command's effect lands in the real state through the ordinary paths.

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"slices"
	"testing"
	"time"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/contentdefs"
	"lodestone/server/pkg/itemdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/weather"
	"lodestone/server/pkg/writebehind"
	"lodestone/server/zone/internal/chem"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/content"
	"lodestone/server/zone/internal/explore"
	"lodestone/server/zone/internal/items"
	"lodestone/server/zone/internal/night"
	"lodestone/server/zone/internal/quests"
)

// devGiveTarget packs Interact 250 action 2's targetId.
func devGiveTarget(key string, level, rarity, gem, cut, affix int) uint64 {
	return uint64(DevHash(key)) | uint64(level)<<32 | uint64(rarity+1)<<40 | uint64(gem+1)<<44 | uint64(cut)<<48 | uint64(affix+1)<<50
}

func (cl *client) dev(action uint8, target uint64, arg uint32) {
	cl.interact(InteractDev, target, action, arg)
}

// devResult waits for the 1401 answering action.
func (cl *client) devResult(t *testing.T, action uint8) *proto.Event {
	t.Helper()
	e := cl.takeFor(EventDevResult, uint32(action), 3*time.Second)
	t.Logf("dev %s: %d %s", devName(action), e.Value, e.Data)
	return e
}

func (cl *client) devOK(t *testing.T, action uint8, target uint64, arg uint32) string {
	t.Helper()
	cl.dev(action, target, arg)
	e := cl.devResult(t, action)
	if e.Value != DevOK {
		t.Fatalf("dev %s refused: %d %s", devName(action), e.Value, e.Data)
	}
	return string(e.Data)
}

func TestDevConsoleRefusedWithoutTheFlag(t *testing.T) {
	h := newHarness(t, nil) // Config.Dev false: what every deploy runs
	a := h.dial(spawnAt(800, 800))
	a.join(h, "dev-off", "Plain")
	a.pump(200 * time.Millisecond)
	before := a.inventory(t)
	var pos movement.Vec3
	h.do(func() { pos = h.srv.byChar["dev-off"].ent.Move.Pos })

	a.dev(DevActStatus, 0, 0)
	for _, act := range []uint8{DevActGive, DevActGold, DevActLevel, DevActTeleport, DevActLearn, DevActFlags, DevActSpawn, DevActReveal} {
		target, arg := uint64(0), uint32(0)
		switch act {
		case DevActGive:
			target, arg = devGiveTarget("weapon:voidglass_sword", 0, 7, -1, 0, -1), 1
		case DevActGold:
			arg = 99999
		case DevActLevel:
			arg = 40
		case DevActTeleport:
			target = explore.PackPinPos(120000, 120000)
		case DevActFlags:
			arg = DevFlagGod | DevFlagFly
		case DevActSpawn:
			target, arg = 1, 3
		}
		a.dev(act, target, arg)
		if e := a.devResult(t, act); e.Value != DevOff {
			t.Fatalf("%s: value %d, want refused (dev mode off)", devName(act), e.Value)
		}
	}
	a.pump(200 * time.Millisecond)
	if n := len(a.eventsOf(EventDevStatus)); n != 0 {
		t.Fatalf("a zone without dev mode sent %d dev status events", n)
	}
	after := a.inventory(t)
	if after.Gold != before.Gold || len(after.Items) != len(before.Items) {
		t.Fatalf("inventory changed: %+v -> %+v", before, after)
	}
	h.do(func() {
		sess := h.srv.byChar["dev-off"]
		if sess.dev != nil || sess.ent.cbt != nil && sess.ent.cbt.DevGod {
			t.Error("dev state created on a zone without dev mode")
		}
		if p := sess.ent.Move.Pos; math.Hypot(p.X-pos.X, p.Z-pos.Z) > 1 {
			t.Errorf("teleported without dev mode: %v -> %v", pos, p)
		}
		if sess.x != nil && sess.x.prog.Level != 1 {
			t.Errorf("level %d", sess.x.prog.Level)
		}
	})
}

// devHarness: the official world's towns and map, combat, night (the clock),
// a store and a queue, Config.Dev on.
func devHarness(t *testing.T) *harness {
	t.Helper()
	w, g := testTowns(t)
	ex := realExplore(t, g)
	store := &mountStore{fakeStore: &fakeStore{saves: map[string]movement.Vec3{}, rows: map[string]movement.Vec3{}}, steeds: map[string][]SteedRec{}}
	q := writebehind.New(100)
	q.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	qctx, stopQ := context.WithCancel(context.Background())
	t.Cleanup(stopQ)
	go q.Run(qctx)
	h := newHarness(t, func(c *Config) {
		c.Dev = true
		c.Ground = g
		c.Towns = w
		c.Explore = ex
		c.Store = store
		c.Queue = q
		c.TimeOffsetS = offsetFor(12)
		c.Night = &NightSetup{World: &night.World{Seed: 42, Intensity: 0.5}, Overlay: &chem.Overlay{}, WindDeg: 270, NoDemons: true, Force: -1}
		c.Combat = &CombatSetup{Config: combat.Config{Seed: 42, NoWildPacks: true}}
	})
	h.srv.SetWorldEvents(false)
	return h
}

func TestDevConsoleCommands(t *testing.T) {
	h := devHarness(t)
	const char = "dev-on"
	var sx, sz float64
	h.do(func() {
		// Somewhere open: the first settlement's edge.
		st := &h.srv.cfg.Towns.T.Settlements[0]
		sx, sz = st.X+st.Radius+40, st.Z
	})
	a := h.dial(spawnAt(sx, sz))
	a.join(h, char, "Dev")
	a.pump(300 * time.Millisecond)
	sess := func() *session { return h.srv.byChar[char] }

	// Status.
	a.dev(DevActStatus, 0, 0)
	st := a.take(EventDevStatus, 3*time.Second)
	var sj devStatusJSON
	if err := json.Unmarshal(st.Data, &sj); err != nil || sj.Speed != 1 {
		t.Fatalf("status %s (%v)", st.Data, err)
	}

	// Items: a mythic level-20 starmetal sword with a brilliant ruby, into loadout 2.
	ruby := slices.IndexFunc(items.D.Gems, func(g itemdefs.Gem) bool { return g.Key == "ruby" })
	brutal := slices.IndexFunc(items.D.Affixes, func(a itemdefs.Affix) bool { return a.Key == "brutal" })
	a.devOK(t, DevActGive, devGiveTarget("weapon:starmetal_sword", 20, 5, ruby, 2, brutal), 1|1<<16|1<<17)
	a.devOK(t, DevActGive, devGiveTarget("potion:health", 0, -1, -1, 0, -1), 7)
	a.devOK(t, DevActGive, devGiveTarget("armor:voidglass_helm", 0, 2, -1, 0, -1), 1|1<<16)
	a.devOK(t, DevActGold, 0, 12345)
	inv := a.inventory(t)
	sword := findItem(inv, "weapon:starmetal_sword")
	if sword == nil || sword.Rarity != 5 || sword.Level != 20 || sword.Slot != "eq:main1" || len(sword.Sockets) == 0 || sword.Sockets[0] != "gem:ruby:brilliant" {
		t.Fatalf("sword %+v", sword)
	}
	if len(sword.Affixes) == 0 || sword.Affixes[0].Key != "brutal" || sword.Name == "" {
		t.Fatalf("sword affixes %+v name %q", sword.Affixes, sword.Name)
	}
	if helm := findItem(inv, "armor:voidglass_helm"); helm == nil || helm.Slot != "eq:head" || helm.Rarity != 2 {
		t.Fatalf("helm %+v", helm)
	}
	if n := countBase(inv, "potion:health"); n < 7 {
		t.Fatalf("%d potions", n)
	}
	if inv.Gold != 12345 {
		t.Fatalf("gold %d", inv.Gold)
	}

	// A tome given and used: the spell is learned.
	var tomeSpell *combatdefs.Spell
	for i := range combatdefs.D.Spells {
		if sp := &combatdefs.D.Spells[i]; !slices.Contains(combatdefs.D.Start.Spells, sp.Key) && sp.Equippable() {
			tomeSpell = sp
			break
		}
	}
	a.devOK(t, DevActGive, devGiveTarget("tome:"+tomeSpell.Key, 0, -1, -1, 0, -1), 1|1<<16)
	h.do(func() {
		if !sess().ent.cbt.Profile.Knows(tomeSpell.Key) {
			t.Errorf("tome:%s used but not learned", tomeSpell.Key)
		}
	})

	// Spells: every one, then back to the kit; one alone.
	a.devOK(t, DevActLearn, 0, 0)
	h.do(func() {
		if n := len(sess().ent.cbt.Profile.Known); n != len(combatdefs.D.Spells) {
			t.Errorf("knows %d of %d spells", n, len(combatdefs.D.Spells))
		}
	})
	a.devOK(t, DevActUnlearn, 0, 0)
	h.do(func() {
		if k := sess().ent.cbt.Profile.Known; len(k) != len(combatdefs.D.Start.Spells) {
			t.Errorf("after unlearn all: %v", k)
		}
	})
	a.devOK(t, DevActLearn, uint64(tomeSpell.ID), 0)
	// Free skill tree: the ordinary Learn (Interact 50/4) ignores points and tiers.
	var high *combatdefs.Spell
	for i := range combatdefs.D.Spells {
		if sp := &combatdefs.D.Spells[i]; sp.Tier >= 3 && !slices.Contains(combatdefs.D.Start.Spells, sp.Key) {
			high = sp
			break
		}
	}
	a.devOK(t, DevActFlags, 0, DevFlagFreeLearn)
	a.interact(combat.InteractCombat, 0, combat.ActLearn, uint32(high.ID))
	a.pump(300 * time.Millisecond)
	h.do(func() {
		if !sess().ent.cbt.Profile.Knows(high.Key) {
			t.Errorf("free skill tree: tier %v %s not learned at level 1", high.Tier, high.Key)
		}
	})

	// Level, XP, skill points, weapon skills.
	a.devOK(t, DevActLevel, 0, 12)
	a.devOK(t, DevActSkillPoints, 0, 9)
	a.devOK(t, DevActWeaponSkill, 1, 40)
	h.do(func() {
		s := sess()
		if s.x.prog.Level != 12 || s.ent.Level != 12 || s.ent.cbt.Level != 12 {
			t.Errorf("level %d/%d/%d", s.x.prog.Level, s.ent.Level, s.ent.cbt.Level)
		}
		if s.ent.cbt.Boons.SkillPoints < 9 {
			t.Errorf("skill point boons %d", s.ent.cbt.Boons.SkillPoints)
		}
		if l := s.ent.cbt.Profile.SkillLevel("swordsmanship"); l != 40 {
			t.Errorf("swordsmanship %d", l)
		}
	})
	a.devOK(t, DevActLevel, 0, 3) // down too
	h.do(func() {
		if l := sess().x.prog.Level; l != 3 {
			t.Errorf("level %d after lowering", l)
		}
	})

	// God mode, infinite mana, no cooldowns.
	a.devOK(t, DevActFlags, 0, DevFlagGod|DevFlagMana|DevFlagCooldowns)
	a.pump(100 * time.Millisecond)
	h.do(func() {
		p := sess().ent.cbt
		if !p.DevGod {
			t.Fatal("god mode not on the player")
		}
		if dmg := h.srv.cbt.w.HurtByWeather(p, 500); dmg != 0 || p.HP != p.HPMax {
			t.Errorf("god mode took %v (hp %v/%v)", dmg, p.HP, p.HPMax)
		}
		p.Mana = 0
	})
	a.pump(150 * time.Millisecond)
	h.do(func() {
		if p := sess().ent.cbt; p.Mana != p.ManaMax {
			t.Errorf("infinite mana: %v/%v", p.Mana, p.ManaMax)
		}
	})

	// Teleport, time, weather.
	tx, tz := sx+300, sz+200
	a.devOK(t, DevActTeleport, explore.PackPinPos(int32(tx*100), int32(tz*100)), 0)
	a.devOK(t, DevActTime, 0, 2150)
	a.devOK(t, DevActWeather, 0, uint32(weather.Rain+1))
	h.do(func() {
		s := h.srv
		p := sess().ent.Move.Pos
		if math.Hypot(p.X-tx, p.Z-tz) > 0.5 {
			t.Errorf("teleport landed at %v", p)
		}
		if hr := weather.Hour(s.worldTimeS()); math.Abs(hr-21.5) > 0.05 {
			t.Errorf("hour %.2f", hr)
		}
		if s.cfg.Rain == nil || !*s.cfg.Rain {
			t.Error("weather: no rain")
		}
	})
	a.devOK(t, DevActWeather, 0, 0)

	// Spawns: three boars and a boss, then gone.
	a.devOK(t, DevActSpawn, 1, 3|5<<8)
	a.devOK(t, DevActSpawn, 0, 1|8<<8|1<<16)
	h.do(func() {
		g := h.srv.dev.groups
		if len(g) != 2 || len(g[0].Comp) != 3 || g[0].Level != 5 || g[1].Boss == "" {
			t.Errorf("spawned %d groups", len(g))
		}
	})
	a.devOK(t, DevActDespawn, 0, 0)
	h.do(func() {
		if len(h.srv.dev.groups) != 0 || slices.ContainsFunc(h.srv.cbt.w.Groups, func(g *combat.Group) bool { return g.Kind == combat.GroupTest || g.Kind == combat.GroupBoss && g.Site < 0 }) {
			t.Error("despawn left groups")
		}
	})

	// Map: reveal, then attune every crystal (boons, XP).
	a.devOK(t, DevActReveal, 0, 0)
	a.devOK(t, DevActAttune, 0, 0)
	h.do(func() {
		s := sess()
		w := h.srv.cfg.Explore
		for _, tw := range w.Towers {
			if !s.x.prog.Towers.Has(tw.Site) || !s.x.prog.Attuned.Has(tw.Site) {
				t.Fatalf("tower %d not revealed/attuned", tw.Site)
			}
		}
		if s.ent.cbt.Boons.Health <= 0 {
			t.Error("no attunement boons")
		}
	})

	// Quests: a two-step quest, one step, then the rest (rewards paid).
	h.do(func() {
		q := &quests.Quest{ID: 4242, Key: "test:dev", Title: "Dev quest", Gold: 77, Steps: []quests.Step{
			{Text: "talk", Obj: quests.Objective{Kind: quests.ObjTalk, Role: 99, Settlement: -1}},
			{Text: "talk again", Obj: quests.Objective{Kind: quests.ObjTalk, Role: 99, Settlement: -1}},
		}}
		if err := sess().quests.log.Add(q); err != nil {
			t.Fatal(err)
		}
	})
	gold := a.inventory(t).Gold
	a.devOK(t, DevActQuest, 4242, 1)
	h.do(func() {
		if q := sess().quests.log.Find(4242); q == nil || q.Step != 1 {
			t.Errorf("after one step: %+v", q)
		}
	})
	a.devOK(t, DevActQuest, 4242, 2)
	h.do(func() {
		l := sess().quests.log
		if l.Find(4242) != nil || !l.IsDone("test:dev") {
			t.Error("quest not finished")
		}
	})
	a.take(EventQuestCompleted, 2*time.Second)
	if g := a.inventory(t).Gold; g != gold+77 {
		t.Errorf("quest gold %d -> %d", gold, g)
	}

	// A shiny pet and a steed.
	sp := &contentdefs.D.Taming.Species[0]
	a.devOK(t, DevActPet, uint64(sp.ID), uint32(content.VariantShiny)|7<<8)
	a.devOK(t, DevActSteed, 0, 3)
	h.do(func() {
		s := sess()
		ps := s.pets.st
		if len(ps.Pets) != 1 || ps.Pets[0].Variant != content.VariantShiny || ps.Pets[0].Level != 7 || ps.Pets[0].Species != sp.Key {
			t.Errorf("pets %+v", ps.Pets)
		}
		if len(s.steed.owned) != 1 || s.steed.owned[0].Colour != 3 || !h.srv.hasWhistle(s) {
			t.Errorf("steed %+v whistle %v", s.steed.owned, h.srv.hasWhistle(s))
		}
	})

	// Fly: forward and up through the air, the zone stepping the same fly
	// as the client.
	a.devOK(t, DevActFlags, 0, DevFlagFly|DevFlagStamina)
	a.devOK(t, DevActSpeed, 0, 200)
	var y0 float64
	h.do(func() { y0 = sess().ent.Move.Pos.Y })
	var sim movement.State
	h.do(func() { sim = sess().ent.Move })
	for i := 0; i < 30; i++ {
		var frames []proto.InputFrame
		for k := 0; k < 2; k++ {
			a.seq++
			f := proto.InputFrame{Seq: a.seq, Flags: proto.InputFlagForward | proto.InputFlagJump, Yaw: 0, Pitch: proto.PitchToI16(0.6)}
			frames = append(frames, f)
			sim = DevFlyStep(sim, f, 2)
		}
		a.send(&proto.Input{AckTick: a.dec.Latest(), Frames: frames})
		a.pump(33 * time.Millisecond)
	}
	a.pump(200 * time.Millisecond)
	h.do(func() {
		p := sess().ent.Move.Pos
		if p.Y < y0+20 {
			t.Errorf("fly: y %.1f -> %.1f", y0, p.Y)
		}
		if math.Hypot(p.X-sim.Pos.X, p.Z-sim.Pos.Z) > 0.05 || math.Abs(p.Y-sim.Pos.Y) > 0.05 {
			t.Errorf("zone fly %v, predicted %v", p, sim.Pos)
		}
	})
	a.devOK(t, DevActFlags, 0, 0)

	// Reset: a new character.
	a.devOK(t, DevActReset, 0, 0)
	h.do(func() {
		s := sess()
		if s.x.prog.Level != 1 || s.x.prog.XP != 0 || s.x.prog.Attuned.Count() != 0 {
			t.Errorf("progress after reset: level %d xp %d attuned %d", s.x.prog.Level, s.x.prog.XP, s.x.prog.Attuned.Count())
		}
		if k := s.ent.cbt.Profile.Known; len(k) != len(combatdefs.D.Start.Spells) {
			t.Errorf("spells after reset %v", k)
		}
		if s.ent.cbt.DevGod {
			t.Error("god mode survived the flags reset")
		}
	})
	inv = a.inventory(t)
	if findItem(inv, "weapon:starmetal_sword") != nil || inv.Gold != items.D.Starter[slices.IndexFunc(items.D.Starter, func(q itemdefs.Qty) bool { return q.Item == "currency:gold" })].Qty {
		t.Errorf("inventory after reset: gold %d, %d items", inv.Gold, len(inv.Items))
	}
}

func countBase(inv inventoryJSON, base string) int {
	n := 0
	for _, it := range inv.Items {
		if it.Base == base {
			n += it.Qty
		}
	}
	return n
}
