package game

// Party travel and respawns (playtest 2 co-op polish). The two-player
// playthrough found friends 3 km apart for two reasons: fast travel only
// went to crystals you climbed yourself (a story step one friend did for
// both left the other walking 3 km), and each player woke at their own last
// waypoint after a death (Teiraben and Craidath, 2.4 km apart). Now:
//
//   - A party member on this zone who unlocked a tower lends it: you may fast
//     travel to it too (Event 609 lists them for the map; the server checks
//     again on the request).
//   - Respawning in a party: the respawn point (waypoint stone or tower top)
//     that you or a party member on this zone unlocked, nearest the friend
//     who is still up (none within 250 m of them: 45 m from them, outside the
//     Heartfall's arena); if nobody is up (a wipe), nearest where you fell. A
//     camp bedroll still wins. Alone: your last waypoint, as before.

import (
	"bytes"
	"math"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/explore"
)

// EventPartyTowers (609): the towers your party members on this zone have
// unlocked that you have not: `value` = how many, `data` = u8 version(1) |
// u16 n + n bytes bitset (bit i = atlas site i, LSB first). Sent when it
// changes (and once with an empty set when it empties).
const EventPartyTowers = 609

// partyTowersEveryTicks: how often each player's lent towers are checked.
const partyTowersEveryTicks = 45

// partyMates are the other members of e's party on this zone.
func (s *Server) partyMates(e *Entity) []*Entity {
	if e == nil || e.PartyID == 0 {
		return nil
	}
	var out []*Entity
	for _, o := range s.parties[e.PartyID] {
		if o != e && o.x != nil {
			out = append(out, o)
		}
	}
	return out
}

// partyTowers: towers a party member on this zone unlocked and e did not.
func (s *Server) partyTowers(e *Entity) explore.Bitset {
	w := s.cfg.Explore
	if w == nil || e == nil || e.x == nil {
		return nil
	}
	out := make(explore.Bitset, (w.SiteCount()+7)/8)
	n := 0
	for _, o := range s.partyMates(e) {
		for i, b := range o.x.prog.Towers {
			if i >= len(out) {
				break
			}
			mine := byte(0)
			if i < len(e.x.prog.Towers) {
				mine = e.x.prog.Towers[i]
			}
			if add := b &^ mine &^ out[i]; add != 0 {
				out[i] |= add
				n++
			}
		}
	}
	if n == 0 {
		return nil
	}
	return out
}

// partyLends reports whether a party member lends e the tower at site.
func (s *Server) partyLends(e *Entity, site int) bool {
	if _, ok := s.cfg.Explore.TowerOfSite(site); !ok {
		return false
	}
	return s.partyTowers(e).Has(site)
}

// partyTowersTick sends Event 609 to a player whose lent towers changed.
func (s *Server) partyTowersTick(tick uint32) {
	if s.cfg.Explore == nil {
		return
	}
	for _, sess := range s.sessions {
		e := sess.ent
		if e == nil || e.x == nil || (tick+e.ID)%partyTowersEveryTicks != 0 {
			continue
		}
		b := s.partyTowers(e)
		if bytes.Equal(b, e.x.partySent) && (b != nil || e.x.partySentOnce) {
			continue
		}
		e.x.partySent, e.x.partySentOnce = b, true
		s.sendEvent(sess, &proto.Event{Kind: EventPartyTowers, EntityID: e.ID, Value: int32(b.Count()), Data: encodePartyTowers(b)})
	}
}

func encodePartyTowers(b explore.Bitset) []byte {
	out := []byte{1, byte(len(b)), byte(len(b) >> 8)}
	return append(out, b...)
}

// partyRespawn is where a player in a party wakes (ok=false: not in a
// party with anyone on this zone, or no unlocked point at all).
func (s *Server) partyRespawn(e *Entity) (movement.Vec3, bool) {
	w := s.cfg.Explore
	mates := s.partyMates(e)
	if w == nil || e.x == nil || len(mates) == 0 {
		return movement.Vec3{}, false
	}
	anchor, up := e.Move.Pos, false
	best := math.Inf(1)
	for _, o := range mates {
		if o.cbt != nil && o.cbt.Downed {
			continue
		}
		if d := math.Hypot(o.Move.Pos.X-e.Move.Pos.X, o.Move.Pos.Z-e.Move.Pos.Z); d < best {
			best, anchor, up = d, o.Move.Pos, true
		}
	}
	sets := []*explore.Progress{e.x.prog}
	for _, o := range mates {
		sets = append(sets, o.x.prog)
	}
	var at movement.Vec3
	bestD, found := math.Inf(1), false
	for site := 0; site < w.SiteCount(); site++ {
		known := false
		for _, p := range sets {
			if p.Waypoints.Has(site) || p.Towers.Has(site) {
				known = true
				break
			}
		}
		if !known {
			continue
		}
		p, ok := w.Destination(site)
		if !ok {
			continue
		}
		if d := math.Hypot(p.X-anchor.X, p.Z-anchor.Z); d < bestD {
			bestD, at, found = d, p, true
		}
	}
	// No point near the friend who is up (new characters who have touched
	// no stone, a fight far from any): wake within sight of them instead,
	// partyNearM away (outside a story arena), not half a map off. Second
	// two-player run: a fresh pair downed at the sanctum woke 2.1 km away
	// at the world spawn.
	if up && (!found || bestD > partyPointM) {
		if p, ok := s.besideFriend(anchor, e.Move.Pos); ok {
			return p, true
		}
	}
	return at, found
}

const (
	partyPointM = 250.0 // a respawn point this near the friend will do
	partyNearM  = 45.0  // else this far from them
)

// besideFriend: dry walkable ground partyNearM from the friend at f, on the
// side you fell (or away from the Heartfall's arena when they are in it).
func (s *Server) besideFriend(f, fell movement.Vec3) (movement.Vec3, bool) {
	if s.cbt.w == nil {
		return movement.Vec3{}, false
	}
	cx, cz, dist := f.X, f.Z, partyNearM // around the friend, toward where you fell
	dx, dz := fell.X-f.X, fell.Z-f.Z
	if p := s.storyPlaces(); p != nil && p.Heartfall.OK && s.storyArenaAt(f.X, f.Z) {
		// Just outside the Hush's arena, on the friend's side of it.
		cx, cz, dist = p.Heartfall.X, p.Heartfall.Z, p.Heartfall.R+storyArenaMarginM+5
		dx, dz = f.X-cx, f.Z-cz
	}
	if l := math.Hypot(dx, dz); l > 1e-6 {
		dx, dz = dx/l, dz/l
	} else {
		dx, dz = 1, 0
	}
	x, z := s.cbt.w.WalkableNear(cx+dx*dist, cz+dz*dist, 24, 2)
	return movement.Vec3{X: x, Y: s.cfg.Ground.HeightAt(x, z), Z: z}, true
}
