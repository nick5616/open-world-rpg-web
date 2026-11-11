package game

// Building doors in the zone (playtest follow-up to WP20; contracts/events.md
// Interact 34, Events 970-972). Every closable doorway of the towns layer
// (server/pkg/towns doors.go: the box is copied from the buffer, identical
// in TS) can be opened and closed with Interact 34; doors start open (a
// WP20 doorway), so nothing changes until someone closes one.
//
// Prediction-safe changes: a change never applies "now". It is scheduled
// for each player within doorInterestM of the settlement at an input seq
// the client has not simulated yet (its newest applied frame + the round
// trip in frames + doorLeadSteps), sent to that player as Event 970 with
// that seq, and the movement step evaluates the door per player and frame:
// open for frame n iff n >= stamp ? new : old. The client stamps its own
// steps the same way (client/src/world/buildings/doors.ts), so walking
// into, through or against a door that is opening or closing costs no
// correction. A change settles (one state for everyone) once every stamped
// player has passed its seq (or after doorSettleTicks).
//
// The zone refuses to close a door on a body (a player or an NPC touching
// the doorway, with a margin for its speed), and refuses a second change
// while one is still pending. Newcomers (and players returning after
// missing changes) get a baseline (971) of the settlement's non-open doors
// when they come within doorBaselineM.
//
// NPCs (internal/npc DoorGate) open a closed door they need to walk
// through, wait for it, walk through and close it behind them once the
// doorway is clear; through an open door they just walk.
//
// Cost: nothing per tick unless a change is pending (a short list) or a
// settlement has ever had a door changed (baseline check twice a second);
// the movement step only wraps the ground while some door is not open.
//
// Persistence and multiple zones (the zone owning a door's region decides
// it, every other zone mirrors it): doors_sync.go.

import (
	"encoding/binary"
	"math"
	"slices"
	"time"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/towns"
)

// Interact target kind 34 and its actions (contracts/events.md).
const (
	InteractDoor    = 34
	DoorActOpen     = 1
	DoorActClose    = 2
	DoorActToggle   = 3
	EventDoorState  = 970
	EventDoorBase   = 971
	EventDoorRefuse = 972
)

// Door refusal reasons (Event 972 value).
const (
	DoorRefuseTooFar  = 1
	DoorRefuseUnknown = 2
	DoorRefuseBody    = 3
	DoorRefuseBusy    = 4
	DoorRefuseAlready = 5
)

const (
	doorLeadSteps   = 12 // input frames of slack beyond the client's estimated newest frame (200 ms)
	doorMaxLagSteps = 60 // cap on the round-trip term (1 s)
	doorSettleTicks = 90 // a pending change settles for everyone after 3 s at the latest
	doorInterestM   = npcDeactivateM
	doorBaselineM   = npcActivateM
	doorBodyMargin  = 0.1  // m beyond the body radius that still counts as in the doorway
	doorSpeedLeadS  = 0.25 // and the distance a body covers in this long
	doorNPCRetryS   = 20.0 // an NPC gives up closing behind it after this long
	bodyRadius      = constants.PlayerCapsuleRadius
)

type doorStamp struct {
	sess *session
	seq  uint32
}

type doorPend struct {
	to     bool
	since  uint32
	stamps []doorStamp
}

type npcClose struct {
	door, npc int
	since     uint32
}

// doorWorld is the zone's door state (tick goroutine).
type doorWorld struct {
	s      *towns.Doors
	open   []bool // settled state
	pend   []*doorPend
	active int     // doors not settled open (the ground wraps itself while > 0)
	queue  []int   // doors with a pending change
	bySet  [][]int // settlement -> its doors
	epoch  []uint32
	dirty  []int // settlements whose doors ever changed (baseline checks)
	opened map[int]int
	closeQ []npcClose
	// doors_sync.go: persistence and the other zones.
	at      []time.Time // when the authority last decided each door
	unsaved map[int]bool
	flushes uint64
	mirror  map[int]doorMirrorWant // another zone's change waiting for ours to settle
	asked   map[int]uint32         // NPC open requests sent to the authority (tick)
}

// sessDoors is a session's door bookkeeping and its frame ground.
type sessDoors struct {
	known map[int]uint32 // settlement -> epoch this client has
	view  doorView
	g     doorFrameGround
}

