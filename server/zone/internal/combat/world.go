package combat

import (
	"fmt"
	"math"
	"slices"
	"sort"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/structures"
)

// GroupKind is what spawned a group.
type GroupKind uint8

const (
	GroupCamp GroupKind = iota + 1 // atlas enemy camp POI
	GroupBandit
	GroupGuardian
	GroupPack // wild roaming pack on the seeded grid
	GroupBoss
	GroupTest // dev/test placement
)

func (k GroupKind) String() string {
	return [...]string{"?", "camp", "bandit", "guardian", "pack", "boss", "test"}[k]
}

// Group is a spawn anchor: a camp, a pack or a boss arena. Its members
// exist only while a player is near (ENEMY_SPAWN_M), so a 4 km world costs
// nothing where nobody stands; the composition is seeded, so a group always
// comes back the same way.
type Group struct {
	ID       int
	Kind     GroupKind
	Anchor   movement.Vec3
	Radius   float64
	Biome    int
	Element  int // region element (elementals, elites)
	Level    int
	Site     int    // atlas site index, -1 none
	Name     string // site name (camps at named places, boss arenas)
	Seed     uint64
	Boss     string // enemy key of the boss (GroupBoss)
	Members  []*Enemy
	Spawned  bool
	Awake    bool
	lastNear uint32 // tick a player was last within ENEMY_DESPAWN_M
	respawn  uint32 // tick it may spawn again (0 = now)
	spawns   int
	Arena    *Arena
	Comp     []string // explicit composition (tests), else from tables
	Elite    string   // forced elite affix (tests)
}

// KillInfo is what the WP14 loot hook receives on every kill: who may roll
// personal loot (spec 8: every eligible player rolls separately).
type KillInfo struct {
	Enemy    *Enemy
	Eligible []uint32 // player entity ids
	Tick     uint32
}

// XPGrant asks the host to add character XP (explore progress, WP12).
type XPGrant struct {
	Player uint32
	XP     int64
	Reason string
}

// Config tunes a World (tests shorten timers; production uses constants).
type Config struct {
	Seed           uint64
	EnemyDensity   float64 // spec 6 enemyDensity (0..1); packs per grid cell
	CampRespawnS   float64
	BossRespawnS   float64
	NoWildPacks    bool
	TestGroupsOnly bool
}

// World is all combat in one zone (tick-owned).
type World struct {
	cfg     Config
	ground  movement.Ground
	Atlas   *AtlasInfo
	Groups  []*Group
	groupAt map[[2]int][]*Group // 256 m cells
	enemies map[uint32]*Enemy
	order   []uint32 // enemy ids in spawn order (deterministic iteration)
	players map[uint32]*Player
	strikes []*strike
	shots   []*shot
	alloc   func() uint32
	tick    uint32
	rng     uint64

	// Outputs, drained by the host each tick.
	Events  []Out
	Spawned []*Enemy
	Removed []*Enemy
	XP      []XPGrant
	Respawn []uint32 // players to teleport to their respawn point
	Synced  []uint32 // players whose combat_sync must be re-sent
	// OnKill is the WP14 loot hook (personal loot per eligible player).
	OnKill func(KillInfo)

	// Stats for metrics and evidence.
	Stats Stats
}

// Stats are cumulative counters.
type Stats struct {
	ClaimsAccepted, ClaimsRefused, Kills, PlayerHits, Evaded, Downs int64
	RefusedBy                                                       [16]int64
}

const cellM = 256.0

// NewWorld builds a combat world on ground; alloc hands out entity ids.
func NewWorld(cfg Config, ground movement.Ground, alloc func() uint32) *World {
	if cfg.CampRespawnS <= 0 {
		cfg.CampRespawnS = constants.CampRespawnS
	}
	if cfg.BossRespawnS <= 0 {
		cfg.BossRespawnS = constants.BossRespawnS
	}
	return &World{cfg: cfg, ground: ground, groupAt: map[[2]int][]*Group{}, enemies: map[uint32]*Enemy{}, players: map[uint32]*Player{}, alloc: alloc, rng: cfg.Seed | 1}
}

// Ground is the movement ground enemies walk on.
func (w *World) Ground() movement.Ground { return w.ground }

