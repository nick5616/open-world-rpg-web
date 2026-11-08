package combat

import (
	"encoding/binary"
	"math"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/movement"
)

// Bosses (spec 8): 2 or 3 phases, big telegraphed attacks and adds, in an
// arena the generator supplies. v1 arenas are overworld structure sites
// (wizard towers, sunken temples, demon lairs, large ruins); WP09's cave
// chambers plug in through AddArena / ArenaProvider without changes here.

// Arena is where a boss fights: a circle it never leaves.
type Arena struct {
	Center movement.Vec3
	Radius float64
	Kind   string // "site" (overworld structure) | "cave" (WP09 chamber) | "test"
	Site   int    // atlas site index for "site"
	System int    // cave system id for "cave" (WP09)
	Node   int    // chamber node in the cave graph (WP09)
}

// ArenaProvider is the hook for generated arenas outside the atlas sites:
// WP09 returns its deepest chambers (spec 8: "bosses live at the heart of
// large cave systems") and the zone registers each with AddArena.
type ArenaProvider interface {
	BossArenas() []Arena
}

// AddArena registers a boss arena (a cave chamber, a test arena).
func (w *World) AddArena(a Arena, boss string, level, element int) *Group {
	if D.BossByKey(boss) == nil {
		return nil
	}
	if a.Radius <= 0 {
		a.Radius = D.BossByKey(boss).ArenaRadius
	}
	return w.AddGroup(&Group{Kind: GroupBoss, Anchor: a.Center, Radius: a.Radius, Element: element, Level: level, Site: -1, Boss: boss, Arena: &a})
}

// BossState is a boss's fight state.
type BossState struct {
	Def             *combatdefs.Boss
	Phase           int
	Arena           *Arena
	transitionUntil uint32
	engagedAt       uint32
	lastPresence    uint32
	adds            []*Enemy
}

func newBossState(def *combatdefs.Boss, arena *Arena) *BossState {
	return &BossState{Def: def, Arena: arena}
}

// bossTick resets a boss nobody is fighting: no living player inside the
// arena (plus 10 m) for 15 s heals it, returns it to phase 1 and removes
// its adds, so a wiped party or a passer-by never leaves a half-dead boss.
func (w *World) bossTick(e *Enemy) {
	b := e.Boss
	if b.Arena == nil {
		return
	}
	present := false
	for _, p := range w.players {
		if !p.Downed && hdist(p.Pos, b.Arena.Center) <= b.Arena.Radius+10 {
			present = true
			break
		}
	}
	if present {
		b.lastPresence = w.tick
		return
	}
	if b.engagedAt != 0 && w.tick-b.lastPresence > secondsToTicks(15) {
		e.resetScale()
		b.Phase, b.engagedAt, b.transitionUntil = 0, 0, 0
		clear(e.threat)
		clear(e.engaged)
		clear(e.DamageBy)
		e.Target = 0
		e.State, e.stateAt = Return, w.tick
		for _, a := range b.adds {
			if a.Alive() {
				a.State = Dead
				a.diedTick = w.tick
			}
		}
		b.adds = nil
		w.near(e.Pos, 120, 0, Out{Ev: ev(EvBossReset, e.ID, 0, 0, e.Pos, []byte(e.Name))})
	}
}

// checkPhase moves to the next phase when health crosses its threshold: a
// short invulnerable roar, the new attack set and its adds.
func (w *World) checkPhase(e *Enemy) {
	b := e.Boss
	for b.Phase+1 < len(b.Def.Phases) && e.HP/e.HPMax <= b.Def.Phases[b.Phase+1].At {
		b.Phase++
		ph := b.Def.Phases[b.Phase]
		b.transitionUntil = w.tick + ticksOf(b.Def.TransitionSteps)
		e.State, e.stateAt, e.attack = Recover, w.tick, nil
		clear(e.cooldowns)
		data := binary.LittleEndian.AppendUint16(nil, uint16(math.Round(float64(b.Def.TransitionSteps)*1000/float64(D.StepHz))))
		data = append(data, []byte(e.Name)...)
		w.near(e.Pos, 120, 0, Out{Ev: ev(EvBossPhase, e.ID, uint32(b.Phase), int32(len(b.Def.Phases)), e.Pos, data)})
		w.spawnAdds(e, ph.Adds)
	}
}

// spawnAdds summons the phase's adds: the boss element's elemental (or the
// biome's beasts for an unaligned boss), around the boss. The count scales
// with the party (half the table's count solo, +25 % per extra player), so
// a solo player gets a fight and a party of four gets a crowd.
func (w *World) spawnAdds(e *Enemy, n int) {
	if n <= 0 {
		return
	}
	n = int(math.Ceil(float64(n) * (0.5 + 0.25*float64(e.scaleN-1))))
	key := ""
	if e.Element < combatdefs.Physical {
		key = D.Tables.Element[e.Element]
	} else if e.Group != nil {
		key = D.Tables.Biome[min(5, max(0, e.Group.Biome))][0]
	}
	def := D.EnemyByKey(key)
	if def == nil {
		return
	}
	for i := 0; i < n; i++ {
		a := e.Yaw + float64(i)*2*math.Pi/float64(n)
		pos := w.place(e.Pos.X+5*math.Cos(a), e.Pos.Z+5*math.Sin(a), def)
		add := newEnemy(def, e.Level, e.Element, nil, pos)
		add.Group, add.Home = e.Group, pos
		for id := range e.engaged {
			add.engaged[id] = true
		}
		add.partyScale(e.scaleN)
		w.addEnemy(add)
		add.State, add.Target = Chase, e.Target
		e.Boss.adds = append(e.Boss.adds, add)
		if e.Group != nil {
			e.Group.Members = append(e.Group.Members, add)
		}
	}
}

// bossDefeated announces the kill with the fight's length (the spec 8
// "boss: 2 to 5 minutes" measurement) and clears the adds' leash.
func (w *World) bossDefeated(e *Enemy) {
	b := e.Boss
	secs := float64(w.tick-b.engagedAt) / 30
	if b.engagedAt == 0 {
		secs = 0
	}
	for _, a := range b.adds {
		if a.Alive() {
			w.kill(a, e.lastHitBy)
		}
	}
	w.near(e.Pos, 160, 0, Out{Ev: ev(EvBossDefeated, e.ID, uint32(e.Def.ID), int32(math.Round(secs)), e.Pos, []byte(e.Name))})
}

// FightSeconds is how long the current boss fight has run (0 if none).
func (b *BossState) FightSeconds(tick uint32) float64 {
	if b.engagedAt == 0 {
		return 0
	}
	return float64(tick-b.engagedAt) / 30
}
