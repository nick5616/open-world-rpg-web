package game

// Combat in the zone (WP13): the glue between sessions/entities and the pure
// combat package (internal/combat). Per input frame the combat layer logs
// attack/cast starts and strips illegal dashes BEFORE the movement step
// (combatFrame), then records the frame's outcome for the strike grace
// window (combatAfterFrame). Hit claims are validated by combat.World and
// answered with HitResult; claims naming a player are always refused (spec
// 2: no PvP of any kind). Each tick the world spawns groups near players,
// runs enemy AI and settles strikes; its outputs become entities (enemies
// travel the existing snapshot/AOI path as EntityKind enemy), Events
// (contracts/events.md 200-399), XP (WP12 progress), respawns (WP12
// RespawnPoint) and saves (character_progress.skill_tree / spells_known /
// spells_equipped, spec 11; local profiles: the same fields of the save).

import (
	"context"
	"errors"
	"math"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/writebehind"
	"lodestone/server/zone/internal/combat"
)

// CombatSetup configures combat (main.go fills it; nil = combat with no
// atlas groups, e.g. flat test zones).
type CombatSetup struct {
	Atlas  *combat.AtlasInfo // camps, packs, boss arenas from the world's sites
	Config combat.Config
	// Dev enables dev placement (LODESTONE_ZONE_DEBUG_CAMP/_BOSS) and the
	// gem Interact (WP14 sockets stand-in).
	Dev bool
	// Arenas are extra boss arenas (WP09 cave chambers via combat.ArenaProvider).
	Arenas []ArenaSpec
	// OnKill is the WP14 loot hook (personal loot per eligible player).
	OnKill func(combat.KillInfo)
}

// ArenaSpec places a boss in an extra arena.
type ArenaSpec struct {
	Arena   combat.Arena
	Boss    string
	Level   int
	Element int
}

// CombatStore persists combat profiles (PGStore implements it).
type CombatStore interface {
	LoadCombat(ctx context.Context, characterID string) (skillTree []byte, known []string, ok bool, err error)
	SaveCombat(ctx context.Context, characterID string, skillTree []byte, known, equipped []string) error
}

// HitResult refusal flags travel in HitResult.flags (accepted = false).
const claimRetryTicks = 15 // a claim may wait 500 ms for its attack frame

type pendingClaim struct {
	sess  *session
	claim proto.HitClaim
	until uint32
}

type combatGlue struct {
	debug   atomic.Pointer[CombatDebugInfo]
	w       *combat.World
	setup   CombatSetup
	byID    map[uint32]*Entity // enemy entity by id
	pending []pendingClaim
	lastLog time.Time
}

// World exposes the combat world (tests, the debug endpoint).
func (s *Server) CombatWorld() *combat.World { return s.cbt.w }

func (s *Server) initCombat() {
	setup := CombatSetup{}
	if s.cfg.Combat != nil {
		setup = *s.cfg.Combat
	}
	if setup.Config.Seed == 0 {
		setup.Config.Seed = s.cfg.Seed
	}
	alloc := func() uint32 { id := s.nextID; s.nextID++; return id }
	w := combat.NewWorld(setup.Config, s.cfg.Ground, alloc)
	if setup.Atlas != nil {
		w.BuildFromAtlas(setup.Atlas)
	}
	for _, a := range setup.Arenas {
		w.AddArena(a.Arena, a.Boss, a.Level, a.Element)
	}
	w.OnKill = setup.OnKill
	if setup.Dev {
		devPlacement(w, s.log.Info)
	}
	s.cbt = combatGlue{w: w, setup: setup, byID: map[uint32]*Entity{}}
	counts := map[string]int{}
	for _, g := range w.Groups {
		counts[g.Kind.String()]++
	}
	s.log.Info("combat ready", "groups", len(w.Groups), "camps", counts["camp"], "bandit", counts["bandit"], "guardian", counts["guardian"], "packs", counts["pack"], "bosses", counts["boss"], "test", counts["test"])
}

