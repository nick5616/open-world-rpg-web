package game

// Opt-in PvP (playtest 2, CR 017: "Add pvp option if not in the same party
// and duels if you are"). The rules live here; the hit itself is validated
// and applied by combat.World.ClaimPlayer exactly like a PvE claim.
//
//   - A player flags for PvP (Interact 70 action 1, the character panel or
//     /pvp). Turning it on is immediate; turning it off takes
//     pvp.flagOffDelayS and a PvP hit given or taken meanwhile restarts the
//     wait. Requests are pvp.toggleCooldownS apart and refused within
//     pvp.combatLockS of dealing or taking damage.
//   - A player hit lands only between two flagged players who are not in
//     the same party, neither of them standing in a safe zone (every
//     settlement out to its radius + pvp.settlementMarginM, and the Haven),
//     or between the two fighters of a duel (duel.go), anywhere.
//   - Damage is the PvE number x pvp.damageMult, then armor and shields. An
//     open-PvP kill downs the victim (the usual respawn, nothing dropped)
//     and sends the kill feed (983) to both and to players within 64 m.
//
// Wire cost: the flag is bit 12 of the player's snapshot typeId (bits 0-11
// are the weapon look) and "dueling" is bit 13, changed only on a toggle, so
// snapshots carry nothing new per tick; everything else is reliable Events
// to the players involved. Nothing is sent to a player who never flags,
// duels or attacks a player (bots, the G5 scale scenario).

import (
	"encoding/binary"
	"encoding/json"
	"math"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/structures"
	"lodestone/server/zone/internal/combat"
)

// Interact targetKind 70 (contracts/events.md).
const (
	InteractPvP = 70

	PvPActFlag      = 1 // arg 1 = flag on, 0 = off
	PvPActChallenge = 2 // targetId = the party member's entity id
	PvPActAnswer    = 3 // targetId = the challenger's entity id; arg 1 accept, 0 decline
	PvPActYield     = 4 // withdraw your challenge, decline one, or forfeit your duel
)

// Player typeId bits (bits 0-11 are the weapon look, weaponlook.go).
const (
	TypePvPFlag uint16 = 1 << 12 // flagged for PvP (also while a turn-off waits)
	TypeDueling uint16 = 1 << 13 // in a duel's countdown or fight
	typePvPMask        = TypePvPFlag | TypeDueling
)

// Event 980 value bits.
const (
	PvPStateFlagged = 1
	PvPStateTurning = 2 // turning off: targetId = ms left
	PvPStateSafe    = 4 // standing in a safe zone: data = its name
)

// Event 981 reasons.
const (
	PvPRefInCombat  = 1 // fought within pvp.combatLockS
	PvPRefCooldown  = 2 // a request within pvp.toggleCooldownS (targetId = ms left)
	PvPRefSameState = 3 // already flagged / not flagged
	PvPRefNoPlayer  = 4 // no such player here
	PvPRefNotParty  = 5 // a duel needs the same party (flag for PvP instead)
	PvPRefTooFar    = 6 // farther than pvp.duel.challengeRangeM
	PvPRefBusy      = 7 // you or they already have a duel or a challenge
	PvPRefNoDuel    = 8 // nothing to answer or yield
	PvPRefDowned    = 9 // you or they are down
	PvPRefBadAction = 10
)

// pvpEvalEveryTick: flagged players' safe-zone check runs at 2 Hz.
const pvpEvalEveryTick = 15

// pvpPlayer is one character's PvP state (tick-owned; nil until they first
// touch PvP, so bots and peaceful players cost nothing).
type pvpPlayer struct {
	flagged    bool
	offAt      uint32 // tick a requested turn-off applies (0 = none)
	nextToggle uint32 // earliest tick of the next flag request
	safe       bool
	safeName   string
	duel       *duel
	// Last 980 sent (resend only on change).
	sent      bool
	sentBits  int32
	sentOffAt uint32
	sentName  string
}

// pvpState is the server's PvP bookkeeping (tick-owned).
type pvpState struct {
	duels    []*duel
	nextDuel uint32
	// settlements: the atlas's settlement sites (built once).
	settlements []structures.Site
	built       bool
	// safeAt replaces the safe-zone test (tests).
	safeAt func(x, z float64) (bool, string)
}

const tickHz = uint32(constants.TickRateHz)

