package game

// Handoff between zones (WP16, spec 9 "Zones and handoff"). The protocol,
// from the old owner A's side, for a player P walking toward a region that
// zone B owns (docs/decisions/0016-handoff.md has the diagrams):
//
//  1. Pre-connect. P comes within GHOST_BAND_M of a region B owns: A stores
//     a single-use token (who P is, from A, to B) and sends P's client a
//     ZoneTransfer{kind 0, B's endpoints, token}. The client opens a second
//     connection to B and says Hello with the token. B consumes the token,
//     holds the connection as a STANDBY session (no entity, no snapshots;
//     it answers clock pings, so the clock is warm) and tells A "ready".
//  2. Transfer. P is 2 m inside B's region and B is ready: on one tick A
//     serializes P's whole state (HandoffState: movement state bit-exact,
//     last applied input seq and frame, observers' view, progress, party,
//     checkpoint epoch), queues the transfer checkpoint, turns P's entity
//     into a mirrored (remote) entity with the same id, keeps P's connection
//     as a standby for the way back, and stores the state + tells B
//     "transfer". A stops reading P's input from here on.
//  3. Admission. B takes the state (exactly once: Take is atomic) and admits
//     the standby session with it on its next tick: same entity id, same
//     movement state, input continues at lastSeq+1. B's Welcome on that
//     connection is the client's signal to switch: it makes B's connection
//     the active one, resends the inputs A never applied, and keeps its
//     prediction, interpolation and clock (zone server clocks are all Unix
//     time). B's first snapshot says ackInputSeq = lastSeq with A's state,
//     which is what the client predicted: no correction.
//
// Walking back is the same protocol in the other direction, except that
// step 1 is free: A already holds P's old connection as a standby and told
// B "ready" implicitly with the transfer.
//
// A player whose client cannot pre-connect is never dropped: A keeps
// simulating them past its border (every zone can simulate anywhere; the
// terrain is the same wasm everywhere) until B is ready. Observers on B's
// side see them through the ghost feed meanwhile.
//
// Duplicate login across zones: on every login a cluster zone swaps itself
// into owner:{char}; if another live zone held it, it asks that zone to
// "release" the character, which hands over the live state the same way
// (and kicks its old session with duplicate_login). No character is ever
// simulated by two zones at once.
//
// Checkpoint ordering: every write carries the owner's epoch (Unix ms at
// admission, always greater than the previous owner's), and Postgres
// refuses a write whose epoch is older than the last one that landed
// (persist.go). A's queued writes can therefore land late without ever
// overwriting B's; B checkpoints in full at admission so B's state is what
// survives.

import (
	"context"
	"encoding/json"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/snapshot"
	"lodestone/server/pkg/ticket"
	"lodestone/server/pkg/transport"
	"lodestone/server/zone/internal/explore"
)

const (
	// handoffEveryTicks: ownership/band checks per player at 10 Hz,
	// staggered by id. Sprinting (7.8 m/s) moves 0.8 m between checks.
	handoffEveryTicks = 3
	// transferDepthM: P must be this far inside the new owner's region
	// before the transfer. Back and forth across the line costs nothing
	// until the player commits 2 m either way (4 m of hysteresis).
	transferDepthM = 2
	// cancelBandM: a pre-connect is cancelled only beyond the band plus
	// this margin, so a player walking along the band edge doesn't make
	// the client open and close connections.
	cancelBandM = 16
	// preconnectRetry: re-issue a pre-connect the client never completed.
	preconnectRetry = 15 * time.Second
	// tokenTTL / stateTTL: Redis lifetimes of tokens and handoff states.
	tokenTTL = 60 * time.Second
	stateTTL = 60 * time.Second
	// standbyIdle: a standby connection never activated for this long is
	// closed (kick transferred); the client re-pre-connects when needed.
	standbyIdle = 10 * time.Minute
	// pendingHold: a transferred state whose standby connection vanished is
	// kept this long for the player's reconnect, then checkpointed.
	pendingHold = 30 * time.Second
	// releaseWait: how long a login waits for the previous owner to hand
	// over the live state before falling back to the Postgres checkpoint.
	releaseWait = 1500 * time.Millisecond
	// ownerTTL: owner:{char} records outlive any session; liveness of the
	// zone named in them is checked against the registry.
	ownerTTL = 24 * time.Hour
)

