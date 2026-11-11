package rift

import (
	"encoding/json"
	"flag"
	"math"
	"os"
	"path/filepath"
	"testing"
)

// fakeHost is a run's zone stand-in: enemies are health numbers, players
// have health, every Out is recorded.
type fakeHost struct {
	next   uint32
	hp     map[uint32]float64
	max    map[uint32]float64
	php    map[uint32]float64
	outs   []Out
	spawns []Spawn
	hpSet  []float64
}

func newFake() *fakeHost {
	return &fakeHost{next: 1000, hp: map[uint32]float64{}, max: map[uint32]float64{}, php: map[uint32]float64{}}
}

func (f *fakeHost) Spawn(r *Run, sp Spawn, hp float64) uint32 {
	f.next++
	f.hp[f.next], f.max[f.next] = hp, hp
	f.spawns = append(f.spawns, sp)
	f.hpSet = append(f.hpSet, hp)
	return f.next
}
func (f *fakeHost) EnemyHP(id uint32) float64 {
	if f.max[id] == 0 {
		return 0
	}
	return f.hp[id] / f.max[id]
}
func (f *fakeHost) MoveEnemy(r *Run, id uint32, x, z float64) {}
func (f *fakeHost) Remove(id uint32)                          { f.hp[id] = 0 }
func (f *fakeHost) HP(m *Member) (float64, float64) {
	if _, ok := f.php[m.ID]; !ok {
		f.php[m.ID] = 200
	}
	return f.php[m.ID], 200
}
func (f *fakeHost) Hurt(r *Run, m *Member, src uint32, dmg float64, kind int) bool {
	f.HP(m)
	f.php[m.ID] -= dmg
	return f.php[m.ID] <= 0
}
func (f *fakeHost) Heal(m *Member, a float64) { f.HP(m); f.php[m.ID] = math.Min(200, f.php[m.ID]+a) }
func (f *fakeHost) Out(r *Run, o Out)         { f.outs = append(f.outs, o) }

func (f *fakeHost) count(kind int) int {
	n := 0
	for _, o := range f.outs {
		if o.Kind == kind {
			n++
		}
	}
	return n
}

func (f *fakeHost) killAll(r *Run) {
	for _, e := range r.Enemies {
		f.hp[e.ID] = 0
	}
}

func member(id uint32) *Member { return &Member{ID: id, Char: "c", Name: "p", X: 0, Z: StartZ, In: true} }

// safe parks a member in the far corner and lets them dodge everything.
func safe(m *Member) { m.X, m.Z, m.Dodging = HalfX-0.5, HalfZ-0.5, true }

func TestPortalScheduleIsDeterministic(t *testing.T) {
	w := Window(1_800_000_000)
	weight := func(x, z float64) float64 {
		if math.Hypot(x-2048, z-2048) < 420 {
			return 0 // the Haven
		}
		return TierWeight(1 + int(x/1024))
	}
	a := Candidates(42, w, 4096, weight)
	b := Candidates(42, w, 4096, weight)
	if len(a) == 0 || len(a) != len(b) {
		t.Fatalf("candidates %d / %d", len(a), len(b))
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("draw %d differs: %+v %+v", i, a[i], b[i])
		}
	}
	ok := func(c *Candidate) bool { return true }
	pa, pb := Pick(a, ok), Pick(b, ok)
	if len(pa) != ActivePortals || pa[0] != pb[0] || pa[3] != pb[3] {
		t.Fatalf("picks %+v", pa)
	}
	for i := range pa {
		for j := i + 1; j < len(pa); j++ {
			if math.Hypot(pa[i].X-pa[j].X, pa[i].Z-pa[j].Z) < PortalSepM {
				t.Fatal("two rifts too close")
			}
		}
		if math.Hypot(pa[i].X-2048, pa[i].Z-2048) < 420-AreaM {
			t.Fatal("a rift in the Haven")
		}
	}
	// Another window, another set; another world seed, another set.
	c := Pick(Candidates(42, w+1, 4096, weight), ok)
	d := Pick(Candidates(43, w, 4096, weight), ok)
	if c[0] == pa[0] && c[1] == pa[1] || d[0] == pa[0] && d[1] == pa[1] {
		t.Fatal("rifts did not move")
	}
	// Harder areas open rifts more often (over many windows).
	east, west := 0, 0
	for k := int64(0); k < 400; k++ {
		for _, p := range Pick(Candidates(7, k, 4096, weight), ok) {
			if p.X > 3072 {
				east++
			} else if p.X < 1024 {
				west++
			}
		}
	}
	if east <= west {
		t.Fatalf("tier weighting: east %d west %d", east, west)
	}
	if WindowEnds(w)-1_800_000_000 > WindowS || WindowEnds(w) <= 1_800_000_000 {
		t.Fatal("window end")
	}
	if ChapterFor(1) != 1 || ChapterFor(9) != 3 || ChapterFor(25) != 5 {
		t.Fatal("chapter by area level")
	}
}

