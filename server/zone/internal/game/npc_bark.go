package game

// NPC barks (playtest 4, CR 050, Event 1930): a short line a townsperson
// says out loud, drawn by clients as a speech bubble over the NPC's head
// (client/src/world/buildings/npcFocus.ts). This is the shared seam the
// playtest 4 branches build on: lively townsfolk (ambient greetings, calls
// at dusk), the first hour (a mentor calling a new player over) and dialog.
// Event-driven only: never call it every tick for every NPC.

import (
	"lodestone/server/pkg/proto"
)

// EventNPCBark: entityId = the NPC's entity id, targetId = the entity
// addressed (0 = nobody in particular), value = how long to show it (ms;
// 0 = the client's default), data = UTF-8 text.
const EventNPCBark = 1930

// npcBarkM is how far a bark carries.
const npcBarkM = 30.0

// npcBark makes active NPC i (towns NPC index) say text aloud. to == nil:
// every player within npcBarkM hears it; else only that player (a line meant
// for one person, e.g. calling them by name). Returns false when NPC i is
// not active (no entity: no player near its settlement).
func (s *Server) npcBark(i int, text string, to *Entity, showMs int32) bool {
	ne := s.town.active[i]
	if ne == nil || text == "" {
		return false
	}
	ev := &proto.Event{Kind: EventNPCBark, EntityID: ne.ID, Value: showMs, Data: []byte(text)}
	if to != nil {
		ev.TargetID = to.ID
		s.sendEventTo(to, ev)
		return true
	}
	for _, e := range s.playersNear(ne.Move.Pos.X, ne.Move.Pos.Z, npcBarkM) {
		s.sendEventTo(e, ev)
	}
	return true
}