// sessHandoff is a session's WP16 state (tick-owned unless noted).
type sessHandoff struct {
	// Standby sessions.
	standby bool      // joined as a standby (token Hello), not admitted
	owner   string    // zone that owns the character: told ready/unready
	since   time.Time // became a standby
	// Active sessions.
	ready    map[string]bool // zones holding a standby for this character
	target   string          // pre-connect issued for this zone
	issuedAt time.Time
	// Admission input (set on the connection goroutine before join, or by
	// admitTransfer on the tick).
	state    *HandoffState
	entityID uint32 // world-stable id from the cluster allocator
}

// pendingState is a transferred state waiting for its player.
type pendingState struct {
	st *HandoffState
	at time.Time
}

type clusterIn struct {
	ctl   ctlMsg
	st    *HandoffState
	ghost *ghostFrame
}

// clusterState is the server's WP16 state.
type clusterState struct {
	c    Cluster
	self string

	inbox      chan clusterIn
	work       chan func()
	ghostOut   chan []byte
	presenceIn chan map[string][]byte
	presOut    chan presenceBatch
	waiters    sync.Map // character -> chan *HandoffState (release; connection goroutines)

	// Tick-owned.
	standby     map[string]*session
	pending     map[string]pendingState
	remote      []*Entity
	remoteByID  map[uint32]*Entity
	remoteParty map[uint32][]*Entity
	gone        []uint32
	departed    []string
	presenceAt  time.Time
	gw          proto.Writer

	stats clusterStats
}

type clusterStats struct {
	out, in, released, preconnects, cancels, standbys, standbyDrops, pendingDrops, lost, ghostsIn, ghostsDropped, fenced atomic.Int64
	remote                                                                                                               atomic.Int64
}

type presenceBatch struct {
	put map[string][]byte
	del []string
}

func (s *Server) clusterOn() bool { return s.cl.c != nil }

// startCluster wires the goroutines (Start).
func (s *Server) startCluster() {
	c := s.cfg.Cluster
	if c == nil {
		return
	}
	cl := &s.cl
	cl.c, cl.self = c, s.cfg.ZoneID
	cl.inbox = make(chan clusterIn, 4096)
	cl.work = make(chan func(), 8192)
	cl.ghostOut = make(chan []byte, 2)
	cl.presenceIn = make(chan map[string][]byte, 1)
	cl.presOut = make(chan presenceBatch, 1)
	cl.standby = map[string]*session{}
	cl.pending = map[string]pendingState{}
	cl.remoteByID = map[uint32]*Entity{}
	cl.remoteParty = map[uint32][]*Entity{}
	go s.clusterReceive()
	go func() { // control worker: FIFO, so a state is stored before B hears "transfer"
		for f := range cl.work {
			f()
		}
	}()
	go func() { // ghost publisher: latest wins (a late frame is worthless)
		for b := range cl.ghostOut {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			_ = c.Broadcast(ctx, b)
			cancel()
		}
	}()
	go func() { // presence: write ours, read everyone's (1 Hz)
		for b := range cl.presOut {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			if err := c.WritePresence(ctx, b.put, b.del); err != nil {
				s.log.Debug("presence write", "err", err)
			}
			m, err := c.ReadPresence(ctx)
			cancel()
			if err != nil {
				continue
			}
			select {
			case cl.presenceIn <- m:
			default:
				select { // replace the unread one
				case <-cl.presenceIn:
				default:
				}
				cl.presenceIn <- m
			}
		}
	}()
}

// do queues f on the control worker (never blocks the tick).
func (s *Server) do(f func()) {
	select {
	case s.cl.work <- f:
	default:
		s.log.Error("cluster worker queue full; dropping a control action")
	}
}

func bg(d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), d)
}

func (s *Server) sendCtl(to string, m ctlMsg) {
	m.From = s.cl.self
	b := m.encode()
	s.do(func() {
		ctx, cancel := bg(2 * time.Second)
		defer cancel()
		if err := s.cl.c.Send(ctx, to, b); err != nil {
			s.log.Warn("cluster send failed", "to", to, "type", m.T, "err", err)
		}
	})
}

