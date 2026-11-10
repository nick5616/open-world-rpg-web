package game

// Combat in the zone (WP13): the glue between sessions/entities and the pure
// combat package (internal/combat). Per input frame the combat layer logs
// attack/cast starts and strips illegal dashes BEFORE the movement step
// (combatFrame), then records the frame's outcome for the strike grace
// window (combatAfterFrame). Hit claims are validated by combat.World and
// answered with HitResult; claims naming a player go through the PvP rules
// (playtest 2, CR 019: pvp.go, duel.go; refused unless both may fight). Each tick the world spawns groups near players,
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
	debug atomic.Pointer[CombatDebugInfo]
	// debugWanted: Unix ms of the last CombatDebug read (WP19: publish on demand).
	debugWanted atomic.Int64
	debugAt     atomic.Int64 // Unix ms of the last publish
	w           *combat.World
	setup       CombatSetup
	byID        map[uint32]*Entity // enemy entity by id
	pending     []pendingClaim
	lastLog     time.Time
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
	w.SetParallel(combatParallel, s.snapshotWorkers()) // WP19b: simple groups think on the tick's workers
	if setup.Dev {
		devPlacement(w, s.log.Info)
	}
	s.cbt = combatGlue{w: w, setup: setup, byID: map[uint32]*Entity{}}
	s.summonHooks(w) // CR 020: allies under the PvP rules (summons.go)
	counts := map[string]int{}
	for _, g := range w.Groups {
		counts[g.Kind.String()]++
	}
	s.log.Info("combat ready", "groups", len(w.Groups), "camps", counts["camp"], "bandit", counts["bandit"], "guardian", counts["guardian"], "packs", counts["pack"], "bosses", counts["boss"], "test", counts["test"])
}

// devPlacement reads LODESTONE_ZONE_DEBUG_CAMP="x,z,level,key key ...[,elite[,dummy]][;...]"
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
		g.Dummy = len(f) >= 6 && strings.TrimSpace(f[5]) == "dummy" // CR 020: training dummies for evidence runs
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
	if spec := strings.TrimSpace(os.Getenv("LODESTONE_ZONE_DEBUG_HORDE")); spec != "" {
		devHorde(w, spec, log)
	}
}

// devHorde reads LODESTONE_ZONE_DEBUG_HORDE="cx,cz,radius,enemies[,level]"
// (WP19, spec 14 soak scenario 1: "300 bots in one region plus 2,000 awake
// enemies"): camps of four mixed commons spread evenly over the disc
// (sunflower spiral), each nudged onto walkable dry ground. They spawn and
// wake by the ordinary rules, so they are awake exactly while players are
// near.
func devHorde(w *combat.World, spec string, log func(string, ...any)) {
	f := strings.Split(spec, ",")
	if len(f) < 4 {
		log("dev horde: want cx,cz,radius,enemies[,level]", "spec", spec)
		return
	}
	cx, _ := strconv.ParseFloat(f[0], 64)
	cz, _ := strconv.ParseFloat(f[1], 64)
	radius, _ := strconv.ParseFloat(f[2], 64)
	n, _ := strconv.Atoi(f[3])
	lvl := 3
	if len(f) >= 5 {
		lvl, _ = strconv.Atoi(f[4])
	}
	comps := [][]string{{"boar", "boar", "wolf", "wolf"}, {"cutthroat", "archer", "cutthroat", "brute"}, {"ram", "stalker", "scuttler", "lurker"}, {"ember_imp", "mud_golem", "shade", "void_mite"}}
	groups := n / 4
	for g := 0; g < groups; g++ {
		r := radius * math.Sqrt((float64(g)+0.5)/float64(groups))
		a := float64(g) * 2.399963229728653 // golden angle
		x, z := w.WalkableNear(cx+r*math.Cos(a), cz+r*math.Sin(a), 24, 4)
		w.TestGroup(movement.Vec3{X: x, Z: z}, comps[g%len(comps)], lvl, "")
	}
	log("dev horde", "groups", groups, "enemies", groups*4, "cx", cx, "cz", cz, "radius", radius, "level", lvl)
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
	s.devGrantSpells(prof) // CR 021: dev evidence runs (dashes.go)
	p := combat.NewPlayer(e.ID, e.Name, prof, int(e.Level))
	p.Pos = e.Move.Pos
	p.PartyID = e.PartyID
	e.cbt = p
	s.cbt.w.AddPlayer(p)
	syncPlayerHealth(e)
	s.sendCombatSync(sess)
	s.pvpJoin(sess) // playtest 2: arriving flagged (zone handoff)
}

func (s *Server) combatLeave(sess *session) {
	if e := sess.ent; e != nil && e.cbt != nil {
		s.pvpLeave(sess) // playtest 2: a duelist who leaves loses the duel
		s.saveCombat(sess, true)
		s.cbt.w.RemovePlayer(e.ID)
	}
}