// Tick is the current tick.
func (w *World) Tick() uint32 { return w.tick }

func secondsToTicks(s float64) uint32 { return uint32(math.Round(s * constants.TickRateHz)) }

// mix is SplitMix64 (deterministic group compositions).
func mix(x uint64) uint64 {
	x += 0x9e3779b97f4a7c15
	x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9
	x = (x ^ (x >> 27)) * 0x94d049bb133111eb
	return x ^ (x >> 31)
}

func unit(h uint64) float64 { return float64(h>>11) / float64(1<<53) }

// AddGroup registers a group (atlas build, tests, dev placement).
func (w *World) AddGroup(g *Group) *Group {
	g.ID = len(w.Groups) + 1
	if g.Seed == 0 {
		g.Seed = mix(w.cfg.Seed ^ uint64(g.ID)*0x9e37)
	}
	if g.Radius == 0 {
		g.Radius = 10
	}
	w.Groups = append(w.Groups, g)
	c := [2]int{int(math.Floor(g.Anchor.X / cellM)), int(math.Floor(g.Anchor.Z / cellM))}
	w.groupAt[c] = append(w.groupAt[c], g)
	return g
}

// BuildFromAtlas places camps, structure groups, boss arenas and wild packs
// (spec 8 "Fights and bosses"). Settlements are safe: nothing spawns within
// their footprint plus 60 m.
func (w *World) BuildFromAtlas(a *AtlasInfo) {
	w.Atlas = a
	level := func(x, z float64) int {
		d := a.Region(a.RegionAt(x, z)).Danger
		return 1 + int(math.Round(math.Max(0, math.Min(1, d))*24))
	}
	safe := func(x, z float64) bool {
		for i := range a.Sites {
			s := &a.Sites[i]
			if s.Category == structures.CategorySettlement && math.Hypot(s.X-x, s.Z-z) < s.Radius+60 {
				return false
			}
		}
		return true
	}
	at := func(s *SiteInfo) movement.Vec3 { return movement.Vec3{X: s.X, Y: w.ground.HeightAt(s.X, s.Z), Z: s.Z} }
	for i := range a.Sites {
		s := &a.Sites[i]
		el := a.Region(int(s.Region)).Element
		if s.Element < 8 {
			el = s.Element
		}
		base := &Group{Anchor: at(s), Biome: s.Biome, Element: el, Level: level(s.X, s.Z), Site: i, Name: s.Name}
		switch {
		case s.Category == structures.CategoryPOI && s.Kind == structures.POIEnemyCamp:
			base.Kind, base.Radius = GroupCamp, 8+2*float64(s.Size)
		case s.Category == structures.CategoryStructure && s.Kind == StructBanditCamp:
			base.Kind, base.Radius = GroupBandit, math.Max(10, s.Radius*0.5)
		case s.Category == structures.CategoryStructure && (s.Kind == StructWizardTower || s.Kind == StructSunken || s.Kind == StructDemonLair || (s.Kind == StructRuin && s.Size >= 2)):
			base.Kind = GroupBoss
			base.Boss = "warden"
			if s.Kind == StructWizardTower {
				base.Boss = "archon"
			}
			bd := D.BossByKey(base.Boss)
			base.Radius = bd.ArenaRadius
			// The generator supplies the arena (spec 8): the structure's
			// footprint at an overworld site. WP09 cave chambers plug in
			// through AddArena with Kind "cave".
			base.Arena = &Arena{Center: base.Anchor, Radius: math.Max(bd.ArenaRadius, s.Radius), Kind: "site", Site: i}
		case s.Category == structures.CategoryStructure && (s.Kind == StructRuin || s.Kind == StructWatchtower || s.Kind == StructShrine || s.Kind == StructMineshaft || s.Kind == StructMeteor):
			base.Kind, base.Radius = GroupGuardian, math.Max(10, s.Radius*0.5)
		default:
			continue
		}
		if base.Kind != GroupBoss && !safe(s.X, s.Z) {
			continue
		}
		w.AddGroup(base)
	}
	if w.cfg.NoWildPacks {
		return
	}
	// Wild packs on a seeded 256 m grid (spec 8: roaming packs of 2 to 5,
	// small fights everywhere), denser with enemyDensity and away from
	// towns, water, cliffs and other groups.
	n := int(a.WorldSize / cellM)
	chance := 0.25 + 0.5*w.cfg.EnemyDensity
	for cz := 0; cz < n; cz++ {
		for cx := 0; cx < n; cx++ {
			h := mix(w.cfg.Seed ^ uint64(cz*n+cx)*0x51ed27)
			if unit(h) > chance {
				continue
			}
			x := (float64(cx) + 0.15 + 0.7*unit(mix(h+1))) * cellM
			z := (float64(cz) + 0.15 + 0.7*unit(mix(h+2))) * cellM
			y := w.ground.HeightAt(x, z)
			if movement.WaterAt(w.ground, x, z) > y-0.2 || movement.SlopeAt(w.ground, x, z).T2 > constants.WalkableTanSq || !safe(x, z) || w.nearGroup(x, z, 80) {
				continue
			}
			w.AddGroup(&Group{Kind: GroupPack, Anchor: movement.Vec3{X: x, Y: y, Z: z}, Radius: 10, Biome: a.BiomeAt(x, z), Element: a.Region(a.RegionAt(x, z)).Element, Level: level(x, z), Site: -1, Seed: h})
		}
	}
}

