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
	return [...]string{"?", "camp", "bandit", "guardian", "pack", "boss", "test", "demon"}[k]
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
	// nearPass: the spawnTick pass that last found a player within
	// ENEMY_SPAWN_M (G5: was a map rebuilt every second, ~1 ms of map
	// writes once per second with 300 players among 500 camps).
	nearPass uint64
	respawn  uint32 // tick it may spawn again (0 = now)
	spawns   int
	Arena    *Arena
	Comp     []string // explicit composition (tests), else from tables
	Elite    string   // forced elite affix (tests)
	Dummy    bool     // CR 020: training dummies (dev evidence runs): its members never move or attack
	// Retired (CR 022): a finished world event's or reset vault's group;
	// it never spawns again (content.go RetireGroup).
	Retired bool
	// AreaLevel: the group takes its level and tier from the area it stands
	// in when it spawns (playtest 1, World.Areas); set for every atlas group.
	AreaLevel bool
	tier      *combatdefs.DifficultyTier // the area's tier at the last spawn (nil: none)
	// WP19b partitioned AI (par.go), valid for the tick aiTick.
	aiTick   uint32
	aiSerial bool
	aiPart   int32
}

// Areas is the playtest-1 discovery-stamped difficulty (internal/difficulty
// Map; CR 012): an area's level and tier, or known=false while nobody has
// stamped it yet (groups there wait). nil = the WP13 region danger curve.
type Areas interface {
	AreaAt(x, z float64) (level int, tier *combatdefs.DifficultyTier, known bool)
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
	// spawnPass counts spawnTick passes (Group.nearPass).
	spawnPass uint64
	enemies   map[uint32]*Enemy
	order     []uint32 // enemy ids in spawn order (deterministic iteration)
	players   map[uint32]*Player
	// playerList is players sorted by id (WP19b): playerUpkeep walks it so
	// respawns and upkeep events come out in a fixed order, not map order.
	playerList []*Player
	strikes    []*strike
	shots      []*shot
	winding    []*Enemy   // WP19: enemies that entered Windup since the last prune (windupsOn)
	pg         playerGrid // WP19: players by cell, valid during Step
	// WP19b partitioned AI (par.go).
	par        Parallel
	parWorkers int
	aiPar      bool // this World is a pass-2 worker copy
	aiw        []*aiWorker
	aiParts    []aiPart
	aiFlat     []*Enemy
	aiList     []*Enemy
	windAt     map[uint32]int
	alloc      func() uint32
	tick       uint32
	rng        uint64

	// Outputs, drained by the host each tick.
	Events  []Out
	Spawned []*Enemy
	Removed []*Enemy
	XP      []XPGrant
	Respawn []uint32 // players to teleport to their respawn point
	Synced  []uint32 // players whose combat_sync must be re-sent
	// OnKill is the WP14 loot hook (personal loot per eligible player).
	OnKill func(KillInfo)
	// DemonHooks are WP15's wards and wet-lightning callbacks (demon.go).
	DemonHooks DemonHooks
	// Areas (playtest 1): stamped area levels and tiers; nil = region danger.
	Areas Areas
	// Obstacles reports a body (radius r, feet at x, y, z, head h above)
	// overlapping static collision enemies may not walk into: town
	// buildings and closed doors (the zone glue, internal/game
	// obstacles.go). nil = none. Called from pass-2 AI workers (par.go):
	// it must only read.
	Obstacles func(x, y, z, r, h float64) bool
	// AggroMult scales enemies' aggro range where they stand (playtest 2
	// weather, CR 030: fog banks and storms; nil = 1). Called from AI
	// workers: it must only read.
	AggroMult func(x, z float64) float64

	// CR 020 spell mechanics: allies (summon.go; never in enemies), ally bolts
	// in flight, scheduled bursts (detonate.go). SummonPvP is the game
	// layer's PvP rule for an ally of owner hitting victim (nil: allies never
	// hurt players); OnSummonPvP tells it what such a hit did (duels, kill feed).
	summons     []*Enemy
	summonIdx   map[uint32]*Enemy
	bolts       []pendingBolt
	bursts      []burst
	SummonPvP   func(owner, victim uint32) (PvPHit, bool)
	OnSummonPvP func(owner, victim uint32, res PvPResult)

	// CR 029 pets (pets.go): tamed companions (allies in summonIdx, never in
	// enemies), the creatures the host lets be tamed (enemy def id; nil:
	// taming is off) and below which health share, and what happened this
	// tick for the host (drained by DrainPets).
	pets          []*Enemy
	Tameable      map[int]bool
	TameWeakenPct float64
	petOut        PetOutputs
	quietClear    bool // Tame: the group is cleared without the "camp cleared" Event

	// CR 035: story strikes waiting out their wind-up (story.go).
	story []storyStrike

	// Stats for metrics and evidence.
	Stats Stats
	// quietDamage: the hit being applied is a stream shot (no observer damage Event; CR 020).
	quietDamage bool

	// Playtest 2 pathfinding (nav.go, navai.go, navcave.go): the grid, the
	// search and its queue (nil until the first ask; shared with the AI
	// workers' copies, which only read built chunks), whether a walker
	// asked this tick (each worker copy has its own, merged after pass 2),
	// the ground's cave side and whether it has levels (allies walk floors).
	nav         *navWorld
	navWanted   bool
	navOff      bool // tests and benchmarks: no pathfinding (the old straight steering)
	caveQ       caveQuery
	levelGround bool
}

