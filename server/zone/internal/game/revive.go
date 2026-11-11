package game

// Revives (playtest 2, CR 035): a player an enemy downs with another player
// alive within reviveNearM is held down for reviveWindowS instead of the
// 3 s respawn (Event 1610 to them and to the players near). A friend
// standing within reviveReachM holds E (Interact 140/3, arg 1; letting go
// sends arg 0) for reviveHoldS: the downed player gets up where they lie
// with half their health (Event 1611). The downed player may respawn at once
// instead (Interact 140/4). Moving away, being downed or the window running
// out ends a revive (1612 value 0). PvP downs keep the plain respawn.

import (
	"encoding/json"
	"math"

	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/combat"
)

const (
	reviveNearM   = 40.0
	reviveReachM  = 3.5
	reviveWindowS = 20.0
	reviveHoldS   = 3.0
	reviveHealth  = 0.5
)

type reviveState struct {
	held map[uint32]uint32        // downed player -> tick their revive window ends
	by   map[uint32]*reviveAction // reviver -> what they hold
}

type reviveAction struct {
	target uint32
	start  uint32
}

func (s *Server) reviveInit() {
	if s.sty.rev.held == nil {
		s.sty.rev.held = map[uint32]uint32{}
		s.sty.rev.by = map[uint32]*reviveAction{}
	}
}

// storyCombatEvent (combat.go): a player downed by an enemy with a friend
// near is held for a revive.
func (s *Server) storyCombatEvent(o combat.Out) {
	if o.Ev.Kind != combat.EvPlayerDowned || s.cbt.w == nil {
		return
	}
	id := o.Ev.EntityID
	if s.cbt.w.Enemy(o.Ev.TargetID) == nil {
		return // PvP or a duel: the plain respawn
	}
	e := s.entityByID(id)
	if e == nil || e.Kind != proto.EntityKindPlayer {
		return
	}
	var helpers []*Entity
	for _, o := range s.playersNear(e.Move.Pos.X, e.Move.Pos.Z, reviveNearM) {
		if o != e && o.cbt != nil && !o.cbt.Downed {
			helpers = append(helpers, o)
		}
	}
	if len(helpers) == 0 || !s.cbt.w.HoldDowned(id, reviveWindowS) {
		return
	}
	s.reviveInit()
	s.sty.rev.held[id] = s.tick + uint32(reviveWindowS*30)
	b, _ := json.Marshal(struct {
		ID      uint32  `json:"id"`
		Name    string  `json:"name"`
		Ms      int     `json:"ms"`
		X       float64 `json:"x"`
		Y       float64 `json:"y"`
		Z       float64 `json:"z"`
		Helpers int     `json:"helpers"`
	}{id, e.Name, int(reviveWindowS * 1000), e.Move.Pos.X, e.Move.Pos.Y, e.Move.Pos.Z, len(helpers)})
	s.sendEventTo(e, &proto.Event{Kind: EventReviveWindow, EntityID: id, Value: int32(reviveWindowS * 1000), Data: b})
	for _, h := range helpers {
		s.sendEventTo(h, &proto.Event{Kind: EventReviveWindow, EntityID: id, Value: int32(reviveWindowS * 1000), X: cm(e.Move.Pos.X), Y: cm(e.Move.Pos.Y), Z: cm(e.Move.Pos.Z), Data: b})
	}
}

// reviveHold is Interact 140/3: start (on) or stop holding E over target.
func (s *Server) reviveHold(sess *session, target uint32, on bool) int32 {
	s.reviveInit()
	e := sess.ent
	rv := &s.sty.rev
	if !on {
		if a := rv.by[e.ID]; a != nil {
			s.reviveStop(e.ID, a)
		}
		return 0
	}
	t := s.entityByID(target)
	if t == nil || t.Kind != proto.EntityKindPlayer || t.cbt == nil || !t.cbt.Downed || rv.held[target] == 0 {
		return StoryRefuseNotDown
	}
	if e.cbt == nil || e.cbt.Downed || t == e {
		return StoryRefuseUnknown
	}
	if math.Hypot(t.Move.Pos.X-e.Move.Pos.X, t.Move.Pos.Z-e.Move.Pos.Z) > reviveReachM {
		return StoryRefuseFar
	}
	if a := rv.by[e.ID]; a != nil && a.target == target {
		return 0
	}
	rv.by[e.ID] = &reviveAction{target: target, start: s.tick}
	ev := &proto.Event{Kind: EventReviveProgress, EntityID: e.ID, TargetID: target, Value: int32(reviveHoldS * 1000)}
	s.sendEventTo(e, ev)
	s.sendEventTo(t, ev)
	return 0
}

func (s *Server) reviveStop(by uint32, a *reviveAction) {
	delete(s.sty.rev.by, by)
	ev := &proto.Event{Kind: EventReviveProgress, EntityID: by, TargetID: a.target, Value: 0}
	if e := s.entityByID(by); e != nil {
		s.sendEventTo(e, ev)
	}
	if t := s.entityByID(a.target); t != nil {
		s.sendEventTo(t, ev)
	}
}

// reviveTick finishes or breaks revives in progress and forgets windows
// that ended.
func (s *Server) reviveTick(tick uint32) {
	rv := &s.sty.rev
	if len(rv.held) == 0 && len(rv.by) == 0 {
		return
	}
	for by, a := range rv.by {
		e, t := s.entityByID(by), s.entityByID(a.target)
		if e == nil || t == nil || e.cbt == nil || t.cbt == nil || e.cbt.Downed || !t.cbt.Downed ||
			math.Hypot(t.Move.Pos.X-e.Move.Pos.X, t.Move.Pos.Z-e.Move.Pos.Z) > reviveReachM+0.5 {
			s.reviveStop(by, a)
			continue
		}
		if tick-a.start < uint32(reviveHoldS*30) {
			continue
		}
		delete(rv.by, by)
		if !s.cbt.w.Revive(a.target, reviveHealth) {
			continue
		}
		delete(rv.held, a.target)
		syncPlayerHealth(t)
		ev := &proto.Event{Kind: EventRevived, EntityID: a.target, TargetID: by, X: cm(t.Move.Pos.X), Y: cm(t.Move.Pos.Y), Z: cm(t.Move.Pos.Z), Data: []byte(e.Name)}
		for _, o := range s.playersNear(t.Move.Pos.X, t.Move.Pos.Z, 64) {
			s.sendEventTo(o, ev)
		}
		if sess := s.byChar[e.CharacterID]; sess != nil && sess.cnt != nil {
			sess.cnt.st.Add("revives", 1)
			sess.cnt.recheck = true
			s.saveContent(sess)
		}
		s.log.Info("revived", "player", t.CharacterID, "by", e.CharacterID)
	}
	if tick%15 == 0 {
		for id, until := range rv.held {
			t := s.entityByID(id)
			if t == nil || t.cbt == nil || !t.cbt.Downed || tick > until+30 {
				delete(rv.held, id)
			}
		}
	}
}

func (s *Server) reviveLeave(e *Entity) {
	rv := &s.sty.rev
	if rv.by == nil {
		return
	}
	if a := rv.by[e.ID]; a != nil {
		s.reviveStop(e.ID, a)
	}
	delete(rv.held, e.ID)
}
