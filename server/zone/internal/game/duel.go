package game

// Duels between party members (playtest 2, CR 018: "duels if you are [in
// the same party], which are a facilitated means").
//
//	challenge (Interact 70 action 2, within pvp.duel.challengeRangeM, same
//	party) -> the challenged gets Event 994 and pvp.duel.answerS to answer
//	(action 3) -> accepted: a ring of pvp.duel.ringRadiusM around the
//	midpoint, a 3-2-1 countdown (995 phase 2), the fight (995 phase 3).
//
// Only the two duelists' hits on each other count as duel hits, anywhere
// (towns and the Haven too: it is consensual and the ring keeps it in
// place) and whatever their PvP flags; enemies keep hurting both normally.
// The duel ends when a duelist drops to 1 health (they never go down from
// a duel hit), leaves the ring for more than pvp.duel.outsideForfeitS,
// yields (action 4), logs out or leaves the zone, or after pvp.duel.maxS (a
// draw); if an enemy downs a duelist it is called off. Both get back the
// health the duel took and the mana they started with, hear the result
// (996), and so does their party chat (the social bus).

import (
	"fmt"
	"math"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/combat"
)

type duelPhase uint8

const (
	duelPending   duelPhase = 1 // challenge sent, waiting for the answer
	duelCountdown duelPhase = 2 // accepted: 3-2-1
	duelFighting  duelPhase = 3
)

// Event 996 reasons.
const (
	duelDefeated  = 1 // the loser dropped to 1 health
	duelOutside   = 2 // the loser stayed outside the ring too long
	duelLeft      = 3 // the loser logged out or left the zone
	duelTimeUp    = 4 // pvp.duel.maxS: a draw
	duelYielded   = 5 // the loser yielded (action 4)
	duelDeclined  = 6
	duelExpired   = 7 // nobody answered in pvp.duel.answerS
	duelCancelled = 8 // the challenger withdrew, or something else downed a duelist
)

type duel struct {
	id      uint32
	phase   duelPhase
	ents    [2]*Entity // 0 = challenger, 1 = challenged
	party   uint32
	until   uint32 // pending: expiry; countdown: the fight starts; fighting: the time cap
	started uint32 // tick the fight started
	center  movement.Vec3
	radius  float64
	outside [2]uint32  // tick each left the ring (0 = inside)
	taken   [2]float64 // health the duel took from each
	mana    [2]float64 // mana when it was accepted
}

func (d *duel) index(e *Entity) int {
	if d.ents[1] == e {
		return 1
	}
	return 0
}

func (d *duel) other(e *Entity) *Entity { return d.ents[1-d.index(e)] }

// duelData: u16 ring radius cm | u32 ms until this phase ends | UTF-8
// opponent name (Event 995).
func (s *Server) duelData(d *duel, opp *Entity) []byte {
	b := le16(nil, uint16(math.Min(65535, d.radius*100)))
	ms := uint32(0)
	if d.until > s.tick {
		ms = (d.until - s.tick) * 1000 / tickHz
	}
	b = le32(b, ms)
	return append(b, opp.Name...)
}

func (s *Server) sendDuelState(d *duel) {
	for i, e := range d.ents {
		opp := d.ents[1-i]
		if d.phase == duelPending && i == 1 {
			continue // the challenged has the challenge (994)
		}
		s.sendEventTo(e, &proto.Event{Kind: combat.EvDuelState, EntityID: opp.ID, TargetID: d.id, Value: int32(d.phase),
			X: cm(d.center.X), Y: cm(d.center.Y), Z: cm(d.center.Z), Data: s.duelData(d, opp)})
	}
}

