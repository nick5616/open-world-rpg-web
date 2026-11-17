package explore

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"math"
)

// Bitset is a per-character set of atlas site indices, stored as bytes
// (bit i = byte i/8, bit i%8, LSB first) in character_progress bytea
// columns and in local save blobs. Short sets are zero-extended, so a set
// saved before the atlas grew (it can't for a pinned world, but defensively)
// still reads.
type Bitset []byte

// Has reports whether bit i is set.
func (b Bitset) Has(i int) bool { return i >= 0 && i/8 < len(b) && b[i/8]&(1<<(i%8)) != 0 }

// Set sets bit i (the set must already be large enough; see Progress.ensure).
func (b Bitset) Set(i int) { b[i/8] |= 1 << (i % 8) }

// Count is the number of set bits.
func (b Bitset) Count() int {
	n := 0
	for _, x := range b {
		for ; x != 0; x &= x - 1 {
			n++
		}
	}
	return n
}

func grow(b Bitset, bits int) Bitset {
	need := (bits + 7) / 8
	if len(b) >= need {
		return b
	}
	return append(b, make([]byte, need-len(b))...)
}

// Pin is one map marker. X, Z are meters (stored as cm on the wire and in
// the database, so every host shows it at the same centimeter).
type Pin struct {
	Slot  uint8 `json:"slot"`
	Color uint8 `json:"color"`
	XCm   int32 `json:"x"`
	ZCm   int32 `json:"z"`
}

// Progress is one character's exploration state: spec 11's
// character_progress bitsets (towers, waypoints, discoveries), the
// characters row's level / xp / last_waypoint, and personal pins (migration
// 0004 `character_progress.pins`). Owned by the tick.
type Progress struct {
	Towers      Bitset
	Waypoints   Bitset
	Discoveries Bitset
	// Attuned: tower crystals attuned (playtest 1, migration 0021
	// character_progress.attuned): each first attunement is a permanent boon.
	Attuned      Bitset
	XP           int64
	Level        int
	LastWaypoint int // site index, -1 none
	Pins         []Pin

	dirty bool
}

// NewProgress is a fresh level-1 character.
func NewProgress() *Progress { return &Progress{Level: 1, LastWaypoint: -1} }

func (p *Progress) ensure(sites int) {
	p.Towers = grow(p.Towers, sites)
	p.Waypoints = grow(p.Waypoints, sites)
	p.Discoveries = grow(p.Discoveries, sites)
	p.Attuned = grow(p.Attuned, sites)
}

// Dirty reports unsaved changes; MarkSaved clears the flag once a save
// has been queued.
func (p *Progress) Dirty() bool { return p.dirty }

// MarkSaved clears the dirty flag.
func (p *Progress) MarkSaved() { p.dirty = false }

// MarkDirty flags a change made outside this package.
func (p *Progress) MarkDirty() { p.dirty = true }

// XPForNextLevel is the XP from level to level+1: wizard-wars' 60 + 40 * level
// plus a decaying early-game surcharge (playtest 3: level 2 came after the
// first discovery). Level 1 needs 360 (a first session: the spawn town, the
// meadows quest and a handful of kills), 300, 260, 240, then the plain curve
// from level 5 on, so nothing past the opening is slower than before.
func XPForNextLevel(level int) int64 {
	base := 60 + 40*int64(level)
	if level >= 1 && level <= len(earlyXPExtra) {
		base += earlyXPExtra[level-1]
	}
	return base
}

// earlyXPExtra is the surcharge for levels 1..4 (twinned in the client's
// progression/gains.ts xpForLevel).
var earlyXPExtra = [...]int64{260, 160, 80, 20}

// LevelForXP is the character level for a total XP (wizard-wars xpProgress).
func LevelForXP(xp int64) int {
	level := 1
	for rem := xp; rem >= XPForNextLevel(level) && level < 255; level++ {
		rem -= XPForNextLevel(level)
	}
	return level
}

