package game

// Playtest 5 (CR 055): the journal's Info tab lists the services of a town
// you have discovered, each with "Mark on map" and "Guide me". Marking is an
// Interact (the client cannot send a pin's name; the zone knows the town and
// the service, so it names the pin itself and checks the place is really in
// that town).

import (
	"math"

	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/explore"
)

const (
	// InteractPlacePin: targetId = PackPinPos (x cm | z cm << 32) of the place; Action ActionPlaceService.
	InteractPlacePin = 185
	// ActionPlaceService: arg = the town's settlement index (low 16 bits) | service kind << 16.
	ActionPlaceService = 1
	// EventPlaceMarked: to you, a service pin was placed (or was already there): the pin slot, x / z cm, the label.
	EventPlaceMarked = 1980
	// EventPlaceRefused: to you, an Interact 185 was refused: value = reason.
	EventPlaceRefused = 1981

	// placePinSlackM: a service may stand this far outside the settlement's radius (the forge or the board
	// at the edge, a stable yard beyond the last house).
	placePinSlackM = 160
	// placePinNearM: a shrine or a tower "near" the town is listed up to this far from its centre.
	placePinNearM = 900
)

// Service kinds (the client's ui/quests/townInfo.ts SERVICE_KINDS, same order, from 1).
var serviceLabels = map[uint8]string{
	1: "Stables",
	2: "Smith",
	3: "Inn",
	4: "Storage",
	5: "Shrine",
	6: "Tower",
	7: "Bounty board",
	8: "Merchant",
}

// Refusals of Interact 185.
const (
	placeNoTown    = 1 // no such town
	placeFar       = 2 // the place is not in that town
	placeBadKind   = 3 // not a service kind
	placeNoExplore = 4 // no exploration state (offline zone)
)

// servicePinLabel is "Stables, Kudrogair".
func servicePinLabel(kind uint8, town string) string {
	l, ok := serviceLabels[kind]
	if !ok {
		return ""
	}
	return l + ", " + town
}

func (s *Server) placePinInteract(sess *session, m *proto.Interact) {
	refuse := func(why int32) {
		s.sendEvent(sess, &proto.Event{Kind: EventPlaceRefused, EntityID: sess.ent.ID, Value: why})
	}
	if m.Action != ActionPlaceService {
		return
	}
	if sess.x == nil || s.cfg.Explore == nil {
		refuse(placeNoExplore)
		return
	}
	si := int(m.Arg & 0xffff)
	kind := uint8(m.Arg >> 16)
	w := s.cfg.Towns
	if w == nil || si < 0 || si >= len(w.T.Settlements) {
		refuse(placeNoTown)
		return
	}
	label := servicePinLabel(kind, s.settlementName(si))
	if label == "" {
		refuse(placeBadKind)
		return
	}
	xc, zc, ok := explore.UnpackPinPos(m.TargetID, s.cfg.Explore.Atlas.WorldSize)
	st := &w.T.Settlements[si]
	reach := float64(st.Radius) + placePinSlackM
	if kind == 5 || kind == 6 {
		reach = placePinNearM
	}
	if !ok || math.Hypot(float64(xc)/100-st.X, float64(zc)/100-st.Z) > reach {
		refuse(placeFar)
		return
	}
	if note := s.placePin(sess, xc, zc, label, EventPlaceMarked); note == "Already on your map." {
		// Say so with the same event, so the client can still point the wisp at it.
		s.sendEvent(sess, &proto.Event{Kind: EventPlaceMarked, EntityID: sess.ent.ID, TargetID: 255, X: xc, Z: zc, Data: []byte(label)})
	}
}
