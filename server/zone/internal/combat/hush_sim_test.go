package combat

// Playtest 2 co-op polish: can a real pair beat the endgame? Two bots that
// read telegraphs like average humans (combatbot.AverageHuman: ~300 ms to
// react, one wind-up in six missed, dash and run out of the area the
// shortest way) fight the Hush at the level the zone gives it, with gear a
// player has by Act VI, no god mode. The zone's finale mechanics
// (internal/game/finale.go: the shroud, the choir of bells and its chorus,
// the endless night and its wells, revives, a respawn 220 m away, a wipe
// resetting it) are re-enacted here with the same numbers so hundreds of
// fights run in seconds; the networked check is the two-browser run
// (tools/playtest/coop-*.mjs, docs/evidence/pt2-coop-polish.md).
//
//	go test ./internal/combat -run TestHushFairForAveragePair -v
//	LODESTONE_HUSH_SIM=40 go test ./internal/combat -run 'TestHush|TestArchon' -v   (the report's numbers)

import (
	"math"
	"os"
	"strconv"
	"testing"

	"lodestone/server/pkg/movement"
	"lodestone/server/zone/internal/combat/combatbot"
)

// Act VI gear for the sims: a sunsteel weapon forged and kept up (it breaks
// the shroud and the bells), mixed starmetal armour, attunement boons.
var actSixGear = Gear{WeaponMult: 1.55, DamagePct: 10, Health: 140, ArmorPct: 15, KillsDemons: true}

// weakGear: what the first playthrough's bots wore into Act VI (a level 10
// sunsteel blade, level 1-4 armour): the floor of "reasonable".
var weakGear = Gear{WeaponMult: 1.34, Health: 60, ArmorPct: 9, KillsDemons: true}

// simGear / simTweak: LODESTONE_SIM_GEAR=weak, LODESTONE_SIM_REACT=<ms>,
// LODESTONE_SIM_MISS=<0..1> explore around the average pair.
func simGear() Gear {
	if os.Getenv("LODESTONE_SIM_GEAR") == "weak" {
		return weakGear
	}
	return actSixGear
}

func simTweak(b *combatbot.Brain) {
	h := b.Human
	if h == nil || h.MissPct >= 1 {
		return
	}
	if v, err := strconv.ParseFloat(os.Getenv("LODESTONE_SIM_REACT"), 64); err == nil {
		h.ReactMs = v
	}
	if v, err := strconv.ParseFloat(os.Getenv("LODESTONE_SIM_MISS"), 64); err == nil {
		h.MissPct = v
	}
}

type duoResult struct {
	won                     bool
	secs                    float64
	downs, revives, respawn int
	noticed, missed         int
	inReach, upTicks        int     // ticks a standing player was in melee reach of the boss, of all standing ticks
	hpLeft                  float64 // the boss's lowest health fraction in the fight
	low                     float64
}

// simAttackStats: strikes that hit / missed (dodged or out of the area) by
// enemy attack id, over every sim fight in the run.
var simAttackStats = map[byte]*[2]int{}

// simMech counts the finale mechanics' outcomes over a run.
var simMech = map[string]int{}

func init() {
	for _, a := range D.EnemyAttacks {
		simAttackStats[byte(a.ID)] = &[2]int{}
	}
}

func logAttackStats(t *testing.T) {
	for _, a := range D.EnemyAttacks {
		if st := simAttackStats[byte(a.ID)]; st[0]+st[1] > 0 {
			t.Logf("  %-14s hit %4d  missed %4d  (%.0f %% hit)", a.Key, st[0], st[1], 100*float64(st[0])/float64(st[0]+st[1]))
			*st = [2]int{}
		}
	}
	if len(simMech) > 0 {
		t.Logf("  mechanics: %v", simMech)
		clear(simMech)
	}
}

// sim numbers twinned from internal/game/finale.go (it can't be imported).
const (
	simShroudS     = 26.0
	simShroudUp    = 12.0
	simShroudStill = 2.5
	simChorusS     = 7.0
	simNightS      = 30.0
	simNightWarn   = 7.0
	simWellR       = 3.5
	simArenaR      = 30.0
	simReviveHold  = 3.0
	simReviveWin   = 20.0
	simRespawnM    = 220.0
)

