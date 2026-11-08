package game

// WP09 in-process tests on the real cave world (seed 20261108): walking in a
// cave matches prediction, mining breaks a vein with personal drops, a
// carve edit and WorldEdits, the vein and carve restore on a short respawn,
// persisted edits are restored on startup, and interest is clipped to the
// cave system.

import (
	"context"
	"encoding/binary"
	"math"
	"slices"
	"sync"
	"testing"
	"time"

	"lodestone/server/pkg/caves"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/worldhost"
	"lodestone/server/pkg/writebehind"
)

func testCaveTerrain(t *testing.T) *worldhost.CaveTerrain {
	t.Helper()
	tr := testTerrain(t)
	cv, err := worldhost.NewCaves(tr.World(), worldhost.CaveOptions{Workers: 1})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cv.Close)
	return worldhost.NewCaveTerrain(tr, cv)
}

type memEdits struct {
	mu      sync.Mutex
	rows    map[int64]StoredEdit
	saved   int
	deleted int
}

func (m *memEdits) LoadEdits(_ context.Context, _ string, now time.Time) ([]StoredEdit, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []StoredEdit
	for _, r := range m.rows {
		if r.ExpiresAt.After(now) {
			out = append(out, r)
		}
	}
	return out, nil
}
func (m *memEdits) SaveEdit(_ context.Context, _ string, e StoredEdit) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rows[e.EditID] = e
	m.saved++
	return nil
}
func (m *memEdits) DeleteEdit(_ context.Context, _ string, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.rows, id)
	m.deleted++
	return nil
}

type memGrants struct {
	mu    sync.Mutex
	items []string
}

func (g *memGrants) Grant(char, item string, qty int, seed uint64) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.items = append(g.items, char+":"+item)
	return nil
}

// veinStand finds a reachable standing point in front of a vein: on the
// chamber floor, 1.4 m out along the vein's normal.
func veinStand(t *testing.T, ct *worldhost.CaveTerrain, v caves.Vein) movement.Vec3 {
	t.Helper()
	nl := math.Hypot(v.NX, v.NZ)
	if nl < 0.2 {
		t.Skip("vein normal too vertical for this test")
	}
	x, z := v.X+v.NX/nl*1.4, v.Z+v.NZ/nl*1.4
	ct.Caves.Ensure(x, v.Y, z, 40)
	y := ct.FloorAt(x, v.Y+0.5, z)
	return movement.Vec3{X: x, Y: y, Z: z}
}

// pickVein: a vein low on a wall whose stand point is on a floor close below it.
func pickVein(t *testing.T, ct *worldhost.CaveTerrain) (caves.Vein, movement.Vec3) {
	g := ct.CaveGraph()
	for _, v := range g.Veins {
		if v.NY > 0.5 || v.NY < -0.3 {
			continue
		}
		p := veinStand(t, ct, v)
		if v.Y-p.Y < 2.2 && v.Y-p.Y > -0.5 {
			return v, p
		}
	}
	t.Fatal("no vein with a floor in front of it")
	return caves.Vein{}, movement.Vec3{}
}

func (cl *client) events(kind uint16) []*proto.Event {
	var out []*proto.Event
	for {
		select {
		case m, ok := <-cl.msgs:
			if !ok {
				return out
			}
			cl.absorb(m)
			if e, ok := m.(*proto.Event); ok && e.Kind == kind {
				out = append(out, e)
			}
		default:
			return out
		}
	}
}

// absorb applies snapshots and records WorldEdits and Events.
func (cl *client) absorb(m proto.Message) {
	switch x := m.(type) {
	case *proto.Snapshot:
		if f, err := cl.dec.Apply(x); err == nil {
			cl.frame, cl.snap = f, x
		}
	case *proto.WorldEdits:
		cl.edits = append(cl.edits, x)
	case *proto.Event:
		cl.evs = append(cl.evs, x)
	}
}

func (cl *client) pump(d time.Duration) {
	deadline := time.After(d)
	for {
		select {
		case m, ok := <-cl.msgs:
			if !ok {
				return
			}
			cl.absorb(m)
		case <-deadline:
			return
		}
	}
}

func (cl *client) eventsOf(kind uint16) []*proto.Event {
	var out []*proto.Event
	for _, e := range cl.evs {
		if e.Kind == kind {
			out = append(out, e)
		}
	}
	return out
}

func (cl *client) seesKind(kind proto.EntityKind) bool {
	if cl.frame == nil {
		return false
	}
	for _, e := range cl.frame.Ents {
		if e.Kind == kind {
			return true
		}
	}
	return false
}

