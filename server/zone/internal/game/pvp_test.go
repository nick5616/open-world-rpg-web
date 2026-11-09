package game

// Playtest 2 (CR 019): opt-in PvP and party duels, driven in-process (fake
// connections, one onTick per call, a simulated clock) so every timer is
// exact: the rules matrix (flags x party x safe zone x duel), the flag's
// anti-abuse timers, open-PvP hits and kills, and the duel lifecycle.

import (
	"io"
	"log/slog"
	"math"
	"strings"
	"testing"
	"time"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/ratelimit"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/ticket"
	"lodestone/server/zone/internal/combat"
)

type pvpRig struct {
	t   *testing.T
	srv *Server
	cs  []*pvpCli
}

type pvpCli struct {
	r      *pvpRig
	sess   *session
	conn   *recConn
	seq    uint32
	yaw    float64 // radians (0 faces -Z)
	flags  uint16
	claim  *pvpCli // claim a hit on this player with the next attack frame
	read   int
	evs    []*proto.Event
	hits   []*proto.HitResult
	lastAt uint32 // seq of the newest attack frame
}

func newPvPRig(t *testing.T) *pvpRig {
	t.Helper()
	dry := false
	clock := time.Unix(1_800_000_000, 0)
	var srv *Server
	cfg := Config{ZoneID: testZone, WorldID: testWorld, Seed: 42, GenVersion: "g1", DevSpawn: true, Rain: &dry,
		SnapshotWorkers: 1, Combat: &CombatSetup{Config: combat.Config{NoWildPacks: true}},
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Now: func() time.Time { return clock.Add(time.Duration(srv.tick) * time.Second / 30) }}
	srv = New(cfg)
	srv.pvp.safeAt = func(x, z float64) (bool, string) {
		if x < 500 {
			return true, "Testford" // the west half of the test world is a town
		}
		return false, ""
	}
	return &pvpRig{t: t, srv: srv}
}

func (r *pvpRig) add(name string, x, z float64) *pvpCli {
	conn := &recConn{benchConn: benchConn{done: make(chan struct{})}}
	sess := &session{conn: conn, joined: make(chan struct{}), buckets: newBuckets(),
		frameBudget: ratelimit.New(1e12, 1e12), spawn: movement.Vec3{X: x, Z: z},
		claims: ticket.Claims{CharacterID: "c-" + strings.ToLower(name), CharacterName: name}}
	r.srv.join(sess)
	c := &pvpCli{r: r, sess: sess, conn: conn}
	r.cs = append(r.cs, c)
	return c
}

func (c *pvpCli) ent() *Entity { return c.sess.ent }

func (c *pvpCli) push(m proto.Message) {
	c.sess.mu.Lock()
	c.sess.inbox = append(c.sess.inbox, m)
	c.sess.mu.Unlock()
}

// tick runs one zone tick: each client sends two frames (the first carries
// its queued flags) and its queued claim.
func (r *pvpRig) tick() {
	for _, c := range r.cs {
		if c.sess.left {
			continue
		}
		in := &proto.Input{AckTick: r.srv.tick}
		for k := 0; k < 2; k++ {
			c.seq++
			f := proto.InputFrame{Seq: c.seq, Yaw: proto.YawToU16(c.yaw)}
			if k == 0 && c.flags != 0 {
				f.Flags = c.flags
				c.flags = 0
				c.lastAt = c.seq
			}
			in.Frames = append(in.Frames, f)
		}
		c.push(in)
		if c.claim != nil {
			sword := combatdefs.D.MoveOf(combatdefs.D.WeaponByKey("sword"), "light", 0)
			p := c.ent().Move.Pos
			c.push(&proto.HitClaim{AttackSeq: c.lastAt, AttackID: uint16(sword.ID), TargetID: c.claim.ent().ID, Tick: r.srv.tick, X: proto.MetersToCm(p.X), Y: proto.MetersToCm(p.Y), Z: proto.MetersToCm(p.Z)})
			c.claim = nil
		}
	}
	r.srv.onTick()
	for _, c := range r.cs {
		c.collect()
	}
}

func (r *pvpRig) ticks(n int) {
	for i := 0; i < n; i++ {
		r.tick()
	}
}

func (r *pvpRig) seconds(s float64) { r.ticks(int(math.Ceil(s * 30))) }