// clusterReceive turns deliveries into tick inputs. Handoff states are
// taken here (off the tick); a state some login is waiting for (release)
// goes straight to that connection goroutine.
func (s *Server) clusterReceive() {
	cl := &s.cl
	for m := range cl.c.Recv() {
		if m.Ghost {
			f, err := decodeGhosts(m.Data)
			if err != nil || f.Zone == cl.self {
				continue
			}
			select {
			case cl.inbox <- clusterIn{ghost: &f}:
			default:
				cl.stats.ghostsDropped.Add(1)
			}
			continue
		}
		ctl, err := decodeCtl(m.Data)
		if err != nil {
			s.log.Warn("bad control message", "err", err)
			continue
		}
		switch ctl.T {
		case ctlTransfer:
			ctx, cancel := bg(2 * time.Second)
			raw, err := cl.c.Take(ctx, stateKey(ctl.Key))
			cancel()
			if err != nil || raw == nil {
				// Lost state (expired or Redis error): the client times out
				// its switch and reconnects through the director, landing
				// here from A's transfer checkpoint. Never two copies.
				cl.stats.lost.Add(1)
				s.log.Error("handoff state missing; the player will reconnect from the checkpoint", "character", ctl.Char, "from", ctl.From, "err", err)
				continue
			}
			st := &HandoffState{}
			if err := json.Unmarshal(raw, st); err != nil {
				cl.stats.lost.Add(1)
				s.log.Error("handoff state unreadable", "character", ctl.Char, "err", err)
				continue
			}
			if w, ok := cl.waiters.LoadAndDelete(ctl.Char); ok {
				w.(chan *HandoffState) <- st
				continue
			}
			cl.inbox <- clusterIn{ctl: ctl, st: st}
		case ctlNone:
			if w, ok := cl.waiters.LoadAndDelete(ctl.Char); ok {
				w.(chan *HandoffState) <- nil
			}
		default:
			cl.inbox <- clusterIn{ctl: ctl}
		}
	}
}

// handoffTick runs on the tick after inputs and before the grid rebuild.
func (s *Server) handoffTick(tick uint32, now time.Time) {
	if !s.clusterOn() {
		return
	}
	cl := &s.cl
	for n := 0; n < 4096; n++ {
		select {
		case in := <-cl.inbox:
			switch {
			case in.ghost != nil:
				s.applyGhosts(in.ghost, now)
			case in.st != nil:
				s.admitTransfer(in.st, now)
			default:
				s.handleCtl(in.ctl, now)
			}
			continue
		default:
		}
		break
	}
	select {
	case m := <-cl.presenceIn:
		s.applyPresence(m, now)
	default:
	}
	for char, sb := range cl.standby {
		if sb.closed.Load() {
			delete(cl.standby, char)
			s.dropStandbyConn(sb)
			s.sendCtl(sb.ho.owner, ctlMsg{T: ctlUnready, Char: char})
			continue
		}
		if now.Sub(sb.ho.since) > standbyIdle {
			delete(cl.standby, char)
			s.kick(sb, proto.KickCodeTransferred, "standby connection idle")
			s.dropStandbyConn(sb)
			s.sendCtl(sb.ho.owner, ctlMsg{T: ctlUnready, Char: char})
			cl.stats.standbyDrops.Add(1)
		}
	}
	for char, p := range cl.pending {
		if now.Sub(p.at) > pendingHold {
			delete(cl.pending, char)
			s.checkpointState(p.st)
			cl.stats.pendingDrops.Add(1)
			s.log.Warn("transferred player never arrived; state checkpointed", "character", char)
		}
	}
	if own := cl.c.Owners(); own != nil {
		for _, sess := range slices.Clone(s.sessions) {
			if e := sess.ent; e != nil && !sess.closed.Load() && (tick+e.ID)%handoffEveryTicks == 0 {
				s.handoffCheck(sess, own, now)
			}
		}
	}
	s.updateRemotes(now)
	s.publishGhosts(tick)
	s.publishPresence(now)
}

// handoffCheck decides pre-connects, cancels and transfers for one player.
func (s *Server) handoffCheck(sess *session, own *Owners, now time.Time) {
	e := sess.ent
	h := sess.handoffState()
	p := e.Move.Pos
	owner := own.OwnerAt(p.X, p.Z)
	if owner == "" {
		return // nobody owns where they stand (no primary live): keep them
	}
	if owner != s.cl.self {
		if Depth(p.X, p.Z) >= transferDepthM && h.ready[owner] {
			if _, live := own.Zones[owner]; live {
				s.transferOut(sess, owner, now)
				return
			}
		}
		s.preconnect(sess, owner, own, now)
		return
	}
	zone, d := own.NearestForeign(p.X, p.Z, s.cl.self)
	switch {
	case zone != "" && d < constants.GhostBandM:
		s.preconnect(sess, zone, own, now)
	case h.target != "" && (zone != h.target || d > constants.GhostBandM+cancelBandM):
		s.cancelPreconnect(sess)
	}
}

