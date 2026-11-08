package snapshot

import (
	"errors"
	"sort"

	"lodestone/server/pkg/proto"
)

// Candidate is one entity in a client's interest set this tick.
type Candidate struct {
	State *EntState
	// Due is true when the entity's AOI ring is scheduled this tick. A known
	// entity that is not due costs nothing: the new frame records the state
	// the client already has.
	Due bool
	// Weight is how fast this entity's send priority grows per due tick when
	// a byte budget is set (see Encoder.SetBudget): party members and close
	// entities grow faster. Zero counts as 1. Ignored without a budget.
	Weight float64
}

// Encoder is the zone's per-client snapshot state. Not goroutine-safe; the
// tick owns it.
type Encoder struct {
	r    ring
	last uint32
	snap proto.Snapshot

	// Byte budget (decision 0005). Zero perTick = unlimited.
	perTick  float64
	burst    float64
	overhead int
	tokens   float64
	prio     map[uint32]prioEntry
	gen      uint32
	work     []pendingRec
	order    []int
	stats    BudgetStats
}

type prioEntry struct {
	acc float64
	gen uint32
}

// pendingRec is one record the client could get this tick.
type pendingRec struct {
	rec    proto.EntityRecord
	size   int
	prio   float64
	weight float64
	send   bool
}

// BudgetStats counts what the budget did (zone metrics and soak evidence).
type BudgetStats struct {
	// Deferred counts records that were due and changed but did not fit;
	// they went out later with the accumulated delta.
	Deferred uint64
	// Sent counts records that were due and changed and went out.
	Sent uint64
}

// SetBudget caps snapshot bytes for this client (decision 0005: the AOI ring
// table is the MAXIMUM rate, the budget a ceiling on top). bytesPerSec
// includes overhead, the per-snapshot transport framing to charge (WebSocket
// header or QUIC packet). Unused allowance carries over up to burstTicks
// ticks' worth, so a large first-sight record (names) is never starved and an
// idle tick isn't wasted; over a window the client still gets at most
// bytesPerSec. bytesPerSec <= 0 removes the budget.
func (e *Encoder) SetBudget(bytesPerSec float64, tickRate int, burstTicks float64, overhead int) {
	if bytesPerSec <= 0 || tickRate <= 0 {
		e.perTick = 0
		return
	}
	if burstTicks < 1 {
		burstTicks = 1
	}
	e.perTick = bytesPerSec / float64(tickRate)
	e.burst = e.perTick * burstTicks
	e.overhead = overhead
	e.tokens = e.perTick
	if e.prio == nil {
		e.prio = map[uint32]prioEntry{}
	}
}

// Stats returns the budget counters.
func (e *Encoder) Stats() BudgetStats { return e.stats }

// RecordSize is the encoded size of r in bytes (mirrors the generated codec;
// TestRecordSizeMatchesCodec keeps it honest if the protocol changes).
func RecordSize(r *proto.EntityRecord) int {
	n := 4 + 2 // id, mask
	m := r.Mask
	for _, f := range recordFieldSizes {
		if m&f.bit != 0 {
			n += f.size
		}
	}
	if m&proto.EntityRecordHasName != 0 {
		n += 2 + len(r.Name)
	}
	return n
}

var recordFieldSizes = [...]struct {
	bit  uint16
	size int
}{
	{proto.EntityRecordHasKind, 1}, {proto.EntityRecordHasX, 4}, {proto.EntityRecordHasY, 4}, {proto.EntityRecordHasZ, 4},
	{proto.EntityRecordHasYaw, 1}, {proto.EntityRecordHasPitch, 1}, {proto.EntityRecordHasVx, 2}, {proto.EntityRecordHasVy, 2},
	{proto.EntityRecordHasVz, 2}, {proto.EntityRecordHasHealthPct, 1}, {proto.EntityRecordHasActivity, 1},
	{proto.EntityRecordHasTypeID, 2}, {proto.EntityRecordHasLevel, 1}, {proto.EntityRecordHasPartyID, 4},
}

// selfSize is the encoded size of a SelfState record.
func selfSize(s *proto.SelfState) int {
	var w proto.Writer
	s.Write(&w)
	return len(w.B)
}

// snapshotFixed is the Snapshot message size without entity records:
// msgId, tick, baselineTick, ackInputSeq, serverTime, self, two list counts,
// removed ids.
func snapshotFixed(self *proto.SelfState, removed int) int {
	return 1 + 4 + 4 + 4 + 8 + selfSize(self) + 2 + 2 + 4*removed
}

// Last returns the newest frame built (not necessarily acked), or nil. The
// zone uses it for AOI hysteresis ("does this client already know X?").
func (e *Encoder) Last() *Frame { return e.r.get(e.last) }

