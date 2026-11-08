package snapshot

import (
	"bytes"
	"math"
	"math/rand"
	"slices"
	"testing"

	"lodestone/server/pkg/proto"
)

// WP19 changed how the budgeted encoder picks records (lazy diffs, a heap
// instead of a full sort). refEncoder is the pre-WP19 implementation, kept
// verbatim here so the test can prove the new one writes byte-identical
// snapshots and keeps identical priority state, tick after tick.
type refEncoder struct {
	r                 ring
	last              uint32
	snap              proto.Snapshot
	perTick, burst    float64
	overhead          int
	tokens            float64
	accIDs, accIDs2   []uint32
	accVals, accVals2 []float64
	work              []refPending
	order             []prioIdx
	stats             BudgetStats
}

type refPending struct {
	rec  proto.EntityRecord
	size int
	prio float64
	send bool
}

func (e *refEncoder) SetBudget(bytesPerSec float64, tickRate int, burstTicks float64, overhead int) {
	e.perTick = bytesPerSec / float64(tickRate)
	e.burst = e.perTick * burstTicks
	e.overhead = overhead
	e.tokens = e.perTick
}

func (e *refEncoder) Build(tick, ackTick, ackSeq uint32, serverTime float64, self *proto.SelfState, interest []Candidate) *proto.Snapshot {
	var base *Frame
	if !(ackTick == 0 || ackTick >= tick || tick-ackTick >= Ring) {
		base = e.r.get(ackTick)
	}
	out := e.r.slot(tick)
	e.last = tick
	s := &e.snap
	s.Tick, s.AckInputSeq, s.ServerTime = tick, ackSeq, serverTime
	s.Entities, s.Removed = s.Entities[:0], s.Removed[:0]
	var bents []EntState
	if base != nil {
		s.BaselineTick = base.Tick
		s.Self = DiffSelf(&base.Self, self)
		bents = base.Ents
	} else {
		s.BaselineTick = 0
		s.Self = DiffSelf(nil, self)
	}
	out.Self = *self
	out.Self.Mask = 0

	work := e.work[:0]
	acc := accCursor{ids: e.accIDs, vals: e.accVals}
	total := 0
	i, j := 0, 0
	for i < len(interest) || j < len(bents) {
		switch {
		case j >= len(bents) || (i < len(interest) && interest[i].State.ID < bents[j].ID):
			c := &interest[i]
			rec := Diff(nil, c.State)
			w := refPending{rec: rec, size: RecordSize(&rec), prio: acc.get(c.State.ID) + weightOf(c)}
			total += w.size
			work = append(work, w)
			i++
		case i >= len(interest) || bents[j].ID < interest[i].State.ID:
			s.Removed = append(s.Removed, bents[j].ID)
			j++
		default:
			c := &interest[i]
			if c.Due {
				if rec := Diff(&bents[j], c.State); rec.Mask != 0 {
					w := refPending{rec: rec, size: RecordSize(&rec), prio: acc.get(c.State.ID) + weightOf(c)}
					total += w.size
					work = append(work, w)
				}
			}
			i++
			j++
		}
	}
	e.tokens += e.perTick
	if e.tokens > e.burst {
		e.tokens = e.burst
	}
	fixed := snapshotFixed(&s.Self, len(s.Removed)) + e.overhead
	avail := e.tokens - float64(fixed)
	spent := 0
	if float64(total) <= avail {
		for k := range work {
			work[k].send = true
		}
		spent = total
	} else {
		e.order = e.order[:0]
		for k := range work {
			e.order = append(e.order, prioIdx{prio: work[k].prio, k: int32(k)})
		}
		slices.SortFunc(e.order, func(a, b prioIdx) int {
			switch {
			case a.prio > b.prio:
				return -1
			case a.prio < b.prio:
				return 1
			}
			return int(a.k - b.k)
		})
		for _, o := range e.order {
			w := &work[o.k]
			if float64(spent+w.size) > avail {
				break
			}
			w.send = true
			spent += w.size
		}
		if spent == 0 && len(e.order) > 0 && e.tokens >= e.burst-1e-9 {
			w := &work[e.order[0].k]
			w.send = true
			spent = w.size
		}
	}
	e.tokens -= float64(fixed + spent)

	newIDs, newVals := e.accIDs2[:0], e.accVals2[:0]
	old := accCursor{ids: e.accIDs, vals: e.accVals}
	keep := func(id uint32, v float64) {
		if v > 0 {
			newIDs = append(newIDs, id)
			newVals = append(newVals, v)
		}
	}
	k := 0
	i, j = 0, 0
	for i < len(interest) || j < len(bents) {
		switch {
		case j >= len(bents) || (i < len(interest) && interest[i].State.ID < bents[j].ID):
			w := &work[k]
			if w.send {
				s.Entities = append(s.Entities, w.rec)
				out.Ents = append(out.Ents, *interest[i].State)
				e.stats.Sent++
			} else {
				keep(w.rec.ID, w.prio)
				e.stats.Deferred++
			}
			k++
			i++
		case i >= len(interest) || bents[j].ID < interest[i].State.ID:
			j++
		default:
			c, b := &interest[i], &bents[j]
			switch {
			case k < len(work) && work[k].rec.ID == c.State.ID:
				w := &work[k]
				if w.send {
					s.Entities = append(s.Entities, w.rec)
					out.Ents = append(out.Ents, *c.State)
					e.stats.Sent++
				} else {
					out.Ents = append(out.Ents, *b)
					keep(w.rec.ID, w.prio)
					e.stats.Deferred++
				}
				k++
			case c.Due:
				out.Ents = append(out.Ents, *c.State)
			default:
				out.Ents = append(out.Ents, *b)
				keep(c.State.ID, old.get(c.State.ID))
			}
			i++
			j++
		}
	}
	e.accIDs, e.accIDs2 = newIDs, e.accIDs
	e.accVals, e.accVals2 = newVals, e.accVals
	e.work = work
	return s
}

