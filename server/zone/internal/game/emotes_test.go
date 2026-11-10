package game

import (
	"context"
	"math"
	"testing"
	"time"

	"lodestone/server/pkg/contentdefs"
	"lodestone/server/pkg/proto"
)

func emoteHarness(t *testing.T) (*harness, *client, *client, *client) {
	t.Helper()
	h := newHarness(t, nil)
	a := h.dial("?spawn=2048,0,2048")
	a.join(h, "emo-a", "Dancer")
	near := h.dial("?spawn=2060,0,2048") // 12 m
	near.join(h, "emo-near", "Near")
	far := h.dial("?spawn=2148,0,2048") // 100 m, beyond emotes.seeM
	far.join(h, "emo-far", "Far")
	for _, c := range []*client{a, near, far} {
		c.pump(150 * time.Millisecond)
	}
	return h, a, near, far
}

func TestEmoteInterestAndNoEcho(t *testing.T) {
	_, a, near, far := emoteHarness(t)
	if contentdefs.D.Emotes.SeeM >= 100 {
		t.Fatalf("the far player is inside seeM %.0f", contentdefs.D.Emotes.SeeM)
	}
	wave := contentdefs.D.Emote(1)
	if wave == nil || wave.Key != "wave" {
		t.Fatalf("emote 1 is %+v", wave)
	}
	a.send(&proto.Interact{TargetKind: InteractEmote, TargetID: 1, Action: EmoteActPlay})
	a.pump(150 * time.Millisecond)
	near.pump(100 * time.Millisecond)
	far.pump(50 * time.Millisecond)
	got := near.eventsOf(EventEmote)
	if len(got) != 1 || got[0].TargetID != 1 || math.Abs(proto.CmToMeters(got[0].X)-2048) > 0.5 {
		t.Fatalf("near observer: %+v", got)
	}
	if n := len(far.eventsOf(EventEmote)); n != 0 {
		t.Fatalf("a player 100 m away got %d emote events", n)
	}
	if n := len(a.eventsOf(EventEmote)); n != 0 {
		t.Fatalf("the actor got %d events of their own emote", n)
	}
	// Unknown and system emotes are refused.
	for _, id := range []uint64{0, 15, EmoteFishing, 300} {
		a.send(&proto.Interact{TargetKind: InteractEmote, TargetID: id, Action: EmoteActPlay})
	}
	a.pump(200 * time.Millisecond)
	if n := len(a.eventsOf(EventEmoteRefused)); n != 4 {
		t.Fatalf("refusals %d, want 4: %+v", n, a.eventsOf(EventEmoteRefused))
	}
	near.pump(50 * time.Millisecond)
	if n := len(near.eventsOf(EventEmote)); n != 1 {
		t.Fatalf("refused emotes reached the observer: %d", n)
	}
}

func TestEmoteRateLimit(t *testing.T) {
	_, a, near, _ := emoteHarness(t)
	burst := int(contentdefs.D.Emotes.Burst)
	for i := 0; i < burst+3; i++ {
		a.send(&proto.Interact{TargetKind: InteractEmote, TargetID: 7, Action: EmoteActPlay})
	}
	a.pump(250 * time.Millisecond)
	near.pump(100 * time.Millisecond)
	if n := len(near.eventsOf(EventEmote)); n != burst {
		t.Fatalf("observer got %d emotes of a %d-spam, want the burst %d", n, burst+3, burst)
	}
	tooFast := 0
	for _, r := range a.eventsOf(EventEmoteRefused) {
		if r.Value == EmoteRefuseTooFast {
			tooFast++
		}
	}
	if tooFast != 3 {
		t.Fatalf("too-fast refusals %d, want 3", tooFast)
	}
	// One more token after everyS.
	a.pump(time.Duration(contentdefs.D.Emotes.EveryS*1000+100) * time.Millisecond)
	a.send(&proto.Interact{TargetKind: InteractEmote, TargetID: 2, Action: EmoteActPlay})
	a.pump(150 * time.Millisecond)
	near.pump(100 * time.Millisecond)
	if n := len(near.eventsOf(EventEmote)); n != burst+1 {
		t.Fatalf("after the refill: %d", n)
	}
}

func TestEmoteLoopReachesNewcomersOnce(t *testing.T) {
	h, a, near, _ := emoteHarness(t)
	a.send(&proto.Interact{TargetKind: InteractEmote, TargetID: 5, Action: EmoteActPlay}) // sit (loops)
	a.pump(150 * time.Millisecond)
	// Someone arrives within range after the emote started: told once, on the next second.
	late := h.dial("?spawn=2050,0,2050")
	late.join(h, "emo-late", "Late")
	late.pump(2200 * time.Millisecond)
	near.pump(100 * time.Millisecond)
	if got := late.eventsOf(EventEmote); len(got) != 1 || got[0].TargetID != 5 {
		t.Fatalf("newcomer: %+v", got)
	}
	if got := near.eventsOf(EventEmote); len(got) != 1 {
		t.Fatalf("the first observer was told %d times", len(got))
	}
	// Stop: those who saw it hear id 0.
	a.send(&proto.Interact{TargetKind: InteractEmote, Action: EmoteActStop})
	a.pump(150 * time.Millisecond)
	near.pump(100 * time.Millisecond)
	late.pump(100 * time.Millisecond)
	if e := lastEv(near, EventEmote); e == nil || e.TargetID != 0 {
		t.Fatalf("near after stop: %+v", e)
	}
	if e := lastEv(late, EventEmote); e == nil || e.TargetID != 0 {
		t.Fatalf("late after stop: %+v", e)
	}
	left := -1
	_ = h.srv.Do(context.Background(), func() { left = len(h.srv.emoters) })
	if left != 0 {
		t.Fatalf("emoters left: %d", left)
	}
}
