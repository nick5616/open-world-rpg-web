package game

// Torches and familiar lights (playtest 3, CR 042).
//
// What a player carries lit is zone state, replicated in the player's snapshot
// record so every client lights its surroundings from the same facts (a late
// joiner, a player walking into range and a ghost from the next zone included,
// exactly like worn armor): EntityRecord.appearance keeps the armor in bits
// 0-50 (CR 034) and the light in bits 51-56:
//
//	bit 51      a torch is lit in the off hand
//	bits 52-56  the familiar light's id (combat.yaml `familiar.id`, 0 none)
//
// A torch is the existing items.yaml `tool:torch`: Interact 160 action 1
// lights or douses it while one is in the pack. A familiar light is a defensive
// toggle spell (combat.yaml `familiar`): casting it calls it, casting it again
// dismisses it (free), and it costs `upkeepPerS` mana a second while it burns,
// going out when the mana runs dry. A torch needs no fuel but cannot be carried
// swimming (water puts it out), and nothing burns while you are down.
//
// Per-tick cost: none. The state changes on a player's own request and a
// once-a-second pass visits only the sessions that carry a light.

import (
	"math"
	"time"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"

	"lodestone/server/zone/internal/quests"
)

// Interact 160 `light` and Events 1840-1841 (contracts/events.md).
const (
	InteractLight = 160

	LightActSend    = 0 // send 1840 again
	LightActTorch   = 1 // light or douse the torch
	LightActDismiss = 2 // put the familiar light out

	EventLightState   = 1840
	EventLightRefused = 1841

	lightTorchBit   = 51
	lightFamShift   = 52
	lightFamMask    = 0x1f
	lightEveryTicks = 30 // upkeep and water, once a second (30 Hz zone ticks)
)

// Event 1840 `data[0]`: why the state changed.
const (
	LightWhyAsked   = 0 // you lit, doused, cast or dismissed it
	LightWhyWater   = 1 // the torch went out in the water
	LightWhyMana    = 2 // the familiar faded: out of mana
	LightWhyDowned  = 3 // you fell
	LightWhyResync  = 4 // an answer to LightActSend
	LightWhyNoTorch = 5 // the torch left the pack
)

// Event 1841 `value`: why a request was refused.
const (
	LightRefuseNoTorch = 1
	LightRefuseWater   = 2
	LightRefuseDowned  = 3
	LightRefuseTooFast = 4
	LightRefuseUnknown = 5
)

// lightState is a session's lit things.
type lightState struct {
	torch    bool
	fam      int // combatdefs Familiar.ID, 0 none
	famSpell int // the spell that called it
	famUp    float64
	last     time.Time
}

func (l *lightState) bits() uint64 {
	var v uint64
	if l.torch {
		v |= 1 << lightTorchBit
	}
	return v | uint64(l.fam&lightFamMask)<<lightFamShift
}

// LightBits is the part of an appearance number that carries the light.
func LightBits(ap uint64) (torch bool, familiar int) {
	return ap>>lightTorchBit&1 != 0, int(ap >> lightFamShift & lightFamMask)
}

func (s *Server) lightOf(sess *session) *lightState {
	if sess.light == nil {
		sess.light = &lightState{}
	}
	return sess.light
}

// refreshLook rebuilds the entity's appearance (armor + light) and, when tell,
// tells the owner (Event 1840: value = the light bits >> 51, targetId = the
// familiar's spell id (the one that just ended when it went out), data = [why]).
func (s *Server) refreshLook(sess *session, why byte, tell bool) {
	e := sess.ent
	if e == nil {
		return
	}
	l := s.lightOf(sess)
	e.Appearance = e.armorAp | l.bits()
	if e.cbt != nil {
		e.cbt.Familiar = 0
		if l.fam != 0 {
			e.cbt.Familiar = l.famSpell
		}
	}
	if l.torch || l.fam != 0 {
		if s.lighted == nil {
			s.lighted = map[*session]struct{}{}
		}
		s.lighted[sess] = struct{}{}
	} else {
		delete(s.lighted, sess)
	}
	if tell {
		val := int32(l.bits() >> lightTorchBit)
		s.sendEvent(sess, &proto.Event{Kind: EventLightState, EntityID: e.ID, TargetID: uint32(l.famSpell), Value: val, Data: []byte{why}})
	}
}