func (w *World) nearGroup(x, z, r float64) bool {
	for _, g := range w.Groups {
		if math.Hypot(g.Anchor.X-x, g.Anchor.Z-z) < r {
			return true
		}
	}
	return false
}

// composition picks a group's members (deterministic per group seed and
// spawn count): enemy keys and an optional elite index.
func (w *World) composition(g *Group) (keys []string, elite int, affix *combatdefs.Affix) {
	h := mix(g.Seed + uint64(g.spawns)*0x1f)
	pick := func(list []string, i int) string { return list[int(mix(h+uint64(i)*7)%uint64(len(list)))] }
	elite = -1
	biome := D.Tables.Biome[min(5, max(0, g.Biome))]
	eliteChance := D.Tables.Depth["surface"].EliteChance
	switch g.Kind {
	case GroupTest:
		keys = slices.Clone(g.Comp)
		eliteChance = 0 // tests and dev placement say exactly what they want
	case GroupCamp:
		n := 3 + int(mix(h+3)%2)
		for i := 0; i < n; i++ {
			keys = append(keys, pick(biome, i))
		}
		if g.Element < 8 {
			keys = append(keys, D.Tables.Element[g.Element])
		}
		eliteChance += 0.1
	case GroupBandit:
		keys = slices.Clone(D.Tables.Site["bandit"])
		eliteChance += 0.15
	case GroupGuardian:
		t := D.Tables.Site["guardian"]
		if s := g.Site; s >= 0 && w.Atlas != nil && w.Atlas.Sites[s].Kind == StructRuin {
			t = D.Tables.Site["ruin"]
		}
		keys = slices.Clone(t)
		eliteChance += 0.1
	case GroupPack:
		n := 2 + int(mix(h+5)%3)
		first := pick(biome, 0)
		for i := 0; i < n; i++ {
			if i < 2 {
				keys = append(keys, first) // packs are mostly one kind
			} else {
				keys = append(keys, pick(biome, i))
			}
		}
	case GroupBoss:
		keys = []string{g.Boss}
		eliteChance = 0
	}
	if g.Elite != "" {
		affix = D.AffixByKey(g.Elite)
		elite = 0
	} else if len(keys) > 0 && unit(mix(h+11)) < eliteChance {
		elite = int(mix(h+13) % uint64(len(keys)))
		affix = &D.Affixes[int(mix(h+17)%uint64(len(D.Affixes)))]
	}
	return keys, elite, affix
}

var affixTitle = map[string]string{"fast": "Swift", "shielded": "Warded", "splitting": "Sundering"}