// KeepLevel makes a loaded character never lose a level to a curve change
// (CR 048 raised the early levels): when the stored level is above what the
// XP reaches, the XP is raised to that level's start.
func (p *Progress) KeepLevel() {
	if p.Level > LevelForXP(p.XP) {
		p.XP = XPForLevel(p.Level)
		p.dirty = true
	}
}

// AddXP adds XP and recomputes the level; returns true on a level-up.
func (p *Progress) AddXP(xp int64) bool {
	if xp <= 0 {
		return false
	}
	p.XP += xp
	p.dirty = true
	old := p.Level
	p.Level = LevelForXP(p.XP)
	return p.Level > old
}

// SetPin places or moves personal pin slot (0..MaxPersonalPins-1).
func (p *Progress) SetPin(slot, color uint8, xCm, zCm int32) bool {
	if int(slot) >= MaxPersonalPins {
		return false
	}
	for i := range p.Pins {
		if p.Pins[i].Slot == slot {
			p.Pins[i] = Pin{slot, color, xCm, zCm}
			p.dirty = true
			return true
		}
	}
	p.Pins = append(p.Pins, Pin{slot, color, xCm, zCm})
	p.dirty = true
	return true
}

// ClearPin removes personal pin slot; false if it wasn't set.
func (p *Progress) ClearPin(slot uint8) bool {
	for i := range p.Pins {
		if p.Pins[i].Slot == slot {
			p.Pins = append(p.Pins[:i], p.Pins[i+1:]...)
			p.dirty = true
			return true
		}
	}
	return false
}

// PinsJSON is the pins column / save-blob value.
func (p *Progress) PinsJSON() []byte {
	if len(p.Pins) == 0 {
		return []byte("[]")
	}
	b, _ := json.Marshal(p.Pins)
	return b
}

// LoadPinsJSON parses a pins value, dropping anything out of range (a
// hand-edited row must not break a login).
func (p *Progress) LoadPinsJSON(b []byte) {
	p.Pins = nil
	var pins []Pin
	if len(b) == 0 || json.Unmarshal(b, &pins) != nil {
		return
	}
	seen := map[uint8]bool{}
	for _, x := range pins {
		if int(x.Slot) < MaxPersonalPins && !seen[x.Slot] {
			seen[x.Slot] = true
			p.Pins = append(p.Pins, x)
		}
	}
}

// ---- Event payloads (contracts/events.md, kinds 603 and 605) ----

// ProgressVersion is the first byte of a progress_sync payload.
const ProgressVersion = 1

// EncodeProgress is the progress_sync (603) Event data:
//
//	u8 version (1) | u64 xp | u16 level | i32 lastWaypoint site (-1 none)
//	| u32 revealedRegions bitmask | u16 n + n bytes towers | u16 n + n bytes waypoints
//	| u16 n + n bytes discoveries
//
// All little-endian, like the rest of the protocol.
func EncodeProgress(p *Progress, revealed uint32) []byte {
	b := make([]byte, 0, 21+len(p.Towers)+len(p.Waypoints)+len(p.Discoveries))
	b = append(b, ProgressVersion)
	b = binary.LittleEndian.AppendUint64(b, uint64(p.XP))
	b = binary.LittleEndian.AppendUint16(b, uint16(p.Level))
	b = binary.LittleEndian.AppendUint32(b, uint32(int32(p.LastWaypoint)))
	b = binary.LittleEndian.AppendUint32(b, revealed)
	for _, s := range []Bitset{p.Towers, p.Waypoints, p.Discoveries} {
		b = binary.LittleEndian.AppendUint16(b, uint16(len(s)))
		b = append(b, s...)
	}
	return b
}