// Stats are cumulative counters.
type Stats struct {
	ClaimsAccepted, ClaimsRefused, Kills, PlayerHits, Evaded, Downs int64
	PvPHits                                                         int64 // playtest 2: accepted player-vs-player claims
	HeldEvents                                                      int64 // CR 022: Event 226 sends (held.go)
	RefusedBy                                                       [24]int64
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
	w := &World{cfg: cfg, ground: ground, groupAt: map[[2]int][]*Group{}, enemies: map[uint32]*Enemy{}, players: map[uint32]*Player{}, alloc: alloc, rng: cfg.Seed | 1}
	w.caveQ, _ = ground.(caveQuery)
	_, w.levelGround = ground.(movement.LevelGround)
	return w
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
			if s.Category == structures.CategorySettlement && s.Layer == 0 && math.Hypot(s.X-x, s.Z-z) < s.Radius+60 {
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
		base := &Group{Anchor: at(s), Biome: s.Biome, Element: el, Level: level(s.X, s.Z), Site: i, Name: s.Name, AreaLevel: true}
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
			w.AddGroup(&Group{Kind: GroupPack, Anchor: movement.Vec3{X: x, Y: y, Z: z}, Radius: 10, Biome: a.BiomeAt(x, z), Element: a.Region(a.RegionAt(x, z)).Element, Level: level(x, z), Site: -1, Seed: h, AreaLevel: true})
		}
	}
	w.havenMeadows(a, level, safe)
}

// havenMeadows (playtest 2: "no creatures within ~300 m of spawn") seeds
// extra packs on a 64 m grid across the Haven around the world spawn, so a
// new player meets something to fight within a minute's walk of the first
// town. They are ordinary area-levelled packs: the Haven tier turns every
// member into a beginner creature (CR 012), so nothing dangerous spawns.
func (w *World) havenMeadows(a *AtlasInfo, level func(x, z float64) int, safe func(x, z float64) bool) {
	hr := D.Difficulty.HavenRadiusM
	if hr <= 0 || (a.SpawnX == 0 && a.SpawnZ == 0) {
		return
	}
	const grid = 64.0
	for gz := -hr; gz <= hr; gz += grid {
		for gx := -hr; gx <= hr; gx += grid {
			h := mix(w.cfg.Seed ^ 0x6861766e ^ uint64(int64(gx+hr))*0x2545f491 ^ uint64(int64(gz+hr))*0x9e3779b9)
			if unit(h) > 0.6 {
				continue
			}
			x := a.SpawnX + gx + (unit(mix(h+1))-0.5)*grid*0.7
			z := a.SpawnZ + gz + (unit(mix(h+2))-0.5)*grid*0.7
			if math.Hypot(x-a.SpawnX, z-a.SpawnZ) > hr-24 || x < 0 || z < 0 || x >= a.WorldSize || z >= a.WorldSize {
				continue
			}
			y := w.ground.HeightAt(x, z)
			if movement.WaterAt(w.ground, x, z) > y-0.2 || movement.SlopeAt(w.ground, x, z).T2 > constants.WalkableTanSq || !safe(x, z) || w.nearGroup(x, z, 44) {
				continue
			}
			w.AddGroup(&Group{Kind: GroupPack, Anchor: movement.Vec3{X: x, Y: y, Z: z}, Radius: 8, Biome: a.BiomeAt(x, z), Element: a.Region(a.RegionAt(x, z)).Element, Level: level(x, z), Site: -1, Seed: h, AreaLevel: true})
		}
	}
}

