package game

// Building doors outlive the zone (playtest polish; doors.go is the
// in-zone part). Until now a door's state lived in zone memory only: a
// restart reopened every door, and each zone of a WP16 cluster had its own.
//
// Authority: the zone that owns the region a door stands in (Owners) is
// that door's authority; a single zone owns everything. Only the authority
// decides a change and persists it. Everywhere else:
//
//   - A player's Interact 34 (or an NPC needing a closed door) passes the
//     local checks (reach, pending, already, someone in the doorway), then
//     goes to the authority as a control message (ctlDoor). The authority
//     checks again on its own state, its bodies and the ghost band's
//     mirrored players (doorBlocked), and either applies the change or
//     answers ctlDoorNo (the asker gets Event 972).
//   - Every change the authority makes (players, its NPCs, requests) goes
//     to every other zone (ctlDoorSet); each applies it to its own players
//     with its own prediction-safe stamps (doorApply, Event 970), after any
//     change still pending there. So the players on both sides of a zone
//     border near a town see one door, and a player handed off keeps it:
//     the new zone's baseline (971) lists the same doors.
//
// Persistence: door_state (migration 0024), one row per door that ever
// changed, written by the authority only, on change, batched (the doors
// changed in the last second go in one write-behind op, a multi-row
// upsert; a stale row never overwrites a newer one), flushed again on
// shutdown. Every zone reads the table before it starts ticking
// (RestoreDoors), so a restarted zone, or one taking a region over from a
// dead one, starts from the last decided state. The cost when nothing
// changes is zero; a change costs one map insert on the tick.

import (
	"context"
	"strconv"

	"lodestone/server/pkg/writebehind"
)

const doorFlushTicks = 30 // batch window: one write per second at most

func doorAct(open bool) int {
	if open {
		return DoorActOpen
	}
	return DoorActClose
}

// doorOwner is the zone deciding door d's state (mine=true: this zone; no
// cluster, no ownership table yet, or nobody owning the region).
func (s *Server) doorOwner(d int) (zone string, mine bool) {
	if !s.clusterOn() {
		return "", true
	}
	own := s.cl.c.Owners()
	if own == nil {
		return s.cl.self, true
	}
	dr := &s.town.doors.s.D[d]
	o := own.OwnerAt(dr.X, dr.Z)
	if o == "" || o == s.cl.self {
		return s.cl.self, true
	}
	return o, false
}

// doorWant: someone here wants door d at `to` (local checks passed). The
// authority applies it; elsewhere the request goes to the authority. char
// is the asking player's character ("" for an NPC: no refusal is sent back).
func (s *Server) doorWant(d int, to bool, by uint32, char string) {
	owner, mine := s.doorOwner(d)
	if mine {
		s.doorSchedule(d, to, by)
		return
	}
	s.sendCtl(owner, ctlMsg{T: ctlDoor, Char: char, Door: s.town.doors.s.D[d].ID, A: doorAct(to), By: by})
}

// doorChanged: the authority's side effects of a change it made (doorSchedule):
// persist it and tell the other zones.
func (s *Server) doorChanged(d int, to bool, by uint32) {
	w := s.town.doors
	w.at[d] = s.cfg.Now()
	if s.cfg.DoorStore != nil {
		w.unsaved[d] = true
	}
	if !s.clusterOn() {
		return
	}
	own := s.cl.c.Owners()
	if own == nil {
		return
	}
	m := ctlMsg{T: ctlDoorSet, Door: w.s.D[d].ID, A: doorAct(to), By: by}
	for id := range own.Zones {
		if id != s.cl.self {
			s.sendCtl(id, m)
		}
	}
}

// doorMirror applies another zone's decision to this zone's players. A
// change still pending here settles first (doorsTick picks it up).
func (s *Server) doorMirror(d int, to bool, by uint32) {
	w := s.town.doors
	if w.pend[d] != nil {
		w.mirror[d] = doorMirrorWant{to: to, by: by}
		return
	}
	if w.open[d] != to {
		s.doorApply(d, to, by)
	}
}

