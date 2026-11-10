package combat

import (
	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

// Hold-to-fire streams and hold-to-empower charges (playtest 2 spell
// mechanics, CR 020; the client's twin is CombatTimeline in
// client/src/combat/timeline.ts).
//
// A stream (a spell with `auto`) starts on the cast step like any spell and
// logs ONE Action at that seq. It then runs while the frames carry
// InputFlag.channel and no attack/dodge/cast: shot k fires on the first
// applied frame at or after its nominal step start + windup + k * interval,
// paying auto.manaPerShot; a shot it cannot pay ends the stream. The zone
// records each shot (where the player stood and looked) and a HitClaim
// names a shot by its nominal seq (attackSeq), so every bullet is
// validated and rolled on its own, but nothing per bullet goes on the wire
// to anyone: observers get Event 223 at the start (with the seed of the
// jitter / rain pattern) and at the stop. After the stream the spell is
// ready again one interval after the last shot or cooldownMs after the
// release, whichever is later, so tapping or re-pressing can never beat
// the stream's rate.
//
// A charge (a spell with `charge`) pays its mana and cooldown on the cast
// step and starts gathering; the first frame without the channel bit
// releases it and logs the Action at THAT seq with the held fraction (an
// attack, dodge or cast step instead cancels it, the mana spent).

// streamRing is how many recent shots a stream remembers for claims (2 s at 15/s).
const streamRing = 32

// shotRec is one fired shot of a stream.
type shotRec struct {
	seq        uint32 // nominal seq (HitClaim.attackSeq)
	tick       uint32
	pos        movement.Vec3
	yaw, pitch float64
}

// channel is a player's running stream or gathering charge.
type channel struct {
	spell *combatdefs.Spell
	act   *Action // the stream's Action (nil for a charge)
	start uint32  // seq of the cast step
	next  uint32  // stream: nominal seq of the next shot
}

// Channel results for FrameResult.Channel (Event 223 value).
const (
	ChannelNone   = 0
	ChannelStream = 1 // a stream started (Started is its Action)
	ChannelCharge = 2 // a charge started gathering
	// A stop is FrameResult.StopID (the spell id; a stop and a new start can share a frame).
)

// Streaming reports a running stream or charge (tests, the game layer).
func (p *Player) Streaming() bool { return p.ch != nil }

// shotSeq is shot k's nominal seq.
func (a *Action) shotSeq(k int) uint32 {
	return a.Seq + uint32(a.Spell.WindupSteps+k*a.Spell.Auto.IntervalSteps)
}

func (a *Action) addShot(s shotRec) {
	a.shots[a.nShots%streamRing] = s
	a.nShots++
}

// shot returns shot k if it was fired and is still remembered.
func (a *Action) shot(k int) *shotRec {
	if k < 0 || k >= a.nShots || k < a.nShots-streamRing {
		return nil
	}
	return &a.shots[k%streamRing]
}

// Shots is how many shots a stream fired.
func (a *Action) Shots() int { return a.nShots }

// lookup finds the action a claim names: an ordinary action by its start
// seq, or a stream's shot by its nominal seq (shot >= 0).
func (p *Player) lookup(seq uint32, id int) (a *Action, shot int) {
	for i := 0; i < min(p.nAct, actionRing); i++ {
		x := &p.actions[i]
		if x.ID != id {
			continue
		}
		if x.Spell != nil && x.Spell.Auto != nil {
			if !x.Legal && x.Seq == seq {
				return x, -1
			}
			if seq < x.Seq+uint32(x.Spell.WindupSteps) {
				continue
			}
			d := int(seq - x.Seq - uint32(x.Spell.WindupSteps))
			iv := x.Spell.Auto.IntervalSteps
			if d%iv == 0 && x.shot(d/iv) != nil && x.shot(d/iv).seq == seq {
				return x, d / iv
			}
			continue
		}
		if x.Seq == seq {
			return x, -1
		}
	}
	return nil, -1
}

// beginChannel starts a stream or a charge for a legal cast of s (called by
// startCast after the legality checks, before anything is paid).
func (p *Player) beginChannel(s *combatdefs.Spell, a *Action, f proto.InputFrame, before movement.State, tick uint32, r *FrameResult) {
	if s.Charge != nil {
		p.Mana -= s.Mana
		p.readyAt[s.ID] = f.Seq + uint32(p.cooldownSteps(s.CooldownSteps))
		r.Spent = r.Spent || s.Mana > 0
		p.ch = &channel{spell: s, start: f.Seq}
		r.Channel = ChannelCharge
		return
	}
	p.ch = &channel{spell: s, act: a, start: f.Seq, next: f.Seq + uint32(s.WindupSteps)}
	r.Channel = ChannelStream
	p.streamShot(f, before, tick, r) // shot 0 on the cast step (no windup)
}

// channelFrame runs a live stream or charge for one frame (before any new
// start in the same frame).
func (p *Player) channelFrame(f proto.InputFrame, before movement.State, tick uint32, r *FrameResult) {
	c := p.ch
	interrupt := f.Flags&(proto.InputFlagAttack|proto.InputFlagDodge|proto.InputFlagCast) != 0
	held := f.Flags&proto.InputFlagChannel != 0 && !interrupt
	if c.spell.Charge != nil {
		if held {
			return
		}
		p.ch = nil
		r.StopID = c.spell.ID
		if interrupt {
			return // cancelled: the mana is spent
		}
		a := Action{Seq: f.Seq, Tick: tick, Kind: ActSpell, ID: c.spell.ID, Spell: c.spell, Weapon: p.Weapon(), Pos: before.Pos,
			Yaw: proto.U16ToYaw(f.Yaw), Pitch: proto.I16ToPitch(f.Pitch), Charge: chargeFrac(int(f.Seq-c.start), c.spell.Charge.MaxSteps), Legal: true}
		r.Started = p.log(a)
		return
	}
	if !held {
		p.endStream(f.Seq, r)
		return
	}
	p.streamShot(f, before, tick, r)
}

// streamShot fires the stream's next shot if it is due and paid for.
func (p *Player) streamShot(f proto.InputFrame, before movement.State, tick uint32, r *FrameResult) {
	c := p.ch
	if c == nil || c.act == nil || f.Seq < c.next {
		return
	}
	au := c.spell.Auto
	if p.Mana < au.ManaPerShot {
		p.endStream(f.Seq, r)
		return
	}
	p.Mana -= au.ManaPerShot
	r.Spent = true
	c.act.addShot(shotRec{seq: c.next, tick: tick, pos: before.Pos, yaw: proto.U16ToYaw(f.Yaw), pitch: proto.I16ToPitch(f.Pitch)})
	c.next += uint32(au.IntervalSteps)
	r.Shots++
}

// endStream stops the stream at seq: the spell is ready one interval after
// the last shot or cooldownMs after now, whichever is later.
func (p *Player) endStream(seq uint32, r *FrameResult) {
	c := p.ch
	p.ch = nil
	if c == nil {
		return
	}
	r.StopID = c.spell.ID
	if c.act == nil {
		return
	}
	r.Stopped = c.act
	ready := seq + uint32(p.cooldownSteps(c.spell.CooldownSteps))
	if n := c.act.nShots; n > 0 {
		ready = max(ready, c.act.shotSeq(n-1)+uint32(c.spell.Auto.IntervalSteps))
	}
	p.readyAt[c.spell.ID] = ready
}

// shotAim is shot k's origin and direction (the stream's seeded jitter
// applied): where its claims are judged from.
func shotAim(a *Action, k int, sh *shotRec) (yaw, pitch float64) {
	dy, dp := shotJitter(streamSeed(a.Seq, a.Spell.ID), k, a.Spell.Auto.JitterDeg)
	return sh.yaw + dy, sh.pitch + dp
}

// chargeOf is an action's damage, radius and speed multipliers from its charge.
func chargeOf(a *Action) (dmg, radius, speed float64) {
	if a.Spell == nil || a.Spell.Charge == nil {
		return 1, 1, 1
	}
	c := a.Spell.Charge
	return chargeMult(c.DamageMult, a.Charge), chargeMult(c.RadiusMult, a.Charge), chargeMult(c.SpeedMult, a.Charge)
}


// YawHint is the newest frame's view yaw (allies follow behind it).
func (p *Player) YawHint() float64 { return p.yaw }

// rollSeq is the seq crits are rolled on (a stream shot rolls on its own).
func (a *Action) rollSeq() uint32 {
	if a.critSeq != 0 {
		return a.critSeq
	}
	return a.Seq
}
