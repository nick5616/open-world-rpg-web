package game

// Pets (CR 029) in-process on the official world: a weakened creature
// calms only for someone carrying its food; feeding it from afar is
// refused; the taming meter fills and the roll tames it (the pet is a
// snapshot entity with the pet bit and its owner's nameplate, persisted);
// walking away interrupts a meter (it turns on you); commands; a knockout
// sends it home (it comes back after the recovery, not before); the stable
// is only at your camp or in a town; a restart and a handoff keep the pets.

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"strings"
	"sync"
	"testing"
	"time"

	"lodestone/server/pkg/contentdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/writebehind"
	"lodestone/server/zone/internal/chem"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/content"
	"lodestone/server/zone/internal/night"
)

type petStore struct {
	*fakeStore
	mu   sync.Mutex
	pets map[string][]byte
}

func (m *petStore) LoadPets(_ context.Context, id string) ([]byte, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.pets[id]
	return b, ok, nil
}

func (m *petStore) SavePets(_ context.Context, id string, data []byte, _ int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pets[id] = append([]byte(nil), data...)
	return nil
}

func (m *petStore) get(id string) *content.PetState {
	m.mu.Lock()
	defer m.mu.Unlock()
	return content.LoadPets(m.pets[id])
}

type petRig struct {
	*harness
	store *petStore
}

func petHarness(t *testing.T, store *petStore) *petRig {
	t.Helper()
	w, g := testTowns(t)
	ex := realExplore(t, g)
	if store == nil {
		store = &petStore{fakeStore: &fakeStore{saves: map[string]movement.Vec3{}, rows: map[string]movement.Vec3{}}, pets: map[string][]byte{}}
	}
	q := writebehind.New(100)
	q.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	qctx, stopQ := context.WithCancel(context.Background())
	t.Cleanup(stopQ)
	go q.Run(qctx)
	h := newHarness(t, func(c *Config) {
		c.Ground = g
		c.Towns = w
		c.Explore = ex
		c.Store = store
		c.Queue = q
		c.TimeOffsetS = offsetFor(12)
		c.Night = &NightSetup{World: &night.World{Seed: 42, Intensity: 0.5}, Overlay: &chem.Overlay{}, WindDeg: 270, Dev: true, NoDemons: true, Force: -1}
		c.Combat = &CombatSetup{Dev: true, Config: combat.Config{Seed: 42, NoWildPacks: true}}
	})
	h.srv.SetWorldEvents(false)
	return &petRig{harness: h, store: store}
}

// openSpot: dry, gentle ground outside every settlement, and a point in a town.
func (r *petRig) spots(t *testing.T) (wx, wz, tx, tz float64) {
	t.Helper()
	found := false
	r.do(func() {
		s := r.srv
		st := &s.cfg.Towns.T.Settlements[0]
		tx, tz = st.X, st.Z
		for si := range s.cfg.Towns.T.Settlements {
			st := &s.cfg.Towns.T.Settlements[si]
			for k := 0; k < 36 && !found; k++ {
				a := float64(k) / 36 * 2 * math.Pi
				cx, cz := st.X+math.Cos(a)*(st.Radius+70), st.Z+math.Sin(a)*(st.Radius+70)
				ok := true
				for d := -12.0; d <= 12 && ok; d += 3 {
					ok = s.steedSpotOK(cx+d, cz) && s.steedSpotOK(cx, cz+d) && movement.SlopeAt(s.cfg.Ground, cx+d, cz).T2 < 0.06
				}
				if ok {
					wx, wz, found = cx, cz, true
				}
			}
			if found {
				break
			}
		}
	})
	if !found {
		t.Fatal("no open ground")
	}
	return
}

func (r *petRig) join(t *testing.T, char, name string, x, z float64) *client {
	t.Helper()
	r.store.rows[char] = movement.Vec3{X: x, Y: r.srv.cfg.Ground.HeightAt(x, z), Z: z}
	c := r.dial("")
	c.join(r.harness, char, name)
	c.pump(300 * time.Millisecond)
	return c
}

