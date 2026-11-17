package game

// The dwarves and the cave dressing (CR 043, genVersion 4): discovery of the
// dwarven halls (Event 1860), cave chests (Interact 170, Event 1861) and
// lore tablets (Interact 171, Event 1862). The halls themselves are
// ordinary Underground settlements (towns buffer), so townsfolk, shops,
// boards, forges, inns and waypoints are the towns machinery; the packs,
// safe zones and warden are in vertical.go (addLayerGroups).

import (
	"math"
	"time"

	"lodestone/server/pkg/caves"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/vertical"
)

// Event kinds and Interact targets (contracts/events.md 1860-1879).
const (
	EventDwarfDiscover = 1860 // TargetID settlement site, Value 0 camp / 1 stronghold, X/Y/Z the door (cm)
	EventChestOpened   = 1861 // TargetID descriptor deco index, Value tier (0 empty / refilling)
	EventLoreTablet    = 1862 // TargetID deco index, Value lore id, Data UTF-8 text
	EventLowerHalls    = 1863 // TargetID lower_halls site, Value 0 the warden wakes / 1 the warden falls

	InteractCaveChest  = 170
	InteractLoreTablet = 171

	chestCooldown = 20 * time.Minute
	chestReachM   = 6.0
)

// loreLines are the tablets' words (the deco's aux picks one).
var loreLines = []string{
	"Here Korhald first struck the seam, and the hill sang back. We keep the song in the walls.",
	"Count the carts: nine went down, eight came up. We do not speak of the ninth.",
	"The Deep Road is cut one pace a day. Ask no more of a dwarf than of a mountain.",
	"A secret kept by many is a lock with many keys. Share the door, not the door's place.",
	"Silver is for kings and starmetal for the dead. Iron is for everyone, and iron wins.",
	"The glow in the ceiling is not stars. It is only worms. Tell the children it is stars.",
	"Beneath the Lower Halls the old forge still burns. It was never lit by us.",
	"Mind the supports. A timber that creaks is a friend; a timber that is silent has already decided.",
	"The warden was a smith once. He would not leave his anvil when the roof fell. He has not left it since.",
	"Every stronghold has a throne. Every throne has a door behind it. Dwarves sit facing the door.",
	"Crystal grows where the water is patient. Dwarves grow where the stone is.",
	"Lanterns first, then picks. A dwarf in the dark is only a short, angry rock.",
}

// decoAt is descriptor decoration i, if it has the kind and the interact flag.
func (s *Server) decoAt(i uint32, kind int) (*vertical.Deco, bool) {
	vw := s.vertical()
	if vw == nil || int(i) >= len(vw.Vertical().Decos) {
		return nil, false
	}
	d := &vw.Vertical().Decos[i]
	if d.Kind != kind || d.Flags&vertical.FlagInteract == 0 {
		return nil, false
	}
	return d, true
}

func nearDeco(p movement.Vec3, d *vertical.Deco) bool {
	return math.Hypot(p.X-d.X, p.Z-d.Z) <= chestReachM && math.Abs(p.Y-d.Y) <= 4
}

// caveInteract handles Interact 170 (cave chest) and 171 (lore tablet).
func (s *Server) caveInteract(sess *session, m *proto.Interact) {
	e := sess.ent
	p := e.Move.Pos
	switch m.TargetKind {
	case InteractCaveChest:
		d, ok := s.decoAt(uint32(m.TargetID), vertical.DecoChest)
		if !ok || !nearDeco(p, d) {
			return
		}
		now := s.cfg.Now()
		if s.chestOpened == nil {
			s.chestOpened = map[uint32]time.Time{}
		}
		id := uint32(m.TargetID)
		if t, ok := s.chestOpened[id]; ok && now.Sub(t) < chestCooldown {
			s.sendEvent(sess, &proto.Event{Kind: EventChestOpened, EntityID: e.ID, TargetID: id, Value: 0, X: cm(d.X), Y: cm(d.Y), Z: cm(d.Z)})
			return
		}
		s.chestOpened[id] = now
		tier := min(3, max(1, d.Tint))
		s.chestLoot(e, d, id, tier, now)
		s.sendEvent(sess, &proto.Event{Kind: EventChestOpened, EntityID: e.ID, TargetID: id, Value: int32(tier), X: cm(d.X), Y: cm(d.Y), Z: cm(d.Z)})
	case InteractLoreTablet:
		d, ok := s.decoAt(uint32(m.TargetID), vertical.DecoTablet)
		if !ok || !nearDeco(p, d) {
			return
		}
		lore := d.Aux % len(loreLines)
		s.sendEvent(sess, &proto.Event{Kind: EventLoreTablet, EntityID: e.ID, TargetID: uint32(m.TargetID), Value: int32(lore), X: cm(d.X), Y: cm(d.Y), Z: cm(d.Z), Data: []byte(loreLines[lore])})
		s.dwarfTabletRead(sess, uint32(m.TargetID))
	}
}