// devPlacement reads LODESTONE_ZONE_DEBUG_CAMP="x,z,level,key key ...[;...]"
// and LODESTONE_ZONE_DEBUG_BOSS="x,z,level,boss[,element]" (acceptance runs
// on known ground; dev builds only).
func devPlacement(w *combat.World, log func(string, ...any)) {
	for _, spec := range strings.Split(os.Getenv("LODESTONE_ZONE_DEBUG_CAMP"), ";") {
		f := strings.Split(strings.TrimSpace(spec), ",")
		if len(f) < 4 {
			continue
		}
		x, _ := strconv.ParseFloat(f[0], 64)
		z, _ := strconv.ParseFloat(f[1], 64)
		lvl, _ := strconv.Atoi(f[2])
		elite := ""
		if len(f) >= 5 {
			elite = f[4]
		}
		x, z = w.WalkableNear(x, z, 120, 8)
		g := w.TestGroup(movement.Vec3{X: x, Z: z}, strings.Fields(f[3]), lvl, elite)
		log("dev camp", "group", g.ID, "x", x, "z", z, "members", f[3])
	}
	for _, spec := range strings.Split(os.Getenv("LODESTONE_ZONE_DEBUG_BOSS"), ";") {
		f := strings.Split(strings.TrimSpace(spec), ",")
		if len(f) < 4 {
			continue
		}
		x, _ := strconv.ParseFloat(f[0], 64)
		z, _ := strconv.ParseFloat(f[1], 64)
		lvl, _ := strconv.Atoi(f[2])
		el := combatdefs.Physical
		if len(f) >= 5 {
			for i, n := range combatdefs.D.Elements {
				if n == f[4] {
					el = i
				}
			}
		}
		x, z = w.WalkableNear(x, z, 160, 18)
		g := w.TestBoss(movement.Vec3{X: x, Z: z}, f[3], lvl, el)
		log("dev boss", "group", g.ID, "x", x, "z", z, "boss", f[3])
	}
}

