package game

// The tick's snapshot phase (WP19). Every client's interest set and delta
// snapshot is built here, in parallel across GOMAXPROCS workers.
//
// Why parallel: at spec 14 scenario 1's size (300 players and 2,000 awake
// enemies in one region) each client's interest is ~2,300 entities, and the
// serial phase alone took ~68 ms of a 100 ms tick on the reference desktop
// (docs/evidence/wp19-*). The work per client is independent: by this point
// the tick has finished mutating the world (entities quantized, grid
// rebuilt, parties and mirrors placed), so workers only READ shared state
// and each writes its own session's encoder and connection queue. The
// output for each client is byte-identical to the serial build regardless
// of which worker builds it; the transport's send path is goroutine-safe.
//
// What the phase reads (and must stay read-only until it ends): s.ents and
// their quantized states (e.q), s.grid, s.parties, s.cl.remote /
// remoteParty, the cave graph and each entity's caveSys. Anything added to
// sendSnapshot later must keep to that rule or move before the phase.
//
// Also WP19, inside one client's build:
//   - interest is gathered into a bitset over entity indices and read back
//     in index order (= id order, s.ents is sorted by id) instead of being
//     sorted: the sort was 20 % of the tick;
//   - mirrored entities (WP16) are sorted by id once per tick (gridRemotes)
//     so they form a second sorted run, merged with the local run;
//   - "does the client already know this entity" walks the previous frame
//     alongside the sorted interest instead of binary-searching it;
//   - distances use Sqrt(dx²+dz²) rather than math.Hypot (equal to within
//     an ulp, at a fraction of the cost; ring edges are not that precise).

import (
	"math"
	"math/bits"
	"runtime"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/snapshot"
	"lodestone/server/zone/internal/aoi"
)

// snapScratch is one snapshot worker's scratch space and metric sums.
type snapScratch struct {
	mark  []uint64 // interest bitset over grid indices (all zero between uses)
	idxs  []int32  // interest, sorted by entity id
	rem   []int32  // mirrored entities in interest (merge scratch)
	loc   []int32  // local entities in interest (merge scratch)
	cands []snapshot.Candidate
	w     proto.Writer
	sum   snapSums
	_     [64]byte // keep workers' hot fields off each other's cache lines
}

type snapSums struct{ near, mid, far, party, maxSet, bytes int64 }

const (
	// snapParallelMin: below this many sessions the phase runs on the tick
	// goroutine (goroutine hand-off costs more than it saves for a few
	// clients, and small zones and most tests stay single-threaded).
	snapParallelMin = 32
	// snapChunk: sessions a worker claims at a time. Small, because the
	// phase waits for its slowest worker: one the OS deschedules while it
	// holds a chunk holds back only that much (live soak: a 49 ms phase with
	// chunks of 8 on the loaded desktop).
	snapChunk = 2
)

// snapshotWorkers is how many goroutines build snapshots (Config, else
// GOMAXPROCS: spec 9's budget is per 4 vCPU zone).
func (s *Server) snapshotWorkers() int {
	n := s.cfg.SnapshotWorkers
	if n <= 0 {
		n = runtime.GOMAXPROCS(0)
	}
	return max(1, n)
}

// sendSnapshots builds and queues every client's snapshot for this tick.
func (s *Server) sendSnapshots(tick uint32, serverTime float64) {
	s.buildViews(tick)
	n := len(s.sessions)
	workers := s.snapshotWorkers()
	if workers > (n+snapChunk-1)/snapChunk {
		workers = (n + snapChunk - 1) / snapChunk
	}
	if n < snapParallelMin || workers < 2 {
		workers = 1
	}
	for len(s.snapScr) < workers {
		s.snapScr = append(s.snapScr, &snapScratch{})
	}
	for _, sc := range s.snapScr[:workers] {
		sc.sum = snapSums{}
	}
	// WP19b: the shared pool (par.go), which returns when every client is
	// done rather than when every helper goroutine has exited.
	parallelFor(n, workers, snapChunk, func(worker, i int) {
		s.sendSnapshot(s.snapScr[worker], s.sessions[i], tick, serverTime)
	})
	var t snapSums
	for _, sc := range s.snapScr[:workers] {
		t.near += sc.sum.near
		t.mid += sc.sum.mid
		t.far += sc.sum.far
		t.party += sc.sum.party
		t.bytes += sc.sum.bytes
		t.maxSet = max(t.maxSet, sc.sum.maxSet)
	}
	s.m.aoiAccum(n, t.near, t.mid, t.far, t.party, t.maxSet, t.bytes)
}

