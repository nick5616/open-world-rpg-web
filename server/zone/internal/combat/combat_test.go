package combat

import (
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

// player drives one Player by hand: frames through World.Frame and the
// movement step, exactly like the zone glue.
type handPlayer struct {
	w     *World
	p     *Player
	state movement.State
	seq   uint32
	g     movement.Ground
}

func newHand(w *World, id uint32, at movement.Vec3, weapon string) *handPlayer {
	prof := NewProfile()
	prof.Loadouts[0].Weapon = weapon
	p := NewPlayer(id, "p", prof, 1)
	at.Y = w.ground.HeightAt(at.X, at.Z)
	p.Pos = at
	w.AddPlayer(p)
	return &handPlayer{w: w, p: p, state: movement.NewState(at), g: w.ground}
}

func (h *handPlayer) frame(flags uint16, slot uint8, yaw float64) uint32 {
	h.seq++
	f := proto.InputFrame{Seq: h.seq, Flags: flags, CastSlot: slot, Yaw: proto.YawToU16(yaw)}
	r := h.w.Frame(h.p, f, h.state)
	h.state = movement.StepFrame(h.state, r.Frame, h.g)
	h.p.RecordFrame(h.seq, h.state)
	return h.seq
}

func (h *handPlayer) idle(n int) {
	for i := 0; i < n; i++ {
		h.frame(0, 0, 0)
	}
}

func newWorld() (*World, *uint32) {
	id := uint32(100)
	w := NewWorld(Config{Seed: 1, NoWildPacks: true}, movement.Flat{Y: 5}, func() uint32 { id++; return id })
	return w, &id
}

func claim(seq uint32, attack int, target uint32, tick uint32, at movement.Vec3) *proto.HitClaim {
	return &proto.HitClaim{AttackSeq: seq, AttackID: uint16(attack), TargetID: target, Tick: tick, X: proto.MetersToCm(at.X), Y: proto.MetersToCm(at.Y), Z: proto.MetersToCm(at.Z)}
}

// spawnOne puts one enemy at `at` and wakes it.
func spawnOne(w *World, key string, at movement.Vec3) *Enemy {
	g := w.TestGroup(at, []string{key}, 1, "")
	w.spawnGroup(g)
	e := g.Members[0]
	e.State = Idle
	w.Drain()
	return e
}

// ---- PvP immunity (spec 2, spec 8: no attack or spell can damage a player) ----

func TestNoAttackOrSpellCanDamageAPlayer(t *testing.T) {
	w, _ := newWorld()
	a := newHand(w, 1, movement.Vec3{X: 100, Z: 100}, "sword")
	b := newHand(w, 2, movement.Vec3{X: 101, Z: 100}, "sword")
	a.p.Profile.Known = nil
	for _, s := range D.Spells {
		a.p.Profile.Known = append(a.p.Profile.Known, s.Key)
	}
	a.p.Mana, a.p.ManaMax = 1e9, 1e9
	hp := b.p.HP
	tried := 0
	// Every weapon move of every weapon, aimed and claimed at the player.
	for _, wpn := range D.Weapons {
		a.p.Profile.Loadouts[0].Weapon = wpn.Key
		a.idle(40)
		seq := a.frame(proto.InputFlagAttack, 0, -math.Pi/2)
		for _, m := range D.Moves {
			res := w.Claim(a.p, claim(seq, m.ID, b.p.ID, w.tick, b.p.Pos))
			if res.Accepted {
				t.Fatalf("move %s accepted against a player", m.Key)
			}
			tried++
		}
	}
	// Every equippable spell cast and claimed at the player (and at its feet).
	for _, s := range D.Spells {
		if s.Type == "passive" || s.Type == "mobility" {
			continue
		}
		a.p.Profile.Loadouts[0].Spells[0] = s.Key
		a.p.readyAt = map[int]uint32{}
		a.idle(2)
		seq := a.frame(proto.InputFlagCast, 0, -math.Pi/2)
		for k := 0; k < 3; k++ {
			w.Step(w.tick + 1)
			w.Drain()
		}
		res := w.Claim(a.p, claim(seq, s.ID, b.p.ID, w.tick, b.p.Pos))
		if res.Accepted {
			t.Fatalf("spell %s accepted against a player", s.Key)
		}
		tried++
	}
	// The zone glue calls RefusePlayerTarget for player ids; World.Claim
	// itself only knows enemies, so a player id is "no such target" here.
	if r := w.RefusePlayerTarget(); r.Accepted || r.Reason != RefuseNotEnemy {
		t.Fatal("RefusePlayerTarget accepted")
	}
	// Self buffs, domains and area spells resolved around the player never
	// touched its health (only shields/heals may change it upward).
	for i := 0; i < 90; i++ {
		w.Step(w.tick + 1)
		w.Drain()
	}
	if b.p.HP < hp {
		t.Fatalf("player B lost health: %v -> %v", hp, b.p.HP)
	}
	t.Logf("%d attack/spell claims against a player: all refused, health %v -> %v", tried, hp, b.p.HP)
}

// The structural half: only two functions lower a player's health:
// hurtPlayer, whose call sites all pass an enemy as the source, and
// hurtByPlayer (playtest 2, CR 019), called only from applyPlayerHit, which
// only ClaimPlayer reaches (the game layer calls it after its PvP rules).
func TestOnlyEnemiesCallHurtPlayer(t *testing.T) {
	files, _ := filepath.Glob("*.go")
	re := regexp.MustCompile(`hurtPlayer\(([^)]*)\)`)
	byPlayer := regexp.MustCompile(`hurtByPlayer\(`)
	writes := regexp.MustCompile(`\b(p|q)\.HP\s*(-=|=\s*0\b)`)
	calls := 0
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, _ := os.ReadFile(f)
		src := string(b)
		for _, m := range re.FindAllStringSubmatch(src, -1) {
			if strings.HasPrefix(m[1], "p *Player") {
				continue // the definition
			}
			args := strings.Split(m[1], ",")
			if len(args) < 3 || !strings.Contains(args[2], "enemy") {
				t.Errorf("%s: hurtPlayer(%s) without an enemy source", f, m[1])
			}
			calls++
		}
		// CR 020: and once in summon.go (allyHit), only after the game layer's
		// SummonPvP rule said the ally's caster may hurt that player.
		if n := len(byPlayer.FindAllString(src, -1)); n > 0 && !(f == "pvp.go" && n == 2) && !(f == "summon.go" && n == 1) {
			t.Errorf("%s: hurtByPlayer appears %d times (only its definition and applyPlayerHit, in pvp.go)", f, n)
		}
		fn := ""
		for _, line := range strings.Split(src, "\n") {
			if strings.HasPrefix(line, "func ") {
				fn = line
			}
			if writes.MatchString(line) {
				ok := (f == "ai.go" && (strings.Contains(fn, "hurtPlayer(") || strings.Contains(fn, "downPlayer("))) ||
					(f == "pvp.go" && strings.Contains(fn, "hurtByPlayer(")) ||
					(f == "dashes.go" && strings.Contains(fn, "payBlood(")) // CR 021: the blood dash costs your own health
				if !ok {
					t.Errorf("%s: player health lowered outside hurtPlayer/hurtByPlayer: %s (in %s)", f, strings.TrimSpace(line), fn)
				}
			}
		}
		if f == "pvp.go" && !strings.Contains(src, "func (w *World) ClaimPlayer(") {
			t.Error("pvp.go: ClaimPlayer is gone")
		}
	}
	if calls == 0 {
		t.Fatal("no hurtPlayer call sites found")
	}
}

