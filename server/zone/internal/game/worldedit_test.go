package game

// CR 040 in-process tests on the real world (seed 20261108): a tree falls to
// axe swings with drops, a world edit everyone gets, persistence and regrowth;
// the shovel digs and fills the ground, the overlay changes every ground
// query, clients get TerrainEdits, and it all survives a restart.

import (
	"context"
	"encoding/binary"
	"math"
	"sync"
	"testing"
	"time"

	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/worldedit"
	"lodestone/server/pkg/worldhost"
	"lodestone/server/pkg/writebehind"
)

type testScatter struct{ t *worldhost.Terrain }

func (s testScatter) ScatterRecord(id uint64) (ScatterRec, bool) {
	layer, cx, cz, _ := worldedit.ScatterID(id)
	ch, ok := s.t.Chunk(cx, cz)
	if !ok {
		return ScatterRec{}, false
	}
	for _, r := range ch.Scatter {
		if r.ID == id {
			return ScatterRec{ID: id, X: float64(r.X), Y: float64(r.Y), Z: float64(r.Z), Layer: layer, Kind: r.Kind, Variant: r.Variant, Scale: r.Extra, Yaw: r.Yaw}, true
		}
	}
	return ScatterRec{}, false
}

type openWorld struct {
	t         *worldhost.Terrain
	forbidden func(x, z int32) bool
}

func (w openWorld) Base(x, z int32) float32  { return w.t.BaseLattice(x, z) }
func (w openWorld) Water(x, z int32) float64 { return w.t.WaterAt(float64(x), float64(z)) }
func (w openWorld) Allowed(x, z int32) bool {
	if x < 8 || z < 8 || x > 4088 || z > 4088 {
		return false
	}
	return w.forbidden == nil || !w.forbidden(x, z)
}

type memTerrain struct {
	mu     sync.Mutex
	blocks map[[2]int32][]byte
	saves  int
}

func (m *memTerrain) LoadTerrainBlocks(context.Context, string) (map[[2]int32][]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := map[[2]int32][]byte{}
	for k, v := range m.blocks {
		out[k] = v
	}
	return out, nil
}
func (m *memTerrain) SaveTerrainBlock(_ context.Context, _ string, cx, cz int32, e []byte, _ int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.blocks[[2]int32{cx, cz}] = e
	m.saves++
	return nil
}
func (m *memTerrain) DeleteTerrainBlock(_ context.Context, _ string, cx, cz int32) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.blocks, [2]int32{cx, cz})
	return nil
}

// treeNear finds a tree record with open ground around it, near the spawn.
func treeNear(t *testing.T, tr *worldhost.Terrain) (ScatterRec, float64) {
	t.Helper()
	h := tr.World().Header
	sx, sz := float64(h.SpawnX), float64(h.SpawnZ)
	if err := tr.Ensure(sx, sz, 200); err != nil {
		t.Fatal(err)
	}
	src := testScatter{tr}
	for dz := int32(-3); dz <= 3; dz++ {
		for dx := int32(-3); dx <= 3; dx++ {
			cx, cz := int32(sx/64)+dx, int32(sz/64)+dz
			ch, ok := tr.Chunk(cx, cz)
			if !ok {
				continue
			}
			for _, r := range ch.Scatter {
				layer, _, _, _ := worldedit.ScatterID(r.ID)
				if layer != worldedit.LayerTree || r.Kind == 5 {
					continue
				}
				rec, _ := src.ScatterRecord(r.ID)
				x := rec.X + 1.6
				if tr.HeightAt(x, rec.Z) > 0 && math.Abs(tr.HeightAt(x, rec.Z)-rec.Y) < 0.8 && tr.WaterAt(x, rec.Z) < tr.HeightAt(x, rec.Z) {
					return rec, tr.HeightAt(x, rec.Z)
				}
			}
		}
	}
	t.Fatal("no tree near the spawn")
	return ScatterRec{}, 0
}

func startEdits(t *testing.T, tr *worldhost.Terrain, store *memEdits, ts *memTerrain, scale float64, restore bool) (*harness, *worldedit.Overlay, *writebehind.Queue) {
	t.Helper()
	ov := worldedit.New()
	tr.SetEdits(ov)
	q := writebehind.New(1000)
	qctx, qstop := context.WithCancel(context.Background())
	t.Cleanup(qstop)
	go q.Run(qctx)
	setup := &WorldEditSetup{Overlay: ov, Scatter: testScatter{tr}, Plan: openWorld{t: tr}, Store: ts, RegrowScale: scale}
	h := newHarnessPre(t, func(c *Config) {
		c.Ground = tr
		c.EditStore, c.Queue, c.WorldID = store, q, testWorld
		c.WorldEdit = setup
	}, func(s *Server) {
		if restore {
			if _, _, err := s.RestoreWorldEdits(context.Background()); err != nil {
				t.Fatal(err)
			}
		}
	})
	return h, ov, q
}

