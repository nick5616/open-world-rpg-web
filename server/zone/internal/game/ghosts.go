package game

// Mirrored ("remote") entities (WP16, spec 9): what other zones own but
// this zone's players can see.
//
//   - Ghost band: every zone broadcasts, each tick, its entities within
//     GHOST_BAND_M of a region another zone owns (30 Hz), and within the mid
//     ring (200 m) of one at 10 Hz (an addition to the spec's 64 m: an
//     entity d metres from the border is at least d metres from any player
//     across it, so this covers everything a foreign player can see in the
//     near and mid rings at those rings' own rates).
//   - Far ring: the world presence feed (spec 11 worldpos:{worldId}),
//     every player once a second; it also carries party ids, so the party
//     ring works across zones.
//
// Remote entities live in s.cl.remote, never in s.ents: they are not
// simulated, persisted, checkpointed, targeted or counted here (enemy AI
// and every other per-entity loop keep seeing only what this zone owns).
// They join the AOI grid after the local entities and are sent to clients
// exactly like local ones. Each record is stamped with its source's server
// time and extrapolated along its wire velocity to this zone's tick time,
// so a record that crosses a tick boundary on its way through Redis does
// not show up as a stutter (zones share Unix time as their clock).
//
// A player keeps one entity id world-wide (Cluster.EntityID), so when they
// are handed off, observers on both sides see the same entity go from
// local to mirrored (or back) in one tick: no removal, no first sight.

