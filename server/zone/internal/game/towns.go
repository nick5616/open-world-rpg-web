package game

// Towns and NPCs in the zone (WP20). The townsfolk of internal/npc become
// snapshot entities (kind npc) while a player is near their settlement, so
// they replicate through the ordinary snapshot/AOI path; Interact kinds
// 30-33 talk to them, read the bounty board, use a forge or anvil (the
// interaction point WP14 hooks into: Config.Stations) and descend a
// mineshaft into its cave system. Events 800-807 answer (contracts/events.md).
//
// NPCs walk on the same movement ground players do (floors within a step,
// door ramps; GroundAt at their level), but are not pushed by walls: their
// paths go through doors and along streets by construction (npc tests).

import (
	"encoding/binary"
	"math"
	"time"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/towns"
	"lodestone/server/zone/internal/npc"
)

// Interact target kinds and actions owned by towns (contracts/events.md).
const (
	InteractNPC     = 30
	InteractBoard   = 31
	InteractStation = 32
	InteractShaft   = 33

	ActionTalk   = 1
	ActionBuy    = 2
	ActionRest   = 3
	ActionAccept = 4 // npc; the board uses 2 for accept
)

// Event kinds 800-899 (WP20).
const (
	EventNPCSay         = 800
	EventShop           = 801
	EventBounties       = 802
	EventBountyAccepted = 803
	EventRested         = 804
	EventStationOpened  = 805
	EventTownRefused    = 806
	EventPurchase       = 807
)

// Refusal reasons (Event 806 value).
const (
	TownRefuseTooFar      = 1
	TownRefuseUnknown     = 2
	TownRefuseClosed      = 3
	TownRefuseNoSuch      = 4
	TownRefuseHave        = 5
	TownRefuseTooMany     = 6
	TownRefuseRested      = 7
	TownRefuseNoCaveBelow = 8
)

const (
	npcActivateM   = 200 // a settlement's NPCs come alive when a player is this close to its edge
	npcDeactivateM = 260 // ... and are dropped beyond this (hysteresis)
	npcEveryTicks  = 15  // activation check twice a second
	townReachM     = 4.5 // spec "4 m from the eye" plus latency slack
	maxBounties    = 5
	shaftReachM    = 8
)

// Stations is the forge/anvil hook (WP14: smelting, forging, socketing).
// Return true when handled; false falls back to Event 805.
type Stations interface {
	UseStation(player *Entity, station int, propID uint64, settlement int) bool
}

type townsState struct {
	active   map[int]*Entity // npc index -> entity
	byEnt    map[uint32]int  // entity id -> npc index
	accepted map[string][]npc.Bounty
	props    map[uint64]int // interactable prop id -> towns prop index
	structs  map[uint64]int // structure id -> structure index
}

func (s *Server) timeOfDay(now time.Time) float64 {
	return npc.TimeOfDay(float64(now.UnixMilli())/1000, s.cfg.TimeOffsetS)
}

func (s *Server) gameDay(now time.Time) int {
	return int(math.Floor((float64(now.UnixMilli())/1000 + s.cfg.TimeOffsetS) / npc.DayLengthS))
}

func (s *Server) npcGround(x, y, z float64) float64 { return movement.GroundAt(s.cfg.Ground, x, y, z) }

func (s *Server) townsInit() {
	t := &s.town
	if t.active != nil {
		return
	}
	t.active = map[int]*Entity{}
	t.byEnt = map[uint32]int{}
	t.accepted = map[string][]npc.Bounty{}
	t.props = map[uint64]int{}
	t.structs = map[uint64]int{}
	tw := s.cfg.Towns.T
	for i := range tw.Props {
		if tw.Props[i].Flags&towns.PropInteract != 0 {
			t.props[tw.Props[i].ID] = i
		}
	}
	for i := range tw.Structures {
		t.structs[tw.Structures[i].ID] = i
	}
}