// collect decodes what the zone sent reliably since the last call.
func (c *pvpCli) collect() {
	c.conn.mu.Lock()
	rel := c.conn.rel[c.read:]
	c.read = len(c.conn.rel)
	c.conn.mu.Unlock()
	for _, b := range rel {
		m, err := proto.DecodeMessage(b)
		if err != nil {
			continue
		}
		switch x := m.(type) {
		case *proto.Event:
			c.evs = append(c.evs, x)
		case *proto.HitResult:
			c.hits = append(c.hits, x)
		}
	}
}

// swing attacks (sword light, opening the combo) and claims a hit on
// target; it waits out the previous swing's combo window first.
func (c *pvpCli) swing(target *pvpCli) *proto.HitResult {
	c.r.ticks(40)
	c.flags = proto.InputFlagAttack
	c.claim = target
	n := len(c.hits)
	for i := 0; i < 20 && len(c.hits) == n; i++ {
		c.r.tick()
	}
	if len(c.hits) == n {
		c.r.t.Fatalf("%s: no HitResult", c.ent().Name)
	}
	return c.hits[len(c.hits)-1]
}

func (c *pvpCli) interact(action uint8, target uint32, arg uint32) {
	c.push(&proto.Interact{TargetKind: InteractPvP, TargetID: uint64(target), Action: action, Arg: arg})
	c.r.tick()
}

// last returns the newest event of kind (nil if none) and how many came.
func (c *pvpCli) last(kind uint16) (*proto.Event, int) {
	var ev *proto.Event
	n := 0
	for _, e := range c.evs {
		if e.Kind == kind {
			ev = e
			n++
		}
	}
	return ev, n
}

func (c *pvpCli) hp() float64 { return c.ent().cbt.HP }

// ---- the rules matrix ----

// TestPvPRulesMatrix: every combination of both flags, party (none, same,
// different), either side in a safe zone, and a duel between the two.
func TestPvPRulesMatrix(t *testing.T) {
	n := 0
	for mask := 0; mask < 1<<5; mask++ {
		for _, party := range []string{"none", "same", "different"} {
			a := pvpSide{flagged: mask&1 != 0, safe: mask&4 != 0}
			b := pvpSide{flagged: mask&2 != 0, safe: mask&8 != 0}
			duel := mask&16 != 0
			switch party {
			case "same":
				a.party, b.party = 7, 7
			case "different":
				a.party, b.party = 7, 9
			}
			how, reason, ok := pvpRule(a, b, duel)
			// The expectation, written out as the rules read in CR 019.
			var wantOK bool
			var wantReason uint8
			switch {
			case duel:
				wantOK = true
			case party == "same":
				wantReason = combat.RefuseSameParty
			case !a.flagged || !b.flagged:
				wantReason = combat.RefuseNotEnemy
			case a.safe || b.safe:
				wantReason = combat.RefuseSafeZone
			default:
				wantOK = true
			}
			if ok != wantOK || reason != wantReason || how.Duel != duel {
				t.Errorf("flags %v/%v party %s safe %v/%v duel %v: ok %v reason %d duel %v, want ok %v reason %d", a.flagged, b.flagged, party, a.safe, b.safe, duel, ok, reason, how.Duel, wantOK, wantReason)
			}
			n++
		}
	}
	t.Logf("%d combinations", n)
}