func simSecs(s float64) uint32 { return uint32(math.Round(s * 30)) }

// hushDuo runs one Hush fight: two players of level plevel, the Hush at
// hlevel; seed varies the bots' reactions; human=false is the perfect bot.
func hushDuo(t testing.TB, hlevel, plevel int, seed int64, mode botMode) duoResult {
	return bossDuo(t, "the_hush", hlevel, plevel, seed, mode)
}

// bossDuo is hushDuo for any boss (the finale mechanics only for the Hush).
func bossDuo(t testing.TB, boss string, hlevel, plevel int, seed int64, mode botMode) duoResult {
	finale := boss == "the_hush"
	s := newSim(t)
	center := movement.Vec3{X: 500, Y: 10, Z: 500}
	arena := Arena{Center: center, Radius: simArenaR, Kind: "test"}
	g := s.w.AddGroup(&Group{Kind: GroupBoss, Anchor: center, Radius: simArenaR, Element: 8, Level: hlevel, Site: -1, Boss: boss, Arena: &arena, Name: "The Heartfall"})
	s.w.SpawnNow(g)
	hush := g.Members[0]
	weapons := []string{"sword", "spear"}
	var ps []*simPlayer
	for i := 0; i < 2; i++ {
		sp := s.addPlayer([]string{"Nell", "Rook"}[i], weapons[i], movement.Vec3{X: 500 + float64(i)*3 - 1.5, Z: 500 - 18}, plevel)
		sp.p.SetGear(simGear())
		sp.p.Charges = 5
		sp.brain.Charges = 5
		sp.brain.Spell = nil
		mode.apply(sp.brain, seed*7+int64(i))
		simTweak(sp.brain)
		sp.spawn = movement.Vec3{X: 500, Y: 10, Z: 500 - simRespawnM} // the nearest tower, a walk back
		ps = append(ps, sp)
	}
	home := center
	for _, sp := range ps {
		sp.brain.Goal, sp.brain.Leash = &home, simArenaR-2
	}
	// The finale's state.
	shroud, nextShroud := 0.0, simSecs(14)
	var shroudEnd uint32
	takenMult, takenUntil := 1.0, uint32(0)
	var bells []*Group
	var nextChorus, nightAt, nextNight uint32
	var wells [][2]float64
	phase := 0
	engaged := false
	guard := func(e *Enemy, src uint32, dmg float64, killing bool) float64 {
		if phase == 1 && len(bells) > 0 {
			return 0
		}
		if shroud > 0 {
			if killing {
				shroud--
				if shroud <= 0 {
					shroud = 0
					simMech["shroud broken"]++
					nextShroud = s.tick + simSecs(simShroudS)
					takenMult, takenUntil = 1.5, s.tick+simSecs(5)
					s.w.Hold(e, 3.5)
				}
			}
			return 0
		}
		if s.tick < takenUntil {
			dmg *= takenMult
		}
		return dmg
	}
	if finale {
		hush.Guard = guard
	}
	res := duoResult{}
	type downState struct {
		at     uint32
		holdBy uint32
		hold   uint32
	}
	down := map[uint32]*downState{}
	limit := simSecs(9 * 60)
	res.low = 1
	for s.tick < limit {
		seen := len(s.events)
		s.step()
		w := s.w
		w.SettleStoryStrikes()
		now := s.tick
		for _, o := range s.events[seen:] {
			switch o.Ev.Kind {
			case EvPlayerHurt:
				if len(o.Ev.Data) > 0 {
					simAttackStats[o.Ev.Data[0]][0]++
				}
			case EvEvaded:
				if e := w.enemies[o.Ev.TargetID]; e != nil && e.attack != nil {
					simAttackStats[byte(e.attack.ID)][1]++
				}
			}
		}
		if hush.Alive() && hush.Boss.FightSeconds(now) > 0 {
			res.low = math.Min(res.low, hush.HP/hush.HPMax)
			for _, sp := range ps {
				if !sp.p.Downed {
					res.upTicks++
					if hdist(sp.p.Pos, hush.Pos) <= 3.2+hush.Radius() {
						res.inReach++
					}
				}
			}
		}
		if !hush.Alive() {
			res.won = true
			break
		}
		if hush.Boss.FightSeconds(now) > 0 {
			engaged = true
		} else if engaged {
			break // a wipe: the boss reset (nobody alive in the arena for 15 s)
		}
		alive := 0
		for _, sp := range ps {
			if !sp.p.Downed {
				alive++
			}
		}
		// Downs: held for a revive while the partner stands; else the respawn.
		for _, sp := range ps {
			id := sp.p.ID
			if sp.p.Downed && down[id] == nil {
				res.downs++
				d := &downState{at: now}
				down[id] = d
				if alive > 0 {
					w.HoldDowned(id, simReviveWin)
				}
			}
			if !sp.p.Downed && down[id] != nil {
				if now-down[id].at >= simSecs(simReviveWin)-1 || hdist(sp.p.Pos, center) > simArenaR+40 {
					res.respawn++
				}
				delete(down, id)
			}
		}
		for _, sp := range ps {
			sp.brain.PreferIDs = nil
			sp.brain.Goal, sp.brain.Leash = &home, simArenaR-2
		}
		for _, sp := range ps {
			d := down[sp.p.ID]
			if d == nil {
				continue
			}
			for _, o := range ps {
				if o == sp || o.p.Downed {
					continue
				}
				// The partner goes to them and holds E.
				pos := sp.p.Pos
				o.brain.Goal, o.brain.Leash = &pos, 1.5
				o.brain.PreferIDs = func(combatbot.EnemyView) bool { return false }
				if hdist(o.p.Pos, sp.p.Pos) <= 3.5 {
					d.hold++
					if float64(d.hold) >= simReviveHold*30 {
						if w.Revive(sp.p.ID, 0.5) {
							res.revives++
							delete(down, sp.p.ID)
						}
					}
				} else {
					d.hold = 0
				}
			}
		}
		if alive == 0 || !finale {
			continue // both down: the boss resets in 15 s unless a revive... nobody is left to revive
		}
		ph := hush.Boss.Phase
		if ph != phase {
			phase = ph
			switch phase {
			case 1:
				shroud = 0
				w.MoveEnemy(hush, movement.Vec3{X: center.X, Z: center.Z})
				n := 3 // two players: party size + 1
				rot := float64(now%360) * math.Pi / 180
				for i := 0; i < n; i++ {
					a := rot + float64(i)*2*math.Pi/float64(n)
					x, z := w.WalkableNear(center.X+simArenaR*0.75*math.Cos(a), center.Z+simArenaR*0.75*math.Sin(a), 6, 2)
					bells = append(bells, w.SpawnDemons(movement.Vec3{X: x, Z: z}, []string{"hollow_bell"}, hlevel))
				}
				nextChorus = now + simSecs(4)
			case 2:
				nextNight = now + simSecs(6)
				nextShroud = now + simSecs(18)
			}
		}
		// The shroud.
		if shroud > 0 && now >= shroudEnd {
			shroud = 0
			for _, sp := range ps {
				if !sp.p.Downed && hdist(sp.p.Pos, center) <= simArenaR+4 {
					w.HurtPlayerBy(sp.p.ID, hush, "hush_night", sp.p.HPMax*0.4)
					simMech["long quiet struck"]++
				}
			}
			hush.HP = math.Min(hush.HPMax, hush.HP+hush.HPMax*0.05)
		}
		if ph != 1 && shroud <= 0 && now >= nextShroud && (nightAt == 0 || nightAt-now > simSecs(simShroudUp+2)) {
			shroud = float64(3 + 3*2)
			w.Hold(hush, simShroudStill)
			shroudEnd = now + simSecs(simShroudUp)
			nextShroud = now + simSecs(simShroudS)
		}
		// The choir: the bots shatter the bells first.
		if ph == 1 && len(bells) > 0 {
			live := map[uint32]bool{}
			for _, bg := range bells {
				for _, m := range bg.Members {
					if m.Alive() {
						live[m.ID] = true
					}
				}
			}
			if len(live) == 0 {
				bells = nil
				takenMult, takenUntil = 2, now+simSecs(8)
				w.Hold(hush, 6)
			} else {
				for _, sp := range ps {
					if sp.brain.PreferIDs == nil {
						sp.brain.PreferIDs = func(v combatbot.EnemyView) bool { return live[v.ID] }
						sp.brain.Leash = simArenaR + 6
					}
				}
				if now >= nextChorus {
					nextChorus = now + simSecs(simChorusS)
					for _, sp := range ps {
						if !sp.p.Downed {
							w.StoryStrike(hush, "hush_chorus", sp.p.Pos, 3.0)
						}
					}
				}
			}
		}
		// The endless night: each to a well of their own.
		if ph == 2 {
			if nightAt == 0 && now >= nextNight {
				n := min(4, max(2, alive))
				rot := float64(now%360) * math.Pi / 180
				wells = wells[:0]
				for i := 0; i < n; i++ {
					a := rot + float64(i)*2*math.Pi/float64(n)
					wells = append(wells, [2]float64{center.X + simArenaR*0.6*math.Cos(a), center.Z + simArenaR*0.6*math.Sin(a)})
				}
				nightAt = now + simSecs(simNightWarn)
			} else if nightAt != 0 && now >= nightAt {
				in := make([]int, len(wells))
				at := map[uint32]int{}
				for _, sp := range ps {
					at[sp.p.ID] = -1
					for i, wl := range wells {
						if math.Hypot(sp.p.Pos.X-wl[0], sp.p.Pos.Z-wl[1]) <= simWellR {
							at[sp.p.ID] = i
							in[i]++
							break
						}
					}
				}
				for _, sp := range ps {
					if i := at[sp.p.ID]; !sp.p.Downed && (i < 0 || in[i] != 1) && hdist(sp.p.Pos, center) <= simArenaR+4 {
						w.HurtPlayerBy(sp.p.ID, hush, "hush_night", sp.p.HPMax*0.75)
						simMech["night struck"]++
					}
				}
				nightAt = 0
				wells = wells[:0]
				nextNight = now + simSecs(simNightS)
			}
			if nightAt != 0 {
				// The warning: each runs to their own well (a pair says "I'll take this one").
				used := map[int]bool{}
				for _, sp := range ps {
					if sp.p.Downed || down[sp.p.ID] != nil {
						continue
					}
					bi, bd := -1, math.Inf(1)
					for i, wl := range wells {
						if d := math.Hypot(sp.p.Pos.X-wl[0], sp.p.Pos.Z-wl[1]); !used[i] && d < bd {
							bi, bd = i, d
						}
					}
					if bi >= 0 {
						used[bi] = true
						wp := movement.Vec3{X: wells[bi][0], Z: wells[bi][1]}
						sp.brain.Goal, sp.brain.Leash = &wp, 1.0
						sp.brain.PreferIDs = func(combatbot.EnemyView) bool { return false }
					}
				}
			}
		}
	}
	res.secs = hush.Boss.FightSeconds(s.tick)
	if res.won {
		for _, o := range s.events {
			if o.Ev.Kind == EvBossDefeated {
				res.secs = float64(o.Ev.Value)
			}
		}
	}
	res.hpLeft = math.Max(0, math.Min(res.low, hush.HP/hush.HPMax))
	for _, sp := range ps {
		if h := sp.brain.Human; h != nil {
			res.noticed += h.Noticed
			res.missed += h.Ignored
		}
	}
	return res
}

