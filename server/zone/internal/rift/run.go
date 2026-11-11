package rift

// A run (CR 040): a party walks through the stages of one chapter. The run
// owns the rules (what fires when, who is hit, when the door opens, perks,
// spoils); the zone (internal/game/rift.go) is its Host: it spawns the
// bodies as combat enemies (so every weapon and spell works on them), moves
// players, applies damage through combat and turns Outs into Events.

import (
	"math"
)

// Run states.
const (
	StateIntro = iota // the room is quiet for IntroS
	StateFight
	StatePerks // cleared; perk cards are up
	StateDoor  // cleared; the door is open
	StateEnded
)

// Why a player left a run (Out.Reason / Event 1705 value).
const (
	LeftDied       = 1 // downed: unbanked spoils are lost
	LeftExit       = 2 // walked out at a checkpoint: everything kept
	LeftDisconnect = 3 // logged out or lost connection: unbanked spoils lost
	LeftVictory    = 4 // stage 50 cleared and walked out
	LeftDev        = 5 // dev console
)

// Out kinds.
const (
	OutStage     = iota + 1 // a new room (members are moved to its entrance)
	OutVolley               // a telegraphed volley
	OutClear                // the room is clear (bullets fade)
	OutDoor                 // the door opened (N: 1 = the way out stands beside it)
	OutPerkOffer            // Member: Perks to choose from
	OutPerkTaken            // Member took Perk
	OutReward               // Member's stage reward (Loot, at X, Z)
	OutGems                 // N gems for Member at X, Z (gem events, geodes)
	OutBank                 // Member's spoils banked (N gold)
	OutLeft                 // Member left (Reason)
	OutHit                  // Member hit (N damage, Value = volley kind, 0 spikes)
	OutWard                 // Member's ward ate a shot
	OutGraze                // Member grazed a shot (mana)
	OutPhase                // a boss reached phase N
	OutEnd                  // the run is over (Reason: the last way out)
)

// Out is one thing the host must do or tell.
type Out struct {
	Kind   int
	Member uint32
	N      int
	Value  int
	Reason int
	Perks  []int
	Perk   int
	Loot   LootOdds
	X, Z   float64
	V      *Volley
	Enemy  uint32
}

// Host is the zone side of a run.
type Host interface {
	// Spawn makes sp's body at arena-local (x, z) with hp; its entity id.
	Spawn(r *Run, sp Spawn, hp float64) uint32
	// EnemyHP is an enemy's health fraction (0: dead or gone).
	EnemyHP(id uint32) float64
	// MoveEnemy places an enemy at arena-local (x, z).
	MoveEnemy(r *Run, id uint32, x, z float64)
	// Remove takes an enemy out of the world.
	Remove(id uint32)
	// HP is a member's health and max health.
	HP(m *Member) (hp, max float64)
	// Hurt deals dmg to a member from enemy src (0: the room); true if it
	// downed them.
	Hurt(r *Run, m *Member, src uint32, dmg float64, kind int) bool
	// Heal heals a member by amount.
	Heal(m *Member, amount float64)
	// Out delivers one output.
	Out(r *Run, o Out)
}

// Member is one player in a run. The host writes X, Z (arena-local),
// Dodging (dash i-frames) and In (inside the arena) before every Tick.
type Member struct {
	ID      uint32
	Char    string
	Name    string
	X, Z    float64
	In      bool
	Dodging bool

	Perks  map[string]int
	Mods   Mods
	Offer  []int
	Picked bool
	Spoils int // gold carried since the last checkpoint
	Banked int // gold banked this run
	Best   int // deepest stage cleared while in the run
	Left   int // reason, 0 while in

	hitUntil uint32
	ward     bool
	windUsed bool
	grazed   map[uint64]bool
}

// Enemy is one body in the room.
type Enemy struct {
	ID       uint32
	Spawn    Spawn
	X, Z     float64
	next     uint32
	n        uint32
	phase    int
	alive    bool
	maxPhase int
}