// townsTick activates settlements near players, steps active NPCs and
// refreshes their entities (tick goroutine).
func (s *Server) townsTick(tick uint32, now time.Time) {
	w := s.cfg.Towns
	if w == nil {
		return
	}
	s.townsInit()
	t := &s.town
	tod := s.timeOfDay(now)
	if tick%npcEveryTicks == 0 {
		for si := range w.T.Settlements {
			st := &w.T.Settlements[si]
			near := math.Inf(1)
			for _, sess := range s.sessions {
				if e := sess.ent; e != nil {
					near = math.Min(near, math.Hypot(e.Move.Pos.X-st.X, e.Move.Pos.Z-st.Z)-st.Radius)
				}
			}
			for i := st.NPCFirst; i < st.NPCFirst+st.NPCs; i++ {
				e, on := t.active[i]
				switch {
				case !on && near < npcActivateM:
					s.activateNPC(i, tod)
				case on && near > npcDeactivateM:
					s.removeEntity(e)
					delete(t.byEnt, e.ID)
					delete(t.active, i)
				}
			}
		}
	}
	dt := 1.0 / 30
	for i, e := range t.active {
		w.Step(i, tod, dt, s.npcGround)
		st := &w.NPCs[i]
		e.Move.Pos = movement.Vec3{X: st.X, Y: st.Y, Z: st.Z}
		e.Move.Vel = movement.Vec3{X: st.VX, Z: st.VZ}
		e.Yaw = wireYaw(st.Yaw)
		e.prevValid = e.Move
	}
}

// wireYaw turns a worldgen heading (radians from +x toward +z: forward =
// (cos, sin)) into the camera-convention yaw players send and every
// EntityRecord carries (forward = (-sin, -cos)), so NPCs and players share
// one meaning of EntityRecord.yaw.
func wireYaw(h float64) float64 { return math.Atan2(-math.Cos(h), -math.Sin(h)) }

func (s *Server) activateNPC(i int, tod float64) {
	w := s.cfg.Towns
	w.Place(i, tod, s.npcGround, s.cfg.Ground.HeightAt)
	st := &w.NPCs[i]
	d := st.Def
	e := &Entity{ID: s.nextID, Kind: proto.EntityKindNpc, Name: d.Name, Level: d.Merchant, TypeID: uint16(d.Role) | uint16(d.Variant)<<8, Health: 100, HealthMax: 100}
	s.nextID++
	e.Move = movement.State{Pos: movement.Vec3{X: st.X, Y: st.Y, Z: st.Z}}
	e.Yaw = wireYaw(st.Yaw)
	e.prevValid = e.Move
	e.view = e.Move
	s.ents = append(s.ents, e) // ids only grow: stays sorted
	s.town.active[i] = e
	s.town.byEnt[e.ID] = i
}

// NPCEntity returns the entity of NPC i if it is active (tests, tools).
func (s *Server) NPCEntity(i int) *Entity { return s.town.active[i] }

func (s *Server) townEvent(e *Entity, ev *proto.Event) { s.sendEventTo(e, ev) }

func (s *Server) refuseTown(e *Entity, id uint64, reason int32) {
	s.townEvent(e, &proto.Event{Kind: EventTownRefused, EntityID: e.ID, Value: reason, Data: binary.LittleEndian.AppendUint64(nil, id)})
}

func eyeDist(e *Entity, x, y, z float64) float64 {
	p := e.Move.Pos
	return math.Sqrt((p.X-x)*(p.X-x) + (p.Y+1.6-y)*(p.Y+1.6-y) + (p.Z-z)*(p.Z-z))
}

// townInteract applies a towns Interact (tick goroutine).
func (s *Server) townInteract(sess *session, m *proto.Interact, now time.Time) {
	w := s.cfg.Towns
	e := sess.ent
	if w == nil || e == nil || m.TargetKind < InteractNPC || m.TargetKind > InteractShaft {
		return
	}
	s.townsInit()
	switch m.TargetKind {
	case InteractNPC:
		s.npcInteract(e, m, now)
	case InteractBoard:
		s.boardInteract(e, m, now)
	case InteractStation:
		s.stationInteract(e, m)
	case InteractShaft:
		s.shaftInteract(e, m)
	}
}

