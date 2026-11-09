package game

import (
	"context"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/ratelimit"
	"lodestone/server/pkg/snapshot"
	"lodestone/server/pkg/ticket"
	"lodestone/server/pkg/transport"
	"lodestone/server/zone/internal/combat"
)

const (
	helloTimeout = 10 * time.Second
	// Hello may carry a local profile's signed save blob, which can reach
	// hundreds of KB (spec 11); after the handshake frames are tiny.
	helloReadLimit   = 1 << 20
	sessionReadLimit = 16 << 10
	inboxMax         = 256
)

// session is one connected client. The reader goroutine owns buckets and
// writes inbox/closed; the tick owns everything else.
type session struct {
	conn   transport.Conn
	claims ticket.Claims
	spawn  movement.Vec3
	joined chan struct{}
	closed atomic.Bool
	// WP16: handoff state (handoff.go); joinOnce guards joined, which a
	// standby session closes twice (standby, then admission).
	ho       *sessHandoff
	joinOnce sync.Once

	mu    sync.Mutex
	inbox []proto.Message
	spare []proto.Message
	// WP19b (inputs.go): this tick's messages, taken from inbox, and
	// whether they must be applied on the tick goroutine.
	taken    []proto.Message
	inSerial bool

	// Tick-owned.
	ent    *Entity
	x      *exploreState   // WP12 exploration (explore.go)
	cprof  *combat.Profile // WP13: loaded before join (combat.go)
	items  *charItems      // WP14: loaded before join (items.go)
	quests *questState     // quest log: loaded before join (quests.go)
	// Playtest 2: travel to a friend (friendtravel.go).
	travel           *friendTravel
	lastFriendTravel time.Time
	left             bool
	ackTick          uint32
	ackFloor         uint32 // WP16: acks at or below this tick predate the session's current activation
	enc              snapshot.Encoder
	budget           snapshot.BudgetStats // last published encoder counters
	relCharged       int64                // WP19b: conn's ReliableQueued already charged to the budget
	frameBudget      ratelimit.Bucket
	frames           []proto.InputFrame // received, not yet applied (sorted at apply)
	gapSince         uint32             // tick a missing frame started holding the buffer, 0 = none
	consumed         uint32             // newest frame seq applied or refused (LastSeq counts applied only)
	editChunks       map[[2]int32]bool  // WP09: chunks whose WorldEdits this client has (mining.go)
	doors            *sessDoors         // building doors: settlements known, frame ground (doors.go)

	// Reader-owned.
	buckets    [256]*ratelimit.Bucket
	violations ratelimit.Bucket
}

// Per-message-type token buckets (spec 9 security; the-circle consumers.py
// pattern): capacity allows a burst, rate is the sustained ceiling, both well
// above what an honest client sends (Input 30/s, ClockPing <= 1/s).
func newBuckets() [256]*ratelimit.Bucket {
	var b [256]*ratelimit.Bucket
	mk := func(capacity, rate float64) *ratelimit.Bucket { x := ratelimit.New(capacity, rate); return &x }
	b[proto.MsgInput] = mk(60, 40)
	b[proto.MsgClockPing] = mk(16, 4)
	b[proto.MsgHitClaim] = mk(30, 15)
	b[proto.MsgInteract] = mk(10, 5)
	b[proto.MsgBye] = mk(4, 1)
	b[proto.MsgHello] = mk(2, 0.1)
	return b
}

// Handler is the /ws endpoint. In dev mode a `spawn=x,z` query picks the
// spawn point (soak bots use it to spread out or cluster).
func (s *Server) Handler(ws *transport.WebSocket) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hint := s.spawnHint(r)
		ws.Handler(func(c transport.Conn) { s.accept(c, hint) }).ServeHTTP(w, r)
	})
}

// AcceptWebTransport is the WebTransport session handler (same handshake
// and session code as /ws; the transport is invisible past this point).
func (s *Server) AcceptWebTransport(r *http.Request, c transport.Conn) {
	s.accept(c, s.spawnHint(r))
}