// TestPvPClaimsThroughTheZone runs the matrix's corners through real claims:
// unflagged, one flagged, both flagged, same party, a safe zone, and checks
// the HitResult reason and the victim's health each time.
func TestPvPClaimsThroughTheZone(t *testing.T) {
	r := newPvPRig(t)
	a := r.add("Ash", 1000, 1000)
	b := r.add("Birch", 1000, 998.5) // 1.5 m in front of Ash (yaw 0 faces -Z)
	r.ticks(5)
	hp0 := b.hp()
	cases := []struct {
		name          string
		aFlag, bFlag  bool
		party         bool
		where         float64 // Ash's and Birch's x (< 500 is the test town)
		want          uint8
		wantAccepted  bool
		wantHealthCut bool
	}{
		{"neither flagged", false, false, false, 1000, combat.RefuseNotEnemy, false, false},
		{"only the attacker flagged", true, false, false, 1000, combat.RefuseNotEnemy, false, false},
		{"both flagged, same party", true, true, true, 1000, combat.RefuseSameParty, false, false},
		{"both flagged, in town", true, true, false, 400, combat.RefuseSafeZone, false, false},
		{"both flagged, open ground", true, true, false, 1000, 0, true, true},
	}
	for _, tc := range cases {
		for _, c := range []*pvpCli{a, b} {
			st := r.srv.pvpOf(c.ent())
			st.flagged, st.offAt, st.nextToggle = false, 0, 0
		}
		a.ent().pvp.flagged = tc.aFlag
		b.ent().pvp.flagged = tc.bFlag
		a.ent().PartyID, b.ent().PartyID = 0, 0
		if tc.party {
			a.ent().PartyID, b.ent().PartyID = 5, 5
		}
		a.ent().Move.Pos.X, b.ent().Move.Pos.X = tc.where, tc.where
		b.ent().cbt.HP = hp0
		res := a.swing(b)
		if res.Accepted != tc.wantAccepted || (!res.Accepted && res.Flags != tc.want) {
			t.Fatalf("%s: HitResult %+v, want accepted %v reason %d", tc.name, res, tc.wantAccepted, tc.want)
		}
		if cut := b.hp() < hp0; cut != tc.wantHealthCut {
			t.Fatalf("%s: Birch health %v -> %v", tc.name, hp0, b.hp())
		}
		t.Logf("%s: accepted %v reason %d damage %d (Birch %v -> %v)", tc.name, res.Accepted, res.Flags, res.Damage, hp0, b.hp())
	}
}

// TestPvPDamageIsScaledAndKillsRespawn: an open-PvP hit deals
// pvp.damageMult of what the same swing deals a physical enemy; a killing
// hit downs the victim (no items lost: nothing touches the inventory), sends
// the kill feed to both and the respawn follows as usual.
func TestPvPDamageIsScaledAndKillsRespawn(t *testing.T) {
	r := newPvPRig(t)
	a := r.add("Ash", 1000, 1000)
	b := r.add("Birch", 1000, 998.5)
	r.ticks(5)
	for _, c := range []*pvpCli{a, b} {
		c.interact(PvPActFlag, 0, 1)
	}
	if ev, _ := b.last(combat.EvPvPState); ev == nil || ev.Value&PvPStateFlagged == 0 {
		t.Fatalf("no flagged state event: %+v", ev)
	}
	if a.ent().TypeID&TypePvPFlag == 0 {
		t.Fatal("flag bit missing from the typeId")
	}
	hp0 := b.hp()
	res := a.swing(b)
	if !res.Accepted {
		t.Fatalf("refused: %+v", res)
	}
	sword := combatdefs.D.MoveOf(combatdefs.D.WeaponByKey("sword"), "light", 0)
	pve := sword.Damage * combatdefs.D.DamageMult(1)
	want := math.Round(pve * combatdefs.D.PvP.DamageMult)
	if got := hp0 - b.hp(); math.Abs(got-want) > 1 && math.Abs(got-want*1.5) > 1 { // a crit is x1.5
		t.Fatalf("PvP damage %v, want %v (PvE %v x %v)", got, want, pve, combatdefs.D.PvP.DamageMult)
	}
	if ev, _ := b.last(combat.EvPvPHit); ev == nil || ev.EntityID != a.ent().ID {
		t.Fatalf("victim got no 992: %+v", ev)
	}
	t.Logf("hit for %d (PvE %v x %v)", res.Damage, pve, combatdefs.D.PvP.DamageMult)

	b.ent().cbt.HP = 2
	res = a.swing(b)
	if !res.Accepted || res.Flags&combat.FlagKilled == 0 || !b.ent().cbt.Downed {
		t.Fatalf("killing hit: %+v downed %v", res, b.ent().cbt.Downed)
	}
	for _, c := range []*pvpCli{a, b} {
		if ev, _ := c.last(combat.EvPvPKill); ev == nil || ev.EntityID != a.ent().ID || ev.TargetID != b.ent().ID || !strings.Contains(string(ev.Data), `"victim":"Birch"`) {
			t.Fatalf("%s kill feed: %+v", c.ent().Name, ev)
		}
	}
	if ev, _ := b.last(combat.EvPlayerDowned); ev == nil || ev.TargetID != a.ent().ID {
		t.Fatalf("downed event names the killer: %+v", ev)
	}
	items := -1
	if b.sess.items != nil {
		items = len(b.sess.items.inv.Items)
	}
	r.seconds(13)
	if b.ent().cbt.Downed || b.hp() != b.ent().cbt.HPMax {
		t.Fatalf("no respawn: downed %v hp %v", b.ent().cbt.Downed, b.hp())
	}
	if b.sess.items != nil && len(b.sess.items.inv.Items) != items {
		t.Fatalf("items changed on a PvP death: %d -> %d", items, len(b.sess.items.inv.Items))
	}
}