func (s *Server) npcInteract(e *Entity, m *proto.Interact, now time.Time) {
	w := s.cfg.Towns
	i, ok := s.town.byEnt[uint32(m.TargetID)]
	if !ok {
		s.refuseTown(e, m.TargetID, TownRefuseUnknown)
		return
	}
	ne := s.town.active[i]
	if eyeDist(e, ne.Move.Pos.X, ne.Move.Pos.Y+1.0, ne.Move.Pos.Z) > townReachM {
		s.refuseTown(e, m.TargetID, TownRefuseTooFar)
		return
	}
	tod := s.timeOfDay(now)
	open := w.Open(i, tod)
	d := w.NPCs[i].Def
	switch m.Action {
	case ActionTalk:
		ov := int32(0)
		if open {
			ov = 1
		}
		s.townEvent(e, &proto.Event{Kind: EventNPCSay, EntityID: ne.ID, TargetID: uint32(d.Role), Value: ov, Data: []byte(w.Say(i, tod, open))})
		if !open {
			return
		}
		if ws := w.Wares(i); ws != nil {
			s.townEvent(e, &proto.Event{Kind: EventShop, EntityID: ne.ID, Value: int32(d.Merchant), Data: npc.EncodeShop(ws)})
		}
		if d.Role == towns.RoleBounty {
			s.sendBounties(e, d.Settlement, ne.ID, now)
		}
	case ActionBuy:
		ws := w.Wares(i)
		switch {
		case ws == nil:
			s.refuseTown(e, m.TargetID, TownRefuseUnknown)
		case !open:
			s.refuseTown(e, m.TargetID, TownRefuseClosed)
		case int(m.Arg) >= len(ws):
			s.refuseTown(e, m.TargetID, TownRefuseNoSuch)
		default:
			it := ws[m.Arg]
			if s.cfg.Granter != nil {
				if err := s.cfg.Granter.Grant(e.CharacterID, it.Item, 1, uint64(now.UnixNano())); err != nil {
					s.log.Warn("purchase grant failed", "character", e.CharacterID, "item", it.Item, "err", err)
					return
				}
			}
			s.log.Info("purchase", "character", e.CharacterID, "item", it.Item, "price", it.Price, "npc", d.Name)
			s.townEvent(e, &proto.Event{Kind: EventPurchase, EntityID: e.ID, TargetID: 1, Value: int32(it.Price), Data: []byte(it.Item)})
		}
	case ActionRest:
		if d.Role != towns.RoleInnkeeper {
			s.refuseTown(e, m.TargetID, TownRefuseUnknown)
			return
		}
		if e.Health >= e.HealthMax {
			s.refuseTown(e, m.TargetID, TownRefuseRested)
			return
		}
		got := int32(e.HealthMax - e.Health)
		e.Health = e.HealthMax
		s.townEvent(e, &proto.Event{Kind: EventRested, EntityID: e.ID, Value: got})
	case ActionAccept:
		if d.Role != towns.RoleBounty {
			s.refuseTown(e, m.TargetID, TownRefuseUnknown)
			return
		}
		if !open {
			s.refuseTown(e, m.TargetID, TownRefuseClosed)
			return
		}
		s.acceptBounty(e, d.Settlement, uint32(m.Arg), ne.ID, now)
	}
}

func (s *Server) interactProp(e *Entity, id uint64, kinds ...uint8) (*towns.Prop, bool) {
	pi, ok := s.town.props[id]
	if !ok {
		s.refuseTown(e, id, TownRefuseUnknown)
		return nil, false
	}
	p := &s.cfg.Towns.T.Props[pi]
	match := false
	for _, k := range kinds {
		match = match || p.Kind == k
	}
	if !match {
		s.refuseTown(e, id, TownRefuseUnknown)
		return nil, false
	}
	if eyeDist(e, p.X, p.Y+1.0, p.Z) > townReachM {
		s.refuseTown(e, id, TownRefuseTooFar)
		return nil, false
	}
	return p, true
}

func (s *Server) boardInteract(e *Entity, m *proto.Interact, now time.Time) {
	p, ok := s.interactProp(e, m.TargetID, towns.PropBoard)
	if !ok {
		return
	}
	switch m.Action {
	case 1:
		s.sendBounties(e, p.Settlement, 0, now)
	case 2:
		s.acceptBounty(e, p.Settlement, uint32(m.Arg), 0, now)
	}
}

func (s *Server) sendBounties(e *Entity, settlement int, from uint32, now time.Time) {
	bs := s.cfg.Towns.Bounties(settlement, s.gameDay(now))
	have := s.town.accepted[e.CharacterID]
	data := npc.EncodeBounties(bs, func(id uint32) bool {
		for _, b := range have {
			if b.ID == id {
				return true
			}
		}
		return false
	})
	s.townEvent(e, &proto.Event{Kind: EventBounties, EntityID: from, TargetID: uint32(settlement), Data: data})
}