func TestLayoutsAreFairAndDeterministic(t *testing.T) {
	for c := 1; c <= len(Chapters); c++ {
		for s := 1; s <= Stages; s++ {
			a, b := StageLayout(c, s), StageLayout(c, s)
			if len(a.Obstacles) != len(b.Obstacles) || len(a.Slots) < 3 {
				t.Fatalf("ch %d stage %d: %d slots", c, s, len(a.Slots))
			}
			// the entrance and the door are never blocked
			for _, p := range [][2]float64{{0, StartZ}, {0, DoorZ}, {ExitX, DoorZ}} {
				if x, z := a.Collide(p[0], p[1]); math.Hypot(x-p[0], z-p[1]) > 0.5 {
					t.Fatalf("ch %d stage %d: (%v, %v) is blocked", c, s, p[0], p[1])
				}
			}
			if s%10 == 0 && len(a.Obstacles) != 0 {
				t.Fatalf("boss room %d not open", s)
			}
		}
	}
	l := StageLayout(1, 2)
	// a body walked into a pillar ends on its edge, and inside the walls
	for _, o := range l.Obstacles {
		if o.Solid() {
			x, z := l.Collide(o.X+0.1, o.Z)
			if d := math.Hypot(x-o.X, z-o.Z); d < o.R+PlayerR-1e-9 {
				t.Fatalf("still inside: %v", d)
			}
		}
	}
	if x, z := l.Collide(50, -50); x != HalfX-PlayerR || z != -HalfZ+PlayerR {
		t.Fatalf("walls: %v %v", x, z)
	}
}

func TestPatternsAreDeterministicAndReadable(t *testing.T) {
	l := StageLayout(1, 7)
	ch := ChapterByN(1)
	for kind := KindRing; kind <= KindRain; kind++ {
		for _, d := range []float64{0, 0.5, 1} {
			v := Design(kind, 1, -8, Aim{0, 10}, ch, 7, d, 300, 2, 99, 0, 0)
			w := Design(kind, 1, -8, Aim{0, 10}, ch, 7, d, 300, 2, 99, 0, 0)
			if v.Fire != w.Fire || v.Angle != w.Angle || v.Count != w.Count {
				t.Fatalf("kind %d not deterministic", kind)
			}
			// telegraphed, slow, small
			if v.Windup < 450 || (kind == KindLaser && v.Windup < 800) {
				t.Fatalf("kind %d wind-up %d ms", kind, v.Windup)
			}
			if v.Speed > 8.5 || v.Radius > 0.5 {
				t.Fatalf("kind %d speed %v radius %v", kind, v.Speed, v.Radius)
			}
			for i := 0; i < v.Bullets(); i++ {
				for _, tt := range []float64{0, 0.4, 1.3, 3} {
					x1, z1, a1 := v.Pos(i, tt, &l)
					x2, z2, a2 := w.Pos(i, tt, &l)
					if x1 != x2 || z1 != z2 || a1 != a2 {
						t.Fatalf("kind %d bullet %d differs", kind, i)
					}
					if a1 && (math.Abs(x1) > HalfX+1 || math.Abs(z1) > HalfZ+1) {
						t.Fatalf("kind %d bullet %d outside the room", kind, i)
					}
				}
			}
		}
	}
	// A ring at depth 1 still leaves a gap a body fits through 4 m out.
	ring := Design(KindRing, 0, 0, Aim{0, 5}, ch, 40, 1, 0, 0, 1, 0, 0)
	gap := 2*math.Pi*4/float64(ring.Count) - 2*ring.Radius
	if gap < 2*HitR+0.4 {
		t.Fatalf("ring gap %v m", gap)
	}
	// A wall has its gap.
	wall := Design(KindWall, 0, -10, Aim{}, ch, 20, 0.5, 0, 0, 3, 0, 0)
	if _, _, ok := wall.Pos(wall.P2, 0.5, &l); ok {
		t.Fatal("the wall's gap is filled")
	}
	// Bouncing orbs stay in the room and die on their budget.
	b := Design(KindBounce, 0, 0, Aim{5, 5}, ch, 15, 0.3, 0, 0, 5, 0, 0)
	open := StageLayout(1, 10)
	for tt := 0.0; tt < b.Life; tt += 0.05 {
		for i := 0; i < b.Count; i++ {
			if x, z, ok := b.Pos(i, tt, &open); ok && (math.Abs(x) > HalfX || math.Abs(z) > HalfZ) {
				t.Fatalf("orb left the room at %v", tt)
			}
		}
	}
	// Straight shots stop on pillars.
	pl := Layout{Obstacles: []Obstacle{{Kind: Pillar, X: 5, Z: 0, R: 1}}}
	shot := Volley{Kind: KindRing, Count: 1, Speed: 4, Radius: 0.3, Life: 9}
	if _, _, ok := shot.Pos(0, 0.5, &pl); !ok {
		t.Fatal("shot dead before the pillar")
	}
	if _, _, ok := shot.Pos(0, 1.2, &pl); ok {
		t.Fatal("shot went through the pillar")
	}
}