// TestPvPFlagTimers: on is immediate; off waits flagOffDelayS; a PvP hit
// while waiting restarts the wait; requests within toggleCooldownS and
// within combatLockS of fighting are refused; asking for "on" while
// turning off cancels the turn-off.
func TestPvPFlagTimers(t *testing.T) {
	def := combatdefs.D.PvP
	r := newPvPRig(t)
	a := r.add("Ash", 1000, 1000)
	b := r.add("Birch", 1000, 998.5)
	r.ticks(5)
	a.interact(PvPActFlag, 0, 1)
	if !a.ent().pvpFlagged() {
		t.Fatal("flag on is not immediate")
	}
	a.interact(PvPActFlag, 0, 0)
	if ev, _ := a.last(combat.EvPvPRefused); ev == nil || ev.Value != PvPRefCooldown || ev.TargetID == 0 {
		t.Fatalf("a second request inside the cooldown: %+v", ev)
	}
	r.seconds(def.ToggleCooldownS)
	a.interact(PvPActFlag, 0, 0)
	st, _ := a.last(combat.EvPvPState)
	if st == nil || st.Value&PvPStateTurning == 0 || !a.ent().pvpFlagged() {
		t.Fatalf("turning off: %+v flagged %v", st, a.ent().pvpFlagged())
	}
	if math.Abs(float64(st.TargetID)-def.FlagOffDelayS*1000) > 100 {
		t.Fatalf("turn-off wait %d ms, want %v s", st.TargetID, def.FlagOffDelayS)
	}
	// Changing your mind: "on" while turning off keeps the flag.
	a.interact(PvPActFlag, 0, 1)
	if a.ent().pvp.offAt != 0 || !a.ent().pvpFlagged() {
		t.Fatal("on while turning off did not cancel the turn-off")
	}
	r.seconds(def.ToggleCooldownS)
	a.interact(PvPActFlag, 0, 0)
	start := r.srv.tick
	// A PvP hit while waiting restarts the wait.
	b.interact(PvPActFlag, 0, 1)
	b.yaw = math.Pi // Ash is behind Birch
	r.seconds(def.FlagOffDelayS / 2)
	if res := b.swing(a); !res.Accepted {
		t.Fatalf("hit on a player turning off (still flagged): %+v", res)
	}
	hitAt := r.srv.tick
	// Combat lock: Birch just fought, so it cannot flag off now.
	b.interact(PvPActFlag, 0, 0)
	if ev, _ := b.last(combat.EvPvPRefused); ev == nil || ev.Value != PvPRefInCombat {
		t.Fatalf("flag off right after fighting: %+v", ev)
	}
	for a.ent().pvpFlagged() {
		r.tick()
		if r.srv.tick-start > 60*30 {
			t.Fatal("never turned off")
		}
	}
	if waited := float64(r.srv.tick-hitAt) / 30; math.Abs(waited-def.FlagOffDelayS) > 0.2 {
		t.Fatalf("turned off %.2f s after the hit, want %v (restarted)", waited, def.FlagOffDelayS)
	}
	if a.ent().TypeID&TypePvPFlag != 0 {
		t.Fatal("flag bit stayed in the typeId")
	}
	// Out of the combat lock (it passed while Ash turned off), Birch can.
	if b.ent().cbt.InCombat(r.srv.tick, def.CombatLockS) {
		r.seconds(def.CombatLockS)
	}
	b.interact(PvPActFlag, 0, 0)
	if ev, _ := b.last(combat.EvPvPState); ev == nil || ev.Value&PvPStateTurning == 0 {
		t.Fatalf("flag off after the combat lock: %+v", ev)
	}
}

