package explore

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// Playtest 5 (CR 055): a pin a conversation placed carries its name through
// the save blob and the pins Event (personal pins use the owner field), and
// an old save without labels still loads.
func TestPinLabels(t *testing.T) {
	var p Progress
	if !p.SetLabeledPin(2, 4, 166400, 240000, "Stables, Kudrogair") {
		t.Fatal("set")
	}
	p.SetPin(3, 1, 5, 5) // dropped by hand: no label
	var q Progress
	q.LoadPinsJSON(p.PinsJSON())
	if q.Pins[0].Label != "Stables, Kudrogair" || q.Pins[1].Label != "" {
		t.Fatalf("labels lost in the save: %+v", q.Pins)
	}
	q.LoadPinsJSON([]byte(`[{"slot":1,"color":2,"x":10,"z":20}]`))
	if len(q.Pins) != 1 || q.Pins[0].Label != "" {
		t.Fatalf("an old save: %+v", q.Pins)
	}
	// Moving a pin by hand drops the name (it is no longer that place).
	p.SetPin(2, 4, 7, 7)
	if p.Pins[0].Label != "" {
		t.Fatalf("moved pin kept its label: %+v", p.Pins[0])
	}
	// The wire carries it, cut on a rune boundary.
	long := ClipLabel(strings.Repeat("é", 40))
	if !utf8.ValidString(long) || len(long) > MaxPinLabel {
		t.Fatalf("clip %q", long)
	}
	views, err := DecodePins(EncodePins([]PinView{{Slot: 2, Color: 4, XCm: 1, ZCm: 2, Owner: "Stables, Kudrogair"}}))
	if err != nil || len(views) != 1 || views[0].Owner != "Stables, Kudrogair" {
		t.Fatalf("%+v %v", views, err)
	}
}