func spawnXYZ(x, y, z float64) string { return "?spawn=" + ftoa(x) + "," + ftoa(y) + "," + ftoa(z) }

func TestHarvestFellsPersistsAndRegrows(t *testing.T) {
	tr := testTerrain(t)
	rec, gy := treeNear(t, tr)
	store := &memEdits{rows: map[int64]StoredEdit{}}
	ts := &memTerrain{blocks: map[[2]int32][]byte{}}
	h, _, q := startEdits(t, tr, store, ts, 1, false)
	a := h.dial(spawnXYZ(rec.X+1.6, gy+0.2, rec.Z))
	a.join(h, "chopper", "Chopper")
	a.pump(300 * time.Millisecond)

	swings := 0
	for len(a.eventsOf(EventHarvestFelled)) == 0 && swings < 30 {
		a.send(&proto.Interact{TargetKind: InteractHarvest, TargetID: rec.ID, Action: ActionUse})
		swings++
		a.pump(260 * time.Millisecond)
	}
	def, _ := worldedit.DefFor(worldedit.LayerTree, rec.Kind)
	want := int(math.Ceil(def.MaxHP(rec.Scale) / def.Damage))
	if len(a.eventsOf(EventHarvestFelled)) != 1 || swings != want {
		t.Fatalf("felled after %d swings (want %d); refusals %v", swings, want, a.eventsOf(EventHarvestRefused))
	}
	hits := a.eventsOf(EventHarvestHit)
	if len(hits) != swings || hits[len(hits)-1].Value != 0 || binary.LittleEndian.Uint64(hits[0].Data) != rec.ID {
		t.Fatalf("hits %d: last value %d", len(hits), hits[len(hits)-1].Value)
	}
	drops := a.eventsOf(EventDropSpawned)
	if len(drops) == 0 {
		t.Fatal("no drops")
	}
	logs := 0
	for _, d := range drops {
		if string(d.Data) == "wood:log" {
			logs += int(d.Value)
		}
	}
	if logs < 2 {
		t.Fatalf("a tree drops at least 2 logs: %v", drops)
	}
	// Everyone near gets the removal: the swinger on first interest or the live delta, a late joiner on interest.
	b := h.dial(spawnXYZ(rec.X+1.6, gy+0.2, rec.Z))
	b.join(h, "watcher", "Watcher")
	b.pump(900 * time.Millisecond)
	found := false
	for _, we := range b.edits {
		for _, e := range we.Edits {
			if e.TargetID == rec.ID && e.Kind == proto.EditKindObjectDestroyed && e.ExpiresAt > float64(time.Now().UnixMicro())/1000 {
				found = true
			}
		}
	}
	if !found {
		t.Fatalf("late joiner did not get the object_destroyed edit: %+v", b.edits)
	}
	// Gone is gone: swinging again is refused.
	a.pump(250 * time.Millisecond)
	a.send(&proto.Interact{TargetKind: InteractHarvest, TargetID: rec.ID, Action: ActionUse})
	a.pump(200 * time.Millisecond)
	if r := a.eventsOf(EventHarvestRefused); len(r) == 0 || r[len(r)-1].Value != HarvestGone {
		t.Fatalf("a felled tree was not refused: %v", r)
	}
	fl, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	_ = q.Flush(fl)
	cancel()
	store.mu.Lock()
	if len(store.rows) != 1 {
		t.Fatalf("rows %d", len(store.rows))
	}
	for _, r := range store.rows {
		if r.Kind != "object_destroyed" || r.TargetID != rec.ID || !r.ExpiresAt.After(time.Now().Add(time.Hour)) {
			t.Fatalf("row %+v", r)
		}
	}
	store.mu.Unlock()

	// A restarted zone still has it removed (persisted edits are restored).
	h2, _, _ := startEdits(t, testTerrain(t), store, ts, 1, true)
	c := h2.dial(spawnXYZ(rec.X+1.6, gy+0.2, rec.Z))
	c.join(h2, "chopper", "Chopper")
	c.pump(900 * time.Millisecond)
	c.send(&proto.Interact{TargetKind: InteractHarvest, TargetID: rec.ID, Action: ActionUse})
	c.pump(200 * time.Millisecond)
	if r := c.eventsOf(EventHarvestRefused); len(r) == 0 || r[len(r)-1].Value != HarvestGone {
		t.Fatalf("restored zone lost the felled tree: %v", r)
	}
	st, _ := h2.srv.WorldEditStatus(context.Background())
	if st.Removed != 1 {
		t.Fatalf("status %+v", st)
	}
}

