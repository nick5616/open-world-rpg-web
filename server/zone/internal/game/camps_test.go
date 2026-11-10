package game

// Camps (CR 025) in-process on the official world (real towns, atlas,
// terrain): placement (valid, refused: in a town, out of reach, overlapping,
// too many of a kind, someone else's piece), ownership (pick up, chests
// locked to the owner), a storage chest round trip, persistence through the
// store and a restart, decay, the campfire keeping demons away (spawn
// spots, demon steps, sheltered players; burnt out: no more), Rested and
// the bedroll respawn, and solid pieces in the movement step.

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"sync"
	"testing"
	"time"

	"lodestone/server/pkg/campdefs"
	"lodestone/server/pkg/camps"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/writebehind"
	"lodestone/server/zone/internal/chem"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/night"
)

type memCampStore struct {
	mu   sync.Mutex
	rows map[uint64]CampRow
}

func (m *memCampStore) LoadCamps(_ context.Context, _ string) ([]CampRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []CampRow
	for _, r := range m.rows {
		out = append(out, r)
	}
	return out, nil
}

func (m *memCampStore) SaveCamp(_ context.Context, _, _ string, r CampRow) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rows[r.ID] = r
	return nil
}

func (m *memCampStore) DeleteCamp(_ context.Context, _ string, id uint64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.rows, id)
	return nil
}

func (m *memCampStore) has(id uint64) (CampRow, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[id]
	return r, ok
}