// botMode: how the sim's bots read telegraphs.
type botMode int

const (
	perfectBots botMode = iota // the spec 8 bot: every wind-up dodged on its last frames
	humanBots                  // combatbot.AverageHuman
	noDodgeBots                // never reacts to a wind-up
)

func (m botMode) apply(b *combatbot.Brain, seed int64) {
	switch m {
	case humanBots:
		b.Human = combatbot.AverageHuman(seed)
	case noDodgeBots:
		b.Human = combatbot.AverageHuman(seed)
		b.Human.MissPct = 1
	}
}

// duoStats runs n fights and summarises them.
func duoStats(t *testing.T, name string, n int, run func(seed int64) duoResult) (wins int, meanWin, reach float64) {
	var secs, hp float64
	downs, revives, respawns, in, up := 0, 0, 0, 0, 0
	for i := 0; i < n; i++ {
		r := run(int64(i + 1))
		if r.won {
			wins++
			secs += r.secs
		} else {
			hp += r.hpLeft
		}
		downs += r.downs
		revives += r.revives
		respawns += r.respawn
		in += r.inReach
		up += r.upTicks
		t.Logf("%s seed %2d: won %-5v %.0f s, boss left %3.0f %%, downs %d, revives %d, respawns %d, wind-ups noticed %d missed %d", name, i+1, r.won, r.secs, r.hpLeft*100, r.downs, r.revives, r.respawn, r.noticed, r.missed)
	}
	if wins > 0 {
		meanWin = secs / float64(wins)
	}
	lost := n - wins
	meanLeft := 0.0
	if lost > 0 {
		meanLeft = hp / float64(lost) * 100
	}
	reach = float64(in) / math.Max(1, float64(up))
	t.Logf("%s: %d/%d won (%.0f %%), mean win %.0f s (%.1f min); losses left the boss at %.0f %% on average; downs %.1f, revives %.1f, respawns %.1f a fight; in melee reach %.0f %% of the time",
		name, wins, n, 100*float64(wins)/float64(n), meanWin, meanWin/60, meanLeft, float64(downs)/float64(n), float64(revives)/float64(n), float64(respawns)/float64(n), reach*100)
	logAttackStats(t)
	return wins, meanWin, reach
}