// Hitboxes: the core hits, the glow does not; a dodge, the grace after a
// hit and a ward say no.
func TestHitboxesAreFair(t *testing.T) {
	h := newFake()
	m := member(1)
	r := NewRun(1, ChapterByN(1), 5, 7, []*Member{m}, 1, 0, h)
	r.State = StateFight
	for _, e := range r.Enemies {
		h.Remove(e.ID)
		e.alive = false
	}
	r.Enemies = nil
	v := &Volley{ID: 9, Kind: KindRing, Count: 1, Speed: 0, Radius: 0.3, Life: 50, OX: 0, OZ: 0, Fire: 0}
	r.Volleys = []*Volley{v}
	m.hitUntil = 0
	m.X, m.Z = v.Radius+HitR+0.05, 0 // just outside the core
	r.hits(30, 1, h)
	if h.count(OutHit) != 0 {
		t.Fatal("hit by the glow")
	}
	m.X = v.Radius + HitR - 0.05
	m.Dodging = true
	r.hits(31, 1, h)
	if h.count(OutHit) != 0 {
		t.Fatal("hit through a dodge")
	}
	m.Dodging = false
	r.hits(32, 1, h)
	if h.count(OutHit) != 1 {
		t.Fatal("not hit by the core")
	}
	r.hits(33, 1, h)
	if h.count(OutHit) != 1 {
		t.Fatal("hit twice inside the grace")
	}
	r.hits(32+uint32(HitGraceS*TickHz)+1, 1, h)
	if h.count(OutHit) != 2 {
		t.Fatal("not hit after the grace")
	}
	// damage grows with level and depth, bosses hit harder
	if Damage(KindRing, 10, 0, 0) <= Damage(KindRing, 1, 0, 0) || Damage(KindRing, 10, 1, 0) <= Damage(KindRing, 10, 0, 0) || Damage(KindRing, 10, 0, 1) <= Damage(KindRing, 10, 0, 0) {
		t.Fatal("damage scaling")
	}
	// a ward eats the first shot of a room
	m.Perks["ward_shard"] = 1
	m.Mods = ModsOf(m.Perks)
	m.ward = true
	r.hits(200, 1, h)
	if h.count(OutWard) != 1 || h.count(OutHit) != 2 {
		t.Fatal("ward")
	}
	// slip frame shrinks the hit circle
	m.Perks["slip_frame"] = 1
	m.Mods = ModsOf(m.Perks)
	m.X = v.Radius + HitR*0.8
	r.hits(300, 1, h)
	if h.count(OutHit) != 2 {
		t.Fatal("slip frame")
	}
}