func (m *memCampStore) waitFor(t *testing.T, id uint64, present bool) CampRow {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		r, ok := m.has(id)
		if ok == present {
			return r
		}
		if time.Now().After(deadline) {
			t.Fatalf("camp row %d present=%v never happened", id, present)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

type campRig struct {
	*harness
	store *memCampStore
	chars *fakeStore
}

func campHarness(t *testing.T, store *memCampStore, nightHour float64) *campRig {
	t.Helper()
	w, g := testTowns(t)
	ex := realExplore(t, g)
	if store == nil {
		store = &memCampStore{rows: map[uint64]CampRow{}}
	}
	chars := &fakeStore{saves: map[string]movement.Vec3{}, rows: map[string]movement.Vec3{}}
	q := writebehind.New(100)
	q.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	qctx, stopQ := context.WithCancel(context.Background())
	t.Cleanup(stopQ)
	go q.Run(qctx)
	h := newHarnessPre(t, func(c *Config) {
		c.Ground = g
		c.Towns = w
		c.Explore = ex
		c.Store = chars
		c.Queue = q
		c.CampStore = store
		c.TimeOffsetS = offsetFor(nightHour)
		c.Night = &NightSetup{World: &night.World{Seed: 42, Intensity: 0.5}, Overlay: &chem.Overlay{}, WindDeg: 270, Dev: true, NoDemons: true, Force: -1}
		c.Combat = &CombatSetup{Dev: true, Config: combat.Config{Seed: 42, NoWildPacks: true}}
	}, func(s *Server) {
		if _, err := s.RestoreCamps(context.Background()); err != nil {
			t.Fatal(err)
		}
	})
	h.srv.SetWorldEvents(false)
	return &campRig{harness: h, store: store, chars: chars}
}

// openSpot finds gentle open ground outside every settlement where a
// workbench (the biggest piece) fits, with room around it.
func (r *campRig) openSpot(t *testing.T) (float64, float64) {
	t.Helper()
	var x, z float64
	found := false
	r.do(func() {
		env := campEnv{r.srv}
		for si := range r.srv.cfg.Towns.T.Settlements {
			st := &r.srv.cfg.Towns.T.Settlements[si]
			for k := 0; k < 24 && !found; k++ {
				a := float64(k) / 24 * 2 * math.Pi
				cx, cz := st.X+math.Cos(a)*(st.Radius+70), st.Z+math.Sin(a)*(st.Radius+70)
				ok := true
				for _, d := range [][2]float64{{0, 0}, {6, 0}, {-6, 0}, {0, 6}, {0, -6}, {4, 4}} {
					if _, why := camps.Check(camps.Want{Kind: campdefs.Workbench, X: cx + d[0], Z: cz + d[1], Owner: "probe", FeetX: cx + d[0] - 2, FeetY: 1e4, FeetZ: cz + d[1]}, nil, env); why != 0 {
						ok = false
						break
					}
				}
				if ok && env.HeightAt(cx, cz) > 10 {
					x, z, found = cx, cz, true
				}
			}
			if found {
				break
			}
		}
	})
	if !found {
		t.Fatal("no open camp spot on the official world")
	}
	return x, z
}

func placeID(kind, rot int, x, z float64) uint64 {
	return uint64(kind) | uint64(rot)<<8 | uint64(camps.M2Cm(x))<<16 | uint64(camps.M2Cm(z))<<40
}

func (r *campRig) join(t *testing.T, char, name string, x, z float64) *client {
	t.Helper()
	r.chars.rows[char] = movement.Vec3{X: x, Y: r.srv.cfg.Ground.HeightAt(x, z) + 0.2, Z: z}
	c := r.dial("")
	c.join(r.harness, char, name)
	c.take(EventCampMine, 3*time.Second)
	return c
}

// placed waits for this client's own placement (1101 value 1 by its entity).
func (cl *client) placed(t *testing.T) (uint64, *proto.Event) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		for i, e := range cl.evs {
			if e.Kind == EventCampRefused {
				t.Fatalf("placement refused: reason %d", e.Value)
			}
			if e.Kind == EventCampPiece && e.Value == 1 {
				cl.evs = append(cl.evs[:i:i], cl.evs[i+1:]...)
				return binary.LittleEndian.Uint64(e.Data), e
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("no placement event")
		}
		cl.pump(40 * time.Millisecond)
	}
}

func (cl *client) refused(t *testing.T, want int) {
	t.Helper()
	e := cl.take(EventCampRefused, 3*time.Second)
	if int(e.Value) != want {
		t.Fatalf("refusal %d, want %d", e.Value, want)
	}
}

func TestCampPlaceRulesOwnershipChestPersistence(t *testing.T) {
	r := campHarness(t, nil, 12)
	x, z := r.openSpot(t)
	const A, B = "c0000000-0000-0000-0000-00000000000a", "c0000000-0000-0000-0000-00000000000b"
	a := r.join(t, A, "Ash", x-2, z)
	a.interact(InteractCamp, 0, CampActDev, 0)
	if inv := a.inventory(t); findItem(inv, "camp:campfire") == nil || findItem(inv, "wood:firewood") == nil {
		t.Fatalf("dev grant: %+v", inv.Items)
	}

	// Without a kit nothing happens; in a town and out of reach are refused.
	st := &r.srv.cfg.Towns.T.Settlements[0]
	a.interact(InteractCamp, placeID(campdefs.Chest, 0, x+30, z), CampActPlace, 0)
	a.refused(t, camps.RefuseTooFar)
	r.teleport(A, st.X+2, st.Z+2)
	a.interact(InteractCamp, placeID(campdefs.Chest, 0, st.X+4, st.Z+2), CampActPlace, 0)
	a.refused(t, camps.RefuseTown)
	r.teleport(A, x-2, z)
	a.pump(200 * time.Millisecond)

	// A campfire, then a chest beside it.
	a.interact(InteractCamp, placeID(campdefs.Campfire, 0, x, z), CampActPlace, 0)
	fire, ev := a.placed(t)
	if ev.Data[8] != byte(campdefs.Campfire) || ev.Data[22]&1 == 0 || ev.Data[22]&8 == 0 {
		t.Fatalf("campfire record %v (want mine + burning)", ev.Data[:28])
	}
	row := r.store.waitFor(t, fire, true)
	if row.Owner != A || row.Kind != campdefs.Campfire || row.BurnUntil <= 0 {
		t.Fatalf("stored %+v", row)
	}
	a.interact(InteractCamp, placeID(campdefs.Chest, 2, x, z+2.2), CampActPlace, 0)
	chest, _ := a.placed(t)
	// Overlapping the chest, and a third campfire's kit is not there (two max: one more is fine, then refused).
	a.interact(InteractCamp, placeID(campdefs.Workbench, 0, x+0.2, z+2.2), CampActPlace, 0)
	a.refused(t, camps.RefuseBlocked)
	a.interact(InteractCamp, placeID(campdefs.Campfire, 0, x+3, z-2), CampActPlace, 0)
	fire2, _ := a.placed(t)
	addItems(t, r.harness, A, "camp:campfire", 1)
	a.interact(InteractCamp, placeID(campdefs.Campfire, 0, x-3, z-3), CampActPlace, 0)
	a.refused(t, camps.RefuseKindLimit)

	// B joins nearby: sees the pieces (1100 area baseline), can't pick them up or open the chest.
	b := r.join(t, B, "Birch", x-3, z+4)
	area := b.take(EventCampArea, 3*time.Second)
	if n := binary.LittleEndian.Uint16(area.Data[5:]); n != 3 {
		t.Fatalf("B's baseline lists %d pieces, want 3", n)
	}
	b.interact(InteractCamp, fire, CampActPickup, 0)
	b.refused(t, camps.RefuseNotYours)
	b.interact(InteractCamp, chest, CampActUse, 0)
	b.refused(t, camps.RefuseLocked)
	// B can't place right beside A's camp.
	addItems(t, r.harness, B, "camp:signpost", 1)
	b.interact(InteractCamp, placeID(campdefs.Signpost, 0, x-3, z+5), CampActPlace, 0)
	b.refused(t, camps.RefuseOtherCamp)

	// The chest: put firewood in, see it, can't pick the chest up while full, take it back.
	a.interact(InteractCamp, chest, CampActUse, 0)
	a.take(EventCampChest, 3*time.Second)
	inv := a.inventory(t)
	wood := findItem(inv, "wood:firewood")
	before := wood.Qty
	a.interact(InteractCamp, chest|uint64(5)<<40, CampActPut, wood.H)
	var cj chestJSON
	if err := json.Unmarshal(a.take(EventCampChest, 3*time.Second).Data, &cj); err != nil || cj.Slots[0] == nil || cj.Slots[0].Base != "wood:firewood" || cj.Slots[0].Qty != 5 {
		t.Fatalf("chest after put: %+v %v", cj, err)
	}
	if w := findItem(a.inventory(t), "wood:firewood"); w == nil || w.Qty != before-5 {
		t.Fatalf("pack after put: %+v", w)
	}
	a.interact(InteractCamp, chest, CampActPickup, 0)
	a.refused(t, camps.RefuseNotEmpty)
	// Shared with the party: B (same party) may open it.
	r.do(func() {
		r.srv.setParty(r.srv.byChar[A].ent, "party-1")
		r.srv.setParty(r.srv.byChar[B].ent, "party-1")
	})
	a.interact(InteractCamp, chest, CampActLock, 1)
	a.take(EventCampChest, 3*time.Second)
	b.interact(InteractCamp, chest, CampActUse, 0)
	if err := json.Unmarshal(b.take(EventCampChest, 3*time.Second).Data, &cj); err != nil || !cj.Open || cj.Slots[0] == nil {
		t.Fatalf("B's view of the shared chest: %+v %v", cj, err)
	}
	b.interact(InteractCamp, chest|0<<40, CampActTake, 0)
	b.pump(300 * time.Millisecond)
	if w := findItem(b.inventory(t), "wood:firewood"); w == nil || w.Qty != 5 {
		t.Fatalf("B took %+v", w)
	}

	// Pick the second campfire up: the kit comes back, the row goes, B sees it go.
	a.interact(InteractCamp, fire2, CampActPickup, 0)
	gone := b.take(EventCampRemoved, 3*time.Second)
	if binary.LittleEndian.Uint64(gone.Data) != fire2 || gone.Value != 1 {
		t.Fatalf("removed %+v", gone)
	}
	r.store.waitFor(t, fire2, false)
	if k := findItem(a.inventory(t), "camp:campfire"); k == nil || k.Qty < 2 {
		t.Fatalf("kit not refunded: %+v", k)
	}

	// A restart restores the pieces from the store.
	time.Sleep(200 * time.Millisecond)
	r2 := campHarness(t, r.store, 12)
	var raw []byte
	r2.do(func() { raw, _ = json.Marshal(r2.srv.CampDebug()) })
	var dbg struct {
		Pieces []struct {
			ID   uint64 `json:"id"`
			Kind string `json:"kind"`
		} `json:"pieces"`
	}
	if err := json.Unmarshal(raw, &dbg); err != nil || len(dbg.Pieces) != 2 {
		t.Fatalf("restored %s (%v), want 2 pieces (campfire, chest)", raw, err)
	}
}

func TestCampFireKeepsDemonsAwayAndBurnsOut(t *testing.T) {
	r := campHarness(t, nil, 21)
	x, z := r.openSpot(t)
	const A = "c0000000-0000-0000-0000-0000000000f1"
	a := r.join(t, A, "Ember", x-2, z)
	a.interact(InteractCamp, 0, CampActDev, 0)
	a.inventory(t)
	// Before the fire: demons may rise 8 m away and step anywhere.
	var spotBefore bool
	demon := &combat.Enemy{Demon: &combat.DemonState{Rank: "lesser"}}
	r.do(func() { spotBefore = r.srv.spawnSpot(x+40, z) })
	a.interact(InteractCamp, placeID(campdefs.Campfire, 0, x, z), CampActPlace, 0)
	fire, _ := a.placed(t)
	r.teleport(A, x-40, z) // spawn spots are refused within 24 m of a player anyway
	r.do(func() {
		s := r.srv
		safe := campdefs.D.Fire.SafeRadiusM
		if !s.campSafeAt(x+safe-1, z, 0) || s.campSafeAt(x+safe+1, z, 0) {
			t.Error("campSafeAt: the circle is wrong")
		}
		if s.spawnSpot(x+safe+2, z) {
			t.Error("demons may rise just outside a burning campfire's circle (want the margin)")
		}
		if !s.demonBlocked(demon, x+3, z) {
			t.Error("a demon may step into a burning campfire's circle")
		}
		if !s.demonSheltered(demon, &combat.Player{Pos: movement.Vec3{X: x + 2, Z: z}}) {
			t.Error("a player by the fire is not sheltered")
		}
		// Burnt out: no more protection.
		s.camp.pieces[fire].BurnUntil = s.worldTimeS() - 1
		s.campFires()
		if s.campSafeAt(x+1, z, 0) || s.demonBlocked(demon, x+3, z) {
			t.Error("a cold campfire still keeps demons away")
		}
	})
	_ = spotBefore
	r.teleport(A, x-2, z)
	a.pump(200 * time.Millisecond)
	// Firewood relights it and reports the hours.
	a.interact(InteractCamp, fire, CampActFuel, 2)
	note := a.take(EventCampNote, 3*time.Second)
	if note.Value != 1 {
		t.Fatalf("fuel note %+v", note)
	}
	r.do(func() {
		s := r.srv
		left := (s.camp.pieces[fire].BurnUntil - s.worldTimeS()) / camps.HourS
		if math.Abs(left-2*campdefs.D.Fire.HoursPerWood) > 0.05 {
			t.Errorf("relit for %.2f h, want %v", left, 2*campdefs.D.Fire.HoursPerWood)
		}
		if !s.campSafeAt(x+1, z, 0) {
			t.Error("relit fire does not protect")
		}
	})
}

func TestCampRestedRespawnAndCollision(t *testing.T) {
	r := campHarness(t, nil, 22)
	x, z := r.openSpot(t)
	const A = "c0000000-0000-0000-0000-0000000000b1"
	a := r.join(t, A, "Moss", x-2, z)
	a.interact(InteractCamp, 0, CampActDev, 0)
	a.inventory(t)
	var stamBefore int
	r.do(func() { stamBefore = r.srv.byChar[A].ent.Move.StaminaMax })
	a.interact(InteractCamp, placeID(campdefs.Campfire, 0, x, z+3), CampActPlace, 0)
	a.placed(t)
	a.interact(InteractCamp, placeID(campdefs.Bedroll, 0, x, z), CampActPlace, 0)
	bed, _ := a.placed(t)
	a.interact(InteractCamp, bed, CampActUse, 0)
	rest := a.take(EventCampRested, 3*time.Second)
	want := campdefs.D.Rested.DurationS + campdefs.D.Rested.FireBonusS // the fire is within warmthM
	if math.Abs(float64(rest.Value)-want) > 2 {
		t.Fatalf("rested for %d s, want %v", rest.Value, want)
	}
	r.do(func() {
		s := r.srv
		e := s.byChar[A].ent
		if got := e.Move.StaminaMax - stamBefore; got != int(math.Round(campdefs.D.Rested.StaminaBonus*constants.StaminaFinePerPoint)) {
			t.Errorf("stamina wheel grew by %d fine units", got)
		}
		if e.cbt.RegenMult != campdefs.D.Rested.RegenMult {
			t.Errorf("regen mult %v", e.cbt.RegenMult)
		}
		sp := s.RespawnPoint(e)
		if math.Hypot(sp.X-x, sp.Z-z) > 3 {
			t.Errorf("respawn %v, want beside the bedroll at (%v, %v)", sp, x, z)
		}
		// Rested ends: the wheel shrinks back.
		s.byChar[A].camp.restedUntil = s.cfg.Now().Add(-time.Second)
	})
	a.take(EventCampRested, 3*time.Second) // value 0: over
	r.do(func() {
		e := r.srv.byChar[A].ent
		if e.Move.StaminaMax != stamBefore || e.cbt.RegenMult != 0 {
			t.Errorf("after Rested: stamina %d (was %d), regen %v", e.Move.StaminaMax, stamBefore, e.cbt.RegenMult)
		}
	})

	// A solid chest: the movement step's ground pushes a body out of it.
	a.interact(InteractCamp, placeID(campdefs.Chest, 0, x+3, z), CampActPlace, 0)
	chest, _ := a.placed(t)
	r.do(func() {
		s := r.srv
		p := s.camp.pieces[chest]
		sess := s.byChar[A]
		s.Teleport(sess.ent, movement.Vec3{X: p.X - 1.5, Y: p.Y, Z: p.Z})
		g := s.frameGround(sess, sess.ent.LastSeq+1)
		lv := movement.AtLevel(g, p.Y)
		col, ok := lv.(movement.Collider)
		if !ok {
			t.Fatal("the frame ground near a chest has no push-out")
		}
		res := col.Collide(p.X-0.5, p.Y, p.Z) // inside the chest's west half
		if res.X > p.X-0.6-constants.PlayerCapsuleRadius+1e-9 || res.PushX >= 0 {
			t.Errorf("not pushed out of the chest: %+v (chest at %v)", res, p.X)
		}
		// Enemies walk around it too.
		if !s.enemyBlocked(p.X, p.Y, p.Z, 0.5, 1.8) {
			t.Error("enemies may walk through a chest")
		}
	})
}

func TestCampDecay(t *testing.T) {
	r := campHarness(t, nil, 12)
	x, z := r.openSpot(t)
	const A = "c0000000-0000-0000-0000-0000000000d1"
	a := r.join(t, A, "Fern", x-2, z)
	a.interact(InteractCamp, 0, CampActDev, 0)
	a.inventory(t)
	a.interact(InteractCamp, placeID(campdefs.Signpost, 0, x, z), CampActPlace, 0)
	sign, _ := a.placed(t)
	r.store.waitFor(t, sign, true)
	// Owner online: never decays, even if the clock says so.
	days := time.Duration(campdefs.D.Decay.Days * 24 * float64(time.Hour))
	r.do(func() {
		r.srv.camp.pieces[sign].SeenAt = r.srv.cfg.Now().Add(-days - time.Hour)
		r.srv.campDecay(r.srv.cfg.Now())
		if r.srv.camp.pieces[sign] == nil {
			t.Error("decayed while the owner is online")
		}
	})
	a.c.Close(1000, "")
	time.Sleep(300 * time.Millisecond)
	// Recently seen (the leave just stamped it): stays.
	r.do(func() {
		r.srv.campDecay(r.srv.cfg.Now())
		if r.srv.camp.pieces[sign] == nil {
			t.Error("decayed right after the owner left")
		}
		r.srv.camp.pieces[sign].SeenAt = r.srv.cfg.Now().Add(-days - time.Hour)
		r.srv.campDecay(r.srv.cfg.Now())
		if r.srv.camp.pieces[sign] != nil {
			t.Error("not decayed after decay.days unseen")
		}
	})
	r.store.waitFor(t, sign, false)
}
