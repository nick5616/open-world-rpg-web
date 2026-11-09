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
	// NameID is NameID(State.Name) when the caller caches it (WP19: the
	// zone interns once per entity); 0 with a non-empty name = look it up.
	NameID uint32
	// Ref is 1 + the entity's index in the History store opened for this
	// tick (G5: the encoder's frames then refer to the shared state instead
	// of copying it); 0 = no shared copy, the encoder keeps its own.
	Ref uint32
}

// nameID is c's interned name.
func (c *Candidate) nameID() uint32 {
	if c.NameID != 0 || c.State.Name == "" {
		return c.NameID
	}
	return NameID(c.State.Name)
}

// Encoder is the zone's per-client snapshot state. Not goroutine-safe; the
// tick owns it.
type Encoder struct {
	r    encRing // compact, pointer-free frames of state references (compact.go)
	last uint32
	snap proto.Snapshot
	// States the frames refer to (compact.go): the zone's shared History
	// and this encoder's own per-tick arena.
	hist    *History
	useHist bool // hist holds this Build's tick
	own     [histLen]histSlot

	// Byte budget (decision 0005). Zero perTick = unlimited.
	perTick  float64
	burst    float64
	overhead int
	tokens   float64
	// Priority accumulators of deferred entities, sorted by id (parallel
	// slices, double-buffered). Interest is sorted by id too, so reading and
	// rewriting them is a merge walk: no hashing in the tick's hottest loop
	// (150 clients x 150 entities x 30 Hz).
	accIDs, accIDs2   []uint32
	accVals, accVals2 []float64
	work              []pendingRec
	recs              []filledRec
	order             []prioIdx
	stats             BudgetStats
}

// SetHistory makes the encoder refer to h's states for candidates with a
// Ref (G5, compact.go). Set it once; a reset encoder (zero value) has none.
// Changing it to another History while frames refer to the old one would
// break them, so a different h after the first is ignored.
func (e *Encoder) SetHistory(h *History) {
	if e.hist == nil {
		e.hist = h
	}
}

// pendingRec is one record the client could get this tick. WP19: the record
// itself (Diff + RecordSize) is computed only when the selection reaches it
// (fill), so the many records a dense crowd defers cost no diffing. G5: kept
// small (the record lives in recs once made), since a dense crowd has
// hundreds of these per client per tick and most are only ranked.
type pendingRec struct {
	prio float64
	base int32  // index of the baseline entry in bents, -1 first sight
	cur  int32  // index in interest
	name uint32 // the candidate's name id
	rec  int32  // 1 + index in Encoder.recs once filled
	send bool
}

type filledRec struct {
	rec  proto.EntityRecord
	size int
}

// fill computes w's record and its size once.
func (e *Encoder) fill(w *pendingRec, interest []Candidate, bents []entRef) *filledRec {
	if w.rec == 0 {
		cur := interest[w.cur].State
		var r proto.EntityRecord
		if w.base < 0 {
			r = Diff(nil, cur)
		} else {
			r = diffEnc(e.state(&bents[w.base]), cur, w.name)
		}
		e.recs = append(e.recs, filledRec{rec: r, size: RecordSize(&r)})
		w.rec = int32(len(e.recs))
	}
	return &e.recs[w.rec-1]
}

type prioIdx struct {
	prio float64
	k    int32
}

// BudgetStats counts what the budget did (zone metrics and soak evidence).
type BudgetStats struct {
	// Deferred counts records that were due and changed but did not fit;
	// they went out later with the accumulated delta.
	Deferred uint64
	// Sent counts records that were due and changed and went out.
	Sent uint64
	// Charged counts non-snapshot bytes charged to the budget (Charge).
	Charged uint64
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
}

// Charge spends n bytes of the client's allowance on traffic other than
// snapshots (WP19b, decision 0005: reliable events ride the same downlink,
// so they come out of the same budget). The next snapshots get that much
// less room for entity records. The debt is capped at one burst (budget
// carry-over) so a one-off large reliable message (an inventory on join)
// costs a few ticks of entity updates, not seconds. No-op without a budget.
func (e *Encoder) Charge(n int) {
	if e.perTick <= 0 || n <= 0 {
		return
	}
	e.tokens -= float64(n)
	if e.tokens < -e.burst {
		e.tokens = -e.burst
	}
	e.stats.Charged += uint64(n)
}

// accCursor walks the sorted accumulator slices alongside sorted interest.
type accCursor struct {
	ids  []uint32
	vals []float64
	p    int
}

