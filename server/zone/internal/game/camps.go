package game

// Camps (playtest 2, CR 025, contracts/camps.yaml): Valheim-flavoured camp
// pieces. A player crafts a kit (Interact 22 with a `camp` recipe: no
// station needed), places it in the wild (Interact 90/1: the zone checks
// the rules of server/pkg/camps, spends the kit and owns the piece), uses it
// and picks it up again for the kit (90/2). Pieces:
//
//   - Campfire: light and warmth; a cooking station (Event 404 kind 3);
//     burns on firewood for in-game hours. While it burns, demons never rise
//     within fire.safeRadiusM, never step into that circle and leave the
//     players inside alone (night.go hooks: campSafeAt).
//   - Bedroll: rest (90/3) for the Rested buff (more health and mana regen,
//     a bigger stamina wheel: StaminaMax rides SelfState, so prediction
//     adopts it) and it is your respawn point (RespawnPoint).
//   - Storage chest: 16 slots, locked to you or shared with your party;
//     items move through the item journal (camps_chest.go).
//   - Workbench: a crafting station (Event 404 kind 4) for tools and arrows.
//   - Signpost: a named marker on your map and your party's.
//
// Visibility: pieces are sent per 256 m area, once per session as a player
// comes within an area of one (Event 1100, binary, like content's places),
// then every change to the sessions that know the area (1101/1102). Nothing
// per tick. Camps are off in worlds without an atlas or towns (the flat and
// scale worlds), so LODESTONE_WIRE_DIGEST=1 is unchanged.
//
// Collision: solid pieces (chest, workbench, signpost) are boxes the
// players' movement step pushes out of after the town and the doors
// (server/pkg/camps, the Go half of a TS/Go twin; the client wraps its
// ground the same way, client/src/ui/camps/collide.ts). A new piece is
// refused within reach of any body, so the round trip before the client
// knows it costs no correction in practice; enemies walk around them too
// (obstacles.go).
//
// Persistence: camp_pieces (migration 0026) through the write-behind queue,
// keyed per piece; placing writes the row only after the kit's removal
// committed (lose, never duplicate), picking up deletes the row before the
// kit's grant commits. Decay: a camp whose owner has not been within
// decay.visitM for decay.days real days is removed by the zone owning it.
//
// WP16: the zone owning a point is the authority for pieces placed there:
// it places, changes, removes and persists them and tells every other zone
// (ctlCampSet); everywhere else players see them, collide with them and the
// fire keeps demons away. A player standing on another zone's ground near
// a border is refused (RefuseElsewhere) rather than raced.

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"math"
	"math/rand/v2"
	"slices"
	"time"

	"lodestone/server/pkg/campdefs"
	"lodestone/server/pkg/camps"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/towns"
	"lodestone/server/pkg/weather"
	"lodestone/server/pkg/writebehind"
	"lodestone/server/zone/internal/items"
)

// Interact 90 `camp` and its actions (contracts/events.md).
const (
	InteractCamp = 90

	CampActPlace  = 1  // targetId = kind | rot << 8 | x cm << 16 (24 bits) | z cm << 40 (24 bits)
	CampActPickup = 2  // targetId = piece id: your piece back as its kit
	CampActUse    = 3  // targetId = piece id: cook / light, rest, open the chest, open the workbench
	CampActFuel   = 4  // targetId = piece id, arg = firewood (0 = as much as fits)
	CampActPut    = 5  // targetId = piece id | qty << 40 (0 = all), arg = item handle
	CampActTake   = 6  // targetId = piece id | slot << 40
	CampActLabel  = 7  // targetId = piece id | chunk << 40, arg = 4 bytes of the label (ASCII, 0-terminated)
	CampActLock   = 8  // targetId = piece id, arg = 0 owner only, 1 party
	CampActDev    = 9  // dev builds: kits and materials
	CampActSync   = 10 // send 1106 again
)

// Event kinds 1100-1119 (CR 025).
const (
	EventCampArea    = 1100
	EventCampPiece   = 1101
	EventCampRemoved = 1102
	EventCampRefused = 1103
	EventCampChest   = 1104
	EventCampRested  = 1105
	EventCampMine    = 1106
	EventCampNote    = 1107
)

// Station kinds of Event 404 added by camps (items.go has 1-3).
const (
	StationWorkbench = 4
)

const (
	campAreaM      = 256.0
	campLabelMax   = 24
	campSeenEvery  = time.Hour // owner_seen_at is written at most this often
	campSafeMargin = 6.0       // demons rise this much further out than the circle
	campSaveKey    = "camp:"
	campNearM      = 24.0 // the movement step wraps the ground within this of a solid piece
)

// campPiece is one placed piece (tick goroutine).
type campPiece struct {
	ID            uint64
	Kind, Rot     int
	XCm, YCm, ZCm int32
	X, Y, Z       float64 // camps.Cm2M of the wire values (the collision twin's inputs)
	Owner         string
	OwnerName     string
	Label         string
	Lock          int
	Party         uint32
	BurnUntil     float64 // world clock seconds
	PlacedAt      time.Time
	SeenAt        time.Time
	mine          bool // this zone is its authority (WP16)
	chest         []*chestSlot
}

type chestSlot struct {
	it        *items.Item
	persisted bool // a database row lies in the chest
}

func (p *campPiece) area() int32 { return campArea(p.X, p.Z) }

func campArea(x, z float64) int32 {
	return int32(math.Floor(z/campAreaM))*64 + int32(math.Floor(x/campAreaM))
}

func (p *campPiece) footprint() camps.Footprint { return camps.FootprintOf(p.Kind, p.Rot, p.X, p.Z) }

func (p *campPiece) row() CampRow {
	return CampRow{ID: p.ID, Owner: p.Owner, OwnerName: p.OwnerName, Kind: p.Kind, XCm: p.XCm, YCm: p.YCm, ZCm: p.ZCm, Rot: p.Rot, Label: p.Label,
		Lock: p.Lock, Party: p.Party, BurnUntil: p.BurnUntil, PlacedAt: p.PlacedAt, SeenAt: p.SeenAt}
}

func (p *campPiece) json() campJSON {
	return campJSON{ID: p.ID, Owner: p.Owner, OwnerName: p.OwnerName, Kind: p.Kind, XCm: p.XCm, YCm: p.YCm, ZCm: p.ZCm, Rot: p.Rot, Label: p.Label, Lock: p.Lock, Party: p.Party, BurnUntil: p.BurnUntil}
}

func (p *campPiece) chestEmpty() bool {
	for _, c := range p.chest {
		if c != nil {
			return false
		}
	}
	return true
}

// fireSpot is a burning campfire for the night hooks (read on AI workers).
type fireSpot struct {
	x, z, until float64
}

