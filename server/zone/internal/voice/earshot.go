// Package voice computes proximity-voice earshot sets in the zone (spec 10
// "Proximity voice" 1, WP11): every EARSHOT_INTERVAL_MS, who can hear whom.
// The zone publishes the result (lodestone/server/pkg/earshot) and the
// social service turns it into LiveKit subscriptions, so the sets decide what
// every player hears. Pure: no clocks, no I/O; the tick feeds it positions.
package voice

import (
	"math"
	"slices"
	"strings"

	"lodestone/server/pkg/constants"
)

// Player is one listener/speaker this interval.
type Player struct {
	ID      string  // character id (= LiveKit identity)
	X, Y, Z float64 // feet position, m (every head is PLAYER_HEIGHT above it, so distances are the same)
	// Cave is the cave system the player is in plus one, 0 = open air (the
	// zone fills it from the WP09 cave graph, game/earshot.go).
	Cave uint32
	// Mouth, for a player in open air, is the cave system (plus one) whose
	// opening they stand near, else 0: they hear (and are heard by) that
	// system's dwellers with the cave radii, as interest clipping shows
	// them to each other (spec 9 "plus its mouths").
	Mouth uint32
}

// Neighbors calls fn with the index of every player that might be within r of
// player i (a superset is fine; Step checks exact distances). The zone backs
// it with its AOI grid; tests use brute force.
type Neighbors func(i int, r float64, fn func(j int))

// Computer holds the previous sets (hysteresis needs them).
type Computer struct {
	OpenM, CaveM float64 // join radii
	// HystM is how much farther than the join radius a current member may go
	// before it leaves (EARSHOT_LEAVE_M - EARSHOT_OPEN_M = 8 m), and also the
	// head start a current member has over a newcomer when the set is full.
	HystM float64
	Max   int

	prev map[string][]string // listener -> sorted speaker ids

	// Scratch reused every Step.
	index map[string]int
	inc   []int
	cand  []cand
}

type cand struct {
	idx   int
	score float64 // distance, minus HystM for a current member (see Step)
}

// NewComputer uses the contract constants (40 m open, 30 m cave, leave at
// +8 m, 12 nearest).
func NewComputer() *Computer {
	return &Computer{
		OpenM: constants.EarshotOpenM,
		CaveM: constants.EarshotCaveM,
		HystM: constants.EarshotLeaveM - constants.EarshotOpenM,
		Max:   int(constants.EarshotMax),
		prev:  map[string][]string{},
	}
}

// radii returns the join and leave distance between two players, or ok =
// false when they cannot hear each other at any distance.
//
// Open air: 40 m / 48 m. Same cave system: 30 m / 38 m (spec 10: rock walls
// keep voices close). One underground and one not, or different systems:
// never, because spec 9 clips a cave dweller's world to their system plus its
// mouths; someone in open air near one of the system's openings (Mouth) is
// heard with the cave radii.
func (c *Computer) radii(a, b *Player) (join, leave float64, ok bool) {
	switch {
	case a.Cave == 0 && b.Cave == 0:
		return c.OpenM, c.OpenM + c.HystM, true
	case a.Cave == b.Cave, a.Cave == 0 && a.Mouth == b.Cave, b.Cave == 0 && b.Mouth == a.Cave:
		return c.CaveM, c.CaveM + c.HystM, true
	}
	return 0, 0, false
}

// Step computes every listener's set. It returns the sets that changed since
// the previous Step (every set when full is true; new players always, even
// with an empty set, so the receiver learns which zone owns them) and the ids
// of players who were present last time and are not now. Sets are sorted by
// id.
//
// The rules, and why:
//   - Join at 40 m, leave at 48 m: someone pacing at the edge does not flip
//     a subscription (and an SFU renegotiation) every 250 ms.
//   - At most 12, nearest first, but a current member competes as if it were
//     8 m closer than it is: in a crowd, two people at nearly equal distance
//     would otherwise swap places in the top 12 every few intervals. The
//     same 8 m as the leave band, so "how much does it take to change what I
//     hear" has one answer.
//   - Distances are 3D: someone on a cliff 45 m above you is out of earshot.
//
// Party members are not added here; the social service owns parties.
//
// Cost: one pass over each listener's grid neighbours with squared
// distances and no per-pair allocation; 300 players in a 120 m square (every
// listener has ~100 candidates) is in BenchmarkStep300Clustered.
func (c *Computer) Step(players []Player, near Neighbors, full bool) (sets map[string][]string, gone []string) {
	sets = map[string][]string{}
	next := make(map[string][]string, len(players))
	maxLeave := max(c.OpenM, c.CaveM) + c.HystM
	// Current members as player indices: checking incumbency per candidate
	// is then a scan of at most 12 ints instead of 12 string compares.
	clear(c.index)
	if c.index == nil {
		c.index = make(map[string]int, len(players))
	}
	for i := range players {
		c.index[players[i].ID] = i
	}
	for i := range players {
		l := &players[i]
		cur, known := c.prev[l.ID]
		c.inc = c.inc[:0]
		for _, id := range cur {
			if k, ok := c.index[id]; ok {
				c.inc = append(c.inc, k)
			}
		}
		c.cand = c.cand[:0]
		near(i, maxLeave, func(j int) {
			if j == i || j < 0 || j >= len(players) {
				return
			}
			s := &players[j]
			dx, dy, dz := s.X-l.X, s.Y-l.Y, s.Z-l.Z
			d2 := dx*dx + dy*dy + dz*dz
			if d2 > maxLeave*maxLeave {
				return
			}
			join, leave, ok := c.radii(l, s)
			if !ok {
				return
			}
			incumbent := slices.Contains(c.inc, j)
			if incumbent {
				if d2 > leave*leave {
					return
				}
			} else if d2 > join*join {
				return
			}
			score := math.Sqrt(d2)
			if incumbent {
				score -= c.HystM
			}
			// Keep only the Max best, sorted, by insertion: a crowd gives
			// each listener ~100 candidates and we need 12, so this beats
			// collecting and sorting them all.
			k := cand{j, score}
			n := len(c.cand)
			if n == c.Max && !less(k, c.cand[n-1], players) {
				return
			}
			if n < c.Max {
				c.cand = append(c.cand, k)
			} else {
				c.cand[n-1] = k
				n--
			}
			for p := n; p > 0 && less(c.cand[p], c.cand[p-1], players); p-- {
				c.cand[p], c.cand[p-1] = c.cand[p-1], c.cand[p]
			}
		})
		ids := make([]string, 0, len(c.cand))
		for _, k := range c.cand {
			ids = append(ids, players[k.idx].ID)
		}
		slices.Sort(ids)
		ids = slices.Compact(ids) // a Neighbors superset may repeat a player
		next[l.ID] = ids
		if full || !known || !slices.Equal(cur, ids) {
			sets[l.ID] = ids
		}
	}
	for id := range c.prev {
		if _, ok := next[id]; !ok {
			gone = append(gone, id)
		}
	}
	slices.Sort(gone)
	c.prev = next
	return sets, gone
}

// Current returns a listener's set from the last Step (tests, debug).
func (c *Computer) Current(id string) []string { return slices.Clone(c.prev[id]) }

// Pairs is the number of (listener, speaker) entries in the last Step.
func (c *Computer) Pairs() int {
	n := 0
	for _, s := range c.prev {
		n += len(s)
	}
	return n
}

// less orders candidates by score, ties by id (deterministic sets).
func less(a, b cand, players []Player) bool {
	if a.score != b.score {
		return a.score < b.score
	}
	return strings.Compare(players[a.idx].ID, players[b.idx].ID) < 0
}
