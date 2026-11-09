package game

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"log/slog"
	"math"
	"slices"
	"testing"
	"time"

	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/ticket"
	"lodestone/server/pkg/towns"
	"lodestone/server/pkg/writebehind"
	"lodestone/server/zone/internal/npc"
)

// testQueue is a running write-behind queue for one zone.
func testQueue(t *testing.T) *writebehind.Queue {
	q := writebehind.New(100)
	q.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go q.Run(ctx)
	return q
}

// spawnDoors: the doors of the spawn settlement's buildings, inn first.
func spawnDoors(t *testing.T, w *npc.World) (*towns.Doors, []int) {
	t.Helper()
	ds := towns.NewDoors(w.T)
	st := w.T.Settlements[spawnSettlement(t, w)]
	var out []int
	for b := st.BuildingFirst; b < st.BuildingFirst+st.Buildings; b++ {
		if d, ok := ds.ByBuilding[b]; ok {
			if w.T.Buildings[b].Role == towns.BuildingInn {
				out = append([]int{d}, out...)
			} else {
				out = append(out, d)
			}
		}
	}
	if len(out) < 3 {
		t.Fatalf("spawn settlement has %d doors", len(out))
	}
	return ds, out
}

func doorOpenOn(s *Server, d int) (open, pending bool) {
	_ = s.Do(context.Background(), func() { open, pending = s.DoorOpen(d) })
	return
}