// Baseline returns the frame a snapshot at tick would delta against, given
// the client's newest ack, or nil for a full snapshot.
func (e *Encoder) Baseline(tick, ackTick uint32) *Frame {
	if ackTick == 0 || ackTick >= tick || tick-ackTick >= Ring {
		return nil
	}
	return e.r.get(ackTick)
}

// Build makes the snapshot for tick. interest must be sorted by ID and must
// not contain the client's own entity; self carries full values. The returned
// Snapshot is reused by the next Build: encode it before calling again.
func (e *Encoder) Build(tick, ackTick, ackSeq uint32, serverTime float64, self *proto.SelfState, interest []Candidate) *proto.Snapshot {
	base := e.Baseline(tick, ackTick)
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

	if e.perTick > 0 {
		e.buildBudgeted(s, out, bents, interest)
		return s
	}

	i, j := 0, 0
	for i < len(interest) || j < len(bents) {
		switch {
		case j >= len(bents) || (i < len(interest) && interest[i].State.ID < bents[j].ID):
			c := interest[i].State
			s.Entities = append(s.Entities, Diff(nil, c))
			out.Ents = append(out.Ents, *c)
			i++
		case i >= len(interest) || bents[j].ID < interest[i].State.ID:
			s.Removed = append(s.Removed, bents[j].ID)
			j++
		default:
			c, b := interest[i], &bents[j]
			if c.Due {
				if rec := Diff(b, c.State); rec.Mask != 0 {
					s.Entities = append(s.Entities, rec)
				}
				out.Ents = append(out.Ents, *c.State)
			} else {
				out.Ents = append(out.Ents, *b)
			}
			i++
			j++
		}
	}
	return s
}

// buildBudgeted is Build under a byte budget (decision 0005). Same merge as
// the unlimited path, in two passes: the first collects every record the
// client could get (new entities, and due entities that changed against the
// acked baseline) and decides which fit, the second writes the snapshot and
// the frame in ID order. Priority is a per-entity accumulator: each due tick
// an entity is deferred, its priority grows by its Weight, and sending it
// resets it. Close and party entities grow fastest, but anyone starved long
// enough wins a turn (the "age bonus"). A deferred known entity keeps its
// baseline state in the new frame, so its next record carries the whole
// accumulated change: nothing is lost, only rate. A deferred NEW entity is
// left out of the frame and tried again next tick.
func (e *Encoder) buildBudgeted(s *proto.Snapshot, out *Frame, bents []EntState, interest []Candidate) {
	e.gen++
	work := e.work[:0]

	i, j := 0, 0
	for i < len(interest) || j < len(bents) {
		switch {
		case j >= len(bents) || (i < len(interest) && interest[i].State.ID < bents[j].ID):
			c := &interest[i]
			work = append(work, pendingRec{rec: Diff(nil, c.State), weight: c.Weight})
			i++
		case i >= len(interest) || bents[j].ID < interest[i].State.ID:
			s.Removed = append(s.Removed, bents[j].ID)
			j++
		default:
			c := &interest[i]
			if c.Due {
				if rec := Diff(&bents[j], c.State); rec.Mask != 0 {
					work = append(work, pendingRec{rec: rec, weight: c.Weight})
				}
			}
			i++
			j++
		}
	}

	e.order = e.order[:0]
	for k := range work {
		w := &work[k]
		if w.weight <= 0 {
			w.weight = 1
		}
		w.size = RecordSize(&w.rec)
		w.prio = e.prio[w.rec.ID].acc + w.weight
		e.order = append(e.order, k)
	}
	sort.SliceStable(e.order, func(a, b int) bool { return work[e.order[a]].prio > work[e.order[b]].prio })

	e.tokens += e.perTick
	if e.tokens > e.burst {
		e.tokens = e.burst
	}
	fixed := snapshotFixed(&s.Self, len(s.Removed)) + e.overhead
	avail := e.tokens - float64(fixed)
	spent := 0
	for _, k := range e.order {
		w := &work[k]
		if float64(spent+w.size) > avail {
			break // strict priority: the top record waits for allowance rather than being overtaken
		}
		w.send = true
		spent += w.size
	}
	// A record bigger than any tick's allowance (a long name on first sight
	// with a tiny budget) still goes out once the bucket is full.
	if spent == 0 && len(e.order) > 0 && e.tokens >= e.burst-1e-9 {
		w := &work[e.order[0]]
		w.send = true
		spent = w.size
	}
	e.tokens -= float64(fixed + spent)

	for k := range work {
		w := &work[k]
		if w.send {
			e.prio[w.rec.ID] = prioEntry{gen: e.gen}
			e.stats.Sent++
		} else {
			e.prio[w.rec.ID] = prioEntry{acc: w.prio, gen: e.gen}
			e.stats.Deferred++
		}
	}
	// Forget entities that left interest (no record for 64 ticks means they
	// are gone or idle with nothing pending; idle ones start again from 0).
	if e.gen%64 == 0 {
		for id, p := range e.prio {
			if e.gen-p.gen > 64 {
				delete(e.prio, id)
			}
		}
	}

	k := 0
	i, j = 0, 0
	for i < len(interest) || j < len(bents) {
		switch {
		case j >= len(bents) || (i < len(interest) && interest[i].State.ID < bents[j].ID):
			if w := &work[k]; w.send {
				s.Entities = append(s.Entities, w.rec)
				out.Ents = append(out.Ents, *interest[i].State)
			}
			k++
			i++
		case i >= len(interest) || bents[j].ID < interest[i].State.ID:
			j++
		default:
			c, b := &interest[i], &bents[j]
			switch {
			case k < len(work) && work[k].rec.ID == c.State.ID:
				if work[k].send {
					s.Entities = append(s.Entities, work[k].rec)
					out.Ents = append(out.Ents, *c.State)
				} else {
					out.Ents = append(out.Ents, *b)
				}
				k++
			case c.Due:
				out.Ents = append(out.Ents, *c.State) // unchanged: equal to b
			default:
				out.Ents = append(out.Ents, *b)
			}
			i++
			j++
		}
	}
	e.work = work
}