// A solo run: rooms clear, the door opens, a perk is offered at 2, spoils
// bank at 10, and walking out at the checkpoint keeps them.
func TestRunLifecycleAndStages(t *testing.T) {
	h := newFake()
	m := member(1)
	r := NewRun(1, ChapterByN(1), 3, 11, []*Member{m}, 1, 0, h)
	safe(m)
	now := uint32(0)
	step := func(n int) {
		for i := 0; i < n; i++ {
			now++
			r.Tick(now, h)
		}
	}
	step(int(IntroS*TickHz) + 60)
	if r.State != StateFight || h.count(OutVolley) == 0 {
		t.Fatalf("state %d volleys %d", r.State, h.count(OutVolley))
	}
	h.killAll(r)
	step(1)
	if r.State != StateDoor || h.count(OutReward) != 1 || m.Spoils <= 0 {
		t.Fatalf("after clear: state %d rewards %d spoils %d", r.State, h.count(OutReward), m.Spoils)
	}
	m.X, m.Z, m.Dodging = 0, DoorZ, false
	step(1)
	if r.Stage != 2 || r.State != StateIntro {
		t.Fatalf("stage %d state %d", r.Stage, r.State)
	}
	safe(m)
	step(int(IntroS*TickHz) + 2)
	h.killAll(r)
	step(1)
	if r.State != StatePerks || h.count(OutPerkOffer) != 1 || len(m.Offer) != 3 {
		t.Fatalf("perks: state %d offers %d", r.State, h.count(OutPerkOffer))
	}
	if r.Pick(1, 999, h) || !r.Pick(1, m.Offer[1], h) {
		t.Fatal("pick")
	}
	step(1)
	if r.State != StateDoor || len(m.Perks) != 1 {
		t.Fatalf("after pick: state %d perks %v", r.State, m.Perks)
	}
	for s := 3; s <= 10; s++ {
		m.X, m.Z, m.Dodging = 0, DoorZ, false
		step(1)
		if r.Stage != s {
			t.Fatalf("stage %d, want %d", r.Stage, s)
		}
		safe(m)
		step(int(IntroS*TickHz) + 2)
		h.killAll(r)
		step(1)
		if r.State == StatePerks {
			r.Pick(1, m.Offer[0], h)
			step(1)
		}
	}
	if m.Banked <= 0 || m.Spoils != 0 || h.count(OutBank) != 1 || r.Kind != StageMiniBoss {
		t.Fatalf("checkpoint: banked %d spoils %d kind %d", m.Banked, m.Spoils, r.Kind)
	}
	if h.count(OutDoor) == 0 || h.outs[len(h.outs)-1].Kind != OutDoor || h.outs[len(h.outs)-1].N != 1 {
		t.Fatal("the way out did not open at the checkpoint")
	}
	m.X, m.Z, m.Dodging = ExitX, DoorZ, false
	step(1)
	if m.Left != LeftExit || r.State != StateEnded || m.Best != 10 {
		t.Fatalf("exit: left %d state %d best %d", m.Left, r.State, m.Best)
	}
}

// Dying loses the unbanked spoils; the run ends with the last player.
func TestDyingEndsTheRunKeepingTheBank(t *testing.T) {
	h := newFake()
	m := member(1)
	r := NewRun(1, ChapterByN(2), 6, 3, []*Member{m}, 11, 0, h)
	m.Banked, m.Spoils = 100, 50
	h.php[1] = 5
	r.State = StateFight
	r.Volleys = []*Volley{{ID: 1, Kind: KindRing, Count: 1, Speed: 0, Radius: 0.3, Life: 5}}
	m.X, m.Z, m.Dodging = 0, 0, false
	m.hitUntil = 0
	r.Tick(40, h)
	if m.Left != LeftDied || m.Spoils != 0 || m.Banked != 100 || r.State != StateEnded {
		t.Fatalf("died: left %d spoils %d banked %d state %d", m.Left, m.Spoils, m.Banked, r.State)
	}
	// Second Wind holds once.
	h2 := newFake()
	m2 := member(2)
	m2.Perks = map[string]int{"second_wind": 1}
	r2 := NewRun(2, ChapterByN(1), 3, 3, []*Member{m2}, 1, 0, h2)
	h2.php[2] = 5
	r2.hit(m2, KindRing, 50, 100, h2)
	if m2.Left != 0 || h2.php[2] != 80 {
		t.Fatalf("second wind: left %d hp %v", m2.Left, h2.php[2])
	}
	r2.hit(m2, KindRing, 500, 200, h2)
	if m2.Left != LeftDied {
		t.Fatal("second wind twice")
	}
}