// waitDoor waits until door d is settled at want on s.
func waitDoor(t *testing.T, s *Server, d int, want bool, what string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		open, pending := doorOpenOn(s, d)
		if open == want && !pending {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s: door %d open=%v pending=%v, want open=%v", what, d, open, pending, want)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func waitRow(t *testing.T, st *MemDoorStore, id uint64, open bool) DoorRow {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if r, ok := st.Row(testWorld, id); ok && r.Open == open {
			return r
		}
		if time.Now().After(deadline) {
			r, ok := st.Row(testWorld, id)
			t.Fatalf("door %d never stored open=%v (row %+v, %v)", id, open, r, ok)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// decodeDoorBase is Event 971's data: prop index -> open from its step.
func decodeDoorBase(t *testing.T, ev *proto.Event) map[int]bool {
	t.Helper()
	b := ev.Data
	if len(b) < 3 || b[0] != 1 {
		t.Fatalf("baseline data %x", b)
	}
	n := int(binary.LittleEndian.Uint16(b[1:3]))
	out := map[int]bool{}
	for i, o := 0, 3; i < n; i, o = i+1, o+10 {
		out[int(binary.LittleEndian.Uint32(b[o:]))] = b[o+5] == 1
	}
	return out
}

// Doors outlive the zone: closed doors are written (batched, by the zone
// that owns them) and a restarted zone starts with them closed; a player
// arriving gets them in the baseline (971). A change right before shutdown
// is flushed by Stop.
func TestDoorStateSurvivesRestart(t *testing.T) {
	w, g := testTowns(t)
	ds, doors := spawnDoors(t, w)
	store := NewMemDoorStore()
	cfg := func(c *Config) {
		c.Ground, c.Towns, c.TimeOffsetS = g, w, offsetFor(12)
		c.DoorStore, c.Queue = store, testQueue(t)
	}
	inn, house, shed := doors[0], doors[1], doors[2]
	h1 := newHarness(t, cfg)
	_ = h1.srv.Do(context.Background(), func() {
		h1.srv.doorWant(inn, false, 0, "")
		h1.srv.doorWant(house, false, 0, "")
	})
	waitDoor(t, h1.srv, house, false, "house closed")
	_ = h1.srv.Do(context.Background(), func() { h1.srv.doorWant(house, true, 0, "") }) // and opened again
	waitDoor(t, h1.srv, house, true, "house reopened")
	waitRow(t, store, ds.D[inn].ID, false)
	waitRow(t, store, ds.D[house].ID, true)
	saves, writers := store.Stats(ds.D[inn].ID)
	if saves > 3 || !slices.Equal(writers, []string{testZone}) {
		t.Fatalf("3 changes in about a second: %d writes (want batched), writers %v", saves, writers)
	}
	// A change in the last second before shutdown still lands.
	_ = h1.srv.Do(context.Background(), func() { h1.srv.doorWant(shed, false, 0, "") })
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	h1.srv.Stop(ctx)
	cancel()
	if r, ok := store.Row(testWorld, ds.D[shed].ID); !ok || r.Open {
		t.Fatalf("the change before shutdown was lost: %+v %v", r, ok)
	}

	restored := -1
	h2 := newHarnessPre(t, cfg, func(s *Server) {
		n, err := s.RestoreDoors(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		restored = n
	})
	if restored != 2 {
		t.Fatalf("restored %d closed doors, want 2 (inn, shed)", restored)
	}
	for d, want := range map[int]bool{inn: false, house: true, shed: false} {
		if open, pending := doorOpenOn(h2.srv, d); open != want || pending {
			t.Fatalf("after restart door %d open=%v pending=%v, want %v", d, open, pending, want)
		}
	}
	fx, fz := w.T.Buildings[ds.D[inn].Building].Door(3)
	cl := h2.dial(spawnAt(math.Round(fx*100)/100, math.Round(fz*100)/100))
	cl.join(h2, "late", "Latecomer")
	base := decodeDoorBase(t, cl.nextEvent(EventDoorBase, 3*time.Second))
	if open, ok := base[ds.D[inn].Prop]; !ok || open {
		t.Fatalf("baseline after restart: %v (inn prop %d should be listed closed)", base, ds.D[inn].Prop)
	}
	if _, ok := base[ds.D[house].Prop]; ok {
		t.Fatalf("baseline lists the reopened house door: %v", base)
	}
}

// joinZone connects a plain (non-handoff) client to one cluster zone.
func joinZone(t *testing.T, z *testZone2, char string, spawn string) *client {
	t.Helper()
	priv, _, _ := ticket.PrivateKeyFromEnv()
	h := &harness{t: t, srv: z.srv, url: z.url, priv: priv}
	cl := h.dial(spawn)
	tk := ticket.Sign(priv, ticket.Claims{AccountID: "acct-" + char, CharacterID: char, CharacterName: char, WorldID: testWorld, Audience: ticket.AudienceZone(z.id)})
	cl.hello([]byte(tk), proto.ProtocolVersion)
	cl.next(proto.MsgWelcome, 3*time.Second)
	return cl
}

// WP16: the zone owning a door's region decides it. A player on the other
// zone (near the border, the ghost band's case) closes it: the request goes
// to the owner, which applies it, persists it (only the owner writes) and
// tells the other zone, whose players get it as usual (970). A player of
// the owning zone standing in the doorway makes the other zone's close
// fail with "someone in the doorway" (972 reason 3).
func TestDoorsAcrossZonesFollowTheOwner(t *testing.T) {
	w, g := testTowns(t)
	ds, doors := spawnDoors(t, w)
	store := NewMemDoorStore()
	_, a, b := twoZones(t, func(c *Config) {
		c.Ground, c.Towns, c.TimeOffsetS = g, w, offsetFor(12)
		c.DoorStore, c.Queue = store, testQueue(t)
	})
	d := doors[0]
	dr := ds.D[d]
	owner, other := a, b
	if dr.X >= 2048 {
		owner, other = b, a
	}
	bd := w.T.Buildings[dr.Building]
	fx, fz := bd.Door(2.2)
	near := fmt.Sprintf("?spawn=%.2f,%.2f", fx, fz)
	far := joinZone(t, other, "visitor", near) // simulated by the zone that does not own the door
	far.keep(300 * time.Millisecond)

	far.interact(InteractDoor, dr.ID, DoorActClose, 0)
	if ev := far.nextEvent(EventDoorState, 3*time.Second); ev.Value != 0 || ev.TargetID != uint32(dr.Prop) {
		t.Fatalf("visitor's 970: %+v", ev)
	}
	waitDoor(t, owner.srv, d, false, "owner")
	waitDoor(t, other.srv, d, false, "other zone")
	waitRow(t, store, dr.ID, false)
	if _, writers := store.Stats(dr.ID); !slices.Equal(writers, []string{owner.id}) {
		t.Fatalf("door written by %v, want only the owner %s", writers, owner.id)
	}

	// The owner's own player stands in the doorway; the visitor opens the
	// door (fine) and tries to close it on them (refused).
	_ = joinZone(t, owner, "doorstop", fmt.Sprintf("?spawn=%.2f,%.2f,%.2f", dr.X, dr.Y+0.3, dr.Z))
	far.interact(InteractDoor, dr.ID, DoorActOpen, 0)
	if ev := far.nextEvent(EventDoorState, 3*time.Second); ev.Value != 1 {
		t.Fatalf("visitor's open: %+v", ev)
	}
	waitDoor(t, owner.srv, d, true, "owner reopened")
	waitDoor(t, other.srv, d, true, "other zone reopened")
	far.interact(InteractDoor, dr.ID, DoorActClose, 0)
	ref := far.nextEvent(EventDoorRefuse, 3*time.Second)
	if ref.Value != DoorRefuseBody {
		t.Fatalf("closing on the owner's player: refusal %+v, want reason %d", ref, DoorRefuseBody)
	}
	if open, _ := doorOpenOn(owner.srv, d); !open {
		t.Fatal("the owner closed the door on its player")
	}
}