// DecodeProgress is the inverse (tests; the TS twin is in client/src/ui/map/events.ts).
func DecodeProgress(b []byte) (*Progress, uint32, error) {
	if len(b) < 19 || b[0] != ProgressVersion {
		return nil, 0, errors.New("explore: bad progress payload")
	}
	le := binary.LittleEndian
	p := &Progress{XP: int64(le.Uint64(b[1:])), Level: int(le.Uint16(b[9:])), LastWaypoint: int(int32(le.Uint32(b[11:])))}
	revealed := le.Uint32(b[15:])
	o := 19
	sets := make([]Bitset, 3)
	for i := range sets {
		if o+2 > len(b) {
			return nil, 0, errors.New("explore: progress payload truncated")
		}
		n := int(le.Uint16(b[o:]))
		o += 2
		if o+n > len(b) {
			return nil, 0, errors.New("explore: progress payload truncated")
		}
		sets[i] = append(Bitset(nil), b[o:o+n]...)
		o += n
	}
	p.Towers, p.Waypoints, p.Discoveries = sets[0], sets[1], sets[2]
	return p, revealed, nil
}

// PinView is a pin as the pins Event (605) shows it to one player.
type PinView struct {
	Party bool // a party pin (shared), else your personal pin
	Slot  uint8
	Color uint8
	XCm   int32
	ZCm   int32
	Owner string // party pins: who placed it
}

// EncodePins is the pins (605) Event data: the full list the player should
// show (personal + party), replacing the previous list:
//
//	u8 version (1) | u8 count | count x (u8 flags (bit 0 party) | u8 slot
//	| u8 color | i32 xCm | i32 zCm | u16 len + UTF-8 owner)
func EncodePins(pins []PinView) []byte {
	b := []byte{1, uint8(min(len(pins), 255))}
	for i, p := range pins {
		if i == 255 {
			break
		}
		var flags uint8
		if p.Party {
			flags = 1
		}
		b = append(b, flags, p.Slot, p.Color)
		b = binary.LittleEndian.AppendUint32(b, uint32(p.XCm))
		b = binary.LittleEndian.AppendUint32(b, uint32(p.ZCm))
		owner := p.Owner
		if len(owner) > 64 {
			owner = owner[:64]
		}
		b = binary.LittleEndian.AppendUint16(b, uint16(len(owner)))
		b = append(b, owner...)
	}
	return b
}

// DecodePins is the inverse (tests).
func DecodePins(b []byte) ([]PinView, error) {
	if len(b) < 2 || b[0] != 1 {
		return nil, errors.New("explore: bad pins payload")
	}
	le := binary.LittleEndian
	n := int(b[1])
	o := 2
	out := make([]PinView, 0, n)
	for i := 0; i < n; i++ {
		if o+13 > len(b) {
			return nil, errors.New("explore: pins payload truncated")
		}
		p := PinView{Party: b[o]&1 != 0, Slot: b[o+1], Color: b[o+2], XCm: int32(le.Uint32(b[o+3:])), ZCm: int32(le.Uint32(b[o+7:]))}
		l := int(le.Uint16(b[o+11:]))
		o += 13
		if o+l > len(b) {
			return nil, errors.New("explore: pins payload truncated")
		}
		p.Owner = string(b[o : o+l])
		o += l
		out = append(out, p)
	}
	return out, nil
}

// PackPinPos is how Interact carries a pin position in its u64 targetId:
// x cm in the low 32 bits, z cm in the high 32 (both u32: the world is
// [0, 409600) cm). UnpackPinPos validates it.
func PackPinPos(xCm, zCm int32) uint64 { return uint64(uint32(xCm)) | uint64(uint32(zCm))<<32 }

// UnpackPinPos returns the pin position or ok=false when outside the world.
func UnpackPinPos(v uint64, worldSizeM float64) (int32, int32, bool) {
	x, z := uint32(v), uint32(v>>32)
	lim := uint32(math.Round(worldSizeM * 100))
	if x >= lim || z >= lim {
		return 0, 0, false
	}
	return int32(x), int32(z), true
}