func ticksOfS(s float64) uint32 { return uint32(math.Round(s * float64(tickHz))) }

func (s *Server) pvpOf(e *Entity) *pvpPlayer {
	if e.pvp == nil {
		e.pvp = &pvpPlayer{}
	}
	return e.pvp
}

// pvpFlagged: flagged (a waiting turn-off still counts).
func (e *Entity) pvpFlagged() bool { return e.pvp != nil && e.pvp.flagged }

// pvpTypeBits are the typeId bits PvP adds to a player.
func (e *Entity) pvpTypeBits() uint16 {
	if e.pvp == nil {
		return 0
	}
	var b uint16
	if e.pvp.flagged {
		b |= TypePvPFlag
	}
	if d := e.pvp.duel; d != nil && d.phase >= duelCountdown {
		b |= TypeDueling
	}
	return b
}

// pvpRetype refreshes the PvP bits of the player's typeId.
func (e *Entity) pvpRetype() { e.TypeID = e.TypeID&^typePvPMask | e.pvpTypeBits() }

// ---- safe zones ----

// pvpSafe reports whether (x, z) is a safe zone and its name.
func (s *Server) pvpSafe(pos movement.Vec3) (bool, string) {
	if s.pvp.safeAt != nil {
		return s.pvp.safeAt(pos.X, pos.Z)
	}
	a := s.cbt.w.Atlas
	if a == nil {
		return false, ""
	}
	if !s.pvp.built {
		s.pvp.built = true
		for _, st := range a.Sites {
			if st.Category == structures.CategorySettlement {
				s.pvp.settlements = append(s.pvp.settlements, st.Site)
			}
		}
	}
	margin := combatdefs.D.PvP.SettlementMarginM
	for i := range s.pvp.settlements {
		st := &s.pvp.settlements[i]
		if math.Hypot(st.X-pos.X, st.Z-pos.Z) < st.Radius+margin {
			name := st.Name
			if name == "" {
				name = "a settlement"
			}
			return true, name
		}
	}
	if s.diff.on {
		if s.diff.m.Haven(s.diff.m.Cell(pos.X, pos.Z)) {
			return true, "the Haven"
		}
	} else if hr := combatdefs.D.Difficulty.HavenRadiusM; hr > 0 && (a.SpawnX != 0 || a.SpawnZ != 0) && math.Hypot(pos.X-a.SpawnX, pos.Z-a.SpawnZ) <= hr {
		return true, "the Haven"
	}
	return false, ""
}

// ---- the rules ----

// pvpSide is one player as the rules see them.
type pvpSide struct {
	flagged bool
	party   uint32
	safe    bool
}

// pvpRule decides a player hit: the duel between exactly these two (in its
// fight) always lands; party members never fight outside a duel; otherwise
// both must be flagged and neither in a safe zone. reason is the HitResult
// refusal when ok is false.
func pvpRule(a, b pvpSide, duel bool) (how combat.PvPHit, reason uint8, ok bool) {
	switch {
	case duel:
		return combat.PvPHit{Duel: true}, 0, true
	case a.party != 0 && a.party == b.party:
		return how, combat.RefuseSameParty, false
	case !a.flagged || !b.flagged:
		return how, combat.RefuseNotEnemy, false
	case a.safe || b.safe:
		return how, combat.RefuseSafeZone, false
	}
	return how, 0, true
}

// pvpVerdict applies pvpRule to two players of this zone.
func (s *Server) pvpVerdict(e, t *Entity) (combat.PvPHit, uint8, bool) {
	duel := false
	if e.pvp != nil && e.pvp.duel != nil {
		d := e.pvp.duel
		duel = d.phase == duelFighting && d.other(e) == t
	}
	a := pvpSide{flagged: e.pvpFlagged(), party: e.PartyID}
	b := pvpSide{flagged: t.pvpFlagged(), party: t.PartyID}
	if !duel && a.flagged && b.flagged && (a.party == 0 || a.party != b.party) {
		// Safe zones only matter once the rest allows the hit.
		a.safe, _ = s.pvpSafe(e.Move.Pos)
		b.safe, _ = s.pvpSafe(t.Move.Pos)
	}
	return pvpRule(a, b, duel)
}