func TestMiningBreakDropsEditsRespawn(t *testing.T) {
	ct := testCaveTerrain(t)
	store := &memEdits{rows: map[int64]StoredEdit{}}
	grants := &memGrants{}
	q := writebehind.New(100)
	qctx, qstop := context.WithCancel(context.Background())
	defer qstop()
	go q.Run(qctx)
	h := newHarness(t, func(c *Config) {
		c.Ground = ct
		c.VeinRespawnMin, c.VeinRespawnMax = 2*time.Second, 3*time.Second
		c.EditStore, c.Granter, c.Queue = store, grants, q
		c.WorldID = testWorld
	})
	v, stand := pickVein(t, ct)
	spawn := "?spawn=" + ftoa(stand.X) + "," + ftoa(stand.Y+0.3) + "," + ftoa(stand.Z)
	a := h.dial(spawn)
	wa := a.join(h, "miner-a", "Miner")
	if got := proto.CmToMeters(wa.Y); math.Abs(got-stand.Y) > 0.02 {
		t.Fatalf("spawned at y %.2f, want the cave floor %.2f (underground spawn)", got, stand.Y)
	}
	a.pump(300 * time.Millisecond)

	// Swing until it breaks (pickaxe 25 per swing, >= 300 ms apart).
	swings := 0
	for len(a.eventsOf(EventVeinBreak)) == 0 && swings < 40 {
		a.send(&proto.Interact{TargetKind: InteractVein, TargetID: v.ID, Action: ActionUse})
		swings++
		a.pump(320 * time.Millisecond)
	}
	hits := a.eventsOf(EventVeinHit)
	if len(a.eventsOf(EventVeinBreak)) != 1 || len(hits) == 0 {
		t.Fatalf("after %d swings: %d hits, %d breaks; refusals %v", swings, len(hits), len(a.eventsOf(EventVeinBreak)), a.eventsOf(EventMineRefused))
	}
	wantSwings := int(math.Ceil(float64(v.HP) / pickaxeDamage))
	if swings != wantSwings {
		t.Fatalf("broke after %d swings, want %d (hp %d)", swings, wantSwings, v.HP)
	}
	if id := binary.LittleEndian.Uint64(hits[0].Data); id != v.ID {
		t.Fatalf("hit event for vein %x", id)
	}
	drops := a.eventsOf(EventDropSpawned)
	if len(drops) != 1 || len(drops[0].Data) == 0 {
		t.Fatalf("drops %v", drops)
	}
	// WorldEdits: the vein's chunk, one vein_mined edit with the carve sphere.
	var edit *proto.EditRecord
	cx, cz := chunkOf(v.X, v.Z)
	for _, we := range a.edits {
		for i := range we.Edits {
			if we.Cx == cx && we.Cz == cz && we.Edits[i].TargetID == v.ID {
				edit = &we.Edits[i]
			}
		}
	}
	if edit == nil || edit.Kind != proto.EditKindVeinMined || len(edit.Params) != 16 {
		t.Fatalf("no vein_mined WorldEdits for chunk (%d,%d): %+v", cx, cz, a.edits)
	}
	if r := math.Float32frombits(binary.LittleEndian.Uint32(edit.Params[12:])); r != CarveRadiusM {
		t.Fatalf("carve radius %v", r)
	}
	// The cave cells were rebuilt with the carve: the vein is flagged mined.
	vcx, vcy, vcz := caves.CellOf(v.X, v.Y, v.Z)
	cell := ct.Caves.Cell(vcx, vcy, vcz)
	flagged := slices.ContainsFunc(cell.Veins, func(x caves.Vein) bool { return x.ID == v.ID && x.Flags&caves.VeinMined != 0 })
	if !flagged || len(ct.Caves.Edits()) != 1 {
		t.Fatalf("cave edit not applied: flagged=%v edits=%d", flagged, len(ct.Caves.Edits()))
	}
	// Swinging a mined vein is refused.
	a.send(&proto.Interact{TargetKind: InteractVein, TargetID: v.ID, Action: ActionUse})
	a.pump(200 * time.Millisecond)
	if r := a.eventsOf(EventMineRefused); len(r) == 0 || r[len(r)-1].Value != RefuseMined {
		t.Fatalf("mined vein not refused: %v", r)
	}

	// The pickup is personal: a second player next to the miner never sees it.
	b := h.dial(spawn)
	b.join(h, "watcher-b", "Watcher")
	b.pump(400 * time.Millisecond)
	if b.seesKind(proto.EntityKindPickup) {
		t.Fatal("another player sees a personal drop")
	}
	// ...but gets the active edit on first interest.
	gotB := slices.ContainsFunc(b.edits, func(we *proto.WorldEdits) bool {
		return slices.ContainsFunc(we.Edits, func(e proto.EditRecord) bool { return e.TargetID == v.ID })
	})
	if !gotB {
		t.Fatal("late joiner did not get the active edit")
	}

	// The miner stands next to the drop: auto-pickup grants it.
	deadline := time.Now().Add(3 * time.Second)
	for len(a.eventsOf(EventItemGranted)) == 0 && time.Now().Before(deadline) {
		a.pump(100 * time.Millisecond)
	}
	if len(a.eventsOf(EventItemGranted)) != 1 {
		// Walk onto it if auto-pickup did not reach.
		t.Fatalf("no grant; pickup visible to owner: %v", a.seesKind(proto.EntityKindPickup))
	}
	grants.mu.Lock()
	if len(grants.items) != 1 || grants.items[0] != "miner-a:"+string(drops[0].Data) {
		t.Fatalf("grants %v", grants.items)
	}
	grants.mu.Unlock()

	// Respawn (2-3 s): the edit expires everywhere, the carve is restored.
	deadline = time.Now().Add(6 * time.Second)
	for len(ct.Caves.Edits()) != 0 && time.Now().Before(deadline) {
		a.pump(100 * time.Millisecond)
	}
	a.pump(200 * time.Millisecond)
	if n := len(ct.Caves.Edits()); n != 0 {
		t.Fatalf("vein never respawned (%d edits)", n)
	}
	last := a.edits[len(a.edits)-1]
	if last.Edits[0].TargetID != v.ID || last.Edits[0].ExpiresAt > float64(time.Now().UnixMicro())/1000+1 {
		t.Fatalf("no expiry delta: %+v", last)
	}
	cell = ct.Caves.Cell(vcx, vcy, vcz)
	if slices.ContainsFunc(cell.Veins, func(x caves.Vein) bool { return x.ID == v.ID && x.Flags&caves.VeinMined != 0 }) {
		t.Fatal("respawned vein still flagged mined in the cave cell")
	}
	st, err := h.srv.MiningStatus(context.Background())
	if err != nil || st.Active != 0 || st.Mined != 1 {
		t.Fatalf("status %+v %v", st, err)
	}
	// Persistence: saved on break, deleted on respawn (write-behind).
	fl, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	_ = q.Flush(fl)
	cancel()
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.saved != 1 || store.deleted != 1 || len(store.rows) != 0 {
		t.Fatalf("store saved %d deleted %d rows %d", store.saved, store.deleted, len(store.rows))
	}
	t.Logf("vein %x (%s, hp %d) broke after %d swings; drop %q; respawned", v.ID, v.MaterialName(), v.HP, swings, drops[0].Data)
}