// Decoder rebuilds client state from snapshots (bots, tests; WP06 ports it).
type Decoder struct {
	r      ring
	latest uint32
	recIdx []int
	rem    []uint32
}

// ErrStale means the snapshot is older than one already applied (possible
// over datagrams); ignore it.
var ErrStale = errors.New("snapshot: stale")

// Latest is the newest applied tick (what the client acks).
func (d *Decoder) Latest() uint32 { return d.latest }

// Frame returns an applied frame still in the ring, or nil.
func (d *Decoder) Frame(tick uint32) *Frame { return d.r.get(tick) }

// Apply decodes s against its baseline and returns the new frame. The frame's
// slices are reused after Ring further ticks; copy anything kept longer.
func (d *Decoder) Apply(s *proto.Snapshot) (*Frame, error) {
	if s.Tick == 0 {
		return nil, errors.New("snapshot: tick 0 is reserved")
	}
	if d.latest != 0 && s.Tick <= d.latest {
		return nil, ErrStale
	}
	var base *Frame
	if s.BaselineTick != 0 {
		if s.BaselineTick >= s.Tick || s.Tick-s.BaselineTick >= Ring {
			return nil, ErrNoBaseline
		}
		if base = d.r.get(s.BaselineTick); base == nil {
			return nil, ErrNoBaseline
		}
	}
	out := d.r.slot(s.Tick)
	if base != nil {
		out.Self = ApplySelf(&base.Self, &s.Self)
	} else {
		out.Self = ApplySelf(nil, &s.Self)
	}

	// Records arrive in ID order from our encoder, but don't rely on it.
	d.recIdx = d.recIdx[:0]
	for k := range s.Entities {
		d.recIdx = append(d.recIdx, k)
	}
	sort.SliceStable(d.recIdx, func(a, b int) bool { return s.Entities[d.recIdx[a]].ID < s.Entities[d.recIdx[b]].ID })
	d.rem = append(d.rem[:0], s.Removed...)
	sort.Slice(d.rem, func(a, b int) bool { return d.rem[a] < d.rem[b] })
	removed := func(id uint32) bool {
		k := sort.Search(len(d.rem), func(k int) bool { return d.rem[k] >= id })
		return k < len(d.rem) && d.rem[k] == id
	}

	var bents []EntState
	if base != nil {
		bents = base.Ents
	}
	j, k := 0, 0
	for j < len(bents) || k < len(d.recIdx) {
		switch {
		case k < len(d.recIdx) && (j >= len(bents) || s.Entities[d.recIdx[k]].ID < bents[j].ID):
			out.Ents = append(out.Ents, Apply(nil, &s.Entities[d.recIdx[k]]))
			k++
		case k >= len(d.recIdx) || bents[j].ID < s.Entities[d.recIdx[k]].ID:
			if !removed(bents[j].ID) {
				out.Ents = append(out.Ents, bents[j])
			}
			j++
		default:
			out.Ents = append(out.Ents, Apply(&bents[j], &s.Entities[d.recIdx[k]]))
			j++
			k++
		}
	}
	d.latest = s.Tick
	return out, nil
}