func (s *Server) acceptBounty(e *Entity, settlement int, id uint32, from uint32, now time.Time) {
	var pick *npc.Bounty
	bs := s.cfg.Towns.Bounties(settlement, s.gameDay(now))
	for k := range bs {
		if bs[k].ID == id {
			pick = &bs[k]
		}
	}
	have := s.town.accepted[e.CharacterID]
	switch {
	case pick == nil:
		s.refuseTown(e, uint64(id), TownRefuseNoSuch)
		return
	case len(have) >= maxBounties:
		s.refuseTown(e, uint64(id), TownRefuseTooMany)
		return
	}
	for _, b := range have {
		if b.ID == id {
			s.refuseTown(e, uint64(id), TownRefuseHave)
			return
		}
	}
	s.town.accepted[e.CharacterID] = append(have, *pick)
	s.log.Info("bounty accepted", "character", e.CharacterID, "bounty", id, "text", pick.Text)
	s.townEvent(e, &proto.Event{Kind: EventBountyAccepted, EntityID: e.ID, TargetID: id, Value: int32(pick.Reward), Data: []byte(pick.Text)})
	s.sendBounties(e, settlement, from, now)
}

// AcceptedBounties is the hook WP13/WP14/WP15 complete bounties through
// (kills, deliveries, demons): the jobs a player holds this session.
func (s *Server) AcceptedBounties(e *Entity) []npc.Bounty { return s.town.accepted[e.CharacterID] }

// CompleteBounty removes a held bounty (the caller grants the reward).
func (s *Server) CompleteBounty(e *Entity, id uint32) bool {
	have := s.town.accepted[e.CharacterID]
	for k, b := range have {
		if b.ID == id {
			s.town.accepted[e.CharacterID] = append(have[:k:k], have[k+1:]...)
			return true
		}
	}
	return false
}

func (s *Server) stationInteract(e *Entity, m *proto.Interact) {
	p, ok := s.interactProp(e, m.TargetID, towns.PropForge, towns.PropAnvil)
	if !ok || m.Action != 1 {
		return
	}
	station := 1
	if p.Kind == towns.PropAnvil {
		station = 2
	}
	if s.cfg.Stations != nil && s.cfg.Stations.UseStation(e, station, p.ID, p.Settlement) {
		return
	}
	data := binary.LittleEndian.AppendUint64(nil, p.ID)
	data = binary.LittleEndian.AppendUint16(data, uint16(p.Settlement))
	s.townEvent(e, &proto.Event{Kind: EventStationOpened, EntityID: e.ID, TargetID: uint32(station), Data: data})
}

// shaftInteract: the winch takes you down the old shaft into the linked
// cave system's entrance chamber (spec 5: mineshafts connect into caves).
func (s *Server) shaftInteract(e *Entity, m *proto.Interact) {
	si, ok := s.town.structs[m.TargetID]
	tw := s.cfg.Towns.T
	if !ok || tw.Structures[si].Kind != towns.StructMineshaft || m.Action != 1 {
		s.refuseTown(e, m.TargetID, TownRefuseUnknown)
		return
	}
	st := &tw.Structures[si]
	if math.Hypot(e.Move.Pos.X-st.X, e.Move.Pos.Z-st.Z) > st.Radius+shaftReachM {
		s.refuseTown(e, m.TargetID, TownRefuseTooFar)
		return
	}
	cw := s.caves()
	if cw == nil || st.Link < 0 {
		s.refuseTown(e, m.TargetID, TownRefuseNoCaveBelow)
		return
	}
	// Down the shaft: the chamber of the linked system nearest the shaft
	// (horizontally) whose floor lies at least 6 m below the shaft's ground;
	// the system's deepest chamber if none does (the mouth may sit uphill).
	g := cw.CaveGraph()
	for _, sys := range g.Systems {
		if sys.SiteIndex != st.Link {
			continue
		}
		best, bestD, deepest := -1, math.Inf(1), -1
		for c := sys.FirstChamber; c < sys.FirstChamber+sys.Chambers; c++ {
			ch := g.Chambers[c]
			if deepest < 0 || ch.Floor < g.Chambers[deepest].Floor {
				deepest = c
			}
			if ch.Floor < st.Y-6 {
				if d := math.Hypot(ch.X-st.X, ch.Z-st.Z); d < bestD {
					best, bestD = c, d
				}
			}
		}
		if best < 0 {
			best = deepest
		}
		if best >= 0 {
			ch := g.Chambers[best]
			s.log.Info("mineshaft descent", "character", e.CharacterID, "structure", st.Site, "cave", sys.SiteIndex, "y", ch.Floor)
			s.Teleport(e, movement.Vec3{X: ch.X, Y: ch.Floor + 0.2, Z: ch.Z})
			return
		}
	}
	s.refuseTown(e, m.TargetID, TownRefuseNoCaveBelow)
}
