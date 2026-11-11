package game

// Exploration in the zone (WP12): per-character progress loaded at login
// (Postgres for accounts, the signed save blob for local profiles), the
// proximity rules run from the tick (tower tops, waypoint touches,
// discoveries), fast travel and map pins over Interact, Events back to the
// client (contracts/events.md 600-699), saves through the write-behind
// queue, and the party ring fed from the social service's Redis party
// records. The rules themselves live in internal/explore (pure, unit-tested);
// this file is the glue to sessions, the wire and persistence.

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"time"

	"lodestone/server/pkg/localsave"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/ticket"
	"lodestone/server/pkg/writebehind"
	"lodestone/server/zone/internal/explore"
)

// Event kinds (contracts/events.md, WP12 range 600-699; teleport is core).
const (
	EventTeleport         = 2
	EventTowerUnlocked    = 600
	EventWaypoint         = 601
	EventDiscovery        = 602
	EventProgress         = 603
	EventLevelUp          = 604
	EventPins             = 605
	EventFastTravelDenied = 606
	EventParty            = 607
	EventRespawnPoint     = 608
)

// Interact registry (contracts/events.md "Interact"): targetKind selects the
// owner, action the verb.
const (
	InteractSite = 10 // targetId = atlas site index
	InteractPin  = 11 // targetId = PackPinPos(x cm, z cm)

	ActionFastTravel = 1 // InteractSite

	ActionPinSet        = 1 // InteractPin: arg = slot | color << 8
	ActionPinClear      = 2 // arg = slot
	ActionPartyPinSet   = 3 // arg = color
	ActionPartyPinClear = 4
)

const (
	// exploreEveryTicks: proximity checks at 10 Hz per player (staggered).
	// At 7.8 m/s sprint that is 0.8 m between checks, well inside the 3 m
	// waypoint touch radius.
	exploreEveryTicks = 3
	// fastTravelCooldown stops a client from bouncing between points every
	// tick (each hop costs every observer a teleport and the chunk cache a
	// cold area).
	fastTravelCooldown = 2 * time.Second
	// localSaveEvery: a local profile's blob is re-issued at most this often
	// while its progress changes (each issue is a Redis round trip and a
	// signed blob of a few KB down the wire), plus at the normal checkpoint.
	localSaveEvery = 5 * time.Second
	// localMoveSaveM: a local profile who walked this far since its last
	// blob gets a new one at the next checkpoint (playtest 2: the position
	// only rode along with other progress, so any reconnect, zone restart
	// or reload put a player who had only walked back at their spawn).
	localMoveSaveM = 2.0
	// partyPinTTL: party pins live with the party record in Redis; they
	// expire a while after the last change so abandoned parties don't
	// leave keys behind forever.
	partyPinTTL = 6 * time.Hour
)

// exploreState is one character's exploration state, shared by its session
// and entity (tick-owned after join).
type exploreState struct {
	prog       *explore.Progress
	local      *localSaveState // local profiles with a verified blob
	readOnly   bool            // local blob failed verification: never issue over it
	lastTravel time.Time
	partyKey   string
	lastIssue  time.Time
	issued     bool // a blob issue is queued since the last change
	// Event 609 (party_travel.go): the lent towers last sent.
	partySent     explore.Bitset
	partySentOnce bool
}

// localSaveState is what a local profile's next blob is built from.
type localSaveState struct {
	profileID string
	state     localsave.State
}

// ProgressStore is the optional persistence of exploration progress
// (PGStore implements it). Reads on the connection goroutine at login;
// writes from the write-behind queue.
type ProgressStore interface {
	LoadProgress(ctx context.Context, characterID string, sites []uint64) (*explore.Progress, bool, error)
	SaveProgress(ctx context.Context, characterID string, snap ProgressSnapshot) error
}

// ProgressSnapshot is an immutable copy of Progress for an off-tick save.
type ProgressSnapshot struct {
	Level        int
	XP           int64
	LastWaypoint *int64 // atlas site stable id as int64 bits, nil none
	Towers       []byte
	Waypoints    []byte
	Discoveries  []byte
	Attuned      []byte // playtest 1 (migration 0021)
	Pins         []byte // JSON
	Epoch        int64  // WP16: owner epoch; > 0 fences the write (persist.go)
}

