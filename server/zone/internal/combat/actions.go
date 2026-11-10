package combat

import (
	"encoding/binary"
	"math"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

// Frame runs Player.Frame for one input frame and turns what started into
// world effects: self buffs (shields, heals), the cast FX other players
// see, and refusal feedback for the caster's HUD.
func (w *World) Frame(p *Player, f proto.InputFrame, before movement.State) FrameResult {
	r := p.Frame(f, before, w.ground, w.tick)
	if r.Drink {
		w.toPlayer(p.ID, Out{Ev: ev(EvConsumable, p.ID, 1, int32(p.Charges), p.Pos, nil)})
	}
	if r.Frame.Flags&proto.InputFlagDodge != 0 && r.Frame.CastSlot != 0 {
		w.castFX(p, int(r.Frame.CastSlot)|CastFXDash, f, before)
	}
	if r.Guard {
		w.castFX(p, CastFXGuard, f, before)
	}
	if r.StopID != 0 {
		w.channelEvent(p, r, f, before, true) // CR 020: before a new start in the same frame
	}
	a := r.Started
	if a == nil {
		if r.Channel == ChannelCharge {
			w.channelEvent(p, r, f, before, false)
		}
		return r
	}
	if !a.Legal {
		w.toPlayer(p.ID, Out{Ev: ev(EvRefused, p.ID, uint32(a.ID), int32(a.Refusal), p.Pos, binary.LittleEndian.AppendUint32(nil, a.Seq))})
		return r
	}
	switch {
	case r.Channel == ChannelStream:
		w.channelEvent(p, r, f, before, false) // observers simulate the stream from its seed: nothing per shot
	case a.Spell != nil && a.Spell.Charge != nil:
		w.castFXCharge(p, a, f, before)
	case a.Move != nil && a.Charge > 0:
		w.castFXCharge(p, a, f, before) // CR 022: a charged shot's draw, so others fly it at its speed
	default:
		w.castFX(p, a.ID, f, before)
	}
	p.noteBeam(a, w.tick) // CR 022: a channelled beam is held for its duration (held.go)
	if s := a.Spell; s != nil && s.Summon != nil {
		w.summon(p, a) // CR 020 (summon.go)
	}
	if s := a.Spell; s != nil && s.Type == "defensive" {
		if s.Absorb > 0 {
			p.shield = s.Absorb * a.Weapon.SpellPower
			p.shieldEnd = w.tick + ticksOf(s.DurationSteps)
			w.toPlayer(p.ID, Out{Ev: ev(EvShield, p.ID, uint32(s.ID), int32(math.Round(p.shield)), p.Pos, nil)})
		}
		if s.Heal > 0 {
			// Halo: heal over time for you and your party nearby.
			per := s.Heal / float64(max(1, ticksOf(s.DurationSteps)))
			for _, q := range w.playersNear(p.Pos, math.Max(s.HealRadius, 1)) {
				if q == p || (p.PartyID != 0 && q.PartyID == p.PartyID) {
					q.hotPerTick, q.hotEnd = per, w.tick+ticksOf(s.DurationSteps)
					w.toPlayer(q.ID, Out{Ev: ev(EvHeal, p.ID, q.ID, int32(math.Round(s.Heal)), q.Pos, []byte{1})})
				}
			}
		}
	}
	if s := a.Spell; s != nil && s.Type == "domain" && s.Heal > 0 {
		w.healArea(p, s.Heal, s.Radius)
	}
	return r
}

// castFX tells nearby players (not the caster, who predicted it) that an
// attack or cast started, so they can draw it: entityId = caster, targetId
// = attack id (| CastFXDash for a dash variant; CastFXGuard for the
// secondary button going down, CR 018), x/y/z = origin, data = u16 yaw |
// i16 pitch.
func (w *World) castFX(p *Player, id int, f proto.InputFrame, before movement.State) {
	data := binary.LittleEndian.AppendUint16(nil, f.Yaw)
	data = binary.LittleEndian.AppendUint16(data, uint16(f.Pitch))
	w.near(before.Pos, 64, p.ID, Out{Ev: ev(EvCast, p.ID, uint32(id), 0, before.Pos, data)})
}

// channelEvent is Event 223 (CR 020): a stream started (value 1, to players
// within 64 m but the caster: data = u16 yaw | i16 pitch | u32 start seq,
// the seed of its jitter / rain pattern), a charge started gathering (value
// 2, same data) or either ended (value 0, to everyone within 64 m and the
// caster, whose prediction stops on it if the zone ran out of mana first:
// data = u16 shots fired | u32 start seq). targetId = spell id.
func (w *World) channelEvent(p *Player, r FrameResult, f proto.InputFrame, before movement.State, stop bool) {
	switch {
	case !stop:
		c := p.ch
		if c == nil {
			return
		}
		data := binary.LittleEndian.AppendUint16(nil, f.Yaw)
		data = binary.LittleEndian.AppendUint16(data, uint16(f.Pitch))
		data = binary.LittleEndian.AppendUint32(data, c.start)
		val := int32(1)
		if r.Channel == ChannelCharge {
			val = 2
		}
		w.near(before.Pos, 64, p.ID, Out{Ev: ev(EvChannel, p.ID, uint32(c.spell.ID), val, before.Pos, data)})
	default:
		id, shots, start := r.StopID, 0, uint32(0)
		if a := r.Stopped; a != nil {
			id, shots, start = a.ID, a.nShots, a.Seq
		}
		data := binary.LittleEndian.AppendUint16(nil, uint16(min(65535, shots)))
		data = binary.LittleEndian.AppendUint32(data, start)
		w.near(before.Pos, 64, 0, Out{Ev: ev(EvChannel, p.ID, uint32(id), 0, before.Pos, data)})
	}
}

// castFXCharge is Event 214 for a released charge (a charge spell, or CR
// 022 a charged weapon move: the bow's drawn shot, the spear's charge): the
// usual data plus u8 the held fraction (0..255), so observers draw the
// empowered shot.
func (w *World) castFXCharge(p *Player, a *Action, f proto.InputFrame, before movement.State) {
	data := binary.LittleEndian.AppendUint16(nil, f.Yaw)
	data = binary.LittleEndian.AppendUint16(data, uint16(f.Pitch))
	data = append(data, uint8(math.Round(a.Charge*255)))
	w.near(before.Pos, 64, p.ID, Out{Ev: ev(EvCast, p.ID, uint32(a.ID), 0, before.Pos, data)})
}

// Sync asks the host to (re)send p's combat_sync.
func (w *World) Sync(id uint32) { w.Synced = append(w.Synced, id) }

// WalkableNear finds dry, gentle ground near (x, z) (rings every 4 m up to
// search m) whose surroundings within flatR stay walkable: dev placement on
// generated terrain, so a test camp or arena never lands in a lake or on a
// cliff face. Returns the input point when nothing qualifies.
func (w *World) WalkableNear(x, z, search, flatR float64) (float64, float64) {
	ok := func(px, pz float64) bool {
		h := w.ground.HeightAt(px, pz)
		if movement.WaterAt(w.ground, px, pz) > h-0.2 || movement.SlopeAt(w.ground, px, pz).T2 > constants.WalkableTanSq*0.5 {
			return false
		}
		for k := 0; k < 8; k++ {
			a := float64(k) * math.Pi / 4
			qx, qz := px+flatR*math.Cos(a), pz+flatR*math.Sin(a)
			qh := w.ground.HeightAt(qx, qz)
			if movement.WaterAt(w.ground, qx, qz) > qh-0.2 || math.Abs(qh-h) > flatR*0.5 || movement.SlopeAt(w.ground, qx, qz).T2 > constants.WalkableTanSq {
				return false
			}
		}
		return true
	}
	for r := 0.0; r <= search; r += 4 {
		n := max(1, int(r*2*math.Pi/4))
		for i := 0; i < n; i++ {
			a := float64(i) / float64(n) * 2 * math.Pi
			if px, pz := x+r*math.Cos(a), z+r*math.Sin(a); ok(px, pz) {
				return px, pz
			}
		}
	}
	return x, z
}

// TestGroup places an explicit group (dev placement and tests): keys are
// enemy keys; elite is an affix key or "".
func (w *World) TestGroup(at movement.Vec3, keys []string, level int, elite string) *Group {
	at.Y = w.ground.HeightAt(at.X, at.Z)
	return w.AddGroup(&Group{Kind: GroupTest, Anchor: at, Radius: 8, Comp: keys, Level: max(1, level), Site: -1, Elite: elite, Element: 8})
}

// TestBoss places a boss arena at a point (dev placement and tests).
func (w *World) TestBoss(at movement.Vec3, boss string, level, element int) *Group {
	at.Y = w.ground.HeightAt(at.X, at.Z)
	return w.AddArena(Arena{Center: at, Kind: "test", Site: -1}, boss, max(1, level), element)
}

// Drain returns and clears the tick's outputs.
func (w *World) Drain() (events []Out, spawned, removed []*Enemy, xp []XPGrant, respawn, synced []uint32) {
	events, spawned, removed, xp, respawn, synced = w.Events, w.Spawned, w.Removed, w.XP, w.Respawn, w.Synced
	w.Events, w.Spawned, w.Removed, w.XP, w.Respawn, w.Synced = nil, nil, nil, nil, nil, nil
	return
}