// Run is one party's walk through a chapter.
type Run struct {
	ID      uint32
	Chapter *Chapter
	Level   int
	Seed    uint32
	Stage   int
	Kind    int
	Layout  Layout
	State   int
	Started uint32 // the room's first tick
	Now     uint32
	Begun   uint32 // the run's first tick
	Members []*Member
	Enemies []*Enemy
	Volleys []*Volley
	Reason  int // why it ended

	seekers     map[uint32][]Seeker
	seekTarget  map[uint32]uint32
	nextVolley  uint32
	showerEnd   uint32
	showerNext  uint32
	perksBy     uint32
	slow        float64
	clearedTick uint32
}

// NewRun starts a run of chapter c at level for the players, from stage
// (1 normally; the dev console may start deeper).
func NewRun(id uint32, c *Chapter, level int, seed uint32, members []*Member, stage int, now uint32, h Host) *Run {
	r := &Run{ID: id, Chapter: c, Level: max(level, c.MinLevel), Seed: seed, Members: members, Begun: now, seekers: map[uint32][]Seeker{}, seekTarget: map[uint32]uint32{}}
	for _, m := range members {
		if m.Perks == nil {
			m.Perks = map[string]int{}
		}
		m.Mods = ModsOf(m.Perks)
		m.grazed = map[uint64]bool{}
	}
	r.startStage(max(1, min(Stages, stage)), now, h)
	return r
}

// Depth is the run's current ramp (0..1).
func (r *Run) Depth() float64 { return Depth(r.Chapter.N, r.Stage) }

// Active is the members still in the run.
func (r *Run) Active() []*Member {
	var out []*Member
	for _, m := range r.Members {
		if m.Left == 0 {
			out = append(out, m)
		}
	}
	return out
}

// Member finds a member by entity id.
func (r *Run) Member(id uint32) *Member {
	for _, m := range r.Members {
		if m.ID == id {
			return m
		}
	}
	return nil
}

func (r *Run) startStage(s int, now uint32, h Host) {
	for _, e := range r.Enemies {
		h.Remove(e.ID)
	}
	r.Enemies, r.Volleys = nil, nil
	clear(r.seekers)
	clear(r.seekTarget)
	r.Stage, r.Started, r.State = s, now, StateIntro
	r.Kind = StageKind(r.Seed, s)
	r.Layout = StageLayout(r.Chapter.N, s)
	n := len(r.Active())
	d := r.Depth()
	for _, m := range r.Active() {
		m.ward = m.Mods.Ward
		m.Offer, m.Picked = nil, false
		m.hitUntil = now + uint32(IntroS*TickHz)
		clear(m.grazed)
	}
	h.Out(r, Out{Kind: OutStage, N: s, Value: r.Kind})
	for i, sp := range Composition(r.Chapter.N, s, r.Seed, &r.Layout) {
		hp := EnemyHP(sp.Arch, r.Level, n, d, sp.Boss)
		id := h.Spawn(r, sp, hp)
		e := &Enemy{ID: id, Spawn: sp, X: sp.X, Z: sp.Z, alive: true}
		// staggered first volleys, so a room never opens with every gun at once
		e.next = now + uint32((IntroS+0.45*float64(i))*TickHz)
		r.Enemies = append(r.Enemies, e)
	}
	if r.Kind == StageGemShower {
		r.showerEnd = now + uint32((IntroS+16)*TickHz)
		r.showerNext = now + uint32(IntroS*TickHz)
	}
}