func TestMiningRestoresPersistedEdits(t *testing.T) {
	ct := testCaveTerrain(t)
	v := ct.CaveGraph().Veins[3]
	store := &memEdits{rows: map[int64]StoredEdit{
		77: {EditID: 77, Kind: "vein_mined", TargetID: v.ID, X: float32(v.X), Y: float32(v.Y), Z: float32(v.Z), R: CarveRadiusM, ExpiresAt: time.Now().Add(time.Hour)},
		78: {EditID: 78, Kind: "vein_mined", TargetID: ct.CaveGraph().Veins[4].ID, ExpiresAt: time.Now().Add(-time.Minute)}, // expired: ignored
	}}
	srv := New(Config{Ground: ct, EditStore: store, WorldID: testWorld})
	n, err := srv.RestoreEdits(context.Background())
	if err != nil || n != 1 {
		t.Fatalf("restored %d (%v)", n, err)
	}
	if e := ct.Caves.Edits(); len(e) != 1 || e[0].VeinID != v.ID {
		t.Fatalf("cave edits %+v", e)
	}
	if st := srv.miningStatus(); st.Active != 1 || len(st.Veins) != 1 || !st.Veins[0].Mined {
		t.Fatalf("status %+v", st)
	}
	ct.RemoveEdit(v.ID)
}

