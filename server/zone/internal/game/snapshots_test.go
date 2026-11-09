package game

import (
	"bytes"
	"fmt"
	"math"
	"math/rand"
	"slices"
	"sync"
	"testing"

	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/transport"
	"lodestone/server/zone/internal/aoi"
)

// refInterest is the pre-WP19 interest gathering (grid query minus self,
// party members, mirrored party members, then the (id, index) sort).
// It queries both grids 616 m out, as the single pre-WP19 grid was.
func refInterest(s *Server, e *Entity) []int32 {
	var idxs []int32
	add := func(i int32) {
		if i != e.idx {
			idxs = append(idxs, i)
		}
	}
	s.grid.Query(e.Move.Pos.X, e.Move.Pos.Z, aoi.QueryRadius, add)
	s.gridOthers.Query(e.Move.Pos.X, e.Move.Pos.Z, aoi.QueryRadius, add)
	if e.PartyID != 0 {
		for _, m := range s.parties[e.PartyID] {
			if m != e {
				idxs = append(idxs, m.idx)
			}
		}
		for _, m := range s.cl.remoteParty[e.PartyID] {
			idxs = append(idxs, m.idx)
		}
	}
	keys := make([]uint64, 0, len(idxs))
	for _, i := range idxs {
		keys = append(keys, uint64(s.entAt(i).ID)<<32|uint64(uint32(i)))
	}
	slices.Sort(keys)
	var out []int32
	last := int32(-1)
	for _, k := range keys {
		if i := int32(uint32(k)); i != last {
			out = append(out, i)
			last = i
		}
	}
	return out
}

// TestGatherInterestMatchesReference: the bitset gathering (and the merge
// with id-sorted mirrors) yields exactly the old sorted interest, with
// mirrors whose ids interleave the local ones, parties on both sides and
// players at the world edge.
func TestGatherInterestMatchesReference(t *testing.T) {
	for _, withRemotes := range []bool{false, true} {
		rng := rand.New(rand.NewSource(3))
		s := New(Config{})
		s.cl.remoteByID = map[uint32]*Entity{}
		s.cl.remoteParty = map[uint32][]*Entity{}
		pos := func() (float64, float64) {
			if rng.Intn(10) == 0 {
				return rng.Float64() * 4096, rng.Float64() * 30 // edge row
			}
			return 1500 + rng.NormFloat64()*250, 1500 + rng.NormFloat64()*250
		}
		kinds := []proto.EntityKind{proto.EntityKindPlayer, proto.EntityKindPlayer, proto.EntityKindEnemy, proto.EntityKindNpc, proto.EntityKindPickup, proto.EntityKindProjectile}
		for i := 0; i < 1400; i++ {
			e := &Entity{ID: uint32(2 + 3*i), Kind: kinds[rng.Intn(len(kinds))]}
			e.Move.Pos.X, e.Move.Pos.Z = pos()
			if e.Kind == proto.EntityKindPlayer && rng.Intn(6) == 0 {
				e.PartyID = uint32(1 + rng.Intn(20))
				s.parties[e.PartyID] = append(s.parties[e.PartyID], e)
			}
			s.ents = append(s.ents, e)
		}
		if withRemotes {
			for i := 0; i < 400; i++ {
				r := &Entity{ID: uint32(1 + 3*rng.Intn(1800)), Kind: kinds[rng.Intn(4)], remote: &remoteInfo{}}
				if s.cl.remoteByID[r.ID] != nil {
					continue
				}
				r.Move.Pos.X, r.Move.Pos.Z = pos()
				if r.Kind == proto.EntityKindPlayer && rng.Intn(5) == 0 {
					r.PartyID = uint32(1 + rng.Intn(20))
					s.cl.remoteParty[r.PartyID] = append(s.cl.remoteParty[r.PartyID], r)
				}
				s.cl.remoteByID[r.ID] = r
				s.cl.remote = append(s.cl.remote, r) // unsorted, as upsertRemote appends
			}
		}
		s.grid.Reset()
		s.gridOthers.Reset()
		for i, e := range s.ents {
			e.idx = int32(i)
			s.gridFor(e).Insert(int32(i), e.Move.Pos.X, e.Move.Pos.Z)
		}
		s.gridRemotes()
		s.buildViews(1)
		sc := &snapScratch{}
		// What can end up in a snapshot: Classify with known = true (the
		// widest hysteresis) must keep the same entities in the same order.
		visible := func(e *Entity, idxs []int32) []int32 {
			var out []int32
			for _, i := range idxs {
				o := s.entAt(i)
				d := math.Hypot(o.Move.Pos.X-e.Move.Pos.X, o.Move.Pos.Z-e.Move.Pos.Z)
				if aoi.Classify(d, o.Kind, true, e.PartyID != 0 && o.PartyID == e.PartyID) != aoi.None {
					out = append(out, i)
				}
			}
			return out
		}
		for _, e := range s.ents {
			if e.Kind != proto.EntityKindPlayer {
				continue
			}
			want := visible(e, refInterest(s, e))
			s.gatherInterest(sc, e)
			got := visible(e, sc.idxs)
			if !slices.IsSortedFunc(sc.idxs, func(a, b int32) int { return cmpU32(s.entAt(a).ID, s.entAt(b).ID) }) {
				t.Fatalf("remotes=%v entity %d: interest not sorted by id", withRemotes, e.ID)
			}
			if !slices.Equal(got, want) {
				t.Fatalf("remotes=%v entity %d: interest differs (%d vs %d entries)", withRemotes, e.ID, len(got), len(want))
			}
		}
		for _, w := range sc.mark {
			if w != 0 {
				t.Fatal("bitset not cleared after use")
			}
		}
	}
}

