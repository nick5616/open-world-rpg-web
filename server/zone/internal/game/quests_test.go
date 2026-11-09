package game

// Quest log in-process tests on the official world (real towns, caves and
// atlas): the starter quest "Ward against the night" from first login to
// the Light tome, bounties as persisted quests with markers (accept, explore
// completion on arrival, a delivery handed in at the board), the log
// surviving a logout through the store, abandoning, and the handoff field.

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"sort"
	"testing"
	"time"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/towns"
	"lodestone/server/pkg/writebehind"
	"lodestone/server/zone/internal/explore"
	"lodestone/server/zone/internal/items"
	"lodestone/server/zone/internal/npc"
	"lodestone/server/zone/internal/quests"
)

type questStore struct {
	fakeStore
	logs  map[string][]byte
	saves int
}

func (q *questStore) LoadQuests(_ context.Context, id string) ([]byte, bool, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	b, ok := q.logs[id]
	return b, ok, nil
}

func (q *questStore) SaveQuests(_ context.Context, id string, b []byte, _ int64) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if _, ok := q.rows[id]; !ok {
		return ErrNoRow
	}
	q.logs[id] = append([]byte(nil), b...)
	q.saves++
	return nil
}

type wireLogT struct {
	Tracked uint32             `json:"tracked"`
	Quests  []quests.WireQuest `json:"quests"`
}

func (cl *client) questLog(t *testing.T) wireLogT {
	t.Helper()
	var l wireLogT
	if err := json.Unmarshal(cl.lastEvent(EventQuestLog, 3*time.Second).Data, &l); err != nil {
		t.Fatal(err)
	}
	return l
}

// take pumps until an Event of kind has been absorbed, removes the oldest
// one from the client's record and returns it (so lastEvent-style reads of
// other kinds keep working).
func (cl *client) take(kind uint16, timeout time.Duration) *proto.Event {
	cl.t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		for i, e := range cl.evs {
			if e.Kind == kind {
				cl.evs = append(cl.evs[:i:i], cl.evs[i+1:]...)
				return e
			}
		}
		if time.Now().After(deadline) {
			var got []string
			for _, e := range cl.evs {
				got = append(got, ftoa(float64(e.Kind))+":"+ftoa(float64(e.Value)))
			}
			cl.t.Fatalf("timeout waiting for event %d (have %v)", kind, got)
		}
		cl.pump(40 * time.Millisecond)
	}
}

func (l wireLogT) find(id uint32) *quests.WireQuest {
	for i := range l.Quests {
		if l.Quests[i].ID == id {
			return &l.Quests[i]
		}
	}
	return nil
}

func realExplore(t *testing.T, g movement.Ground) *explore.World {
	t.Helper()
	a, err := structures.ParseAtlas(testTerrain(t).World().Atlas)
	if err != nil {
		t.Fatal(err)
	}
	o, sites := structures.Towers(a, g)
	return explore.NewWorld(a, structures.Wrap(g, o), sites)
}

// addItems puts items straight into a live inventory (test hook).
func addItems(t *testing.T, h *harness, char string, base string, qty int) {
	t.Helper()
	if err := h.srv.Do(context.Background(), func() {
		sess := h.srv.byChar[char]
		var d items.Delta
		sess.items.inv.Add(items.Stack(base, qty), &d)
		h.srv.commitItems(sess, &d, nil, "test")
	}); err != nil {
		t.Fatal(err)
	}
}