// campState is the server-wide part.
type campState struct {
	pieces    map[uint64]*campPiece
	byOwner   map[string][]*campPiece
	byArea    map[int32][]*campPiece
	set       *camps.Set         // solid boxes, rebuilt on change (read-only once built)
	solid     []camps.SolidPiece // what set was built from (pathfinding sees the changes)
	fires     []fireSpot         // burning campfires (rebuilt each second and on change)
	nowW      float64            // world clock when fires was built
	lastDecay time.Time
	restored  bool
	handed    map[string]campHanded
}

// campSess is one session's camp state.
type campSess struct {
	areas       map[int32]bool
	restedUntil time.Time
	restedFire  bool
	restedOn    bool
	openChest   uint64
	label       map[uint64][]byte
	party       uint32
	sentMine    bool
	g           campFrameGround
}

type campHanded struct {
	RestedUntil int64 `json:"restedUntil"` // unix ms
	Fire        bool  `json:"fire,omitempty"`
}

func init() {
	RegisterHandoffField(HandoffField{
		Name: "camp",
		Save: func(s *Server, e *Entity) json.RawMessage {
			sess := s.byChar[e.CharacterID]
			if sess == nil || sess.camp == nil || sess.camp.restedUntil.IsZero() {
				return nil
			}
			b, _ := json.Marshal(campHanded{RestedUntil: sess.camp.restedUntil.UnixMilli(), Fire: sess.camp.restedFire})
			return b
		},
		Load: func(s *Server, e *Entity, data json.RawMessage) {
			var h campHanded
			if json.Unmarshal(data, &h) != nil {
				return
			}
			if s.camp.handed == nil {
				s.camp.handed = map[string]campHanded{}
			}
			s.camp.handed[e.CharacterID] = h
		},
	})
}

// campsOn: camps need a world to be about (an atlas or towns), like content.
func (s *Server) campsOn() bool { return s.contentOn() }

func (s *Server) campInit() {
	c := &s.camp
	if c.pieces != nil {
		return
	}
	c.pieces = map[uint64]*campPiece{}
	c.byOwner = map[string][]*campPiece{}
	c.byArea = map[int32][]*campPiece{}
	c.set = camps.NewSet(nil)
}

func (s *Server) sessCamp(sess *session) *campSess {
	if sess.camp == nil {
		sess.camp = &campSess{areas: map[int32]bool{}, label: map[uint64][]byte{}}
	}
	return sess.camp
}

// RestoreCamps loads the world's pieces (and their chests) before the zone
// ticks. Returns the number of pieces.
func (s *Server) RestoreCamps(ctx context.Context) (int, error) {
	s.campInit()
	if s.cfg.CampStore == nil || !s.campsOn() {
		return 0, nil
	}
	rows, err := s.cfg.CampStore.LoadCamps(ctx, s.cfg.WorldID)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, r := range rows {
		if campdefs.D.ByID(r.Kind) == nil {
			continue
		}
		p := &campPiece{ID: r.ID, Kind: r.Kind, Rot: r.Rot & 7, XCm: r.XCm, YCm: r.YCm, ZCm: r.ZCm, Owner: r.Owner, OwnerName: r.OwnerName, Label: r.Label,
			Lock: r.Lock, Party: r.Party, BurnUntil: r.BurnUntil, PlacedAt: r.PlacedAt, SeenAt: r.SeenAt}
		p.X, p.Y, p.Z = camps.Cm2M(p.XCm), camps.Cm2M(p.YCm), camps.Cm2M(p.ZCm)
		if p.Kind == campdefs.Chest {
			p.chest = make([]*chestSlot, campdefs.D.Chest.Slots)
			for i, it := range r.ChestItems {
				if i >= len(p.chest) {
					break
				}
				it.H, it.Slot = 0, ""
				p.chest[i] = &chestSlot{it: it, persisted: true}
			}
		}
		s.campIndex(p)
		n++
	}
	s.campRebuild()
	s.camp.restored = true
	return n, nil
}

// ---- index ----

func (s *Server) campIndex(p *campPiece) {
	c := &s.camp
	p.mine = s.ownsPoint(p.X, p.Z)
	c.pieces[p.ID] = p
	c.byOwner[p.Owner] = append(c.byOwner[p.Owner], p)
	c.byArea[p.area()] = append(c.byArea[p.area()], p)
}

func (s *Server) campUnindex(p *campPiece) {
	c := &s.camp
	delete(c.pieces, p.ID)
	del := func(l []*campPiece) []*campPiece {
		if i := slices.Index(l, p); i >= 0 {
			return slices.Delete(l, i, i+1)
		}
		return l
	}
	if l := del(c.byOwner[p.Owner]); len(l) > 0 {
		c.byOwner[p.Owner] = l
	} else {
		delete(c.byOwner, p.Owner)
	}
	if l := del(c.byArea[p.area()]); len(l) > 0 {
		c.byArea[p.area()] = l
	} else {
		delete(c.byArea, p.area())
	}
}

// campRebuild rebuilds the solid set and the burning fires (tick goroutine,
// outside the movement and combat phases).
func (s *Server) campRebuild() {
	c := &s.camp
	var solid []camps.SolidPiece
	for _, p := range c.pieces {
		if camps.Solid(p.Kind) {
			solid = append(solid, camps.SolidPiece{ID: p.ID, Kind: p.Kind, Rot: p.Rot, X: p.X, Y: p.Y, Z: p.Z})
		}
	}
	s.navCampsChanged(c.solid, solid)
	c.solid = solid
	c.set = camps.NewSet(solid)
	s.campFires()
}

func (s *Server) campFires() {
	c := &s.camp
	c.nowW = s.worldTimeS()
	var fires []fireSpot
	for _, p := range c.pieces {
		if p.Kind == campdefs.Campfire && p.BurnUntil > c.nowW {
			fires = append(fires, fireSpot{p.X, p.Z, p.BurnUntil})
		}
	}
	c.fires = fires // a new slice: AI workers may hold the old one
}

// piecesNear lists the pieces within r of (x, z).
func (s *Server) piecesNear(x, z, r float64) []*campPiece {
	var out []*campPiece
	c := &s.camp
	for az := int32(math.Floor((z - r) / campAreaM)); az <= int32(math.Floor((z+r)/campAreaM)); az++ {
		for ax := int32(math.Floor((x - r) / campAreaM)); ax <= int32(math.Floor((x+r)/campAreaM)); ax++ {
			for _, p := range c.byArea[az*64+ax] {
				if math.Hypot(p.X-x, p.Z-z) <= r {
					out = append(out, p)
				}
			}
		}
	}
	return out
}

