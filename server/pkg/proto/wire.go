// Package proto is the Go side of the zone wire protocol. protocol_gen.go is
// generated from contracts/protocol.yaml; this file is the hand-written
// primitive runtime it uses (it knows bytes, never messages).
package proto

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"unicode/utf8"
)

// Writer appends little-endian primitives to B. Reuse one per connection and
// reset with w.B = w.B[:0] so steady-state snapshot encoding allocates nothing.
type Writer struct {
	B []byte
}

func (w *Writer) Reset()        { w.B = w.B[:0] }
func (w *Writer) U8(v uint8)    { w.B = append(w.B, v) }
func (w *Writer) I8(v int8)     { w.B = append(w.B, byte(v)) }
func (w *Writer) U16(v uint16)  { w.B = binary.LittleEndian.AppendUint16(w.B, v) }
func (w *Writer) I16(v int16)   { w.B = binary.LittleEndian.AppendUint16(w.B, uint16(v)) }
func (w *Writer) U32(v uint32)  { w.B = binary.LittleEndian.AppendUint32(w.B, v) }
func (w *Writer) I32(v int32)   { w.B = binary.LittleEndian.AppendUint32(w.B, uint32(v)) }
func (w *Writer) U64(v uint64)  { w.B = binary.LittleEndian.AppendUint64(w.B, v) }
func (w *Writer) I64(v int64)   { w.B = binary.LittleEndian.AppendUint64(w.B, uint64(v)) }
func (w *Writer) F32(v float32) { w.U32(math.Float32bits(v)) }
func (w *Writer) F64(v float64) { w.U64(math.Float64bits(v)) }
func (w *Writer) Bool(v bool) {
	if v {
		w.U8(1)
	} else {
		w.U8(0)
	}
}

// Str writes a u16 length + UTF-8. Strings over 65535 bytes are truncated
// (callers validate lengths long before this; names are <= 40 chars).
func (w *Writer) Str(v string) {
	if len(v) > 0xffff {
		v = v[:0xffff]
	}
	w.U16(uint16(len(v)))
	w.B = append(w.B, v...)
}

func (w *Writer) Bytes(v []byte) {
	w.U32(uint32(len(v)))
	w.B = append(w.B, v...)
}

// ErrTruncated is returned when a message ends early.
var ErrTruncated = errors.New("proto: truncated message")

// Reader reads primitives; the first failure sticks in Err and later reads
// return zero values, so generated code needs no per-field error checks.
type Reader struct {
	B   []byte
	Off int
	Err error
}

func (r *Reader) take(n int) []byte {
	if r.Err != nil {
		return nil
	}
	if n < 0 || r.Off+n > len(r.B) {
		r.Err = ErrTruncated
		return nil
	}
	b := r.B[r.Off : r.Off+n]
	r.Off += n
	return b
}

func (r *Reader) U8() uint8 {
	if b := r.take(1); b != nil {
		return b[0]
	}
	return 0
}
func (r *Reader) I8() int8 { return int8(r.U8()) }
func (r *Reader) U16() uint16 {
	if b := r.take(2); b != nil {
		return binary.LittleEndian.Uint16(b)
	}
	return 0
}
func (r *Reader) I16() int16 { return int16(r.U16()) }
func (r *Reader) U32() uint32 {
	if b := r.take(4); b != nil {
		return binary.LittleEndian.Uint32(b)
	}
	return 0
}
func (r *Reader) I32() int32 { return int32(r.U32()) }
func (r *Reader) U64() uint64 {
	if b := r.take(8); b != nil {
		return binary.LittleEndian.Uint64(b)
	}
	return 0
}
func (r *Reader) I64() int64   { return int64(r.U64()) }
func (r *Reader) F32() float32 { return math.Float32frombits(r.U32()) }
func (r *Reader) F64() float64 { return math.Float64frombits(r.U64()) }
func (r *Reader) Bool() bool   { return r.U8() != 0 }

func (r *Reader) Str() string {
	n := int(r.U16())
	b := r.take(n)
	if b == nil {
		return ""
	}
	if !utf8.Valid(b) {
		r.Err = errors.New("proto: invalid utf-8 string")
		return ""
	}
	return string(b)
}

func (r *Reader) Bytes() []byte {
	n := int(r.U32())
	b := r.take(n)
	if b == nil {
		return nil
	}
	out := make([]byte, n)
	copy(out, b)
	return out
}

// Count reads a list length and rejects counts the remaining bytes can't hold
// (every item is at least one byte), so a hostile count can't force a huge make().
func (r *Reader) Count() int {
	n := int(r.U16())
	if r.Err != nil {
		return 0
	}
	if n > len(r.B)-r.Off {
		r.Err = ErrTruncated
		return 0
	}
	return n
}

// WriteMessage appends one framed message ([id][body]).
func WriteMessage(w *Writer, m Message) {
	w.U8(m.MsgID())
	m.WriteBody(w)
}

// Encode returns a freshly allocated framed message.
func Encode(m Message) []byte {
	var w Writer
	WriteMessage(&w, m)
	return w.B
}

// DecodeMessage decodes one framed message. Strict: unknown ids, truncation and
// trailing bytes are errors (a peer on another protocol version is kicked at
// Hello, so trailing bytes here mean corruption).
func DecodeMessage(b []byte) (Message, error) {
	r := Reader{B: b}
	id := r.U8()
	if r.Err != nil {
		return nil, r.Err
	}
	m := NewMessage(id)
	if m == nil {
		return nil, fmt.Errorf("proto: unknown message id %d", id)
	}
	m.ReadBody(&r)
	if r.Err != nil {
		return nil, fmt.Errorf("proto: %s: %w", MessageName(id), r.Err)
	}
	if r.Off != len(b) {
		return nil, fmt.Errorf("proto: %s: %d trailing bytes", MessageName(id), len(b)-r.Off)
	}
	return m, nil
}
