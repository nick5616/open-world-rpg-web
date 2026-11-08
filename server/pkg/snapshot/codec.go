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
}

// Encoder is the zone's per-client snapshot state. Not goroutine-safe; the
// tick owns it.
type Encoder struct {
	r    ring
	last uint32
	snap proto.Snapshot
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