func (s *Server) sendCombatSync(sess *session) {
	e := sess.ent
	// pt/ux: the weapon look rides in the player's typeId for others
	// (weaponlook.go) and, per loadout, at the end of combat_sync for you.
	mats, look := weaponLooks(sess)
	e.TypeID = look | e.pvpTypeBits() | e.TypeID&TypeRiding // playtest 2: bits 12-13 are the PvP flag and dueling (pvp.go); CR 027: 14 riding (mounts.go)
	s.sendEvent(sess, &proto.Event{Kind: combat.EvCombatSync, EntityID: e.ID, Value: int32(e.cbt.Profile.Active), Data: append(combat.EncodeSync(e.cbt), mats[0], mats[1])})
	s.questsChanged(sess) // quests.go: "know a spell" objectives
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
	f = mountedFrame(e, f) // CR 027: no dodges, dashes or melee from the saddle (mounts.go)
	r := s.cbt.w.Frame(e.cbt, f, e.Move)
	s.nightAction(sess, r.Started) // WP15: Fire/Ice/Earth chemistry where it lands (night.go)
	s.vaultMagic(sess, r.Started)  // CR 023: braziers and fonts of the sealed vaults (dungeons.go)
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
	res := s.resolveClaim(sess, c)
	if res.Pending {
		s.cbt.pending = append(s.cbt.pending, pendingClaim{sess: sess, claim: *c, until: s.tick + claimRetryTicks})
		return
	}
	s.sendHitResult(sess, c, res)
}