func (s *Server) spawnHint(r *http.Request) *movement.Vec3 {
	if !s.cfg.DevSpawn {
		return nil
	}
	if v := r.URL.Query().Get("spawn"); v != "" {
		if p, ok := parseSpawn(v); ok {
			return &p
		}
	}
	return nil
}

// budgetBurstTicks: unused byte allowance carries over for up to 3 ticks
// (100 ms), enough for a burst of first-sight records with names, short
// enough that the 5 s per-client kbps metric never sees the cap exceeded.
const budgetBurstTicks = 3

// priorityWeight is how fast an entity's send priority grows under the byte
// budget (decision 0005): 2 at your feet, 1 at 8 m, 0.22 at the near ring's
// edge (64 m), so in a crowd the people next to you update several times as
// often as those across the square. Party members get +2 on top: you watch
// your friends.
func priorityWeight(d float64, party bool) float64 {
	w := 16 / (d + 8)
	if party {
		w += 2
	}
	return w
}

func parseSpawn(v string) (movement.Vec3, bool) {
	// x,z (on the surface) or, since WP09, x,y,z (on the floor under y: dev
	// spawns inside caves). A missing y is NaN.
	parts := strings.Split(v, ",")
	if len(parts) != 2 && len(parts) != 3 {
		return movement.Vec3{}, false
	}
	x, err1 := strconv.ParseFloat(parts[0], 64)
	z, err2 := strconv.ParseFloat(parts[len(parts)-1], 64)
	y, err3 := math.NaN(), error(nil)
	if len(parts) == 3 {
		y, err3 = strconv.ParseFloat(parts[1], 64)
		if err3 == nil && (math.IsNaN(y) || math.IsInf(y, 0)) {
			return movement.Vec3{}, false
		}
	}
	if err1 != nil || err2 != nil || err3 != nil || math.IsNaN(x) || math.IsNaN(z) {
		return movement.Vec3{}, false
	}
	return movement.Vec3{X: x, Y: y, Z: z}, true
}

// kick sends Kick (reliable) and closes with 4000+code so a client that
// misses the frame still learns why.
func (s *Server) kick(sess *session, code proto.KickCode, reason string) {
	_ = sess.conn.SendReliable(proto.Encode(&proto.Kick{Code: code, Reason: reason}))
	sess.conn.Close(transport.CloseKickBase+int(code), reason)
	sess.closed.Store(true)
	s.m.kick(code)
}

func (s *Server) kickConn(c transport.Conn, code proto.KickCode, reason string) {
	_ = c.SendReliable(proto.Encode(&proto.Kick{Code: code, Reason: reason}))
	c.Close(transport.CloseKickBase+int(code), reason)
	s.m.kick(code)
	<-c.Done()
}

