package game

// Lively townsfolk, zone side (playtest 4, CR 050). Everything here is
// event-driven: the clocks and the weather already tick, these hang off the
// moments they change.
//
//   - Dusk (night.go dusk, once per night): in every settlement a player is
//     near, a guard (the innkeeper in towns without one) calls "Lanterns!" /
//     "Gates!" as a speech bubble (Event 1930, npcBark), and larger
//     settlements toll their bell (Event 1931) for everyone within earshot.
//   - Rain (townsTick, each activation round): villagers and farmers go
//     indoors, see npc/life.go.

import (
	"math"

	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/towns"
	"lodestone/server/zone/internal/npc"
)

// EventTownBell: a settlement's bell tolls at dusk. x/z = the square (cm),
// value = strokes; heard within townBellM.
const EventTownBell = 1931

const (
	townBellM       = 160.0 // how far the bell carries (the client spatialises it)
	townBellStrokes = 3
)

// townsDusk is called once when night falls (night.go dusk): a call at the
// gate and the bell, per settlement that has a player near.
func (s *Server) townsDusk(idx int64) {
	w := s.cfg.Towns
	if w == nil {
		return
	}
	s.townsInit()
	t := &s.town
	if t.duskCalled == nil {
		t.duskCalled = map[int]int64{}
	}
	for si := range w.T.Settlements {
		st := &w.T.Settlements[si]
		if last, ok := t.duskCalled[si]; ok && last == idx {
			continue // once per town per evening
		}
		ears := s.playersNear(st.X, st.Z, st.Radius+townBellM)
		if len(ears) == 0 {
			continue
		}
		t.duskCalled[si] = idx
		// The caller: the first active guard, else the innkeeper.
		caller := -1
		for i := st.NPCFirst; i < st.NPCFirst+st.NPCs && caller < 0; i++ {
			if w.T.NPCs[i].Role == towns.RoleGuard && t.active[i] != nil {
				caller = i
			}
		}
		for i := st.NPCFirst; i < st.NPCFirst+st.NPCs && caller < 0; i++ {
			if w.T.NPCs[i].Role == towns.RoleInnkeeper && t.active[i] != nil {
				caller = i
			}
		}
		if caller >= 0 {
			s.npcBark(caller, npc.DuskLine(si, idx), nil, 0)
		}
		if st.Size >= 1 { // villages and towns have a bell
			ev := &proto.Event{Kind: EventTownBell, Value: townBellStrokes, X: int32(math.Round(st.X * 100)), Y: int32(math.Round(st.Y * 100)), Z: int32(math.Round(st.Z * 100))}
			for _, e := range ears {
				s.sendEventTo(e, ev)
			}
		}
	}
}