// resolveClaim validates a claim: on a player through the PvP rules
// (playtest 2, CR 019: pvp.go; refused unless both may fight), on anything
// else through the PvE path, which knows enemies only.
func (s *Server) resolveClaim(sess *session, c *proto.HitClaim) combat.ClaimResult {
	if t := s.entityByID(c.TargetID); t != nil && t.Kind == proto.EntityKindPlayer {
		return s.pvpClaim(sess, c, t)
	}
	return s.cbt.w.Claim(sess.ent.cbt, c)
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
			ok = pr.LearnWith(sp.Key, p.Level, p.Boons.SkillPoints) == combat.LearnOK
			if ok {
				learnedSpellIntoSlot(p, sp.Key) // a free slot in the active loadout, like tomes
			}
		}
	case combat.ActSetGem:
		if s.cbt.setup.Dev {
			ok = pr.SetGem(int(m.Arg&0xff), int(m.Arg>>8)-1)
		}
	case combat.ActDevGrant: // CR 020: evidence runs learn any spell like a tome (dev builds only)
		if sp := combatdefs.D.SpellByID(int(m.Arg)); s.cbt.setup.Dev && sp != nil {
			ok = pr.Grant(sp.Key) || pr.Knows(sp.Key)
		}
	case combat.ActSetMaterial: // WP15: dev sunsteel until WP14 equips forged items
		if s.cbt.setup.Dev {
			key := ""
			if mat := combatdefs.D.MaterialByID(int(m.Arg >> 8)); mat != nil {
				key = mat.Key
			}
			ok = (m.Arg>>8 == 0 || key != "") && pr.SetMaterial(int(m.Arg&0xff), key)
			s.log.Info("dev weapon material", "entity", e.ID, "loadout", m.Arg&0xff, "active", pr.Active, "material", key, "ok", ok)
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
			res := s.resolveClaim(pc.sess, &pc.claim)
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
	s.dashEnvTick(tick) // CR 021: dash trails set grass alight and freeze water (dashes.go)
	events, spawned, removed, xp, respawn, synced := w.Drain()
	for _, en := range spawned {
		ent := &Entity{ID: en.ID, Kind: proto.EntityKindEnemy, Name: en.Name, Level: uint8(min(255, en.Level)), npc: en, TypeID: en.TypeID()}
		if en.Owner() != 0 {
			ent.Kind, ent.Name = proto.EntityKindEffect, s.summonName(en) // CR 020: an ally (summons.go)
		}
		ent.Move.Pos = en.Pos
		ent.Yaw = en.Yaw
		ent.prevValid, ent.view = ent.Move, ent.Move
		s.insertEntity(ent) // WP16: player ids are world-stable, not in join order
		s.cbt.byID[en.ID] = ent
	}
	for _, en := range removed {
		if ent := s.cbt.byID[en.ID]; ent != nil {
			s.removeEntity(ent)
			delete(s.cbt.byID, en.ID)
		}
	}
	s.deliverCombatAll(events) // WP19b: per session on the workers, each session's events in order
	for _, o := range events {
		s.nightCombatEvent(o) // WP15: burning enemies set the grass alight (night.go)
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
	// WP19b: over s.ents on the workers (each entity is written only by its
	// own item; the maps are read-only here). s.ents holds every byID entity
	// (insertEntity above), so this is the same set the old map walk saw.
	parallelFor(len(s.ents), s.phaseWorkers(len(s.ents)), viewChunk, func(_, i int) {
		ent := s.ents[i]
		en := ent.npc
		if en == nil || s.cbt.byID[ent.ID] != ent || (w.Enemy(ent.ID) == nil && w.Summon(ent.ID) == nil) {
			return
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
	})
	for _, sess := range s.sessions {
		if e := sess.ent; e != nil && e.cbt != nil {
			syncPlayerHealth(e)
			// CR 022: the casting bit while a held action runs (stream, charge,
			// beam, held dash, guard): every observer ends it where the caster did.
			e.npcActivity = e.cbt.HeldActivity(tick)
		}
	}
	// WP19: the debug snapshot walks every group and allocates a record per
	// enemy (~1.5 ms with 2,000 enemies, every 30th tick: a p99 spike), so
	// it is built only while someone reads /debug/combat (CombatDebug).
	if tick%constants.TickRateHz == 0 && time.Now().UnixMilli()-s.cbt.debugWanted.Load() < combatDebugKeepMs {
		s.publishCombatDebug(tick)
	}
	if tick%(constants.TickRateHz*10) == 0 {
		st := w.Stats
		awake := 0
		for _, ent := range s.cbt.byID {
			if en := ent.npc; en != nil && en.State != combat.Asleep && en.Alive() && en.Owner() == 0 {
				awake++
			}
		}
		s.m.reg.SetInt("zone_combat_awake", int64(awake)) // WP19: soak scenario 1 checks "2,000 awake enemies"
		s.m.reg.SetInt("zone_combat_enemies", int64(len(s.cbt.byID)))
		s.m.reg.SetInt("zone_combat_kills_total", st.Kills)
		s.m.reg.SetInt("zone_combat_player_hits_total", st.PlayerHits)
		s.m.reg.SetInt("zone_combat_evaded_total", st.Evaded)
		s.m.reg.SetInt("zone_combat_downs_total", st.Downs)
	}
}

// deliverCombatAll sends a tick's combat Events to their audiences (WP19b).
// Same recipients and, per connection, the same order as calling
// deliverCombat for each event in turn: each event is encoded once, then
// every session walks the events in order on a worker. A session's
// connection is written only by the worker holding that session; the
// entity list and byChar are read-only here.
func (s *Server) deliverCombatAll(events []combat.Out) {
	if len(events) == 0 {
		return
	}
	enc := s.cbtEnc[:0]
	for i := range events {
		enc = append(enc, proto.Encode(&events[i].Ev))
	}
	s.cbtEnc = enc
	parallelFor(len(s.sessions), s.phaseWorkers(len(s.sessions)), inputChunk, func(_, i int) {
		sess := s.sessions[i]
		e := sess.ent
		if e == nil {
			return
		}
		for k := range events {
			aud := &events[k].Aud
			if aud.To != 0 {
				// deliverCombat: the entity with that id, if it is a
				// player whose session (byChar) is this one.
				if e.ID == aud.To && s.byChar[e.CharacterID] == sess {
					_ = sess.conn.SendReliable(enc[k])
				}
				continue
			}
			if e.ID == aud.Except {
				continue
			}
			dx, dz := e.Move.Pos.X-aud.Near.X, e.Move.Pos.Z-aud.Near.Z
			if dx*dx+dz*dz <= aud.Radius*aud.Radius {
				if err := sess.conn.SendReliable(enc[k]); err != nil {
					sess.closed.Store(true)
				}
			}
		}
	})
	clear(enc)
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
	before := ent.x.prog.Level
	if ent.x.prog.AddXP(g.XP) {
		s.levelChanged(sess, before) // playtest 1: 604 + stats, refill (progression.go)
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

// combatActivity is extra Activity bits: an enemy's casting bit while it
// winds up an attack, a player's while they hold something (CR 022,
// combat/held.go).
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
	s.cbt.debugAt.Store(time.Now().UnixMilli())
}

// CombatDebug returns the newest debug snapshot (nil before the first).
// WP19: the tick builds it only while it is being read (combatDebugKeepMs
// after the last read), so a read after a quiet spell waits for the next
// publish (at most ~1 s) instead of returning a stale or missing snapshot.
func (s *Server) CombatDebug() *CombatDebugInfo {
	now := time.Now().UnixMilli()
	s.cbt.debugWanted.Store(now)
	for deadline := now + 2500; ; {
		if d := s.cbt.debug.Load(); (d != nil && now-s.cbt.debugAt.Load() < 1500) || time.Now().UnixMilli() > deadline || s.stopping.Load() {
			return s.cbt.debug.Load()
		}
		time.Sleep(20 * time.Millisecond)
		now = time.Now().UnixMilli()
	}
}

// combatDebugKeepMs: keep publishing this long after the last read.
const combatDebugKeepMs = 10_000