func (sess *session) handoffState() *sessHandoff {
	if sess.ho == nil {
		sess.ho = &sessHandoff{}
	}
	if sess.ho.ready == nil {
		sess.ho.ready = map[string]bool{}
	}
	return sess.ho
}

// preconnect makes sure the client is (getting) connected to zone.
func (s *Server) preconnect(sess *session, zone string, own *Owners, now time.Time) {
	h := sess.handoffState()
	if h.ready[zone] || (h.target == zone && now.Sub(h.issuedAt) < preconnectRetry) {
		return
	}
	info, ok := own.Zones[zone]
	if !ok {
		return
	}
	if h.target != "" && h.target != zone {
		s.cancelPreconnect(sess)
	}
	h.target, h.issuedAt = zone, now
	tok := randomToken()
	rec, _ := json.Marshal(tokenRecord{Claims: claimsJSON(sess.claims), From: s.cl.self, To: zone})
	msg := proto.Encode(&proto.ZoneTransfer{ZoneID: zone, Endpoint: info.Endpoint, WtEndpoint: info.WTEndpoint, Ticket: []byte(HandoffTicketPrefix + tok), Kind: 0})
	conn, char := sess.conn, sess.claims.CharacterID
	s.cl.stats.preconnects.Add(1)
	s.do(func() {
		ctx, cancel := bg(2 * time.Second)
		defer cancel()
		// Stored before the client hears about it, so B can always find it.
		if err := s.cl.c.Put(ctx, tokenKey(tok), rec, tokenTTL); err != nil {
			s.log.Warn("pre-connect token not stored", "character", char, "err", err)
			return
		}
		_ = conn.SendReliable(msg)
	})
}

func (s *Server) cancelPreconnect(sess *session) {
	h := sess.handoffState()
	if h.target == "" {
		return
	}
	zone := h.target
	h.target = ""
	s.cl.stats.cancels.Add(1)
	_ = sess.conn.SendReliable(proto.Encode(&proto.ZoneTransfer{ZoneID: zone, Kind: 1}))
}

// buildState snapshots a live character for its next owner.
func (s *Server) buildState(sess *session) *HandoffState {
	e := sess.ent
	st := &HandoffState{
		Claims: claimsJSON(sess.claims), From: s.cl.self, AtMs: s.cfg.Now().UnixMilli(), Epoch: e.epoch,
		EntityID: e.ID, Move: e.Move, Prev: e.prevValid, View: e.viewRaw, Guess: e.guess,
		Yaw: e.Yaw, Pitch: e.Pitch, LastSeq: e.LastSeq, LastFrame: e.lastFrame,
		Level: e.Level, Health: e.Health, HealthMax: e.HealthMax,
	}
	if x := sess.x; x != nil {
		st.Progress = x.prog
		st.ReadOnly = x.readOnly
		st.PartyKey = x.partyKey
		if !x.lastTravel.IsZero() {
			st.LastTravel = x.lastTravel.UnixMilli()
		}
		if x.local != nil {
			st.Local = &localSaveJSON{ProfileID: x.local.profileID, State: x.local.state}
		}
	}
	for _, f := range handoffFields {
		if b := f.Save(s, e); b != nil {
			if st.Ext == nil {
				st.Ext = map[string]json.RawMessage{}
			}
			st.Ext[f.Name] = b
		}
	}
	return st
}

// transferOut hands sess's character to zone `to` (tick goroutine).
func (s *Server) transferOut(sess *session, to string, now time.Time) {
	e := sess.ent
	st := s.buildState(sess)
	// Spec 11: saved on zone transfer. Fenced by this zone's epoch, so it
	// can never overwrite what the next owner writes.
	s.exploreLeave(sess)
	if s.cfg.Queue != nil {
		s.checkpoint(e)
	}
	s.detach(sess)
	s.addRemoteFrom(e, to, now)
	// The connection stays open as a standby for the way back.
	h := sess.handoffState()
	h.standby, h.owner, h.since, h.target = true, to, now, ""
	clear(h.ready)
	sess.ent = nil
	s.cl.standby[st.Claims.CharacterID] = sess
	s.putState(st, to)
	s.cl.stats.out.Add(1)
	s.log.Info("handoff out", "character", st.Claims.CharacterID, "to", to, "entity", e.ID, "seq", st.LastSeq,
		"x", e.Move.Pos.X, "z", e.Move.Pos.Z)
}