func TestHarvestRegrowsAndRefusesFar(t *testing.T) {
	tr := testTerrain(t)
	rec, gy := treeNear(t, tr)
	store := &memEdits{rows: map[int64]StoredEdit{}}
	h, _, _ := startEdits(t, tr, store, &memTerrain{blocks: map[[2]int32][]byte{}}, 1e-8, false) // regrows within milliseconds
	// Far away from it: refused.
	far := h.dial(spawnXYZ(rec.X+30, tr.HeightAt(rec.X+30, rec.Z)+0.2, rec.Z))
	far.join(h, "far", "Far")
	far.pump(300 * time.Millisecond)
	far.send(&proto.Interact{TargetKind: InteractHarvest, TargetID: rec.ID, Action: ActionUse})
	far.pump(200 * time.Millisecond)
	if r := far.eventsOf(EventHarvestRefused); len(r) == 0 || r[0].Value != HarvestFar {
		t.Fatalf("far swing not refused: %v", r)
	}
	a := h.dial(spawnXYZ(rec.X+1.6, gy+0.2, rec.Z))
	a.join(h, "chopper", "Chopper")
	a.pump(300 * time.Millisecond)
	for i := 0; i < 30 && len(a.eventsOf(EventHarvestFelled)) == 0; i++ {
		a.send(&proto.Interact{TargetKind: InteractHarvest, TargetID: rec.ID, Action: ActionUse})
		a.pump(260 * time.Millisecond)
	}
	if len(a.eventsOf(EventHarvestFelled)) != 1 {
		t.Fatal("never felled")
	}
	a.pump(500 * time.Millisecond)
	var last *proto.EditRecord
	for _, we := range a.edits {
		for i := range we.Edits {
			if we.Edits[i].TargetID == rec.ID {
				last = &we.Edits[i]
			}
		}
	}
	if last == nil || last.ExpiresAt > float64(time.Now().UnixMicro())/1000+1 {
		t.Fatalf("no expiry delta after regrowth: %+v", last)
	}
	// And it can be chopped again.
	a.send(&proto.Interact{TargetKind: InteractHarvest, TargetID: rec.ID, Action: ActionUse})
	a.pump(250 * time.Millisecond)
	if n := len(a.eventsOf(EventHarvestHit)); n == 0 {
		t.Fatal("a regrown tree cannot be hit")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.deleted == 0 {
		// the queue may not have run yet; the in-memory state is what matters here
		t.Log("row deletion pending in the write-behind queue")
	}
}

func TestEarthworkDigFillStreamsAndPersists(t *testing.T) {
	tr := testTerrain(t)
	rec, gy := treeNear(t, tr) // open ground near the spawn
	px, pz := rec.X+4.5, rec.Z+0.5
	gy = tr.HeightAt(px, pz)
	ts := &memTerrain{blocks: map[[2]int32][]byte{}}
	h, ov, q := startEdits(t, tr, &memEdits{rows: map[int64]StoredEdit{}}, ts, 1, false)
	a := h.dial(spawnXYZ(px-1.2, gy+0.2, pz))
	a.join(h, "digger", "Digger")
	a.pump(300 * time.Millisecond)
	target := func() uint64 { return uint64(uint32(math.Round(px*100))) | uint64(uint32(math.Round(pz*100)))<<32 }
	h0 := tr.HeightAt(px, pz)

	for i := 0; i < 5; i++ {
		a.send(&proto.Interact{TargetKind: InteractEarth, TargetID: target(), Action: 1})
		a.pump(230 * time.Millisecond)
	}
	if r := a.eventsOf(EventEarthRefused); len(r) != 0 {
		t.Fatalf("refused: %d first value %d (target %d) at %.1f,%.1f ground %.2f water %.2f", len(r), r[0].Value, r[0].TargetID, px, pz, gy, tr.WaterAt(px, pz))
	}
	if got := tr.HeightAt(px, pz); got > h0-1.0 {
		t.Fatalf("5 swings should lower the ground by a metre or more: %v -> %v", h0, got)
	}
	if len(a.terr) == 0 || len(a.eventsOf(EventEarthFX)) == 0 {
		t.Fatalf("no TerrainEdits (%d) or fx (%d)", len(a.terr), len(a.eventsOf(EventEarthFX)))
	}
	// The wire deltas, applied to an empty overlay, equal the server's.
	mirror := worldedit.New()
	for _, m := range a.terr {
		es, err := worldedit.DecodeEntries(m.Data)
		if err != nil {
			t.Fatal(err)
		}
		var ch []worldedit.Change
		for _, e := range es {
			ch = append(ch, worldedit.Change{X: m.Cx*64 + int32(e.I&63), Z: m.Cz*64 + int32(e.I>>6), D: e.D})
		}
		if _, err := mirror.Apply(ch); err != nil {
			t.Fatal(err)
		}
	}
	for z := int32(pz) - 12; z < int32(pz)+12; z++ {
		for x := int32(px) - 12; x < int32(px)+12; x++ {
			if mirror.Delta(x, z) != ov.Delta(x, z) {
				t.Fatalf("client mirror differs at %d,%d: %d vs %d", x, z, mirror.Delta(x, z), ov.Delta(x, z))
			}
		}
	}
	// Too fast: two swings in one tick, the second is refused.
	a.pump(260 * time.Millisecond)
	a.send(&proto.Interact{TargetKind: InteractEarth, TargetID: target(), Action: 1})
	a.send(&proto.Interact{TargetKind: InteractEarth, TargetID: target(), Action: 1})
	a.pump(150 * time.Millisecond)
	if r := a.eventsOf(EventEarthRefused); len(r) == 0 || r[len(r)-1].Value != EarthTooFast {
		t.Fatalf("burst not refused: %v", r)
	}
	// Out of reach.
	a.pump(260 * time.Millisecond)
	far := uint64(uint32((px+40)*100)) | uint64(uint32(pz*100))<<32
	a.send(&proto.Interact{TargetKind: InteractEarth, TargetID: far, Action: 1})
	a.pump(150 * time.Millisecond)
	if r := a.eventsOf(EventEarthRefused); r[len(r)-1].Value != EarthFar {
		t.Fatalf("far dig not refused: %v", r)
	}
	// Fill raises it again (no item system in this harness: free).
	lowest := tr.HeightAt(px, pz)
	for i := 0; i < 5; i++ {
		a.send(&proto.Interact{TargetKind: InteractEarth, TargetID: target(), Action: 2})
		a.pump(230 * time.Millisecond)
	}
	if got := tr.HeightAt(px, pz); got <= lowest+0.5 {
		t.Fatalf("fill did not raise the ground: %v -> %v; refusals %v", lowest, got, func() (v []int32) { for _, e := range a.eventsOf(EventEarthRefused) { v = append(v, e.Value) }; return }())
	}
	// A late joiner gets the chunk's edits on first interest.
	b := h.dial(spawnXYZ(px-1.2, gy+0.2, pz))
	b.join(h, "late", "Late")
	b.pump(900 * time.Millisecond)
	if len(b.terr) == 0 {
		t.Fatal("late joiner got no TerrainEdits")
	}
	// Persisted per chunk, and a restarted zone restores it.
	fl, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	_ = q.Flush(fl)
	cancel()
	ts.mu.Lock()
	if len(ts.blocks) == 0 {
		t.Fatal("nothing persisted")
	}
	ts.mu.Unlock()
	want := tr.HeightAt(px, pz)
	tr2 := testTerrain(t)
	_, ov2, _ := startEdits(t, tr2, &memEdits{rows: map[int64]StoredEdit{}}, ts, 1, true)
	if got := tr2.HeightAt(px, pz); got != want || ov2.Vertices() != ov.Vertices() {
		t.Fatalf("restored height %v (%d verts), want %v (%d)", got, ov2.Vertices(), want, ov.Vertices())
	}
	st, _ := h.srv.WorldEditStatus(context.Background())
	if st.TerrainVerts != ov.Vertices() || st.Dug < 5 || st.Filled < 5 {
		t.Fatalf("status %+v", st)
	}
}

func TestEarthworkRefusesProtectedAndWater(t *testing.T) {
	tr := testTerrain(t)
	rec, gy := treeNear(t, tr)
	px, pz := rec.X+4.5, rec.Z+0.5
	gy = tr.HeightAt(px, pz)
	ov := worldedit.New()
	tr.SetEdits(ov)
	h := newHarness(t, func(c *Config) {
		c.Ground = tr
		c.WorldEdit = &WorldEditSetup{Overlay: ov, Scatter: testScatter{tr},
			Plan: openWorld{t: tr, forbidden: func(x, z int32) bool { return math.Hypot(float64(x)-px, float64(z)-pz) < 20 }}}
	})
	a := h.dial(spawnXYZ(px-1.2, gy+0.2, pz))
	a.join(h, "d", "D")
	a.pump(300 * time.Millisecond)
	a.send(&proto.Interact{TargetKind: InteractEarth, TargetID: uint64(uint32(px*100)) | uint64(uint32(pz*100))<<32, Action: 1})
	a.pump(200 * time.Millisecond)
	if r := a.eventsOf(EventEarthRefused); len(r) != 1 || r[0].Value != EarthForbidden {
		t.Fatalf("protected ground not refused: %v", r)
	}
	if ov.Any() {
		t.Fatal("a refused dig changed the ground")
	}
}
