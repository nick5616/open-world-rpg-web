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
		w.castFX(p, int(r.Frame.CastSlot)|0x8000, f, before)
	}
	a := r.Started
	if a == nil {
		return r
	}
	if !a.Legal {
		w.toPlayer(p.ID, Out{Ev: ev(EvRefused, p.ID, uint32(a.ID), int32(a.Refusal), p.Pos, binary.LittleEndian.AppendUint32(nil, a.Seq))})
		return r
	}
	w.castFX(p, a.ID, f, before)
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
// = attack id (| 0x8000 for a dash variant), x/y/z = origin, data = u16 yaw
// | i16 pitch.
func (w *World) castFX(p *Player, id int, f proto.InputFrame, before movement.State) {
	data := binary.LittleEndian.AppendUint16(nil, f.Yaw)
	data = binary.LittleEndian.AppendUint16(data, uint16(f.Pitch))
	w.near(before.Pos, 64, p.ID, Out{Ev: ev(EvCast, p.ID, uint32(id), 0, before.Pos, data)})
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