// spawnGroup creates a group's members around its anchor.
func (w *World) spawnGroup(g *Group) {
	keys, elite, affix := w.composition(g)
	g.spawns++
	g.Spawned = true
	g.Awake = false
	g.Members = g.Members[:0]
	for i, k := range keys {
		def := D.EnemyByKey(k)
		if def == nil {
			continue
		}
		a := float64(i)/float64(max(1, len(keys)))*2*math.Pi + unit(mix(g.Seed+uint64(i)))
		r := 0.0
		if len(keys) > 1 {
			r = math.Min(g.Radius*0.6, 2.5+float64(i))
		}
		pos := w.place(g.Anchor.X+r*math.Cos(a), g.Anchor.Z+r*math.Sin(a), def)
		var af *combatdefs.Affix
		el := def.Element
		if def.Family == "boss" && g.Element < combatdefs.Physical {
			el = g.Element // a boss takes its arena's element ("The Ashen Warden")
		}
		if i == elite {
			af = affix
			if el == combatdefs.Physical && g.Element < 8 {
				el = g.Element // spec 8: elites carry an element
			}
		}
		e := newEnemy(def, g.Level, el, af, pos)
		e.Group = g
		e.Yaw = a
		if af != nil {
			e.Name = affixTitle[af.Key] + " " + def.Name
		}
		if def.Family == "boss" {
			e.Boss = newBossState(D.BossByKey(def.Key), g.Arena)
			title := D.BossTitles["none"]
			if el < 8 {
				title = D.BossTitles[D.Elements[el]]
			}
			e.Name = title + " " + D.BossNames[def.Key]
		}
		w.addEnemy(e)
		g.Members = append(g.Members, e)
	}
}

// place puts an enemy on the ground at (x, z) (flyers hover).
func (w *World) place(x, z float64, def *combatdefs.Enemy) movement.Vec3 {
	y := w.ground.HeightAt(x, z)
	if def.Behavior == "flyer" {
		y += 1.5
	}
	return movement.Vec3{X: x, Y: y, Z: z}
}

func (w *World) addEnemy(e *Enemy) {
	e.ID = w.alloc()
	e.State = Asleep
	e.record(w.tick)
	w.enemies[e.ID] = e
	w.order = append(w.order, e.ID)
	w.Spawned = append(w.Spawned, e)
}

func (w *World) removeEnemy(e *Enemy) {
	if _, ok := w.enemies[e.ID]; !ok {
		return
	}
	delete(w.enemies, e.ID)
	if i := slices.Index(w.order, e.ID); i >= 0 {
		w.order = slices.Delete(w.order, i, i+1)
	}
	w.Removed = append(w.Removed, e)
}

// Enemy returns a live or dying enemy by entity id.
func (w *World) Enemy(id uint32) *Enemy { return w.enemies[id] }

// Enemies returns the current enemies in spawn order.
func (w *World) Enemies() []*Enemy {
	out := make([]*Enemy, 0, len(w.order))
	for _, id := range w.order {
		out = append(out, w.enemies[id])
	}
	return out
}

// AddPlayer registers a joining player.
func (w *World) AddPlayer(p *Player) { w.players[p.ID] = p }

// RemovePlayer forgets a leaving player (threat, strikes).
func (w *World) RemovePlayer(id uint32) {
	delete(w.players, id)
	for _, e := range w.enemies {
		delete(e.threat, id)
		delete(e.engaged, id)
		if e.Target == id {
			e.Target = 0
		}
	}
	w.strikes = slices.DeleteFunc(w.strikes, func(s *strike) bool { return s.player == id })
}

// Player returns a registered player.
func (w *World) Player(id uint32) *Player { return w.players[id] }

func (w *World) emit(aud Audience, e Out) {
	e.Aud = aud
	w.Events = append(w.Events, e)
}

func (w *World) toPlayer(id uint32, e Out) { w.emit(Audience{To: id}, e) }

func (w *World) near(at movement.Vec3, r float64, except uint32, e Out) {
	w.emit(Audience{Near: at, Radius: r, Except: except}, e)
}

