package game

// Travel to a friend (playtest 2, CR 017): the Friends panel's "Travel"
// button. Server-authoritative, friendly rules:
//
//   - only to an accepted friend (social_friends in Postgres, checked off
//     the tick while the channel runs) who is online in this world: on this
//     zone, or (cluster mode) in the world presence feed;
//   - not while you are in combat (hurt or fighting in the last 10 s, or
//     downed), not to a friend who is;
//   - a 3 s channel first (Event 980; the client draws a bar and fades the
//     screen): moving more than 1 m or taking damage cancels it, so it is
//     never an instant escape;
//   - a 30 s cooldown after a successful travel.
//
// The move itself is Teleport (fast travel's path): the player lands on the
// friend's spot; when that spot belongs to another zone, WP16's handoff
// moves the player there as it would after walking across.
//
// The friend is named by a 64-bit FNV-1a hash of their character id in
// Interact's targetId (Interact carries no string); the zone matches it
// against its sessions and the presence feed.

import (
	"context"
	"errors"
	"hash/fnv"
	"math"
	"time"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

// Interact 61 `friend` (contracts/events.md).
const (
	InteractFriend        = 61
	FriendActTravel       = 1 // targetId = FriendHash(friend character id)
	FriendActTravelCancel = 2
)

// Event kinds 980-989 (CR 017).
const (
	EventTravelChannel = 980 // channel started: value = ms, entityId = you, targetId = friend entity (0 on another zone), data = friend name
	EventTravelRefused = 981 // value = reason below, data = friend name (if known)
	EventTravelArrived = 982 // after the teleport: data = friend name
)

// Travel refusal reasons (Event 981 value).
const (
	TravelRefuseOffline     = 1 // not online in this world (or unknown)
	TravelRefuseNotFriend   = 2
	TravelRefuseInCombat    = 3 // you
	TravelRefuseFriendBusy  = 4 // they are in combat or downed
	TravelRefuseCooldown    = 5
	TravelRefuseMoved       = 6 // you moved: channel cancelled
	TravelRefuseHurt        = 7 // you were hurt: channel cancelled
	TravelRefuseCancelled   = 8 // you cancelled
	TravelRefuseUnavailable = 9 // the zone cannot check friendships (no database)
	TravelRefuseSelf        = 10
)

const (
	friendTravelChannel  = 3 * time.Second
	friendTravelCooldown = 30 * time.Second
	friendTravelCombatS  = 10
	friendTravelMoveM    = 1.0
)

// FriendStore answers "are these two characters friends" (PGStore
// implements it with social_friends).
type FriendStore interface {
	AreFriends(ctx context.Context, a, b string) (bool, error)
}

// AreFriends implements FriendStore: an accepted social_friends row either way.
func (p *PGStore) AreFriends(ctx context.Context, a, b string) (bool, error) {
	if !uuidRe.MatchString(a) || !uuidRe.MatchString(b) {
		return false, nil
	}
	var n int
	err := p.Pool.QueryRow(ctx, `SELECT count(*) FROM social_friends WHERE state = 'accepted'
		AND ((requester = $1::uuid AND target = $2::uuid) OR (requester = $2::uuid AND target = $1::uuid))`, a, b).Scan(&n)
	return n > 0, err
}

// FriendHash is Interact 61's targetId for a character id (the client
// computes the same: client/src/social/travel.ts).
func FriendHash(characterID string) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(characterID))
	return h.Sum64()
}

// friendTravel is one channel in progress (session-owned, tick goroutine).
type friendTravel struct {
	friend  string // character id
	name    string
	start   movement.Vec3
	health  float64
	until   time.Time
	checked bool // the friendship check answered
	friends bool
}

// presenceSeen is a player on another zone (applyPresence, ghosts.go).
type presenceSeen struct {
	pos  movement.Vec3
	name string
	t    float64 // source server time (ms)
}

// friendSeen is a friend's whereabouts.
type friendSeen struct {
	ent  *Entity // on this zone
	pos  movement.Vec3
	name string
}

// findFriend resolves a hash to an online character: this zone first, then
// the world presence feed (other zones of a cluster).
func (s *Server) findFriend(hash uint64, self string) (string, friendSeen, bool) {
	for id, o := range s.byChar {
		if o.ent != nil && !o.closed.Load() && id != self && FriendHash(id) == hash {
			return id, friendSeen{ent: o.ent, pos: o.ent.Move.Pos, name: o.ent.Name}, true
		}
	}
	nowMs := s.serverTimeMs()
	for id, p := range s.cl.presenceChar {
		if id != self && FriendHash(id) == hash && nowMs-p.t <= float64(presenceMaxAge/time.Millisecond) {
			return id, friendSeen{pos: p.pos, name: p.name}, true
		}
	}
	return "", friendSeen{}, false
}

// inCombatFor: hurt or fighting in the last friendTravelCombatS seconds, or downed.
func (s *Server) inCombatFor(e *Entity) bool {
	if e == nil || e.cbt == nil {
		return false
	}
	return e.cbt.Downed || e.cbt.InCombatWithin(s.cbt.w.Tick(), friendTravelCombatS)
}