func simRuns(def int) int {
	if v, err := strconv.Atoi(os.Getenv("LODESTONE_HUSH_SIM")); err == nil && v > 0 {
		return v
	}
	return def
}

// hushAbove twins internal/game/finale.go's finaleLevel: the Hush's level
// over the party's.
const hushAbove = 1

// TestHushFairForAveragePair: two average humans at the party's level beat
// the Hush most of the time, in 3-7 minutes; it is still a fight (they go
// down and revive each other) and two players who never dodge lose.
func TestHushFairForAveragePair(t *testing.T) {
	if testing.Short() {
		t.Skip("fight sims")
	}
	const plevel = 30
	hl := plevel + hushAbove
	n := simRuns(6)
	wins, mean, _ := duoStats(t, "hush human pair", n, func(seed int64) duoResult { return hushDuo(t, hl, plevel, seed, humanBots) })
	if float64(wins) < 0.75*float64(n) {
		t.Errorf("average pair won %d of %d against the Hush: want at least 75 %%", wins, n)
	}
	if wins > 0 && (mean < 150 || mean > 450) {
		t.Errorf("mean win %.0f s: want 2.5-7.5 minutes", mean)
	}
	// Standing in everything loses: the fight asks for dodging.
	r := hushDuo(t, hl, plevel, 99, noDodgeBots)
	t.Logf("hush, a pair that never dodges: won %v at %.0f s, boss left %.0f %%", r.won, r.secs, r.hpLeft*100)
	if r.won {
		t.Errorf("a pair that never dodges beat the Hush")
	}
}

// TestArchonFunForMeleePair: the Act V Archon (a ranged boss) against two
// melee players: they win, in 2-5 minutes, and spend most of the fight in
// reach of it instead of chasing a kite.
func TestArchonFunForMeleePair(t *testing.T) {
	if testing.Short() {
		t.Skip("fight sims")
	}
	n := simRuns(6)
	wins, mean, reach := duoStats(t, "archon melee pair", n, func(seed int64) duoResult { return bossDuo(t, "archon", 20, 20, seed, humanBots) })
	if float64(wins) < 0.6*float64(n) {
		t.Errorf("melee pair won %d of %d against the Archon: want at least 60 %%", wins, n)
	}
	if wins > 0 && (mean < 90 || mean > 330) {
		t.Errorf("mean win %.0f s: want 1.5-5.5 minutes", mean)
	}
	if reach < archonMinReach {
		t.Errorf("melee pair in reach of the Archon %.0f %% of the time: want at least %.0f %%", reach*100, archonMinReach*100)
	}
}

// archonMinReach: the share of the fight a melee player should be able to
// spend in reach of the Archon (62 % while it kited, 70 % since it stands
// and fights, on flat ground; the rest is its adds and the dodging).
const archonMinReach = 0.65
