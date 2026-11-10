package game

// Playtest 2 emotes (CR 026, contracts/content.yaml `emotes`): Interact 89
// plays an emote; Event 1090 tells the players within emotes.seeM (not the
// actor, whose client already plays it). Rate limited per player (a burst,
// then one per everyS). A looping emote (sit, dance, rest, and the fishing
// pose the zone itself sends from fishing.go) is also told, once, to anyone
// who comes within range while it lasts; it ends when the player moves away
// from where it started (observers end it themselves when the body moves,
// so the zone sends nothing for that). Nothing is sent per tick: a player
// who never emotes costs nothing; one who holds a loop costs a distance
// check per other player once a second.

import (
	"math"
	"time"

	"lodestone/server/pkg/contentdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/ratelimit"
)

// Interact 89 `emote`.
const (
	InteractEmote = 89

	EmoteActPlay = 1 // targetId = emote id (contentdefs Emotes, not a system one)
	EmoteActStop = 2 // stop a looping emote (targetId 0)
)

// Events 1090-1091 (contracts/events.md, range 1080-1099).
const (
	EventEmote        = 1090
	EventEmoteRefused = 1091
)

// Emote refusals (Event 1091 value).
const (
	EmoteRefuseUnknown = 1
	EmoteRefuseTooFast = 2
	EmoteRefuseNotNow  = 3
)

// System emote ids (fishing.go).
const (
	EmoteFishing   = 20
	EmoteShowCatch = 21
)

const (
	emoteEveryTicks = 30  // loop emotes: newcomers and walk-away once a second
	emoteMoveM      = 1.0 // a loop ends when its player moves this far
)

// emoteLoop is a looping emote in progress.
type emoteLoop struct {
	id      int
	x, z    float64 // where the player stood
	ev      *proto.Event
	told    map[uint32]bool // observers' entity ids already told
	fishing bool
}

// emoteState is a session's emote limiter and loop.
type emoteState struct {
	bucket ratelimit.Bucket
	loop   *emoteLoop
}

func (s *Server) emotesOf(sess *session) *emoteState {
	if sess.emotes == nil {
		em := &contentdefs.D.Emotes
		sess.emotes = &emoteState{bucket: ratelimit.New(em.Burst, 1/math.Max(0.1, em.EveryS))}
	}
	return sess.emotes
}

// emoteInteract applies Interact 89 (tick goroutine).
func (s *Server) emoteInteract(sess *session, m *proto.Interact, now time.Time) {
	e := sess.ent
	if e == nil {
		return
	}
	refuse := func(r int32) {
		s.sendEvent(sess, &proto.Event{Kind: EventEmoteRefused, EntityID: e.ID, TargetID: uint32(m.TargetID), Value: r})
	}
	switch m.Action {
	case EmoteActPlay:
		def := contentdefs.D.Emote(int(m.TargetID))
		if m.TargetID > 255 || def == nil || def.System {
			refuse(EmoteRefuseUnknown)
			return
		}
		if (e.cbt != nil && e.cbt.Downed) || !emoteModeOK(e) {
			refuse(EmoteRefuseNotNow)
			return
		}
		if !s.emotesOf(sess).bucket.Take(now) {
			refuse(EmoteRefuseTooFast)
			return
		}
		s.fishStop(sess, FishLostCancelled) // an emote reels a line in (fishing.go)
		s.playEmote(sess, def.ID, def.Loop, 0, e.Move.Pos.X, e.Move.Pos.Y, e.Move.Pos.Z)
	case EmoteActStop:
		s.stopEmote(sess, true)
	default:
		refuse(EmoteRefuseUnknown)
	}
}

// emoteModeOK: emotes are for the ground or a jump (not climbing, gliding
// or swimming).
func emoteModeOK(e *Entity) bool {
	return e.Move.Mode == movement.ModeGround || e.Move.Mode == movement.ModeAir
}

// playEmote tells players near sess's player about emote id (value: extra,
// x/y/z: where, metres). loop keeps it for newcomers until the player moves.
func (s *Server) playEmote(sess *session, id int, loop bool, value int32, x, y, z float64) {
	e := sess.ent
	em := s.emotesOf(sess)
	ev := &proto.Event{Kind: EventEmote, EntityID: e.ID, TargetID: uint32(id), Value: value, X: cm(x), Y: cm(y), Z: cm(z)}
	told := s.emoteTell(e, ev, nil)
	if loop {
		em.loop = &emoteLoop{id: id, x: e.Move.Pos.X, z: e.Move.Pos.Z, ev: ev, told: told, fishing: id == EmoteFishing}
		if s.emoters == nil {
			s.emoters = map[*session]struct{}{}
		}
		s.emoters[sess] = struct{}{}
	} else if em.loop != nil {
		em.loop = nil
		delete(s.emoters, sess)
	}
}

// stopEmote ends sess's looping emote; tell sends Event 1090 id 0 to those
// who saw it (a walk-away needs no event: observers see the body move).
func (s *Server) stopEmote(sess *session, tell bool) {
	em := sess.emotes
	if em == nil || em.loop == nil {
		return
	}
	l := em.loop
	em.loop = nil
	delete(s.emoters, sess)
	if !tell || sess.ent == nil {
		return
	}
	p := sess.ent.Move.Pos
	stop := &proto.Event{Kind: EventEmote, EntityID: sess.ent.ID, TargetID: 0, X: cm(p.X), Y: cm(p.Y), Z: cm(p.Z)}
	for _, o := range s.sessions {
		if o.ent != nil && l.told[o.ent.ID] {
			s.sendEvent(o, stop)
		}
	}
}

// emoteTell sends ev to every player within emotes.seeM of e but e, skipping
// those in told; it returns the set told (told itself when not nil).
func (s *Server) emoteTell(e *Entity, ev *proto.Event, told map[uint32]bool) map[uint32]bool {
	if told == nil {
		told = map[uint32]bool{}
	}
	r := contentdefs.D.Emotes.SeeM
	for _, o := range s.sessions {
		oe := o.ent
		if oe == nil || oe == e || told[oe.ID] {
			continue
		}
		if math.Hypot(oe.Move.Pos.X-e.Move.Pos.X, oe.Move.Pos.Z-e.Move.Pos.Z) > r || math.Abs(oe.Move.Pos.Y-e.Move.Pos.Y) > r {
			continue
		}
		s.sendEvent(o, ev)
		told[oe.ID] = true
	}
	return told
}

// emotesTick: once a second, loops whose player walked away end; the rest
// are told to players who came within range.
func (s *Server) emotesTick(tick uint32) {
	if len(s.emoters) == 0 || tick%emoteEveryTicks != 0 {
		return
	}
	for sess := range s.emoters {
		e := sess.ent
		l := sess.emotes.loop
		if e == nil || sess.left || l == nil {
			delete(s.emoters, sess)
			continue
		}
		if l.fishing {
			s.fishCheck(sess, s.cfg.Now()) // fishing.go: a missed bite, an endless fight
			if sess.emotes.loop != l {
				continue
			}
		}
		if math.Hypot(e.Move.Pos.X-l.x, e.Move.Pos.Z-l.z) > emoteMoveM {
			if l.fishing {
				s.fishStop(sess, FishLostWalkedAway) // fishing.go (ends the loop, tells the angler)
			} else {
				s.stopEmote(sess, false)
			}
			continue
		}
		s.emoteTell(e, l.ev, l.told)
	}
}

// emotesLeave forgets a leaving session.
func (s *Server) emotesLeave(sess *session) {
	delete(s.emoters, sess)
	s.fishLeave(sess)
}