// putState stores st and tells `to` to take it (control worker: in order).
func (s *Server) putState(st *HandoffState, to string) {
	key := randomToken()
	raw, _ := json.Marshal(st)
	msg := ctlMsg{T: ctlTransfer, From: s.cl.self, Char: st.Claims.CharacterID, Key: key}.encode()
	s.do(func() {
		ctx, cancel := bg(3 * time.Second)
		defer cancel()
		if err := s.cl.c.Put(ctx, stateKey(key), raw, stateTTL); err != nil {
			s.log.Error("handoff state not stored; the player reconnects from the checkpoint", "character", st.Claims.CharacterID, "err", err)
			return
		}
		if err := s.cl.c.Send(ctx, to, msg); err != nil {
			s.log.Error("handoff transfer not sent", "character", st.Claims.CharacterID, "to", to, "err", err)
		}
	})
}

// detach removes an active session and its entity from the simulation
// without closing the connection (transfer) and without logout effects.
func (s *Server) detach(sess *session) {
	e := sess.ent
	if i := slices.Index(s.sessions, sess); i >= 0 {
		s.sessions = slices.Delete(s.sessions, i, i+1)
	}
	s.connsMu.Lock()
	delete(s.conns, sess)
	s.connsMu.Unlock()
	s.m.players.Store(int64(len(s.sessions)))
	if k := sess.conn.Kind(); int(k) < len(s.m.transports) {
		s.m.transports[k].Add(-1)
	}
	if e == nil {
		return
	}
	if s.byChar[e.CharacterID] == sess {
		delete(s.byChar, e.CharacterID)
	}
	s.removeEntity(e)
	if e.PartyID != 0 {
		ps := s.parties[e.PartyID]
		if i := slices.Index(ps, e); i >= 0 {
			s.parties[e.PartyID] = slices.Delete(ps, i, i+1)
		}
		if len(s.parties[e.PartyID]) == 0 {
			delete(s.parties, e.PartyID)
		}
	}
}

// admitTransfer admits a transferred character (tick goroutine).
func (s *Server) admitTransfer(st *HandoffState, now time.Time) {
	char := st.Claims.CharacterID
	sb := s.cl.standby[char]
	if sb == nil || sb.closed.Load() {
		// The client's standby connection is gone: hold the state for its
		// reconnect (join picks it up), checkpoint it if nobody comes.
		s.cl.pending[char] = pendingState{st: st, at: now}
		s.log.Warn("transferred player has no standby connection here; holding the state", "character", char, "from", st.From)
		return
	}
	delete(s.cl.standby, char)
	h := sb.handoffState()
	h.standby, h.state = false, st
	s.resetForAdmission(sb)
	sb.joined = make(chan struct{}) // join closes it; nobody waits on it now
	sb.joinOnce = sync.Once{}
	s.join(sb)
	if sb.ent != nil {
		h.ready[st.From] = true // the old owner kept our old connection as a standby
		s.cl.stats.in.Add(1)
		s.log.Info("handoff in", "character", char, "from", st.From, "entity", sb.ent.ID, "seq", st.LastSeq, "latencyMs", s.cfg.Now().UnixMilli()-st.AtMs)
	}
}

// resetForAdmission clears per-activation session state, so a connection
// that was active here before (and a standby since) starts like a new one:
// fresh snapshot baselines (the client resets its decoder on Welcome) and
// an ack floor at the current tick (a stale ack from the last activation,
// e.g. a reordered datagram, must not name a baseline the client lost).
func (s *Server) resetForAdmission(sess *session) {
	sess.enc = snapshot.Encoder{} // join re-applies the byte budget
	sess.budget = snapshot.BudgetStats{}
	sess.ackTick = s.tick
	sess.frames = sess.frames[:0]
	sess.gapSince = 0
	sess.consumed = 0
	sess.editChunks = nil
	sess.left = false
	sess.x = nil // replaced from the handoff state (joinState)
	sess.mu.Lock()
	clear(sess.inbox)
	sess.inbox = sess.inbox[:0]
	sess.mu.Unlock()
}