// Party: health scales with the party, a disconnect leaves the others in,
// and the run ends with its last player.
func TestPartyScalingAndDisconnect(t *testing.T) {
	solo, duo, four := newFake(), newFake(), newFake()
	NewRun(1, ChapterByN(1), 5, 9, []*Member{member(1)}, 3, 0, solo)
	NewRun(2, ChapterByN(1), 5, 9, []*Member{member(1), member(2)}, 3, 0, duo)
	NewRun(3, ChapterByN(1), 5, 9, []*Member{member(1), member(2), member(3), member(4)}, 3, 0, four)
	if len(solo.hpSet) == 0 || len(solo.hpSet) != len(duo.hpSet) {
		t.Fatal("same room, same enemies")
	}
	for i := range solo.hpSet {
		if math.Abs(duo.hpSet[i]/solo.hpSet[i]-PartyScale(2)) > 0.01 || math.Abs(four.hpSet[i]/solo.hpSet[i]-PartyScale(4)) > 0.01 {
			t.Fatalf("party scaling %v %v %v", solo.hpSet[i], duo.hpSet[i], four.hpSet[i])
		}
	}
	h := newFake()
	a, b := member(1), member(2)
	r := NewRun(4, ChapterByN(1), 5, 9, []*Member{a, b}, 1, 0, h)
	a.Spoils, b.Spoils = 30, 30
	r.Leave(2, LeftDisconnect, h)
	if b.Left != LeftDisconnect || b.Spoils != 0 || r.State == StateEnded || len(r.Active()) != 1 {
		t.Fatal("disconnect")
	}
	safe(a)
	r.Tick(1, h)
	if r.State == StateEnded {
		t.Fatal("ended with a player in")
	}
	r.Leave(1, LeftDied, h)
	if r.State != StateEnded || h.count(OutEnd) != 1 {
		t.Fatal("not ended")
	}
}

func TestLootGetsBetterWithDepth(t *testing.T) {
	prev := Loot(1, 1, StageFight, 5)
	for s := 2; s <= 49; s++ {
		o := Loot(1, s, StageFight, 5)
		if o.Luck < prev.Luck || o.Chance < prev.Chance || o.MinRarity < prev.MinRarity || o.Gold < prev.Gold {
			t.Fatalf("stage %d worse than %d: %+v %+v", s, s-1, o, prev)
		}
		prev = o
	}
	if Loot(1, 40, StageFight, 5).MinRarity < 2 || Loot(1, 20, StageMiniBoss, 5).Items < 2 || Loot(1, 50, StageBoss, 5).MinRarity < 4 {
		t.Fatal("chests")
	}
	if Loot(3, 10, StageFight, 5).Luck <= Loot(1, 10, StageFight, 5).Luck {
		t.Fatal("later chapters are luckier")
	}
}