func (s *Server) lightRefuse(sess *session, what, why int) {
	s.sendEvent(sess, &proto.Event{Kind: EventLightRefused, EntityID: sess.ent.ID, TargetID: uint32(what), Value: int32(why)})
}

// lightWet: swimming puts a torch out.
func lightWet(e *Entity) bool { return e.Move.Mode == movement.ModeSwim }

// lightInteract applies Interact 160 (tick goroutine).
func (s *Server) lightInteract(sess *session, m *proto.Interact, now time.Time) {
	e := sess.ent
	if e == nil {
		return
	}
	l := s.lightOf(sess)
	switch m.Action {
	case LightActSend:
		s.refreshLook(sess, LightWhyResync, true)
	case LightActTorch:
		if l.torch {
			l.torch = false
			s.refreshLook(sess, LightWhyAsked, true)
			return
		}
		switch {
		case e.cbt != nil && e.cbt.Downed:
			s.lightRefuse(sess, 1, LightRefuseDowned)
		case sess.items == nil || sess.items.inv.Count("tool:torch") == 0:
			s.lightRefuse(sess, 1, LightRefuseNoTorch)
		case lightWet(e):
			s.lightRefuse(sess, 1, LightRefuseWater)
		case now.Sub(l.last) < 300*time.Millisecond:
			s.lightRefuse(sess, 1, LightRefuseTooFast)
		default:
			l.last = now
			l.torch = true
			s.refreshLook(sess, LightWhyAsked, true)
			s.questsDeed(sess, quests.DeedTorch) // CR 051: the torch errand
		}
	case LightActDismiss:
		if l.fam != 0 {
			s.familiarOff(sess, LightWhyAsked)
		}
	default:
		s.lightRefuse(sess, 0, LightRefuseUnknown)
	}
}

// familiarCast is a legal cast of a familiar light spell (combatFrame): the
// first cast calls it, the same spell again dismisses it, another school's
// replaces it. The combat package already paid the mana (nothing for a
// dismissal).
func (s *Server) familiarCast(sess *session, sp *combatdefs.Spell) {
	if sess.ent == nil || sp == nil || sp.Familiar == nil {
		return
	}
	l := s.lightOf(sess)
	if l.fam == sp.Familiar.ID {
		s.familiarOff(sess, LightWhyAsked)
		return
	}
	l.fam, l.famSpell, l.famUp = sp.Familiar.ID, sp.ID, sp.Familiar.UpkeepPerS
	s.refreshLook(sess, LightWhyAsked, true)
}

// familiarOff puts the familiar light out (the event names the spell it was).
func (s *Server) familiarOff(sess *session, why byte) {
	l := s.lightOf(sess)
	spell := l.famSpell
	l.fam, l.famUp = 0, 0
	l.famSpell = 0
	s.refreshLook(sess, why, false)
	s.sendEvent(sess, &proto.Event{Kind: EventLightState, EntityID: sess.ent.ID, TargetID: uint32(spell), Value: int32(l.bits() >> lightTorchBit), Data: []byte{why}})
}

// lightTick: once a second the lit sessions pay their familiar's upkeep, lose
// a torch that went into the water or left the pack, and everything when down.
func (s *Server) lightTick(tick uint32) {
	if len(s.lighted) == 0 || tick%lightEveryTicks != 0 {
		return
	}
	for sess := range s.lighted {
		e := sess.ent
		if e == nil || sess.left {
			delete(s.lighted, sess)
			continue
		}
		l := s.lightOf(sess)
		if e.cbt != nil && e.cbt.Downed {
			l.torch = false
			if l.fam != 0 {
				s.familiarOff(sess, LightWhyDowned)
			} else {
				s.refreshLook(sess, LightWhyDowned, true)
			}
			continue
		}
		if l.torch {
			switch {
			case lightWet(e):
				l.torch = false
				s.refreshLook(sess, LightWhyWater, true)
			case sess.items != nil && sess.items.inv.Count("tool:torch") == 0:
				l.torch = false
				s.refreshLook(sess, LightWhyNoTorch, true)
			}
		}
		if l.fam != 0 && e.cbt != nil {
			if e.cbt.Mana < l.famUp {
				s.familiarOff(sess, LightWhyMana)
				continue
			}
			e.cbt.Mana = math.Max(0, e.cbt.Mana-l.famUp)
		}
	}
}