func petSync(t *testing.T, e *proto.Event) petSyncJSON {
	t.Helper()
	var j petSyncJSON
	if err := json.Unmarshal(e.Data, &j); err != nil {
		t.Fatal(err)
	}
	return j
}

// waitSync consumes 1200s until one satisfies ok.
func (cl *client) waitSync(t *testing.T, what string, ok func(petSyncJSON) bool) petSyncJSON {
	t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	var last petSyncJSON
	for {
		for i := 0; i < len(cl.evs); i++ {
			if e := cl.evs[i]; e.Kind == EventPetSync {
				cl.evs = append(cl.evs[:i:i], cl.evs[i+1:]...)
				i--
				last = petSync(t, e)
				if ok(last) {
					return last
				}
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s: last sync %+v", what, last)
		}
		cl.pump(40 * time.Millisecond)
	}
}

func (cl *client) petRefused(t *testing.T, want int) {
	t.Helper()
	if e := cl.take(EventPetRefused, 3*time.Second); int(e.Value) != want {
		t.Fatalf("refusal %d, want %d", e.Value, want)
	}
}

// calmed: dev-spawn a weakened creature of species near the player and
// wait for its calm (1201); 0 when none comes within wait.
func (r *petRig) calmed(t *testing.T, cl *client, species int, wait time.Duration) uint32 {
	t.Helper()
	cl.interact(InteractPet, uint64(species), PetActDev, 2)
	deadline := time.Now().Add(wait)
	for time.Now().Before(deadline) {
		for i, e := range cl.evs {
			if e.Kind == EventTameCalm && e.Value > 0 {
				cl.evs = append(cl.evs[:i:i], cl.evs[i+1:]...)
				return e.EntityID
			}
		}
		cl.pump(40 * time.Millisecond)
	}
	return 0
}

func (r *petRig) creaturePos(id uint32) (p movement.Vec3) {
	r.do(func() {
		if en := r.srv.cbt.w.Enemy(id); en != nil {
			p = en.Pos
		}
	})
	return
}

func TestTamingLifecycleOnTheOfficialWorld(t *testing.T) {
	r := petHarness(t, nil)
	wx, wz, tx, tz := r.spots(t)
	const A = "c0000000-0000-0000-0000-00000000e1a1"
	a := r.join(t, A, "Ash", wx, wz)
	aid := a.welc.EntityID
	slime := contentdefs.D.PetByKey("slime")

	// Weakened, but nobody carries its food: it fights on.
	if id := r.calmed(t, a, slime.ID, 2500*time.Millisecond); id != 0 {
		t.Fatal("calmed without food")
	}
	r.do(func() { // clear that slime away
		for _, en := range r.srv.cbt.w.Enemies() {
			r.srv.cbt.w.Slay(en, 0)
		}
	})
	a.pump(200 * time.Millisecond)

	// With its favourite food, a weakened slime calms.
	addItems(t, r.harness, A, slime.Foods[0], 6)
	a.pump(200 * time.Millisecond)
	var petID int
	for try := 0; try < 4 && petID == 0; try++ {
		id := r.calmed(t, a, slime.ID, 3*time.Second)
		if id == 0 {
			t.Fatal("a weakened slime never calmed for its food's carrier")
		}
		p := r.creaturePos(id)
		// Out of reach: refused.
		r.teleport(A, p.X+9, p.Z)
		a.pump(100 * time.Millisecond)
		a.interact(InteractPet, uint64(id), PetActFeed, 0)
		a.petRefused(t, PetRefuseFar)
		r.teleport(A, p.X+1.8, p.Z)
		a.pump(100 * time.Millisecond)
		a.interact(InteractPet, uint64(id), PetActFeed, 0)
		st := a.take(EventTameProgress, 3*time.Second)
		if st.Value != TameStarted || st.EntityID != id {
			t.Fatalf("meter %+v", st)
		}
		var j tameJSON
		_ = json.Unmarshal(st.Data, &j)
		if !j.Fav || j.Ms <= 0 || j.Ms > int64(slime.TameS*1000) {
			t.Fatalf("meter %+v", j)
		}
		end := a.take(EventTameProgress, time.Duration(j.Ms+3000)*time.Millisecond)
		switch end.Value {
		case TameTamed:
			petID = int(end.TargetID)
		case TameFailed:
			r.do(func() {
				if en := r.srv.cbt.w.Enemy(id); en != nil {
					r.srv.cbt.w.Slay(en, 0)
				}
			})
		default:
			t.Fatalf("meter ended %+v", end)
		}
	}
	if petID == 0 {
		t.Fatal("four favourite-food tamings all failed")
	}
	// The pet is out: a sync, an entity with the pet bit and the owner's nameplate.
	sj := a.waitSync(t, "pet out", func(j petSyncJSON) bool { return len(j.Pets) == 1 && j.Pets[0].Out != 0 })
	out := sj.Pets[0].Out
	if sj.Active != petID || sj.Pets[0].Species != "slime" || sj.Pets[0].Level < 1 {
		t.Fatalf("sync %+v", sj)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		a.pump(40 * time.Millisecond)
		if a.frame != nil {
			if e := a.frame.Find(out); e != nil && e.Kind == proto.EntityKindEffect && e.TypeID&combat.PetTypeBit != 0 && strings.HasPrefix(e.Name, "Ash's ") {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("the pet never showed in the snapshot")
		}
	}
	deadline = time.Now().Add(3 * time.Second)
	for len(r.store.get(A).Pets) != 1 {
		if time.Now().After(deadline) {
			t.Fatal("the pet was never saved")
		}
		time.Sleep(30 * time.Millisecond)
	}

	// A second taming walked away from: interrupted, the wolf turns on you.
	wolf := contentdefs.D.PetByKey("wolf")
	addItems(t, r.harness, A, wolf.Foods[0], 2)
	a.pump(150 * time.Millisecond)
	id := r.calmed(t, a, wolf.ID, 3*time.Second)
	if id == 0 {
		t.Fatal("no calm wolf")
	}
	p := r.creaturePos(id)
	r.teleport(A, p.X+1.8, p.Z)
	a.pump(100 * time.Millisecond)
	a.interact(InteractPet, uint64(id), PetActFeed, 0)
	if e := a.take(EventTameProgress, 3*time.Second); e.Value != TameStarted {
		t.Fatalf("wolf meter %+v", e)
	}
	r.teleport(A, p.X+16, p.Z)
	e := a.take(EventTameProgress, 3*time.Second)
	var j tameJSON
	_ = json.Unmarshal(e.Data, &j)
	if e.Value != TameInterrupted || j.Reason != TameWhyAway {
		t.Fatalf("interrupt %+v %+v", e, j)
	}
	r.do(func() {
		if en := r.srv.cbt.w.Enemy(id); en != nil {
			if en.Calm(r.srv.cbt.w.Tick()) {
				t.Error("still calm after the interrupt")
			}
			r.srv.cbt.w.Slay(en, 0)
		}
	})

	// Commands: stay, then follow.
	a.interact(InteractPet, 0, PetActCommand, PetCmdStay)
	a.waitSync(t, "stay", func(j petSyncJSON) bool { return j.Mode == combat.PetStay })
	a.interact(InteractPet, 0, PetActCommand, PetCmdFollow)
	a.waitSync(t, "follow", func(j petSyncJSON) bool { return j.Mode == combat.PetFollow })

	// The stable is not out here.
	a.interact(InteractPet, 0, PetActStable, 0)
	a.petRefused(t, PetRefuseStable)

	// Knocked out: home to recover; it does not come back before.
	r.do(func() {
		if en := r.srv.cbt.w.Summon(out); en != nil {
			r.srv.cbt.w.HurtPet(en, 1e6, 0)
		}
	})
	if n := a.take(EventPetNote, 3*time.Second); n.Value != PetNoteKO {
		t.Fatalf("note %+v", n)
	}
	a.waitSync(t, "knocked out", func(j petSyncJSON) bool {
		return j.Pets[0].Out == 0 && j.Pets[0].KOMs > 0 && j.Active == petID
	})
	a.pump(1500 * time.Millisecond)
	r.do(func() {
		if r.srv.cbt.w.PetOf(aid) != nil {
			t.Error("a knocked-out pet came back at once")
		}
		// the recovery is over: it comes back on its own
		rec := r.srv.byChar[A].pets.st.ActivePet()
		rec.KOUntil = time.Now().Add(-time.Second).UnixMilli()
	})
	if n := a.take(EventPetNote, 3*time.Second); n.Value != PetNoteBack {
		t.Fatalf("back note %+v", n)
	}

	// In a town: the stable works.
	r.teleport(A, tx, tz)
	a.pump(1200 * time.Millisecond)
	a.interact(InteractPet, 0, PetActStable, 0)
	a.waitSync(t, "stabled", func(j petSyncJSON) bool { return j.Active == 0 && j.Stable })
	a.interact(InteractPet, uint64(petID), PetActTakeOut, 0)
	a.waitSync(t, "taken out", func(j petSyncJSON) bool { return j.Active == petID && j.Pets[0].Out != 0 })
	// A name.
	for i, chunk := range []uint32{'B' | 'l'<<8 | 'o'<<16 | 'b'<<24, 'b' | 'y'<<8} {
		a.interact(InteractPet, uint64(petID)|uint64(i)<<16, PetActName, chunk)
	}
	if n := a.take(EventPetNote, 3*time.Second); n.Value != PetNoteNamed {
		t.Fatalf("name note %+v", n)
	}
	deadline = time.Now().Add(3 * time.Second)
	for {
		if st := r.store.get(A); len(st.Pets) == 1 && st.Pets[0].Name == "Blobby" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("name not saved: %+v", r.store.get(A))
		}
		time.Sleep(30 * time.Millisecond)
	}

	// A restart: the pet is still yours and comes out with you.
	r2 := petHarness(t, r.store)
	c := r2.join(t, A, "Ash", tx, tz)
	sj = petSync(t, c.take(EventPetSync, 3*time.Second))
	if len(sj.Pets) != 1 || sj.Pets[0].Name != "Blobby" || sj.Active != petID {
		t.Fatalf("after restart %+v", sj)
	}
	deadline = time.Now().Add(4 * time.Second)
	for {
		ok := false
		r2.do(func() { ok = r2.srv.cbt.w.PetOf(c.welc.EntityID) != nil })
		if ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the pet did not come out after the restart")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestPetsHandoffField(t *testing.T) {
	var f *HandoffField
	for i := range handoffFields {
		if handoffFields[i].Name == "pets" {
			f = &handoffFields[i]
		}
	}
	if f == nil {
		t.Fatal("no pets handoff field")
	}
	s := New(Config{Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	st := &content.PetState{V: 1}
	st.Add(content.PetRec{Species: "wolf", Name: "Fang", Level: 4, HP: 0.6})
	st.Mode = combat.PetStay
	e := &Entity{CharacterID: "c1"}
	s.byChar["c1"] = &session{ent: e, pets: &petSess{st: st}}
	raw := f.Save(s, e)
	s2 := New(Config{Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	f.Load(s2, e, raw)
	h := s2.petsG.handed["c1"]
	if h == nil {
		t.Fatal("nothing handed")
	}
	got := content.LoadPets(h.St)
	if len(got.Pets) != 1 || got.Pets[0].Name != "Fang" || got.Pets[0].Level != 4 || got.Active != 1 || got.Mode != combat.PetStay {
		t.Fatalf("handed %+v", got)
	}
	// Nobody with pets: nothing rides the handoff.
	s.byChar["c2"] = &session{ent: &Entity{CharacterID: "c2"}, pets: &petSess{st: &content.PetState{V: 1}}}
	if f.Save(s, &Entity{CharacterID: "c2"}) != nil {
		t.Fatal("an empty pet state rode the handoff")
	}
}