func (s *Server) doorsInit() {
	t := &s.town
	if t.doors != nil || s.cfg.Towns == nil {
		return
	}
	tw := s.cfg.Towns.T
	ds := towns.NewDoors(tw)
	w := &doorWorld{s: ds, open: make([]bool, ds.Len()), pend: make([]*doorPend, ds.Len()), bySet: make([][]int, len(tw.Settlements)), epoch: make([]uint32, len(tw.Settlements)), opened: map[int]int{},
		at: make([]time.Time, ds.Len()), unsaved: map[int]bool{}, mirror: map[int]doorMirrorWant{}, asked: map[int]uint32{}}
	for d := range ds.D {
		w.open[d] = true
		if si := ds.D[d].Settlement; si >= 0 && si < len(w.bySet) {
			w.bySet[si] = append(w.bySet[si], d)
		}
	}
	t.doors = w
	s.cfg.Towns.Doors = npcDoors{s}
}

func (w *doorWorld) settledOpen(d int) bool { return w.open[d] && w.pend[d] == nil }

// openFor: door d for this session's input frame seq.
func (w *doorWorld) openFor(d int, sess *session, seq uint32) bool {
	if p := w.pend[d]; p != nil {
		for _, st := range p.stamps {
			if st.sess == sess {
				if seq >= st.seq {
					return p.to
				}
				break
			}
		}
	}
	return w.open[d]
}

type doorView struct {
	w    *doorWorld
	sess *session
	seq  uint32
}

func (v *doorView) DoorClosed(d int) bool { return !v.w.openFor(d, v.sess, v.seq) }

// doorFrameGround is the zone ground for one player's input frame: the
// level view gets the doors closed for that frame (towns.WithDoors).
type doorFrameGround struct {
	inner movement.Ground
	s     *towns.Doors
	v     *doorView
}

func (g *doorFrameGround) HeightAt(x, z float64) float64 { return g.inner.HeightAt(x, z) }
func (g *doorFrameGround) WaterAt(x, z float64) float64  { return movement.WaterAt(g.inner, x, z) }
func (g *doorFrameGround) AtLevel(y float64) movement.Ground {
	return towns.WithDoors(movement.AtLevel(g.inner, y), g.s, g.v)
}

func (s *Server) sessDoors(sess *session) *sessDoors {
	if sess.doors == nil {
		sess.doors = &sessDoors{known: map[int]uint32{}}
	}
	return sess.doors
}

// frameGround is the ground a player's input frame seq steps on: the zone
// ground, with the doors closed for that frame while any door is not open.
func (s *Server) frameGround(sess *session, seq uint32) movement.Ground {
	w := s.town.doors
	if sess.riftG != nil {
		return s.riftWrap(sess, s.cfg.Ground) // CR 040: the rift's arena (rift.go)
	}
	if w == nil || w.active == 0 {
		return s.campWrap(sess, s.cfg.Ground) // CR 025: solid camp pieces near the player (camps.go)
	}
	sd := s.sessDoors(sess)
	sd.view = doorView{w: w, sess: sess, seq: seq}
	sd.g = doorFrameGround{inner: s.cfg.Ground, s: w.s, v: &sd.view}
	return s.campWrap(sess, &sd.g)
}

// doorStep: the first input seq of this session a change may apply from
// (beyond everything the client has predicted when the event reaches it).
func (s *Server) doorStep(sess *session) uint32 {
	lag := uint32(0)
	if sess.ackTick != 0 && s.tick > sess.ackTick {
		lag = min((s.tick-sess.ackTick)*stepsPerTick, doorMaxLagSteps)
	}
	return sess.consumed + lag + doorLeadSteps
}

func (w *doorWorld) recount(d int, wasActive bool) {
	now := !w.settledOpen(d)
	if now && !wasActive {
		w.active++
	} else if !now && wasActive {
		w.active--
	}
}

func settlementEdgeDist(st *towns.Settlement, p movement.Vec3) float64 {
	return math.Hypot(p.X-st.X, p.Z-st.Z) - st.Radius
}

func doorData(id uint64, step uint32) []byte {
	b := binary.LittleEndian.AppendUint64(make([]byte, 0, 12), id)
	return binary.LittleEndian.AppendUint32(b, step)
}

// doorSchedule is the authority's change of door d to `to`: applied here
// and persisted / sent to the other zones (doors_sync.go doorChanged).
func (s *Server) doorSchedule(d int, to bool, by uint32) {
	s.doorApply(d, to, by)
	s.doorChanged(d, to, by)
}