// joinStandby registers a standby session (join's first branch).
func (s *Server) joinStandby(sess *session) {
	char := sess.claims.CharacterID
	if live := s.byChar[char]; live != nil {
		// Already active here: a stale pre-connect. Refuse it.
		s.kick(sess, proto.KickCodeTransferred, "already connected to this zone")
		return
	}
	if old := s.cl.standby[char]; old != nil && old != sess {
		s.kick(old, proto.KickCodeTransferred, "replaced by a newer connection")
		s.dropStandbyConn(old)
	}
	sess.ho.since = time.Now()
	s.cl.standby[char] = sess
	s.cl.stats.standbys.Add(1)
	s.sendCtl(sess.ho.owner, ctlMsg{T: ctlReady, Char: char})
	if p, ok := s.cl.pending[char]; ok {
		// A transfer arrived before this connection did (reconnect race).
		delete(s.cl.pending, char)
		s.admitTransfer(p.st, time.Now())
	}
}

func (s *Server) dropStandbyConn(sess *session) {
	sess.closed.Store(true)
	sess.conn.Close(transport.CloseKickBase+int(proto.KickCodeTransferred), "standby closed")
}

// handleCtl applies a control message (tick goroutine).
func (s *Server) handleCtl(m ctlMsg, now time.Time) {
	switch m.T {
	case ctlReady, ctlUnready:
		if sess := s.byChar[m.Char]; sess != nil && sess.ent != nil {
			h := sess.handoffState()
			if m.T == ctlReady {
				h.ready[m.From] = true
			} else {
				delete(h.ready, m.From)
				if h.target == m.From {
					h.target = "" // re-issue on the next check
				}
			}
		}
	case ctlRelease:
		if sess := s.byChar[m.Char]; sess != nil && sess.ent != nil {
			st := s.buildState(sess)
			e := sess.ent
			s.exploreLeave(sess)
			if s.cfg.Queue != nil {
				s.checkpoint(e)
			}
			s.kick(sess, proto.KickCodeDuplicateLogin, "logged in from another connection")
			s.detach(sess)
			sess.left = true
			s.addRemoteFrom(e, m.From, now)
			s.putState(st, m.From)
			s.cl.stats.released.Add(1)
			s.log.Info("released to another zone (duplicate login)", "character", m.Char, "to", m.From)
			return
		}
		if sb := s.cl.standby[m.Char]; sb != nil {
			delete(s.cl.standby, m.Char)
			s.kick(sb, proto.KickCodeTransferred, "logged in elsewhere")
			s.dropStandbyConn(sb)
		}
		s.sendCtl(m.From, ctlMsg{T: ctlNone, Char: m.Char})
	}
}

// ---- connection goroutine side ----

// verifyHello checks Hello's ticket: a director-signed connect ticket, or
// (cluster zones) a pre-connect token, which makes a standby session.
func (s *Server) verifyHello(hello *proto.Hello) (ticket.Claims, *sessHandoff, error) {
	raw := string(hello.Ticket)
	if s.clusterOn() && len(raw) > len(HandoffTicketPrefix) && raw[:len(HandoffTicketPrefix)] == HandoffTicketPrefix {
		ctx, cancel := bg(2 * time.Second)
		b, err := s.cl.c.Take(ctx, tokenKey(raw[len(HandoffTicketPrefix):]))
		cancel()
		var rec tokenRecord
		if err == nil && b != nil {
			err = json.Unmarshal(b, &rec)
		}
		if err != nil || b == nil {
			return ticket.Claims{}, nil, ticket.ErrSignature
		}
		if rec.To != s.cl.self || rec.Claims.WorldID != s.cfg.WorldID || rec.Claims.CharacterID == "" {
			return ticket.Claims{}, nil, ticket.ErrAudience
		}
		return rec.Claims.claims(s.cl.self), &sessHandoff{standby: true, owner: rec.From}, nil
	}
	claims, err := ticket.Verify(s.cfg.TicketKey, raw, ticket.AudienceZone(s.cfg.ZoneID), s.cfg.Now())
	if err == nil && claims.WorldID != s.cfg.WorldID {
		err = errWrongWorld
	}
	if err == nil && claims.CharacterID == "" {
		err = errNoCharacter
	}
	return claims, nil, err
}