// TestBudgetedMatchesReference drives the WP19 encoder and the reference
// with identical, adversarial input: crowds joining and leaving interest,
// rings due at different rates, health/name/level changes, lost and
// reordered acks, several budgets (tiny, the 150 kbps default, generous).
func TestBudgetedMatchesReference(t *testing.T) {
	for _, tc := range []struct {
		n       int
		budget  float64
		burst   float64
		seed    int64
		ackLoss int // percent
	}{
		{143, 150_000.0 / 8, 3, 1, 0},
		{400, 150_000.0 / 8, 3, 2, 10},
		{60, 150_000.0 / 8, 3, 3, 30},
		{300, 2_000.0 / 8, 1, 4, 5},     // tiny: oversized-record rule
		{200, 2_000_000.0 / 8, 3, 5, 5}, // generous: everything fits
		{1200, 150_000.0 / 8, 3, 6, 3},
	} {
		rng := rand.New(rand.NewSource(tc.seed))
		var enc Encoder
		var ref refEncoder
		enc.SetBudget(tc.budget, 30, tc.burst, 4)
		ref.SetBudget(tc.budget, 30, tc.burst, 4)
		ents := make([]EntState, tc.n)
		for i := range ents {
			ents[i] = EntState{ID: uint32(3*i + 2), Kind: proto.EntityKind(1 + rng.Intn(3)), X: rng.Int31n(60000) - 30000, Z: rng.Int31n(60000) - 30000,
				HealthPct: 100, Name: []string{"A", "Walker", "Somebody Long"}[rng.Intn(3)], Level: 1}
		}
		in := make([]bool, tc.n)
		for i := range in {
			in[i] = rng.Intn(10) != 0
		}
		ack := uint32(0)
		var wa, wb proto.Writer
		self := proto.SelfState{Health: 100, HealthMax: 100}
		for tick := uint32(1); tick <= 600; tick++ {
			cands := make([]Candidate, 0, tc.n)
			for i := range ents {
				e := &ents[i]
				if rng.Intn(100) < 2 {
					in[i] = !in[i]
				}
				if !in[i] {
					continue
				}
				switch r := rng.Intn(100); {
				case r < 60:
					e.X += int32(rng.Intn(33) - 16)
					e.Vx = int16(rng.Intn(1000) - 500)
				case r < 62:
					e.HealthPct = uint8(rng.Intn(101))
				case r < 63:
					e.Name = "Renamed"
				case r < 64:
					e.Level++
				}
				d := math.Hypot(float64(e.X), float64(e.Z)) / 100
				due := d < 64 || (d < 200 && (tick+e.ID)%3 == 0) || (tick+e.ID)%15 == 0
				cands = append(cands, Candidate{State: e, Due: due, Weight: 16 / (d + 8)})
			}
			self.X += 7
			a := enc.Build(tick, ack, tick, float64(tick), &self, cands)
			wa.Reset()
			proto.WriteMessage(&wa, a)
			b := ref.Build(tick, ack, tick, float64(tick), &self, cands)
			wb.Reset()
			proto.WriteMessage(&wb, b)
			if !bytes.Equal(wa.B, wb.B) {
				t.Fatalf("n=%d seed=%d tick %d: snapshot bytes differ (%d vs %d bytes)", tc.n, tc.seed, tick, len(wa.B), len(wb.B))
			}
			if enc.tokens != ref.tokens || enc.stats != ref.stats || !slices.Equal(enc.accIDs, ref.accIDs) || !slices.Equal(enc.accVals, ref.accVals) {
				t.Fatalf("n=%d seed=%d tick %d: encoder state differs", tc.n, tc.seed, tick)
			}
			if rng.Intn(100) >= tc.ackLoss {
				ack = tick - uint32(rng.Intn(3)) // acks lag 0-2 ticks, sometimes skip
			}
		}
		if enc.stats.Deferred == 0 && tc.budget < 1e6/8 && tc.n >= 143 {
			t.Fatalf("n=%d: budget never deferred anything; the test is not exercising selection", tc.n)
		}
	}
}