func TestStarterQuestWardAgainstTheNight(t *testing.T) {
	w, g := testTowns(t)
	ex := realExplore(t, g)
	store := &questStore{fakeStore: fakeStore{saves: map[string]movement.Vec3{}, rows: map[string]movement.Vec3{}}, logs: map[string][]byte{}}
	q := writebehind.New(100)
	q.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	qctx, stopQ := context.WithCancel(context.Background())
	defer stopQ()
	go q.Run(qctx)
	h := newHarness(t, func(c *Config) {
		c.Ground = g
		c.Towns = w
		c.Explore = ex
		c.Store = store
		c.Queue = q
		c.TimeOffsetS = offsetFor(12)
	})
	si := spawnSettlement(t, w)
	smith := npcOf(w, si, towns.RoleBlacksmith)
	sd := w.T.NPCs[smith]
	const char = "11111111-2222-3333-4444-555555555555"
	sx, sz := sd.WorkX+1.5*math.Cos(sd.WorkYaw), sd.WorkZ+1.5*math.Sin(sd.WorkYaw)
	store.rows[char] = movement.Vec3{X: sx, Y: g.HeightAt(sx, sz) + 0.3, Z: sz}

	a := h.dial("")
	a.join(h, char, "Warden")
	started := a.take(EventQuestStarted, 3*time.Second)
	if started.TargetID != quests.WardID {
		t.Fatalf("started %+v", started)
	}
	l := a.questLog(t)
	ward := l.find(quests.WardID)
	if ward == nil || ward.Step != 0 || l.Tracked != quests.WardID || len(ward.Markers) != 1 || math.Hypot(ward.Markers[0].X-sd.WorkX, ward.Markers[0].Z-sd.WorkZ) > 0.01 {
		t.Fatalf("ward at login: %+v", ward)
	}
	if len(ward.Steps) < 6 {
		t.Fatalf("ward steps %+v", ward.Steps)
	}
	t.Logf("ward: %d steps; step 0: %s", len(ward.Steps), ward.Text)
	gold0 := a.inventory(t).Gold

	// 1. Talk to the blacksmith: the step's line, 25 gold.
	sid := a.npcEntityID(h, smith)
	a.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(sid), Action: ActionTalk})
	step := a.take(EventQuestStep, 3*time.Second)
	if step.TargetID != quests.WardID || step.Value != 1 {
		t.Fatalf("talk step %+v", step)
	}
	var said bool
	for _, ev := range a.eventsOf(EventNPCSay) {
		if len(ev.Data) > 60 && ev.EntityID == sid {
			said = true
			t.Logf("smith: %s", ev.Data)
		}
	}
	if !said {
		t.Fatal("the blacksmith did not say the quest line")
	}
	if g := a.inventory(t).Gold; g != gold0+quests.WardSmithCoin {
		t.Fatalf("gold %d -> %d", gold0, g)
	}
	l = a.questLog(t)
	ward = l.find(quests.WardID)
	if ward.Step != 1 || ward.Need != 4 {
		t.Fatalf("after talk %+v", ward)
	}
	if len(ward.Markers) == 0 || ward.Markers[0].R < 20 {
		t.Fatalf("ore markers %+v", ward.Markers)
	}
	t.Logf("ore: %s at (%.0f, %.0f) r %.0f; %s", ward.Text, ward.Markers[0].X, ward.Markers[0].Z, ward.Markers[0].R, ward.Note)

	// 2. Ore (mining is WP09's, tested there): progress, then the step.
	addItems(t, h, char, "ore:sunsteel", 2)
	deadline := time.Now().Add(3 * time.Second)
	for ward = a.questLog(t).find(quests.WardID); ward.Progress != 2 && time.Now().Before(deadline); ward = a.questLog(t).find(quests.WardID) {
	}
	if ward.Progress != 2 {
		t.Fatalf("progress %d", ward.Progress)
	}
	addItems(t, h, char, "ore:sunsteel", 2)
	if s := a.take(EventQuestStep, 3*time.Second); s.Value != 2 {
		t.Fatalf("ore step %+v", s)
	}

	// 3. The blueprint from the blacksmith, with gold.
	idx := -1
	for i, it := range npc.SmithWares() {
		if it.Item == "blueprint:sunsteel_blade" {
			idx = i
		}
	}
	a.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(sid), Action: ActionBuy, Arg: uint32(idx)})
	if s := a.take(EventQuestStep, 3*time.Second); s.Value != 3 {
		t.Fatalf("blueprint step %+v", s)
	}

	// 4. The blade (forging is WP14's, tested there).
	addItems(t, h, char, "weapon:sunsteel_blade", 1)
	s4 := a.take(EventQuestStep, 3*time.Second)
	if s4.Value != 4 {
		t.Fatalf("forge step %+v", s4)
	}
	ward = a.questLog(t).find(quests.WardID)
	t.Logf("light: %s · %s · markers %+v", ward.Text, ward.Note, ward.Markers)
	if ward.Text != "Learn Light magic: read the Tome of Glint" {
		// 5. The shrine: arriving hands over the tome.
		if len(ward.Markers) != 1 {
			t.Fatalf("shrine markers %+v", ward.Markers)
		}
		m := ward.Markers[0]
		_ = h.srv.Do(context.Background(), func() {
			e := h.srv.byChar[char].ent
			h.srv.Teleport(e, movement.Vec3{X: m.X, Y: g.HeightAt(m.X, m.Z), Z: m.Z})
		})
		if s := a.take(EventQuestStep, 5*time.Second); s.Value != 5 {
			t.Fatalf("shrine step %+v", s)
		}
	}
	tome := findItem(a.inventory(t), quests.LightTome)
	if tome == nil {
		t.Fatal("no Light tome")
	}
	// 6. Read it: Glint is learned, slotted, and the quest completes.
	a.interact(InteractItem, uint64(tome.H), ItemActUse, 0)
	done := a.take(EventQuestCompleted, 3*time.Second)
	if done.TargetID != quests.WardID || done.Value != quests.WardGold {
		t.Fatalf("completed %+v", done)
	}
	var slotted bool
	_ = h.srv.Do(context.Background(), func() {
		p := h.srv.byChar[char].ent.cbt.Profile
		for _, k := range p.Loadouts[p.Active].Spells {
			slotted = slotted || k == quests.LightSpell
		}
	})
	if !slotted {
		t.Fatal("Glint not in a spell slot")
	}
	if a.questLog(t).find(quests.WardID) != nil {
		t.Fatal("ward still active")
	}

	// Saved (write-behind) and not restarted on the next login.
	a.c.Close(1000, "")
	deadline = time.Now().Add(3 * time.Second)
	for {
		store.mu.Lock()
		b := store.logs[char]
		store.mu.Unlock()
		if l := quests.Load(b); l.IsDone(quests.WardKey) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("quest log never saved")
		}
		time.Sleep(20 * time.Millisecond)
	}
	a2 := h.dial("")
	a2.join(h, char, "Warden")
	a2.pump(600 * time.Millisecond)
	if len(a2.eventsOf(EventQuestStarted)) > 0 {
		t.Fatal("ward restarted")
	}
	if l := a2.questLog(t); l.find(quests.WardID) != nil {
		t.Fatal("ward restarted after completion")
	}
}

