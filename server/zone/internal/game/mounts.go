package game

// Playtest 2 mounts (CR 027, docs/cr/027-mounts.md): the spirit steed.
//
// Buy a Spirit Whistle (general stores, 40 gold) and press H: the first
// whistle bonds a steed to the character (persisted: character_mounts,
// migration 0028, or the local save's `mounts`), every whistle calls it. It
// gallops in from STEED_ARRIVE_FROM_M away over STEED_ARRIVE_S (or
// materializes where there is no dry, walkable spot) and stands beside you;
// E within STEED_MOUNT_REACH_M mounts (Interact 110/2), E again (or Space at
// a standstill, which the step does itself) gets off.
//
// Riding is the shared movement step's (server/pkg/movement/ride.go):
// mounting sets movement.FlagMounted on the player's state (only the zone
// ever sets it; the step only clears it) and the client learns it from
// SelfState like any server change. Every tick this file watches its
// riders: the step dropped them (a hop, a hard landing, deep water, a
// teleport), a hit that cost health throws them (STEED_HIT_DISMOUNT_CHANCE),
// and at night a demon within STEED_SPOOK_RADIUS_M may spook the steed: the
// rider is thrown, the steed bolts and can't be called for
// STEED_SPOOK_COOLDOWN_S. A rider can't dash, parry or swing a melee weapon
// (combatFrame strips those bits; bows, staves, wands and spells work).
//
// Others see it cheaply: a riding player's snapshot typeId has bit 14 set
// (TypeRiding; flips only on mount and dismount), and Event 1141 tells
// players within STEED_SEE_M a steed's look and where it stands (on every
// change, and to newcomers by a 2 s check; nothing at all while nobody has
// a steed out, so the scale scenario's wire is unchanged).

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"math/rand/v2"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/weather"
	"lodestone/server/pkg/writebehind"
	"lodestone/server/zone/internal/items"
	"lodestone/server/zone/internal/quests"
)

// InteractSteed is contracts/events.md Interact 110 `steed`.
const InteractSteed = 110

// Interact 110 actions.
const (
	SteedActSummon   = 1 // H: bond (first time, with a Spirit Whistle) and call the steed
	SteedActMount    = 2 // E by the steed
	SteedActDismount = 3 // E in the saddle
	SteedActName     = 4 // targetId = chunk (0 starts over), arg = 4 ASCII bytes (a 0 byte ends it)
	SteedActColour   = 5 // arg = colour index
	SteedActDismiss  = 6 // send it away
	SteedActSync     = 7 // send 1140 again
	SteedActDev      = 9 // dev builds: a Spirit Whistle
)

// Events 1140-1159 (contracts/events.md).
const (
	EventSteedSync    = 1140
	EventSteedState   = 1141
	EventSteedRefused = 1142
	EventSteedThrown  = 1143
)

// Steed phases (Event 1141 value).
const (
	SteedGone     = 0
	SteedArriving = 1
	SteedStanding = 2
	SteedRidden   = 3
	SteedBolting  = 4 // spooked: it runs off and fades (then gone)
)

// Refusals (Event 1142 value).
const (
	SteedRefuseUnknown  = 1
	SteedRefuseNoSteed  = 2  // no steed bonded and no Spirit Whistle
	SteedRefuseCooldown = 3  // spooked: targetId = ms left
	SteedRefuseHere     = 4  // underground
	SteedRefuseFar      = 5  // too far to mount
	SteedRefuseBusy     = 6  // not now: swimming, climbing, gliding, in the air, dashing
	SteedRefuseNotOut   = 7  // no steed out to mount
	SteedRefuseDowned   = 8  // you are down
	SteedRefuseName     = 9  // a name of 1-16 letters, digits, spaces, ' or -
	SteedRefuseRiding   = 10 // already riding
	SteedRefuseSky      = 11 // CR 038: in the sky (steeds can't fly)
)

// Thrown causes (Event 1143 value).
const (
	ThrownHop    = 0 // Space at a standstill (the step)
	ThrownHit    = 1
	ThrownSpook  = 2
	ThrownFall   = 3
	ThrownWater  = 4
	ThrownGetOff = 5 // E
	ThrownTravel = 6 // fast travel, respawn: the steed stays behind and fades
)

// TypeRiding is the player typeId bit a rider carries (bits 0-11 weapon
// look, 12-13 PvP; contracts/events.md "Player entities").
const TypeRiding uint16 = 1 << 14

// SteedColours is the number of colour choices (the client's palette).
const SteedColours = 6

