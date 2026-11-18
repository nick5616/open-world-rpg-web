package game

// Parties in the zone (WP12): the party ring and party pins.
//
// The social service owns parties (spec 10: "party state lives in Redis"):
// `partyof:{characterId}` -> party id, kept through the 5-minute reconnect
// grace. The zone never talks to the social service; a poller goroutine
// reads those keys every partyPollEvery for the characters it hosts and
// hands the result to the tick, which sets Entity.PartyID (a 32-bit hash of
// the party id, the snapshot's partyId field) so members get each other in
// the party ring at any distance. That is what the compass and map draw.
//
// Party pins (decision: relayed by the zone, stored next to the party in
// Redis; docs/decisions/0012-exploration.md): a member places one shared pin;
// the zone updates its in-memory copy, pushes the pins Event to members it
// hosts immediately, and writes `partypins:{worldId}:{partyId}` so members
// on other zones (or reconnecting) pick it up on their next poll.

import (
	"context"
	"encoding/json"
	"hash/fnv"
	"slices"
	"sort"
	"time"

	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/writebehind"
	"lodestone/server/zone/internal/explore"
)

// PartyPin is one member's shared pin.
type PartyPin struct {
	CharacterID string `json:"c"`
	Owner       string `json:"o"`
	Color       uint8  `json:"k"`
	XCm         int32  `json:"x"`
	ZCm         int32  `json:"z"`
}

// PartyDirectory reads party membership and stores party pins. Called off
// the tick only.
type PartyDirectory interface {
	// Lookup maps character ids to party ids ("" = no party).
	Lookup(ctx context.Context, characterIDs []string) (map[string]string, error)
	LoadPins(ctx context.Context, partyID string) ([]PartyPin, error)
	SavePins(ctx context.Context, partyID string, pins []PartyPin) error
}

// RedisParties is the PartyDirectory over the social service's Redis keys.
type RedisParties struct {
	RDB     *redis.Client
	WorldID string
}

// Lookup implements PartyDirectory (MGET partyof:{id}).
func (r *RedisParties) Lookup(ctx context.Context, ids []string) (map[string]string, error) {
	out := make(map[string]string, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	keys := make([]string, len(ids))
	for i, id := range ids {
		keys[i] = "partyof:" + id
	}
	vals, err := r.RDB.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, err
	}
	for i, v := range vals {
		if s, ok := v.(string); ok {
			out[ids[i]] = s
		} else {
			out[ids[i]] = ""
		}
	}
	return out, nil
}

func (r *RedisParties) pinKey(party string) string { return "partypins:" + r.WorldID + ":" + party }

// LoadPins implements PartyDirectory.
func (r *RedisParties) LoadPins(ctx context.Context, party string) ([]PartyPin, error) {
	b, err := r.RDB.Get(ctx, r.pinKey(party)).Bytes()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var pins []PartyPin
	if err := json.Unmarshal(b, &pins); err != nil {
		return nil, nil // a corrupt record must not break the party
	}
	return pins, nil
}

// SavePins implements PartyDirectory.
func (r *RedisParties) SavePins(ctx context.Context, party string, pins []PartyPin) error {
	if len(pins) == 0 {
		return r.RDB.Del(ctx, r.pinKey(party)).Err()
	}
	b, _ := json.Marshal(pins)
	return r.RDB.Set(ctx, r.pinKey(party), b, partyPinTTL).Err()
}

const (
	// partyPollEvery: membership changes (invite accepted, kick) reach the
	// party ring within ~2 s, the ring's own 2 Hz cadence for distant
	// members. 150 players = one MGET of 150 keys every 2 s.
	partyPollEvery = 2 * time.Second
	// partyPinLocalHold: after this zone changed a party's pins, polled
	// copies older than the change are ignored for this long (the Redis
	// write may still be in the queue).
	partyPinLocalHold = 5 * time.Second
)

type partyUpdate struct {
	at   time.Time
	keys map[string]string
	pins map[string][]PartyPin
}

// partyState is tick-owned.
type partyState struct {
	ask       chan []string    // tick -> poller: characters hosted now
	upd       chan partyUpdate // poller -> tick
	pins      map[string][]PartyPin
	localAt   map[string]time.Time
	lastAsked time.Time
}