// Gem events: one in every ten stages; a vault's geodes pay gems, a shower
// rains them, the golem's heart pays gems and an item.
func TestGemEvents(t *testing.T) {
	seen := map[int]bool{}
	for seed := uint32(0); seed < 6; seed++ {
		for b := 0; b < 5; b++ {
			n := 0
			for s := b*10 + 1; s <= b*10+10; s++ {
				k := StageKind(seed, s)
				if k >= StageGemVault {
					n++
					seen[k] = true
				}
			}
			if n == 0 {
				t.Fatalf("seed %d stages %d-%d: no gem event", seed, b*10+1, b*10+10)
			}
		}
	}
	if !seen[StageGemVault] || !seen[StageGemShower] || !seen[StageGemGolem] {
		t.Fatalf("gem events seen %v", seen)
	}
	if Loot(1, 16, StageGemGolem, 5).Gems < 6 || Loot(1, 16, StageGemGolem, 5).Items != 1 || Loot(1, 6, StageGemShower, 5).Gems < 2 {
		t.Fatal("gem rewards")
	}
	// a vault: breaking a geode pays every player
	var seed uint32
	for seed = 0; StageKind(seed, 6) != StageGemVault; seed++ {
	}
	h := newFake()
	m := member(1)
	m.Perks = map[string]int{"gem_sense": 1}
	r := NewRun(1, ChapterByN(1), 3, seed, []*Member{m}, 6, 0, h)
	safe(m)
	geodes := 0
	for _, e := range r.Enemies {
		if e.Spawn.Arch.GemDrop > 0 {
			geodes++
			h.hp[e.ID] = 0
		}
	}
	r.Tick(100, h)
	if geodes < 4 || h.count(OutGems) != geodes || h.outs[len(h.outs)-1].N < 3 {
		t.Fatalf("geodes %d gem outs %d", geodes, h.count(OutGems))
	}
	// a shower rains gems until it ends, then the room is clear
	for seed = 0; StageKind(seed, 6) != StageGemShower; seed++ {
	}
	h = newFake()
	m = member(1)
	r = NewRun(2, ChapterByN(1), 3, seed, []*Member{m}, 6, 0, h)
	safe(m)
	for now := uint32(1); now < uint32((IntroS+17)*TickHz); now++ {
		r.Tick(now, h)
	}
	if h.count(OutGems) < 8 || r.State != StateDoor && r.State != StatePerks {
		t.Fatalf("shower: gems %d state %d", h.count(OutGems), r.State)
	}
}

func TestBossPhasesAndRotation(t *testing.T) {
	h := newFake()
	m := member(1)
	r := NewRun(1, ChapterByN(4), 15, 2, []*Member{m}, 50, 0, h)
	safe(m)
	if r.Kind != StageBoss || len(r.Enemies) == 0 || r.Enemies[0].Spawn.Boss != 2 {
		t.Fatal("no chapter boss at 50")
	}
	boss := r.Enemies[0]
	kinds := map[int]bool{}
	for now := uint32(1); now < 30*30; now++ {
		if now == 300 {
			h.hp[boss.ID] = h.max[boss.ID] * 0.5
		}
		if now == 600 {
			h.hp[boss.ID] = h.max[boss.ID] * 0.2
		}
		r.Tick(now, h)
	}
	for _, o := range h.outs {
		if o.Kind == OutVolley && o.Enemy == boss.ID {
			kinds[o.V.Kind] = true
		}
	}
	if h.count(OutPhase) != 2 || len(kinds) < 5 || !kinds[KindLaser] {
		t.Fatalf("phases %d kinds %v", h.count(OutPhase), kinds)
	}
}

// ---- the TS twin's golden vectors ----

var update = flag.Bool("update", false, "rewrite testdata/rift_golden.json")

type goldenBullet struct {
	I     int     `json:"i"`
	T     float64 `json:"t"`
	X     float64 `json:"x"`
	Z     float64 `json:"z"`
	Alive bool    `json:"alive"`
}

type goldenVolley struct {
	Chapter, Stage int
	V              map[string]any `json:"v"`
	Bullets        []goldenBullet `json:"bullets"`
	Laser          [][3]float64   `json:"laser,omitempty"`
	Rain           [][4]float64   `json:"rain,omitempty"`
	Seekers        [][3]float64   `json:"seekers,omitempty"`
}

type goldenLayout struct {
	Chapter, Stage int
	Template       int
	Obstacles      []Obstacle
	Slots          [][2]float64
	Collide        [][4]float64
	Spikes         [][3]float64
}

