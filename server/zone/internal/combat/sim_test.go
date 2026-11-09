package combat

import (
	"math"
	"testing"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/combat/combatbot"
)

// sim runs a World with bot players in-process at simulated time (fast):
// the same frame -> step -> claim path the zone glue uses, without the
// network. Used for the spec 8 time-to-kill measurements and the party
// clears; the networked version of the same thing is cmd/combatbots.
type sim struct {
	t       testing.TB
	w       *World
	ground  movement.Ground
	tick    uint32
	nextID  uint32
	players []*simPlayer
	log     func(string, ...any)
	events  []Out
}

type simPlayer struct {
	p       *Player
	brain   *combatbot.Brain
	state   movement.State
	pending []proto.HitClaim
	spawn   movement.Vec3
	hits    map[uint32]int // accepted hits per enemy
	refused map[uint8]int
}

func newSim(t testing.TB) *sim {
	s := &sim{t: t, ground: movement.Flat{Y: 10}, nextID: 1000}
	s.w = NewWorld(Config{Seed: 7, NoWildPacks: true}, s.ground, func() uint32 { s.nextID++; return s.nextID })
	return s
}

func (s *sim) addPlayer(name, weapon string, at movement.Vec3, level int) *simPlayer {
	s.nextID++
	prof := NewProfile()
	prof.Loadouts[0].Weapon = weapon
	p := NewPlayer(s.nextID, name, prof, level)
	at.Y = s.ground.HeightAt(at.X, at.Z)
	p.Pos = at
	st := movement.NewState(at)
	sp := &simPlayer{p: p, brain: combatbot.New(name, weapon, s.ground, st), state: st, spawn: at, hits: map[uint32]int{}, refused: map[uint8]int{}}
	s.w.AddPlayer(p)
	s.players = append(s.players, sp)
	return sp
}

func views(w *World) []combatbot.EnemyView {
	var out []combatbot.EnemyView
	for _, e := range w.Enemies() {
		if !e.Alive() {
			continue
		}
		out = append(out, combatbot.EnemyView{ID: e.ID, Pos: e.Pos, HPPct: e.HealthPct(), TypeID: e.TypeID()})
	}
	return out
}

// step advances one zone tick (two input frames per player).
func (s *sim) step() {
	s.tick++
	vs := views(s.w)
	for _, sp := range s.players {
		retry := sp.pending
		sp.pending = nil
		for k := 0; k < constants.MoveStepHz/constants.TickRateHz; k++ {
			f, claims := sp.brain.Step(vs, s.tick)
			before := sp.state
			r := s.w.Frame(sp.p, f, before)
			next := movement.StepFrame(before, r.Frame, s.ground)
			sp.state = next
			sp.p.RecordFrame(f.Seq, next)
			if next != sp.brain.State {
				sp.brain.Rebase(next) // the zone refused a dash or the player is down
			}
			retry = append(retry, claims...)
		}
		for i := range retry {
			c := retry[i]
			res := s.w.Claim(sp.p, &c)
			switch {
			case res.Pending:
				sp.pending = append(sp.pending, c)
			case res.Accepted:
				sp.hits[c.TargetID]++
			default:
				sp.refused[res.Reason]++
			}
		}
	}
	s.w.Step(s.tick)
	evs, _, _, _, respawn, _ := s.w.Drain()
	s.events = append(s.events, evs...)
	for _, o := range evs {
		if o.Ev.Kind == EvProjectile {
			for _, sp := range s.players {
				sp.brain.SeeProjectile(o.Ev)
			}
		}
		if o.Ev.Kind == EvTelegraph {
			if tg, ok := combatbot.DecodeTelegraph(o.Ev); ok {
				for _, sp := range s.players {
					if math.Hypot(sp.p.Pos.X-o.Aud.Near.X, sp.p.Pos.Z-o.Aud.Near.Z) <= o.Aud.Radius {
						sp.brain.SeeTelegraph(tg)
					}
				}
			}
		}
	}
	for _, id := range respawn {
		for _, sp := range s.players {
			if sp.p.ID == id {
				sp.state = movement.NewState(sp.spawn)
				sp.brain.Rebase(sp.state)
				sp.p.Pos = sp.spawn
			}
		}
	}
	for _, sp := range s.players {
		sp.brain.HP = sp.p.HP / sp.p.HPMax
	}
}

func (s *sim) runUntil(maxTicks int, done func() bool) bool {
	for i := 0; i < maxTicks; i++ {
		s.step()
		if done() {
			return true
		}
	}
	return false
}

func (g *Group) cleared() bool {
	if g.spawns == 0 {
		return false
	}
	return !g.Spawned
}

// fightOne measures one enemy of `key` (optionally elite) against one bot
// with `weapon`: hits to kill and seconds from the first attack to death.
func fightOne(t *testing.T, key, weapon, elite string) (hits int, secs float64, ok bool) {
	return fightAt(t, key, weapon, elite, 1, 1)
}

// fightAt is fightOne with a level-`player` character against a level-`enemy` enemy.
func fightAt(t *testing.T, key, weapon, elite string, player, enemy int) (hits int, secs float64, ok bool) {
	s := newSim(t)
	g := s.w.TestGroup(movement.Vec3{X: 500, Z: 520}, []string{key}, enemy, elite)
	sp := s.addPlayer("bot", weapon, movement.Vec3{X: 500, Z: 500}, player)
	sp.brain.Spell = nil // weapon time-to-kill: no spells
	var target *Enemy
	var start, end uint32
	ok = s.runUntil(30*120, func() bool {
		if target == nil && len(g.Members) > 0 {
			target = g.Members[0]
		}
		if target != nil && start == 0 && target.AggroTick != 0 {
			start = target.AggroTick
		}
		if target != nil && !target.Alive() && end == 0 {
			end = s.tick
		}
		return end != 0
	})
	if target == nil {
		return 0, 0, false
	}
	return sp.hits[target.ID], float64(end-start) / 30, ok
}