// TestPvPSafeZoneState: a flagged player walking into a settlement is told
// (990 bit 4 + the town's name) and cannot be hit there.
func TestPvPSafeZoneState(t *testing.T) {
	r := newPvPRig(t)
	a := r.add("Ash", 520, 1000)
	r.ticks(5)
	a.interact(PvPActFlag, 0, 1)
	if ev, _ := a.last(combat.EvPvPState); ev == nil || ev.Value&PvPStateSafe != 0 {
		t.Fatalf("outside town: %+v", ev)
	}
	a.ent().Move.Pos.X = 480
	r.ticks(pvpEvalEveryTick + 1)
	ev, _ := a.last(combat.EvPvPState)
	if ev == nil || ev.Value&PvPStateSafe == 0 || string(ev.Data) != "Testford" {
		t.Fatalf("inside town: %+v", ev)
	}
}

// ---- duels ----

func duelPair(t *testing.T) (*pvpRig, *pvpCli, *pvpCli) {
	r := newPvPRig(t)
	a := r.add("Ash", 1000, 1000)
	b := r.add("Birch", 1000, 998.5)
	a.ent().PartyID, b.ent().PartyID = 3, 3
	r.ticks(5)
	return r, a, b
}

// accept runs challenge + accept + the countdown; returns the duel.
func accept(t *testing.T, r *pvpRig, a, b *pvpCli) *duel {
	t.Helper()
	a.interact(PvPActChallenge, b.ent().ID, 0)
	ch, _ := b.last(combat.EvDuelChallenge)
	if ch == nil || ch.EntityID != a.ent().ID || string(ch.Data) != "Ash" || ch.Value != int32(combatdefs.D.PvP.Duel.AnswerS*1000) {
		t.Fatalf("challenge event: %+v", ch)
	}
	b.interact(PvPActAnswer, a.ent().ID, 1)
	d := a.ent().pvp.duel
	if d == nil || d.phase != duelCountdown {
		t.Fatalf("not counting down: %+v", d)
	}
	for _, c := range []*pvpCli{a, b} {
		if ev, _ := c.last(combat.EvDuelState); ev == nil || ev.Value != int32(duelCountdown) {
			t.Fatalf("%s countdown state: %+v", c.ent().Name, ev)
		}
		if c.ent().TypeID&TypeDueling == 0 {
			t.Fatal("dueling bit missing")
		}
	}
	// No duel hits during the countdown (and party members never fight otherwise).
	if res := a.swing(b); res.Accepted || res.Flags != combat.RefuseSameParty {
		t.Fatalf("hit during the countdown: %+v", res)
	}
	r.seconds(combatdefs.D.PvP.Duel.CountdownS)
	if d.phase != duelFighting {
		t.Fatalf("phase %d after the countdown", d.phase)
	}
	return d
}

// TestDuelChallengeRules: party only, range, busy, decline, expiry.
func TestDuelChallengeRules(t *testing.T) {
	r, a, b := duelPair(t)
	c := r.add("Cedar", 1003, 1000) // not in the party
	r.ticks(2)
	a.interact(PvPActChallenge, c.ent().ID, 0)
	if ev, _ := a.last(combat.EvPvPRefused); ev == nil || ev.Value != PvPRefNotParty {
		t.Fatalf("outside the party: %+v", ev)
	}
	c.ent().PartyID = 3
	c.ent().Move.Pos.X = 1000 + combatdefs.D.PvP.Duel.ChallengeRangeM + 5
	r.tick()
	a.interact(PvPActChallenge, c.ent().ID, 0)
	if ev, _ := a.last(combat.EvPvPRefused); ev == nil || ev.Value != PvPRefTooFar {
		t.Fatalf("too far: %+v", ev)
	}
	a.interact(PvPActChallenge, b.ent().ID, 0)
	c.ent().Move.Pos.X = 1003
	c.interact(PvPActChallenge, b.ent().ID, 0)
	if ev, _ := c.last(combat.EvPvPRefused); ev == nil || ev.Value != PvPRefBusy {
		t.Fatalf("challenging someone who has a challenge: %+v", ev)
	}
	b.interact(PvPActAnswer, a.ent().ID, 0)
	if ev, _ := a.last(combat.EvDuelEnded); ev == nil || ev.Value != duelDeclined || a.ent().pvp.duel != nil {
		t.Fatalf("declined: %+v", ev)
	}
	a.ent().pvp.nextToggle = 0
	a.interact(PvPActChallenge, b.ent().ID, 0)
	r.seconds(combatdefs.D.PvP.Duel.AnswerS + 0.2)
	for _, x := range []*pvpCli{a, b} {
		if ev, _ := x.last(combat.EvDuelEnded); ev == nil || ev.Value != duelExpired {
			t.Fatalf("%s: unanswered challenge: %+v", x.ent().Name, ev)
		}
	}
	if a.ent().pvp.duel != nil || b.ent().pvp.duel != nil {
		t.Fatal("expired duel still attached")
	}
}