// PartyHash is the snapshot partyId for a social party id: FNV-1a 32,
// never 0 (0 = no party). Every zone computes the same value.
func PartyHash(party string) uint32 {
	if party == "" {
		return 0
	}
	h := fnv.New32a()
	h.Write([]byte(party))
	v := h.Sum32()
	if v == 0 {
		v = 1
	}
	return v
}

// startParties launches the poller (Start calls it when a directory is set).
func (s *Server) startParties() {
	if s.cfg.Parties == nil {
		return
	}
	s.party = partyState{ask: make(chan []string, 1), upd: make(chan partyUpdate, 1), pins: map[string][]PartyPin{}, localAt: map[string]time.Time{}}
	go s.partyPoller()
}

func (s *Server) partyPoller() {
	var ids []string
	for {
		select {
		case <-s.stopped:
			return
		case ids = <-s.party.ask:
		}
		at := time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		keys, err := s.cfg.Parties.Lookup(ctx, ids)
		if err != nil {
			cancel()
			s.log.Debug("party lookup failed", "err", err)
			continue
		}
		pins := map[string][]PartyPin{}
		for _, k := range keys {
			if _, done := pins[k]; k == "" || done {
				continue
			}
			p, err := s.cfg.Parties.LoadPins(ctx, k)
			if err == nil {
				pins[k] = p
			}
		}
		cancel()
		select {
		case s.party.upd <- partyUpdate{at: at, keys: keys, pins: pins}:
		default: // the tick hasn't taken the previous one; this one is newer next time
		}
	}
}

// partyTick (tick goroutine): asks the poller for fresh membership every
// partyPollEvery and applies whatever came back.
func (s *Server) partyTick(_ uint32) {
	if s.cfg.Parties == nil || s.party.ask == nil {
		return
	}
	now := time.Now()
	if now.Sub(s.party.lastAsked) >= partyPollEvery {
		s.party.lastAsked = now
		ids := make([]string, 0, len(s.sessions))
		for _, sess := range s.sessions {
			if sess.ent != nil {
				ids = append(ids, sess.ent.CharacterID)
			}
		}
		select {
		case s.party.ask <- ids:
		default:
		}
	}
	select {
	case u := <-s.party.upd:
		s.applyParty(u)
	default:
	}
}

func (s *Server) applyParty(u partyUpdate) {
	changedPins := map[string]bool{}
	for k, pins := range u.pins {
		if t, ok := s.party.localAt[k]; ok && u.at.Before(t.Add(partyPinLocalHold)) {
			continue
		}
		if !pinsEqual(s.party.pins[k], pins) {
			s.party.pins[k] = pins
			changedPins[k] = true
		}
	}
	for _, sess := range s.sessions {
		e := sess.ent
		if e == nil || e.x == nil {
			continue
		}
		key, ok := u.keys[e.CharacterID]
		if !ok {
			continue // joined after the ask; next poll
		}
		if key != e.x.partyKey {
			old := e.x.partyKey
			s.setParty(e, key)
			if old != "" {
				s.dropPartyPin(old, e.CharacterID)
				changedPins[old] = true
			}
			s.sendEvent(sess, &proto.Event{Kind: EventParty, EntityID: e.ID, Value: int32(e.PartyID)})
			s.sendPins(sess)
			continue
		}
		if key != "" && changedPins[key] {
			s.sendPins(sess)
		}
	}
	for k := range changedPins {
		s.broadcastPins(k, nil)
	}
}

// setParty moves an entity between party groups (the party ring reads
// s.parties).
func (s *Server) setParty(e *Entity, key string) {
	if e.PartyID != 0 {
		ps := s.parties[e.PartyID]
		if i := slices.Index(ps, e); i >= 0 {
			s.parties[e.PartyID] = slices.Delete(ps, i, i+1)
		}
		if len(s.parties[e.PartyID]) == 0 {
			delete(s.parties, e.PartyID)
		}
	}
	e.x.partyKey = key
	e.PartyID = PartyHash(key)
	if e.PartyID != 0 {
		s.parties[e.PartyID] = append(s.parties[e.PartyID], e)
	}
}