// duelChallenge: e challenges the party member with entity id target.
func (s *Server) duelChallenge(sess *session, target uint32) {
	e := sess.ent
	def := combatdefs.D.PvP.Duel
	t := s.entityByID(target)
	switch {
	case e.cbt.Downed:
		s.pvpRefuse(sess, PvPRefDowned, 0)
		return
	case t == nil || t == e || t.Kind != proto.EntityKindPlayer || t.cbt == nil || s.byChar[t.CharacterID] == nil:
		s.pvpRefuse(sess, PvPRefNoPlayer, target)
		return
	case e.PartyID == 0 || e.PartyID != t.PartyID:
		s.pvpRefuse(sess, PvPRefNotParty, target)
		return
	case hdist(e.Move.Pos, t.Move.Pos) > def.ChallengeRangeM:
		s.pvpRefuse(sess, PvPRefTooFar, target)
		return
	case (e.pvp != nil && e.pvp.duel != nil) || (t.pvp != nil && t.pvp.duel != nil):
		s.pvpRefuse(sess, PvPRefBusy, target)
		return
	case t.cbt.Downed:
		s.pvpRefuse(sess, PvPRefDowned, target)
		return
	}
	s.pvp.nextDuel++
	d := &duel{id: s.pvp.nextDuel, phase: duelPending, ents: [2]*Entity{e, t}, party: e.PartyID, until: s.tick + ticksOfS(def.AnswerS), radius: def.RingRadiusM}
	s.pvp.duels = append(s.pvp.duels, d)
	s.pvpOf(e).duel = d
	s.pvpOf(t).duel = d
	s.sendEventTo(t, &proto.Event{Kind: combat.EvDuelChallenge, EntityID: e.ID, TargetID: d.id, Value: int32(def.AnswerS * 1000),
		X: cm(e.Move.Pos.X), Y: cm(e.Move.Pos.Y), Z: cm(e.Move.Pos.Z), Data: []byte(e.Name)})
	s.sendDuelState(d)
	s.log.Info("duel challenge", "duel", d.id, "from", e.Name, "to", t.Name)
}

// duelAnswer: the challenged accepts or declines.
func (s *Server) duelAnswer(sess *session, challenger uint32, accept bool) {
	e := sess.ent
	if e.pvp == nil || e.pvp.duel == nil || e.pvp.duel.phase != duelPending || e.pvp.duel.ents[1] != e || (challenger != 0 && e.pvp.duel.ents[0].ID != challenger) {
		s.pvpRefuse(sess, PvPRefNoDuel, challenger)
		return
	}
	d := e.pvp.duel
	if !accept {
		s.endDuel(d, -1, duelDeclined)
		return
	}
	a := d.ents[0]
	def := combatdefs.D.PvP.Duel
	if e.cbt.Downed || a.cbt.Downed {
		s.pvpRefuse(sess, PvPRefDowned, challenger)
		return
	}
	if hdist(e.Move.Pos, a.Move.Pos) > def.ChallengeRangeM*1.5 {
		s.pvpRefuse(sess, PvPRefTooFar, challenger) // still pending: come closer and accept again
		return
	}
	d.center = movement.Vec3{X: (a.Move.Pos.X + e.Move.Pos.X) / 2, Y: (a.Move.Pos.Y + e.Move.Pos.Y) / 2, Z: (a.Move.Pos.Z + e.Move.Pos.Z) / 2}
	d.center.Y = math.Max(d.center.Y, s.cfg.Ground.HeightAt(d.center.X, d.center.Z))
	d.phase = duelCountdown
	d.until = s.tick + ticksOfS(def.CountdownS)
	for i, x := range d.ents {
		d.mana[i] = x.cbt.Mana
		x.pvpRetype()
	}
	s.sendDuelState(d)
	s.log.Info("duel accepted", "duel", d.id, "a", a.Name, "b", e.Name)
}

// duelYield: withdraw a challenge, decline one, or forfeit the duel.
func (s *Server) duelYield(sess *session) {
	e := sess.ent
	if e.pvp == nil || e.pvp.duel == nil {
		s.pvpRefuse(sess, PvPRefNoDuel, 0)
		return
	}
	d := e.pvp.duel
	switch {
	case d.phase == duelPending && d.index(e) == 0:
		s.endDuel(d, -1, duelCancelled)
	case d.phase == duelPending:
		s.endDuel(d, -1, duelDeclined)
	default:
		s.endDuel(d, 1-d.index(e), duelYielded)
	}
}