// TestDuelToOneHealthRestores: only the two duelists can hurt each other,
// the loser stops at 1 health, both get the duel's health and their mana
// back, and the result goes to party chat.
func TestDuelToOneHealthRestores(t *testing.T) {
	r, a, b := duelPair(t)
	var chat []string
	var chatTo []string
	r.srv.cfg.PartyChat = func(to []string, text string) { chatTo, chat = to, append(chat, text) }
	outsider := r.add("Cedar", 1000.5, 999) // flagged, not in the party, next to Birch
	r.ticks(2)
	outsider.interact(PvPActFlag, 0, 1)
	d := accept(t, r, a, b)
	if !d.ents[0].pvpFlagged() && d.ents[1].pvpFlagged() {
		t.Fatal("duels must not need flags")
	}
	// An outsider cannot join in (Birch is not flagged).
	if res := outsider.swing(b); res.Accepted {
		t.Fatalf("a third player hit a duelist: %+v", res)
	}
	a.ent().cbt.Mana = 10 // spent on spells during the duel
	manaBefore := d.mana[0]
	hpMax := b.ent().cbt.HPMax
	res := a.swing(b)
	if !res.Accepted {
		t.Fatalf("duel hit refused: %+v", res)
	}
	if ev, _ := b.last(combat.EvPvPHit); ev == nil || len(ev.Data) == 0 || ev.Data[0] != 1 {
		t.Fatalf("duel hit event: %+v", ev)
	}
	b.ent().cbt.HP = 4 // a few hits later
	d.taken[1] = hpMax - 4
	res = a.swing(b)
	if !res.Accepted || b.ent().cbt.Downed {
		t.Fatalf("finishing duel hit: %+v downed %v", res, b.ent().cbt.Downed)
	}
	for _, x := range []*pvpCli{a, b} {
		ev, _ := x.last(combat.EvDuelEnded)
		if ev == nil || ev.Value != duelDefeated || ev.EntityID != a.ent().ID || ev.TargetID != b.ent().ID || !strings.Contains(string(ev.Data), "Ash defeated Birch") {
			t.Fatalf("%s: duel result %+v", x.ent().Name, ev)
		}
	}
	if b.hp() != hpMax {
		t.Fatalf("loser not restored: %v of %v", b.hp(), hpMax)
	}
	if a.ent().cbt.Mana < manaBefore-0.01 {
		t.Fatalf("winner's mana not restored: %v < %v", a.ent().cbt.Mana, manaBefore)
	}
	if a.ent().TypeID&TypeDueling != 0 || a.ent().pvp.duel != nil {
		t.Fatal("still dueling")
	}
	if len(chat) != 1 || !strings.Contains(chat[0], "defeated") || len(chatTo) < 2 {
		t.Fatalf("party chat: %v to %v", chat, chatTo)
	}
	// After the duel, party members cannot hit each other again.
	if res := a.swing(b); res.Accepted || res.Flags != combat.RefuseSameParty {
		t.Fatalf("hit after the duel: %+v", res)
	}
}

// TestDuelEnemiesStillHurt: a duel changes nothing about enemies, and an
// enemy downing a duelist calls the duel off.
func TestDuelEnemiesStillHurt(t *testing.T) {
	r, a, b := duelPair(t)
	d := accept(t, r, a, b)
	// What an enemy strike does (the only enemy path to player health).
	b.ent().cbt.HP = 0.5
	r.srv.cbt.w.TestHurtPlayer(b.ent().cbt, 5)
	r.ticks(2)
	if !b.ent().cbt.Downed {
		t.Fatal("enemy damage did not apply during a duel")
	}
	if ev, _ := a.last(combat.EvDuelEnded); ev == nil || ev.Value != duelCancelled || ev.EntityID != 0 {
		t.Fatalf("duel not called off: %+v", ev)
	}
	_ = d
}