// ---- night, respawn, collision hooks ----

// campSafeAt reports a point inside a burning campfire's circle grown by
// margin (WP15 hooks: demons never rise there, never step in, and leave the
// players inside alone). Safe on AI workers: fires is replaced, never
// mutated, on the tick goroutine.
func (s *Server) campSafeAt(x, z, margin float64) bool {
	fires := s.camp.fires
	if len(fires) == 0 {
		return false
	}
	r := campdefs.D.Fire.SafeRadiusM + margin
	now := s.camp.nowW
	for _, f := range fires {
		if f.until > now && (f.x-x)*(f.x-x)+(f.z-z)*(f.z-z) < r*r {
			return true
		}
	}
	return false
}

// campSpawn is a character's bedroll respawn point (beside it), if any.
func (s *Server) campSpawn(e *Entity) (movement.Vec3, bool) {
	for _, p := range s.camp.byOwner[e.CharacterID] {
		if p.Kind != campdefs.Bedroll {
			continue
		}
		cs, sn := camps.Rot(p.Rot)
		// Beside the bedroll's long side (local +x), on the ground.
		d := campdefs.D.ByID(p.Kind).W/2 + 0.9
		x, z := p.X+cs*d, p.Z+sn*d
		y := movement.GroundAt(s.cfg.Ground, x, p.Y+1.5, z)
		return movement.Vec3{X: x, Y: y, Z: z}, true
	}
	return movement.Vec3{}, false
}

// campFrameGround is the ground for one input frame near solid pieces.
type campFrameGround struct {
	inner movement.Ground
	s     *camps.Set
}

func (g *campFrameGround) HeightAt(x, z float64) float64 { return g.inner.HeightAt(x, z) }
func (g *campFrameGround) WaterAt(x, z float64) float64  { return movement.WaterAt(g.inner, x, z) }
func (g *campFrameGround) AtLevel(y float64) movement.Ground {
	return camps.With(movement.AtLevel(g.inner, y), g.s)
}

// campWrap wraps a frame's ground with the solid pieces near the player.
func (s *Server) campWrap(sess *session, g movement.Ground) movement.Ground {
	set := s.camp.set
	if set.Len() == 0 || sess.ent == nil {
		return g
	}
	p := sess.ent.Move.Pos
	if !set.Near(p.X, p.Z, campNearM) {
		return g
	}
	cs := s.sessCamp(sess)
	cs.g = campFrameGround{inner: g, s: set}
	return &cs.g
}

// campRestedStamina is the Rested buff's stamina wheel points (0 without it).
func (s *Server) campRestedStamina(e *Entity) float64 {
	if sess := s.byChar[e.CharacterID]; sess != nil && sess.camp != nil && sess.camp.restedOn {
		return campdefs.D.Rested.StaminaBonus
	}
	return 0
}

// ---- join, leave, tick ----

func (s *Server) campJoin(sess *session) {
	if !s.campsOn() || sess.ent == nil {
		return
	}
	s.campInit()
	cs := s.sessCamp(sess)
	if h, ok := s.camp.handed[sess.ent.CharacterID]; ok {
		delete(s.camp.handed, sess.ent.CharacterID)
		if until := time.UnixMilli(h.RestedUntil); until.After(s.cfg.Now()) {
			cs.restedUntil, cs.restedFire = until, h.Fire
			s.campApplyRested(sess)
		}
	}
	s.campSendAreas(sess)
	s.sendCampMine(sess)
}

func (s *Server) campLeave(sess *session) {
	if sess.camp == nil || sess.ent == nil {
		return
	}
	s.campSeen(sess, true)
}

func (s *Server) campsTick(tick uint32) {
	if !s.campsOn() {
		return
	}
	s.campInit()
	now := s.cfg.Now()
	if tick%constants.TickRateHz == 0 {
		s.campFires()
	}
	for i, sess := range s.sessions {
		if sess.ent == nil || (tick+uint32(i))%constants.TickRateHz != 0 {
			continue
		}
		cs := s.sessCamp(sess)
		s.campSendAreas(sess)
		if cs.restedOn && !now.Before(cs.restedUntil) {
			cs.restedOn, cs.restedUntil = false, time.Time{}
			s.campApplyRested(sess)
			s.sendEvent(sess, &proto.Event{Kind: EventCampRested, EntityID: sess.ent.ID, Value: 0})
		}
		if sess.ent.PartyID != cs.party || !cs.sentMine {
			cs.party = sess.ent.PartyID
			s.sendCampMine(sess)
		}
		s.campSeen(sess, false)
	}
	if s.camp.restored || s.cfg.CampStore == nil {
		every := time.Duration(campdefs.D.Decay.CheckEveryS * float64(time.Second))
		if s.camp.lastDecay.IsZero() {
			s.camp.lastDecay = now.Add(-every + 20*time.Second) // first check 20 s after start
		}
		if now.Sub(s.camp.lastDecay) >= every {
			s.camp.lastDecay = now
			s.campDecay(now)
		}
	}
}

// campSeen records the owner near their camp (decay) and their party
// (party-locked chests, signposts on party maps).
func (s *Server) campSeen(sess *session, force bool) {
	e := sess.ent
	own := s.camp.byOwner[e.CharacterID]
	if len(own) == 0 {
		return
	}
	now := s.cfg.Now()
	near := false
	for _, p := range own {
		if math.Hypot(p.X-e.Move.Pos.X, p.Z-e.Move.Pos.Z) <= campdefs.D.Decay.VisitM {
			near = true
			break
		}
	}
	for _, p := range own {
		changed := false
		if near && (force || now.Sub(p.SeenAt) >= campSeenEvery) {
			p.SeenAt, changed = now, true
		}
		if p.Party != e.PartyID {
			p.Party, changed = e.PartyID, true
		}
		if p.OwnerName != e.Name && e.Name != "" {
			p.OwnerName, changed = e.Name, true
		}
		if changed && p.mine {
			s.campSave(p)
		}
	}
}

// campDecay removes the camps whose owners stayed away too long (the
// authority's pieces only; owners online keep theirs).
func (s *Server) campDecay(now time.Time) {
	var gone []*campPiece
	for _, p := range s.camp.pieces {
		if !p.mine || s.byChar[p.Owner] != nil {
			continue
		}
		if camps.Decayed(p.SeenAt, now) {
			gone = append(gone, p)
		}
	}
	for _, p := range gone {
		s.log.Info("camp piece decayed", "piece", p.ID, "kind", campdefs.D.ByID(p.Kind).Key, "owner", p.Owner, "seenAt", p.SeenAt.UTC().Format(time.RFC3339))
		s.campDropChest(p)
		s.campRemove(p, 2, true)
	}
}

