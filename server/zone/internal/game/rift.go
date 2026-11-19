package game

// Rift runs (playtest 2, CR 040, docs/cr/040-rift-runs.md): portals that
// open at random in the world (internal/rift portal.go: seeded per area and
// time window, a few at once, weighted by area difficulty), announced as
// world events; E at one takes you (and your party near it) into a run of
// 50 compact arena stages whose enemies fire readable bullet patterns.
//
// Where the arenas are: high above the portal (RiftBaseY + 45 m per
// instance slot), each its own instance. Players in a run see only their
// run (snapshot filter, Entity.riftID); the movement ground of a player in
// a run is the arena (riftGround: a flat floor, walls, pillars and pools,
// the client's sim/riftGround.ts twin), weather never reaches it, and every
// position save while in a run is the portal's exit, so a crash or a logout
// never leaves a character in the sky.
//
// The run's rules are internal/rift; this file is its Host: bodies are
// combat enemies (combat/rift.go), shots hurt through combat (armor, god
// mode), rewards are real items (personal pickups in the room, swept into
// the bag when the room changes), spoils are gold banked at checkpoints.

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"time"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/writebehind"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/items"
	"lodestone/server/zone/internal/quests"
	"lodestone/server/zone/internal/rift"
)

// Event kinds 2000-2019 (contracts/events.md "Rift runs").
const (
	EventRiftPortals = 2000 // the open rifts (JSON), to everyone in the zone on a change and on join
	EventRiftStage   = 2001 // a new room (JSON), to the run's players
	EventRiftVolley  = 2002 // a telegraphed volley (binary), to the run's players
	EventRiftClear   = 2003 // the room is clear (value = stage)
	EventRiftDoor    = 2004 // the door opened (value 1: the way out stands beside it)
	EventRiftLeft    = 2005 // you left the run (value = reason; JSON summary)
	EventRiftPerks   = 2006 // perk cards to pick from (JSON)
	EventRiftPerk    = 2007 // a perk was taken (targetId = who, value = perk index)
	EventRiftReward  = 2008 // your stage reward (JSON)
	EventRiftBank    = 2009 // spoils banked (value = gold)
	EventRiftNote    = 2010 // value: 1 a ward ate a shot, 2 a graze (mana), 4 a boss phase (targetId enemy, data u8 phase), 5 someone joined
	EventRiftBoard   = 2011 // a chapter's leaderboard (JSON)
	EventRiftEnd     = 2012 // the run ended (value = reason, targetId = run)
)

// InteractRift is Interact targetKind 190: 1 enter (targetId = portal id),
// 2 pick a perk (arg = perk index), 3 leave (forfeit the unbanked spoils),
// 4 the leaderboard (arg = chapter, 0 = every chapter).
const (
	InteractRift   = 190
	RiftActEnter   = 1
	RiftActPerk    = 2
	RiftActLeave   = 3
	RiftActBoard   = 4
	RiftBaseY      = 2600.0 // the first instance's floor
	riftSlotStepY  = 45.0
	riftSlots      = 64
	riftEnterM     = 7.0  // how near the portal E works
	riftPartyM     = 25.0 // party members this near come along
	riftAnnounceM  = 450.0
	riftPickupLife = 10 * time.Minute
)

