package chem

import (
	"encoding/binary"
	"errors"

	"lodestone/server/pkg/proto"
)

// Event kinds (contracts/events.md, WP15 range 500-599).
const (
	EvIgnite     = 520 // targetId = cell, value = radius (cells), data = i64 step
	EvExtinguish = 521 // same layout
	EvFreeze     = 522 // same layout
	EvPillar     = 523 // targetId = pillar id, x/y/z = centre + base (cm), value = height cm, data = i64 step | u16 half cm | u16 run cm
	EvBaseline   = 524 // targetId = chunk, data = i64 step | u16 n | n x (u16 local cell | u8 state | i32 until - step)
	EvBitmap     = 525 // targetId = chunk, data = i64 step | 256 bytes (2 bits per cell, LSB first: 0 none, 1 burning, 2 burnt, 3 frozen)
)

// OpKindOfEvent maps an op event kind to its op kind (0 = not an op event).
func OpKindOfEvent(kind uint16) uint8 {
	switch kind {
	case EvIgnite:
		return OpIgnite
	case EvExtinguish:
		return OpExtinguish
	case EvFreeze:
		return OpFreeze
	case EvPillar:
		return OpPillar
	}
	return 0
}

// OpEvent encodes an op as its Event.
func OpEvent(op Op) proto.Event {
	switch op.Kind {
	case OpPillar:
		p := op.Pillar
		d := binary.LittleEndian.AppendUint64(nil, uint64(op.Step))
		d = binary.LittleEndian.AppendUint16(d, uint16(proto.MetersToCm(p.Half)))
		d = binary.LittleEndian.AppendUint16(d, uint16(proto.MetersToCm(p.Run)))
		return proto.Event{Kind: EvPillar, TargetID: p.ID, Value: proto.MetersToCm(p.Height), X: proto.MetersToCm(p.X), Y: proto.MetersToCm(p.BaseY), Z: proto.MetersToCm(p.Z), Data: d}
	}
	kind := map[uint8]uint16{OpIgnite: EvIgnite, OpExtinguish: EvExtinguish, OpFreeze: EvFreeze}[op.Kind]
	ix, iz := CellXZ(op.Cell)
	x, z := CellCenter(ix, iz)
	return proto.Event{Kind: kind, TargetID: op.Cell, Value: op.Radius, X: proto.MetersToCm(x), Z: proto.MetersToCm(z), Data: binary.LittleEndian.AppendUint64(nil, uint64(op.Step))}
}

// QuantizePillar rounds a pillar to what its Event carries (cm), so the
// zone simulates exactly the pillar clients decode.
func QuantizePillar(p Pillar) Pillar {
	q := func(v float64) float64 { return proto.CmToMeters(proto.MetersToCm(v)) }
	p.X, p.Z, p.BaseY, p.Height, p.Half, p.Run = q(p.X), q(p.Z), q(p.BaseY), q(p.Height), q(p.Half), q(p.Run)
	return p
}

var errShort = errors.New("chem: short event data")

// DecodeOp reads an op Event (the client's path; tests).
func DecodeOp(e *proto.Event) (Op, error) {
	k := OpKindOfEvent(e.Kind)
	if k == 0 || len(e.Data) < 8 {
		return Op{}, errShort
	}
	op := Op{Kind: k, Step: int64(binary.LittleEndian.Uint64(e.Data)), Cell: e.TargetID, Radius: e.Value}
	if k == OpPillar {
		if len(e.Data) < 12 {
			return Op{}, errShort
		}
		op.Cell, op.Radius = 0, 0
		op.Pillar = Pillar{ID: e.TargetID, X: proto.CmToMeters(e.X), BaseY: proto.CmToMeters(e.Y), Z: proto.CmToMeters(e.Z), Height: proto.CmToMeters(e.Value),
			Half: proto.CmToMeters(int32(binary.LittleEndian.Uint16(e.Data[8:]))), Run: proto.CmToMeters(int32(binary.LittleEndian.Uint16(e.Data[10:])))}
	}
	return op, nil
}

// BaselineCell is one non-default cell of a chunk baseline.
type BaselineCell struct {
	ID    uint32
	State uint8
	Until int64
}

// EncodeBaseline is a chunk's full state at the simulation's step (Event 524).
func EncodeBaseline(s *Sim, chunk uint32) []byte {
	d := binary.LittleEndian.AppendUint64(nil, uint64(s.Step))
	d = append(d, 0, 0)
	n := 0
	cx, cz := int(chunk%ChunksN)*ChunkCells, int(chunk/ChunksN)*ChunkCells
	s.ChunkCellsOf(chunk, func(id uint32, st uint8, until int64) {
		ix, iz := CellXZ(id)
		d = binary.LittleEndian.AppendUint16(d, uint16((iz-cz)*ChunkCells+(ix-cx)))
		d = append(d, st)
		d = binary.LittleEndian.AppendUint32(d, uint32(int32(until-s.Step)))
		n++
	})
	binary.LittleEndian.PutUint16(d[8:], uint16(n))
	return d
}

// DecodeBaseline reads Event 524 data for a chunk.
func DecodeBaseline(chunk uint32, b []byte) (step int64, cells []BaselineCell, err error) {
	if len(b) < 10 {
		return 0, nil, errShort
	}
	step = int64(binary.LittleEndian.Uint64(b))
	n := int(binary.LittleEndian.Uint16(b[8:]))
	if len(b) < 10+7*n {
		return 0, nil, errShort
	}
	cx, cz := int(chunk%ChunksN)*ChunkCells, int(chunk/ChunksN)*ChunkCells
	for i := 0; i < n; i++ {
		p := b[10+7*i:]
		l := int(binary.LittleEndian.Uint16(p))
		cells = append(cells, BaselineCell{ID: CellID(cx+l%ChunkCells, cz+l/ChunkCells), State: p[2], Until: step + int64(int32(binary.LittleEndian.Uint32(p[3:])))})
	}
	return step, cells, nil
}

// EncodeBitmap is a chunk's 2-bit state map (Event 525, the fallback path).
func EncodeBitmap(s *Sim, chunk uint32) []byte {
	d := binary.LittleEndian.AppendUint64(nil, uint64(s.Step))
	bm := make([]byte, ChunkCells*ChunkCells/4)
	cx, cz := int(chunk%ChunksN)*ChunkCells, int(chunk/ChunksN)*ChunkCells
	s.ChunkCellsOf(chunk, func(id uint32, st uint8, _ int64) {
		ix, iz := CellXZ(id)
		l := (iz-cz)*ChunkCells + (ix - cx)
		bm[l/4] |= st << (2 * (l % 4))
	})
	return append(d, bm...)
}