// ---- persistence ----

func (s *Server) campSave(p *campPiece) {
	st := s.cfg.CampStore
	if st == nil || s.cfg.Queue == nil {
		return
	}
	r, world, zone := p.row(), s.cfg.WorldID, s.cfg.ZoneID
	s.cfg.Queue.Enqueue(writebehind.Op{Key: campSaveKey + uintKey(p.ID), Run: func(ctx context.Context) error { return st.SaveCamp(ctx, world, zone, r) }})
}

func (s *Server) campDelete(id uint64) {
	st := s.cfg.CampStore
	if st == nil || s.cfg.Queue == nil {
		return
	}
	world := s.cfg.WorldID
	s.cfg.Queue.Enqueue(writebehind.Op{Key: campSaveKey + uintKey(id), Run: func(ctx context.Context) error { return st.DeleteCamp(ctx, world, id) }})
}

func uintKey(v uint64) string {
	const digits = "0123456789abcdef"
	var b [16]byte
	i := len(b)
	for {
		i--
		b[i] = digits[v&15]
		v >>= 4
		if v == 0 {
			break
		}
	}
	return string(b[i:])
}

// campBroadcastCtl tells every other zone about a piece (WP16).
func (s *Server) campBroadcastCtl(c campJSON) {
	if !s.clusterOn() {
		return
	}
	own := s.cl.c.Owners()
	if own == nil {
		return
	}
	m := ctlMsg{T: ctlCampSet, Camp: c.encode()}
	for id := range own.Zones {
		if id != s.cl.self {
			s.sendCtl(id, m)
		}
	}
}

// campCtl applies another zone's piece (handleCtl, tick goroutine).
func (s *Server) campCtl(m ctlMsg) {
	if !s.campsOn() || len(m.Camp) == 0 {
		return
	}
	s.campInit()
	var c campJSON
	if json.Unmarshal(m.Camp, &c) != nil || c.ID == 0 {
		return
	}
	old := s.camp.pieces[c.ID]
	if c.Gone {
		if old != nil {
			s.campRemove(old, c.Reason, false)
		}
		return
	}
	if campdefs.D.ByID(c.Kind) == nil {
		return
	}
	if old != nil {
		old.Label, old.Lock, old.Party, old.BurnUntil, old.OwnerName = c.Label, c.Lock, c.Party, c.BurnUntil, c.OwnerName
		s.campFires()
		s.campNotify(old, 2, 0)
		return
	}
	p := &campPiece{ID: c.ID, Kind: c.Kind, Rot: c.Rot & 7, XCm: c.XCm, YCm: c.YCm, ZCm: c.ZCm, Owner: c.Owner, OwnerName: c.OwnerName, Label: c.Label, Lock: c.Lock,
		Party: c.Party, BurnUntil: c.BurnUntil, PlacedAt: s.cfg.Now(), SeenAt: s.cfg.Now()}
	p.X, p.Y, p.Z = camps.Cm2M(p.XCm), camps.Cm2M(p.YCm), camps.Cm2M(p.ZCm)
	if p.Kind == campdefs.Chest {
		p.chest = make([]*chestSlot, campdefs.D.Chest.Slots)
	}
	s.campIndex(p)
	s.campRebuild()
	s.campNotify(p, 1, 0)
}

// ---- wire ----

// campRecord appends a piece's binary record as `to` sees it.
func (s *Server) campRecord(b []byte, p *campPiece, to *Entity) []byte {
	b = binary.LittleEndian.AppendUint64(b, p.ID)
	b = append(b, byte(p.Kind), byte(p.Rot))
	b = binary.LittleEndian.AppendUint32(b, uint32(p.XCm))
	b = binary.LittleEndian.AppendUint32(b, uint32(p.YCm))
	b = binary.LittleEndian.AppendUint32(b, uint32(p.ZCm))
	var fl byte
	if to != nil && to.CharacterID == p.Owner {
		fl |= 1
	}
	if p.Lock == 1 {
		fl |= 2
	}
	if to != nil && p.Party != 0 && to.PartyID == p.Party {
		fl |= 4
	}
	left := uint32(0)
	if p.Kind == campdefs.Campfire {
		if l := p.BurnUntil - s.worldTimeS(); l > 0 {
			left = uint32(math.Min(l*1000, math.MaxUint32))
			fl |= 8
		}
	}
	b = append(b, fl)
	b = binary.LittleEndian.AppendUint32(b, left)
	used := 0
	if p.Kind == campdefs.Chest {
		for _, c := range p.chest {
			if c != nil {
				used++
			}
		}
	}
	b = append(b, byte(used))
	name := p.OwnerName
	if len(name) > 255 {
		name = name[:255]
	}
	b = append(b, byte(len(name)))
	b = append(b, name...)
	b = append(b, byte(len(p.Label)))
	return append(b, p.Label...)
}

// campSendAreas sends the pieces of the 3 x 3 areas around a player that
// this session has not had yet (Event 1100, one per area with pieces).
func (s *Server) campSendAreas(sess *session) {
	cs := s.sessCamp(sess)
	e := sess.ent
	ax0, az0 := int32(math.Floor(e.Move.Pos.X/campAreaM)), int32(math.Floor(e.Move.Pos.Z/campAreaM))
	for dz := int32(-1); dz <= 1; dz++ {
		for dx := int32(-1); dx <= 1; dx++ {
			ax, az := ax0+dx, az0+dz
			if ax < 0 || az < 0 || ax >= 64 || az >= 64 {
				continue
			}
			a := az*64 + ax
			if cs.areas[a] {
				continue
			}
			cs.areas[a] = true
			ps := s.camp.byArea[a]
			if len(ps) == 0 {
				continue
			}
			b := []byte{1}
			b = binary.LittleEndian.AppendUint16(b, uint16(ax))
			b = binary.LittleEndian.AppendUint16(b, uint16(az))
			b = binary.LittleEndian.AppendUint16(b, uint16(len(ps)))
			for _, p := range ps {
				b = s.campRecord(b, p, e)
			}
			s.sendEvent(sess, &proto.Event{Kind: EventCampArea, EntityID: e.ID, TargetID: uint32(a), Data: b})
		}
	}
}

// campNotify sends a placed (1) or changed (2) piece to every session that
// knows its area. by = the entity that placed it (sounds), 0 none.
func (s *Server) campNotify(p *campPiece, what int32, by uint32) {
	a := p.area()
	for _, sess := range s.sessions {
		if sess.ent == nil || sess.camp == nil || !sess.camp.areas[a] {
			continue
		}
		s.sendEvent(sess, &proto.Event{Kind: EventCampPiece, EntityID: by, Value: what, X: p.XCm, Y: p.YCm, Z: p.ZCm, Data: s.campRecord(nil, p, sess.ent)})
	}
}