// ---- validation (spec 9: lenient, favor the player) ----

func TestClaimValidation(t *testing.T) {
	w, _ := newWorld()
	h := newHand(w, 1, movement.Vec3{X: 200, Z: 200}, "sword")
	e := spawnOne(w, "brute", movement.Vec3{X: 200, Z: 198})
	// yaw 0 faces -Z: the brute is straight ahead, 2 m away.
	seq := h.frame(proto.InputFlagAttack, 0, 0)
	m := D.MoveOf(D.WeaponByKey("sword"), "light", 0)
	w.Step(1)
	if r := w.Claim(h.p, claim(seq, m.ID, e.ID, 1, h.p.Pos)); !r.Accepted || r.Damage == 0 {
		t.Fatalf("in-reach hit refused: %+v", r)
	}
	if r := w.Claim(h.p, claim(seq, m.ID, e.ID, 1, h.p.Pos)); r.Accepted || r.Reason != RefuseHits {
		t.Fatalf("second hit of the same swing on the same target: %+v", r)
	}
	if r := w.Claim(h.p, claim(seq+50, m.ID, e.ID, 1, h.p.Pos)); !r.Pending {
		t.Fatalf("claim for a frame not yet applied should wait: %+v", r)
	}
	if r := w.Claim(h.p, claim(seq, 999, e.ID, 1, h.p.Pos)); r.Accepted || r.Reason != RefuseUnknown {
		t.Fatalf("unknown attack id: %+v", r)
	}

	// Too fast: a second swing before the first's recovery is refused.
	h.idle(30)
	s1 := h.frame(proto.InputFlagAttack, 0, 0)
	s2 := h.frame(proto.InputFlagAttack, 0, 0)
	_ = s2
	if a := h.p.actions[(h.p.nAct-1)%actionRing]; a.Seq != s2 || a.Legal {
		t.Fatalf("a swing one step after another was legal (s1 %d)", s1)
	}
	// ...but a dodge after the hit frames cancels the recovery (spec 8).
	h.idle(40)
	s3 := h.frame(proto.InputFlagAttack, 0, 0)
	mv := h.p.Action(s3, h.p.actions[(h.p.nAct-1)%actionRing].ID).Move
	h.idle(mv.StartupSteps + mv.ActiveSteps)
	h.frame(proto.InputFlagDodge|proto.InputFlagBack, 0, 0)
	s4 := h.frame(proto.InputFlagAttack, 0, 0)
	if a := h.p.actions[(h.p.nAct-1)%actionRing]; a.Seq != s4 || !a.Legal {
		t.Fatalf("attack right after a dodge-cancel refused")
	}

	// Out of reach: the target moved 12 m away for the whole history.
	h.idle(40)
	far := spawnOne(w, "boar", movement.Vec3{X: 200, Z: 186})
	for i := 0; i < 20; i++ {
		w.Step(w.tick + 1)
	}
	s5 := h.frame(proto.InputFlagAttack, 0, 0)
	a5 := h.p.actions[(h.p.nAct-1)%actionRing]
	if r := w.Claim(h.p, claim(s5, a5.ID, far.ID, w.tick, h.p.Pos)); r.Accepted || r.Reason != RefuseRange {
		t.Fatalf("12 m sword hit: %+v", r)
	}
	// Lenient: the target was in reach 200 ms ago (it has since stepped
	// away 1.5 m beyond reach + slack): accepted.
	near := spawnOne(w, "boar", movement.Vec3{X: 205, Z: 198})
	near.record(w.tick)
	w.Step(w.tick + 1)
	h.idle(40)
	h.frame(0, 0, 0)
	s6 := h.frame(proto.InputFlagAttack, 0, -math.Pi/2) // face +X
	a6 := h.p.actions[(h.p.nAct-1)%actionRing]
	// In reach (3 m) at this tick, out of reach (6 m) from the next one on:
	// the client saw it in reach, so the claim must be accepted.
	near.Pos.X, near.Pos.Z = h.p.Pos.X+3, h.p.Pos.Z
	near.record(w.tick)
	near.Pos.X = h.p.Pos.X + 6
	near.record(w.tick + 1)
	w.tick++
	if r := w.Claim(h.p, claim(s6, a6.ID, near.ID, w.tick, h.p.Pos)); !r.Accepted {
		t.Fatalf("hit on a target that was in reach in the history window refused: %+v", r)
	}
}