// accept runs the handshake and then the read loop, on the connection's
// goroutine. Hello -> protocol version -> ticket -> spawn lookup -> queue
// for the tick to admit -> read loop.
func (s *Server) accept(c transport.Conn, spawnHint *movement.Vec3) {
	if s.stopping.Load() {
		s.kickConn(c, proto.KickCodeShutdown, "zone shutting down")
		return
	}
	c.SetReadLimit(helloReadLimit)
	ctx, cancel := context.WithTimeout(context.Background(), helloTimeout)
	b, err := c.Recv(ctx)
	cancel()
	if err != nil {
		return
	}
	// Check the version before full decoding: a client on another protocol
	// version may lay out Hello differently, but protocolVersion is always
	// the first field, so it still gets a clear version_mismatch.
	if len(b) >= 3 && b[0] == proto.MsgHello {
		if v := uint16(b[1]) | uint16(b[2])<<8; v != proto.ProtocolVersion {
			s.kickConn(c, proto.KickCodeVersionMismatch, "server speaks protocol "+strconv.Itoa(proto.ProtocolVersion)+", client "+strconv.Itoa(int(v)))
			return
		}
	}
	m, err := proto.DecodeMessage(b)
	hello, ok := m.(*proto.Hello)
	if err != nil || !ok {
		s.m.protoErrors.Add(1)
		c.Close(1002, "expected Hello")
		return
	}
	// WP16: a director ticket, or a cluster zone's pre-connect token (handoff.go).
	claims, ho, err := s.verifyHello(hello)
	if err != nil {
		s.kickConn(c, proto.KickCodeBadTicket, err.Error())
		return
	}
	c.SetReadLimit(sessionReadLimit)

	sess := &session{conn: c, claims: claims, joined: make(chan struct{}),
		buckets: newBuckets(), violations: ratelimit.New(100, 10), frameBudget: frameBudget(), ho: ho}
	if !s.clusterAccept(sess) { // WP16: standby, or live state from the previous owner
		sess.spawn = s.spawnFor(claims, spawnHint)
		sess.x = s.loadExplore(claims, hello.SaveBlob, &sess.spawn, spawnHint != nil) // WP12
		sess.cprof = s.loadCombat(claims.CharacterID, sess.x)                         // WP13
		sess.items = s.loadItems(claims.CharacterID, sess.x)                          // WP14
		sess.quests = s.loadQuests(claims.CharacterID, sess.x)                        // quests.go
	}

	select {
	case s.joins <- sess:
	case <-s.stopped:
		s.kickConn(c, proto.KickCodeShutdown, "zone shutting down")
		return
	case <-time.After(2 * time.Second):
		s.kickConn(c, proto.KickCodeServerFull, "zone busy")
		return
	}
	select {
	case <-sess.joined:
	case <-c.Done():
		sess.closed.Store(true)
		return
	case <-s.stopped:
		// Queued after Stop drained the join queue: nobody will admit it.
		s.kickConn(c, proto.KickCodeShutdown, "zone shutting down")
		return
	}
	if sess.closed.Load() {
		<-c.Done()
		return
	}
	s.readLoop(sess)
}

// frameBudget bounds simulated time to real time: frames ARE simulation time
// (one frame = 1/60 s of movement), so a client sending 120 frames a second
// would move twice as fast. The burst absorbs packets bunched up by TCP or a
// hitch; beyond it frames are dropped and the client reconciles. This is the
// real speed-hack defense.
//
// Burst 60 frames (1 s), up from WP03's 30: under the netsim "thailand"
// profile a TCP retransmit stall (~250 ms) often chains into a second one,
// and a 500-600 ms bunch overflowed 30 frames, snapping honest players back
// a step or two (WP06 two-browser run, decision 0006). The cost: a client
// that deliberately withholds input ("lag switch") can deliver at most 1 s
// of movement at once, which an honest player on a bad link already does.
func frameBudget() ratelimit.Bucket { return ratelimit.New(60, 60) }

func (s *Server) spawnFor(c ticket.Claims, hint *movement.Vec3) movement.Vec3 {
	if hint != nil {
		return s.hintSpawn(*hint)
	}
	if s.cfg.Store != nil {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if p, ok, err := s.cfg.Store.LoadPosition(ctx, c.CharacterID); err == nil && ok {
			return s.savedSpawn(c.CharacterID, p)
		} else if err != nil {
			s.log.Warn("load position failed; using default spawn", "character", c.CharacterID, "err", err)
		}
	}
	return s.newCharacterSpawn(c.CharacterID)
}

