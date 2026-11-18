package game

import (
	"testing"
	"time"

	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/explore"
)

func (cl *client) placeService(si int, kind uint8, xCm, zCm int32) {
	cl.send(&proto.Interact{TargetKind: InteractPlacePin, TargetID: explore.PackPinPos(xCm, zCm), Action: ActionPlaceService, Arg: uint32(si) | uint32(kind)<<16})
}

// Playtest 5 (CR 055): the journal's Info tab marks a service of your town:
// the pin carries "<Service>, <Town>", survives into the save, and a place
// that is not in that town, or a bad service, is refused.
func TestInfoTabMarksAServiceWithItsName(t *testing.T) {
	h, a, _, char, _, _ := dialogStart(t)
	w := h.srv.cfg.Towns
	si := spawnSettlement(t, w)
	st := w.T.Settlements[si]
	town := h.srv.settlementName(si)
	a.drainFor(300 * time.Millisecond)

	xc, zc := cm(st.X+12), cm(st.Z-9)
	a.placeService(si, 1, xc, zc)
	ev := a.take(EventPlaceMarked, 3*time.Second)
	want := "Stables, " + town
	if string(ev.Data) != want || ev.X != xc || ev.Z != zc {
		t.Fatalf("event %+v data %q, want %q", ev, ev.Data, want)
	}
	a.take(EventPins, 3*time.Second)
	h.do(func() {
		pins := h.srv.byChar[char].x.prog.Pins
		if len(pins) != 1 || pins[0].Label != want || pins[0].XCm != xc {
			t.Errorf("pins %+v", pins)
		}
	})

	// Marking it again reports the same place (the client can still point the wisp at it) and adds no pin.
	a.placeService(si, 1, xc, zc)
	if again := a.take(EventPlaceMarked, 3*time.Second); again.X != xc {
		t.Fatalf("again %+v", again)
	}
	h.do(func() {
		if n := len(h.srv.byChar[char].x.prog.Pins); n != 1 {
			t.Errorf("%d pins", n)
		}
	})

	// A place far outside the town, an unknown town and a bad service are refused, and set nothing.
	a.placeService(si, 2, cm(st.X+5000), cm(st.Z))
	if r := a.take(EventPlaceRefused, 3*time.Second); r.Value != placeFar {
		t.Fatalf("far: %+v", r)
	}
	a.placeService(len(w.T.Settlements)+3, 2, xc, zc)
	if r := a.take(EventPlaceRefused, 3*time.Second); r.Value != placeNoTown {
		t.Fatalf("no town: %+v", r)
	}
	a.placeService(si, 99, cm(st.X+3), cm(st.Z))
	if r := a.take(EventPlaceRefused, 3*time.Second); r.Value != placeBadKind {
		t.Fatalf("bad kind: %+v", r)
	}
	h.do(func() {
		if n := len(h.srv.byChar[char].x.prog.Pins); n != 1 {
			t.Errorf("%d pins after refusals", n)
		}
	})
}