// areaReady applies the playtest-1 area (CR 012) to an atlas group about to
// spawn: its level and tier come from the stamped area under its anchor.
// false = wait (the area is not stamped yet, or bosses don't spawn in its
// tier, e.g. the Haven).
func (w *World) areaReady(g *Group) bool {
	if w.Areas == nil || !g.AreaLevel {
		return true
	}
	lvl, t, ok := w.Areas.AreaAt(g.Anchor.X, g.Anchor.Z)
	if !ok || t == nil {
		return false
	}
	if g.Kind == GroupBoss && !t.Bosses {
		return false
	}
	g.Level, g.tier = max(1, lvl), t
	return true
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
	case GroupTest, GroupDemon: // GroupDemon: WP15 night spawns (demon.go)
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
	if t := g.tier; t != nil && g.Kind != GroupBoss && g.Kind != GroupTest && g.Kind != GroupDemon {
		// Playtest 1 (CR 012): the area's tier swaps a share of the members
		// for beginner creatures (the Haven: all of them) and scales elites.
		if t.Beginner > 0 && len(D.Tables.Beginner) > 0 {
			bt := D.Tables.Beginner
			for i := range keys {
				if t.Beginner >= 1 || unit(mix(h+uint64(101+i)*31)) < t.Beginner {
					keys[i] = bt[int(mix(h+uint64(i)*13+7)%uint64(len(bt)))]
				}
			}
		}
		eliteChance *= t.Elite
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
		if def.Demon != nil {
			e.Demon = newDemonState(def) // WP15 (demon.go)
		}
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
	e.gone = true // WP19b: thinkAll's merge pass skips it without a map lookup
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
func (w *World) AddPlayer(p *Player) {
	if old := w.players[p.ID]; old != nil {
		w.dropListed(p.ID)
	}
	w.players[p.ID] = p
	i, _ := slices.BinarySearchFunc(w.playerList, p.ID, func(q *Player, id uint32) int { return cmpID(q.ID, id) })
	w.playerList = slices.Insert(w.playerList, i, p)
}

// dropListed removes id from playerList.
func (w *World) dropListed(id uint32) {
	if i, ok := slices.BinarySearchFunc(w.playerList, id, func(q *Player, id uint32) int { return cmpID(q.ID, id) }); ok {
		w.playerList = slices.Delete(w.playerList, i, i+1)
	}
}

func cmpID(a, b uint32) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

// RemovePlayer forgets a leaving player (threat, strikes).
func (w *World) RemovePlayer(id uint32) {
	w.DismissSummons(id) // CR 020
	w.DismissPets(id)    // CR 029 (the host saved its pet first)
	delete(w.players, id)
	w.dropListed(id)
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
	w.eachPlayerNear(p.X, p.Z, r, func(pl *Player) {
		if math.Hypot(pl.Pos.X-p.X, pl.Pos.Z-p.Z) <= r && math.Abs(pl.Pos.Y-p.Y) < r {
			out = append(out, pl)
		}
	})
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// playerGrid buckets players by 32 m cell for the duration of one Step
// (WP19). Every "players near X" question used to scan every player: with
// 2,000 awake enemies and 300 players that was hundreds of thousands of
// distance checks a tick (acquire alone 10 % of the tick). Player positions
// do not change inside Step (the host sets them before it; RecordFrame runs
// between Steps), so the grid is exact while valid, and outside Step (claims
// arriving with input frames) callers fall back to the full scan.
type playerGrid struct {
	n     int
	cells [][]*Player
	used  []int32
	valid bool
}

const playerCellM = 32.0

func (g *playerGrid) cellOf(v float64) int {
	c := int(math.Floor(v / playerCellM))
	return max(0, min(g.n-1, c))
}

func (w *World) buildPlayerGrid() {
	g := &w.pg
	if g.cells == nil {
		g.n = int(math.Ceil(float64(constants.WorldSizeM) / playerCellM))
		g.cells = make([][]*Player, g.n*g.n)
	}
	for _, c := range g.used {
		clear(g.cells[c])
		g.cells[c] = g.cells[c][:0]
	}
	g.used = g.used[:0]
	for _, p := range w.players {
		c := int32(g.cellOf(p.Pos.Z)*g.n + g.cellOf(p.Pos.X))
		if len(g.cells[c]) == 0 {
			g.used = append(g.used, c)
		}
		g.cells[c] = append(g.cells[c], p)
	}
	g.valid = true
}

// eachPlayerNear calls fn for every player that may be within r of (x, z)
// horizontally (a superset: callers apply their exact test), or for every
// player when the grid is not valid. Visit order carries no meaning:
// callers pick by score with id tie-breaks or sort.
func (w *World) eachPlayerNear(x, z, r float64, fn func(*Player)) {
	g := &w.pg
	if !g.valid {
		for _, p := range w.players {
			fn(p)
		}
		return
	}
	x0, x1 := g.cellOf(x-r), g.cellOf(x+r)
	z0, z1 := g.cellOf(z-r), g.cellOf(z+r)
	for cz := z0; cz <= z1; cz++ {
		for cx := x0; cx <= x1; cx++ {
			for _, p := range g.cells[cz*g.n+cx] {
				fn(p)
			}
		}
	}
}

// Step advances combat by one zone tick: group spawning (1 Hz, staggered),
// enemy AI, statuses, enemy projectiles, strike settling, and player
// upkeep (mana, regen, consumables, respawns).
func (w *World) Step(tick uint32) {
	w.tick = tick
	for _, p := range w.playerList {
		p.notePos(tick) // playtest 2: PvP claims look back over these (pvp.go)
	}
	w.buildPlayerGrid() // WP19: exact for this Step only
	defer func() { w.pg.valid = false }()
	if tick%constants.TickRateHz == 0 {
		w.spawnTick()
	}
	if tick%15 == 0 {
		w.wakeTick()
	}
	w.pruneWinding() // WP19
	w.thinkAll(tick) // WP19b: partitioned across workers (par.go)
	w.stepSummons()  // CR 020: allies act after the enemies thought (summon.go)
	w.stepPets()     // CR 029: tamed companions (pets.go)
	w.navTick()      // playtest 2: path searches asked for this tick, within the budget (navai.go)
	w.stepBursts()   // CR 020: delayed charges and brand chain reactions (detonate.go)
	w.stepShots()
	w.settleStrikes()
	w.dashTick() // CR 021: held dashes' trails, heals and slams (dashes.go)
	w.heldTick() // CR 022: what players hold, for every client's visuals (held.go)
	w.playerUpkeep()
}

// spawnTick spawns groups players approach and despawns abandoned ones.
func (w *World) spawnTick() {
	if len(w.players) == 0 && len(w.order) == 0 {
		return
	}
	spawnR, despawnR := constants.EnemySpawnM, constants.EnemyDespawnM
	w.spawnPass++
	pass := w.spawnPass
	for _, p := range w.players {
		cx, cz := int(math.Floor(p.Pos.X/cellM)), int(math.Floor(p.Pos.Z/cellM))
		for dz := -1; dz <= 1; dz++ {
			for dx := -1; dx <= 1; dx++ {
				for _, g := range w.groupAt[[2]int{cx + dx, cz + dz}] {
					if g.nearPass == pass {
						// G5: a player within ENEMY_SPAWN_M already set
						// both marks this pass; no other player can change
						// them (300 players x 500 camps was a 1.2 ms Hypot
						// spike once a second).
						continue
					}
					d := math.Hypot(g.Anchor.X-p.Pos.X, g.Anchor.Z-p.Pos.Z)
					if d <= despawnR {
						g.lastNear = w.tick
						if d <= spawnR {
							g.nearPass = pass
						}
					}
				}
			}
		}
	}
	for _, g := range w.Groups {
		if g.nearPass == pass && !g.Spawned && !g.Retired && w.tick >= g.respawn && w.areaReady(g) {
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
		w.eachPlayerNear(g.Anchor.X, g.Anchor.Z, constants.EnemyWakeM, func(p *Player) {
			if !awake && math.Hypot(g.Anchor.X-p.Pos.X, g.Anchor.Z-p.Pos.Z) <= constants.EnemyWakeM {
				awake = true
			}
		})
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

// havenRespawnS: how long a cleared beginner (Haven) pack stays away.
const havenRespawnS = 75.0

// groupCleared handles a group whose members are all dead.
func (w *World) groupCleared(g *Group) {
	for _, e := range g.Members {
		if e.Alive() {
			return
		}
	}
	if g.Kind == GroupBoss {
		g.respawn = w.tick + secondsToTicks(w.cfg.BossRespawnS)
	} else if g.tier != nil && g.tier.Beginner >= 1 {
		// Playtest 2: the Haven's beginner packs come back quickly. In a
		// shared world other players clear them, and a new character sent to
		// "kill 5 slimes" found every marked pack gone for ten minutes.
		g.respawn = w.tick + secondsToTicks(min(w.cfg.CampRespawnS, havenRespawnS))
	} else {
		g.respawn = w.tick + secondsToTicks(w.cfg.CampRespawnS)
	}
	g.Spawned = false
	g.Members = nil
	if g.Kind != GroupBoss && !w.quietClear { // CR 029: a tamed last member clears it quietly
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