// TestCaveMovementMatchesPrediction walks the golden cave path's first
// stretch on the server with a client predicting on its own cave ground.
func TestCaveMovementMatchesPrediction(t *testing.T) {
	ct := testCaveTerrain(t)
	h := newHarness(t, func(c *Config) { c.Ground = ct })
	g := ct.CaveGraph()
	s := g.Systems[0]
	deep := g.Chambers[s.FirstChamber+s.Deepest]
	// Spawn in the deepest chamber, walk around in it.
	x, z := deep.X, deep.Z
	ct.Caves.Ensure(x, deep.Floor, z, 48)
	cl := h.dial("?spawn=" + ftoa(x) + "," + ftoa(deep.Floor+1) + "," + ftoa(z))
	cl.join(h, "spelunker", "Spelunker")
	local := testCaveTerrain(t)
	local.Caves.Ensure(x, deep.Floor, z, 48)
	sim := movement.State{Pos: movement.Vec3{X: x, Y: local.FloorAt(x, deep.Floor+1, z), Z: z}}
	cl.walkOn(90, proto.InputFlagForward, 0.4, &sim, local)
	cl.walkOn(60, proto.InputFlagForward|proto.InputFlagJump, 2.5, &sim, local)
	cl.walkOn(90, proto.InputFlagForward|proto.InputFlagSprint, -1.9, &sim, local)
	self := cl.waitAck(t)
	if self.X != proto.MetersToCm(sim.Pos.X) || self.Y != proto.MetersToCm(sim.Pos.Y) || self.Z != proto.MetersToCm(sim.Pos.Z) {
		t.Fatalf("server (%d,%d,%d) cm vs predicted (%.3f,%.3f,%.3f)", self.X, self.Y, self.Z, sim.Pos.X, sim.Pos.Y, sim.Pos.Z)
	}
	if sim.Pos.Y > deep.Floor+4 || g.SystemAt(sim.Pos.X, sim.Pos.Y+1, sim.Pos.Z) != 0 {
		t.Fatalf("left the chamber: %+v", sim.Pos)
	}
	if v := h.srv.m.speedViolations.Load(); v != 0 {
		t.Fatalf("%d validation rejections in a cave", v)
	}
}

// TestCaveInterestClipping: a player in a cave doesn't see the meadow above.
func TestCaveInterestClipping(t *testing.T) {
	ct := testCaveTerrain(t)
	h := newHarness(t, func(c *Config) { c.Ground = ct })
	g := ct.CaveGraph()
	// A system whose deepest chamber is far from all its openings (a
	// sinkhole above it would make the walker "at a mouth", visible by design).
	si := -1
	for k := range g.Systems {
		d := g.Chambers[g.Systems[k].FirstChamber+g.Systems[k].Deepest]
		far := true
		for _, op := range g.SystemOpenings(k) {
			if math.Hypot(d.X-op.X, d.Z-op.Z) < mouthAOIM+20 {
				far = false
			}
		}
		if far {
			si = k
			break
		}
	}
	if si < 0 {
		t.Skip("no system with a deepest chamber away from its openings")
	}
	s := g.Systems[si]
	deep := g.Chambers[s.FirstChamber+s.Deepest]
	o := g.SystemOpenings(si)[0]
	ct.Caves.Ensure(deep.X, deep.Floor, deep.Z, 48)
	ct.Caves.Ensure(o.X, o.Y, o.Z, 48)
	in := h.dial("?spawn=" + ftoa(deep.X) + "," + ftoa(deep.Floor+1) + "," + ftoa(deep.Z))
	in.join(h, "cave-dweller", "Dweller")
	// Directly above the chamber, on the surface (within 200 m: normally mid ring).
	above := h.dial("?spawn=" + ftoa(deep.X+3) + "," + ftoa(deep.Z+3))
	above.join(h, "meadow-walker", "Walker")
	// At the mouth: visible from inside.
	mouth := h.dial("?spawn=" + ftoa(o.X+o.RMask+6) + "," + ftoa(o.Z))
	mouth.join(h, "mouth-watcher", "Watcher")
	time.Sleep(600 * time.Millisecond)
	for _, c := range []*client{in, above, mouth} {
		c.pump(400 * time.Millisecond)
	}
	names := func(c *client) []string {
		var out []string
		if c.frame == nil {
			return out
		}
		for _, e := range c.frame.Ents {
			out = append(out, e.Name)
		}
		slices.Sort(out)
		return out
	}
	if n := names(in); slices.Contains(n, "Walker") {
		t.Fatalf("cave dweller sees the meadow above: %v", n)
	}
	if n := names(above); slices.Contains(n, "Dweller") {
		t.Fatalf("meadow walker sees the cave below: %v", n)
	}
	mouthDist := math.Hypot(deep.X-o.X, deep.Z-o.Z)
	if mouthDist < 200 {
		if n := names(in); !slices.Contains(n, "Watcher") {
			t.Fatalf("cave dweller does not see the player at the mouth (%.0f m away): %v", mouthDist, n)
		}
	}
	t.Logf("inside sees %v; above sees %v; mouth sees %v", names(in), names(above), names(mouth))
}
