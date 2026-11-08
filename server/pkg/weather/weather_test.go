package weather

import "testing"

// The same vectors as client/src/sim/weather.test (traversal.test.ts): if
// either side's hash changes, client and zone disagree about rain.
func TestHashVectorsMatchTS(t *testing.T) {
	want := []uint32{689418537, 1815390235, 4091472293, 4141916889, 2727198801, 3880554713}
	for i, w := range []int64{0, 1, 2, 3, 2946000, -1} {
		if got := Hash(20261108, w); got != want[i] {
			t.Fatalf("window %d: %d want %d", w, got, want[i])
		}
	}
	if IsRaining(20261108, 0) {
		t.Fatal("window 0 should be dry (37)")
	}
	if !IsRaining(20261108, 600*2946000) {
		t.Fatal("window 2946000 should rain (1)")
	}
}

func TestAboutAQuarterRains(t *testing.T) {
	wet := 0
	for w := 0; w < 4000; w++ {
		if IsRaining(7, float64(w*600)) {
			wet++
		}
	}
	if f := float64(wet) / 4000; f < 0.2 || f > 0.3 {
		t.Fatalf("rain fraction %v", f)
	}
}
