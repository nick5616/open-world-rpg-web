package combat

import (
	"math"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

// Player-vs-player hits (playtest 2, CR 019: opt-in PvP and party duels).
//
// The game layer decides WHETHER two players may hurt each other (flags,
// parties, safe zones, duels: internal/game/pvp.go) and only then calls
// ClaimPlayer; World.Claim still knows enemies only, so a claim naming a
// player can never reach the PvE path. ClaimPlayer validates exactly like
// Claim (the logged action, its legality and age, hit limits, the shape
// against any sample of the victim's recent positions, terrain line of
// sight) and computes the damage as against a physical enemy, scaled by
// combat.yaml pvp.damageMult, then the victim's armor and shield. No
// statuses, no skill XP, no kill XP and no loot come from players.

// PvPHit is how the game layer lets a player claim land on a player.
type PvPHit struct {
	// Duel: the victim never drops below 1 health (the duel ends there).
	Duel bool
}

// PvPResult is ClaimPlayer's verdict: the ClaimResult the attacker gets
// (HitResult) plus what happened to the victim.
type PvPResult struct {
	ClaimResult
	Dealt     float64 // health the victim lost
	Downed    bool    // open PvP: the victim went down (killed)
	DuelFloor bool    // duel: the victim reached 1 health
}

// pvpHist is how many ticks of each player's positions ClaimPlayer can
// look back over (historyTicks + futureTicks with room to spare).
const pvpHist = 40

type posRec struct {
	tick uint32
	pos  movement.Vec3
}

// notePos records the player's position at tick (World.Step, every tick).
func (p *Player) notePos(tick uint32) {
	p.hist[p.nHist%pvpHist] = posRec{tick: tick, pos: p.Pos}
	p.nHist++
}

// samples calls fn with every recorded position in [lo, hi] (or the
// current one when none is recorded there).
func (p *Player) samples(lo, hi uint32, fn func(movement.Vec3)) {
	n := 0
	for i := 0; i < min(p.nHist, pvpHist); i++ {
		s := p.hist[i]
		if s.tick >= lo && s.tick <= hi {
			fn(s.pos)
			n++
		}
	}
	if n == 0 {
		fn(p.Pos)
	}
}

// InCombat reports damage dealt or taken (by anything) within the last
// `seconds` (the PvP flag's combat lock).
func (p *Player) InCombat(now uint32, seconds float64) bool {
	win := secondsToTicks(seconds)
	recent := func(t uint32) bool { return t != 0 && t <= now && now-t < win }
	return recent(p.inCombatTick) || recent(p.lastHurtTick)
}

// ClaimPlayer validates and applies one hit claim from p on the player q.
func (w *World) ClaimPlayer(p *Player, c *proto.HitClaim, q *Player, how PvPHit) PvPResult {
	if p.Downed {
		return PvPResult{ClaimResult: w.refuse(RefuseDowned)}
	}
	if q == nil || q == p {
		return PvPResult{ClaimResult: w.refuse(RefuseNoTarget)}
	}
	if q.Downed {
		return PvPResult{ClaimResult: w.refuse(RefuseDead)}
	}
	if q.Graced(w.tick) {
		return PvPResult{ClaimResult: w.refuse(RefuseInvulnerable)} // CR 024: just respawned
	}
	a, shot := p.lookup(c.AttackSeq, int(c.AttackID)) // CR 020: a stream's shot by its nominal seq
	if a == nil {
		if c.AttackSeq > p.LastSeq {
			return PvPResult{ClaimResult: ClaimResult{Pending: true}}
		}
		return PvPResult{ClaimResult: w.refuse(RefuseUnknown)}
	}
	if !a.Legal {
		return PvPResult{ClaimResult: w.refuse(uint8(a.Refusal))}
	}
	if r := w.claimable(a, shot, q.ID); r != 0 {
		return PvPResult{ClaimResult: w.refuse(r)}
	}
	if s := a.Spell; s != nil {
		if s.RequiresStatus != "" || s.Damage == 0 {
			return PvPResult{ClaimResult: w.refuse(RefuseIllegal)} // players carry no statuses; heals and buffs never hurt
		}
		if w.tick-a.Tick+2 < ticksOf(s.WindupSteps) || (s.Type == "rune" && w.tick-a.Tick+2 < ticksOf(s.ArmSteps)) {
			return PvPResult{ClaimResult: w.refuse(RefuseIllegal)}
		}
	}
	impact := movement.Vec3{X: proto.CmToMeters(c.X), Y: proto.CmToMeters(c.Y), Z: proto.CmToMeters(c.Z)}
	if r := w.judge(p, a, shot, c, q.ID, playerRadius, playerCentre, q.samples, q.posAt, impact); r != 0 {
		return PvPResult{ClaimResult: w.refuse(r)}
	}
	return w.applyPlayerHit(p, a, q, how, shot)
}

// playerCentre is a player's body centre above the feet (an enemy's
// Height(): line of sight aims at it and at twice it).
const playerCentre = 0.9

// applyPlayerHit applies an accepted PvP claim.
func (w *World) applyPlayerHit(p *Player, a *Action, q *Player, how PvPHit, shot int) PvPResult {
	// The same hit against a physical enemy with the victim's health (low
	// target health bonuses read it), crit rolled per (action, victim).
	proxy := &Enemy{ID: q.ID, HP: q.HP, HPMax: q.HPMax, Element: combatdefs.Physical}
	if shot >= 0 {
		a.critSeq = a.shotSeq(shot) // CR 020: each stream shot rolls and counts on its own
		if a.shotHits == nil {
			a.shotHits, a.shotTgts = map[uint64]bool{}, map[int]int{}
		}
		a.shotHits[uint64(shot)<<32|uint64(q.ID)] = true
		a.shotTgts[shot]++
	}
	dmg, _, flags := w.damageOf(p, a, proxy)
	a.critSeq = 0
	dmg *= D.PvP.DamageMult
	if shot < 0 {
		a.hits[q.ID]++
		if a.hits[q.ID] == 1 {
			a.targets++
		}
	}
	if a.Spell != nil && a.Spell.Orbit != nil {
		if a.lastHit == nil {
			a.lastHit = map[uint32]uint32{}
		}
		a.lastHit[q.ID] = w.tick
	}
	dealt, shielded := w.hurtByPlayer(q, dmg, p, how.Duel)
	if shielded {
		flags |= FlagShielded
	}
	res := PvPResult{Dealt: dealt}
	switch {
	case q.Downed:
		flags |= FlagKilled
		res.Downed = true
	case how.Duel && q.HP <= 1:
		res.DuelFloor = true
	}
	ls := 0.0
	if a.Spell != nil {
		ls = a.Spell.Lifesteal
	} else if a.Form != nil {
		ls = a.Form.Lifesteal
	}
	if ls > 0 && dealt > 0 {
		w.healPlayer(p, p, dealt*ls)
	}
	p.inCombatTick = w.tick
	w.Stats.ClaimsAccepted++
	w.Stats.PvPHits++
	p.graceTick = 0 // landing a hit ends your own respawn grace (CR 024)
	res.ClaimResult = ClaimResult{Accepted: true, Damage: uint16(min(65535, math.Round(dealt))), Flags: flags, HPPct: q.HealthPct()}
	return res
}

// TestHurtPlayer lands an enemy strike's damage on p (tests and dev tools:
// the PvE path, from a stand-in enemy).
func (w *World) TestHurtPlayer(p *Player, dmg float64) {
	enemy := &Enemy{ID: 0, Def: D.EnemyByKey("boar"), Element: combatdefs.Physical}
	w.hurtPlayer(p, dmg, enemy, nil)
}

// HealthPct is a player's 0..100 health for HitResult (1 while alive).
func (p *Player) HealthPct() uint8 {
	if p.HPMax <= 0 || p.HP <= 0 {
		return 0
	}
	return uint8(math.Max(1, math.Round(p.HP*100/p.HPMax)))
}

// hurtByPlayer lowers q's health for a PvP hit from `by` (after armor and
// shield, like an enemy strike). A duel hit stops at 1 health; an open-PvP
// hit can down q (the usual respawn, no item loss). Returns the health lost
// and whether a shield absorbed some of it.
func (w *World) hurtByPlayer(q *Player, dmg float64, by *Player, duel bool) (float64, bool) {
	if q.Downed || q.Graced(w.tick) { // CR 024: respawn grace (claims, allies)
		return 0, false
	}
	dmg, shielded := w.mitigate(q, dmg)
	dmg = math.Round(dmg)
	q.lastHurtTick = w.tick
	q.inCombatTick = w.tick
	if dmg < 1 {
		return 0, shielded
	}
	if duel && q.HP-dmg < 1 {
		dmg = math.Max(0, q.HP-1) // a duel stops at 1 health
	}
	q.HP -= dmg
	w.toPlayer(q.ID, Out{Ev: ev(EvPvPHit, by.ID, q.ID, int32(dmg), by.Pos, []byte{boolByte(duel)})})
	w.near(q.Pos, 64, q.ID, Out{Ev: ev(EvStrikeHit, q.ID, by.ID, int32(dmg), q.Pos, nil)})
	if q.HP <= 0 {
		w.downPlayer(q, by.ID)
	}
	return dmg, shielded
}

func boolByte(b bool) byte {
	if b {
		return 1
	}
	return 0
}

// RestoreAfterDuel gives back the health a duel took (capped at the
// maximum; damage from enemies during the duel stays) and the mana the
// player had when it began (if they have less now).
func (p *Player) RestoreAfterDuel(healthTaken, manaBefore float64) {
	if p.Downed {
		return
	}
	p.HP = math.Min(p.HPMax, p.HP+math.Max(0, healthTaken))
	p.Mana = math.Max(p.Mana, math.Min(p.ManaMax, manaBefore))
}

// PvP Event kinds (contracts/events.md 990-999, playtest 2). The combat
// world emits only 992; the game layer owns the rest (internal/game/pvp.go).
const (
	EvPvPState      = 990 // to you: your flag, a pending turn-off, safe zone
	EvPvPRefused    = 991 // to you: a PvP/duel Interact was refused
	EvPvPHit        = 992 // to you: a player hit you
	EvPvPKill       = 993 // kill feed: killer and victim (and players within 64 m)
	EvDuelChallenge = 994 // to the challenged: accept or decline
	EvDuelState     = 995 // to both duelists: waiting, countdown, fighting
	EvDuelEnded     = 996 // to both duelists: winner, loser, reason
	EvDuelOutside   = 997 // to a duelist: outside the ring (forfeit countdown) / back inside
)

// RefuseSafeZone and RefuseSameParty are the PvP refusal reasons (HitResult
// flags / Event 215; RefuseNotEnemy also covers "one of you is not flagged").
const (
	RefuseSafeZone  = 16 // PvP between you is allowed, but one of you stands in a safe zone
	RefuseSameParty = 17 // a party member: challenge them to a duel instead
)