const (
	steedKindSpirit   = 1
	steedWhistle      = "tool:spirit_whistle"
	steedDefaultName  = "Spirit Steed"
	steedNameMax      = 16
	steedSaveKey      = "mounts:"
	steedTellEvery    = 60 // ticks: the newcomer check (2 s)
	steedSpookEvery   = 30 // ticks: spook rolls (1 s, staggered)
	steedBoltS        = 1.6
	steedTravelJumpM  = 24 // a rider moved this far in one tick: a teleport, the steed stays behind
	steedMaterializeS = 0.9
)

// SteedRec is one owned steed (persisted).
type SteedRec struct {
	Kind     int    `json:"kind"`
	Name     string `json:"name"`
	Colour   int    `json:"colour"`
	BondedAt int64  `json:"bondedAt"` // unix ms
}

// steedSave is the persisted JSON (local saves; the table's rows map 1:1).
type steedSave struct {
	V      int        `json:"v"`
	Steeds []SteedRec `json:"steeds"`
}

// steedSess is one session's steed: what it owns and the steed it has out.
type steedSess struct {
	owned    []SteedRec
	phase    int
	x, y, z  float64 // where it stands (or will, arriving)
	fx, fz   float64 // arriving: where it came from
	arriveAt time.Time
	since    time.Time // standing since (fades after STEED_IDLE_S)
	cooldown time.Time // spooked: no summon until
	boltEnd  time.Time
	rx, rz   float64 // riding: last tick's position (teleport detection)
	health   uint16  // last tick's health (hit detection)
	cause    int     // the zone's own throw this tick (-1 none)
	label    []byte  // name chunks being received
	ver      uint32  // bumps on every state change (1141)
	dirty    bool
	told     map[uint32]uint32 // other owners' steed versions told to this client
}

// steedGlue is the server-wide part.
type steedGlue struct {
	handed map[string]steedHanded
	rng    *rand.Rand
}

type steedHanded struct {
	Owned []SteedRec `json:"owned"`
	Phase int        `json:"phase"`
	X     float64    `json:"x"`
	Y     float64    `json:"y"`
	Z     float64    `json:"z"`
	Cool  int64      `json:"cool,omitempty"` // unix ms
}

func init() {
	RegisterHandoffField(HandoffField{
		Name: "steed",
		Save: func(s *Server, e *Entity) json.RawMessage {
			sess := s.byChar[e.CharacterID]
			if sess == nil || sess.steed == nil {
				return nil
			}
			st := sess.steed
			h := steedHanded{Owned: st.owned, Phase: st.phase, X: st.x, Y: st.y, Z: st.z}
			if !st.cooldown.IsZero() {
				h.Cool = st.cooldown.UnixMilli()
			}
			b, _ := json.Marshal(h)
			return b
		},
		Load: func(s *Server, e *Entity, data json.RawMessage) {
			var h steedHanded
			if json.Unmarshal(data, &h) != nil {
				return
			}
			if s.steeds.handed == nil {
				s.steeds.handed = map[string]steedHanded{}
			}
			s.steeds.handed[e.CharacterID] = h
		},
	})
}

func newSteedSess() *steedSess {
	return &steedSess{told: map[uint32]uint32{}, cause: -1}
}

func (s *Server) steedRand() float64 {
	if s.steeds.rng == nil {
		s.steeds.rng = rand.New(rand.NewPCG(s.cfg.Seed, 0x5713ed))
	}
	return s.steeds.rng.Float64()
}

// ---- persistence ----

// MountStore persists owned steeds (PGStore implements it).
type MountStore interface {
	LoadMounts(ctx context.Context, characterID string) ([]SteedRec, error)
	SaveMounts(ctx context.Context, characterID string, steeds []SteedRec, epoch int64) error
}

// LoadMounts implements MountStore.
func (p *PGStore) LoadMounts(ctx context.Context, id string) ([]SteedRec, error) {
	if !uuidRe.MatchString(id) {
		return nil, nil
	}
	rows, err := p.Pool.Query(ctx, `SELECT kind, name, colour, bonded_at FROM character_mounts WHERE character_id = $1::uuid ORDER BY slot`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SteedRec
	for rows.Next() {
		var r SteedRec
		var at time.Time
		if err := rows.Scan(&r.Kind, &r.Name, &r.Colour, &at); err != nil {
			return nil, err
		}
		r.BondedAt = at.UnixMilli()
		out = append(out, r)
	}
	return out, rows.Err()
}

// SaveMounts implements MountStore: one row per steed (slot = its index),
// epoch-fenced like character_content (an older owner's late save never
// overwrites a newer zone's).
func (p *PGStore) SaveMounts(ctx context.Context, id string, steeds []SteedRec, epoch int64) error {
	if !uuidRe.MatchString(id) {
		return ErrNoRow
	}
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		for i, r := range steeds {
			_, err := tx.Exec(ctx, `
				INSERT INTO character_mounts (character_id, slot, kind, name, colour, bonded_at, epoch, updated_at)
				VALUES ($1::uuid, $2, $3, $4, $5, to_timestamp($6::double precision / 1000), $7, now())
				ON CONFLICT (character_id, slot) DO UPDATE SET kind = EXCLUDED.kind, name = EXCLUDED.name, colour = EXCLUDED.colour,
					epoch = GREATEST(character_mounts.epoch, EXCLUDED.epoch), updated_at = now()
				WHERE EXCLUDED.epoch = 0 OR character_mounts.epoch <= EXCLUDED.epoch`, id, i, r.Kind, r.Name, r.Colour, float64(r.BondedAt), epoch)
			if err != nil {
				return err
			}
		}
		_, err := tx.Exec(ctx, `DELETE FROM character_mounts WHERE character_id = $1::uuid AND slot >= $2 AND ($3 = 0 OR epoch <= $3)`, id, len(steeds), epoch)
		return err
	})
	var pe *pgconn.PgError
	if errors.As(err, &pe) && pe.Code == "23503" {
		return ErrNoRow
	}
	return err
}

