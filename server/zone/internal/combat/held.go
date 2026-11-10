package combat

import (
	"encoding/binary"

	"lodestone/server/pkg/proto"
)

// Shared spell visuals (playtest 2, CR 022, docs/cr/022-shared-spell-fx.md):
// what a player is HOLDING right now, so every client draws it from the
// same state the caster's own client draws it from.
//
// A held action is one that lasts while a key stays down (or, for a
// channelled beam, for its duration) and whose look can change while it
// runs:
//
//	stream / charge  CR 020's channel (p.ch): spell id
//	beam             a channelled beam spell, for its duration: spell id
//	held dash        CR 021's sustained dash, only on steps the zone paid
//	                 for (thrusting, skating...): variant | CastFXDash
//	guard            the secondary button held on a sword, spear or bow
//	                 (parry, spear charge, bow draw): CastFXGuard
//
// Three things go on the wire, and nothing for a player who holds nothing:
//
//   - the Activity casting bit (EntityRecord.activity, a field every
//     snapshot already carries; delta-encoded, so it costs a byte only
//     when it flips): set while a held action runs. Observers end the held
//     pose and FX the moment it drops, and see a held dash's thrust stop
//     exactly where the caster's did (the carry that follows is coasting).
//   - Event 226 `held` (heldTick): the precise aim (u16 yaw, i16 pitch, the
//     caster's own input frame values; snapshots carry 8 bits each, ~1.4
//     degrees) while an aimed action (stream, charge, beam) is held, at most
//     every heldMinTicks and only when it moved at least heldAimStep, plus a
//     keepalive every heldKeepTicks for every held action so a player who
//     comes into range mid-hold learns what it is. Only to players within
//     heldRadius, never to the caster. A smaller change is sent once
//     heldSettleTicks after the last update (the aim a turn ended on).
//   - the starts and stops already on the wire (Events 214, 223).

// EvHeld (contracts/events.md 226): see the file comment. entityId = the
// player, targetId = what is held (spell id, variant | CastFXDash, or
// CastFXGuard), value = u16 yaw | i16 pitch << 16 (the input frame's
// encoding), x/y/z = the player, data = u32 start seq | u16 progress
// (stream: shots fired; charge, beam, dash, guard: steps held).
const EvHeld = 226

const (
	// heldRadius: observers of a held action (the cast FX radius).
	heldRadius = 64
	// heldMinTicks: at most one aim update per 3 ticks (10 Hz) per holder.
	heldMinTicks = 3
	// heldSettleTicks: an aim that changed by less than a step is sent this long after the last update.
	heldSettleTicks = 6
	// heldKeepTicks: a keepalive every second while held (late observers).
	heldKeepTicks = 30
	// heldAimStep: an aim update needs this much change (u16 yaw units /
	// i16 pitch units): ~0.35 degrees, a quarter of a snapshot byte.
	heldAimStepYaw   = 64
	heldAimStepPitch = 128
)

// heldState is what the last Event 226 told observers.
type heldState struct {
	id    int    // what is held now (0 none)
	since uint32 // tick it started
	last  uint32 // tick of the last 226 (or the start)
	yaw   uint16
	pitch int16
}

// beamRun is a channelled beam the player cast (held for its duration).
type beamRun struct {
	id    int
	seq   uint32
	until uint32 // zone tick it ends
}

// HeldVisual is what the player holds right now (see the file comment), 0
// for nothing. Cheap: a few field tests.
func (p *Player) HeldVisual(tick uint32) int {
	switch {
	case p.Downed:
		return 0
	case p.ch != nil:
		return p.ch.spell.ID
	case p.dash.holding && p.dash.variant != 0 && p.dash.moving > 0:
		return p.dash.variant | CastFXDash
	case p.beam.id != 0 && tick < p.beam.until:
		return p.beam.id
	case p.guardHeld:
		return CastFXGuard
	}
	return 0
}

// heldStart and heldProgress are the data of Event 226.
func (p *Player) heldStart(id int) (uint32, int) {
	switch {
	case p.ch != nil && p.ch.spell.ID == id:
		if p.ch.act != nil {
			return p.ch.start, p.ch.act.nShots
		}
		return p.ch.start, int(p.LastSeq - p.ch.start)
	case id&CastFXDash != 0:
		return p.dodgeSeq, p.dash.held
	case id == CastFXGuard:
		return p.LastSeq - uint32(p.altHeld), p.altHeld
	case p.beam.id == id:
		return p.beam.seq, int(p.LastSeq - p.beam.seq)
	}
	return 0, 0
}

// heldTick sends Event 226 for every player holding something (World.Step,
// once a tick).
func (w *World) heldTick() {
	for _, p := range w.playerList {
		h := &p.held
		id := p.HeldVisual(w.tick)
		if p.beam.id != 0 && w.tick >= p.beam.until {
			p.beam = beamRun{}
		}
		if id == 0 {
			if h.id != 0 {
				*h = heldState{}
			}
			continue
		}
		if id != h.id {
			// The start: Event 214 / 223 already carried the aim it began with.
			*h = heldState{id: id, since: w.tick, last: w.tick, yaw: p.aimYaw, pitch: p.aimPitch}
			continue
		}
		since := w.tick - h.last
		aimed := id&CastFXDash == 0 && id != CastFXGuard
		dy := int(p.aimYaw - h.yaw) // wraps: a u16 difference
		if dy > 32768 {
			dy = 65536 - dy
		}
		dp := int(p.aimPitch) - int(h.pitch)
		if dp < 0 {
			dp = -dp
		}
		moved := dy >= heldAimStepYaw || dp >= heldAimStepPitch
		// settled: the aim stopped a little off the last update (a turn that ended between
		// updates): one more, so observers rest on the exact aim.
		settled := (dy > 0 || dp > 0) && since >= heldSettleTicks
		if !(aimed && (moved && since >= heldMinTicks || settled)) && since < heldKeepTicks {
			continue
		}
		h.last, h.yaw, h.pitch = w.tick, p.aimYaw, p.aimPitch
		start, progress := p.heldStart(id)
		data := binary.LittleEndian.AppendUint32(make([]byte, 0, 6), start)
		data = binary.LittleEndian.AppendUint16(data, uint16(min(65535, max(0, progress))))
		w.near(p.Pos, heldRadius, p.ID, Out{Ev: ev(EvHeld, p.ID, uint32(id), HeldAim(p.aimYaw, p.aimPitch), p.Pos, data)})
		w.Stats.HeldEvents++
	}
}

// HeldAim packs an input frame's yaw and pitch into Event 226's value.
func HeldAim(yaw uint16, pitch int16) int32 {
	return int32(uint32(yaw) | uint32(uint16(pitch))<<16)
}

// noteHeldFrame records the frame's look and secondary-button hold for the
// held visuals (Player.Frame).
func (p *Player) noteHeldFrame(f proto.InputFrame, guard bool) {
	p.aimYaw, p.aimPitch = f.Yaw, f.Pitch
	p.guardHeld = guard
}

// noteBeam starts a channelled beam's held window (World.Frame).
func (p *Player) noteBeam(a *Action, tick uint32) {
	s := a.Spell
	if s == nil || s.Type != "beam" || s.DurationSteps <= 0 {
		return
	}
	p.beam = beamRun{id: s.ID, seq: a.Seq, until: tick + ticksOf(s.WindupSteps+s.DurationSteps)}
}

// HeldActivity is the Activity bit a player's entity record carries (the
// casting bit while a held action runs).
func (p *Player) HeldActivity(tick uint32) uint8 {
	if p.HeldVisual(tick) != 0 {
		return proto.ActivityCasting
	}
	return 0
}
