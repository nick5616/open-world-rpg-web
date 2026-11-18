package game

// Playtest 5 town life (CR 054): petting the town dogs and cats. The animals
// are client-side and deterministic per settlement (client/src/world/
// buildings/animalsPlan.ts), so the zone knows none of them: Interact 183
// names one by its key (settlement index << 8 | its index in that
// settlement's plan), the zone checks the PLAYER (on the ground, not
// mounted, not downed or in a fight, inside that settlement's radius plus a
// margin, not spamming) and tells the players within animalPetSeeM (Event 1970) so
// their clients pose the petter and bring their own copy of the animal over.
// Cosmetic: nothing is saved, nothing is granted.

import (
	"math"
	"time"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

// Interact 183 `pet_animal`.
const (
	InteractPetAnimal = 183

	PetActStart = 1
	PetActStop  = 2
)

// Events 1970-1971 (contracts/events.md, range 1970-1979).
const (
	EventAnimalPet        = 1970
	EventAnimalPetRefused = 1971
)

// Refusals (Event 1971 value).
const (
	PetRefuseMounted  = 1
	PetRefuseCombat   = 2
	PetRefuseTooFast  = 3
	PetRefuseNoTown   = 4
	PetRefuseNotOnGnd = 5
)

const (
	animalPetSeeM      = 48.0
	petTownSlack = 40.0 // metres beyond a settlement's radius an animal can wander to
	petEvery     = 1200 * time.Millisecond
	petCombatS   = 20
)

// animalKey packs a settlement index and an animal's index in its plan.
func animalKey(si, idx int) uint32 { return uint32(si)<<8 | uint32(idx&0xff) }

// splitAnimalKey is animalKey's inverse.
func splitAnimalKey(k uint32) (si, idx int) { return int(k >> 8), int(k & 0xff) }

// petFacts is what decides whether a petting may start.
type petFacts struct {
	onGround bool
	riding   bool
	hurt     bool // downed or in a fight lately
	spamming bool
	inTown   bool
}

// petRefusal is 0 when the petting may start, else the Event 1971 reason.
func petRefusal(f petFacts) int32 {
	switch {
	case f.riding:
		return PetRefuseMounted
	case f.hurt:
		return PetRefuseCombat
	case !f.onGround:
		return PetRefuseNotOnGnd
	case f.spamming:
		return PetRefuseTooFast
	case !f.inTown:
		return PetRefuseNoTown
	}
	return 0
}

// animalPetInteract applies Interact 183 (tick goroutine).
func (s *Server) animalPetInteract(sess *session, m *proto.Interact, now time.Time) {
	e := sess.ent
	if e == nil {
		return
	}
	key := uint32(m.TargetID)
	switch m.Action {
	case PetActStart:
		si, _ := splitAnimalKey(key)
		inTown := false
		if w := s.cfg.Towns; w != nil && si >= 0 && si < len(w.T.Settlements) {
			st := &w.T.Settlements[si]
			inTown = math.Hypot(e.Move.Pos.X-st.X, e.Move.Pos.Z-st.Z) <= st.Radius+petTownSlack
		}
		hurt := false
		if e.cbt != nil && s.cbt.w != nil {
			hurt = e.cbt.Downed || e.cbt.InCombatWithin(s.cbt.w.Tick(), petCombatS)
		}
		if why := petRefusal(petFacts{
			onGround: e.Move.Mode == movement.ModeGround,
			riding:   e.TypeID&TypeRiding != 0,
			hurt:     hurt,
			spamming: !sess.petAt.IsZero() && now.Sub(sess.petAt) < petEvery,
			inTown:   inTown,
		}); why != 0 {
			s.sendEvent(sess, &proto.Event{Kind: EventAnimalPetRefused, EntityID: e.ID, TargetID: key, Value: why})
			return
		}
		sess.petAt = now
		sess.petOn = true
		sess.petKey = key
		s.animalPetTell(e, key, 1)
	case PetActStop:
		if sess.petOn {
			k := sess.petKey
			sess.petOn = false
			s.animalPetTell(e, k, 0)
		}
	}
}

// animalPetTell sends Event 1970 to every player within animalPetSeeM of e but e.
func (s *Server) animalPetTell(e *Entity, key uint32, value int32) {
	p := e.Move.Pos
	ev := &proto.Event{Kind: EventAnimalPet, EntityID: e.ID, TargetID: key, Value: value, X: cm(p.X), Y: cm(p.Y), Z: cm(p.Z)}
	for _, o := range s.playersNear(p.X, p.Z, animalPetSeeM) {
		if o != e {
			s.sendEventTo(o, ev)
		}
	}
}