func (s *Server) travelRefuse(sess *session, reason int32, name string) {
	s.sendEvent(sess, &proto.Event{Kind: EventTravelRefused, EntityID: sess.ent.ID, Value: reason, Data: []byte(name)})
}

// friendInteract applies Interact 61 (tick goroutine).
// hpOf is the player's health (combat's, when combat runs).
func hpOf(e *Entity) float64 {
	if e.cbt != nil {
		return e.cbt.HP
	}
	return float64(e.Health)
}

func (s *Server) friendInteract(sess *session, m *proto.Interact, now time.Time) {
	e := sess.ent
	if e == nil {
		return
	}
	switch m.Action {
	case FriendActTravelCancel:
		if sess.travel != nil {
			sess.travel = nil
			s.travelRefuse(sess, TravelRefuseCancelled, "")
		}
		return
	case FriendActTravel:
	default:
		return
	}
	fs, ok := s.cfg.Store.(FriendStore)
	if !ok || s.cfg.Store == nil {
		s.travelRefuse(sess, TravelRefuseUnavailable, "")
		return
	}
	if sess.travel != nil {
		return // already channelling: the click again does nothing
	}
	if now.Sub(sess.lastFriendTravel) < friendTravelCooldown {
		s.travelRefuse(sess, TravelRefuseCooldown, "")
		return
	}
	if s.inCombatFor(e) {
		s.travelRefuse(sess, TravelRefuseInCombat, "")
		return
	}
	if m.TargetID == FriendHash(e.CharacterID) {
		s.travelRefuse(sess, TravelRefuseSelf, "")
		return
	}
	id, f, ok := s.findFriend(m.TargetID, e.CharacterID)
	if !ok {
		s.travelRefuse(sess, TravelRefuseOffline, "")
		return
	}
	if s.inCombatFor(f.ent) {
		s.travelRefuse(sess, TravelRefuseFriendBusy, f.name)
		return
	}
	tr := &friendTravel{friend: id, name: f.name, start: e.Move.Pos, health: hpOf(e), until: now.Add(friendTravelChannel)}
	sess.travel = tr
	var fid uint32
	if f.ent != nil {
		fid = f.ent.ID
	}
	s.sendEvent(sess, &proto.Event{Kind: EventTravelChannel, EntityID: e.ID, TargetID: fid, Value: int32(friendTravelChannel / time.Millisecond), Data: []byte(f.name)})
	// The friendship check is I/O: off the tick, answered on it.
	self := e.CharacterID
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		yes, err := fs.AreFriends(ctx, self, id)
		if err != nil && !errors.Is(err, context.Canceled) {
			s.log.Warn("friend travel: friendship check failed", "character", self, "friend", id, "err", err)
		}
		_ = s.Do(ctx, func() {
			if sess.travel == tr {
				tr.checked, tr.friends = true, yes && err == nil
			}
		})
	}()
}

// friendTravelTick advances channels (tick goroutine).
func (s *Server) friendTravelTick(now time.Time) {
	for _, sess := range s.sessions {
		tr, e := sess.travel, sess.ent
		if tr == nil || e == nil {
			continue
		}
		if tr.checked && !tr.friends {
			sess.travel = nil
			s.travelRefuse(sess, TravelRefuseNotFriend, tr.name)
			continue
		}
		if math.Hypot(e.Move.Pos.X-tr.start.X, e.Move.Pos.Z-tr.start.Z) > friendTravelMoveM {
			sess.travel = nil
			s.travelRefuse(sess, TravelRefuseMoved, tr.name)
			continue
		}
		if hpOf(e) < tr.health || s.inCombatFor(e) {
			sess.travel = nil
			s.travelRefuse(sess, TravelRefuseHurt, tr.name)
			continue
		}
		if !tr.checked && now.After(tr.until.Add(3*time.Second)) {
			sess.travel = nil
			s.travelRefuse(sess, TravelRefuseUnavailable, tr.name)
			continue
		}
		if now.Before(tr.until) || !tr.checked {
			continue // the check gets until the channel ends plus its own 2 s timeout
		}
		sess.travel = nil
		_, f, ok := s.findFriend(FriendHash(tr.friend), e.CharacterID)
		switch {
		case !ok:
			s.travelRefuse(sess, TravelRefuseOffline, tr.name)
			continue
		case s.inCombatFor(f.ent):
			s.travelRefuse(sess, TravelRefuseFriendBusy, tr.name)
			continue
		}
		sess.lastFriendTravel = now
		s.Teleport(e, f.pos)
		s.sendEvent(sess, &proto.Event{Kind: EventTravelArrived, EntityID: e.ID, Data: []byte(tr.name)})
		s.log.Info("friend travel", "character", e.CharacterID, "friend", tr.friend, "x", f.pos.X, "y", f.pos.Y, "z", f.pos.Z, "sameZone", f.ent != nil)
	}
}