type doorMirrorWant struct {
	to bool
	by uint32
}

// doorCtl handles the door control messages (handleCtl, tick goroutine).
func (s *Server) doorCtl(m ctlMsg) {
	if s.cfg.Towns == nil {
		return
	}
	s.doorsInit()
	w := s.town.doors
	d, ok := w.s.ByProp[m.Door]
	if !ok {
		return
	}
	to := m.A == DoorActOpen
	switch m.T {
	case ctlDoorSet:
		s.doorMirror(d, to, m.By) // (around an ownership change: the newest decision wins)
	case ctlDoor:
		reason := int32(0)
		switch _, mine := s.doorOwner(d); {
		case !mine:
			reason = DoorRefuseBusy // ownership moved mid-flight: ask again
		case w.pend[d] != nil:
			reason = DoorRefuseBusy
		case w.open[d] == to:
			reason = DoorRefuseAlready
		case !to && s.doorBlocked(d):
			reason = DoorRefuseBody
		}
		if reason == 0 {
			s.doorSchedule(d, to, m.By)
			return
		}
		if m.Char != "" {
			s.sendCtl(m.From, ctlMsg{T: ctlDoorNo, Char: m.Char, Door: m.Door, A: int(reason)})
		}
	case ctlDoorNo:
		if sess := s.byChar[m.Char]; sess != nil && sess.ent != nil {
			s.refuseDoor(sess, w.s.D[d].Prop, m.Door, int32(m.A))
		}
	}
}

// flushDoors hands the doors changed since the last flush to the
// write-behind queue as one batch (tick goroutine, or Stop after the tick).
func (s *Server) flushDoors() {
	w := s.town.doors
	if w == nil || len(w.unsaved) == 0 {
		return
	}
	store, q := s.cfg.DoorStore, s.cfg.Queue
	rows := make([]DoorRow, 0, len(w.unsaved))
	for d := range w.unsaved {
		open := w.open[d]
		if p := w.pend[d]; p != nil {
			open = p.to
		}
		rows = append(rows, DoorRow{ID: w.s.D[d].ID, Open: open, At: w.at[d]})
	}
	clear(w.unsaved)
	if store == nil || q == nil {
		return
	}
	w.flushes++
	world, zone := s.cfg.WorldID, s.cfg.ZoneID
	q.Enqueue(writebehind.Op{Key: "doors:" + strconv.FormatUint(w.flushes, 10), Run: func(ctx context.Context) error {
		return store.SaveDoors(ctx, world, zone, rows)
	}})
}

// RestoreDoors loads the persisted door states before the zone starts
// ticking (every zone of the world: the authority for its own doors, the
// others as their starting mirror). Returns the doors not open.
func (s *Server) RestoreDoors(ctx context.Context) (int, error) {
	if s.cfg.DoorStore == nil || s.cfg.Towns == nil {
		return 0, nil
	}
	s.doorsInit()
	rows, err := s.cfg.DoorStore.LoadDoors(ctx, s.cfg.WorldID)
	if err != nil {
		return 0, err
	}
	w := s.town.doors
	closed := 0
	for _, r := range rows {
		d, ok := w.s.ByProp[r.ID]
		if !ok {
			continue // a towns layer without this door (another genVersion)
		}
		w.at[d] = r.At
		if r.Open == w.open[d] {
			continue
		}
		was := !w.settledOpen(d)
		w.open[d] = r.Open
		s.navDoorChanged(d) // enemy pathfinding (obstacles.go)
		w.recount(d, was)
		si := w.s.D[d].Settlement
		w.epoch[si]++
		if w.epoch[si] == 1 {
			w.dirty = append(w.dirty, si) // newcomers get a baseline (971)
		}
		if !r.Open {
			closed++
		}
	}
	return closed, nil
}