// pvpClaim validates a claim on a player (handleHitClaim, the pending
// claim retry) and applies what follows a hit.
func (s *Server) pvpClaim(sess *session, c *proto.HitClaim, t *Entity) combat.ClaimResult {
	e := sess.ent
	w := s.cbt.w
	if t.cbt == nil || t == e {
		return w.RefusePvP(combat.RefuseNoTarget)
	}
	how, reason, ok := s.pvpVerdict(e, t)
	if !ok {
		return w.RefusePvP(reason)
	}
	res := w.ClaimPlayer(e.cbt, c, t.cbt, how)
	if !res.Accepted {
		return res.ClaimResult
	}
	syncPlayerHealth(t)
	if how.Duel {
		d := e.pvp.duel
		d.taken[d.index(t)] += res.Dealt
		if res.DuelFloor {
			s.endDuel(d, d.index(e), duelDefeated)
		}
		return res.ClaimResult
	}
	s.pvpEngaged(e)
	s.pvpEngaged(t)
	if res.Downed {
		s.pvpKillFeed(e, t)
	}
	return res.ClaimResult
}

// pvpEngaged restarts a waiting turn-off (no flagging off to escape a fight).
func (s *Server) pvpEngaged(e *Entity) {
	if p := e.pvp; p != nil && p.offAt != 0 {
		p.offAt = s.tick + ticksOfS(combatdefs.D.PvP.FlagOffDelayS)
		s.pvpSendState(e, false)
	}
}

// pvpKillFeed: Event 983 to the killer, the victim and players within 64 m.
func (s *Server) pvpKillFeed(killer, victim *Entity) {
	b, _ := json.Marshal(map[string]string{"killer": killer.Name, "victim": victim.Name})
	ev := proto.Encode(&proto.Event{Kind: combat.EvPvPKill, EntityID: killer.ID, TargetID: victim.ID, X: cm(victim.Move.Pos.X), Y: cm(victim.Move.Pos.Y), Z: cm(victim.Move.Pos.Z), Data: b})
	for _, o := range s.sessions {
		oe := o.ent
		if oe == nil {
			continue
		}
		if oe == killer || oe == victim || math.Hypot(oe.Move.Pos.X-victim.Move.Pos.X, oe.Move.Pos.Z-victim.Move.Pos.Z) <= 64 {
			if err := o.conn.SendReliable(ev); err != nil {
				o.closed.Store(true)
			}
		}
	}
	s.log.Info("pvp kill", "killer", killer.Name, "victim", victim.Name)
}

// ---- the flag ----

// pvpInteract handles Interact targetKind 70.
func (s *Server) pvpInteract(sess *session, m *proto.Interact) {
	e := sess.ent
	if e == nil || e.cbt == nil {
		return
	}
	switch m.Action {
	case PvPActFlag:
		s.pvpSetFlag(sess, m.Arg == 1)
	case PvPActChallenge:
		s.duelChallenge(sess, uint32(m.TargetID))
	case PvPActAnswer:
		s.duelAnswer(sess, uint32(m.TargetID), m.Arg == 1)
	case PvPActYield:
		s.duelYield(sess)
	default:
		s.pvpRefuse(sess, PvPRefBadAction, 0)
	}
}

func (s *Server) pvpRefuse(sess *session, reason int32, msLeft uint32) {
	s.sendEvent(sess, &proto.Event{Kind: combat.EvPvPRefused, EntityID: sess.ent.ID, TargetID: msLeft, Value: reason})
}

// pvpSetFlag asks for the flag on or off.
func (s *Server) pvpSetFlag(sess *session, on bool) {
	e := sess.ent
	st := s.pvpOf(e)
	def := combatdefs.D.PvP
	if on && st.flagged && st.offAt != 0 {
		st.offAt = 0 // changed your mind while turning off: stay flagged
		s.pvpSendState(e, false)
		return
	}
	if on == st.flagged && st.offAt == 0 || !on && st.offAt != 0 {
		s.pvpRefuse(sess, PvPRefSameState, 0)
		return
	}
	if s.tick < st.nextToggle {
		s.pvpRefuse(sess, PvPRefCooldown, (st.nextToggle-s.tick)*1000/tickHz)
		return
	}
	if e.cbt.InCombat(s.tick, def.CombatLockS) {
		s.pvpRefuse(sess, PvPRefInCombat, 0)
		return
	}
	st.nextToggle = s.tick + ticksOfS(def.ToggleCooldownS)
	if on {
		st.flagged = true
		st.safe, st.safeName = s.pvpSafe(e.Move.Pos)
		e.pvpRetype()
		s.log.Info("pvp flag on", "entity", e.ID, "name", e.Name)
	} else {
		st.offAt = s.tick + ticksOfS(def.FlagOffDelayS)
	}
	s.pvpSendState(e, true)
}