// duelTick advances every duel (pvpTick).
func (s *Server) duelTick(tick uint32) {
	if len(s.pvp.duels) == 0 {
		return
	}
	def := combatdefs.D.PvP.Duel
	for _, d := range append([]*duel(nil), s.pvp.duels...) {
		switch d.phase {
		case duelPending:
			if tick >= d.until {
				s.endDuel(d, -1, duelExpired)
			}
		case duelCountdown:
			if tick >= d.until {
				d.phase = duelFighting
				d.started = tick
				d.until = tick + ticksOfS(def.MaxS)
				s.sendDuelState(d)
			}
		case duelFighting:
			if d.ents[0].cbt.Downed || d.ents[1].cbt.Downed {
				s.endDuel(d, -1, duelCancelled) // an enemy (or an outsider's PvP) downed a duelist
				continue
			}
			ended := false
			for i, e := range d.ents {
				out := hdist(e.Move.Pos, d.center) > d.radius
				switch {
				case out && d.outside[i] == 0:
					d.outside[i] = tick
					s.sendEventTo(e, &proto.Event{Kind: combat.EvDuelOutside, EntityID: e.ID, TargetID: d.id, Value: int32(def.OutsideForfeitS * 1000)})
				case out && tick-d.outside[i] >= ticksOfS(def.OutsideForfeitS):
					s.endDuel(d, 1-i, duelOutside)
					ended = true
				case !out && d.outside[i] != 0:
					d.outside[i] = 0
					s.sendEventTo(e, &proto.Event{Kind: combat.EvDuelOutside, EntityID: e.ID, TargetID: d.id, Value: 0})
				}
				if ended {
					break
				}
			}
			if !ended && tick >= d.until {
				s.endDuel(d, -1, duelTimeUp)
			}
		}
	}
}

// endDuel finishes a duel: winner is the index of the winner (-1 none).
func (s *Server) endDuel(d *duel, winner int, reason int32) {
	for i, x := range s.pvp.duels {
		if x == d {
			s.pvp.duels = append(s.pvp.duels[:i], s.pvp.duels[i+1:]...)
			break
		}
	}
	fought := d.phase >= duelCountdown
	a, b := d.ents[0], d.ents[1]
	var w, l *Entity
	if winner >= 0 {
		w, l = d.ents[winner], d.ents[1-winner]
	}
	secs := 0
	if d.started > 0 {
		secs = int((s.tick - d.started) / tickHz)
	}
	var text string
	switch reason {
	case duelDefeated:
		text = fmt.Sprintf("%s defeated %s in a duel (%d s).", w.Name, l.Name, secs)
	case duelOutside:
		text = fmt.Sprintf("%s left the duel ring: %s wins the duel.", l.Name, w.Name)
	case duelLeft:
		text = fmt.Sprintf("%s left: %s wins the duel.", l.Name, w.Name)
	case duelTimeUp:
		text = fmt.Sprintf("The duel between %s and %s is a draw: time is up.", a.Name, b.Name)
	case duelYielded:
		text = fmt.Sprintf("%s yielded: %s wins the duel.", l.Name, w.Name)
	case duelDeclined:
		text = fmt.Sprintf("%s declined %s's duel.", b.Name, a.Name)
	case duelExpired:
		text = fmt.Sprintf("%s's duel challenge to %s went unanswered.", a.Name, b.Name)
	default:
		text = fmt.Sprintf("The duel between %s and %s was called off.", a.Name, b.Name)
	}
	var wid, lid uint32
	if w != nil {
		wid, lid = w.ID, l.ID
	}
	for i, x := range d.ents {
		if x.pvp != nil && x.pvp.duel == d {
			x.pvp.duel = nil
		}
		x.pvpRetype()
		if fought && x.cbt != nil {
			x.cbt.RestoreAfterDuel(d.taken[i], d.mana[i])
			syncPlayerHealth(x)
		}
		s.sendEventTo(x, &proto.Event{Kind: combat.EvDuelEnded, EntityID: wid, TargetID: lid, Value: reason, X: cm(d.center.X), Y: cm(d.center.Y), Z: cm(d.center.Z), Data: []byte(text)})
	}
	if fought && s.cfg.PartyChat != nil {
		// Party chat: the members this zone hosts (the duelists' party is
		// usually here; members elsewhere read it from the duelists).
		var to []string
		for _, sess := range s.sessions {
			if sess.ent != nil && (sess.ent.PartyID == d.party && d.party != 0 || sess.ent == a || sess.ent == b) {
				to = append(to, sess.ent.CharacterID)
			}
		}
		s.cfg.PartyChat(to, text)
	}
	s.log.Info("duel ended", "duel", d.id, "reason", reason, "text", text)
}

func hdist(a, b movement.Vec3) float64 { return math.Hypot(a.X-b.X, a.Z-b.Z) }