func (s *Server) campNotifyRemoved(p *campPiece, reason int32) {
	a := p.area()
	ev := &proto.Event{Kind: EventCampRemoved, Value: reason, X: p.XCm, Y: p.YCm, Z: p.ZCm, Data: binary.LittleEndian.AppendUint64(nil, p.ID)}
	for _, sess := range s.sessions {
		if sess.ent == nil || sess.camp == nil || !sess.camp.areas[a] {
			continue
		}
		s.sendEvent(sess, ev)
	}
}

type campMineJSON struct {
	Pieces  []campMinePiece `json:"pieces"`
	Markers []campMarker    `json:"markers"`
	Spawn   *[2]float64     `json:"spawn"`
	Max     int             `json:"max"`
	Rested  int             `json:"restedS"`
}

type campMinePiece struct {
	ID   uint64  `json:"id"`
	Kind int     `json:"kind"`
	X    float64 `json:"x"`
	Z    float64 `json:"z"`
}

type campMarker struct {
	ID    uint64  `json:"id"`
	X     float64 `json:"x"`
	Z     float64 `json:"z"`
	Label string  `json:"label"`
	Owner string  `json:"owner"`
	Mine  bool    `json:"mine"`
}

// sendCampMine sends a player their camp and the signposts on their map
// (theirs and their party's): Event 1106.
func (s *Server) sendCampMine(sess *session) {
	e := sess.ent
	if e == nil || !s.campsOn() {
		return
	}
	cs := s.sessCamp(sess)
	cs.sentMine = true
	out := campMineJSON{Pieces: []campMinePiece{}, Markers: []campMarker{}, Max: campdefs.D.Limits.MaxPieces}
	for _, p := range s.camp.byOwner[e.CharacterID] {
		out.Pieces = append(out.Pieces, campMinePiece{ID: p.ID, Kind: p.Kind, X: p.X, Z: p.Z})
	}
	for _, p := range s.camp.pieces {
		if p.Kind != campdefs.Signpost {
			continue
		}
		mine := p.Owner == e.CharacterID
		if mine || (e.PartyID != 0 && p.Party == e.PartyID) {
			label := p.Label
			if label == "" {
				label = p.OwnerName + "'s camp"
			}
			out.Markers = append(out.Markers, campMarker{ID: p.ID, X: p.X, Z: p.Z, Label: label, Owner: p.OwnerName, Mine: mine})
		}
	}
	slices.SortFunc(out.Markers, func(a, b campMarker) int { return cmpU64(a.ID, b.ID) })
	if sp, ok := s.campSpawn(e); ok {
		out.Spawn = &[2]float64{sp.X, sp.Z}
	}
	if cs.restedOn {
		out.Rested = int(math.Ceil(cs.restedUntil.Sub(s.cfg.Now()).Seconds()))
	}
	b, _ := json.Marshal(out)
	s.sendEvent(sess, &proto.Event{Kind: EventCampMine, EntityID: e.ID, Value: int32(len(out.Pieces)), Data: b})
}

