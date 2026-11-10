package game

import (
	"encoding/json"
	"math"
	"testing"
	"time"

	"lodestone/server/pkg/contentdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

// pondGround is flat ground at 10 m with a lake (surface 11.5 m) east of
// x = 2060: the angler stands on the shore at x = 2050.
type pondGround struct{}

func (pondGround) HeightAt(x, z float64) float64 { return 10 }
func (pondGround) WaterAt(x, z float64) float64 {
	if x > 2060 {
		return 11.5
	}
	return math.Inf(-1)
}

var _ movement.Water = pondGround{}

func castID(x, z float64) uint64 {
	return uint64(uint32(math.Round(x*100))) | uint64(uint32(math.Round(z*100)))<<32
}

func fishHarness(t *testing.T) (*harness, *client, *client, *client) {
	t.Helper()
	old := fishFast
	fishFast = true
	t.Cleanup(func() { fishFast = old })
	h := newHarness(t, func(c *Config) { c.Ground = pondGround{} })
	a := h.dial("?spawn=2050,10,2048")
	a.join(h, "fish-a", "Angler")
	near := h.dial("?spawn=2040,10,2048")
	near.join(h, "fish-near", "Near")
	far := h.dial("?spawn=1950,10,2048")
	far.join(h, "fish-far", "Far")
	for _, c := range []*client{a, near, far} {
		c.pump(150 * time.Millisecond)
	}
	return h, a, near, far
}

func lastEv(c *client, kind uint16) *proto.Event {
	evs := c.eventsOf(kind)
	if len(evs) == 0 {
		return nil
	}
	return evs[len(evs)-1]
}

func TestFishingCastHookLand(t *testing.T) {
	_, a, near, far := fishHarness(t)

	// No rod: refused.
	a.send(&proto.Interact{TargetKind: InteractFishing, TargetID: castID(2070, 2048), Action: FishActCast})
	a.pump(150 * time.Millisecond)
	if r := lastEv(a, EventFishRefused); r == nil || r.Value != FishRefuseNoRod {
		t.Fatalf("cast without a rod: %+v", r)
	}
	a.send(&proto.Interact{TargetKind: InteractFishing, Action: FishActDevRod})
	a.pump(150 * time.Millisecond)

	// Dry land and out of reach: refused.
	a.send(&proto.Interact{TargetKind: InteractFishing, TargetID: castID(2055, 2048), Action: FishActCast})
	a.pump(100 * time.Millisecond)
	if r := lastEv(a, EventFishRefused); r == nil || r.Value != FishRefuseNoWater {
		t.Fatalf("cast on dry land: %+v", r)
	}
	a.send(&proto.Interact{TargetKind: InteractFishing, TargetID: castID(2090, 2048), Action: FishActCast})
	a.pump(100 * time.Millisecond)
	if r := lastEv(a, EventFishRefused); r == nil || r.Value != FishRefuseReach {
		t.Fatalf("cast 40 m away: %+v", r)
	}

	a.send(&proto.Interact{TargetKind: InteractFishing, TargetID: castID(2066, 2048), Action: FishActCast})
	a.pump(200 * time.Millisecond)
	cast := lastEv(a, EventFishCast)
	if cast == nil {
		t.Fatalf("no cast event; refusals %+v", a.eventsOf(EventFishRefused))
	}
	var cd struct {
		Seq    uint32 `json:"seq"`
		Water  string `json:"water"`
		BiteMs int    `json:"biteMs"`
	}
	if err := json.Unmarshal(cast.Data, &cd); err != nil || cd.Water != "lake" || cd.BiteMs < 1200 || cd.BiteMs > 1800 {
		t.Fatalf("cast data %s (%v)", cast.Data, err)
	}
	// The near observer sees the line (emote 20 with the bobber), the far one doesn't, the angler doesn't get their own.
	near.pump(100 * time.Millisecond)
	far.pump(50 * time.Millisecond)
	if e := lastEv(near, EventEmote); e == nil || e.TargetID != EmoteFishing || math.Abs(proto.CmToMeters(e.X)-2066) > 0.02 {
		t.Fatalf("near observer: %+v", e)
	}
	if len(far.eventsOf(EventEmote)) != 0 || len(a.eventsOf(EventEmote)) != 0 {
		t.Fatalf("far %d / angler %d emote events", len(far.eventsOf(EventEmote)), len(a.eventsOf(EventEmote)))
	}
	// A second cast while the line is out: busy.
	a.send(&proto.Interact{TargetKind: InteractFishing, TargetID: castID(2066, 2049), Action: FishActCast})
	a.pump(100 * time.Millisecond)
	if r := lastEv(a, EventFishRefused); r == nil || r.Value != FishRefuseBusy {
		t.Fatalf("second cast: %+v", r)
	}

	// Hook after the bite.
	a.pump(time.Duration(cd.BiteMs)*time.Millisecond - 300*time.Millisecond + 100*time.Millisecond)
	a.send(&proto.Interact{TargetKind: InteractFishing, TargetID: uint64(cd.Seq), Action: FishActHook})
	a.pump(200 * time.Millisecond)
	hk := lastEv(a, EventFishHooked)
	if hk == nil {
		t.Fatalf("not hooked; lost %+v", a.eventsOf(EventFishLost))
	}
	var hd struct {
		MinMs int `json:"minMs"`
	}
	_ = json.Unmarshal(hk.Data, &hd)
	if hd.MinMs < 2000 {
		t.Fatalf("hooked data %s", hk.Data)
	}
	// Landing at once is impossible: the fish is lost, nothing granted.
	a.send(&proto.Interact{TargetKind: InteractFishing, TargetID: uint64(cd.Seq), Action: FishActLand, Arg: uint32(hd.MinMs)})
	a.pump(150 * time.Millisecond)
	if l := lastEv(a, EventFishLost); l == nil || l.Value != FishLostTooQuick {
		t.Fatalf("instant landing: %+v", l)
	}
	if len(a.eventsOf(EventFishCaught)) != 0 {
		t.Fatal("an instant landing paid out")
	}
	// The near observer's line went away (emote 0).
	near.pump(100 * time.Millisecond)
	if e := lastEv(near, EventEmote); e == nil || e.TargetID != 0 {
		t.Fatalf("near observer after the loss: %+v", e)
	}

	// Again, honestly: wait out the cooldown, cast, hook, fight, land.
	a.pump(1600 * time.Millisecond)
	a.send(&proto.Interact{TargetKind: InteractFishing, TargetID: castID(2068, 2050), Action: FishActCast})
	a.pump(200 * time.Millisecond)
	cast = lastEv(a, EventFishCast)
	_ = json.Unmarshal(cast.Data, &cd)
	a.pump(time.Duration(cd.BiteMs) * time.Millisecond)
	a.send(&proto.Interact{TargetKind: InteractFishing, TargetID: uint64(cd.Seq), Action: FishActHook})
	a.pump(200 * time.Millisecond)
	hk = lastEv(a, EventFishHooked)
	_ = json.Unmarshal(hk.Data, &hd)
	a.pump(time.Duration(hd.MinMs+100) * time.Millisecond)
	a.send(&proto.Interact{TargetKind: InteractFishing, TargetID: uint64(cd.Seq), Action: FishActLand, Arg: uint32(hd.MinMs + 100)})
	a.pump(300 * time.Millisecond)
	got := lastEv(a, EventFishCaught)
	if got == nil {
		t.Fatalf("not caught; lost %+v", a.eventsOf(EventFishLost))
	}
	f := contentdefs.D.FishByID(int(got.TargetID))
	if f == nil || got.Value < int32(f.Weight[0]*1000)-1 || got.Value > int32(f.Weight[1]*1000)+1 {
		t.Fatalf("caught %+v (%v)", got, f)
	}
	// It is in the inventory (Event 400 lists it).
	inv := lastEv(a, EventInventory)
	if inv == nil || !jsonHas(inv.Data, f.Item) {
		t.Fatalf("inventory after the catch lacks %s", f.Item)
	}
	near.pump(100 * time.Millisecond)
	if e := lastEv(near, EventEmote); e == nil || e.TargetID != EmoteShowCatch || e.Value != int32(f.ID) {
		t.Fatalf("near observer did not see the catch held up: %+v", e)
	}
}

func jsonHas(b []byte, s string) bool {
	return len(b) > 0 && string(b) != "" && contains(string(b), `"`+s+`"`)
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func TestFishingStrikeEarlyAndRateLimit(t *testing.T) {
	_, a, _, _ := fishHarness(t)
	a.send(&proto.Interact{TargetKind: InteractFishing, Action: FishActDevRod})
	a.pump(100 * time.Millisecond)
	a.send(&proto.Interact{TargetKind: InteractFishing, TargetID: castID(2066, 2048), Action: FishActCast})
	a.pump(150 * time.Millisecond)
	cast := lastEv(a, EventFishCast)
	if cast == nil {
		t.Fatal("no cast")
	}
	// A strike before the bite spooks the fish.
	a.send(&proto.Interact{TargetKind: InteractFishing, TargetID: uint64(cast.TargetID), Action: FishActHook})
	a.pump(150 * time.Millisecond)
	if l := lastEv(a, EventFishLost); l == nil || l.Value != FishLostEarly {
		t.Fatalf("early strike: %+v", l)
	}
	// Within the cooldown: too soon.
	a.send(&proto.Interact{TargetKind: InteractFishing, TargetID: castID(2066, 2048), Action: FishActCast})
	a.pump(100 * time.Millisecond)
	if r := lastEv(a, EventFishRefused); r == nil || r.Value != FishRefuseTooSoon {
		t.Fatalf("cast in the cooldown: %+v", r)
	}
	// Cast and reel in, as fast as the cooldown allows: the burst (6, then
	// one per 4 s) runs out after about 9 casts 1.65 s apart.
	casts, soon := 1, 0
	for i := 0; i < 12; i++ {
		a.pump(1600 * time.Millisecond)
		before := len(a.eventsOf(EventFishCast))
		a.send(&proto.Interact{TargetKind: InteractFishing, TargetID: castID(2066, 2048), Action: FishActCast})
		a.pump(100 * time.Millisecond)
		if len(a.eventsOf(EventFishCast)) > before {
			casts++
			c := lastEv(a, EventFishCast)
			a.send(&proto.Interact{TargetKind: InteractFishing, TargetID: uint64(c.TargetID), Action: FishActLose, Arg: FishLostCancelled})
			a.pump(50 * time.Millisecond)
		} else if r := lastEv(a, EventFishRefused); r != nil && r.Value == FishRefuseTooSoon {
			soon++
		}
	}
	burst := int(contentdefs.D.Fishing.CastBurst)
	if casts > burst+5 || soon == 0 {
		t.Fatalf("rate limit: %d casts (burst %d), %d refused as too soon", casts, burst, soon)
	}
}

func TestFishingWalkAwayEndsTheLine(t *testing.T) {
	_, a, _, _ := fishHarness(t)
	a.send(&proto.Interact{TargetKind: InteractFishing, Action: FishActDevRod})
	a.pump(100 * time.Millisecond)
	a.send(&proto.Interact{TargetKind: InteractFishing, TargetID: castID(2066, 2048), Action: FishActCast})
	a.pump(150 * time.Millisecond)
	if lastEv(a, EventFishCast) == nil {
		t.Fatal("no cast")
	}
	a.walk(60, uint16(proto.InputFlagForward), math.Pi/2, nil) // west, away from the water
	a.pump(1200 * time.Millisecond)
	if l := lastEv(a, EventFishLost); l == nil || l.Value != FishLostWalkedAway {
		t.Fatalf("walked away: %+v", l)
	}
}