// clusterAccept prepares a cluster login on the connection goroutine.
// Returns true when the session needs no spawn or progress lookup: a
// standby, or a login that received the live state from the zone that
// held the character (duplicate login across zones).
func (s *Server) clusterAccept(sess *session) bool {
	if !s.clusterOn() {
		return false
	}
	if sess.ho != nil && sess.ho.standby {
		return true
	}
	char := sess.claims.CharacterID
	h := sess.handoffState()
	ctx, cancel := bg(2 * time.Second)
	defer cancel()
	if id, err := s.cl.c.EntityID(ctx, char); err == nil {
		h.entityID = id
	} else {
		s.log.Warn("world entity id unavailable; using a zone-local id", "character", char, "err", err)
	}
	prev, err := s.cl.c.Swap(ctx, ownerKey(char), []byte(s.cl.self), ownerTTL)
	if err != nil || prev == nil || string(prev) == s.cl.self {
		return false
	}
	own := s.cl.c.Owners()
	if own == nil {
		return false
	}
	if _, live := own.Zones[string(prev)]; !live {
		return false // the old owner died: its regions failed over, load the checkpoint
	}
	w := make(chan *HandoffState, 1)
	s.cl.waiters.Store(char, w)
	if err := s.cl.c.Send(ctx, string(prev), ctlMsg{T: ctlRelease, From: s.cl.self, Char: char}.encode()); err != nil {
		s.cl.waiters.Delete(char)
		return false
	}
	select {
	case st := <-w:
		if st == nil {
			return false
		}
		h.state = st
		sess.spawn = st.Move.Pos
		sess.x = s.exploreFromState(st)
		return true
	case <-time.After(releaseWait):
		s.cl.waiters.Delete(char)
		s.log.Warn("previous owner did not release in time; loading the checkpoint", "character", char, "zone", string(prev))
		return false
	}
}

// exploreFromState rebuilds a character's exploration state from a handoff.
func (s *Server) exploreFromState(st *HandoffState) *exploreState {
	x := &exploreState{prog: st.Progress, readOnly: st.ReadOnly, partyKey: st.PartyKey}
	if x.prog == nil {
		x.prog = explore.NewProgress()
	}
	if st.LastTravel != 0 {
		x.lastTravel = time.UnixMilli(st.LastTravel)
	}
	if st.Local != nil {
		x.local = &localSaveState{profileID: st.Local.ProfileID, state: st.Local.State}
	}
	return x
}

// ---- join/leave hooks (tick goroutine) ----

// joinID picks the new entity's id: the handed-over one, else the world
// allocator's, else the zone-local counter.
func (s *Server) joinID(sess *session) uint32 {
	if h := sess.ho; h != nil {
		id := h.entityID
		if h.state != nil {
			id = h.state.EntityID
		}
		if id != 0 && s.entityByID(id) == nil {
			s.removeRemote(id) // its mirror (if any) becomes the real thing
			return id
		}
	}
	id := s.nextID
	s.nextID++
	return id
}

// joinState applies a handoff state to a new entity (join, before Welcome).
// pending: a transfer that arrived while this player had no connection
// here (consumed on their reconnect).
func (s *Server) joinState(sess *session, e *Entity) {
	if !s.clusterOn() {
		return
	}
	h := sess.handoffState()
	if h.state == nil {
		if p, ok := s.cl.pending[e.CharacterID]; ok {
			delete(s.cl.pending, e.CharacterID)
			h.state = p.st
			sess.x = s.exploreFromState(p.st)
		}
	}
	e.epoch = s.cfg.Now().UnixMilli()
	st := h.state
	if st == nil {
		return
	}
	e.epoch = max(e.epoch, st.Epoch+1)
	e.Move, e.prevValid = st.Move, st.Prev
	e.view, e.viewRaw, e.guess = st.View, st.View, st.Guess
	e.Yaw, e.Pitch = st.Yaw, st.Pitch
	e.LastSeq, e.lastFrame = st.LastSeq, st.LastFrame
	e.Health, e.HealthMax = st.Health, st.HealthMax
	if st.Level > 0 {
		e.Level = st.Level
	}
	sess.consumed = st.LastSeq
	// Always the handed-over progress: a standby connection that was active
	// here before still carries that activation's (stale) exploration state.
	sess.x = s.exploreFromState(st)
	if k := sess.x.partyKey; k != "" {
		e.PartyID = PartyHash(k)
	}
	for _, f := range handoffFields {
		if b, ok := st.Ext[f.Name]; ok {
			f.Load(s, e, b)
		}
	}
}