import (
	"math"
	"slices"
	"time"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

const (
	// ghostFresh: a ghost-band record older than this yields to presence.
	ghostFresh = 600 * time.Millisecond
	// remoteExpire: a remote entity nobody refreshed for this long is gone
	// (presence runs at 1 Hz; two misses and a margin).
	remoteExpire = 3500 * time.Millisecond
	// Extrapolation caps (ms) for ghost and presence records.
	ghostExtrapMs    = 300
	presenceExtrapMs = 1200
	// presenceEvery: spec 11 "every player's position at 1 Hz".
	presenceEvery = time.Second
	// presenceMaxAge: entries older than this (a dead zone's leftovers)
	// are ignored.
	presenceMaxAge = 5 * time.Second
	// presenceGC: entries this old are deleted (zones remove their own on
	// logout; a crashed zone's entries are swept by the survivors).
	presenceGC = time.Minute
)

// remoteInfo is a mirrored entity's source state.
type remoteInfo struct {
	zone      string
	base      ghostRec  // newest record
	ghostAt   time.Time // last ghost-band record (zero: presence only)
	updatedAt time.Time
}

func (s *Server) entAt(i int32) *Entity {
	if int(i) < len(s.ents) {
		return s.ents[i]
	}
	return s.cl.remote[int(i)-len(s.ents)]
}

// addRemoteFrom turns a local entity that just left (transfer, release)
// into a mirror, so observers here keep it with no gap until its new
// owner's ghost records arrive.
func (s *Server) addRemoteFrom(e *Entity, zone string, now time.Time) {
	e.quantize(s.cfg.Ground)
	g := ghostRec{EntState: e.q, T: s.serverTimeMs()}
	s.upsertRemote(zone, g, true, now)
}

func (s *Server) upsertRemote(zone string, g ghostRec, ghost bool, now time.Time) {
	r := s.cl.remoteByID[g.ID]
	if r == nil {
		r = &Entity{ID: g.ID, Kind: g.Kind, remote: &remoteInfo{}}
		s.cl.remoteByID[g.ID] = r
		s.cl.remote = append(s.cl.remote, r)
	} else if g.T <= r.remote.base.T {
		return // older than what we have (two sources around a transfer)
	}
	ri := r.remote
	ri.zone, ri.base, ri.updatedAt = zone, g, now
	if ghost {
		ri.ghostAt = now
	}
	r.Kind, r.Name, r.Level, r.PartyID = g.Kind, g.Name, g.Level, g.PartyID
}

func (s *Server) removeRemote(id uint32) {
	r := s.cl.remoteByID[id]
	if r == nil {
		return
	}
	delete(s.cl.remoteByID, id)
	if i := slices.Index(s.cl.remote, r); i >= 0 {
		s.cl.remote = slices.Delete(s.cl.remote, i, i+1)
	}
}

// applyGhosts takes one zone's ghost frame (tick goroutine).
func (s *Server) applyGhosts(f *ghostFrame, now time.Time) {
	s.cl.stats.ghostsIn.Add(1)
	for i := range f.Recs {
		g := f.Recs[i]
		if s.entityByID(g.ID) != nil {
			continue // ours (a late record from the zone that handed it to us)
		}
		s.upsertRemote(f.Zone, g, true, now)
	}
	for _, id := range f.Gone {
		if r := s.cl.remoteByID[id]; r != nil && r.remote.zone == f.Zone {
			s.removeRemote(id)
		}
	}
}

// applyPresence takes the world presence feed (tick goroutine): far-ring
// players on other zones, only where the ghost band is silent.
func (s *Server) applyPresence(m map[string][]byte, now time.Time) {
	own := s.cl.c.Owners()
	nowMs := s.serverTimeMs()
	for k, b := range m {
		zone, g, err := decodePresence(b)
		if err == nil && nowMs-g.T > float64(presenceGC/time.Millisecond) {
			s.cl.departed = append(s.cl.departed, k) // a dead zone's leftovers: anyone may sweep them
			continue
		}
		if err != nil || zone == s.cl.self || nowMs-g.T > float64(presenceMaxAge/time.Millisecond) {
			continue
		}
		if own != nil {
			if _, live := own.Zones[zone]; !live {
				continue
			}
		}
		if s.cl.presenceChar == nil {
			s.cl.presenceChar = map[string]presenceSeen{}
		}
		s.cl.presenceChar[k] = presenceSeen{pos: movement.Vec3{X: proto.CmToMeters(g.X), Y: proto.CmToMeters(g.Y), Z: proto.CmToMeters(g.Z)}, name: g.Name, t: g.T}
		if s.entityByID(g.ID) != nil {
			continue
		}
		if r := s.cl.remoteByID[g.ID]; r != nil && now.Sub(r.remote.ghostAt) < ghostFresh {
			continue
		}
		s.upsertRemote(zone, g, false, now)
	}
}

// updateRemotes expires stale mirrors and places the rest on this tick's
// clock (extrapolated along their wire velocity).
func (s *Server) updateRemotes(now time.Time) {
	cl := &s.cl
	if len(cl.remote) == 0 && len(cl.remoteParty) == 0 {
		return
	}
	nowMs := s.serverTimeMs()
	clear(cl.remoteParty)
	cw := s.caves()
	kept := cl.remote[:0]
	for _, r := range cl.remote {
		ri := r.remote
		if now.Sub(ri.updatedAt) > remoteExpire {
			delete(cl.remoteByID, r.ID)
			continue
		}
		capMs := float64(presenceExtrapMs)
		if now.Sub(ri.ghostAt) < ghostFresh {
			capMs = ghostExtrapMs
		}
		dt := math.Max(0, math.Min(capMs, nowMs-ri.base.T)) / 1000
		q := ri.base.EntState
		x := proto.CmToMeters(q.X) + proto.CmsToVel(q.Vx)*dt
		z := proto.CmToMeters(q.Z) + proto.CmsToVel(q.Vz)*dt
		q.X, q.Z = proto.MetersToCm(x), proto.MetersToCm(z)
		r.q = q
		r.Move.Pos.X, r.Move.Pos.Y, r.Move.Pos.Z = x, proto.CmToMeters(q.Y), z
		r.caveSys = -1
		if cw != nil {
			r.caveSys = cw.SystemAt(r.Move.Pos.X, r.Move.Pos.Y, r.Move.Pos.Z)
		}
		if r.PartyID != 0 {
			cl.remoteParty[r.PartyID] = append(cl.remoteParty[r.PartyID], r)
		}
		kept = append(kept, r)
	}
	clear(cl.remote[len(kept):])
	cl.remote = kept
	cl.stats.remote.Store(int64(len(kept)))
}

// mirrored reports whether a local entity kind is mirrored to other zones
// (personal pickups and projectiles only matter to this zone's players).
func mirrored(k proto.EntityKind) bool {
	return k != proto.EntityKindPickup && k != proto.EntityKindProjectile
}

// publishGhosts broadcasts this tick's ghost-band records.
func (s *Server) publishGhosts(tick uint32) {
	own := s.cl.c.Owners()
	if own == nil {
		return
	}
	f := ghostFrame{Zone: s.cl.self, Gone: s.cl.gone}
	t := s.serverTimeMs()
	midDiv := uint32(constants.TickRateHz / constants.RateMidHz)
	for _, e := range s.ents {
		if !mirrored(e.Kind) {
			continue
		}
		zone, d := own.NearestForeign(e.Move.Pos.X, e.Move.Pos.Z, s.cl.self)
		switch {
		case zone == "":
			continue
		case d < constants.GhostBandM:
		case d < constants.RingMidM && (tick+e.ID)%midDiv == 0:
		default:
			continue
		}
		f.Recs = append(f.Recs, ghostRec{EntState: e.q, T: t})
	}
	s.cl.gone = s.cl.gone[:0]
	if len(f.Recs) == 0 && len(f.Gone) == 0 {
		return
	}
	b := encodeGhosts(&s.cl.gw, &f)
	select {
	case s.cl.ghostOut <- b:
	default:
		select { // replace the unsent one
		case <-s.cl.ghostOut:
		default:
		}
		select {
		case s.cl.ghostOut <- b:
		default:
		}
	}
}

// publishPresence hands this zone's players to the presence worker once a
// second (it writes them and reads everyone's back).
func (s *Server) publishPresence(now time.Time) {
	if now.Sub(s.cl.presenceAt) < presenceEvery {
		return
	}
	s.cl.presenceAt = now
	t := s.serverTimeMs()
	put := make(map[string][]byte, len(s.sessions))
	for _, sess := range s.sessions {
		if e := sess.ent; e != nil {
			put[e.CharacterID] = encodePresence(s.cl.self, &ghostRec{EntState: e.q, T: t})
		}
	}
	b := presenceBatch{put: put, del: s.cl.departed}
	s.cl.departed = nil
	select {
	case s.cl.presOut <- b:
	default: // the worker is still busy with the last second's batch
		s.cl.departed = b.del
	}
}

// gridRemotes inserts the mirrors into the AOI grid after the local
// entities (grid build in onTick). WP19: mirrors are sorted by id first, so
// their grid indices are a second id-sorted run that each client's
// interest merges with the local one (snapshots.go gatherInterest) instead
// of sorting (id, index) keys per client. Nothing else depends on
// s.cl.remote's order.
func (s *Server) gridRemotes() {
	byID := func(a, b *Entity) int { return cmpU32(a.ID, b.ID) }
	if !slices.IsSortedFunc(s.cl.remote, byID) {
		slices.SortStableFunc(s.cl.remote, byID)
	}
	base := int32(len(s.ents))
	for j, r := range s.cl.remote {
		r.idx = base + int32(j)
		s.gridFor(r).Insert(r.idx, r.Move.Pos.X, r.Move.Pos.Z)
	}
}