// readLoop decodes frames, applies rate limits and answers clock pings
// directly (off the tick, so the pong's t2/t3 are as tight as possible).
func (s *Server) readLoop(sess *session) {
	defer sess.closed.Store(true)
	for {
		b, err := sess.conn.Recv(context.Background())
		if err != nil {
			return
		}
		t2 := s.serverTimeMs()
		now := time.Now()
		if len(b) == 0 {
			continue
		}
		if bk := sess.buckets[b[0]]; bk != nil && !bk.Take(now) {
			s.m.rateLimited.Add(1)
			if !sess.violations.Take(now) {
				s.kick(sess, proto.KickCodeRateLimited, "too many messages")
				return
			}
			continue
		}
		m, err := proto.DecodeMessage(b)
		if err != nil {
			// Strict decoding: after a matching Hello, a bad frame means a
			// broken or hostile client.
			s.m.protoErrors.Add(1)
			sess.conn.Close(1002, "protocol error")
			return
		}
		switch msg := m.(type) {
		case *proto.ClockPing:
			pong := &proto.ClockPong{T1: msg.T1, T2: t2, T3: s.serverTimeMs()}
			if h, ok := sess.conn.(transport.Holder); ok {
				h.SendUrgent(proto.Encode(pong)) // not delayed by the tick's hold (WP19b)
			} else {
				sess.conn.SendUnreliable(proto.Encode(pong))
			}
		case *proto.Bye:
			sess.conn.Close(1000, "bye")
			return
		case *proto.Input, *proto.HitClaim, *proto.Interact:
			sess.mu.Lock()
			if len(sess.inbox) < inboxMax {
				sess.inbox = append(sess.inbox, m)
			}
			sess.mu.Unlock()
		default:
			// Server-to-client ids or a second Hello: ignore.
		}
	}
}

// drainTaken applies the messages takeInputs took from a session's inbox
// (tick goroutine, or a worker for a plain session: inputs.go).
func (s *Server) drainTaken(sess *session, now time.Time) {
	msgs := sess.taken
	sess.taken = nil
	var claims []*proto.HitClaim
	for _, m := range msgs {
		if hc, ok := m.(*proto.HitClaim); ok {
			claims = append(claims, hc) // WP13: validated after this tick's frames (combat.go)
			continue
		}
		if it, ok := m.(*proto.Interact); ok {
			if it.TargetKind == InteractChem || it.TargetKind == InteractNight {
				s.nightInteract(sess, it) // WP15: chemistry sync mode, dev night tools (night.go)
				continue
			}
			if it.TargetKind == InteractFriend {
				s.friendInteract(sess, it, now) // playtest 2: travel to a friend (friendtravel.go)
				continue
			}
			if it.TargetKind == InteractQuest {
				s.questInteract(sess, it) // quests: accept, abandon, turn in, track (quests.go)
				continue
			}
			if it.TargetKind == InteractPvP {
				s.pvpInteract(sess, it) // playtest 2: PvP flag, duels (pvp.go, duel.go)
				continue
			}
			if it.TargetKind == combat.InteractCombat {
				s.handleCombatInteract(sess, it) // WP13: loadouts, equip, learn (combat.go)
				continue
			}
			s.interact(sess.ent, it, now)   // WP09 mining (mining.go)
			s.handleInteract(sess, it, now) // WP12: fast travel, pins (explore.go)
			s.townInteract(sess, it, now)   // WP20: NPCs, bounty board, stations, shafts (towns.go)
			s.itemInteract(sess, it, now)   // WP14: containers, items, crafting, dropped items (items.go)
			continue
		}
		in, ok := m.(*proto.Input)
		if !ok {
			continue
		}
		// Baseline ack: newest snapshot the client has. Never trust an ack
		// from the future.
		if in.AckTick > sess.ackTick && in.AckTick > sess.ackFloor && in.AckTick <= s.tick {
			sess.ackTick = in.AckTick
		}
		// Frames: newest plus repeats, any order; collected across this
		// tick's packets and applied below.
		for _, f := range in.Frames {
			if f.Seq > sess.consumed {
				sess.frames = append(sess.frames, f)
			}
		}
	}
	clear(msgs)
	sess.spare = msgs // tick-owned (takeInputs swaps it in under mu)
	s.applyFrames(sess, now)
	for _, c := range claims {
		s.handleHitClaim(sess, c) // WP13 (combat.go)
	}
}

// gapWaitTicks: how long a missing frame may hold back the ones after it.
// Datagrams reorder (the netsim "thailand" relay reorders by 2+ packets about
// 1% of the time, as real jittery paths do); applying frame N+1 before N
// arrives would drop N for good and cost the player a reconciliation snap.
// Two ticks (67 ms) is past any plausible reordering; a frame still missing
// then was truly lost (all its redundant copies), so skip it. Over WebSocket
// frames never arrive out of order and this never waits.
const gapWaitTicks = 2