// playersNear returns registered players within r of p (sorted by id).
func (w *World) playersNear(p movement.Vec3, r float64) []*Player {
	var out []*Player
	for _, pl := range w.players {
		if math.Hypot(pl.Pos.X-p.X, pl.Pos.Z-p.Z) <= r && math.Abs(pl.Pos.Y-p.Y) < r {
			out = append(out, pl)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Step advances combat by one zone tick: group spawning (1 Hz, staggered),
// enemy AI, statuses, enemy projectiles, strike settling, and player
// upkeep (mana, regen, consumables, respawns).
func (w *World) Step(tick uint32) {
	w.tick = tick
	if tick%constants.TickRateHz == 0 {
		w.spawnTick()
	}
	if tick%15 == 0 {
		w.wakeTick()
	}
	for _, id := range slices.Clone(w.order) {
		e := w.enemies[id]
		if e == nil {
			continue
		}
		if e.State == Dead {
			if tick-e.diedTick > secondsToTicks(1.5) {
				w.removeEnemy(e)
			}
			continue
		}
		if e.State != Asleep {
			w.think(e)
		}
		e.record(tick)
	}
	w.stepShots()
	w.settleStrikes()
	w.playerUpkeep()
}

// spawnTick spawns groups players approach and despawns abandoned ones.
func (w *World) spawnTick() {
	if len(w.players) == 0 && len(w.order) == 0 {
		return
	}
	spawnR, despawnR := constants.EnemySpawnM, constants.EnemyDespawnM
	near := map[*Group]bool{}
	for _, p := range w.players {
		cx, cz := int(math.Floor(p.Pos.X/cellM)), int(math.Floor(p.Pos.Z/cellM))
		for dz := -1; dz <= 1; dz++ {
			for dx := -1; dx <= 1; dx++ {
				for _, g := range w.groupAt[[2]int{cx + dx, cz + dz}] {
					d := math.Hypot(g.Anchor.X-p.Pos.X, g.Anchor.Z-p.Pos.Z)
					if d <= despawnR {
						g.lastNear = w.tick
						if d <= spawnR {
							near[g] = true
						}
					}
				}
			}
		}
	}
	for _, g := range w.Groups {
		if near[g] && !g.Spawned && w.tick >= g.respawn {
			w.spawnGroup(g)
		}
		if g.Spawned && w.tick-g.lastNear > secondsToTicks(constants.EnemyDespawnS) {
			for _, e := range g.Members {
				w.removeEnemy(e)
			}
			g.Members = nil
			g.Spawned = false
			if g.respawn < w.tick {
				g.respawn = 0
			}
			g.spawns-- // the same composition comes back
		}
	}
}

// wakeTick wakes groups with a player within ENEMY_WAKE_M (spec 8: enemies
// sleep until a player is within 96 m) and puts lonely ones back to sleep.
func (w *World) wakeTick() {
	for _, g := range w.Groups {
		if !g.Spawned {
			continue
		}
		awake := false
		for _, p := range w.players {
			if math.Hypot(g.Anchor.X-p.Pos.X, g.Anchor.Z-p.Pos.Z) <= constants.EnemyWakeM {
				awake = true
				break
			}
		}
		if awake == g.Awake {
			continue
		}
		g.Awake = awake
		for _, e := range g.Members {
			if !e.Alive() {
				continue
			}
			if awake && e.State == Asleep {
				e.State, e.stateAt = Idle, w.tick
			} else if !awake && (e.State == Idle || e.State == Return) {
				e.State = Asleep
			}
		}
	}
}

// groupCleared handles a group whose members are all dead.
func (w *World) groupCleared(g *Group) {
	for _, e := range g.Members {
		if e.Alive() {
			return
		}
	}
	if g.Kind == GroupBoss {
		g.respawn = w.tick + secondsToTicks(w.cfg.BossRespawnS)
	} else {
		g.respawn = w.tick + secondsToTicks(w.cfg.CampRespawnS)
	}
	g.Spawned = false
	g.Members = nil
	if g.Kind != GroupBoss {
		w.near(g.Anchor, 120, 0, Out{Ev: ev(EvCampCleared, 0, uint32(g.ID), int32(g.Kind), g.Anchor, []byte(g.Name))})
	}
}

// GroupStatus is a debug/evidence summary.
func (g *Group) String() string {
	alive := 0
	for _, e := range g.Members {
		if e.Alive() {
			alive++
		}
	}
	return fmt.Sprintf("%s#%d @(%.0f,%.0f) lvl %d members %d/%d", g.Kind, g.ID, g.Anchor.X, g.Anchor.Z, g.Level, alive, len(g.Members))
}

// Cleared reports a group that was beaten and waits for its respawn timer.
func (g *Group) Cleared() bool { return g.spawns > 0 && !g.Spawned && g.respawn > 0 }