func TestCooldownAndMana(t *testing.T) {
	w, _ := newWorld()
	h := newHand(w, 1, movement.Vec3{X: 300, Z: 300}, "staff")
	h.p.Profile.Loadouts[0].Spells[0] = "ember_flick"
	s1 := h.frame(proto.InputFlagCast, 0, 0)
	s2 := h.frame(proto.InputFlagCast, 0, 0)
	if a := h.p.Action(s1, D.SpellByKey("ember_flick").ID); a == nil || !a.Legal {
		t.Fatal("first cast refused")
	}
	if a := h.p.Action(s2, D.SpellByKey("ember_flick").ID); a == nil || a.Legal || a.Refusal != RefuseCooldown {
		t.Fatal("cast during cooldown accepted")
	}
	h.p.Mana = 1
	h.idle(60)
	s3 := h.frame(proto.InputFlagCast, 0, 0)
	if a := h.p.Action(s3, D.SpellByKey("ember_flick").ID); a == nil || a.Legal || a.Refusal != RefuseMana {
		t.Fatal("cast without mana accepted")
	}
	// A mobility dash nobody equipped is stripped before the step runs.
	before := h.state
	h.frame(proto.InputFlagDodge, uint8(D.DashByID(5).ID), 0) // static_step, not equipped
	if h.state.Dash != 0 || h.state.Pos != movement.StepFrame(before, proto.InputFrame{}, h.g).Pos {
		t.Fatal("an unequipped dash variant was applied")
	}
	// The equipped one (magma_dash in the start kit) is applied.
	h.p.Profile.Loadouts[0].Spells[1] = "magma_dash"
	h.p.Mana = 100
	h.idle(5)
	h.frame(proto.InputFlagDodge|proto.InputFlagForward, uint8(D.SpellByKey("magma_dash").Dash), 0)
	if h.state.Dash == 0 {
		t.Fatal("equipped mobility dash refused")
	}
}