// get returns the accumulator for id; ids must be asked in ascending order.
func (c *accCursor) get(id uint32) float64 {
	for c.p < len(c.ids) && c.ids[c.p] < id {
		c.p++
	}
	if c.p < len(c.ids) && c.ids[c.p] == id {
		return c.vals[c.p]
	}
	return 0
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

// Last returns a copy of the newest frame built (not necessarily acked), or
// nil. It allocates (the encoder keeps compact frames, compact.go): tests
// and tools use it; the zone asks Known/Knows.
func (e *Encoder) Last() *Frame {
	f := e.r.get(e.last)
	if f == nil {
		return nil
	}
	out := &Frame{Tick: f.Tick, Self: f.Self}
	for i := range f.Ents {
		out.Ents = append(out.Ents, e.state(&f.Ents[i]).state())
	}
	return out
}

// baseline returns the frame a snapshot at tick would delta against, given
// the client's newest ack, or nil for a full snapshot.
func (e *Encoder) baseline(tick, ackTick uint32) *encFrame {
	if ackTick == 0 || ackTick >= tick || tick-ackTick >= Ring {
		return nil
	}
	return e.r.get(ackTick)
}

// Build makes the snapshot for tick. interest must be sorted by ID and must
// not contain the client's own entity; self carries full values. The returned
// Snapshot is reused by the next Build: encode it before calling again.
func (e *Encoder) Build(tick, ackTick, ackSeq uint32, serverTime float64, self *proto.SelfState, interest []Candidate) *proto.Snapshot {
	base := e.baseline(tick, ackTick)
	out := e.r.slot(tick)
	e.last = tick
	e.useHist = e.hist != nil && e.hist.Tick() == tick
	own := &e.own[tick%histLen] // held tick-64's states: no usable frame refers to them
	own.tick, own.ents = tick, own.ents[:0]

	s := &e.snap
	s.Tick, s.AckInputSeq, s.ServerTime = tick, ackSeq, serverTime
	s.Entities, s.Removed = s.Entities[:0], s.Removed[:0]

	var bents []entRef
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
		e.buildBudgeted(tick, s, out, bents, interest)
		return s
	}

	i, j := 0, 0
	for i < len(interest) || j < len(bents) {
		switch {
		case j >= len(bents) || (i < len(interest) && interest[i].State.ID < bents[j].ID):
			c := &interest[i]
			s.Entities = append(s.Entities, Diff(nil, c.State))
			out.Ents = append(out.Ents, e.refCur(tick, c, c.nameID()))
			i++
		case i >= len(interest) || bents[j].ID < interest[i].State.ID:
			s.Removed = append(s.Removed, bents[j].ID)
			j++
		default:
			c, b := &interest[i], &bents[j]
			if c.Due {
				n := c.nameID()
				if e.changed(c, n, b) {
					s.Entities = append(s.Entities, diffEnc(e.state(b), c.State, n))
					out.Ents = append(out.Ents, e.refCur(tick, c, n))
				} else {
					out.Ents = append(out.Ents, e.unchanged(tick, c, b))
				}
			} else {
				out.Ents = append(out.Ents, e.carry(tick, b))
			}
			i++
			j++
		}
	}
	return s
}