// doorApply changes door d to `to` for everyone on this zone, from a
// stamped input seq per player in range (Event 970 each).
func (s *Server) doorApply(d int, to bool, by uint32) {
	w := s.town.doors
	dr := &w.s.D[d]
	was := !w.settledOpen(d)
	p := &doorPend{to: to, since: s.tick}
	si := dr.Settlement
	w.epoch[si]++
	if w.epoch[si] == 1 {
		w.dirty = append(w.dirty, si)
	}
	st := &s.cfg.Towns.T.Settlements[si]
	val := int32(0)
	if to {
		val = 1
	}
	for _, sess := range s.sessions {
		e := sess.ent
		if e == nil || settlementEdgeDist(st, e.Move.Pos) > doorInterestM {
			continue
		}
		seq := s.doorStep(sess)
		p.stamps = append(p.stamps, doorStamp{sess, seq})
		s.sendEvent(sess, &proto.Event{Kind: EventDoorState, EntityID: by, TargetID: uint32(dr.Prop), Value: val, X: cm(dr.X), Y: cm(dr.Y), Z: cm(dr.Z), Data: doorData(dr.ID, seq)})
		s.sessDoors(sess).known[si] = w.epoch[si]
	}
	w.pend[d] = p
	w.queue = append(w.queue, d)
	w.recount(d, was)
	s.log.Debug("door", "door", d, "prop", dr.Prop, "open", to, "by", by, "told", len(p.stamps))
}

// doorBlocked: is a player or an active NPC in door d's doorway (or about
// to be, at its speed)?
func (s *Server) doorBlocked(d int) bool {
	w := s.town.doors
	dr := &w.s.D[d]
	touch := func(p movement.Vec3, vx, vz float64) bool {
		if math.Abs(p.X-dr.X) > 4 || math.Abs(p.Z-dr.Z) > 4 {
			return false
		}
		r := bodyRadius + doorBodyMargin + min(math.Hypot(vx, vz)*doorSpeedLeadS, 1.5)
		return w.s.Touches(d, p.X, p.Y, p.Z, r)
	}
	for _, sess := range s.sessions {
		if e := sess.ent; e != nil && touch(e.Move.Pos, e.Move.Vel.X, e.Move.Vel.Z) {
			return true
		}
	}
	// WP16 ghost band: players another zone simulates, mirrored here.
	for _, r := range s.cl.remote {
		if r.Kind == proto.EntityKindPlayer && touch(r.Move.Pos, proto.CmsToVel(r.q.Vx), proto.CmsToVel(r.q.Vz)) {
			return true
		}
	}
	for i := range s.town.active {
		st := &s.cfg.Towns.NPCs[i]
		if touch(movement.Vec3{X: st.X, Y: st.Y, Z: st.Z}, st.VX, st.VZ) {
			return true
		}
	}
	return false
}

func (s *Server) refuseDoor(sess *session, prop int, id uint64, reason int32) {
	s.sendEvent(sess, &proto.Event{Kind: EventDoorRefuse, EntityID: sess.ent.ID, TargetID: uint32(prop), Value: reason, Data: binary.LittleEndian.AppendUint64(nil, id)})
}

// doorInteract applies Interact 34 (tick goroutine).
func (s *Server) doorInteract(sess *session, m *proto.Interact) {
	s.doorsInit()
	w := s.town.doors
	e := sess.ent
	d, ok := w.s.ByProp[m.TargetID]
	if !ok {
		s.refuseDoor(sess, math.MaxUint32, m.TargetID, DoorRefuseUnknown)
		return
	}
	dr := &w.s.D[d]
	if eyeDist(e, dr.X, dr.Y+1.2, dr.Z) > townReachM {
		s.refuseDoor(sess, dr.Prop, dr.ID, DoorRefuseTooFar)
		return
	}
	var to bool
	switch m.Action {
	case DoorActOpen:
		to = true
	case DoorActClose:
		to = false
	case DoorActToggle:
		to = !w.open[d]
	default:
		s.refuseDoor(sess, dr.Prop, dr.ID, DoorRefuseUnknown)
		return
	}
	switch {
	case w.pend[d] != nil:
		s.refuseDoor(sess, dr.Prop, dr.ID, DoorRefuseBusy)
	case w.open[d] == to:
		s.refuseDoor(sess, dr.Prop, dr.ID, DoorRefuseAlready)
	case !to && s.doorBlocked(d):
		s.refuseDoor(sess, dr.Prop, dr.ID, DoorRefuseBody)
	default:
		s.doorWant(d, to, e.ID, e.CharacterID) // here, or by the door's zone (doors_sync.go)
	}
}