type riftPortal struct {
	ID      uint32  `json:"id"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Z       float64 `json:"z"`
	Chapter int     `json:"chapter"`
	Name    string  `json:"name"`
	Color   string  `json:"color"`
	Level   int     `json:"level"`
	EndsMs  int64   `json:"endsInMs"`
	Dev     bool    `json:"dev,omitempty"`
	ends    time.Time
	told    map[string]bool
}

type riftRun struct {
	run     *rift.Run
	portal  riftPortal
	origin  movement.Vec3
	slot    int
	enemies map[uint32]*combat.Enemy
	pickups map[uint32]*Entity
	layout  *rift.Layout
	started time.Time
}

type riftState struct {
	init     bool
	window   int64
	portals  []*riftPortal
	nextID   uint32
	runs     map[uint32]*riftRun
	byPlayer map[uint32]*riftRun // entity id -> run
	enemyRun map[uint32]uint32   // enemy id -> run id
	slots    [riftSlots]bool
	nextRun  uint32
	board    map[int][]RiftBest
	boardAt  time.Time
	disabled bool
}

// RiftBest is one leaderboard row.
type RiftBest struct {
	Char  string `json:"-"`
	Name  string `json:"name"`
	Stage int    `json:"stage"`
	Ms    int64  `json:"ms"`
}

// RiftStore persists the per-chapter leaderboard (migration 0030).
type RiftStore interface {
	SaveRiftBest(ctx context.Context, worldID string, chapter int, characterID, name string, stage int, ms int64) error
	LoadRiftBoard(ctx context.Context, worldID string, chapter, limit int) ([]RiftBest, error)
}

// SetRifts turns the rift schedule on or off (SetWorldEvents does too; the
// dev console's /rift spawn works either way).
func (s *Server) SetRifts(on bool) { s.rift.disabled = !on }

func (s *Server) riftInit() {
	if s.rift.init {
		return
	}
	s.rift.init = true
	s.rift.runs = map[uint32]*riftRun{}
	s.rift.byPlayer = map[uint32]*riftRun{}
	s.rift.enemyRun = map[uint32]uint32{}
	s.rift.board = map[int][]RiftBest{}
	s.rift.window = -1
	if s.cbt.w != nil {
		prev := s.cbt.w.OnKill
		s.cbt.w.OnKill = func(k combat.KillInfo) {
			if k.Enemy != nil && s.rift.enemyRun[k.Enemy.ID] != 0 {
				return // a rift body: the run pays (no kill loot, no feats)
			}
			if prev != nil {
				prev(k)
			}
		}
	}
	s.riftLoadBoard()
}

// ---- portals ----

func (s *Server) riftAreaLevel(x, z float64) (level, tier int) {
	if !s.diff.on {
		return 3, 1
	}
	m := s.diff.m
	c := m.Cell(x, z)
	if m.Haven(c) {
		return 1, 0
	}
	l, ok := m.Level(c)
	if !ok {
		l = m.Projected(c, 3)
	}
	_, ti := m.Def.TierFor(l)
	return l, ti
}

func (s *Server) riftPortalsTick() {
	if s.rift.disabled || s.cfg.Ground == nil || s.cfg.Towns == nil {
		return // rifts are world events: off with them (tests, LODESTONE_ZONE_NO_WORLD_EVENTS) and without a map
	}
	now := s.cfg.Now()
	w := rift.Window(now.Unix())
	if w != s.rift.window {
		s.rift.window = w
		var keep []*riftPortal
		for _, p := range s.rift.portals {
			if p.Dev && now.Before(p.ends) {
				keep = append(keep, p)
			}
		}
		weight := func(x, z float64) float64 {
			_, t := s.riftAreaLevel(x, z)
			return rift.TierWeight(t)
		}
		n := constants.WorldSizeM / rift.AreaM
		picks := rift.Pick(rift.Candidates(s.cfg.Seed, w, constants.WorldSizeM, weight), func(c *rift.Candidate) bool {
			for k := 0; k < 4; k++ {
				x, z := c.X, c.Z
				if k > 0 {
					x, z = rift.Alt(s.cfg.Seed, w, c.Cell, n, k)
				}
				if s.eventSpotOK(x, z) {
					c.X, c.Z = x, z
					return true
				}
			}
			return false
		})
		for _, c := range picks {
			keep = append(keep, s.newPortal(c.X, c.Z, time.Unix(rift.WindowEnds(w), 0), false))
		}
		s.rift.portals = keep
		s.riftSendPortals(nil)
		if len(picks) > 0 {
			s.log.Info("rifts open", "window", w, "count", len(picks))
		}
	}
	// world-event announcements to players coming near
	for _, sess := range s.sessions {
		e := sess.ent
		if e == nil || e.riftID != 0 {
			continue
		}
		for _, p := range s.rift.portals {
			if p.told[e.CharacterID] || math.Hypot(e.Move.Pos.X-p.X, e.Move.Pos.Z-p.Z) > riftAnnounceM {
				continue
			}
			p.told[e.CharacterID] = true
			s.sendEvent(sess, &proto.Event{Kind: EventWorldEvent, EntityID: e.ID, TargetID: riftEventID(p.ID), Value: EventPhaseActive,
				X: cm(p.X), Y: cm(p.Y), Z: cm(p.Z), Data: s.riftEventData(p, now)})
		}
	}
}

// riftEventID keeps a rift's world-event id apart from content events'.
func riftEventID(id uint32) uint32 { return 0x70000000 | id }

func (s *Server) newPortal(x, z float64, ends time.Time, dev bool) *riftPortal {
	lvl, _ := s.riftAreaLevel(x, z)
	ch := rift.ChapterByN(rift.ChapterFor(lvl))
	s.rift.nextID++
	return &riftPortal{ID: s.rift.nextID, X: math.Round(x*100) / 100, Y: math.Round(s.cfg.Ground.HeightAt(x, z)*100) / 100, Z: math.Round(z*100) / 100,
		Chapter: ch.N, Name: ch.Name, Color: ch.Color, Level: max(lvl, ch.MinLevel), Dev: dev, ends: ends, told: map[string]bool{}}
}

func (s *Server) riftEventData(p *riftPortal, now time.Time) []byte {
	where := "nearby"
	if tw := s.cfg.Towns; tw != nil {
		best, bd := -1, math.Inf(1)
		for i := range tw.T.Settlements {
			if d := math.Hypot(tw.T.Settlements[i].X-p.X, tw.T.Settlements[i].Z-p.Z); d < bd {
				best, bd = i, d
			}
		}
		if best >= 0 {
			st := &tw.T.Settlements[best]
			where = quests.Where(st.X, st.Z, p.X, p.Z, s.settlementName(best))
		}
	}
	b, _ := json.Marshal(map[string]any{"id": riftEventID(p.ID), "kind": "rift", "name": "A rift: " + p.Name,
		"text": "A rift has torn open " + where + ". Press E at it to enter Chapter " + strconv.Itoa(p.Chapter) + " (50 rooms, level " + strconv.Itoa(p.Level) + ").",
		"phase": EventPhaseActive, "endsInMs": max(0, p.ends.Sub(now).Milliseconds()), "progress": -1, "x": p.X, "y": p.Y, "z": p.Z, "r": 6})
	return b
}

// riftSendPortals sends the open rifts to one player (nil: everyone).
func (s *Server) riftSendPortals(only *session) {
	now := s.cfg.Now()
	list := make([]riftPortal, 0, len(s.rift.portals))
	for _, p := range s.rift.portals {
		q := *p
		q.EndsMs = max(0, p.ends.Sub(now).Milliseconds())
		list = append(list, q)
	}
	b, _ := json.Marshal(list)
	for _, sess := range s.sessions {
		if sess.ent != nil && (only == nil || sess == only) {
			s.sendEvent(sess, &proto.Event{Kind: EventRiftPortals, EntityID: sess.ent.ID, Value: int32(len(list)), Data: b})
		}
	}
}

func (s *Server) riftJoin(sess *session) {
	s.riftInit()
	s.riftSendPortals(sess)
}

// RiftPortals is the open rifts (tests, debug).
func (s *Server) RiftPortals() []riftPortal {
	out := make([]riftPortal, 0, len(s.rift.portals))
	for _, p := range s.rift.portals {
		out = append(out, *p)
	}
	return out
}

// ---- entering, leaving ----

func (s *Server) handleRiftInteract(sess *session, m *proto.Interact) {
	s.riftInit()
	e := sess.ent
	if e == nil {
		return
	}
	switch m.Action {
	case RiftActEnter:
		if msg := s.riftEnter(sess, uint32(m.TargetID), 0); msg != "" {
			s.sendEvent(sess, &proto.Event{Kind: EventRiftLeft, EntityID: e.ID, Value: 0, Data: []byte(`{"refused":` + strconv.Quote(msg) + `}`)})
		}
	case RiftActPerk:
		if rr := s.rift.byPlayer[e.ID]; rr != nil {
			rr.run.Pick(e.ID, int(m.Arg), &riftHost{s: s, rr: rr})
		}
	case RiftActLeave:
		if rr := s.rift.byPlayer[e.ID]; rr != nil {
			rr.run.Leave(e.ID, rift.LeftDisconnect, &riftHost{s: s, rr: rr})
		}
	case RiftActBoard:
		s.riftSendBoard(sess, int(m.Arg))
		s.riftSendPortals(sess) // a client that hooked late asks this way too
	}
}

// riftEnter puts the player (and their party near the portal) into a run;
// a message says why not. stage > 1: the dev console's /rift go.
func (s *Server) riftEnter(sess *session, portalID uint32, stage int) string {
	e := sess.ent
	if s.rift.byPlayer[e.ID] != nil {
		return "You are already in a rift."
	}
	if e.cbt == nil || e.cbt.Downed {
		return "Not while you are down."
	}
	var p *riftPortal
	for _, q := range s.rift.portals {
		if q.ID == portalID {
			p = q
		}
	}
	if p == nil {
		return "That rift has closed."
	}
	if stage == 0 && (math.Hypot(e.Move.Pos.X-p.X, e.Move.Pos.Z-p.Z) > riftEnterM || math.Abs(e.Move.Pos.Y-p.Y) > 8) {
		return "Walk up to the rift first."
	}
	// A party member's run from this rift, still in its first room: join it.
	if e.PartyID != 0 {
		for _, rr := range s.rift.runs {
			if rr.portal.ID != p.ID {
				continue
			}
			for _, mm := range rr.run.Active() {
				if o := s.entityByID(mm.ID); o != nil && o.PartyID == e.PartyID {
					m := &rift.Member{ID: e.ID, Char: e.CharacterID, Name: e.Name}
					if rr.run.Join(m, &riftHost{s: s, rr: rr}) {
						s.riftSendStage(rr, sess)
						s.riftAttach(sess, rr, len(rr.run.Members)-1)
						s.riftNote(rr, 5, e.ID, nil)
						return ""
					}
				}
			}
		}
	}
	slot := -1
	for i, used := range s.rift.slots {
		if !used {
			slot = i
			break
		}
	}
	if slot < 0 {
		return "The rift is crowded; try again in a moment."
	}
	s.rift.slots[slot] = true
	s.rift.nextRun++
	id := s.rift.nextRun
	ch := rift.ChapterByN(p.Chapter)
	origin := movement.Vec3{X: p.X, Y: RiftBaseY + riftSlotStepY*float64(slot), Z: p.Z}
	rr := &riftRun{portal: *p, origin: origin, slot: slot, enemies: map[uint32]*combat.Enemy{}, pickups: map[uint32]*Entity{}, started: s.cfg.Now()}
	// the party near the portal comes along
	var sessions []*session
	sessions = append(sessions, sess)
	if e.PartyID != 0 {
		for _, o := range s.sessions {
			oe := o.ent
			if o == sess || oe == nil || oe.PartyID != e.PartyID || s.rift.byPlayer[oe.ID] != nil || oe.cbt == nil || oe.cbt.Downed {
				continue
			}
			if math.Hypot(oe.Move.Pos.X-p.X, oe.Move.Pos.Z-p.Z) <= riftPartyM {
				sessions = append(sessions, o)
			}
		}
	}
	var members []*rift.Member
	for _, o := range sessions {
		members = append(members, &rift.Member{ID: o.ent.ID, Char: o.ent.CharacterID, Name: o.ent.Name})
	}
	s.rift.runs[id] = rr
	for _, o := range sessions {
		s.riftAttachEarly(o, rr, id)
	}
	seed := uint32(items.Mix64(s.cfg.Seed ^ uint64(id)<<20 ^ uint64(s.tick)))
	rr.run = rift.NewRun(id, ch, p.Level, seed, members, max(1, stage), s.tick, &riftHost{s: s, rr: rr})
	s.log.Info("rift run", "run", id, "chapter", ch.N, "level", rr.run.Level, "players", len(members), "slot", slot, "stage", rr.run.Stage)
	return ""
}

// riftAttachEarly ties a session to run id before its first room is sent.
func (s *Server) riftAttachEarly(sess *session, rr *riftRun, id uint32) {
	s.rift.byPlayer[sess.ent.ID] = rr
	sess.ent.riftID = id
}

// riftAttach: a late joiner (the first room): the arena, then the entrance.
func (s *Server) riftAttach(sess *session, rr *riftRun, i int) {
	s.riftAttachEarly(sess, rr, rr.run.ID)
	setRiftG(sess, &riftGround{o: rr.origin, l: rr.layout})
	s.riftPlaceMember(rr, sess.ent, i)
}

// riftPlaceMember moves a player to the room's entrance.
func (s *Server) riftPlaceMember(rr *riftRun, e *Entity, i int) {
	n := len(rr.run.Active())
	x := (float64(i) - float64(n-1)/2) * 1.6
	s.Teleport(e, movement.Vec3{X: rr.origin.X + x, Y: rr.origin.Y + 0.02, Z: rr.origin.Z + rift.StartZ})
}

// riftLeave: a session closing while in a run (disconnect: the unbanked
// spoils are lost; the character is saved at the portal).
func (s *Server) riftLeave(sess *session) {
	if !s.rift.init || sess.ent == nil {
		return
	}
	if rr := s.rift.byPlayer[sess.ent.ID]; rr != nil {
		rr.run.Leave(sess.ent.ID, rift.LeftDisconnect, &riftHost{s: s, rr: rr})
	}
}

// riftSafePos is where a player in a run is saved: the portal's exit.
func (s *Server) riftSafePos(e *Entity) movement.Vec3 {
	if e.riftID != 0 {
		if rr := s.rift.runs[e.riftID]; rr != nil {
			return s.riftExit(rr)
		}
	}
	return e.Move.Pos
}

func (s *Server) riftExit(rr *riftRun) movement.Vec3 {
	x, z := rr.portal.X+2.5, rr.portal.Z+2.5
	return movement.Vec3{X: x, Y: s.cfg.Ground.HeightAt(x, z), Z: z}
}

// ---- the tick ----

func (s *Server) riftTick(tick uint32) {
	s.riftInit()
	if tick%30 == 0 {
		s.riftPortalsTick()
	}
	if len(s.rift.runs) == 0 {
		return
	}
	ids := make([]uint32, 0, len(s.rift.runs))
	for id := range s.rift.runs {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		rr := s.rift.runs[id]
		h := &riftHost{s: s, rr: rr}
		for _, m := range rr.run.Active() {
			e := s.entityByID(m.ID)
			if e == nil {
				rr.run.Leave(m.ID, rift.LeftDisconnect, h)
				continue
			}
			lx, ly, lz := e.Move.Pos.X-rr.origin.X, e.Move.Pos.Y-rr.origin.Y, e.Move.Pos.Z-rr.origin.Z
			m.X, m.Z = lx, lz
			m.In = math.Abs(lx) <= rift.HalfX+1 && math.Abs(lz) <= rift.HalfZ+1 && math.Abs(ly) < 6
			m.Dodging = e.Move.IFrames > 0
			if ly < -15 || ly > 60 {
				s.riftPlaceMember(rr, e, 0) // fell or flew out of the room: back to its entrance
			}
			if e.cbt != nil {
				e.cbt.SetRiftMods(combat.RiftMods{DamageMult: m.Mods.DamageMult, HealthMult: m.Mods.HealthMult})
			}
		}
		rr.run.Tick(tick, h)
		if rr.run.State == rift.StateEnded {
			s.riftCleanup(id, rr)
		}
	}
}

func (s *Server) riftCleanup(id uint32, rr *riftRun) {
	for eid, en := range rr.enemies {
		s.cbt.w.RemoveRiftEnemy(en)
		delete(s.rift.enemyRun, eid)
	}
	for _, p := range rr.pickups {
		s.removeEntity(p)
	}
	s.rift.slots[rr.slot] = false
	delete(s.rift.runs, id)
	s.log.Info("rift run over", "run", id, "stage", rr.run.Stage, "reason", rr.run.Reason)
}

// riftEnemyEntity tags a combat enemy's entity with its run (combat.go).
func (s *Server) riftTagOf(enemyID uint32) uint32 {
	if !s.rift.init {
		return 0
	}
	return s.rift.enemyRun[enemyID]
}

// ---- the host ----

type riftHost struct {
	s  *Server
	rr *riftRun
}

func (h *riftHost) world(x, z float64) movement.Vec3 {
	return movement.Vec3{X: h.rr.origin.X + x, Y: h.rr.origin.Y, Z: h.rr.origin.Z + z}
}

func (h *riftHost) Spawn(r *rift.Run, sp rift.Spawn, hp float64) uint32 {
	ch := r.Chapter
	key, name := "", sp.Arch.Name
	switch {
	case sp.Boss == 3 || sp.Arch.Body < 0:
		key = "crystal_golem"
		if sp.Boss == 3 {
			name = "Geode Golem"
		}
	case sp.Boss == 2:
		key, name = ch.BossBody, ch.Boss
	case sp.Boss == 1:
		key, name = ch.Bodies[2], ch.MiniBoss[(r.Stage/rift.BossEvery-1)%4]
	default:
		key = ch.Bodies[sp.Arch.Body]
	}
	en := h.s.cbt.w.RiftEnemy(h.world(sp.X, sp.Z), key, r.Level, sp.Elite || sp.Boss > 0, hp)
	if en == nil {
		return 0
	}
	en.Name = name
	h.rr.enemies[en.ID] = en
	h.s.rift.enemyRun[en.ID] = r.ID
	return en.ID
}

func (h *riftHost) EnemyHP(id uint32) float64 {
	en := h.rr.enemies[id]
	if en == nil || !en.Alive() || en.HPMax <= 0 {
		return 0
	}
	return en.HP / en.HPMax
}

func (h *riftHost) MoveEnemy(r *rift.Run, id uint32, x, z float64) {
	if en := h.rr.enemies[id]; en != nil && en.Alive() {
		h.s.cbt.w.PlaceEnemy(en, h.world(x, z))
	}
}

func (h *riftHost) Remove(id uint32) {
	if en := h.rr.enemies[id]; en != nil {
		h.s.cbt.w.RemoveRiftEnemy(en)
		delete(h.rr.enemies, id)
		delete(h.s.rift.enemyRun, id)
	}
}

func (h *riftHost) HP(m *rift.Member) (float64, float64) { return h.s.cbt.w.PlayerHP(m.ID) }

func (h *riftHost) Hurt(r *rift.Run, m *rift.Member, src uint32, dmg float64, kind int) bool {
	return h.s.cbt.w.HurtPlayerRift(m.ID, dmg)
}

func (h *riftHost) Heal(m *rift.Member, amount float64) { h.s.cbt.w.HealPlayer(m.ID, amount) }

func (h *riftHost) Out(r *rift.Run, o rift.Out) { h.s.riftOut(h.rr, r, o) }

// ---- outputs ----

func (s *Server) riftSessions(rr *riftRun) []*session {
	var out []*session
	for _, m := range rr.run.Members {
		if m.Left != 0 {
			continue
		}
		if e := s.entityByID(m.ID); e != nil {
			if sess := s.byChar[e.CharacterID]; sess != nil {
				out = append(out, sess)
			}
		}
	}
	return out
}

func (s *Server) riftSessOf(id uint32) *session {
	if e := s.entityByID(id); e != nil {
		return s.byChar[e.CharacterID]
	}
	return nil
}

func (s *Server) riftOut(rr *riftRun, r *rift.Run, o rift.Out) {
	if rr.run == nil {
		rr.run = r // NewRun's first room arrives before NewRun returns
	}
	switch o.Kind {
	case rift.OutStage:
		rr.layout = &r.Layout
		s.riftSweep(rr, 0)
		for i, sess := range s.riftSessions(rr) {
			s.riftSendStage(rr, sess)
			setRiftG(sess, &riftGround{o: rr.origin, l: rr.layout})
			s.riftPlaceMember(rr, sess.ent, i)
		}
	case rift.OutVolley:
		data := encodeVolley(o.V, o.Enemy)
		for _, sess := range s.riftSessions(rr) {
			s.sendEvent(sess, &proto.Event{Kind: EventRiftVolley, EntityID: sess.ent.ID, TargetID: o.V.ID, Value: int32(r.ID), Data: data})
		}
	case rift.OutClear:
		for _, sess := range s.riftSessions(rr) {
			s.sendEvent(sess, &proto.Event{Kind: EventRiftClear, EntityID: sess.ent.ID, TargetID: r.ID, Value: int32(o.N)})
		}
	case rift.OutDoor:
		for _, sess := range s.riftSessions(rr) {
			s.sendEvent(sess, &proto.Event{Kind: EventRiftDoor, EntityID: sess.ent.ID, TargetID: r.ID, Value: int32(o.N)})
		}
	case rift.OutPerkOffer:
		if sess := s.riftSessOf(o.Member); sess != nil {
			type card struct {
				I    int    `json:"i"`
				Key  string `json:"key"`
				Name string `json:"name"`
				Text string `json:"text"`
				Have int    `json:"have"`
			}
			m := r.Member(o.Member)
			var cards []card
			for _, p := range o.Perks {
				cards = append(cards, card{p, rift.Perks[p].Key, rift.Perks[p].Name, rift.Perks[p].Text, m.Perks[rift.Perks[p].Key]})
			}
			b, _ := json.Marshal(map[string]any{"stage": r.Stage, "seconds": o.N, "cards": cards})
			s.sendEvent(sess, &proto.Event{Kind: EventRiftPerks, EntityID: sess.ent.ID, TargetID: r.ID, Value: int32(r.Stage), Data: b})
		}
	case rift.OutPerkTaken:
		for _, sess := range s.riftSessions(rr) {
			s.sendEvent(sess, &proto.Event{Kind: EventRiftPerk, EntityID: sess.ent.ID, TargetID: o.Member, Value: int32(o.Perk)})
		}
	case rift.OutReward:
		s.riftReward(rr, r, o)
	case rift.OutGems:
		if sess := s.riftSessOf(o.Member); sess != nil {
			s.riftGems(rr, sess, o.N, o.X, o.Z, "gems:"+strconv.Itoa(int(r.Now)), 1.3)
		}
	case rift.OutBank:
		if sess := s.riftSessOf(o.Member); sess != nil && o.N > 0 {
			marker := "rift:" + strconv.FormatUint(uint64(r.ID), 16) + ":" + strconv.FormatUint(uint64(r.Seed), 16) + ":bank:" + strconv.Itoa(r.Stage) + ":" + sess.ent.CharacterID
			s.questGrant(sess, []quests.ItemQty{{Item: "currency:gold", Qty: o.N}}, marker, "rift spoils")
			s.sendEvent(sess, &proto.Event{Kind: EventRiftBank, EntityID: sess.ent.ID, TargetID: r.ID, Value: int32(o.N)})
		}
	case rift.OutLeft:
		s.riftMemberLeft(rr, r, o)
	case rift.OutWard, rift.OutGraze:
		v := int32(1)
		if o.Kind == rift.OutGraze {
			v = 2
			s.cbt.w.AddMana(o.Member, 3)
		}
		if sess := s.riftSessOf(o.Member); sess != nil {
			s.sendEvent(sess, &proto.Event{Kind: EventRiftNote, EntityID: sess.ent.ID, TargetID: o.Member, Value: v})
		}
	case rift.OutPhase:
		s.riftNote(rr, 4, o.Enemy, []byte{byte(o.N)})
	case rift.OutEnd:
		for _, m := range r.Members {
			if sess := s.riftSessOf(m.ID); sess != nil {
				s.sendEvent(sess, &proto.Event{Kind: EventRiftEnd, EntityID: sess.ent.ID, TargetID: r.ID, Value: int32(o.Reason)})
			}
		}
	}
}

func (s *Server) riftNote(rr *riftRun, v int32, target uint32, data []byte) {
	for _, sess := range s.riftSessions(rr) {
		s.sendEvent(sess, &proto.Event{Kind: EventRiftNote, EntityID: sess.ent.ID, TargetID: target, Value: v, Data: data})
	}
}

// riftSendStage tells one player the room (JSON; the client builds the
// same layout from chapter + stage: client/src/rift/layout.ts).
func (s *Server) riftSendStage(rr *riftRun, sess *session) {
	r := rr.run
	type foe struct {
		ID   uint32 `json:"id"`
		Name string `json:"name"`
		Boss int    `json:"boss,omitempty"`
		Kind int    `json:"kind"`
	}
	var foes []foe
	for _, en := range r.Enemies {
		foes = append(foes, foe{en.ID, s.riftEnemyName(rr, en.ID), en.Spawn.Boss, en.Spawn.Arch.Kind})
	}
	type mem struct {
		ID     uint32         `json:"id"`
		Name   string         `json:"name"`
		Perks  map[string]int `json:"perks"`
		Spoils int            `json:"spoils"`
		Banked int            `json:"banked"`
	}
	var mems []mem
	for _, m := range r.Active() {
		mems = append(mems, mem{m.ID, m.Name, m.Perks, m.Spoils, m.Banked})
	}
	b, _ := json.Marshal(map[string]any{"run": r.ID, "chapter": r.Chapter.N, "chapterName": r.Chapter.Name, "color": r.Chapter.Color,
		"stage": r.Stage, "stages": rift.Stages, "kind": r.Kind, "kindName": rift.StageKindNames[r.Kind], "level": r.Level,
		"ox": proto.MetersToCm(rr.origin.X), "oy": proto.MetersToCm(rr.origin.Y), "oz": proto.MetersToCm(rr.origin.Z),
		"startTick": r.Started, "tick": s.tick, "foes": foes, "members": mems, "checkpoint": rift.Checkpoint(r.Stage), "portal": rr.portal.ID})
	s.sendEvent(sess, &proto.Event{Kind: EventRiftStage, EntityID: sess.ent.ID, TargetID: r.ID, Value: int32(r.Stage), Data: b})
}

func (s *Server) riftEnemyName(rr *riftRun, id uint32) string {
	if en := rr.enemies[id]; en != nil {
		return en.Name
	}
	return ""
}

// encodeVolley is Event 2002's data: u8 kind | u32 fire tick | u16 wind-up
// ms | i16 origin x cm | i16 origin z cm (arena-local) | u16 angle (u16
// turn) | u8 count | u16 speed cm/s | u8 core radius cm | i32 p1 | i32 p2 |
// i32 p3 | u32 seed | u16 life ms | u32 source enemy id.
func encodeVolley(v *rift.Volley, src uint32) []byte {
	b := make([]byte, 0, 40)
	b = append(b, uint8(v.Kind))
	b = binary.LittleEndian.AppendUint32(b, v.Fire)
	b = binary.LittleEndian.AppendUint16(b, uint16(v.Windup))
	b = binary.LittleEndian.AppendUint16(b, uint16(int16(math.Round(v.OX*100))))
	b = binary.LittleEndian.AppendUint16(b, uint16(int16(math.Round(v.OZ*100))))
	b = binary.LittleEndian.AppendUint16(b, rift.AngleU16(v.Angle))
	b = append(b, uint8(v.Count))
	b = binary.LittleEndian.AppendUint16(b, uint16(math.Round(v.Speed*100)))
	b = append(b, uint8(math.Round(v.Radius*100)))
	b = binary.LittleEndian.AppendUint32(b, uint32(int32(v.P1)))
	b = binary.LittleEndian.AppendUint32(b, uint32(int32(v.P2)))
	b = binary.LittleEndian.AppendUint32(b, uint32(int32(v.P3)))
	b = binary.LittleEndian.AppendUint32(b, v.Seed)
	b = binary.LittleEndian.AppendUint16(b, uint16(math.Round(v.Life*1000)))
	b = binary.LittleEndian.AppendUint32(b, src)
	return b
}

// riftReward rolls a player's stage reward: items into the room (personal
// pickups by the door), gems, the gold that went into the spoils.
func (s *Server) riftReward(rr *riftRun, r *rift.Run, o rift.Out) {
	sess := s.riftSessOf(o.Member)
	if sess == nil || sess.ent == nil {
		return
	}
	e := sess.ent
	lo := o.Loot
	seed := items.Mix64(uint64(r.Seed)<<32 ^ uint64(r.Stage)<<8 ^ hashString(e.CharacterID))
	rng := items.NewRNG(seed)
	n := lo.Items
	if lo.Chance > 0 && rng.Float() < lo.Chance {
		n++
	}
	now := s.cfg.Now()
	var names []string
	for i := 0; i < n; i++ {
		ro := items.Rolled{Level: r.Level, Element: -1, Luck: lo.Luck, MinRarity: lo.MinRarity}
		if r.Kind == rift.StageGemGolem {
			ro.Kind, ro.MinSock = "weapon", 3 // the golem's heart: every socket the base has
		}
		it := items.RollEquipment(rng, ro)
		it.Seed = int64(seed) + int64(i)
		it.Prov = []items.Prov{{Ev: "rolled", Char: e.CharacterID, Name: e.Name, Src: "rift " + r.Chapter.Key, At: now.UnixMilli(), Local: sess.items != nil && sess.items.persist == persistLocal}}
		x := (float64(i) - float64(n-1)/2) * 1.4
		s.riftDrop(rr, e, it, x, o.Z, "rift:"+strconv.FormatUint(uint64(r.ID), 16)+":"+strconv.FormatUint(uint64(r.Seed), 16)+":"+strconv.Itoa(r.Stage)+":"+strconv.Itoa(i))
		names = append(names, it.Base)
	}
	if lo.Gems > 0 {
		s.riftGems(rr, sess, lo.Gems, 0, o.Z+1.5, "reward:"+strconv.Itoa(r.Stage), lo.Luck)
	}
	m := r.Member(o.Member)
	b, _ := json.Marshal(map[string]any{"stage": r.Stage, "gold": lo.Gold, "spoils": m.Spoils, "banked": m.Banked, "items": names, "gems": lo.Gems, "luck": math.Round(lo.Luck*100) / 100, "minRarity": lo.MinRarity})
	s.sendEvent(sess, &proto.Event{Kind: EventRiftReward, EntityID: e.ID, TargetID: r.ID, Value: int32(lo.Gold), Data: b})
}

// riftGems drops n rolled gems around arena-local (x, z) for one player.
func (s *Server) riftGems(rr *riftRun, sess *session, n int, x, z float64, salt string, luck float64) {
	r := rr.run
	e := sess.ent
	rng := items.NewRNG(items.Mix64(uint64(r.Seed) ^ hashString(e.CharacterID+salt)))
	for i := 0; i < n; i++ {
		g := items.RollGem(rng, -1, luck)
		if g == nil {
			continue
		}
		a := float64(i) * 2.39996
		d := 0.5 + 0.35*math.Sqrt(float64(i))
		gx := math.Max(-rift.HalfX+0.6, math.Min(rift.HalfX-0.6, x+math.Cos(a)*d))
		gz := math.Max(-rift.HalfZ+0.6, math.Min(rift.HalfZ-0.6, z+math.Sin(a)*d))
		s.riftDrop(rr, e, g, gx, gz, "rift:"+strconv.FormatUint(uint64(r.ID), 16)+":"+strconv.FormatUint(uint64(r.Seed), 16)+":"+salt+":"+strconv.Itoa(i))
	}
}

func (s *Server) riftDrop(rr *riftRun, owner *Entity, it *items.Item, x, z float64, key string) {
	pos := movement.Vec3{X: rr.origin.X + x, Y: rr.origin.Y + 0.15, Z: rr.origin.Z + z}
	p := s.spawnDrop(owner.ID, it, pos, &itemDrop{key: key, source: SourceContent, readyAt: s.cfg.Now().Add(800 * time.Millisecond)}, s.cfg.Now().Add(riftPickupLife))
	p.riftID = rr.run.ID
	rr.pickups[p.ID] = p
}

// riftSweep: what a player left lying in the room goes into the bag (a
// full bag: it stays behind and is lost) when the room changes or they
// leave. owner 0: everyone's.
func (s *Server) riftSweep(rr *riftRun, owner uint32) {
	ids := make([]uint32, 0, len(rr.pickups))
	for id := range rr.pickups {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		p := rr.pickups[id]
		if owner != 0 && p.Owner != owner {
			continue
		}
		delete(rr.pickups, id)
		if s.entityByID(p.ID) == nil {
			continue // taken
		}
		if o := s.entityByID(p.Owner); o != nil && p.drop != nil {
			p.drop.readyAt = time.Time{}
			p.drop.refused = time.Time{}
			s.takeDrop(o, p)
		}
		s.removeEntity(p)
	}
}

func (s *Server) riftMemberLeft(rr *riftRun, r *rift.Run, o rift.Out) {
	e := s.entityByID(o.Member)
	delete(s.rift.byPlayer, o.Member)
	m := r.Member(o.Member)
	if e == nil || m == nil {
		return
	}
	s.riftSweep(rr, e.ID)
	e.riftID = 0
	sess := s.byChar[e.CharacterID]
	if sess != nil {
		setRiftG(sess, nil)
	}
	if e.cbt != nil {
		if e.cbt.Downed {
			s.cbt.w.Revive(e.ID, 0.5)
		}
		e.cbt.SetRiftMods(combat.RiftMods{})
		syncPlayerHealth(e)
	}
	s.Teleport(e, s.riftExit(rr))
	ms := s.cfg.Now().Sub(rr.started).Milliseconds()
	if m.Best > 0 {
		s.riftRecord(r.Chapter.N, e.CharacterID, e.Name, m.Best, ms)
	}
	if sess != nil {
		b, _ := json.Marshal(map[string]any{"reason": o.Reason, "best": m.Best, "banked": m.Banked, "chapter": r.Chapter.N, "chapterName": r.Chapter.Name, "stage": r.Stage, "perks": m.Perks, "ms": ms})
		s.sendEvent(sess, &proto.Event{Kind: EventRiftLeft, EntityID: e.ID, TargetID: r.ID, Value: int32(o.Reason), Data: b})
		s.riftSendPortals(sess)
		if sess.cnt != nil && m.Best > 0 {
			sess.cnt.st.Add("rift_rooms", m.Best)
			sess.cnt.recheck = true
		}
	}
	s.log.Info("rift left", "run", r.ID, "entity", e.ID, "reason", o.Reason, "best", m.Best, "banked", m.Banked)
}

// ---- the leaderboard ----

func (s *Server) riftRecord(chapter int, char, name string, stage int, ms int64) {
	b := s.rift.board[chapter]
	i := -1
	for k := range b {
		if b[k].Char == char {
			i = k
		}
	}
	if i >= 0 {
		if stage < b[i].Stage || (stage == b[i].Stage && ms >= b[i].Ms) {
			return
		}
		b[i] = RiftBest{char, name, stage, ms}
	} else {
		b = append(b, RiftBest{char, name, stage, ms})
	}
	sort.SliceStable(b, func(i, j int) bool {
		if b[i].Stage != b[j].Stage {
			return b[i].Stage > b[j].Stage
		}
		return b[i].Ms < b[j].Ms
	})
	if len(b) > 20 {
		b = b[:20]
	}
	s.rift.board[chapter] = b
	if st, ok := s.cfg.Store.(RiftStore); ok && s.cfg.Queue != nil {
		world := s.cfg.WorldID
		s.cfg.Queue.Enqueue(writebehind.Op{Key: "rift:" + strconv.Itoa(chapter) + ":" + char, Run: func(ctx context.Context) error {
			return st.SaveRiftBest(ctx, world, chapter, char, name, stage, ms)
		}})
	}
}

func (s *Server) riftLoadBoard() {
	st, ok := s.cfg.Store.(RiftStore)
	if !ok {
		return
	}
	world := s.cfg.WorldID
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		loaded := map[int][]RiftBest{}
		for c := 1; c <= len(rift.Chapters); c++ {
			rows, err := st.LoadRiftBoard(ctx, world, c, 20)
			if err != nil {
				s.log.Warn("rift leaderboard load failed", "err", err)
				return
			}
			loaded[c] = rows
		}
		_ = s.Do(ctx, func() {
			for c, rows := range loaded {
				for _, r := range rows {
					s.riftRecordMem(c, r)
				}
			}
		})
	}()
}

func (s *Server) riftRecordMem(chapter int, r RiftBest) {
	b := s.rift.board[chapter]
	for _, x := range b {
		if x.Char == r.Char {
			return
		}
	}
	b = append(b, r)
	sort.SliceStable(b, func(i, j int) bool {
		if b[i].Stage != b[j].Stage {
			return b[i].Stage > b[j].Stage
		}
		return b[i].Ms < b[j].Ms
	})
	s.rift.board[chapter] = b
}

func (s *Server) riftSendBoard(sess *session, chapter int) {
	type row struct {
		Chapter int        `json:"chapter"`
		Name    string     `json:"name"`
		Rows    []RiftBest `json:"rows"`
		You     int        `json:"you"`
	}
	var out []row
	for c := 1; c <= len(rift.Chapters); c++ {
		if chapter != 0 && c != chapter {
			continue
		}
		rows := s.rift.board[c]
		you := 0
		for _, x := range rows {
			if x.Char == sess.ent.CharacterID {
				you = x.Stage
			}
		}
		if len(rows) > 10 {
			rows = rows[:10]
		}
		out = append(out, row{c, rift.Chapters[c-1].Name, rows, you})
	}
	b, _ := json.Marshal(out)
	s.sendEvent(sess, &proto.Event{Kind: EventRiftBoard, EntityID: sess.ent.ID, Value: int32(chapter), Data: b})
}

// RiftBoard is a chapter's leaderboard (tests).
func (s *Server) RiftBoard(chapter int) []RiftBest { return s.rift.board[chapter] }

// ---- the arena's ground (client twin: client/src/rift/riftGround.ts) ----

// riftGround is a player's movement ground while in a run: at the arena's
// level a flat floor with the room's walls, pillars and pools; elsewhere
// the world's ground unchanged.
type riftGround struct {
	inner movement.Ground
	o     movement.Vec3
	l     *rift.Layout
	lvl   riftLevel
}

type riftLevel struct {
	o movement.Vec3
	l *rift.Layout
}

func (g *riftGround) HeightAt(x, z float64) float64 { return g.inner.HeightAt(x, z) }
func (g *riftGround) WaterAt(x, z float64) float64  { return movement.WaterAt(g.inner, x, z) }
func (g *riftGround) AtLevel(y float64) movement.Ground {
	if y > g.o.Y-30 && y < g.o.Y+200 {
		g.lvl = riftLevel{o: g.o, l: g.l}
		return &g.lvl
	}
	return movement.AtLevel(g.inner, y)
}

func (l *riftLevel) HeightAt(_, _ float64) float64 { return l.o.Y }
func (l *riftLevel) WaterAt(_, _ float64) float64  { return math.Inf(-1) }
func (l *riftLevel) Collide(x, y, z float64) movement.CollideResult {
	lx, lz := x-l.o.X, z-l.o.Z
	cx, cz := l.l.Collide(lx, lz)
	if cx == lx && cz == lz {
		return movement.CollideResult{X: x, Y: y, Z: z}
	}
	return movement.CollideResult{X: l.o.X + cx, Y: y, Z: l.o.Z + cz, PushX: cx - lx, PushZ: cz - lz}
}

// viewGround is the ground an entity's view extrapolates on (the arena
// while in a rift; riftG.inner is set by riftWrap for its frames).
func (e *Entity) viewGround(g movement.Ground) movement.Ground {
	if e.riftG != nil {
		return &riftGround{inner: g, o: e.riftG.o, l: e.riftG.l}
	}
	return g
}

// riftWrap: a player in a run steps on the arena.
func (s *Server) riftWrap(sess *session, g movement.Ground) movement.Ground {
	rg := sess.riftG
	if rg == nil {
		return g
	}
	rg.inner = g
	return rg
}

// riftEnv: no weather in a rift (the client does the same).
func (s *Server) riftEnv(sess *session, env movement.Env) movement.Env {
	if sess.riftG != nil {
		env.Weather = nil
		env.Raining = false
		env.Updraft = nil
	}
	return env
}

// setRiftG sets (nil: clears) a player's arena ground for their frames and view.
func setRiftG(sess *session, g *riftGround) {
	sess.riftG = g
	if sess.ent != nil {
		sess.ent.riftG = g
	}
}

// SaveRiftBest implements RiftStore (migration 0030): a character's best,
// kept only when it beats the stored one.
func (p *PGStore) SaveRiftBest(ctx context.Context, worldID string, chapter int, id, name string, stage int, ms int64) error {
	if !uuidRe.MatchString(id) {
		return nil // dev tickets and bots: memory only
	}
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO rift_best (world_id, chapter, character_id, name, stage, ms, updated_at) VALUES ($1, $2, $3, $4, $5, $6, now())
		ON CONFLICT (world_id, chapter, character_id) DO UPDATE SET name = EXCLUDED.name, stage = EXCLUDED.stage, ms = EXCLUDED.ms, updated_at = now()
		WHERE rift_best.stage < EXCLUDED.stage OR (rift_best.stage = EXCLUDED.stage AND rift_best.ms > EXCLUDED.ms)`, worldID, chapter, id, name, stage, ms)
	return err
}

// LoadRiftBoard implements RiftStore: a chapter's best rows.
func (p *PGStore) LoadRiftBoard(ctx context.Context, worldID string, chapter, limit int) ([]RiftBest, error) {
	rows, err := p.Pool.Query(ctx, `SELECT character_id, name, stage, ms FROM rift_best WHERE world_id = $1 AND chapter = $2 ORDER BY stage DESC, ms ASC LIMIT $3`, worldID, chapter, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RiftBest
	for rows.Next() {
		var b RiftBest
		var st int16
		if err := rows.Scan(&b.Char, &b.Name, &st, &b.Ms); err != nil {
			return nil, err
		}
		b.Stage = int(st)
		out = append(out, b)
	}
	return out, rows.Err()
}