// loadSteeds runs on the connection goroutine before join.
func (s *Server) loadSteeds(characterID string, x *exploreState) *steedSess {
	st := newSteedSess()
	if x != nil && x.local != nil {
		st.owned = parseSteeds(x.local.state.Mounts)
		return st
	}
	store, ok := s.cfg.Store.(MountStore)
	if !ok || s.cfg.Store == nil {
		return st
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	owned, err := store.LoadMounts(ctx, characterID)
	if err != nil {
		s.log.Warn("mounts load failed; no steed this session", "character", characterID, "err", err)
	}
	st.owned = owned
	return st
}

func parseSteeds(raw json.RawMessage) []SteedRec {
	if len(raw) == 0 {
		return nil
	}
	var v steedSave
	if json.Unmarshal(raw, &v) != nil {
		return nil
	}
	return v.Steeds
}

// steedsIntoLocal copies the owned steeds into a local save's state (localState).
func steedsIntoLocal(sess *session, raw *json.RawMessage) {
	if sess.steed == nil || len(sess.steed.owned) == 0 {
		return
	}
	b, _ := json.Marshal(steedSave{V: 1, Steeds: sess.steed.owned})
	*raw = b
	sess.steed.dirty = false
}

// saveSteeds persists a changed set: accounts through the write-behind
// queue (coalesced per character), local profiles in the next save blob.
func (s *Server) saveSteeds(sess *session) {
	st, e := sess.steed, sess.ent
	if st == nil || e == nil || !st.dirty || s.cfg.Queue == nil {
		return
	}
	if sess.x != nil && sess.x.local != nil {
		sess.x.prog.MarkDirty() // steedsIntoLocal copies them into the blob
		s.saveProgressSoon(sess, false)
		return
	}
	store, ok := s.cfg.Store.(MountStore)
	if !ok || s.cfg.Store == nil {
		return
	}
	st.dirty = false
	owned, id, epoch, log := append([]SteedRec(nil), st.owned...), e.CharacterID, e.epoch, s.log
	s.cfg.Queue.Enqueue(writebehind.Op{Key: steedSaveKey + id, Run: func(ctx context.Context) error {
		err := store.SaveMounts(ctx, id, owned, epoch)
		if err != nil && errors.Is(err, writebehind.ErrSkip) {
			if _, seen := loggedMissing.LoadOrStore(steedSaveKey+id, true); !seen {
				log.Info("mounts save skipped: no character row", "character", id)
			}
		}
		return err
	}})
}

// ---- join, leave ----

func (s *Server) steedJoin(sess *session) {
	e := sess.ent
	if e == nil {
		return
	}
	if sess.steed == nil {
		sess.steed = newSteedSess()
	}
	st := sess.steed
	if h, ok := s.steeds.handed[e.CharacterID]; ok {
		delete(s.steeds.handed, e.CharacterID)
		st.owned = h.Owned
		if h.Cool > 0 {
			st.cooldown = time.UnixMilli(h.Cool)
		}
		if h.Phase == SteedRidden && movement.Mounted(e.Move) {
			st.phase, st.x, st.y, st.z = SteedRidden, e.Move.Pos.X, e.Move.Pos.Y, e.Move.Pos.Z
			st.rx, st.rz = e.Move.Pos.X, e.Move.Pos.Z
		}
	}
	if st.phase != SteedRidden && movement.Mounted(e.Move) {
		e.Move = movement.Dismount(e.Move) // no steed came along
		e.prevValid = e.Move
	}
	s.steedRetype(e)
	st.health = e.Health
	if st.phase != SteedGone {
		st.ver++
		s.steedBroadcast(sess)
	}
	if len(st.owned) > 0 || s.hasWhistle(sess) { // nothing for everyone else (the scale scenario's wire is unchanged)
		s.sendSteedSync(sess)
	}
}

func (s *Server) steedLeave(sess *session) {
	st := sess.steed
	if st == nil || sess.ent == nil {
		return
	}
	if st.dirty {
		s.saveSteeds(sess)
	}
	if st.phase != SteedGone {
		st.phase = SteedGone
		st.ver++
		s.steedBroadcast(sess)
	}
}

// steedRetype keeps the player's typeId riding bit in step with its state.
func (s *Server) steedRetype(e *Entity) {
	if movement.Mounted(e.Move) {
		e.TypeID |= TypeRiding
	} else {
		e.TypeID &^= TypeRiding
	}
}

// ---- events ----

type steedSyncJSON struct {
	Owned    bool    `json:"owned"`
	Name     string  `json:"name"`
	Colour   int     `json:"colour"`
	Kind     int     `json:"kind"`
	Whistle  bool    `json:"whistle"`
	Phase    int     `json:"phase"`
	X        float64 `json:"x"`
	Z        float64 `json:"z"`
	CoolMs   int64   `json:"coolMs"`
	Colours  int     `json:"colours"`
	Count    int     `json:"count"`
	ArriveMs int64   `json:"arriveMs"`
}

func (s *Server) hasWhistle(sess *session) bool {
	return sess.items != nil && sess.items.inv.Count(steedWhistle) > 0
}

// sendSteedSync is Event 1140: your steed (to you).
func (s *Server) sendSteedSync(sess *session) {
	st := sess.steed
	if st == nil || sess.ent == nil {
		return
	}
	now := s.cfg.Now()
	j := steedSyncJSON{Owned: len(st.owned) > 0, Whistle: s.hasWhistle(sess), Phase: st.phase, X: round2(st.x), Z: round2(st.z), Colours: SteedColours, Count: len(st.owned)}
	if len(st.owned) > 0 {
		j.Name, j.Colour, j.Kind = st.owned[0].Name, st.owned[0].Colour, st.owned[0].Kind
	}
	if st.cooldown.After(now) {
		j.CoolMs = st.cooldown.Sub(now).Milliseconds()
	}
	if st.phase == SteedArriving {
		j.ArriveMs = max(0, st.arriveAt.Sub(now).Milliseconds())
	}
	b, _ := json.Marshal(j)
	s.sendEvent(sess, &proto.Event{Kind: EventSteedSync, EntityID: sess.ent.ID, Value: int32(st.phase), Data: b})
}

type steedStateJSON struct {
	Phase  int     `json:"p"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Z      float64 `json:"z"`
	FX     float64 `json:"fx,omitempty"`
	FZ     float64 `json:"fz,omitempty"`
	Ms     int64   `json:"ms,omitempty"` // arriving or bolting: ms left
	Colour int     `json:"c"`
	Name   string  `json:"n"`
	Kind   int     `json:"k"`
}

// steedEvent is Event 1141 for sess's steed.
func (s *Server) steedEvent(sess *session) *proto.Event {
	st, e := sess.steed, sess.ent
	j := steedStateJSON{Phase: st.phase, X: round2(st.x), Y: round2(st.y), Z: round2(st.z), Kind: steedKindSpirit}
	if len(st.owned) > 0 {
		j.Colour, j.Name, j.Kind = st.owned[0].Colour, st.owned[0].Name, st.owned[0].Kind
	}
	now := s.cfg.Now()
	switch st.phase {
	case SteedArriving:
		j.FX, j.FZ = round2(st.fx), round2(st.fz)
		j.Ms = max(0, st.arriveAt.Sub(now).Milliseconds())
	case SteedBolting:
		j.FX, j.FZ = round2(st.fx), round2(st.fz) // where it runs to
		j.Ms = max(0, st.boltEnd.Sub(now).Milliseconds())
	}
	b, _ := json.Marshal(j)
	return &proto.Event{Kind: EventSteedState, EntityID: e.ID, Value: int32(st.phase), TargetID: st.ver, X: cm(st.x), Y: cm(st.y), Z: cm(st.z), Data: b}
}

// steedNear: o should hear about sess's steed (the owner or the steed in range).
func steedNear(o, sess *session) bool {
	if o.ent == nil || sess.ent == nil {
		return false
	}
	p, q, st := o.ent.Move.Pos, sess.ent.Move.Pos, sess.steed
	return math.Hypot(p.X-q.X, p.Z-q.Z) <= constants.SteedSeeM || math.Hypot(p.X-st.x, p.Z-st.z) <= constants.SteedSeeM
}

// steedBroadcast sends the current 1141 to the owner and to every session
// near (or told before: they hear it went away).
func (s *Server) steedBroadcast(sess *session) {
	st := sess.steed
	ev := proto.Encode(s.steedEvent(sess))
	id := sess.ent.ID
	for _, o := range s.sessions {
		if o.ent == nil {
			continue
		}
		if o.steed == nil {
			o.steed = newSteedSess()
		}
		_, before := o.steed.told[id]
		if o != sess && !before && !steedNear(o, sess) {
			continue
		}
		if st.phase == SteedGone {
			delete(o.steed.told, id)
		} else {
			o.steed.told[id] = st.ver
		}
		if err := o.conn.SendReliable(ev); err != nil {
			o.closed.Store(true)
		}
	}
}

func (s *Server) steedRefuse(sess *session, action uint8, reason int, target uint32) {
	s.sendEvent(sess, &proto.Event{Kind: EventSteedRefused, EntityID: sess.ent.ID, TargetID: target, Value: int32(reason), Data: []byte{action}})
}

// steedThrown is Event 1143 to the rider and the players near.
func (s *Server) steedThrown(sess *session, cause int) {
	e := sess.ent
	ev := proto.Encode(&proto.Event{Kind: EventSteedThrown, EntityID: e.ID, Value: int32(cause), X: cm(e.Move.Pos.X), Y: cm(e.Move.Pos.Y), Z: cm(e.Move.Pos.Z)})
	for _, o := range s.sessions {
		if o.ent == nil || (o != sess && math.Hypot(o.ent.Move.Pos.X-e.Move.Pos.X, o.ent.Move.Pos.Z-e.Move.Pos.Z) > constants.SteedSeeM) {
			continue
		}
		if err := o.conn.SendReliable(ev); err != nil {
			o.closed.Store(true)
		}
	}
}

// ---- Interact 110 ----

func (s *Server) steedInteract(sess *session, m *proto.Interact) {
	e := sess.ent
	if e == nil {
		return
	}
	if sess.steed == nil {
		sess.steed = newSteedSess()
	}
	switch m.Action {
	case SteedActSummon:
		s.steedSummon(sess)
	case SteedActMount:
		s.steedMount(sess)
	case SteedActDismount:
		if !movement.Mounted(e.Move) {
			s.steedRefuse(sess, m.Action, SteedRefuseUnknown, 0)
			return
		}
		sess.steed.cause = ThrownGetOff
		e.Move = movement.Dismount(e.Move)
		e.prevValid = e.Move
		s.steedDismounted(sess, ThrownGetOff)
	case SteedActName:
		s.steedName(sess, int(m.TargetID), m.Arg)
	case SteedActColour:
		st := sess.steed
		if len(st.owned) == 0 || m.Arg >= SteedColours {
			s.steedRefuse(sess, m.Action, SteedRefuseUnknown, 0)
			return
		}
		st.owned[0].Colour = int(m.Arg)
		s.steedChanged(sess)
	case SteedActDismiss:
		st := sess.steed
		if movement.Mounted(e.Move) {
			s.steedRefuse(sess, m.Action, SteedRefuseRiding, 0)
			return
		}
		if st.phase == SteedArriving || st.phase == SteedStanding {
			st.phase = SteedGone
			st.ver++
			s.steedBroadcast(sess)
			s.sendSteedSync(sess)
		}
	case SteedActSync:
		s.sendSteedSync(sess)
	case SteedActDev:
		s.steedDevGrant(sess)
	default:
		s.steedRefuse(sess, m.Action, SteedRefuseUnknown, 0)
	}
}

// steedChanged: the owned steed's name or colour changed: persist, tell.
func (s *Server) steedChanged(sess *session) {
	st := sess.steed
	st.dirty = true
	s.saveSteeds(sess)
	if st.phase != SteedGone {
		st.ver++
		s.steedBroadcast(sess)
	}
	s.sendSteedSync(sess)
}

func (s *Server) steedSummon(sess *session) {
	e, st := sess.ent, sess.steed
	now := s.cfg.Now()
	if movement.Mounted(e.Move) {
		s.steedRefuse(sess, SteedActSummon, SteedRefuseRiding, 0)
		return
	}
	if len(st.owned) == 0 {
		if !s.hasWhistle(sess) {
			s.steedRefuse(sess, SteedActSummon, SteedRefuseNoSteed, 0)
			return
		}
		// The first whistle bonds a steed to the character (the whistle stays: it calls it).
		st.owned = []SteedRec{{Kind: steedKindSpirit, Name: steedDefaultName, Colour: 0, BondedAt: now.UnixMilli()}}
		st.dirty = true
		s.saveSteeds(sess)
	}
	if st.cooldown.After(now) {
		s.steedRefuse(sess, SteedActSummon, SteedRefuseCooldown, uint32(st.cooldown.Sub(now).Milliseconds()))
		return
	}
	if e.cbt != nil && e.cbt.Downed {
		s.steedRefuse(sess, SteedActSummon, SteedRefuseDowned, 0)
		return
	}
	if e.caveSys >= 0 || e.layer == layerUnder || e.layer == layerDepths {
		s.steedRefuse(sess, SteedActSummon, SteedRefuseHere, 0)
		return
	}
	if e.layer == layerSky {
		s.steedRefuse(sess, SteedActSummon, SteedRefuseSky, 0)
		return
	}
	if e.Move.Mode == movement.ModeSwim || e.Move.Mode == movement.ModeClimb {
		s.steedRefuse(sess, SteedActSummon, SteedRefuseBusy, 0)
		return
	}
	g := s.cfg.Ground
	p := e.Move.Pos
	yaw := e.Yaw
	// Stand beside you (your right, 2.2 m), on dry walkable ground, else where you are.
	rx, rz := math.Cos(yaw), -math.Sin(yaw)
	tx, tz := p.X+rx*2.2, p.Z+rz*2.2
	if !s.steedSpotOK(tx, tz) {
		tx, tz = p.X, p.Z
	}
	ty := movement.GroundAt(g, tx, p.Y+1, tz)
	// Gallop in from behind you (else from a side), or materialize.
	fx, fz, from := tx, tz, false
	bx, bz := math.Sin(yaw), math.Cos(yaw) // behind = -forward
	for _, a := range []float64{0, 0.6, -0.6, 1.2, -1.2, math.Pi / 2, -math.Pi / 2} {
		c, sn := math.Cos(a), math.Sin(a)
		dx, dz := bx*c-bz*sn, bx*sn+bz*c
		cx, cz := tx+dx*constants.SteedArriveFromM, tz+dz*constants.SteedArriveFromM
		if cx < 1 || cz < 1 || cx > constants.WorldSizeM-1 || cz > constants.WorldSizeM-1 {
			continue
		}
		if s.steedSpotOK(cx, cz) && s.steedSpotOK((cx+tx)/2, (cz+tz)/2) {
			fx, fz, from = cx, cz, true
			break
		}
	}
	arrive := constants.SteedArriveS
	if !from {
		arrive = steedMaterializeS
	}
	st.phase, st.x, st.y, st.z, st.fx, st.fz = SteedArriving, tx, ty, tz, fx, fz
	st.arriveAt = now.Add(time.Duration(arrive * float64(time.Second)))
	st.since = now
	st.ver++
	s.steedBroadcast(sess)
	s.sendSteedSync(sess)
	s.questsDeed(sess, quests.DeedSteed) // CR 051: the steed errand
}

// steedSpotOK: dry, not too steep for the steed, inside the world.
func (s *Server) steedSpotOK(x, z float64) bool {
	if x < 1 || z < 1 || x > constants.WorldSizeM-1 || z > constants.WorldSizeM-1 {
		return false
	}
	g := s.cfg.Ground
	h := g.HeightAt(x, z)
	if movement.WaterAt(g, x, z)-h >= constants.RideSplashDepthM {
		return false
	}
	return movement.SlopeAt(g, x, z).T2 <= constants.RideWalkableTanSq
}

func (s *Server) steedMount(sess *session) {
	e, st := sess.ent, sess.steed
	if movement.Mounted(e.Move) {
		s.steedRefuse(sess, SteedActMount, SteedRefuseRiding, 0)
		return
	}
	if st.phase != SteedArriving && st.phase != SteedStanding {
		s.steedRefuse(sess, SteedActMount, SteedRefuseNotOut, 0)
		return
	}
	if e.cbt != nil && e.cbt.Downed {
		s.steedRefuse(sess, SteedActMount, SteedRefuseDowned, 0)
		return
	}
	p := e.Move.Pos
	if math.Hypot(p.X-st.x, p.Z-st.z) > constants.SteedMountReachM || math.Abs(p.Y-st.y) > 2.5 {
		s.steedRefuse(sess, SteedActMount, SteedRefuseFar, 0)
		return
	}
	if e.Move.Mode != movement.ModeGround || e.Move.Dash > 0 || !movement.Grounded(e.Move, s.cfg.Ground) {
		s.steedRefuse(sess, SteedActMount, SteedRefuseBusy, 0)
		return
	}
	e.Move = movement.Mount(e.Move)
	e.prevValid = e.Move
	st.phase = SteedRidden
	st.x, st.y, st.z = p.X, p.Y, p.Z
	st.rx, st.rz = p.X, p.Z
	st.health = e.Health
	st.ver++
	s.steedRetype(e)
	s.steedBroadcast(sess)
	s.sendSteedSync(sess)
	s.questsDeed(sess, quests.DeedRide) // CR 051
}

// steedDismounted: the rider left the saddle (cause): the steed stands
// beside them, or (a teleport) stays behind and fades.
func (s *Server) steedDismounted(sess *session, cause int) {
	e, st := sess.ent, sess.steed
	s.steedRetype(e)
	now := s.cfg.Now()
	p := e.Move.Pos
	switch cause {
	case ThrownTravel:
		st.phase = SteedGone
	case ThrownSpook:
		// It bolts away from the rider, fading.
		st.phase = SteedBolting
		st.x, st.y, st.z = st.rx, p.Y, st.rz
		yaw := e.Yaw
		st.fx, st.fz = st.x-math.Sin(yaw)*14, st.z-math.Cos(yaw)*14
		st.boltEnd = now.Add(time.Duration(steedBoltS * float64(time.Second)))
		st.cooldown = now.Add(time.Duration(constants.SteedSpookCooldownS * float64(time.Second)))
	default:
		rx, rz := math.Cos(e.Yaw), -math.Sin(e.Yaw)
		st.phase = SteedStanding
		st.x, st.z = p.X+rx*1.1, p.Z+rz*1.1
		st.y = movement.GroundAt(s.cfg.Ground, st.x, p.Y+1, st.z)
		st.since = now
	}
	st.ver++
	s.steedBroadcast(sess)
	s.steedThrown(sess, cause)
	s.sendSteedSync(sess)
}

func (s *Server) steedName(sess *session, chunk int, arg uint32) {
	st := sess.steed
	if len(st.owned) == 0 || chunk < 0 || chunk > 3 {
		s.steedRefuse(sess, SteedActName, SteedRefuseUnknown, 0)
		return
	}
	if chunk == 0 {
		st.label = st.label[:0]
	} else if len(st.label) != chunk*4 {
		return // a chunk went missing: wait for a restart
	}
	done := chunk == 3
	for i := 0; i < 4; i++ {
		c := byte(arg >> (8 * i))
		if c == 0 {
			done = true
			break
		}
		st.label = append(st.label, c)
	}
	if !done {
		return
	}
	name := trimSpaces(string(st.label))
	st.label = st.label[:0]
	ok := len(name) > 0 && len(name) <= steedNameMax
	for i := 0; ok && i < len(name); i++ {
		c := name[i]
		ok = c == ' ' || c == '\'' || c == '-' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
	}
	if !ok {
		s.steedRefuse(sess, SteedActName, SteedRefuseName, 0)
		return
	}
	st.owned[0].Name = name
	s.steedChanged(sess)
}

func (s *Server) steedDevGrant(sess *session) {
	if !s.cfg.DevSpawn || sess.items == nil {
		s.steedRefuse(sess, SteedActDev, SteedRefuseUnknown, 0)
		return
	}
	if s.hasWhistle(sess) {
		s.sendSteedSync(sess)
		return
	}
	var d items.Delta
	it := items.Stack(steedWhistle, 1)
	it.Prov = []items.Prov{{Ev: "dev_grant", Char: sess.ent.CharacterID, At: s.cfg.Now().UnixMilli()}}
	if left := sess.items.inv.Add(it, &d); left < 1 {
		s.commitItems(sess, &d, nil, "steed dev grant")
		s.sendGranted(sess, SourceCraft, []*items.Item{it})
	}
	s.sendSteedSync(sess)
}

// ---- the tick ----

func (s *Server) mountsTick(tick uint32) {
	now := s.cfg.Now()
	night := false
	nightKnown := false
	for _, sess := range s.sessions {
		st, e := sess.steed, sess.ent
		if st == nil || e == nil {
			continue
		}
		switch st.phase {
		case SteedArriving:
			if !now.Before(st.arriveAt) {
				st.phase = SteedStanding
				st.since = now
				st.ver++
				s.steedBroadcast(sess)
				s.sendSteedSync(sess)
			}
		case SteedStanding:
			if now.Sub(st.since) > time.Duration(constants.SteedIdleS*float64(time.Second)) {
				st.phase = SteedGone
				st.ver++
				s.steedBroadcast(sess)
				s.sendSteedSync(sess)
			}
		case SteedBolting:
			if !now.Before(st.boltEnd) {
				st.phase = SteedGone
				st.ver++
				s.steedBroadcast(sess)
				s.sendSteedSync(sess)
			}
		case SteedRidden:
			if !nightKnown {
				night, nightKnown = weather.IsNight(s.worldTimeS()), true
			}
			s.riderTick(sess, tick, now, night)
		}
		if st.dirty && sess.x != nil && sess.x.local == nil {
			s.saveSteeds(sess)
		}
	}
	if tick%steedTellEvery == 0 {
		s.steedsTell()
	}
}

// riderTick watches one rider: dropped by the step, a teleport, hits, demons.
func (s *Server) riderTick(sess *session, tick uint32, now time.Time, night bool) {
	e, st := sess.ent, sess.steed
	p := e.Move.Pos
	if !movement.Mounted(e.Move) {
		cause := ThrownFall
		switch {
		case math.Hypot(p.X-st.rx, p.Z-st.rz) > steedTravelJumpM:
			cause = ThrownTravel
		case e.Move.Mode == movement.ModeSwim:
			cause = ThrownWater
		case e.Move.Vel.Y > 0:
			cause = ThrownHop
		}
		st.rx, st.rz = p.X, p.Z
		s.steedDismounted(sess, cause)
		return
	}
	if math.Hypot(p.X-st.rx, p.Z-st.rz) > steedTravelJumpM { // moved outside the step (a server teleport kept the flag)
		e.Move = movement.Dismount(e.Move)
		e.prevValid = e.Move
		st.rx, st.rz = p.X, p.Z
		s.steedDismounted(sess, ThrownTravel)
		return
	}
	if sess.cnt != nil { // CR 031: metres ridden (achievements.go)
		sess.cnt.ach.gallopM += math.Hypot(p.X-st.rx, p.Z-st.rz)
	}
	st.rx, st.rz = p.X, p.Z
	st.x, st.y, st.z = p.X, p.Y, p.Z
	// A hit that cost health may throw the rider; going down always does.
	downed := e.cbt != nil && e.cbt.Downed
	hit := e.Health < st.health
	st.health = e.Health
	if downed || (hit && s.steedRand() < constants.SteedHitDismountChance) {
		s.throwRider(sess, ThrownHit)
		return
	}
	// At night a demon close by may spook the steed (once a second).
	if night && (tick+e.ID)%steedSpookEvery == 0 && s.demonNear(p, constants.SteedSpookRadiusM) && s.steedRand() < constants.SteedSpookChance {
		s.throwRider(sess, ThrownSpook)
	}
}

// throwRider: the zone takes the rider out of the saddle (a hit, a spook).
func (s *Server) throwRider(sess *session, cause int) {
	e := sess.ent
	e.Move = movement.Dismount(e.Move)
	e.Move.Vel.X *= 0.3
	e.Move.Vel.Z *= 0.3
	e.prevValid = e.Move
	s.steedDismounted(sess, cause)
}

// demonNear: a live demon within r of p.
func (s *Server) demonNear(p movement.Vec3, r float64) bool {
	for _, o := range s.ents {
		en := o.npc
		if en == nil || !en.IsDemon() || !en.Alive() {
			continue
		}
		if math.Hypot(en.Pos.X-p.X, en.Pos.Z-p.Z) <= r && math.Abs(en.Pos.Y-p.Y) < 8 {
			return true
		}
	}
	return false
}

// steedsTell sends steeds to players who came near them since (every 2 s;
// nothing while nobody has a steed out).
func (s *Server) steedsTell() {
	var out []*session
	for _, sess := range s.sessions {
		if sess.steed != nil && sess.ent != nil && sess.steed.phase != SteedGone {
			out = append(out, sess)
		}
	}
	if len(out) == 0 {
		return
	}
	for _, o := range s.sessions {
		if o.ent == nil {
			continue
		}
		for _, t := range out {
			if t == o {
				continue
			}
			if o.steed == nil {
				o.steed = newSteedSess()
			}
			if v, ok := o.steed.told[t.ent.ID]; (ok && v == t.steed.ver) || !steedNear(o, t) {
				continue
			}
			o.steed.told[t.ent.ID] = t.steed.ver
			s.sendEvent(o, s.steedEvent(t))
		}
	}
}

// ---- combat while mounted ----

// mountedFrame strips what a rider can't do (before the combat layer and
// the step see the frame): dodges and mobility dashes, held dashes, and
// with a sword or spear every melee move, parry/charge, technique and form.
// Bows, staves, wands and spells work from the saddle.
func mountedFrame(e *Entity, f proto.InputFrame) proto.InputFrame {
	if !movement.Mounted(e.Move) {
		return f
	}
	if f.Flags&proto.InputFlagDodge != 0 {
		f.Flags &^= proto.InputFlagDodge
		f.CastSlot = 0
	}
	if e.cbt == nil {
		return f
	}
	if w := e.cbt.Weapon(); w != nil && (w.Key == "sword" || w.Key == "spear") {
		f.Flags &^= proto.InputFlagAttack | proto.InputFlagAltAttack
		if f.Flags&proto.InputFlagCast != 0 && f.CastSlot >= 4 { // combat.FormSlot, TechniqueSlot
			f.Flags &^= proto.InputFlagCast
			f.CastSlot = 0
		}
	}
	return f
}