// entView is what a client's interest loop needs from an entity, copied
// once per tick into one array indexed like the grid (s.views), with the
// quantized states alongside (s.qs). WP19: reading these through *Entity
// (big structs scattered over the heap) was a cache miss per candidate per
// client, the largest single cost left in the snapshot phase; the arrays
// are walked in index order, which is id order, so they stream.
type entView struct {
	x, z    float64
	id      uint32
	owner   uint32
	partyID uint32
	kind    proto.EntityKind
	nameID  uint32
	caveSys int32       // cave system this tick (-1 surface): caveVisible only runs when it differs from the viewer's
	rift    uint32      // CR 040: the rift run it is in (0 = the world): only its run sees it
	due     aoi.DueMask // G5: which rings update it this tick (aoi.Due), once per entity instead of per client
	beam    bool        // playtest 2 ground loot: a rare+ pickup whose light beam is seen across the mid ring
}

// buildViews fills s.views and s.qs for every grid index (after the grid
// and mirrors are placed; read-only during the snapshot phase), and opens
// the tick's shared state store (G5: every client's encoder refers to these
// states instead of copying them into its frames; Candidate.Ref = 1 + grid
// index).
func (s *Server) buildViews(tick uint32) {
	n := len(s.ents) + len(s.cl.remote)
	if cap(s.views) < n {
		s.views = make([]entView, n, n+n/4)
		s.qs = make([]snapshot.EntState, n, n+n/4)
	}
	s.views, s.qs = s.views[:n], s.qs[:n]
	put := func(i int, e *Entity) {
		if e.q.Name != e.nameOf { // names rarely change: intern once per entity
			e.nameOf, e.nameID = e.q.Name, snapshot.NameID(e.q.Name)
		}
		s.views[i] = entView{x: e.Move.Pos.X, z: e.Move.Pos.Z, id: e.ID, owner: e.Owner, partyID: e.PartyID, kind: e.Kind, caveSys: int32(e.caveSys), rift: e.riftID, nameID: e.nameID, due: aoi.DueAll(tick, e.ID),
			beam: e.Kind == proto.EntityKindPickup && e.TypeID >= pickupBeamRarity}
		s.qs[i] = e.q
		// Unchanged since when (snapshot.History.Set): a break in the
		// series (new entity, absent last tick) counts as a change.
		if e.histTick+1 != tick || e.histQ != e.q {
			e.histSince = tick
		}
		e.histQ, e.histTick = e.q, tick
		s.hist.Set(i, &s.qs[i], e.nameID, e.histSince)
	}
	s.hist.Begin(tick, n)
	for i, e := range s.ents {
		put(i, e)
	}
	for j, r := range s.cl.remote {
		put(len(s.ents)+j, r)
	}
}

// gridFor is the AOI grid an entity goes in this tick: players (and
// anything with a party id) can be seen 616 m away, everything else only
// within the mid ring (aoi.QueryRadiusOthers), so clients look for those in
// a smaller square. Classify drops the others beyond 200 m anyway: the
// split changes no interest set, only how many entities each client walks.
func (s *Server) gridFor(e *Entity) *aoi.Grid {
	if aoi.FarRing(e.Kind, e.PartyID) {
		return s.grid
	}
	return s.gridOthers
}

// gatherInterest fills sc.idxs with the client's candidate entities (grid
// cells around them, party members anywhere), deduplicated and sorted by
// entity id.
func (s *Server) gatherInterest(sc *snapScratch, e *Entity) {
	nLocal := len(s.ents)
	total := nLocal + len(s.cl.remote)
	words := (total + 63) >> 6
	if cap(sc.mark) < words {
		sc.mark = make([]uint64, words)
	}
	mark := sc.mark[:words]
	s.grid.QueryMark(e.Move.Pos.X, e.Move.Pos.Z, aoi.QueryRadius, mark)
	// G5: the second grid's entities (no players, no party ids) are never
	// in a ring at or beyond QueryRadiusOthers, so the square's corner
	// cells, which cannot hold anything closer, are not walked.
	s.gridOthers.QueryMarkWithin(e.Move.Pos.X, e.Move.Pos.Z, aoi.QueryRadiusOthers, mark)
	self := e.idx
	mark[self>>6] &^= 1 << (uint(self) & 63)
	if e.PartyID != 0 {
		for _, m := range s.parties[e.PartyID] {
			if m != e {
				mark[m.idx>>6] |= 1 << (uint(m.idx) & 63)
			}
		}
		for _, m := range s.cl.remoteParty[e.PartyID] { // WP16: party members on other zones
			mark[m.idx>>6] |= 1 << (uint(m.idx) & 63)
		}
	}
	// Read the bitset back in index order, clearing it for the next client.
	// Local indices are in id order (s.ents is sorted by id); mirrors come
	// after them, sorted by id among themselves (gridRemotes).
	idxs := sc.idxs[:0]
	if len(s.cl.remote) == 0 {
		for wi, wv := range mark {
			for wv != 0 {
				idxs = append(idxs, int32(wi<<6+bits.TrailingZeros64(wv)))
				wv &= wv - 1
			}
			mark[wi] = 0
		}
		sc.idxs = idxs
		return
	}
	loc, rem := sc.loc[:0], sc.rem[:0]
	for wi, wv := range mark {
		for wv != 0 {
			i := int32(wi<<6 + bits.TrailingZeros64(wv))
			if int(i) < nLocal {
				loc = append(loc, i)
			} else {
				rem = append(rem, i)
			}
			wv &= wv - 1
		}
		mark[wi] = 0
	}
	// Merge the two id-sorted runs (equal ids: the local entity first, as
	// the old (id, index) sort did).
	a, b := 0, 0
	for a < len(loc) || b < len(rem) {
		if b >= len(rem) || (a < len(loc) && s.views[loc[a]].id <= s.views[rem[b]].id) {
			idxs = append(idxs, loc[a])
			a++
		} else {
			idxs = append(idxs, rem[b])
			b++
		}
	}
	sc.loc, sc.rem, sc.idxs = loc, rem, idxs
}