// Tick runs the room for one zone tick.
func (r *Run) Tick(now uint32, h Host) {
	r.Now = now
	if r.State == StateEnded {
		return
	}
	act := r.Active()
	if len(act) == 0 {
		r.end(LeftDied, h)
		return
	}
	r.slow = 0
	for _, m := range act {
		r.slow = math.Max(r.slow, m.Mods.BulletSlow)
	}
	t := float64(now-r.Started) / TickHz
	if r.State == StateIntro && t >= IntroS {
		r.State = StateFight
	}
	if r.State == StateFight || r.State == StateIntro {
		r.enemies(now, t, h)
		if r.State == StateFight {
			r.shower(now, h)
		}
	}
	r.hits(now, t, h)
	switch r.State {
	case StateFight:
		if r.roomClear(now) {
			r.clear(now, h)
		}
	case StatePerks:
		all := true
		for _, m := range r.Active() {
			if !m.Picked {
				all = false
			}
		}
		if all || now >= r.perksBy {
			for _, m := range r.Active() {
				if !m.Picked && len(m.Offer) > 0 {
					r.take(m, m.Offer[0], h) // the first card, when the clock runs out
				}
			}
			r.openDoor(h)
		}
	case StateDoor:
		r.door(now, h)
	}
}

func (r *Run) roomClear(now uint32) bool {
	if r.Kind == StageGemShower {
		return now >= r.showerEnd
	}
	for _, e := range r.Enemies {
		if e.alive {
			return false
		}
	}
	return true
}

// nearest is the nearest member in the room to (x, z).
func (r *Run) nearest(x, z float64) *Member {
	var best *Member
	bd := math.Inf(1)
	for _, m := range r.Members {
		if m.Left != 0 || !m.In {
			continue
		}
		if d := math.Hypot(m.X-x, m.Z-z); d < bd {
			best, bd = m, d
		}
	}
	return best
}

func (r *Run) enemies(now uint32, t float64, h Host) {
	d := r.Depth()
	for i, e := range r.Enemies {
		if !e.alive {
			continue
		}
		frac := h.EnemyHP(e.ID)
		if frac <= 0 {
			e.alive = false
			if g := e.Spawn.Arch.GemDrop; g > 0 {
				for _, m := range r.Active() {
					h.Out(r, Out{Kind: OutGems, Member: m.ID, N: g + m.Mods.Gems, X: e.X, Z: e.Z})
				}
			}
			continue
		}
		if a := e.Spawn.Arch; a.Sway > 0 && e.Spawn.Boss == 0 {
			x := e.Spawn.X + a.Sway*math.Sin(t*0.55+float64(i)*1.7)
			x = clamp(x, -HalfX+1.2, HalfX-1.2)
			if math.Abs(x-e.X) > 0.01 {
				e.X = x
				h.MoveEnemy(r, e.ID, e.X, e.Z)
			}
		}
		if e.Spawn.Boss > 0 {
			if p := BossPhase(frac); p > e.phase {
				e.phase = p
				h.Out(r, Out{Kind: OutPhase, N: p, Enemy: e.ID})
				e.next = min(e.next, now+uint32(0.9*TickHz))
			}
		}
		if r.State != StateFight || e.Spawn.Arch.Kind == 0 || now < e.next {
			continue
		}
		kind := e.Spawn.Arch.Kind
		every := e.Spawn.Arch.Every
		if e.Spawn.Boss > 0 {
			ks := BossKinds(e.Spawn.Arch, r.Chapter, e.Spawn.Boss, e.phase)
			kind = ks[int(e.n)%len(ks)]
			every = 2.3 - 0.35*float64(e.phase)
		}
		tgt := r.nearest(e.X, e.Z)
		if tgt == nil {
			continue
		}
		v := Design(kind, e.X, e.Z, Aim{tgt.X, tgt.Z}, r.Chapter, r.Stage, d, now, e.n, r.Seed^e.ID, e.Spawn.Boss, e.phase)
		if kind == KindSeeker {
			v.Seed = tgt.ID
		}
		r.launch(&v, e.ID, h)
		e.n++
		gap := Cadence(every, d) + 0.35*Unit(Hash(r.Seed, e.ID, e.n))
		e.next = now + uint32(math.Round(gap*TickHz))
	}
}