// clusterJoined runs after Welcome: the owner record, and for an arriving
// character the full checkpoint that fences out the old owner's queue.
func (s *Server) clusterJoined(sess *session) {
	if !s.clusterOn() || sess.ent == nil {
		return
	}
	char, self := sess.ent.CharacterID, s.cl.self
	transferred := sess.ho != nil && sess.ho.state != nil
	if transferred {
		if sess.x != nil && sess.x.prog != nil {
			sess.x.prog.MarkDirty()
		}
		s.checkpoint(sess.ent)
		s.do(func() {
			ctx, cancel := bg(2 * time.Second)
			defer cancel()
			_, _ = s.cl.c.Swap(ctx, ownerKey(char), []byte(self), ownerTTL)
		})
		sess.ho.state = nil
	}
}

// clusterLeave runs when a player leaves the zone for good (logout).
func (s *Server) clusterLeave(e *Entity) {
	if !s.clusterOn() || e == nil {
		return
	}
	s.cl.gone = append(s.cl.gone, e.ID)
	s.cl.departed = append(s.cl.departed, e.CharacterID)
	char, self := e.CharacterID, s.cl.self
	s.do(func() {
		ctx, cancel := bg(2 * time.Second)
		defer cancel()
		_ = s.cl.c.DelIf(ctx, ownerKey(char), []byte(self))
	})
}

// clusterStop kicks standby connections on shutdown (Stop).
func (s *Server) clusterStop() {
	if !s.clusterOn() {
		return
	}
	for char, sb := range s.cl.standby {
		delete(s.cl.standby, char)
		s.kick(sb, proto.KickCodeShutdown, "zone shutting down")
	}
	for char, p := range s.cl.pending {
		delete(s.cl.pending, char)
		s.checkpointState(p.st)
	}
}

// checkpointState writes a handoff state nobody admitted (as its next
// owner, with a newer epoch than the sender's).
func (s *Server) checkpointState(st *HandoffState) {
	if s.cfg.Queue == nil || st == nil {
		return
	}
	e := &Entity{ID: st.EntityID, Kind: proto.EntityKindPlayer, CharacterID: st.Claims.CharacterID, Move: st.Move, epoch: max(s.cfg.Now().UnixMilli(), st.Epoch+1)}
	s.checkpoint(e)
	if st.Progress != nil && !st.ReadOnly && st.Local == nil {
		sess := &session{claims: st.Claims.claims(s.cl.self), ent: e, x: s.exploreFromState(st)}
		e.x = sess.x
		sess.x.prog.MarkDirty()
		s.saveProgressSoon(sess, true)
	}
}

// ---- entity store helpers ----

// insertEntity adds e keeping s.ents sorted by id (WP16: world-stable
// player ids are not allocated in join order any more).
func (s *Server) insertEntity(e *Entity) {
	i, _ := slices.BinarySearchFunc(s.ents, e.ID, func(x *Entity, id uint32) int { return cmpU32(x.ID, id) })
	s.ents = slices.Insert(s.ents, i, e)
}

func (s *Server) entityByID(id uint32) *Entity {
	if i, ok := slices.BinarySearchFunc(s.ents, id, func(x *Entity, id uint32) int { return cmpU32(x.ID, id) }); ok {
		return s.ents[i]
	}
	return nil
}

// ClusterStats is the handoff counters (metrics, /debug/cluster).
func (s *Server) ClusterStats() map[string]int64 {
	st := &s.cl.stats
	return map[string]int64{
		"handoffs_out": st.out.Load(), "handoffs_in": st.in.Load(), "released": st.released.Load(),
		"preconnects": st.preconnects.Load(), "cancels": st.cancels.Load(), "standbys_joined": st.standbys.Load(),
		"standby_drops": st.standbyDrops.Load(), "pending_drops": st.pendingDrops.Load(), "states_lost": st.lost.Load(),
		"ghost_frames_in": st.ghostsIn.Load(), "ghost_frames_dropped": st.ghostsDropped.Load(), "remote_entities": st.remote.Load(),
		"checkpoints_fenced": st.fenced.Load(),
	}
}

// ClusterView is /debug/cluster's simulation part: the characters this zone
// owns now (the soak checker unions these across zones to prove nobody is
// owned twice or by nobody), standby and mirrored counts.
func (s *Server) ClusterView(ctx context.Context) (map[string]any, error) {
	var out map[string]any
	err := s.Do(ctx, func() {
		chars := make([]string, 0, len(s.sessions))
		for _, sess := range s.sessions {
			if sess.ent != nil {
				chars = append(chars, sess.ent.CharacterID)
			}
		}
		out = map[string]any{"tick": s.tick, "characters": chars, "standby": len(s.cl.standby), "remote": len(s.cl.remote), "pending": len(s.cl.pending)}
	})
	return out, err
}
