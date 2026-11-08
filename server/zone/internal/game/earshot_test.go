package game

import (
	"slices"
	"sync"
	"testing"
	"time"

	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/ticket"
	"lodestone/server/zone/internal/voice"
)

type fakeEarshot struct {
	mu      sync.Mutex
	batches [][]voice.Player
	times   []time.Time
}

func (f *fakeEarshot) Offer(ps []voice.Player, _ float64) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.batches = append(f.batches, ps)
	f.times = append(f.times, time.Now())
	return true
}

func (f *fakeEarshot) snapshot() ([][]voice.Player, []time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.batches), slices.Clone(f.times)
}

// The tick hands positions to the earshot runner every 250 ms (not every
// tick), with character ids and confirmed positions.
func TestEarshotHandoffCadence(t *testing.T) {
	fe := &fakeEarshot{}
	h := newHarness(t, func(c *Config) { c.Earshot = fe })
	a := h.dial("?spawn=100,100")
	a.join(h, "char-a", "A")
	b := h.dial("?spawn=110,100")
	b.join(h, "char-b", "B")
	time.Sleep(1300 * time.Millisecond)
	batches, times := fe.snapshot()
	if n := len(batches); n < 4 || n > 7 {
		t.Fatalf("%d hand-offs in 1.3 s, want about 5 (one per 250 ms)", n)
	}
	for i := 1; i < len(times); i++ {
		if gap := times[i].Sub(times[i-1]); gap < 200*time.Millisecond || gap > 320*time.Millisecond {
			t.Fatalf("hand-off gap %v, want ~250 ms", gap)
		}
	}
	last := batches[len(batches)-1]
	if len(last) != 2 {
		t.Fatalf("want both players, got %+v", last)
	}
	ids := []string{last[0].ID, last[1].ID}
	slices.Sort(ids)
	if !slices.Equal(ids, []string{"char-a", "char-b"}) || last[0].X < 99 || last[0].X > 111 {
		t.Fatalf("bad players %+v", last)
	}
}

// InputFlag.speaking from a player shows as Activity.speaking to others;
// a local profile's bit is never shown (listen-only, spec 11).
func TestSpeakingFlagMirroredIntoActivity(t *testing.T) {
	h := newHarness(t, nil)
	obs := h.dial("?spawn=100,100")
	obs.join(h, "obs", "Observer")
	talker := h.dial("?spawn=105,100")
	tw := talker.join(h, "talk", "Talker")
	local := h.dial("?spawn=95,100")
	local.hello(h.ticket("loc", "Local", func(c *ticket.Claims) { c.AccountID = ""; c.ProfileID = "p1"; c.IsLocalProfile = true }), proto.ProtocolVersion)
	lw := local.next(proto.MsgWelcome, 3*time.Second).(*proto.Welcome)

	activity := func(id uint32) (uint8, bool) {
		if obs.frame == nil {
			return 0, false
		}
		for _, e := range obs.frame.Ents {
			if e.ID == id {
				return e.Activity, true
			}
		}
		return 0, false
	}
	waitFor := func(what string, cond func() bool) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for !cond() {
			if time.Now().After(deadline) {
				t.Fatalf("timeout: %s", what)
			}
			talker.walk(2, proto.InputFlagSpeaking, 0, nil)
			local.walk(2, proto.InputFlagSpeaking, 0, nil)
			obs.drainFor(30 * time.Millisecond)
		}
	}
	waitFor("talker speaking", func() bool {
		a, ok := activity(tw.EntityID)
		return ok && a&proto.ActivitySpeaking != 0
	})
	if a, ok := activity(lw.EntityID); !ok || a&proto.ActivitySpeaking != 0 {
		t.Fatalf("local profile must never show speaking (activity %08b, seen %v)", a, ok)
	}
	// Releasing push-to-talk clears the bit.
	deadline := time.Now().Add(3 * time.Second)
	for {
		talker.walk(2, 0, 0, nil)
		obs.drainFor(30 * time.Millisecond)
		if a, ok := activity(tw.EntityID); ok && a&proto.ActivitySpeaking == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("speaking bit never cleared")
		}
	}
}

// G3 (WP09 x WP11): the earshot hand-off carries the cave system, so the
// voice rules (30 m in the same system, nobody through the rock above, the
// mouth refinement) see what interest clipping sees.
func TestEarshotCarriesCaveSystem(t *testing.T) {
	ct := testCaveTerrain(t)
	fe := &fakeEarshot{}
	h := newHarness(t, func(c *Config) { c.Ground = ct; c.Earshot = fe })
	g := ct.CaveGraph()
	const si = 0
	s := g.Systems[si]
	deep := g.Chambers[s.FirstChamber+s.Deepest]
	o := g.SystemOpenings(si)[0]
	ct.Caves.Ensure(deep.X, deep.Floor, deep.Z, 48)
	in := h.dial("?spawn=" + ftoa(deep.X) + "," + ftoa(deep.Floor+1) + "," + ftoa(deep.Z))
	in.join(h, "char-in", "Dweller")
	mouth := h.dial("?spawn=" + ftoa(o.X+o.RMask+6) + "," + ftoa(o.Z))
	mouth.join(h, "char-mouth", "Watcher")
	far := h.dial("?spawn=" + ftoa(o.X+400) + "," + ftoa(o.Z+400))
	far.join(h, "char-far", "Walker")
	time.Sleep(900 * time.Millisecond)
	batches, _ := fe.snapshot()
	if len(batches) == 0 {
		t.Fatal("no earshot hand-off")
	}
	got := map[string]voice.Player{}
	for _, p := range batches[len(batches)-1] {
		got[p.ID] = p
	}
	if p := got["char-in"]; p.Cave != si+1 || p.Mouth != 0 {
		t.Fatalf("player in the deepest chamber of system %d: %+v", si, p)
	}
	if p := got["char-mouth"]; p.Cave != 0 || p.Mouth != si+1 {
		t.Fatalf("player at the system's opening: %+v", p)
	}
	if p := got["char-far"]; p.Cave != 0 || p.Mouth != 0 {
		t.Fatalf("player far away in open air: %+v", p)
	}
}