// chestLoot rolls a chest's contents (a seeded roll per chest opening and
// player): gold, ore, a gem, a potion; the tier raises every part.
func (s *Server) chestLoot(e *Entity, d *vertical.Deco, id uint32, tier int, now time.Time) {
	seed := mix64(s.cfg.Seed ^ mix64(uint64(id)<<8|uint64(tier)) ^ uint64(now.UnixNano()) ^ hashString(e.CharacterID))
	u := func(k uint64) float64 { return unit(mix64(seed ^ k*0x9E3779B97F4A7C15)) }
	type drop struct {
		item string
		qty  int
	}
	gold := []int{8, 28, 70}[tier-1]
	drops := []drop{{"currency:gold", gold + int(u(1)*float64(gold))}}
	ores := [][]string{{"ore:copper", "ore:iron"}, {"ore:iron", "ore:silver"}, {"ore:silver", "ore:starmetal", "ore:iron"}}[tier-1]
	drops = append(drops, drop{ores[int(u(2)*float64(len(ores)))%len(ores)], 1 + tier + int(u(3)*2)})
	gems := []string{"ruby", "sapphire", "topaz", "emerald", "aquamarine", "sunstone", "onyx", "amethyst", "opal", "moonstone"}
	if u(4) < 0.3+0.2*float64(tier) {
		cut := "rough"
		if u(5) < 0.1*float64(tier) {
			cut = "cut"
		}
		drops = append(drops, drop{"gem:" + gems[int(u(6)*float64(len(gems)))%len(gems)] + ":" + cut, 1})
	}
	if u(7) < 0.25 {
		drops = append(drops, drop{"potion:health", 1})
	}
	for k, dr := range drops {
		v := caves0(d, k, len(drops))
		sd := mix64(seed ^ uint64(k+1))
		pk := s.spawnPickup(e, v, dr.item, dr.qty, sd, now)
		s.sendEventTo(e, &proto.Event{Kind: EventDropSpawned, EntityID: pk.ID, TargetID: e.ID, Value: int32(dr.qty), Data: []byte(dr.item)})
	}
	s.log.Info("cave chest", "deco", id, "tier", tier, "character", e.CharacterID, "drops", len(drops))
	_ = constants.PickupDespawnS
}

// dwarfHall: site i is a dwarven settlement or door; returns the settlement
// site and whether it is a stronghold.
func (s *Server) dwarfHall(site int) (hall int, stronghold bool, ok bool) {
	w := s.cfg.Explore
	if w == nil || site < 0 || site >= len(w.Atlas.Sites) {
		return 0, false, false
	}
	st := &w.Atlas.Sites[site]
	if st.Layer != vertical.LayerUnder {
		return 0, false, false
	}
	switch {
	case st.Category == structures.CategorySettlement:
		return site, st.Size >= 2, true
	case st.Category == structures.CategoryPOI && st.Kind == structures.POIDwarfDoor && st.Link >= 0 && st.Link < len(w.Atlas.Sites):
		h := &w.Atlas.Sites[st.Link]
		return st.Link, h.Size >= 2, true
	}
	return 0, false, false
}

// announceDwarves: discovering a dwarven hall or its door sends Event 1860
// once per session and hall (called from announce).
func (s *Server) announceDwarves(sess *session, site int) {
	hall, hold, ok := s.dwarfHall(site)
	if !ok {
		return
	}
	key := uint64(sess.ent.ID)<<32 | uint64(hall)
	if s.dwarfSeen == nil {
		s.dwarfSeen = map[uint64]bool{}
	}
	if s.dwarfSeen[key] {
		return
	}
	s.dwarfSeen[key] = true
	st := &s.cfg.Explore.Atlas.Sites[hall]
	v := int32(0)
	if hold {
		v = 1
	}
	s.sendEvent(sess, &proto.Event{Kind: EventDwarfDiscover, EntityID: sess.ent.ID, TargetID: uint32(hall), Value: v, X: cm(st.X), Y: cm(st.Y), Z: cm(st.Z), Data: []byte(st.Name)})
}

// caves0 is a pseudo-vein at a chest, so its loot pops out through the
// vein pickup path (spreading the k-th of n around it).
func caves0(d *vertical.Deco, k, n int) caves.Vein {
	a := 2 * math.Pi * float64(k) / float64(max(n, 1))
	return caves.Vein{X: d.X, Y: d.Y + 0.4, Z: d.Z, NX: math.Cos(a), NZ: math.Sin(a)}
}

// dwarfTabletRead: quest hook for "lost tablets" (quests.go objective).
func (s *Server) dwarfTabletRead(sess *session, deco uint32) {}