func TestCommonEnemyTimeToKill(t *testing.T) {
	commons := []string{"boar", "wolf", "ram", "stalker", "scuttler", "lurker", "cutthroat", "archer", "brute", "sentinel", "wisp", "ember_imp", "frost_mote", "spark_wisp", "mud_golem", "gale_harpy", "lumen_moth", "shade", "void_mite", "cave_crawler", "gloom_bat", "crystal_golem"}
	for _, weapon := range []string{"sword", "spear", "bow"} {
		var sumSecs float64
		var n int
		for _, k := range commons {
			hits, secs, ok := fightOne(t, k, weapon, "")
			if !ok {
				t.Errorf("%s vs %s: never died", weapon, k)
				continue
			}
			t.Logf("%-6s vs %-13s %d hits  %.1f s", weapon, k, hits, secs)
			if hits < 2 || hits > 5 {
				t.Errorf("%s vs %s: %d hits, spec 8 wants 2-5", weapon, k, hits)
			}
			if secs < 3 || secs > 10 {
				t.Errorf("%s vs %s: fight %.1f s, spec 8 wants 3-10", weapon, k, secs)
			}
			sumSecs += secs
			n++
		}
		if n > 0 {
			t.Logf("%s: mean fight %.1f s", weapon, sumSecs/float64(n))
		}
	}
}

func TestEliteTimeToKill(t *testing.T) {
	for _, af := range []string{"fast", "shielded", "splitting"} {
		for _, k := range []string{"boar", "cutthroat", "brute", "ember_imp"} {
			s := newSim(t)
			g := s.w.TestGroup(movement.Vec3{X: 500, Z: 520}, []string{k}, 1, af)
			s.addPlayer("bot", "sword", movement.Vec3{X: 500, Z: 500}, 1).brain.Spell = nil
			var start uint32
			ok := s.runUntil(30*90, func() bool {
				for _, e := range g.Members {
					if start == 0 && e.AggroTick != 0 {
						start = e.AggroTick
					}
				}
				return g.cleared()
			})
			secs := float64(s.tick-start) / 30
			t.Logf("elite %-9s %-10s %.1f s (downs %d)", af, k, secs, s.w.Stats.Downs)
			if !ok {
				t.Errorf("elite %s %s not cleared in 90 s", af, k)
				continue
			}
			if secs < 10 || secs > 30 {
				t.Errorf("elite %s %s: %.1f s, spec 8 wants 10-30", af, k, secs)
			}
		}
	}
}

// Playtest 1 (CR 012): the beginner family (the Haven's slimes) dies in 2-5
// hits like every common, but quicker than the 3 s floor with an optimal
// bot (they are the tutorial: slow, short aggro, soft hits).
func TestBeginnerTimeToKill(t *testing.T) {
	for _, weapon := range []string{"sword", "spear", "bow"} {
		for _, k := range D.Tables.Beginner {
			hits, secs, ok := fightOne(t, k, weapon, "")
			if !ok {
				t.Fatalf("%s vs %s: never died", weapon, k)
			}
			t.Logf("%-6s vs %-11s %d hits  %.1f s", weapon, k, hits, secs)
			if hits < 2 || hits > 5 || secs > 10 {
				t.Errorf("%s vs %s: %d hits in %.1f s", weapon, k, hits, secs)
			}
		}
	}
	for _, k := range D.Tables.Beginner {
		e := D.EnemyByKey(k)
		for _, a := range e.Attacks {
			if at := D.AttackByKey(a); at.Damage > 8 {
				t.Errorf("%s hits for %v: beginners hit softly", k, at.Damage)
			}
		}
		if e.Speed >= 5 {
			t.Errorf("%s speed %v: beginners are slow", k, e.Speed)
		}
	}
}

// Playtest 1 (CR 012, decision 0021): the leveling curve keeps at-level
// fights snappy. Enemies gain +10 % health per level and players +10 %
// damage, so with the training sword (no gear, no weapon skill) an at-level
// common takes the level-1 number of hits (2-5) at any level; and a player
// 8 levels above an area kills its commons in fewer hits (levels feel
// real).
func TestLevelCurveKeepsFightsSnappy(t *testing.T) {
	for _, k := range []string{"boar", "wolf", "cutthroat", "brute", "sentinel", "ember_imp"} {
		h1, _, ok := fightAt(t, k, "sword", "", 1, 1)
		if !ok {
			t.Fatalf("%s never died at level 1", k)
		}
		for _, l := range []int{10, 20, 30} {
			h, secs, ok := fightAt(t, k, "sword", "", l, l)
			t.Logf("sword level %2d vs %-9s level %2d: %d hits %.1f s (level 1: %d)", l, k, l, h, secs, h1)
			if !ok || h > h1 || h > 5 {
				t.Errorf("%s at level %d: %d hits (level 1: %d)", k, l, h, h1)
			}
		}
		h, _, _ := fightAt(t, k, "sword", "", 12, 4)
		t.Logf("sword level 12 vs %-9s level 4: %d hits", k, h)
		if h >= h1 || h > 4 {
			t.Errorf("level 12 vs a level-4 %s: %d hits (at level: %d), over-levelled players should feel it", k, h, h1)
		}
	}
}