// maxBufferedFrames caps frames held behind a gap (0.5 s of input).
const maxBufferedFrames = 30

// maxSynthFrames: longest run of lost frames filled by repeating the last
// input (133 ms); a longer hole is skipped.
const maxSynthFrames = 8

// fillGap handles frames lost for good (every redundant copy dropped)
// before frame next: rather than skip them, which puts the server a step or
// two behind the client's prediction and costs a visible 8-16 cm snap, repeat
// the player's previous input for each (Quake's "duplicate the last
// command"). Walking or holding still through a loss then matches the
// prediction exactly; a turn or key change inside the hole is reconciled
// as usual. Synthesized frames pass the frame budget like real ones, so this
// grants no extra simulation time. Jump edges are never repeated.
func (s *Server) fillGap(sess *session, next uint32, now time.Time) {
	e := sess.ent
	missing := next - sess.consumed - 1
	if missing > maxSynthFrames || e.LastSeq == 0 {
		s.m.framesSkipped.Add(int64(missing))
		return
	}
	f := e.lastFrame
	f.Flags &^= proto.InputFlagJumpEdge | oneStepFlags // WP13: never repeat an attack, cast or dodge
	for seq := sess.consumed + 1; seq < next; seq++ {
		f.Seq = seq
		sess.consumed = seq
		if !sess.frameBudget.Take(now) {
			s.m.framesDropped.Add(1)
			continue
		}
		f = s.combatFrame(sess, f) // WP13 (combat.go)
		// Building doors: the ground with the doors closed for this frame (doors.go).
		e.applyFrame(f, s.frameGround(sess, f.Seq), s.env)
		s.combatAfterFrame(sess, f)
		s.m.framesSynthesized.Add(1)
	}
}

// applyFrames applies buffered input frames in seq order, one fixed 1/60 s
// step each, waiting briefly for a missing frame (see gapWaitTicks).
func (s *Server) applyFrames(sess *session, now time.Time) {
	e := sess.ent
	fr := sess.frames
	slices.SortFunc(fr, func(a, b proto.InputFrame) int { return cmpU32(a.Seq, b.Seq) })
	fr = slices.CompactFunc(fr, func(a, b proto.InputFrame) bool { return a.Seq == b.Seq })
	i, applied := 0, int64(0)
	defer func() { s.m.frames.Add(applied) }() // one atomic per session, not per frame (WP19b)
	for ; i < len(fr); i++ {
		f := fr[i]
		if f.Seq <= sess.consumed {
			continue
		}
		if sess.consumed != 0 && f.Seq != sess.consumed+1 {
			if sess.gapSince == 0 {
				sess.gapSince = s.tick
			}
			if s.tick-sess.gapSince < gapWaitTicks && len(fr)-i < maxBufferedFrames {
				break // hold the rest until the gap fills or times out
			}
			s.fillGap(sess, f.Seq, now)
		}
		sess.gapSince = 0
		// Consumed whether applied or dropped by the frame budget: a frame
		// refused for speed-hack reasons must not hold back later ones.
		sess.consumed = f.Seq
		if !sess.frameBudget.Take(now) {
			s.m.framesDropped.Add(1)
			continue
		}
		f = s.combatFrame(sess, f) // WP13: log attacks/casts, refuse illegal dashes (combat.go)
		// Building doors: the ground with the doors closed for this frame (doors.go).
		if !e.applyFrame(f, s.frameGround(sess, f.Seq), s.env) {
			s.m.speedViolations.Add(1)
		}
		s.combatAfterFrame(sess, f)
		applied++
	}
	if e.drownedEvent {
		e.drownedEvent = false
		s.sendDrowned(sess)
	}
	if i >= len(fr) {
		sess.gapSince = 0
	}
	n := copy(fr, fr[i:])
	sess.frames = fr[:n]
}

// markJoined closes joined once (WP16: a standby session joins twice).
func (sess *session) markJoined() { sess.joinOnce.Do(func() { close(sess.joined) }) }