// launch slows a volley by the party's Lull, numbers it and sends it.
func (r *Run) launch(v *Volley, src uint32, h Host) {
	if r.slow > 0 {
		v.Speed *= 1 - r.slow
		v.Quantize()
	}
	r.nextVolley++
	v.ID = r.nextVolley
	if v.Kind == KindSeeker {
		r.seekers[v.ID] = v.Seekers()
		r.seekTarget[v.ID] = v.Seed
	}
	r.Volleys = append(r.Volleys, v)
	h.Out(r, Out{Kind: OutVolley, V: v, Enemy: src})
}

// shower: a gem shower stage rains impacts and gems for its length.
func (r *Run) shower(now uint32, h Host) {
	if r.Kind != StageGemShower || now >= r.showerEnd || now < r.showerNext {
		return
	}
	k := uint32(now-r.Started) / 30
	v := Design(KindRain, 0, 0, Aim{}, r.Chapter, r.Stage, r.Depth(), now, k, r.Seed^k, 0, 0)
	r.launch(&v, 0, h)
	hh := Hash(r.Seed, k, 0x9e5)
	gx, gz := (Unit(hh)*2-1)*(HalfX-1.5), (Unit(Mix(hh))*2-1)*(HalfZ-2)
	for _, m := range r.Active() {
		h.Out(r, Out{Kind: OutGems, Member: m.ID, N: 1, X: gx, Z: gz})
	}
	r.showerNext = now + uint32(1.4*TickHz)
}

// hits checks every live shot against every player in the room.
func (r *Run) hits(now uint32, t float64, h Host) {
	keep := r.Volleys[:0]
	for _, v := range r.Volleys {
		vt := (float64(now) - float64(v.Fire)) / TickHz
		if vt > v.Ends()+0.1 {
			delete(r.seekers, v.ID)
			delete(r.seekTarget, v.ID)
			continue
		}
		keep = append(keep, v)
		if vt < 0 {
			continue
		}
		if v.Kind == KindSeeker {
			if tm := r.Member(r.seekTarget[v.ID]); tm != nil && tm.Left == 0 && tm.In {
				ss := r.seekers[v.ID]
				for i := range ss {
					v.SeekerStep(&ss[i], tm.X, tm.Z, &r.Layout)
				}
			} else {
				ss := r.seekers[v.ID]
				for i := range ss {
					v.SeekerStep(&ss[i], ss[i].X+math.Cos(ss[i].A), ss[i].Z+math.Sin(ss[i].A), &r.Layout)
				}
			}
		}
		for _, m := range r.Members {
			if m.Left != 0 || !m.In {
				continue
			}
			hitR := HitR * m.Mods.HitScale
			hit, close := r.touches(v, vt, m, hitR)
			if !hit {
				if close && m.Mods.Graze {
					key := uint64(v.ID)<<32 | uint64(m.ID)
					if !m.grazed[key] {
						m.grazed[key] = true
						h.Out(r, Out{Kind: OutGraze, Member: m.ID})
					}
				}
				continue
			}
			r.hit(m, v.Kind, Damage(v.Kind, r.Level, r.Depth(), r.bossSrc()), now, h)
			if r.State == StateEnded {
				return // the last player fell: the room is gone
			}
		}
	}
	clear(r.Volleys[len(keep):])
	r.Volleys = keep
	if r.State == StateFight {
		for _, o := range r.Layout.Obstacles {
			if o.Kind != Spikes {
				continue
			}
			if up, _ := SpikesUp(o, t); !up {
				continue
			}
			for _, m := range r.Members {
				if m.Left == 0 && m.In && OnSpikes(o, m.X, m.Z) {
					r.hit(m, 0, Damage(0, r.Level, r.Depth(), 0), now, h)
					if r.State == StateEnded {
						return
					}
				}
			}
		}
	}
}

func (r *Run) bossSrc() int {
	for _, e := range r.Enemies {
		if e.alive && e.Spawn.Boss > 0 {
			return e.Spawn.Boss
		}
	}
	return 0
}