func cmpU64(a, b uint64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

func (s *Server) campRefuse(sess *session, action uint8, target uint64, reason int) {
	s.sendEvent(sess, &proto.Event{Kind: EventCampRefused, EntityID: sess.ent.ID, TargetID: uint32(target), Value: int32(reason), Data: []byte{action}})
}

func (s *Server) campNote(sess *session, kind int32, text string) {
	s.sendEvent(sess, &proto.Event{Kind: EventCampNote, EntityID: sess.ent.ID, Value: kind, Data: []byte(text)})
}

// ---- Interact 90 ----

func (s *Server) campInteract(sess *session, m *proto.Interact) {
	e := sess.ent
	if e == nil {
		return
	}
	if !s.campsOn() {
		s.campRefuse(sess, m.Action, m.TargetID, camps.RefuseOff)
		return
	}
	s.campInit()
	switch m.Action {
	case CampActPlace:
		s.campPlace(sess, m)
	case CampActSync:
		s.sendCampMine(sess)
	case CampActDev:
		s.campDevGrant(sess)
	default:
		id := m.TargetID & (1<<40 - 1)
		p := s.camp.pieces[id]
		if p == nil {
			s.campRefuse(sess, m.Action, id, camps.RefuseUnknown)
			return
		}
		if math.Hypot(p.X-e.Move.Pos.X, p.Z-e.Move.Pos.Z) > campdefs.D.Limits.ReachM+0.5 || math.Abs(p.Y-e.Move.Pos.Y) > 4 {
			s.campRefuse(sess, m.Action, id, camps.RefuseTooFar)
			return
		}
		if !p.mine {
			s.campRefuse(sess, m.Action, id, camps.RefuseElsewhere)
			return
		}
		switch m.Action {
		case CampActPickup:
			s.campPickup(sess, p)
		case CampActUse:
			s.campUse(sess, p)
		case CampActFuel:
			s.campFuel(sess, p, int(m.Arg))
		case CampActPut:
			s.chestPut(sess, p, uint32(m.Arg), int(m.TargetID>>40&0xffff))
		case CampActTake:
			s.chestTake(sess, p, int(m.TargetID>>40&0xff))
		case CampActLabel:
			s.campLabel(sess, p, int(m.TargetID>>40&0xff), m.Arg)
		case CampActLock:
			s.campLock(sess, p, int(m.Arg))
		default:
			s.campRefuse(sess, m.Action, id, camps.RefuseUnknown)
		}
	}
}

// campEnv is the zone's world for the placement rules.
type campEnv struct{ s *Server }

func (v campEnv) HeightAt(x, z float64) float64 { return v.s.cfg.Ground.HeightAt(x, z) }
func (v campEnv) WaterAt(x, z float64) float64  { return movement.WaterAt(v.s.cfg.Ground, x, z) }
func (v campEnv) InTown(x, z, margin float64) bool {
	tw := v.s.cfg.Towns
	if tw == nil {
		return false
	}
	for i := range tw.T.Settlements {
		st := &tw.T.Settlements[i]
		if math.Hypot(st.X-x, st.Z-z) < st.Radius+margin {
			return true
		}
	}
	return false
}
func (v campEnv) Structure(f camps.Footprint) bool {
	tc, ok := v.s.cfg.Ground.(townCollider)
	if !ok {
		return false
	}
	c := tc.TownCollision()
	if c == nil {
		return false
	}
	var buf [64]int32
	y := v.s.cfg.Ground.HeightAt(f.X, f.Z)
	for _, i := range c.Candidates(f.X, f.Z, f.Radius()+1, buf[:0]) {
		o := int(i) * 9
		b := c.B.F[o : o+9]
		if c.B.Flags[i]&(towns.FlagSolid|towns.FlagWalk) == 0 {
			continue
		}
		top := math.Max(b[7], b[8])
		if top < y-0.3 || b[6] > y+2.6 {
			continue // under the ground or overhead (a bridge deck far above)
		}
		if f.Overlaps(camps.Footprint{X: b[0], Z: b[1], Cs: b[2], Sn: b[3], Hx: b[4], Hz: b[5]}, 0.1) {
			return true
		}
	}
	return false
}

func (s *Server) campPlace(sess *session, m *proto.Interact) {
	e, ci := sess.ent, sess.items
	t := m.TargetID
	kind, r := int(t&0xff), int(t>>8&0xff)&7
	xcm, zcm := int32(t>>16&0xffffff), int32(t>>40&0xffffff)
	def := campdefs.D.ByID(kind)
	if def == nil || ci == nil {
		s.campRefuse(sess, m.Action, 0, camps.RefuseUnknown)
		return
	}
	x, z := camps.Cm2M(xcm), camps.Cm2M(zcm)
	if !s.ownsPoint(x, z) || !s.ownsPoint(e.Move.Pos.X, e.Move.Pos.Z) {
		s.campRefuse(sess, m.Action, 0, camps.RefuseElsewhere)
		return
	}
	if ci.inv.Count(def.Kit) < 1 {
		s.campRefuse(sess, m.Action, 0, camps.RefuseNoKit)
		return
	}
	reach := campdefs.D.Limits.CampRadiusM*2 + campdefs.D.Placement.OtherCampM + 4
	var near []camps.Placed
	seen := map[uint64]bool{}
	for _, p := range s.piecesNear(x, z, reach) {
		seen[p.ID] = true
		near = append(near, camps.Placed{ID: p.ID, Kind: p.Kind, Rot: p.Rot, X: p.X, Z: p.Z, Owner: p.Owner})
	}
	for _, p := range s.camp.byOwner[e.CharacterID] {
		if !seen[p.ID] {
			near = append(near, camps.Placed{ID: p.ID, Kind: p.Kind, Rot: p.Rot, X: p.X, Z: p.Z, Owner: p.Owner})
		}
	}
	y, why := camps.Check(camps.Want{Kind: kind, Rot: r, X: x, Z: z, Owner: e.CharacterID, FeetX: e.Move.Pos.X, FeetY: e.Move.Pos.Y, FeetZ: e.Move.Pos.Z}, near, campEnv{s})
	if why == 0 && def.Solid {
		f := camps.FootprintOf(kind, r, x, z)
		for _, o := range s.ents {
			if (o.Kind == proto.EntityKindPlayer || o.Kind == proto.EntityKindNpc || o.Kind == proto.EntityKindEnemy) &&
				f.Dist(o.Move.Pos.X, o.Move.Pos.Z) < constants.PlayerCapsuleRadius+campdefs.D.Placement.BodyClearM && math.Abs(o.Move.Pos.Y-y) < 3 {
				why = camps.RefuseBody
				break
			}
		}
	}
	if why != 0 {
		s.campRefuse(sess, m.Action, 0, why)
		return
	}
	p := &campPiece{ID: s.campNewID(), Kind: kind, Rot: r, XCm: xcm, YCm: camps.M2Cm(y), ZCm: zcm, Owner: e.CharacterID, OwnerName: e.Name, Party: e.PartyID,
		PlacedAt: s.cfg.Now(), SeenAt: s.cfg.Now()}
	p.X, p.Y, p.Z = x, camps.Cm2M(p.YCm), z
	if kind == campdefs.Campfire {
		p.BurnUntil = s.worldTimeS() + campdefs.D.Fire.KitHours*camps.HourS
	}
	if kind == campdefs.Chest {
		p.chest = make([]*chestSlot, campdefs.D.Chest.Slots)
	}
	var d items.Delta
	if !ci.inv.Spend(def.Kit, 1, &d) {
		s.campRefuse(sess, m.Action, 0, camps.RefuseNoKit)
		return
	}
	s.campIndex(p)
	p.mine = true
	// The row is written once the kit's removal committed (lose, never
	// duplicate): the op's Done for database characters, now otherwise.
	s.campCommit(sess, &d, "camp place "+def.Key, nil, func() {
		if s.camp.pieces[p.ID] == p {
			s.campSave(p)
		}
	})
	s.campRebuild()
	s.campSendAreas(sess)
	s.campNotify(p, 1, e.ID)
	s.campBroadcastCtl(p.json())
	s.sendCampMine(sess)
	s.log.Info("camp piece placed", "piece", p.ID, "kind", def.Key, "owner", e.CharacterID, "x", p.X, "y", p.Y, "z", p.Z, "rot", r)
}

// campCommit is commitItems with hooks: before runs (once) ahead of the
// item transaction, done after it committed (database characters); other
// characters run before (in the queue) and done at once.
func (s *Server) campCommit(sess *session, d *items.Delta, note string, before func(ctx context.Context) error, done func()) {
	ci := sess.items
	if ci.persist == persistDB && s.itm.j != nil && !d.Empty() {
		ci.version++
		op := &ItemOp{Char: sess.ent.CharacterID, Epoch: sess.ent.epoch, Note: note, Before: before, Done: done}
		created, updated, deleted := d.Rows()
		for _, it := range created {
			op.Upsert = append(op.Upsert, ItemRow{Item: it, Owner: op.Char})
		}
		for _, it := range updated {
			op.Update = append(op.Update, ItemRow{Item: it, Owner: op.Char})
		}
		op.Delete = deleted
		s.enqueueItems(sess, op)
		s.sendInventory(sess)
		return
	}
	s.commitItems(sess, d, nil, note)
	if before != nil && s.cfg.Queue != nil {
		s.cfg.Queue.Enqueue(writebehind.Op{Run: before})
	}
	if done != nil {
		done()
	}
}

func (s *Server) campNewID() uint64 {
	for {
		id := rand.Uint64() & (1<<40 - 1)
		if id != 0 && s.camp.pieces[id] == nil {
			return id
		}
	}
}

// campRemove takes a piece out of the world (reason 1 picked up, 2
// decayed); persist: this zone deletes its row and tells the others.
func (s *Server) campRemove(p *campPiece, reason int, persist bool) {
	s.campUnindex(p)
	s.campRebuild()
	s.campNotifyRemoved(p, int32(reason))
	if persist {
		s.campDelete(p.ID)
		s.campBroadcastCtl(campJSON{ID: p.ID, Gone: true, Reason: reason})
	}
	if owner := s.byChar[p.Owner]; owner != nil {
		s.sendCampMine(owner)
	}
	for _, sess := range s.sessions {
		if sess.camp != nil && sess.camp.openChest == p.ID {
			sess.camp.openChest = 0
		}
	}
}

func (s *Server) campPickup(sess *session, p *campPiece) {
	e, ci := sess.ent, sess.items
	if p.Owner != e.CharacterID {
		s.campRefuse(sess, CampActPickup, p.ID, camps.RefuseNotYours)
		return
	}
	if !p.chestEmpty() {
		s.campRefuse(sess, CampActPickup, p.ID, camps.RefuseNotEmpty)
		return
	}
	def := campdefs.D.ByID(p.Kind)
	if ci == nil || !ci.inv.CanFit(def.Kit, 1) {
		s.campRefuse(sess, CampActPickup, p.ID, camps.RefuseFull)
		return
	}
	var d items.Delta
	kit := items.Stack(def.Kit, 1)
	kit.Prov = []items.Prov{{Ev: "camp_pickup", Char: e.CharacterID, Name: e.Name, At: s.cfg.Now().UnixMilli()}}
	ci.inv.Add(kit, &d)
	// The row goes before the kit's grant commits (lose, never duplicate).
	st, world, id := s.cfg.CampStore, s.cfg.WorldID, p.ID
	var before func(ctx context.Context) error
	if st != nil {
		before = func(ctx context.Context) error { return st.DeleteCamp(ctx, world, id) }
	}
	s.campCommit(sess, &d, "camp pickup "+def.Key, before, nil)
	s.campRemove(p, 1, true) // also queues the delete: replaces any queued upsert of this piece
	s.sendGranted(sess, SourceCraft, []*items.Item{kit})
	s.log.Info("camp piece picked up", "piece", p.ID, "kind", def.Key, "owner", e.CharacterID)
}

func (s *Server) campCanUse(e *Entity, p *campPiece) bool {
	return p.Owner == e.CharacterID || (p.Lock == 1 && p.Party != 0 && e.PartyID == p.Party)
}

func (s *Server) campUse(sess *session, p *campPiece) {
	e, ci := sess.ent, sess.items
	switch p.Kind {
	case campdefs.Campfire:
		if p.BurnUntil <= s.worldTimeS() {
			s.campFuel(sess, p, 1) // light it
			return
		}
		if ci == nil {
			return
		}
		ci.station = &openStation{kind: StationCook, prop: p.ID, x: p.X, y: p.Y, z: p.Z}
		s.sendEvent(sess, &proto.Event{Kind: EventStation, EntityID: e.ID, TargetID: StationCook, Value: int32(s.smithing(e)), Data: binary.LittleEndian.AppendUint64(nil, p.ID)})
	case campdefs.Workbench:
		if ci == nil {
			return
		}
		ci.station = &openStation{kind: StationWorkbench, prop: p.ID, x: p.X, y: p.Y, z: p.Z}
		s.sendEvent(sess, &proto.Event{Kind: EventStation, EntityID: e.ID, TargetID: StationWorkbench, Value: int32(s.smithing(e)), Data: binary.LittleEndian.AppendUint64(nil, p.ID)})
	case campdefs.Bedroll:
		s.campRest(sess, p)
	case campdefs.Chest:
		if !s.campCanUse(e, p) {
			s.campRefuse(sess, CampActUse, p.ID, camps.RefuseLocked)
			return
		}
		s.sessCamp(sess).openChest = p.ID
		s.sendChest(sess, p)
	case campdefs.Signpost:
		label := p.Label
		if label == "" {
			label = p.OwnerName + "'s camp"
		}
		s.campNote(sess, 0, label)
	}
}

func (s *Server) campFuel(sess *session, p *campPiece, n int) {
	if p.Kind != campdefs.Campfire || sess.items == nil {
		s.campRefuse(sess, CampActFuel, p.ID, camps.RefuseUnknown)
		return
	}
	ci := sess.items
	wood := campdefs.D.Fire.Wood
	have := ci.inv.Count(wood)
	if n <= 0 || n > have {
		n = have
	}
	if n <= 0 {
		s.campRefuse(sess, CampActFuel, p.ID, camps.RefuseNoWood)
		return
	}
	now := s.worldTimeS()
	until, used := camps.AddWood(p.BurnUntil, now, n)
	if used == 0 {
		s.campRefuse(sess, CampActFuel, p.ID, camps.RefuseFireFull)
		return
	}
	var d items.Delta
	if !ci.inv.Spend(wood, used, &d) {
		s.campRefuse(sess, CampActFuel, p.ID, camps.RefuseNoWood)
		return
	}
	lit := p.BurnUntil <= now
	p.BurnUntil = until
	s.commitItems(sess, &d, nil, "camp fuel")
	s.campFires()
	s.campSave(p)
	s.campNotify(p, 2, sess.ent.ID)
	s.campBroadcastCtl(p.json())
	hours := (until - now) / camps.HourS
	if lit {
		s.campNote(sess, 1, "The campfire catches. It will burn "+hoursText(hours)+".")
	} else {
		s.campNote(sess, 1, "The fire will burn "+hoursText(hours)+".")
	}
}

func hoursText(h float64) string {
	n := int(math.Round(h))
	if n <= 1 {
		return "about an hour"
	}
	return "about " + itoa(n) + " hours"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

func (s *Server) campRest(sess *session, p *campPiece) {
	e := sess.ent
	if p.Owner != e.CharacterID && !(p.Party != 0 && e.PartyID == p.Party) {
		s.campRefuse(sess, CampActUse, p.ID, camps.RefuseNotYours)
		return
	}
	rd := &campdefs.D.Rested
	if e.cbt != nil && s.cbt.w != nil && (e.cbt.Downed || e.cbt.InCombatWithin(s.cbt.w.Tick(), rd.CombatLockS)) {
		s.campRefuse(sess, CampActUse, p.ID, camps.RefuseCombat)
		return
	}
	fire := false
	nowW := s.worldTimeS()
	for _, q := range s.piecesNear(p.X, p.Z, campdefs.D.Fire.WarmthM+2) {
		if q.Kind == campdefs.Campfire && q.BurnUntil > nowW && math.Hypot(q.X-p.X, q.Z-p.Z) <= campdefs.D.Fire.WarmthM {
			fire = true
		}
	}
	dur := rd.DurationS
	if fire {
		dur += rd.FireBonusS
	}
	cs := s.sessCamp(sess)
	cs.restedUntil, cs.restedFire = s.cfg.Now().Add(time.Duration(dur*float64(time.Second))), fire
	s.campApplyRested(sess)
	if e.cbt != nil && !e.cbt.Downed {
		e.cbt.HP = e.cbt.HPMax
		syncPlayerHealth(e)
	}
	e.Move.Stamina = e.Move.StaminaMax
	text := "You rest a while. The night goes on without you, but you rise Rested."
	if !weather.IsNight(nowW) {
		text = "You rest a while and rise Rested."
	}
	if fire {
		text += " The fire's warmth lingers."
	}
	if p.Owner == e.CharacterID {
		text += " Your bedroll is your respawn point."
	}
	s.campNote(sess, 2, text)
	s.sendCampMine(sess)
	s.log.Info("rested", "character", e.CharacterID, "piece", p.ID, "fire", fire, "seconds", dur)
}

// campApplyRested puts the buff (or its end) into combat and movement.
func (s *Server) campApplyRested(sess *session) {
	e, cs := sess.ent, s.sessCamp(sess)
	on := !cs.restedUntil.IsZero() && cs.restedUntil.After(s.cfg.Now())
	cs.restedOn = on
	rd := &campdefs.D.Rested
	if c := e.cbt; c != nil {
		if on {
			c.RegenMult, c.ManaRegenMult = rd.RegenMult, rd.ManaRegenMult
		} else {
			c.RegenMult, c.ManaRegenMult = 0, 0
		}
	}
	s.applyProgression(e, false) // the stamina wheel follows (progression.go)
	if on {
		left := cs.restedUntil.Sub(s.cfg.Now()).Seconds()
		b, _ := json.Marshal(map[string]any{"staminaBonus": rd.StaminaBonus, "regenMult": rd.RegenMult, "manaRegenMult": rd.ManaRegenMult, "fire": cs.restedFire})
		s.sendEvent(sess, &proto.Event{Kind: EventCampRested, EntityID: e.ID, Value: int32(math.Ceil(left)), Data: b})
	}
}

func (s *Server) campLabel(sess *session, p *campPiece, chunk int, arg uint32) {
	e := sess.ent
	if p.Owner != e.CharacterID {
		s.campRefuse(sess, CampActLabel, p.ID, camps.RefuseNotYours)
		return
	}
	cs := s.sessCamp(sess)
	if chunk == 0 {
		cs.label[p.ID] = cs.label[p.ID][:0]
	}
	buf := cs.label[p.ID]
	end := false
	for i := 0; i < 4; i++ {
		c := byte(arg >> (8 * i))
		if c == 0 {
			end = true
			break
		}
		if c >= 32 && c < 127 && len(buf) < campLabelMax {
			buf = append(buf, c)
		}
	}
	cs.label[p.ID] = buf
	if !end && chunk < campLabelMax/4 {
		return
	}
	delete(cs.label, p.ID)
	label := trimSpaces(string(buf))
	if label == p.Label {
		return
	}
	p.Label = label
	s.campSave(p)
	s.campNotify(p, 2, e.ID)
	s.campBroadcastCtl(p.json())
	for _, o := range s.sessions {
		if o.ent != nil && (o.ent.CharacterID == p.Owner || (p.Party != 0 && o.ent.PartyID == p.Party)) {
			s.sendCampMine(o)
		}
	}
}

func trimSpaces(v string) string {
	i, j := 0, len(v)
	for i < j && v[i] == ' ' {
		i++
	}
	for j > i && v[j-1] == ' ' {
		j--
	}
	return v[i:j]
}

func (s *Server) campLock(sess *session, p *campPiece, mode int) {
	if p.Owner != sess.ent.CharacterID {
		s.campRefuse(sess, CampActLock, p.ID, camps.RefuseNotYours)
		return
	}
	if mode != 0 {
		mode = 1
	}
	if p.Lock == mode {
		return
	}
	p.Lock = mode
	p.Party = sess.ent.PartyID
	s.campSave(p)
	s.campNotify(p, 2, sess.ent.ID)
	s.campBroadcastCtl(p.json())
	if p.Kind == campdefs.Chest {
		for _, o := range s.sessions {
			if o.camp != nil && o.camp.openChest == p.ID && o.ent != nil {
				if !s.campCanUse(o.ent, p) {
					o.camp.openChest = 0
				}
				s.sendChest(o, p)
			}
		}
	}
}

// campDevGrant: dev builds hand out every kit and the materials (evidence).
func (s *Server) campDevGrant(sess *session) {
	if !s.cfg.DevSpawn || sess.items == nil {
		s.campRefuse(sess, CampActDev, 0, camps.RefuseUnknown)
		return
	}
	ci := sess.items
	var d items.Delta
	var got []*items.Item
	add := func(base string, n int) {
		it := items.Stack(base, n)
		it.Prov = []items.Prov{{Ev: "dev_grant", Char: sess.ent.CharacterID, At: s.cfg.Now().UnixMilli()}}
		if left := ci.inv.Add(it, &d); left < n {
			got = append(got, it)
		}
	}
	for _, p := range campdefs.D.Pieces {
		add(p.Kit, min(2, p.Max))
	}
	add(campdefs.D.Fire.Wood, 30)
	add("hide:wolf", 4)
	add("ore:copper", 4)
	add("meat:raw", 4)
	s.commitItems(sess, &d, nil, "camp dev grant")
	s.sendGranted(sess, SourceCraft, got)
}

// ---- debug ----

// CampDebug lists the pieces (GET /debug/camps; tick goroutine via Do).
func (s *Server) CampDebug() map[string]any {
	s.campInit()
	type pj struct {
		ID      uint64  `json:"id"`
		Kind    string  `json:"kind"`
		Owner   string  `json:"owner"`
		Name    string  `json:"ownerName"`
		X       float64 `json:"x"`
		Y       float64 `json:"y"`
		Z       float64 `json:"z"`
		Rot     int     `json:"rot"`
		Label   string  `json:"label,omitempty"`
		BurnS   float64 `json:"burnS,omitempty"`
		Mine    bool    `json:"mine"`
		Chested int     `json:"chestItems,omitempty"`
	}
	now := s.worldTimeS()
	out := []pj{}
	for _, p := range s.camp.pieces {
		n := 0
		for _, c := range p.chest {
			if c != nil {
				n++
			}
		}
		out = append(out, pj{ID: p.ID, Kind: campdefs.D.ByID(p.Kind).Key, Owner: p.Owner, Name: p.OwnerName, X: p.X, Y: p.Y, Z: p.Z, Rot: p.Rot, Label: p.Label, BurnS: math.Max(0, p.BurnUntil-now), Mine: p.mine, Chested: n})
	}
	slices.SortFunc(out, func(a, b pj) int { return cmpU64(a.ID, b.ID) })
	return map[string]any{"pieces": out, "fires": len(s.camp.fires), "solid": s.camp.set.Len(), "worldTime": now}
}
