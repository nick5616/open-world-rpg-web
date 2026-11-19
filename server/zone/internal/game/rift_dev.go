package game

// Dev console /rift (CR 040; Interact 250 action 36): spawn a rift at your
// feet, go straight into chapter c stage s, win the room, leave, list.

import (
	"math"
	"time"

	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/rift"
)

// DevActRift is Interact 250 action 36: arg = DevRift* | chapter << 4 |
// stage << 8.
const DevActRift = 36

// /rift sub-commands.
const (
	DevRiftSpawn = 1 // a rift at your feet (chapter: 0 = by the area)
	DevRiftGo    = 2 // a rift of the chapter at your feet, entered at the stage
	DevRiftWin   = 3 // clear the room you are in
	DevRiftLeave = 4 // walk out of your run (spoils banked, as at a checkpoint)
	DevRiftList  = 5 // the open rifts
)

func (s *Server) devRift(sess *session, m *proto.Interact) (int32, string) {
	s.riftInit()
	e := sess.ent
	sub, chapter, stage := int(m.Arg&0xf), int(m.Arg>>4&0xf), int(m.Arg>>8&0xff)
	switch sub {
	case DevRiftSpawn, DevRiftGo:
		if rr := s.rift.byPlayer[e.ID]; rr != nil && sub == DevRiftGo {
			// already in a run: jump within it (another chapter: leave first)
			if chapter == 0 || chapter == rr.run.Chapter.N {
				rr.run.Goto(max(1, stage), s.tick, &riftHost{s: s, rr: rr})
				return devOK("rift: stage %d of %s", rr.run.Stage, rr.run.Chapter.Name)
			}
			rr.run.Leave(e.ID, rift.LeftDev, &riftHost{s: s, rr: rr})
		}
		if s.rift.byPlayer[e.ID] != nil {
			return devBad("you are in a rift (/rift leave first)")
		}
		a := e.Move.Pos.Y // stand a few metres ahead of yourself
		x, z := e.Move.Pos.X-math.Sin(e.Yaw)*3, e.Move.Pos.Z-math.Cos(e.Yaw)*3
		_ = a
		p := s.newPortal(x, z, s.cfg.Now().Add(rift.WindowS*time.Second), true)
		if chapter >= 1 && chapter <= len(rift.Chapters) {
			ch := rift.ChapterByN(chapter)
			p.Chapter, p.Name, p.Color, p.Level = ch.N, ch.Name, ch.Color, max(p.Level, ch.MinLevel)
		}
		s.rift.portals = append(s.rift.portals, p)
		s.riftSendPortals(nil)
		if sub == DevRiftSpawn {
			return devOK("rift %d: %s (level %d) at %.0f %.0f", p.ID, p.Name, p.Level, p.X, p.Z)
		}
		if msg := s.riftEnter(sess, p.ID, max(1, stage)); msg != "" {
			return devBad("%s", msg)
		}
		rr := s.rift.byPlayer[e.ID]
		return devOK("rift: %s stage %d (level %d)", rr.run.Chapter.Name, rr.run.Stage, rr.run.Level)
	case DevRiftWin:
		rr := s.rift.byPlayer[e.ID]
		if rr == nil {
			return devBad("not in a rift")
		}
		rr.run.Win(s.tick, &riftHost{s: s, rr: rr})
		return devOK("rift: room %d cleared", rr.run.Stage)
	case DevRiftLeave:
		rr := s.rift.byPlayer[e.ID]
		if rr == nil {
			return devBad("not in a rift")
		}
		rr.run.Leave(e.ID, rift.LeftDev, &riftHost{s: s, rr: rr})
		return devOK("left the rift")
	case DevRiftList:
		s.riftSendPortals(sess)
		n := len(s.rift.portals)
		near := ""
		for _, p := range s.rift.portals {
			near += " · " + p.Name + " " + itoa(int(math.Hypot(p.X-e.Move.Pos.X, p.Z-e.Move.Pos.Z))) + " m"
		}
		return devOK("%d rifts open%s", n, near)
	}
	return devBad("rift: spawn [chapter] | go <chapter> <stage> | win | leave | list")
}