// touches: whether volley v hits member m at vt seconds after it fired, and
// whether a shot passed close (a graze).
func (r *Run) touches(v *Volley, vt float64, m *Member, hitR float64) (hit, close bool) {
	l := &r.Layout
	switch v.Kind {
	case KindLaser:
		a, length, live := v.LaserAt(vt, l)
		if !live {
			return false, false
		}
		dx, dz := m.X-v.OX, m.Z-v.OZ
		along := dx*math.Cos(a) + dz*math.Sin(a)
		side := math.Abs(-dx*math.Sin(a) + dz*math.Cos(a))
		w := float64(v.P1) / 200
		if along < 0 || along > length {
			return false, false
		}
		return side < w+hitR, side < w+hitR+0.6
	case KindRain:
		for i := 0; i < v.Count; i++ {
			x, z, rr, land := v.RainAt(i)
			if vt >= land && vt <= land+0.25 && math.Hypot(m.X-x, m.Z-z) < rr+hitR {
				return true, true
			}
		}
		return false, false
	case KindSeeker:
		for _, s := range r.seekers[v.ID] {
			if !s.Dead {
				d := math.Hypot(m.X-s.X, m.Z-s.Z)
				if d < v.Radius+hitR {
					return true, true
				}
				close = close || d < v.Radius+hitR+0.5
			}
		}
		return false, close
	}
	for i := 0; i < v.Bullets(); i++ {
		x, z, ok := v.Pos(i, vt, l)
		if !ok {
			continue
		}
		d := math.Hypot(m.X-x, m.Z-z)
		if d < v.Radius+hitR {
			return true, true
		}
		close = close || d < v.Radius+hitR+0.5
	}
	return false, close
}

// hit applies one shot (or the spikes) to m, unless a dodge, the grace
// after the last hit or a ward says no.
func (r *Run) hit(m *Member, kind int, dmg float64, now uint32, h Host) {
	if m.Dodging || now < m.hitUntil {
		return
	}
	m.hitUntil = now + uint32(math.Round(m.Mods.GraceS*TickHz))
	if m.ward {
		m.ward = false
		h.Out(r, Out{Kind: OutWard, Member: m.ID})
		return
	}
	hp, mx := h.HP(m)
	if m.Mods.SecondWind && !m.windUsed && dmg >= hp {
		m.windUsed = true
		dmg = math.Max(0, hp-0.4*mx)
		if dmg <= 0 {
			h.Heal(m, 0.4*mx-hp)
		}
	}
	h.Out(r, Out{Kind: OutHit, Member: m.ID, N: int(dmg), Value: kind})
	if dmg > 0 && h.Hurt(r, m, 0, dmg, kind) {
		r.Leave(m.ID, LeftDied, h)
	}
}

// clear: the room is clear: rewards, then perks or the door.
func (r *Run) clear(now uint32, h Host) {
	r.clearedTick = now
	r.Volleys = nil
	h.Out(r, Out{Kind: OutClear, N: r.Stage})
	loot := Loot(r.Chapter.N, r.Stage, r.Kind, r.Level)
	for _, m := range r.Active() {
		m.Best = max(m.Best, r.Stage)
		m.Spoils += loot.Gold
		lo := loot
		lo.Luck *= 1 + m.Mods.Luck
		if lo.Gems > 0 {
			lo.Gems += m.Mods.Gems
		}
		h.Out(r, Out{Kind: OutReward, Member: m.ID, Loot: lo, X: 0, Z: DoorZ + 3})
		if m.Mods.HealOnClear > 0 {
			_, mx := h.HP(m)
			h.Heal(m, m.Mods.HealOnClear*mx)
		}
		if Checkpoint(r.Stage) {
			m.Banked += m.Spoils
			h.Out(r, Out{Kind: OutBank, Member: m.ID, N: m.Spoils})
			m.Spoils = 0
		}
	}
	if PerkAfter(r.Stage) {
		r.State = StatePerks
		r.perksBy = now + uint32(25*TickHz)
		for i, m := range r.Active() {
			m.Offer = Offer(r.Seed, r.Stage, i, m.Perks)
			m.Picked = len(m.Offer) == 0
			if !m.Picked {
				h.Out(r, Out{Kind: OutPerkOffer, Member: m.ID, Perks: m.Offer, N: 25})
			}
		}
		return
	}
	r.openDoor(h)
}