// TestGoldenForTheClient writes (with -update) or checks the vectors the
// client's patterns.ts / layout.ts replay (client/src/rift/rift.test.ts).
func TestGoldenForTheClient(t *testing.T) {
	type golden struct {
		Hashes  [][3]uint32    `json:"hashes"`
		Layouts []goldenLayout `json:"layouts"`
		Volleys []goldenVolley `json:"volleys"`
	}
	var g golden
	for i := uint32(0); i < 8; i++ {
		g.Hashes = append(g.Hashes, [3]uint32{i * 977, Hash(i*977, 3, 0xffffffff-i), Mix(i * 2654435761)})
	}
	for _, cs := range [][2]int{{1, 1}, {1, 7}, {2, 13}, {3, 22}, {4, 36}, {5, 49}, {5, 50}} {
		l := StageLayout(cs[0], cs[1])
		gl := goldenLayout{Chapter: cs[0], Stage: cs[1], Template: l.Template, Obstacles: l.Obstacles, Slots: l.Slots}
		for k := 0; k < 12; k++ {
			x, z := float64(k%4)*5.3-8, float64(k/4)*9.1-12.5
			cx, cz := l.Collide(x, z)
			gl.Collide = append(gl.Collide, [4]float64{x, z, cx, cz})
		}
		for _, o := range l.Obstacles {
			if o.Kind == Spikes {
				for _, tt := range []float64{0, 1.3, 2.5, 7.9} {
					up, warn := SpikesUp(o, tt)
					b := func(v bool) float64 {
						if v {
							return 1
						}
						return 0
					}
					gl.Spikes = append(gl.Spikes, [3]float64{tt, b(up), b(warn)})
				}
			}
		}
		g.Layouts = append(g.Layouts, gl)
	}
	l := StageLayout(2, 13)
	for kind := KindRing; kind <= KindRain; kind++ {
		v := Design(kind, 2.5, -9, Aim{-1, 8}, ChapterByN(2), 13, 0.6, 1000, uint32(kind), 1234, 0, 0)
		gv := goldenVolley{Chapter: 2, Stage: 13, V: map[string]any{"kind": v.Kind, "fire": v.Fire, "windup": v.Windup, "ox": v.OX, "oz": v.OZ, "angleU16": AngleU16(v.Angle), "count": v.Count, "speed": v.Speed, "radius": v.Radius, "p1": v.P1, "p2": v.P2, "p3": v.P3, "seed": v.Seed, "life": v.Life}}
		for i := 0; i < v.Bullets(); i++ {
			for _, tt := range []float64{0, 0.37, 1.1, 2.6, 5.9} {
				x, z, ok := v.Pos(i, tt, &l)
				gv.Bullets = append(gv.Bullets, goldenBullet{i, tt, x, z, ok})
			}
		}
		if kind == KindLaser {
			for _, tt := range []float64{-0.2, 0, 0.5, 1.0, 1.2} {
				a, ln, live := v.LaserAt(tt, &l)
				if !live {
					ln = -ln
				}
				gv.Laser = append(gv.Laser, [3]float64{tt, a, ln})
			}
		}
		if kind == KindRain {
			for i := 0; i < v.Count; i++ {
				x, z, rr, land := v.RainAt(i)
				gv.Rain = append(gv.Rain, [4]float64{x, z, rr, land})
			}
		}
		if kind == KindSeeker {
			ss := v.Seekers()
			for k := 0; k < 60; k++ {
				tx, tz := 3*math.Cos(float64(k)/20), 6+2*math.Sin(float64(k)/15)
				for i := range ss {
					v.SeekerStep(&ss[i], tx, tz, &l)
				}
				if k%10 == 9 {
					for _, s := range ss {
						d := 0.0
						if s.Dead {
							d = 1
						}
						gv.Seekers = append(gv.Seekers, [3]float64{s.X, s.Z, d})
					}
				}
			}
		}
		g.Volleys = append(g.Volleys, gv)
	}
	b, _ := json.MarshalIndent(g, "", " ")
	path := filepath.Join("testdata", "rift_golden.json")
	if *update {
		_ = os.MkdirAll("testdata", 0o755)
		if err := os.WriteFile(path, b, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	old, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run go test -run TestGoldenForTheClient -update)", err)
	}
	if string(old) != string(b) {
		t.Fatal("testdata/rift_golden.json is stale: go test ./internal/rift -run TestGoldenForTheClient -update, then the client's rift.test.ts")
	}
}