// TestDuelForfeitOutsideTheRing: outside the ring past outsideForfeitS
// loses; stepping back in time cancels the countdown.
func TestDuelForfeitOutsideTheRing(t *testing.T) {
	def := combatdefs.D.PvP.Duel
	r, a, b := duelPair(t)
	d := accept(t, r, a, b)
	far := d.center.Z + def.RingRadiusM + 3
	b.ent().Move.Pos.Z = far
	r.ticks(2)
	if ev, _ := b.last(combat.EvDuelOutside); ev == nil || ev.Value != int32(def.OutsideForfeitS*1000) {
		t.Fatalf("outside warning: %+v", ev)
	}
	r.seconds(def.OutsideForfeitS / 2)
	b.ent().Move.Pos.Z = d.center.Z
	r.ticks(2)
	if ev, _ := b.last(combat.EvDuelOutside); ev == nil || ev.Value != 0 {
		t.Fatalf("back inside: %+v", ev)
	}
	b.ent().Move.Pos.Z = far
	r.seconds(def.OutsideForfeitS + 0.2)
	ev, _ := a.last(combat.EvDuelEnded)
	if ev == nil || ev.Value != duelOutside || ev.EntityID != a.ent().ID {
		t.Fatalf("forfeit by leaving the ring: %+v", ev)
	}
}

// TestDuelTimeCapIsADraw and yielding.
func TestDuelTimeCapIsADraw(t *testing.T) {
	def := combatdefs.D.PvP.Duel
	r, a, b := duelPair(t)
	accept(t, r, a, b)
	r.seconds(def.MaxS + 0.2)
	for _, x := range []*pvpCli{a, b} {
		if ev, _ := x.last(combat.EvDuelEnded); ev == nil || ev.Value != duelTimeUp || ev.EntityID != 0 || !strings.Contains(string(ev.Data), "draw") {
			t.Fatalf("%s: time cap %+v", x.ent().Name, ev)
		}
	}
	accept(t, r, a, b)
	b.interact(PvPActYield, 0, 0)
	if ev, _ := a.last(combat.EvDuelEnded); ev == nil || ev.Value != duelYielded || ev.EntityID != a.ent().ID {
		t.Fatalf("yield: %+v", ev)
	}
}

// TestDuelDisconnectLoses: logging out mid-duel hands the other the win.
func TestDuelDisconnectLoses(t *testing.T) {
	r, a, b := duelPair(t)
	accept(t, r, a, b)
	r.srv.leave(b.sess)
	r.tick()
	ev, _ := a.last(combat.EvDuelEnded)
	if ev == nil || ev.Value != duelLeft || ev.EntityID != a.ent().ID {
		t.Fatalf("disconnect: %+v", ev)
	}
	if len(r.srv.pvp.duels) != 0 || a.ent().pvp.duel != nil {
		t.Fatal("duel left behind")
	}
}

// TestPvPSafeZonesFromTheAtlas: settlements out to radius + margin, and the
// Haven around the world spawn, are safe; open country is not.
func TestPvPSafeZonesFromTheAtlas(t *testing.T) {
	r := newPvPRig(t)
	r.srv.pvp.safeAt = nil
	a := &combat.AtlasInfo{WorldSize: 4096, SpawnX: 1000, SpawnZ: 1000}
	a.Sites = append(a.Sites, combat.SiteInfo{Site: structures.Site{Category: structures.CategorySettlement, X: 3000, Z: 3000, Radius: 60, Name: "Thornbury"}})
	r.srv.cbt.w.Atlas = a
	margin := combatdefs.D.PvP.SettlementMarginM
	haven := combatdefs.D.Difficulty.HavenRadiusM
	for _, tc := range []struct {
		x, z float64
		safe bool
		name string
	}{
		{3000, 3000, true, "Thornbury"},
		{3000 + 60 + margin - 1, 3000, true, "Thornbury"},
		{3000 + 60 + margin + 1, 3000, false, ""},
		{1000, 1000, true, "the Haven"},
		{1000 + haven - 1, 1000, true, "the Haven"},
		{1000 + haven + 1, 1000, false, ""},
		{2000, 3500, false, ""},
	} {
		safe, name := r.srv.pvpSafe(movement.Vec3{X: tc.x, Z: tc.z})
		if safe != tc.safe || name != tc.name {
			t.Errorf("(%v, %v): safe %v %q, want %v %q", tc.x, tc.z, safe, name, tc.safe, tc.name)
		}
	}
}