// ---- enemy strikes: telegraphed, dodgeable, only ever from enemies ----

func strikeSetup(t *testing.T) (*World, *handPlayer, *Enemy) {
	w, _ := newWorld()
	h := newHand(w, 1, movement.Vec3{X: 500, Z: 500}, "sword")
	e := spawnOne(w, "brute", movement.Vec3{X: 500, Z: 502.5})
	e.Target = h.p.ID
	return w, h, e
}

func runStrike(w *World, h *handPlayer, e *Enemy, dodgeAtWindupEnd bool) (hurt, evaded int) {
	a := D.AttackByKey("smash")
	w.windup(e, a, h.p)
	wind := int(ticksOf(a.WindupSteps))
	for i := 0; i < wind+30; i++ {
		flags := uint16(0)
		if dodgeAtWindupEnd && i == wind-1 {
			flags = proto.InputFlagDodge
		}
		h.frame(flags, 0, 0)
		h.frame(0, 0, 0)
		w.Step(w.tick + 1)
		evs, _, _, _, _, _ := w.Drain()
		for _, o := range evs {
			switch o.Ev.Kind {
			case EvPlayerHurt:
				hurt++
			case EvEvaded:
				evaded++
			}
		}
		if e.State == Recover || e.State == Reposition {
			e.State = Idle // no follow-up attacks in this test
			e.nextAttack = w.tick + 1000
		}
	}
	return
}

func TestEnemyStrikeHitsAndDodgeEvades(t *testing.T) {
	w, h, e := strikeSetup(t)
	if hurt, _ := runStrike(w, h, e, false); hurt != 1 {
		t.Fatalf("standing in a telegraphed smash: hurt %d times, want 1", hurt)
	}
	w, h, e = strikeSetup(t)
	hp := h.p.HP
	if hurt, ev := runStrike(w, h, e, true); hurt != 0 || ev != 1 || h.p.HP != hp {
		t.Fatalf("dodging the smash: hurt %d evaded %d hp %v->%v", hurt, ev, hp, h.p.HP)
	}
}

func TestWindupsWithinFeelTargets(t *testing.T) {
	for _, a := range D.EnemyAttacks {
		ms := float64(ticksOf(a.WindupSteps)) * 1000 / constants.TickRateHz
		if ms < constants.EnemyWindupMinMs-1 || ms > constants.EnemyWindupMaxMs+1 {
			t.Errorf("%s: wind-up %.0f ms on the 30 Hz tick", a.Key, ms)
		}
	}
}

func TestPartyScaling(t *testing.T) {
	e := newEnemy(D.EnemyByKey("warden"), 1, combatdefs.Physical, nil, movement.Vec3{})
	base := e.HPMax
	e.partyScale(2)
	if math.Abs(e.HPMax-base*1.75) > 1e-9 {
		t.Fatalf("2 players: hp %v want %v", e.HPMax, base*1.75)
	}
	e.partyScale(4)
	if math.Abs(e.HPMax-base*3.25) > 1e-9 || math.Abs(e.DamageMult-1.3) > 1e-9 {
		t.Fatalf("4 players: hp %v dmg %v", e.HPMax, e.DamageMult)
	}
	e.partyScale(1) // never shrinks mid fight
	if e.ScaleN() != 4 {
		t.Fatal("scale shrank")
	}
}

func TestProfileLearnEquipPersist(t *testing.T) {
	p := NewProfile()
	if r := p.Learn("fireball", 1); r != LearnPrereq {
		t.Fatalf("fireball without prereq: %d", r)
	}
	if r := p.Learn("spark_shot", 1); r != LearnOK {
		t.Fatalf("spark_shot: %d", r)
	}
	if r := p.Learn("fireball", 1); r != LearnOK {
		t.Fatalf("fireball after spark_shot: %d", r)
	}
	if r := p.Learn("kindling", 1); r != LearnNoPoints {
		t.Fatalf("third point at level 1: %d", r)
	}
	if !p.EquipSpell(1, 2, "fireball") || p.EquipSpell(1, 3, "kindling") {
		t.Fatal("equip rules")
	}
	p.Swap(1)
	q := LoadProfile(p.MarshalSkillTree(), p.Known)
	if q.Active != 1 || q.Loadouts[1].Spells[2] != "fireball" || !q.Knows("fireball") {
		t.Fatalf("round trip: %+v", q)
	}
	if r := LoadProfile([]byte(`{"v":1,"loadouts":[{"weapon":"sword","spells":["god_ray","","",""]}]}`), nil); r.Loadouts[0].Spells[0] != "" {
		t.Fatal("unknown equipped spell survived load")
	}
}