func (r *Run) openDoor(h Host) {
	r.State = StateDoor
	way := 0
	if Checkpoint(r.Stage) {
		way = 1
	}
	h.Out(r, Out{Kind: OutDoor, N: way})
}

// ExitX is where the way out stands at a checkpoint (beside the door).
const ExitX = -4.5

// door: a member at the door takes everyone to the next room; at a
// checkpoint, a member on the way out leaves with everything.
func (r *Run) door(now uint32, h Host) {
	for _, m := range r.Active() {
		if !m.In {
			continue
		}
		if Checkpoint(r.Stage) && math.Hypot(m.X-ExitX, m.Z-DoorZ) < DoorReach {
			reason := LeftExit
			if r.Stage == Stages {
				reason = LeftVictory
			}
			r.Leave(m.ID, reason, h)
			continue
		}
		if r.Stage < Stages && math.Hypot(m.X, m.Z-DoorZ) < DoorReach {
			r.startStage(r.Stage+1, now, h)
			return
		}
	}
	if len(r.Active()) == 0 {
		r.end(r.Reason, h)
	}
}

// Pick is a member choosing perk index p (Interact); false when it is not
// one of their cards.
func (r *Run) Pick(id uint32, p int, h Host) bool {
	m := r.Member(id)
	if m == nil || m.Left != 0 || r.State != StatePerks || m.Picked {
		return false
	}
	for _, o := range m.Offer {
		if o == p {
			r.take(m, p, h)
			return true
		}
	}
	return false
}

func (r *Run) take(m *Member, p int, h Host) {
	pk := Perks[p]
	m.Perks[pk.Key]++
	before := m.Mods
	m.Mods = ModsOf(m.Perks)
	m.Picked = true
	if pk.Key == "ward_shard" {
		m.ward = true
	}
	if pk.Key == "deep_breath" {
		_, mx := h.HP(m)
		h.Heal(m, 0.25*mx*m.Mods.HealthMult/before.HealthMult)
	}
	h.Out(r, Out{Kind: OutPerkTaken, Member: m.ID, Perk: p})
}

// Leave takes a member out (died, walked out, disconnected).
func (r *Run) Leave(id uint32, reason int, h Host) {
	m := r.Member(id)
	if m == nil || m.Left != 0 {
		return
	}
	m.Left = reason
	if reason == LeftExit || reason == LeftVictory || reason == LeftDev {
		m.Banked += m.Spoils
		if m.Spoils > 0 {
			h.Out(r, Out{Kind: OutBank, Member: m.ID, N: m.Spoils})
		}
	}
	m.Spoils = 0
	r.Reason = reason
	h.Out(r, Out{Kind: OutLeft, Member: m.ID, Reason: reason, N: m.Best})
	if len(r.Active()) == 0 {
		r.end(reason, h)
	}
}

func (r *Run) end(reason int, h Host) {
	if r.State == StateEnded {
		return
	}
	r.State, r.Reason = StateEnded, reason
	for _, e := range r.Enemies {
		h.Remove(e.ID)
	}
	r.Enemies, r.Volleys = nil, nil
	h.Out(r, Out{Kind: OutEnd, Reason: reason, N: r.Stage})
}

// Win clears the room at once (dev console /rift win).
func (r *Run) Win(now uint32, h Host) {
	if r.State != StateFight && r.State != StateIntro {
		return
	}
	for _, e := range r.Enemies {
		if e.alive {
			e.alive = false
			h.Remove(e.ID)
		}
	}
	r.showerEnd = now
	r.clear(now, h)
}

// Goto jumps to stage s (dev console /rift go).
func (r *Run) Goto(s int, now uint32, h Host) {
	r.startStage(max(1, min(Stages, s)), now, h)
}

// Seekers is a seeker volley's live orbs (the host's evidence and tests).
func (r *Run) Seekers(id uint32) []Seeker { return r.seekers[id] }