// doorsTick settles pending changes, sends baselines and closes doors NPCs
// opened behind them. Free when nothing ever changed.
func (s *Server) doorsTick(tick uint32) {
	w := s.town.doors
	if w == nil {
		return
	}
	if len(w.unsaved) > 0 && tick%doorFlushTicks == 0 {
		s.flushDoors()
	}
	if len(w.queue) > 0 {
		var settled []int
		w.queue = slices.DeleteFunc(w.queue, func(d int) bool {
			p := w.pend[d]
			if p == nil {
				return true
			}
			done := tick-p.since >= doorSettleTicks
			if !done {
				done = true
				for _, st := range p.stamps {
					if !st.sess.left && st.sess.consumed < st.seq {
						done = false
						break
					}
				}
			}
			if !done {
				return false
			}
			was := !w.settledOpen(d)
			w.open[d] = p.to
			s.navDoorChanged(d) // enemy pathfinding (obstacles.go)
			w.pend[d] = nil
			w.recount(d, was)
			settled = append(settled, d)
			return true
		})
		for _, d := range settled { // another zone decided meanwhile
			if m, ok := w.mirror[d]; ok {
				delete(w.mirror, d)
				s.doorMirror(d, m.to, m.by)
			}
		}
	}
	if tick%npcEveryTicks != 0 {
		return
	}
	for _, si := range w.dirty {
		st := &s.cfg.Towns.T.Settlements[si]
		for _, sess := range s.sessions {
			e := sess.ent
			if e == nil || settlementEdgeDist(st, e.Move.Pos) > doorBaselineM {
				continue
			}
			sd := s.sessDoors(sess)
			if sd.known[si] == w.epoch[si] {
				continue
			}
			sd.known[si] = w.epoch[si]
			s.sendDoorBaseline(sess, si)
		}
	}
	if len(w.closeQ) > 0 {
		w.closeQ = slices.DeleteFunc(w.closeQ, func(c npcClose) bool {
			switch {
			case w.pend[c.door] != nil:
				return false // still swinging
			case !w.open[c.door]:
				return true // someone closed it already
			case float64(tick-c.since)/constants.TickRateHz > doorNPCRetryS:
				return true
			case s.doorBlocked(c.door):
				return false
			}
			by := uint32(0)
			if e := s.town.active[c.npc]; e != nil {
				by = e.ID
			}
			s.doorWant(c.door, false, by, "")
			return true
		})
	}
}

// sendDoorBaseline: settlement si's doors that are not settled open (a
// pending change carries a fresh stamp for this session).
func (s *Server) sendDoorBaseline(sess *session, si int) {
	w := s.town.doors
	data := []byte{1, 0, 0}
	n := 0
	for _, d := range w.bySet[si] {
		if w.settledOpen(d) {
			continue
		}
		to, step := w.open[d], uint32(0)
		if p := w.pend[d]; p != nil {
			to = p.to
			found := false
			for _, st := range p.stamps {
				if st.sess == sess {
					step, found = st.seq, true
				}
			}
			if !found {
				step = s.doorStep(sess)
				p.stamps = append(p.stamps, doorStamp{sess, step})
			}
		}
		data = binary.LittleEndian.AppendUint32(data, uint32(w.s.D[d].Prop))
		data = append(data, b2u(w.open[d]), b2u(to))
		data = binary.LittleEndian.AppendUint32(data, step)
		n++
	}
	binary.LittleEndian.PutUint16(data[1:3], uint16(n))
	s.sendEvent(sess, &proto.Event{Kind: EventDoorBase, EntityID: sess.ent.ID, TargetID: uint32(si), Data: data})
}

func b2u(b bool) byte {
	if b {
		return 1
	}
	return 0
}

// DoorOpen reports door d's latest state (a pending change counts) and
// whether that change is still pending (tests, tools; tick goroutine).
func (s *Server) DoorOpen(d int) (open, pending bool) {
	w := s.town.doors
	if w == nil {
		return true, false
	}
	if p := w.pend[d]; p != nil {
		return p.to, true
	}
	return w.open[d], false
}

// Doors returns the towns doors (nil before the towns glue ran).
func (s *Server) Doors() *towns.Doors {
	if s.town.doors == nil {
		return nil
	}
	return s.town.doors.s
}

// npcDoors is the townsfolk's door gate (internal/npc DoorGate).
type npcDoors struct{ s *Server }

func (g npcDoors) Pass(i, b int) bool {
	w := g.s.town.doors
	d, ok := w.s.ByBuilding[b]
	if !ok {
		return true
	}
	if w.pend[d] != nil {
		return false // swinging: wait
	}
	if w.open[d] {
		return true
	}
	by := uint32(0)
	if e := g.s.town.active[i]; e != nil {
		by = e.ID
	}
	if _, mine := g.s.doorOwner(d); !mine {
		// Another zone's door: ask it (once every 2 s) and wait for its 970.
		if t, ok := w.asked[d]; ok && g.s.tick-t < 60 {
			return false
		}
		w.asked[d] = g.s.tick
	}
	g.s.doorWant(d, true, by, "") // a hand on the latch
	w.opened[d] = i
	return false
}

func (g npcDoors) Through(i, b int) {
	w := g.s.town.doors
	d, ok := w.s.ByBuilding[b]
	if !ok {
		return
	}
	if who, ok := w.opened[d]; ok && who == i {
		delete(w.opened, d)
		w.closeQ = append(w.closeQ, npcClose{door: d, npc: i, since: g.s.tick})
	}
}