// loadCombat runs on the connection goroutine before join (like
// loadExplore): accounts from Postgres, local profiles from the save blob.
func (s *Server) loadCombat(characterID string, x *exploreState) *combat.Profile {
	if x != nil && x.local != nil {
		st := x.local.state
		return combat.LoadProfile(st.Progress.SkillTree, st.Progress.SpellsKnown)
	}
	cs, ok := s.cfg.Store.(CombatStore)
	if !ok || s.cfg.Store == nil {
		return combat.NewProfile()
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	tree, known, found, err := cs.LoadCombat(ctx, characterID)
	if err != nil {
		s.log.Warn("combat profile load failed; starting kit this session", "character", characterID, "err", err)
		return combat.NewProfile()
	}
	if !found {
		return combat.NewProfile()
	}
	return combat.LoadProfile(tree, known)
}

// combatJoin registers the player (tick goroutine, after exploreJoin).
func (s *Server) combatJoin(sess *session) {
	e := sess.ent
	prof := sess.cprof
	if prof == nil {
		prof = combat.NewProfile()
	}
	p := combat.NewPlayer(e.ID, e.Name, prof, int(e.Level))
	p.Pos = e.Move.Pos
	p.PartyID = e.PartyID
	e.cbt = p
	s.cbt.w.AddPlayer(p)
	syncPlayerHealth(e)
	s.sendCombatSync(sess)
}

func (s *Server) combatLeave(sess *session) {
	if e := sess.ent; e != nil && e.cbt != nil {
		s.saveCombat(sess, true)
		s.cbt.w.RemovePlayer(e.ID)
	}
}

func (s *Server) sendCombatSync(sess *session) {
	e := sess.ent
	s.sendEvent(sess, &proto.Event{Kind: combat.EvCombatSync, EntityID: e.ID, Value: int32(e.cbt.Profile.Active), Data: combat.EncodeSync(e.cbt)})
}

func syncPlayerHealth(e *Entity) {
	p := e.cbt
	e.HealthMax = uint16(math.Min(65535, math.Round(p.HPMax)))
	e.Health = uint16(math.Min(float64(e.HealthMax), math.Max(0, math.Ceil(p.HP))))
}

// oneStepFlags are input bits that mean "this happens on this step": a
// synthesized or extrapolated frame must never repeat them.
const oneStepFlags = proto.InputFlagAttack | proto.InputFlagDodge | proto.InputFlagCast | proto.InputFlagInteract

// combatFrame runs before the movement step for every applied frame.
func (s *Server) combatFrame(sess *session, f proto.InputFrame) proto.InputFrame {
	e := sess.ent
	if e == nil || e.cbt == nil {
		return f
	}
	r := s.cbt.w.Frame(e.cbt, f, e.Move)
	return r.Frame
}

// combatAfterFrame records the frame's outcome (position, i-frames) for the
// strike grace window.
func (s *Server) combatAfterFrame(sess *session, f proto.InputFrame) {
	if e := sess.ent; e != nil && e.cbt != nil {
		e.cbt.RecordFrame(f.Seq, e.Move)
	}
}

// handleHitClaim validates one claim (tick goroutine).
func (s *Server) handleHitClaim(sess *session, c *proto.HitClaim) {
	e := sess.ent
	if e == nil || e.cbt == nil {
		return
	}
	// PvP never (spec 2): a claim that names a player is refused before
	// anything else looks at it.
	if t := s.entityByID(c.TargetID); t != nil && t.Kind == proto.EntityKindPlayer {
		s.sendHitResult(sess, c, s.cbt.w.RefusePlayerTarget())
		return
	}
	res := s.cbt.w.Claim(e.cbt, c)
	if res.Pending {
		s.cbt.pending = append(s.cbt.pending, pendingClaim{sess: sess, claim: *c, until: s.tick + claimRetryTicks})
		return
	}
	s.sendHitResult(sess, c, res)
}

func (s *Server) sendHitResult(sess *session, c *proto.HitClaim, r combat.ClaimResult) {
	hr := &proto.HitResult{AttackSeq: c.AttackSeq, TargetID: c.TargetID, Accepted: r.Accepted, Damage: r.Damage, TargetHealthPct: r.HPPct, Flags: r.Flags}
	if !r.Accepted {
		hr.Flags = r.Reason
	}
	if err := sess.conn.SendReliable(proto.Encode(hr)); err != nil {
		sess.closed.Store(true)
	}
	if r.Accepted {
		s.m.reg.Add("zone_combat_claims_accepted_total", 1)
	} else {
		s.m.reg.Add("zone_combat_claims_refused_total{reason=\""+strconv.Itoa(int(r.Reason))+"\"}", 1)
	}
}

func (s *Server) entityByID(id uint32) *Entity {
	lo, hi := 0, len(s.ents)
	for lo < hi {
		m := (lo + hi) / 2
		switch {
		case s.ents[m].ID == id:
			return s.ents[m]
		case s.ents[m].ID < id:
			lo = m + 1
		default:
			hi = m
		}
	}
	return nil
}

// handleCombatInteract: loadout swap, equip, learn (Interact targetKind 50).
func (s *Server) handleCombatInteract(sess *session, m *proto.Interact) {
	e := sess.ent
	if e == nil || e.cbt == nil {
		return
	}
	p := e.cbt
	pr := p.Profile
	ok := false
	switch m.Action {
	case combat.ActSwapLoadout:
		ok = pr.Swap(int(m.Arg & 1))
	case combat.ActEquipWeapon:
		if w := combatdefs.D.WeaponByID(int(m.Arg >> 8)); w != nil {
			ok = pr.EquipWeapon(int(m.Arg&0xff), w.Key)
		}
	case combat.ActEquipSpell:
		key := ""
		if sp := combatdefs.D.SpellByID(int(m.Arg >> 8)); sp != nil {
			key = sp.Key
		}
		ok = pr.EquipSpell(int(m.Arg&0xf), int(m.Arg>>4&0xf), key)
	case combat.ActLearn:
		if sp := combatdefs.D.SpellByID(int(m.Arg)); sp != nil {
			ok = pr.Learn(sp.Key, p.Level) == combat.LearnOK
		}
	case combat.ActSetGem:
		if s.cbt.setup.Dev {
			ok = pr.SetGem(int(m.Arg&0xff), int(m.Arg>>8)-1)
		}
	}
	if !ok {
		s.sendEvent(sess, &proto.Event{Kind: combat.EvRefused, EntityID: e.ID, TargetID: uint32(m.Action), Value: combat.RefuseIllegal})
	}
	s.sendCombatSync(sess)
	s.saveCombat(sess, false)
}

// combatTick runs the combat world for one tick and applies its outputs.
func (s *Server) combatTick(tick uint32) {
	w := s.cbt.w
	// Claims that arrived before their attack frame.
	if len(s.cbt.pending) > 0 {
		keep := s.cbt.pending[:0]
		for _, pc := range s.cbt.pending {
			if pc.sess.left || pc.sess.ent == nil || pc.sess.ent.cbt == nil {
				continue
			}
			res := w.Claim(pc.sess.ent.cbt, &pc.claim)
			if res.Pending {
				if tick < pc.until {
					keep = append(keep, pc)
					continue
				}
				res = combat.ClaimResult{Reason: combat.RefuseUnknown}
			}
			s.sendHitResult(pc.sess, &pc.claim, res)
		}
		s.cbt.pending = keep
	}
	for _, sess := range s.sessions {
		e := sess.ent
		if e == nil || e.cbt == nil {
			continue
		}
		p := e.cbt
		p.Pos = e.Move.Pos
		p.PartyID = e.PartyID
		if int(e.Level) != p.Level && e.Level > 0 {
			p.SetLevel(int(e.Level))
			s.sendCombatSync(sess)
		}
	}
	w.Step(tick)
	events, spawned, removed, xp, respawn, synced := w.Drain()
	for _, en := range spawned {
		ent := &Entity{ID: en.ID, Kind: proto.EntityKindEnemy, Name: en.Name, Level: uint8(min(255, en.Level)), npc: en, TypeID: en.TypeID()}
		ent.Move.Pos = en.Pos
		ent.Yaw = en.Yaw
		ent.prevValid, ent.view = ent.Move, ent.Move
		s.ents = append(s.ents, ent) // ids only grow: stays sorted
		s.cbt.byID[en.ID] = ent
	}
	for _, en := range removed {
		if ent := s.cbt.byID[en.ID]; ent != nil {
			s.removeEntity(ent)
			delete(s.cbt.byID, en.ID)
		}
	}
	for _, o := range events {
		s.deliverCombat(o)
	}
	for _, g := range xp {
		s.grantCombatXP(g)
	}
	for _, id := range respawn {
		if ent := s.entityByID(id); ent != nil && ent.Kind == proto.EntityKindPlayer {
			s.Teleport(ent, s.RespawnPoint(ent))
		}
	}
	for _, id := range synced {
		if ent := s.entityByID(id); ent != nil {
			if sess := s.byChar[ent.CharacterID]; sess != nil {
				s.sendCombatSync(sess)
				s.saveCombat(sess, false)
			}
		}
	}
	// Mirror enemies and player health into the entities snapshots read.
	for id, ent := range s.cbt.byID {
		en := ent.npc
		if en == nil || w.Enemy(id) == nil {
			continue
		}
		ent.Move.Pos, ent.Move.Vel = en.Pos, en.Vel
		ent.Move.Mode = movement.ModeGround
		ent.Yaw = en.Yaw
		ent.HealthMax = 100
		ent.Health = uint16(en.HealthPct())
		ent.TypeID = en.TypeID()
		ent.npcActivity = 0
		if en.Winding() {
			ent.npcActivity = proto.ActivityCasting
		}
	}
	for _, sess := range s.sessions {
		if e := sess.ent; e != nil && e.cbt != nil {
			syncPlayerHealth(e)
		}
	}
	if tick%constants.TickRateHz == 0 {
		s.publishCombatDebug(tick)
	}
	if tick%(constants.TickRateHz*10) == 0 {
		st := w.Stats
		s.m.reg.SetInt("zone_combat_enemies", int64(len(s.cbt.byID)))
		s.m.reg.SetInt("zone_combat_kills_total", st.Kills)
		s.m.reg.SetInt("zone_combat_player_hits_total", st.PlayerHits)
		s.m.reg.SetInt("zone_combat_evaded_total", st.Evaded)
		s.m.reg.SetInt("zone_combat_downs_total", st.Downs)
	}
}

// deliverCombat sends one combat Event to its audience.
func (s *Server) deliverCombat(o combat.Out) {
	ev := o.Ev
	if o.Aud.To != 0 {
		if ent := s.entityByID(o.Aud.To); ent != nil {
			s.sendEventTo(ent, &ev)
		}
		return
	}
	b := proto.Encode(&ev)
	r2 := o.Aud.Radius * o.Aud.Radius
	for _, sess := range s.sessions {
		e := sess.ent
		if e == nil || e.ID == o.Aud.Except {
			continue
		}
		dx, dz := e.Move.Pos.X-o.Aud.Near.X, e.Move.Pos.Z-o.Aud.Near.Z
		if dx*dx+dz*dz <= r2 {
			if err := sess.conn.SendReliable(b); err != nil {
				sess.closed.Store(true)
			}
		}
	}
}

// grantCombatXP adds kill XP to WP12's character progress (spec 8: one XP
// pool for discovery and combat; level-ups raise health and skill points).
func (s *Server) grantCombatXP(g combat.XPGrant) {
	ent := s.entityByID(g.Player)
	if ent == nil || ent.x == nil {
		return
	}
	sess := s.byChar[ent.CharacterID]
	if sess == nil {
		return
	}
	if ent.x.prog.AddXP(g.XP) {
		ent.Level = uint8(min(255, ent.x.prog.Level))
		s.sendEvent(sess, &proto.Event{Kind: EventLevelUp, EntityID: ent.ID, Value: int32(ent.x.prog.Level)})
	}
	if s.cfg.Explore != nil {
		s.sendProgress(sess)
	}
	s.saveProgressSoon(sess, false)
}

// saveCombat persists a changed profile: accounts through the write-behind
// queue (coalesced per character), local profiles ride WP12's blob issue.
func (s *Server) saveCombat(sess *session, force bool) {
	e := sess.ent
	if e == nil || e.cbt == nil || s.cfg.Queue == nil {
		return
	}
	pr := e.cbt.Profile
	if !pr.Dirty() {
		return
	}
	if sess.x != nil && sess.x.local != nil {
		sess.x.prog.MarkDirty() // the next blob carries the combat fields (combatIntoLocal)
		s.saveProgressSoon(sess, force)
		return
	}
	cs, ok := s.cfg.Store.(CombatStore)
	if !ok || s.cfg.Store == nil {
		return
	}
	tree, known, equipped := pr.MarshalSkillTree(), append([]string(nil), pr.Known...), append([]string(nil), pr.Equipped()...)
	pr.MarkSaved()
	id, log := e.CharacterID, s.log
	s.cfg.Queue.Enqueue(writebehind.Op{Key: "combat:" + id, Run: func(ctx context.Context) error {
		err := cs.SaveCombat(ctx, id, tree, known, equipped)
		if err != nil && errors.Is(err, writebehind.ErrSkip) {
			if _, seen := loggedMissing.LoadOrStore("combat:"+id, true); !seen {
				log.Info("combat save skipped: no character row", "character", id)
			}
		}
		return err
	}})
}

// combatIntoLocal copies the combat profile into a local save's state
// (called by issueLocalSave).
func combatIntoLocal(e *Entity, progressSkillTree *[]byte, known, equipped *[]string) {
	if e == nil || e.cbt == nil {
		return
	}
	pr := e.cbt.Profile
	*progressSkillTree = pr.MarshalSkillTree()
	*known = append([]string(nil), pr.Known...)
	*equipped = append([]string(nil), pr.Equipped()...)
	pr.MarkSaved()
}

// combatActivity is extra Activity bits for enemies (the casting bit while
// winding up an attack).
func (e *Entity) combatActivity() uint8 { return e.npcActivity }

// CombatDebugInfo is the /debug/combat snapshot (published once a second by
// the tick; safe to read from any goroutine).
type CombatDebugInfo struct {
	Tick    uint32             `json:"tick"`
	Enemies int                `json:"enemies"`
	Stats   combat.Stats       `json:"stats"`
	Groups  []CombatGroupDebug `json:"groups"`
}

// CombatGroupDebug is one group in the debug snapshot.
type CombatGroupDebug struct {
	ID      int                `json:"id"`
	Kind    string             `json:"kind"`
	X       float64            `json:"x"`
	Y       float64            `json:"y"`
	Z       float64            `json:"z"`
	Radius  float64            `json:"radius"`
	Level   int                `json:"level"`
	Name    string             `json:"name,omitempty"`
	Boss    string             `json:"boss,omitempty"`
	Spawned bool               `json:"spawned"`
	Alive   int                `json:"alive"`
	Members int                `json:"members"`
	Cleared bool               `json:"cleared"` // spawned at least once and currently down (respawn timer)
	Enemies []CombatEnemyDebug `json:"enemies,omitempty"`
}

// CombatEnemyDebug is one spawned member.
type CombatEnemyDebug struct {
	ID    uint32  `json:"id"`
	Key   string  `json:"key"`
	Name  string  `json:"name,omitempty"`
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
	Z     float64 `json:"z"`
	HP    float64 `json:"hp"`
	HPMax float64 `json:"hpMax"`
	State string  `json:"state"`
}

func (s *Server) publishCombatDebug(tick uint32) {
	w := s.cbt.w
	info := &CombatDebugInfo{Tick: tick, Enemies: len(s.cbt.byID), Stats: w.Stats}
	for _, g := range w.Groups {
		d := CombatGroupDebug{ID: g.ID, Kind: g.Kind.String(), X: g.Anchor.X, Y: g.Anchor.Y, Z: g.Anchor.Z, Radius: g.Radius, Level: g.Level, Name: g.Name, Boss: g.Boss, Spawned: g.Spawned, Members: len(g.Members), Cleared: g.Cleared()}
		for _, e := range g.Members {
			if e.Alive() {
				d.Alive++
			}
			d.Enemies = append(d.Enemies, CombatEnemyDebug{ID: e.ID, Key: e.Def.Key, Name: e.Name, X: e.Pos.X, Y: e.Pos.Y, Z: e.Pos.Z, HP: e.HP, HPMax: e.HPMax, State: e.State.String()})
		}
		info.Groups = append(info.Groups, d)
	}
	s.cbt.debug.Store(info)
}

// CombatDebug returns the newest debug snapshot (nil before the first).
func (s *Server) CombatDebug() *CombatDebugInfo { return s.cbt.debug.Load() }