// pinViews is what one player's pins Event shows: their personal pins and
// every party pin of their party.
func (s *Server) pinViews(sess *session) []explore.PinView {
	var out []explore.PinView
	for _, p := range sess.x.prog.Pins {
		out = append(out, explore.PinView{Slot: p.Slot, Color: p.Color, XCm: p.XCm, ZCm: p.ZCm, Owner: p.Label})
	}
	if k := sess.x.partyKey; k != "" {
		for i, p := range s.party.pins[k] {
			out = append(out, explore.PinView{Party: true, Slot: uint8(i), Color: p.Color, XCm: p.XCm, ZCm: p.ZCm, Owner: p.Owner})
		}
	}
	return out
}

func (s *Server) sendPins(sess *session) {
	if s.cfg.Explore == nil || sess.x == nil {
		return
	}
	s.sendEvent(sess, &proto.Event{Kind: EventPins, EntityID: sess.ent.ID, Data: explore.EncodePins(s.pinViews(sess))})
}

// broadcastPins sends the pins Event to every hosted member of a party.
func (s *Server) broadcastPins(key string, skip *session) {
	for _, o := range s.sessions {
		if o != skip && o.x != nil && o.x.partyKey == key {
			s.sendPins(o)
		}
	}
}

func (s *Server) dropPartyPin(key, charID string) bool {
	pins := s.party.pins[key]
	i := slices.IndexFunc(pins, func(p PartyPin) bool { return p.CharacterID == charID })
	if i < 0 {
		return false
	}
	s.party.pins[key] = slices.Delete(slices.Clone(pins), i, i+1)
	s.storePartyPins(key)
	return true
}

func (s *Server) storePartyPins(key string) {
	s.party.localAt[key] = time.Now()
	if s.cfg.Queue == nil || s.cfg.Parties == nil {
		return
	}
	pins := slices.Clone(s.party.pins[key])
	dir := s.cfg.Parties
	s.cfg.Queue.Enqueue(writebehind.Op{Key: "partypins:" + key, Run: func(ctx context.Context) error {
		return dir.SavePins(ctx, key, pins)
	}})
}

// pinAction applies a pin Interact (personal pins persist with the
// character; party pins with the party).
func (s *Server) pinAction(sess *session, m *proto.Interact) {
	x := sess.x
	switch m.Action {
	case ActionPinSet:
		xc, zc, ok := explore.UnpackPinPos(m.TargetID, s.cfg.Explore.Atlas.WorldSize)
		if ok && x.prog.SetPin(uint8(m.Arg), uint8(m.Arg>>8), xc, zc) {
			s.sendPins(sess)
			s.saveProgressSoon(sess, false)
		}
	case ActionPinClear:
		if x.prog.ClearPin(uint8(m.Arg)) {
			s.sendPins(sess)
			s.saveProgressSoon(sess, false)
		}
	case ActionPartyPinSet:
		xc, zc, ok := explore.UnpackPinPos(m.TargetID, s.cfg.Explore.Atlas.WorldSize)
		if !ok || x.partyKey == "" {
			return
		}
		key := x.partyKey
		pins := slices.Clone(s.party.pins[key])
		pin := PartyPin{CharacterID: sess.ent.CharacterID, Owner: sess.ent.Name, Color: uint8(m.Arg), XCm: xc, ZCm: zc}
		if i := slices.IndexFunc(pins, func(p PartyPin) bool { return p.CharacterID == pin.CharacterID }); i >= 0 {
			pins[i] = pin
		} else {
			pins = append(pins, pin)
		}
		// Stable order (by owner) so every member's slot numbers agree.
		sort.Slice(pins, func(i, j int) bool { return pins[i].CharacterID < pins[j].CharacterID })
		s.party.pins[key] = pins
		s.storePartyPins(key)
		s.broadcastPins(key, nil)
	case ActionPartyPinClear:
		if x.partyKey != "" && s.dropPartyPin(x.partyKey, sess.ent.CharacterID) {
			s.broadcastPins(x.partyKey, nil)
		}
	}
}

func pinsEqual(a, b []PartyPin) bool { return slices.Equal(a, b) }