// pvpSendState sends Event 980 if anything in it changed (or force).
func (s *Server) pvpSendState(e *Entity, force bool) {
	st := e.pvp
	if st == nil {
		return
	}
	var bits int32
	if st.flagged {
		bits |= PvPStateFlagged
	}
	if st.offAt != 0 {
		bits |= PvPStateTurning
	}
	name := ""
	if st.safe && st.flagged {
		bits |= PvPStateSafe
		name = st.safeName
	}
	if !force && st.sent && bits == st.sentBits && st.offAt == st.sentOffAt && name == st.sentName {
		return
	}
	st.sent, st.sentBits, st.sentOffAt, st.sentName = true, bits, st.offAt, name
	ms := uint32(0)
	if st.offAt > s.tick {
		ms = (st.offAt - s.tick) * 1000 / tickHz
	}
	s.sendEventTo(e, &proto.Event{Kind: combat.EvPvPState, EntityID: e.ID, TargetID: ms, Value: bits, Data: []byte(name)})
}

// pvpTick: turn-offs that came due, flagged players' safe-zone state, and
// the duels (duel.go). Players who never touched PvP are skipped.
func (s *Server) pvpTick(tick uint32) {
	for _, sess := range s.sessions {
		e := sess.ent
		if e == nil || e.pvp == nil || e.cbt == nil {
			continue
		}
		st := e.pvp
		if st.offAt != 0 && tick >= st.offAt {
			st.flagged, st.offAt = false, 0
			st.safe, st.safeName = false, ""
			e.pvpRetype()
			s.pvpSendState(e, false)
			s.log.Info("pvp flag off", "entity", e.ID, "name", e.Name)
			continue
		}
		if st.flagged && (tick+e.ID)%pvpEvalEveryTick == 0 {
			st.safe, st.safeName = s.pvpSafe(e.Move.Pos)
			s.pvpSendState(e, false)
		}
	}
	s.duelTick(tick)
}

// pvpJoin: a character arriving flagged (zone handoff) shows it at once.
func (s *Server) pvpJoin(sess *session) {
	e := sess.ent
	if e == nil || e.pvp == nil {
		return
	}
	e.pvpRetype()
	if e.pvp.flagged {
		e.pvp.safe, e.pvp.safeName = s.pvpSafe(e.Move.Pos)
		s.pvpSendState(e, true)
	}
}

// pvpLeave: a duelist leaving (logout or another zone) loses the duel.
func (s *Server) pvpLeave(sess *session) {
	e := sess.ent
	if e == nil || e.pvp == nil || e.pvp.duel == nil {
		return
	}
	d := e.pvp.duel
	if d.phase == duelPending {
		s.endDuel(d, -1, duelCancelled)
		return
	}
	s.endDuel(d, 1-d.index(e), duelLeft)
}

func init() {
	// WP16: the flag crosses zone borders (a waiting turn-off applies on the
	// way: you arrive unflagged). Duels do not (pvpLeave ends them).
	RegisterHandoffField(HandoffField{
		Name: "pvp",
		Save: func(_ *Server, e *Entity) json.RawMessage {
			if e.pvp == nil || !e.pvp.flagged || e.pvp.offAt != 0 {
				return nil
			}
			return json.RawMessage(`{"flagged":true}`)
		},
		Load: func(_ *Server, e *Entity, data json.RawMessage) {
			var v struct {
				Flagged bool `json:"flagged"`
			}
			if json.Unmarshal(data, &v) == nil && v.Flagged {
				e.pvp = &pvpPlayer{flagged: true}
			}
		},
	})
}

// u16 / u32 little-endian appenders for Event payloads.
func le16(b []byte, v uint16) []byte { return binary.LittleEndian.AppendUint16(b, v) }
func le32(b []byte, v uint32) []byte { return binary.LittleEndian.AppendUint32(b, v) }