func TestBountiesBecomePersistedQuests(t *testing.T) {
	w, g := testTowns(t)
	ex := realExplore(t, g)
	store := &questStore{fakeStore: fakeStore{saves: map[string]movement.Vec3{}, rows: map[string]movement.Vec3{}}, logs: map[string][]byte{}}
	q := writebehind.New(100)
	q.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	qctx, stopQ := context.WithCancel(context.Background())
	defer stopQ()
	go q.Run(qctx)
	h := newHarness(t, func(c *Config) {
		c.Ground = g
		c.Towns = w
		c.Explore = ex
		c.Store = store
		c.Queue = q
		c.TimeOffsetS = offsetFor(12)
	})
	si := spawnSettlement(t, w)
	board := propOf(w, si, towns.PropBoard)
	const char = "21111111-2222-3333-4444-555555555555"
	bx, bz := board.X+1.5*math.Cos(board.Yaw), board.Z+1.5*math.Sin(board.Yaw)
	store.rows[char] = movement.Vec3{X: bx, Y: g.HeightAt(bx, bz) + 0.3, Z: bz}
	a := h.dial("")
	a.join(h, char, "Hunter")
	a.pump(300 * time.Millisecond)

	a.send(&proto.Interact{TargetKind: InteractBoard, TargetID: board.ID, Action: 1})
	list := a.take(EventBounties, 3*time.Second)
	type job struct {
		id   uint32
		kind uint8
		site uint16
		qty  uint16
	}
	var jobs []job
	off := 2
	for i := 0; i < int(list.Data[1]); i++ {
		d := list.Data[off:]
		j := job{id: binary.LittleEndian.Uint32(d), kind: d[4], site: binary.LittleEndian.Uint16(d[5:]), qty: binary.LittleEndian.Uint16(d[7:])}
		n := int(binary.LittleEndian.Uint16(d[14:]))
		jobs = append(jobs, j)
		off += 16 + n
	}
	for _, j := range jobs {
		a.send(&proto.Interact{TargetKind: InteractBoard, TargetID: board.ID, Action: 2, Arg: j.id})
		a.take(EventBountyAccepted, 3*time.Second)
	}
	l := a.questLog(t)
	for _, j := range jobs {
		bq := l.find(j.id)
		if bq == nil || bq.Kind != quests.KindBounty || len(bq.Markers) != 1 {
			t.Fatalf("bounty %+v as quest %+v", j, bq)
		}
		t.Logf("bounty %d kind %d: %q marker %+v", j.id, j.kind, bq.Title, bq.Markers[0])
		if j.kind == quests.BountyDeliver && (!bq.TurnIn || bq.Need != int(j.qty)) {
			t.Fatalf("delivery quest %+v", bq)
		}
		if j.kind != quests.BountyDeliver && bq.Markers[0].R < 30 {
			t.Fatalf("target area %+v", bq.Markers[0])
		}
	}

	// Persisted: a reconnect keeps every held bounty.
	a.c.Close(1000, "")
	deadline := time.Now().Add(3 * time.Second)
	for {
		store.mu.Lock()
		n := len(quests.Load(store.logs[char]).Active)
		store.mu.Unlock()
		if n >= len(jobs)+1 { // + the starter quest
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("bounties not saved (%d)", n)
		}
		time.Sleep(20 * time.Millisecond)
	}
	a = h.dial("")
	a.join(h, char, "Hunter")
	l = a.questLog(t)
	for _, j := range jobs {
		if l.find(j.id) == nil {
			t.Fatalf("bounty %d lost over a reconnect", j.id)
		}
	}
	// The board still says held.
	a.send(&proto.Interact{TargetKind: InteractBoard, TargetID: board.ID, Action: 1})
	if again := a.take(EventBounties, 3*time.Second); again.Data[2+13] != 1 {
		t.Fatal("board lost the held flag after reconnect")
	}

	// Completion: deliveries at the board (first, before walking away),
	// explore/clear on arrival.
	sort.SliceStable(jobs, func(x, y int) bool {
		return jobs[x].kind == quests.BountyDeliver && jobs[y].kind != quests.BountyDeliver
	})
	for _, j := range jobs {
		switch j.kind {
		case quests.BountyDeliver:
			bq := l.find(j.id)
			var item string
			_ = h.srv.Do(context.Background(), func() {
				item = h.srv.byChar[char].quests.log.Find(j.id).Current().Obj.Items[0].Item
			})
			addItems(t, h, char, item, int(j.qty))
			a.send(&proto.Interact{TargetKind: InteractBoard, TargetID: board.ID, Action: 1})
			done := a.take(EventQuestCompleted, 3*time.Second)
			if done.TargetID != j.id || int(done.Value) != bq.Gold {
				t.Fatalf("delivery completed %+v", done)
			}
			if findItem(a.inventory(t), item) != nil {
				t.Fatalf("delivered %s still in the bag", item)
			}
			t.Logf("delivered %d x %s for %d gold", j.qty, item, done.Value)
		case quests.BountyExplore:
			m := l.find(j.id).Markers[0]
			_ = h.srv.Do(context.Background(), func() {
				h.srv.Teleport(h.srv.byChar[char].ent, movement.Vec3{X: m.X, Y: g.HeightAt(m.X, m.Z), Z: m.Z})
			})
			done := a.take(EventQuestCompleted, 5*time.Second)
			if done.TargetID != j.id {
				t.Fatalf("explore completed %+v", done)
			}
			t.Logf("explored %q", l.find(j.id).Title)
		}
	}

	// Abandon one still held.
	l = a.questLog(t)
	for _, wq := range l.Quests {
		if wq.Kind == quests.KindBounty {
			a.interact(InteractQuest, uint64(wq.ID), QuestActAbandon, 0)
			deadline := time.Now().Add(3 * time.Second)
			for a.questLog(t).find(wq.ID) != nil && time.Now().Before(deadline) {
			}
			if a.questLog(t).find(wq.ID) != nil {
				t.Fatal("abandon did not remove the bounty")
			}
			break
		}
	}
}

func TestQuestLogHandoffField(t *testing.T) {
	var f *HandoffField
	for i := range handoffFields {
		if handoffFields[i].Name == "quests" {
			f = &handoffFields[i]
		}
	}
	if f == nil {
		t.Fatal("no quests handoff field")
	}
	l := quests.NewLog()
	_ = l.Add(quests.FromBounty(quests.BountyInfo{ID: 5, Kind: quests.BountyExplore, Site: 3, Text: "Scout"}, 0))
	s := &Server{byChar: map[string]*session{"c": {quests: &questState{log: l}}}}
	e := &Entity{CharacterID: "c"}
	raw := f.Save(s, e)
	s2 := &Server{}
	f.Load(s2, e, raw)
	if h := s2.qst.handed["c"]; h == nil || h.Find(5) == nil {
		t.Fatalf("handed %s", raw)
	}
}
