package game

import "testing"

// Co-op polish: the Hush scales to the party's mean level + 1 (it was the
// highest + 1), never below 12; the Starless Vow adds 4. The shroud breaks
// after 3 + 3 hits per player (Starless 4 + 5).
func TestFinaleLevelAndShroud(t *testing.T) {
	for _, c := range []struct {
		levels []int
		hard   bool
		want   int
	}{
		{nil, false, 12},
		{[]int{5}, false, 12},
		{[]int{30}, false, 31},
		{[]int{30, 30}, false, 31},
		{[]int{33, 27}, false, 31}, // highest + 1 would be 34
		{[]int{32, 29}, false, 32}, // 30.5 rounds up
		{[]int{30, 30}, true, 35},
	} {
		if got := finaleLevel(c.levels, c.hard); got != c.want {
			t.Errorf("finaleLevel(%v, %v) = %d, want %d", c.levels, c.hard, got, c.want)
		}
	}
	for _, c := range []struct {
		n    int
		hard bool
		want float64
	}{{1, false, 6}, {2, false, 9}, {4, false, 15}, {2, true, 14}, {0, false, 6}} {
		if got := finaleShroudHits(c.n, c.hard); got != c.want {
			t.Errorf("finaleShroudHits(%d, %v) = %v, want %v", c.n, c.hard, got, c.want)
		}
	}
}