func (s *Server) snapshotProgress(p *explore.Progress) ProgressSnapshot {
	snap := ProgressSnapshot{Level: p.Level, XP: p.XP, Pins: p.PinsJSON(),
		Towers: append([]byte(nil), p.Towers...), Waypoints: append([]byte(nil), p.Waypoints...), Discoveries: append([]byte(nil), p.Discoveries...), Attuned: append([]byte(nil), p.Attuned...)}
	if w := s.cfg.Explore; w != nil && p.LastWaypoint >= 0 && p.LastWaypoint < len(w.Atlas.Sites) {
		id := int64(w.Atlas.Sites[p.LastWaypoint].ID)
		snap.LastWaypoint = &id
	}
	return snap
}

func (s *Server) siteIDs() []uint64 {
	if s.cfg.Explore == nil {
		return nil
	}
	ids := make([]uint64, len(s.cfg.Explore.Atlas.Sites))
	for i, st := range s.cfg.Explore.Atlas.Sites {
		ids[i] = st.ID
	}
	return ids
}

// loadExplore runs on the connection goroutine before the session joins:
// progress from the save blob (local profiles) or Postgres (accounts). A
// local blob that verifies also supplies the spawn position.
func (s *Server) loadExplore(c ticket.Claims, blob []byte, spawn *movement.Vec3, hinted bool) *exploreState {
	x := &exploreState{prog: explore.NewProgress()}
	if s.cfg.Explore == nil {
		return x
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if c.IsLocalProfile {
		s.loadLocalSave(ctx, c, blob, x, spawn, hinted)
		return x
	}
	ps, ok := s.cfg.Store.(ProgressStore)
	if !ok || s.cfg.Store == nil {
		return x
	}
	p, found, err := ps.LoadProgress(ctx, c.CharacterID, s.siteIDs())
	switch {
	case err != nil:
		s.log.Warn("load progress failed; starting from empty progress (not saved over)", "character", c.CharacterID, "err", err)
		// Saving an empty progress over a row we failed to read would wipe
		// it: treat the session as read-only for progress.
		x.readOnly = true
	case found:
		x.prog = p
	}
	return x
}

func (s *Server) loadLocalSave(ctx context.Context, c ticket.Claims, raw []byte, x *exploreState, spawn *movement.Vec3, hinted bool) {
	if s.cfg.Saves == nil || len(raw) == 0 {
		return
	}
	var b localsave.Blob
	err := json.Unmarshal(raw, &b)
	if err == nil && (b.CharacterID != c.CharacterID || b.ProfileID != c.ProfileID || b.WorldID != s.cfg.WorldID) {
		err = errors.New("blob belongs to another character, profile or world")
	}
	if err == nil {
		err = s.cfg.Saves.Verify(ctx, b)
	}
	var st localsave.State
	if err == nil {
		st, err = b.DecodeState()
	}
	if err != nil {
		// Never issue over a blob we couldn't verify: a newer one may exist
		// on another device, and overwriting it would lose that progress.
		s.log.Warn("local save rejected; progress this session is not saved", "character", c.CharacterID, "err", err)
		x.readOnly = true
		return
	}
	p := explore.NewProgress()
	p.Level, p.XP = max(1, st.Level), st.XP
	p.Towers, p.Waypoints, p.Discoveries = st.Progress.Towers, st.Progress.Waypoints, st.Progress.Discoveries
	p.Attuned = st.Progress.Attuned // playtest 1
	p.LoadPinsJSON(st.Progress.Pins)
	if st.LastWaypoint != nil {
		p.LastWaypoint = s.siteIndexOf(uint64(*st.LastWaypoint))
	}
	x.prog = p
	x.local = &localSaveState{profileID: c.ProfileID, state: st}
	if !hinted && (st.Position != localsave.Vec3{}) {
		*spawn = s.savedSpawn(c.CharacterID, movement.Vec3{X: st.Position.X, Y: st.Position.Y, Z: st.Position.Z})
	}
}

func (s *Server) siteIndexOf(id uint64) int {
	if s.cfg.Explore == nil {
		return -1
	}
	for i := range s.cfg.Explore.Atlas.Sites {
		if s.cfg.Explore.Atlas.Sites[i].ID == id {
			return i
		}
	}
	return -1
}

// sendEvent queues one reliable Event for a session (never blocks).
func (s *Server) sendEvent(sess *session, ev *proto.Event) {
	if err := sess.conn.SendReliable(proto.Encode(ev)); err != nil {
		sess.closed.Store(true)
	}
}

func cm(v float64) int32 { return proto.MetersToCm(v) }

// exploreJoin sends the newly joined player their progress, pins and party
// (tick goroutine, right after Welcome).
func (s *Server) exploreJoin(sess *session) {
	if sess.x == nil {
		sess.x = &exploreState{prog: explore.NewProgress()}
	}
	sess.ent.x = sess.x
	sess.ent.Level = uint8(min(255, max(1, sess.x.prog.Level)))
	if s.cfg.Explore == nil {
		return
	}
	s.sendProgress(sess)
	s.sendPins(sess)
	if sess.x.readOnly && sess.claims.IsLocalProfile && s.cfg.Saves != nil {
		s.sendEvent(sess, &proto.Event{Kind: 1, EntityID: sess.ent.ID, Data: []byte("Your local save could not be verified: progress made this session will not be saved.")})
	}
}

func (s *Server) sendProgress(sess *session) {
	p := sess.x.prog
	s.sendEvent(sess, &proto.Event{Kind: EventProgress, EntityID: sess.ent.ID, Value: int32(p.Level),
		Data: explore.EncodeProgress(p, s.cfg.Explore.RevealedRegions(p))})
}

// exploreTick runs the proximity rules (10 Hz per player, staggered) and
// publishes the character list the party poller reads.
func (s *Server) exploreTick(tick uint32) {
	s.partyTick(tick)
	s.partyTowersTick(tick) // co-op polish: Event 609 (party_travel.go)
	w := s.cfg.Explore
	if w == nil {
		return
	}
	for _, sess := range s.sessions {
		e := sess.ent
		if e == nil || e.x == nil || (tick+e.ID)%exploreEveryTicks != 0 {
			continue
		}
		x := e.x
		s.hap = w.Check(x.prog, e.Move.Pos, s.hap[:0])
		if len(s.hap) == 0 {
			continue
		}
		levelBefore := int(e.Level)
		for _, h := range s.hap {
			s.announce(sess, h)
		}
		if x.prog.Level != levelBefore {
			s.levelChanged(sess, levelBefore) // playtest 1: 604 + stats, refill (progression.go)
		}
		s.sendProgress(sess)
		s.saveProgressSoon(sess, false)
	}
}

// announce turns one Happening into its Event (and a log line: these are
// rare and useful when reading a playtest).
func (s *Server) announce(sess *session, h explore.Happening) {
	w := s.cfg.Explore
	site := &w.Atlas.Sites[h.Site]
	name := site.Name
	if name == "" && site.Link >= 0 && site.Link < len(w.Atlas.Sites) {
		name = w.Atlas.Sites[site.Link].Name // a settlement's waypoint takes the settlement's name (worldgen README)
	}
	ev := &proto.Event{EntityID: sess.ent.ID, TargetID: uint32(h.Site), X: cm(site.X), Y: cm(site.Y), Z: cm(site.Z), Data: []byte(name)}
	switch h.Kind {
	case explore.TowerUnlocked:
		ev.Kind, ev.Value = EventTowerUnlocked, int32(h.Region)
		if t, ok := w.TowerOfSite(h.Site); ok {
			ev.Y = cm(t.Shape.TopY)
		}
		if h.Region < len(w.Atlas.Regions) {
			ev.Data = []byte(w.Atlas.Regions[h.Region].Name)
		}
	case explore.WaypointActivated:
		ev.Kind = EventWaypoint
	case explore.Discovered:
		ev.Kind, ev.Value = EventDiscovery, int32(min(h.XP, math.MaxInt32))
	case explore.RespawnPointSet:
		ev.Kind = EventRespawnPoint
	}
	s.sendEvent(sess, ev)
	s.log.Info("exploration", "character", sess.ent.CharacterID, "kind", ev.Kind, "site", h.Site, "name", name, "xp", h.XP)
}

// handleInteract applies one Interact message (tick goroutine).
func (s *Server) handleInteract(sess *session, m *proto.Interact, now time.Time) {
	if s.cfg.Explore == nil || sess.x == nil {
		return
	}
	switch m.TargetKind {
	case InteractSite:
		switch m.Action {
		case ActionFastTravel:
			s.fastTravel(sess, int(m.TargetID), now)
		case ActionAttune: // playtest 1: a tower's crystal (progression.go)
			s.attune(sess, int(m.TargetID))
		}
	case InteractPin:
		s.pinAction(sess, m)
	}
}

// fastTravel validates and performs a fast travel: the server moves the
// player (spec 8 "fast travel to unlocked towers/waypoints"; the client's
// reconciliation snaps it to the new place) and tells everyone who can see
// it with a teleport Event so interpolation cuts instead of sliding.
func (s *Server) fastTravel(sess *session, site int, now time.Time) {
	w := s.cfg.Explore
	x := sess.x
	reason := w.CanTravel(x.prog, site)
	if reason == explore.TravelLocked && s.partyLends(sess.ent, site) {
		reason = explore.TravelOK // co-op polish: a party member's tower (party_travel.go)
	}
	if reason == explore.TravelOK && now.Sub(x.lastTravel) < fastTravelCooldown {
		reason = explore.TravelCooldown
	}
	dest, ok := w.Destination(site)
	if reason == explore.TravelOK && !ok {
		reason = explore.TravelUnknown
	}
	if reason != explore.TravelOK {
		s.sendEvent(sess, &proto.Event{Kind: EventFastTravelDenied, EntityID: sess.ent.ID, TargetID: uint32(max(0, site)), Value: int32(reason)})
		return
	}
	x.lastTravel = now
	s.Teleport(sess.ent, dest)
	s.log.Info("fast travel", "character", sess.ent.CharacterID, "site", site, "x", dest.X, "y", dest.Y, "z", dest.Z)
}

// Teleport moves an entity to pos with no momentum and tells every client
// that currently sees it (and the entity's own client) with Event kind 2.
// Validation state and the observer view restart at pos, so neither the
// speed check nor view easing treats the jump as movement. WP13's respawn
// uses it with RespawnPoint.
func (s *Server) Teleport(e *Entity, pos movement.Vec3) {
	if g := movement.GroundAt(s.cfg.Ground, pos.X, pos.Y, pos.Z); pos.Y < g { // WP09: cave floors too
		pos.Y = g
	}
	// WP10: a teleport resets motion and mode but keeps the stamina wheel (a
	// zero State would have no stamina: no sprint, climb or glide).
	next := movement.NewState(pos)
	next.Stamina, next.StaminaMax, next.Flags = e.Move.Stamina, e.Move.StaminaMax, e.Move.Flags&movement.FlagExhausted
	if next.StaminaMax == 0 {
		next = movement.NewState(pos)
	}
	if !movement.Grounded(next, s.cfg.Ground) {
		next.Mode = movement.ModeAir
	}
	e.Move = next
	e.prevValid = e.Move
	e.view, e.viewRaw = e.Move, e.Move
	e.viewOff = movement.Vec3{}
	e.guess = 0
	ev := proto.Encode(&proto.Event{Kind: EventTeleport, EntityID: e.ID, X: cm(pos.X), Y: cm(pos.Y), Z: cm(pos.Z)})
	for _, o := range s.sessions {
		if o.ent == e || o.enc.Knows(e.ID) {
			if err := o.conn.SendReliable(ev); err != nil {
				o.closed.Store(true)
			}
		}
	}
	if w, ok := s.cfg.Ground.(wanter); ok {
		w.Want(pos.X, pos.Z, wantMarginM)
	}
}

// RespawnPoint is where a character comes back after death (spec 8: "Death
// respawns you at the last waypoint you touched, keeping everything"):
// beside their last waypoint, else the world spawn. The hook for WP13:
// `s.Teleport(e, s.RespawnPoint(e))`.
func (s *Server) RespawnPoint(e *Entity) movement.Vec3 {
	if p, ok := s.campSpawn(e); ok {
		return p // CR 025: your bedroll (camps.go)
	}
	if p, ok := s.partyRespawn(e); ok {
		return p // co-op polish: near your friend (party_travel.go)
	}
	if w := s.cfg.Explore; w != nil && e.x != nil {
		if p, ok := w.RespawnPoint(e.x.prog); ok {
			return p
		}
	}
	return s.newCharacterSpawn(e.CharacterID)
}

// ---- persistence ----

// saveProgressSoon queues a save of changed progress. Accounts: a
// write-behind op keyed per character (coalesced, so a burst of
// discoveries is one write). Local profiles: a new signed blob, at most
// every localSaveEvery unless force (checkpoint).
func (s *Server) saveProgressSoon(sess *session, force bool) {
	x := sess.x
	if x == nil || !x.prog.Dirty() || x.readOnly || s.cfg.Queue == nil {
		return
	}
	e := sess.ent
	if x.local != nil {
		if !force && time.Since(x.lastIssue) < localSaveEvery {
			return
		}
		s.issueLocalSave(sess)
		return
	}
	ps, ok := s.cfg.Store.(ProgressStore)
	if !ok || s.cfg.Store == nil {
		return
	}
	snap := s.snapshotProgress(x.prog)
	snap.Epoch = e.epoch // WP16: checkpoint fence (persist.go)
	x.prog.MarkSaved()
	id, log := e.CharacterID, s.log
	s.cfg.Queue.Enqueue(writebehind.Op{Key: "progress:" + id, Run: func(ctx context.Context) error {
		err := ps.SaveProgress(ctx, id, snap)
		if err != nil && errorsIsSkip(err) {
			if _, seen := loggedMissing.LoadOrStore("progress:"+id, true); !seen {
				log.Info("progress save skipped: no character row", "character", id)
			}
		}
		return err
	}})
}

// issueLocalSave signs a new blob with the character's current state and
// sends it (SaveBlob) for the browser to store. Off the tick: the Redis
// counter bump runs in the write-behind queue. A blob is only issued while
// the connection is open, because a counter the client never receives
// would make its stored blob stale (localsave README).
func (s *Server) issueLocalSave(sess *session) {
	x, e := sess.x, sess.ent
	stateJSON := s.localState(sess).Marshal()
	saves, profile, charID, world, log := s.cfg.Saves, x.local.profileID, e.CharacterID, s.cfg.WorldID, s.log
	s.cfg.Queue.Enqueue(writebehind.Op{Key: "localsave:" + charID, Run: func(ctx context.Context) error {
		if sess.closed.Load() {
			s.flushLocalDrops(charID, false) // WP14: parked drops stay in the browser's blob
			return nil                       // gone: keep the blob the browser already has valid
		}
		b, err := saves.Issue(ctx, profile, charID, world, stateJSON)
		if err != nil {
			return err
		}
		raw, _ := json.Marshal(b)
		if err := sess.conn.SendReliable(proto.Encode(&proto.SaveBlob{Blob: raw})); err != nil {
			log.Warn("local save issued but not delivered; the browser's blob is now stale", "character", charID, "counter", b.Counter)
		}
		s.flushLocalDrops(charID, true) // WP14: drops parked until a blob without them exists (loot.go)
		return nil
	}})
}

// localState builds the state the next blob carries and marks it issued
// (WP14 calls it for a local profile's drop, which must issue first).
func (s *Server) localState(sess *session) localsave.State {
	x := sess.x
	e := sess.ent
	p := x.prog
	st := x.local.state
	st.Level, st.XP = p.Level, p.XP
	st.Position = localsave.Vec3{X: e.Move.Pos.X, Y: e.Move.Pos.Y, Z: e.Move.Pos.Z}
	st.Progress.Towers = append([]byte(nil), p.Towers...)
	st.Progress.Waypoints = append([]byte(nil), p.Waypoints...)
	st.Progress.Discoveries = append([]byte(nil), p.Discoveries...)
	st.Progress.Attuned = append([]byte(nil), p.Attuned...) // playtest 1
	st.Progress.Pins = p.PinsJSON()
	combatIntoLocal(e, (*[]byte)(&st.Progress.SkillTree), &st.Progress.SpellsKnown, &st.Progress.SpellsEquipped) // WP13
	itemsIntoLocal(sess, &st)                                                                                    // WP14
	contentIntoLocal(sess, &st.Content)                                                                          // content.go
	steedsIntoLocal(sess, &st.Mounts)                                                                            // CR 027 (mounts.go)
	petsIntoLocal(sess, &st.Pets)                                                                                // CR 029 (pets.go)
	questsIntoLocal(sess, &st.Quests)                                                                            // quests.go
	st.LastWaypoint = nil
	if p.LastWaypoint >= 0 {
		id := int64(s.cfg.Explore.Atlas.Sites[p.LastWaypoint].ID)
		st.LastWaypoint = &id
	}
	x.local.state = st
	p.MarkSaved()
	x.lastIssue = time.Now()
	return st
}

// exploreLeave saves what's left when a player leaves (logout checkpoint).
// Local profiles can't receive a blob any more; their last periodic issue
// stands (spec 11 save points).
func (s *Server) exploreLeave(sess *session) {
	if sess.x == nil {
		return
	}
	if sess.x.local == nil {
		s.saveProgressSoon(sess, true)
	}
}

// exploreCheckpoint rides the periodic checkpoint (SAVE_INTERVAL_S).
// Local profiles also get a new blob when they moved (their position lives
// only in the blob they present on the next connect).
func (s *Server) exploreCheckpoint(e *Entity) {
	if e.x == nil {
		return
	}
	if sess := s.byChar[e.CharacterID]; sess != nil && sess.ent == e {
		if x := sess.x; x != nil && x.local != nil && !x.readOnly && localMoved(x, e) {
			x.prog.MarkDirty()
		}
		s.saveProgressSoon(sess, true)
	}
}

func localMoved(x *exploreState, e *Entity) bool {
	p, q := e.Move.Pos, x.local.state.Position
	return math.Hypot(math.Hypot(p.X-q.X, p.Y-q.Y), p.Z-q.Z) > localMoveSaveM
}

// finalLocalSaves issues a last blob, synchronously, to every connected
// local profile before a shutdown kicks them (Stop): the write-behind queue
// would run after the kick, when a blob can no longer be delivered, and the
// browser would reconnect with an older position (playtest 2).
func (s *Server) finalLocalSaves(ctx context.Context) {
	if s.cfg.Saves == nil {
		return
	}
	for _, sess := range s.sessions {
		x, e := sess.x, sess.ent
		if x == nil || x.local == nil || x.readOnly || e == nil || sess.closed.Load() {
			continue
		}
		st := s.localState(sess).Marshal()
		ictx, cancel := context.WithTimeout(ctx, time.Second)
		b, err := s.cfg.Saves.Issue(ictx, x.local.profileID, e.CharacterID, s.cfg.WorldID, st)
		cancel()
		if err != nil {
			s.log.Warn("final local save failed; the browser keeps its last blob", "character", e.CharacterID, "err", err)
			continue
		}
		raw, _ := json.Marshal(b)
		if err := sess.conn.SendReliable(proto.Encode(&proto.SaveBlob{Blob: raw})); err != nil {
			s.log.Warn("final local save not delivered", "character", e.CharacterID, "counter", b.Counter)
			continue
		}
		s.flushLocalDrops(e.CharacterID, true)
	}
}