// recConn records every snapshot a client is sent.
type recConn struct {
	benchConn
	mu    sync.Mutex
	snaps [][]byte
	rel   [][]byte
}

func (c *recConn) SendUnreliable(b []byte) bool {
	c.mu.Lock()
	c.snaps = append(c.snaps, b)
	c.mu.Unlock()
	return true
}

// SendReliable records reliable frames too (WP19b: combat events are
// delivered per session on workers, and charged to the snapshot budget).
func (c *recConn) SendReliable(b []byte) error {
	c.mu.Lock()
	c.rel = append(c.rel, b)
	c.mu.Unlock()
	return c.benchConn.SendReliable(b)
}

// TestParallelTickMatchesSerial (WP19b): the whole tick on 4 workers (input
// and movement, combat AI, event delivery, views, snapshots) sends every
// client exactly the bytes, reliable and unreliable, that the one-worker
// tick sends, and leaves every entity in the same place.
func TestParallelTickMatchesSerial(t *testing.T) {
	if testing.Short() {
		t.Skip("scale")
	}
	type out struct {
		snaps, rel [][][]byte
		pos        []string
	}
	run := func(workers int) out {
		w := newScaleWorldConn(t, 90, 600, 160, func() transport.Conn { return &recConn{benchConn: benchConn{done: make(chan struct{})}} })
		w.srv.cfg.SnapshotWorkers = workers
		w.srv.cbt.w.SetParallel(combatParallel, workers)
		for i := 0; i < 300; i++ {
			w.step()
		}
		var o out
		for _, b := range w.bots {
			c := b.sess.conn.(*recConn)
			o.snaps = append(o.snaps, c.snaps)
			o.rel = append(o.rel, c.rel)
		}
		for _, e := range w.srv.ents {
			o.pos = append(o.pos, fmt.Sprintf("%d %v %v %d", e.ID, e.Move.Pos, e.view.Pos, e.Health))
		}
		return o
	}
	serial, par := run(1), run(4)
	if !slices.Equal(serial.pos, par.pos) {
		t.Fatal("entity states differ between 1 and 4 workers")
	}
	for i := range serial.snaps {
		for name, pair := range map[string][2][][]byte{"snapshot": {serial.snaps[i], par.snaps[i]}, "reliable": {serial.rel[i], par.rel[i]}} {
			a, b := pair[0], pair[1]
			if len(a) != len(b) {
				t.Fatalf("client %d: %d vs %d %s frames", i, len(a), len(b), name)
			}
			for k := range a {
				if !bytes.Equal(a[k], b[k]) {
					ma, _ := proto.DecodeMessage(a[k])
					mb, _ := proto.DecodeMessage(b[k])
					t.Fatalf("client %d %s frame %d differs:\n 1 worker: %+v\n4 workers: %+v", i, name, k, ma, mb)
				}
			}
		}
	}
	reliable := 0
	for _, r := range serial.rel {
		reliable += len(r)
	}
	if reliable < 90*5 {
		t.Fatalf("too few reliable frames (%d) to compare", reliable)
	}
}

// TestParallelSnapshotsMatchSerial: building snapshots on 4 workers sends
// every client exactly the bytes the serial build sends, tick by tick, in a
// crowd with enemies (combat AI, spawns, deaths in view).
func TestParallelSnapshotsMatchSerial(t *testing.T) {
	if testing.Short() {
		t.Skip("scale")
	}
	run := func(workers int) [][][]byte {
		w := newScaleWorldConn(t, 80, 400, 200, func() transport.Conn { return &recConn{benchConn: benchConn{done: make(chan struct{})}} })
		w.srv.cfg.SnapshotWorkers = workers
		for i := 0; i < 240; i++ {
			w.step()
		}
		var out [][][]byte
		for _, b := range w.bots {
			out = append(out, b.sess.conn.(*recConn).snaps)
		}
		return out
	}
	serial, par := run(1), run(4)
	for i := range serial {
		if len(serial[i]) != len(par[i]) {
			t.Fatalf("client %d: %d vs %d snapshots", i, len(serial[i]), len(par[i]))
		}
		for k := range serial[i] {
			if !bytes.Equal(serial[i][k], par[i][k]) {
				t.Fatalf("client %d snapshot %d differs", i, k)
			}
		}
	}
}