// sendSnapshot computes one client's interest set and sends a delta
// snapshot (run by a snapshot worker; see the file comment for what it may
// touch).
func (s *Server) sendSnapshot(sc *snapScratch, sess *session, tick uint32, serverTime float64) {
	e := sess.ent
	px, pz := e.Move.Pos.X, e.Move.Pos.Z
	s.gatherInterest(sc, e)

	known := sess.enc.Known()    // the newest frame's ids, walked alongside the sorted interest
	var count [aoi.Party + 1]int // per ring
	cands := sc.cands[:0]
	if cap(cands) < len(sc.idxs) {
		cands = make([]snapshot.Candidate, 0, len(sc.idxs)+len(sc.idxs)/4)
	}
	cw := s.caves()
	myParty, mySys, myRift := e.PartyID, int32(e.caveSys), e.riftID
	for _, i := range sc.idxs {
		o := &s.views[i]
		if o.rift != myRift {
			continue // CR 040: a rift run is its own instance (rift.go)
		}
		// Personal pickups: only their owner sees them (WP09).
		if o.kind == proto.EntityKindPickup && o.owner != 0 && o.owner != e.ID { // WP14: owner 0 = a dropped item, public
			continue
		}
		sameParty := myParty != 0 && o.partyID == myParty
		// Underground interest clipping (spec 9, WP09 caves.go).
		if cw != nil && o.caveSys != mySys && !sameParty && !s.caveVisible(cw, e, s.entAt(i)) {
			continue
		}
		dx, dz := o.x-px, o.z-pz
		d := math.Sqrt(dx*dx + dz*dz)
		// G5: whether the client knows the entity only matters at the far
		// ring's edge (aoi.UsesKnown), so the newest frame is searched for
		// those few instead of walked for everyone.
		r := aoi.Classify(d, o.kind, aoi.UsesKnown(d, o.kind) && known.Has(o.id), sameParty)
		if r == aoi.None && o.beam && d < constants.RingMidM {
			// Playtest 2 ground loot: rare+ drops stand in a light beam meant
			// to be seen from afar, so they ride the mid ring (pickups are
			// otherwise near-ring only); static, so they cost almost nothing
			// after first sight.
			r = aoi.Mid
		}
		if r == aoi.None {
			continue
		}
		count[r]++
		cands = append(cands, snapshot.Candidate{State: &s.qs[i], Due: o.due.Has(r), Weight: priorityWeight(d, sameParty), NameID: o.nameID, Ref: uint32(i) + 1})
	}
	sc.cands = cands
	near, mid, far, party := count[aoi.Near], count[aoi.Mid], count[aoi.Far], count[aoi.Party]

	// WP19b (decision 0005): reliable traffic queued since the last snapshot
	// (combat events, hit results, inventory, ...) comes out of the same
	// downlink budget, so snapshot + events stay within it.
	if q := sess.conn.Stats().ReliableQueued.Load(); q != sess.relCharged {
		sess.enc.Charge(int(q - sess.relCharged))
		sess.relCharged = q
	}
	st := e.selfState(s.cfg.Ground)
	sess.enc.SetHistory(&s.hist) // G5 (a handoff resets the encoder)
	snap := sess.enc.Build(tick, sess.ackTick, e.LastSeq, serverTime, &st, sc.cands)
	if bs := sess.enc.Stats(); bs != sess.budget {
		s.m.recordsSent.Add(int64(bs.Sent - sess.budget.Sent))
		s.m.recordsDeferred.Add(int64(bs.Deferred - sess.budget.Deferred))
		s.m.budgetCharged.Add(int64(bs.Charged - sess.budget.Charged))
		sess.budget = bs
	}
	sc.w.Reset()
	proto.WriteMessage(&sc.w, snap)
	buf := make([]byte, len(sc.w.B))
	copy(buf, sc.w.B)
	if !sess.conn.SendUnreliable(buf) {
		s.m.snapshotsShed.Add(1)
	}
	sc.sum.near += int64(near)
	sc.sum.mid += int64(mid)
	sc.sum.far += int64(far)
	sc.sum.party += int64(party)
	sc.sum.bytes += int64(len(buf))
	sc.sum.maxSet = max(sc.sum.maxSet, int64(near+mid+far+party))
}