// unchanged is the frame entry for a due candidate equal to its baseline
// state b: the shared current state when there is one (a fresh reference
// that never needs carrying), else b carried forward.
func (e *Encoder) unchanged(tick uint32, c *Candidate, b *entRef) entRef {
	if c.Ref != 0 && e.useHist {
		return entRef{ID: b.ID, Tick: tick, idx: c.Ref - 1, fp: e.hist.cur.fp[c.Ref-1]}
	}
	return e.carry(tick, b)
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
func (e *Encoder) buildBudgeted(tick uint32, s *proto.Snapshot, out *encFrame, bents []entRef, interest []Candidate) {
	work := e.work[:0]
	e.recs = e.recs[:0]
	acc := accCursor{ids: e.accIDs, vals: e.accVals}

	i, j := 0, 0
	for i < len(interest) || j < len(bents) {
		switch {
		case j >= len(bents) || (i < len(interest) && interest[i].State.ID < bents[j].ID):
			c := &interest[i]
			work = append(work, pendingRec{base: -1, cur: int32(i), name: c.nameID(), prio: acc.get(c.State.ID) + weightOf(c)})
			i++
		case i >= len(interest) || bents[j].ID < interest[i].State.ID:
			s.Removed = append(s.Removed, bents[j].ID)
			j++
		default:
			c := &interest[i]
			// Changed iff Diff's mask would be non-zero (same compares every
			// diffed field).
			if c.Due {
				if n := c.nameID(); e.changed(c, n, &bents[j]) {
					work = append(work, pendingRec{base: int32(j), cur: int32(i), name: n, prio: acc.get(c.State.ID) + weightOf(c)})
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
	// Strict priority (highest accumulated priority first, ties to the lower
	// id): records go out in that order until the first that does not fit,
	// which waits for allowance rather than being overtaken. WP19: a binary
	// heap pops only as many records as the allowance reaches (a few dozen
	// of a dense crowd's hundreds) instead of sorting them all; pops come
	// out in exactly the sorted order, and when everything fits this sends
	// everything, as the old "it all fits" fast path did.
	h := e.order[:0]
	for k := range work {
		h = append(h, prioIdx{prio: work[k].prio, k: int32(k)})
	}
	heapInit(h)
	for len(h) > 0 {
		w := &work[h[0].k]
		size := e.fill(w, interest, bents).size
		if float64(spent+size) > avail {
			break
		}
		w.send = true
		spent += size
		h = heapPop(h)
	}
	// A record bigger than any tick's allowance (a long name on first
	// sight with a tiny budget) still goes out once the bucket is full.
	if spent == 0 && len(h) > 0 && e.tokens >= e.burst-1e-9 {
		w := &work[h[0].k]
		w.send = true
		spent = e.fill(w, interest, bents).size
	}
	e.order = h[:0]
	e.tokens -= float64(fixed + spent)

	// Second pass: write records and the frame in id order, and rebuild the
	// accumulators: deferred entities keep (accumulated + weight), sent ones
	// reset, entities with no record this tick carry theirs, and entities
	// that left interest drop out.
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
				s.Entities = append(s.Entities, e.recs[w.rec-1].rec)
				out.Ents = append(out.Ents, e.refCur(tick, &interest[i], w.name))
				e.stats.Sent++
			} else {
				keep(interest[i].State.ID, w.prio)
				e.stats.Deferred++
			}
			k++
			i++
		case i >= len(interest) || bents[j].ID < interest[i].State.ID:
			j++
		default:
			c, b := &interest[i], &bents[j]
			switch {
			case k < len(work) && int(work[k].cur) == i:
				w := &work[k]
				if w.send {
					s.Entities = append(s.Entities, e.recs[w.rec-1].rec)
					out.Ents = append(out.Ents, e.refCur(tick, c, w.name))
					e.stats.Sent++
				} else {
					out.Ents = append(out.Ents, e.carry(tick, b))
					keep(b.ID, w.prio)
					e.stats.Deferred++
				}
				k++
			case c.Due:
				out.Ents = append(out.Ents, e.unchanged(tick, c, b)) // equal to the current state, nothing pending
			default:
				out.Ents = append(out.Ents, e.carry(tick, b))
				keep(b.ID, old.get(b.ID)) // not due this tick: priority waits
			}
			i++
			j++
		}
	}
	e.accIDs, e.accIDs2 = newIDs, e.accIDs
	e.accVals, e.accVals2 = newVals, e.accVals
	e.work = work
}

// prioBefore is the send order: higher priority first, ties to the lower
// work index (= lower entity id, since work is built in id order).
func prioBefore(a, b prioIdx) bool {
	return a.prio > b.prio || (a.prio == b.prio && a.k < b.k)
}

// heapInit makes h a binary heap with the first record to send at h[0].
func heapInit(h []prioIdx) {
	for i := len(h)/2 - 1; i >= 0; i-- {
		heapDown(h, i)
	}
}

// heapPop removes h[0] and returns the shrunk heap.
func heapPop(h []prioIdx) []prioIdx {
	n := len(h) - 1
	h[0] = h[n]
	h = h[:n]
	heapDown(h, 0)
	return h
}

func heapDown(h []prioIdx, i int) {
	n := len(h)
	for {
		l := 2*i + 1
		if l >= n {
			return
		}
		m := l
		if r := l + 1; r < n && prioBefore(h[r], h[l]) {
			m = r
		}
		if !prioBefore(h[m], h[i]) {
			return
		}
		h[i], h[m] = h[m], h[i]
		i = m
	}
}

func weightOf(c *Candidate) float64 {
	if c.Weight <= 0 {
		return 1
	}
	return c.Weight
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
