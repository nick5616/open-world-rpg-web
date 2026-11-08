package social

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/accountapi"
	"lodestone/server/pkg/constants"
	sp "lodestone/server/pkg/socialproto"
	"lodestone/server/pkg/ticket"
)

// outQueue bounds frames waiting for a slow client. History on join is the
// biggest burst (a few hundred messages in ~10 frames), so 256 frames is
// generous; a client that falls that far behind is dropped rather than
// allowed to grow our memory.
const outQueue = 256

// Session is one authenticated socket.
type Session struct {
	hub    *Hub
	c      *websocket.Conn
	id     string
	remote string
	out    chan []byte
	done   chan struct{}
	authed atomic.Bool

	ctx    context.Context
	cancel context.CancelFunc

	closeOnce sync.Once
	// cleanOffline: run the offline path (friends, party grace) on close.
	// False when a newer session for the same character replaced this one.
	cleanOffline atomic.Bool

	// Immutable after auth.
	charID, name, worldID string
	accountID, profileID  string
	local                 bool

	// Only the reader goroutine touches these.
	lim       limits
	lastLimit time.Time // throttles rate_limited errors to one per second

	mu              sync.Mutex
	region, zoneID  string
	x, z            float64
	hasPos          bool
	muted, blocked  map[string]string // char id -> name
	friends         map[string]bool   // accepted friends (whisper permission for local profiles)
	partyID         string
	partyMembers    map[string]bool
	filter          bool
	modMuted        bool
	lastWhisperFrom string
	localRing       []sp.ChatMessage // last REPORT_CONTEXT_MESSAGES local messages received (reports)
}

func newSession(h *Hub, c *websocket.Conn, remote string) *Session {
	ctx, cancel := context.WithCancel(h.ctx)
	s := &Session{hub: h, c: c, id: randHex(8), remote: remote, out: make(chan []byte, outQueue), done: make(chan struct{}),
		ctx: ctx, cancel: cancel, lim: newLimits(h.cfg.Limits), filter: true,
		muted: map[string]string{}, blocked: map[string]string{}, friends: map[string]bool{}, partyMembers: map[string]bool{}}
	s.cleanOffline.Store(true)
	return s
}

// run owns the connection until it closes.
func (s *Session) run() {
	defer close(s.done)
	go s.writer()
	if err := s.authenticate(); err != nil {
		s.hub.log.Info("auth failed", "remote", s.remote, "err", err)
		s.finish()
		return
	}
	go s.pinger()
	s.readLoop()
	s.finish()
}

func (s *Session) writer() {
	for {
		select {
		case <-s.ctx.Done():
			return
		case b := <-s.out:
			ctx, cancel := context.WithTimeout(s.ctx, 10*time.Second)
			err := s.c.Write(ctx, websocket.MessageText, b)
			cancel()
			if err != nil {
				s.cancel()
				return
			}
		}
	}
}

// pinger detects sockets that died without a close frame (laptop lid shut):
// adapted from 3d-portfolio-website multiplayer-server/server.mjs, which
// pings every 30 s and terminates sockets that never ponged.
func (s *Session) pinger() {
	t := time.NewTicker(s.hub.cfg.PingEvery)
	defer t.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-t.C:
			ctx, cancel := context.WithTimeout(s.ctx, s.hub.cfg.PingEvery/2)
			err := s.c.Ping(ctx)
			cancel()
			if err != nil {
				s.cancel()
				return
			}
		}
	}
}

// send marshals v and queues it. Never blocks: a full queue drops the client.
func (s *Session) send(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		s.hub.log.Error("marshal", "err", err)
		return
	}
	s.sendRaw(b)
}

func (s *Session) sendRaw(b []byte) {
	select {
	case <-s.ctx.Done():
	case s.out <- b:
	default:
		s.hub.metrics.Add("social_slow_client_drops_total", 1)
		s.hub.log.Warn("dropping slow client", "char", s.charID)
		s.cancel()
	}
}

func (s *Session) sendErr(code sp.ErrorCode, msg string) {
	s.send(sp.S2CError{Type: sp.S2CTypeError, Code: code, Message: msg})
}

func (s *Session) system(text string) {
	s.send(sp.S2CSystem{Type: sp.S2CTypeSystem, Text: text})
}

// closeWith sends a final error (if code != "") and closes the socket.
// offline=false skips the offline path (a newer session took over).
func (s *Session) closeWith(code sp.ErrorCode, msg string, offline bool) {
	s.closeOnce.Do(func() {
		if !offline {
			s.cleanOffline.Store(false)
		}
		if code != "" {
			// Written directly: the writer may already be gone.
			b, _ := json.Marshal(sp.S2CError{Type: sp.S2CTypeError, Code: code, Message: msg})
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			_ = s.c.Write(ctx, websocket.MessageText, b)
			cancel()
		}
		status := websocket.StatusNormalClosure
		if code == sp.ErrorCodeBadAuth || code == sp.ErrorCodeBanned {
			status = websocket.StatusPolicyViolation
		}
		if msg == "server restarting" {
			status = websocket.StatusGoingAway
		}
		go func() { _ = s.c.Close(status, msg) }()
		s.cancel()
	})
}

func (s *Session) authenticate() error {
	ctx, cancel := context.WithTimeout(s.ctx, s.hub.cfg.AuthTimeout)
	defer cancel()
	typ, b, err := s.c.Read(ctx)
	if err != nil {
		return err
	}
	var a sp.C2SAuth
	if typ != websocket.MessageText || json.Unmarshal(b, &a) != nil || a.Type != sp.C2STypeAuth {
		s.closeWith(sp.ErrorCodeBadAuth, "first message must be auth", true)
		return errors.New("no auth frame")
	}
	cl, err := ticket.Verify(s.hub.cfg.TicketPub, a.Ticket, ticket.AudienceSocial, time.Now())
	if err != nil {
		s.closeWith(sp.ErrorCodeBadAuth, "invalid or expired ticket", true)
		return err
	}
	// Relations are keyed by uuid character ids (migration 0003); anything
	// else cannot come from the director.
	if !accountapi.IsUUID(cl.CharacterID) || !accountapi.IsUUID(cl.WorldID) || cl.CharacterName == "" {
		s.closeWith(sp.ErrorCodeBadAuth, "ticket is missing character or world", true)
		return errors.New("bad claims")
	}
	s.charID, s.name, s.worldID = accountapi.NormalizeUUID(cl.CharacterID), cl.CharacterName, accountapi.NormalizeUUID(cl.WorldID)
	s.accountID, s.profileID, s.local = cl.AccountID, cl.ProfileID, cl.IsLocalProfile

	status, err := s.hub.store.Status(ctx, s.accountID, s.profileID)
	if err != nil {
		s.closeWith(sp.ErrorCodeInternal, "try again", true)
		return err
	}
	if status == "suspended" || status == "banned" {
		s.closeWith(sp.ErrorCodeBanned, "this account is "+status, true)
		return errors.New(status)
	}
	s.modMuted = status == "muted"

	if err := s.loadRelations(ctx); err != nil {
		s.closeWith(sp.ErrorCodeInternal, "try again", true)
		return err
	}

	// Duplicate login: newest wins, here and on any other process.
	if old := s.hub.register(s); old != nil {
		old.closeWith(sp.ErrorCodeReplaced, "signed in from another window", false)
	}
	s.hub.publish(ctx, &envelope{Kind: kindKick, World: s.worldID, Targets: []string{s.charID}, Keep: s.id})

	if err := s.goOnline(ctx); err != nil {
		s.hub.unregister(s)
		s.closeWith(sp.ErrorCodeInternal, "try again", true)
		return err
	}
	s.authed.Store(true)
	s.send(sp.S2CWelcome{Type: sp.S2CTypeWelcome, CharacterID: s.charID, Name: s.name, IsLocalProfile: s.local})
	s.sendRelations()
	s.sendJoinHistory(ctx)
	s.rejoinParty(ctx)
	s.refreshFriends()
	s.hub.notifyFriends(ctx, s.worldID, s.charID)
	if s.modMuted {
		s.system("You are muted by a moderator: you can read chat but not send.")
	}
	s.hub.log.Info("session", "char", s.charID, "name", s.name, "world", s.worldID, "local", s.local, "node", s.hub.node)
	return nil
}

// goOnline writes presence, the online entry and name records.
func (s *Session) goOnline(ctx context.Context) error {
	pipe := s.hub.rdb.TxPipeline()
	pipe.HSet(ctx, keyPresence(s.charID), map[string]any{
		"name": s.name, "world": s.worldID, "node": s.hub.node, "sid": s.id, "ts": nowMs(),
		"local": boolStr(s.local), "zone": "", "region": "",
	})
	pipe.Expire(ctx, keyPresence(s.charID), s.hub.cfg.PresenceTTL)
	pipe.HSet(ctx, keyOnline(s.worldID), s.charID, s.id)
	pipe.SAdd(ctx, keyWorlds, s.worldID)
	pipe.Set(ctx, keyName(s.worldID, s.name), s.charID, 0)
	pipe.Set(ctx, keyCharName(s.charID), s.name, 0)
	pipe.ZRem(ctx, keyPartyGrace(s.worldID), s.charID)
	_, err := pipe.Exec(ctx)
	return err
}

func boolStr(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

// finish runs once the read loop ends: clean presence (if we still own it)
// and the offline path.
func (s *Session) finish() {
	s.cancel()
	if !s.authed.Load() {
		_ = s.c.CloseNow()
		return
	}
	mine := s.hub.unregister(s)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	removed, _ := hdelIfEq.Run(ctx, s.hub.rdb, []string{keyOnline(s.worldID)}, s.charID, s.id).Int()
	_, _ = delPresenceIfSid.Run(ctx, s.hub.rdb, []string{keyPresence(s.charID)}, s.id).Result()
	if mine && removed == 1 && s.cleanOffline.Load() {
		s.hub.wentOffline(ctx, s.worldID, s.charID)
	}
	_ = s.c.CloseNow()
}

func (s *Session) readLoop() {
	for {
		typ, b, err := s.c.Read(s.ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			continue
		}
		now := time.Now()
		if !s.lim.frames.Take(now) {
			s.limited(now, sp.ErrorCodeRateLimited, "slow down")
			continue
		}
		var head struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(b, &head) != nil {
			continue
		}
		s.dispatch(head.Type, b, now)
	}
}

// limited sends a rate-limit error at most once per second, so a flood of
// refused messages does not turn into a flood of replies.
func (s *Session) limited(now time.Time, code sp.ErrorCode, msg string) {
	s.hub.metrics.Add(`social_chat_rejected_total{reason="`+string(code)+`"}`, 1)
	if now.Sub(s.lastLimit) < time.Second {
		return
	}
	s.lastLimit = now
	s.sendErr(code, msg)
}

func decode[T any](b []byte) (T, bool) {
	var v T
	return v, json.Unmarshal(b, &v) == nil
}

func (s *Session) dispatch(typ string, b []byte, now time.Time) {
	ctx, cancel := context.WithTimeout(s.ctx, 10*time.Second)
	defer cancel()
	switch typ {
	case sp.C2STypeChatSend:
		if m, ok := decode[sp.C2SChatSend](b); ok {
			s.chatSend(ctx, now, m.Channel, m.Text)
		}
	case sp.C2STypeWhisper:
		if m, ok := decode[sp.C2SWhisper](b); ok {
			s.whisper(ctx, now, m.To, m.Text)
		}
	case sp.C2STypeReply:
		if m, ok := decode[sp.C2SReply](b); ok {
			s.mu.Lock()
			to := s.lastWhisperFrom
			s.mu.Unlock()
			if to == "" {
				s.sendErr(sp.ErrorCodeUnknownTarget, "Nobody has whispered you yet.")
				return
			}
			s.whisper(ctx, now, to, m.Text)
		}
	case sp.C2STypePresence:
		if m, ok := decode[sp.C2SPresence](b); ok && s.lim.presence.Take(now) {
			s.presence(ctx, m)
		}
	case sp.C2STypePing:
		if m, ok := decode[sp.C2SPing](b); ok {
			s.send(sp.S2CPong{Type: sp.S2CTypePong, T: m.T, ServerTime: float64(nowMs())})
		}
	case sp.C2STypeVoiceToken:
		// Proximity voice (LiveKit) is a later package; say so plainly.
		s.sendErr(sp.ErrorCodeNotAllowed, "Voice is not available yet.")
	case sp.C2STypeReport:
		if m, ok := decode[sp.C2SReport](b); ok {
			if !s.lim.report.Take(now) {
				s.limited(now, sp.ErrorCodeRateLimited, "Too many reports; try again in a minute.")
				return
			}
			s.report(ctx, m)
		}
	default:
		if !socialOps[typ] {
			return
		}
		if !s.lim.social.Take(now) {
			s.limited(now, sp.ErrorCodeRateLimited, "slow down")
			return
		}
		s.socialOp(ctx, typ, b)
	}
}

var socialOps = map[string]bool{
	sp.C2STypePartyInvite: true, sp.C2STypePartyRespond: true, sp.C2STypePartyLeave: true,
	sp.C2STypePartyKick: true, sp.C2STypePartyPromote: true,
	sp.C2STypeFriendRequest: true, sp.C2STypeFriendRespond: true, sp.C2STypeFriendRemove: true,
	sp.C2STypeBlock: true, sp.C2STypeUnblock: true, sp.C2STypeMute: true, sp.C2STypeUnmute: true,
	sp.C2STypeSetFilter: true,
}

func (s *Session) socialOp(ctx context.Context, typ string, b []byte) {
	switch typ {
	case sp.C2STypePartyInvite:
		if m, ok := decode[sp.C2SPartyInvite](b); ok {
			s.partyInvite(ctx, m.Name)
		}
	case sp.C2STypePartyRespond:
		if m, ok := decode[sp.C2SPartyRespond](b); ok {
			s.partyRespond(ctx, m.PartyID, m.Accept)
		}
	case sp.C2STypePartyLeave:
		s.partyLeave(ctx)
	case sp.C2STypePartyKick:
		if m, ok := decode[sp.C2SPartyKick](b); ok {
			s.partyKick(ctx, m.Name)
		}
	case sp.C2STypePartyPromote:
		if m, ok := decode[sp.C2SPartyPromote](b); ok {
			s.partyPromote(ctx, m.Name)
		}
	case sp.C2STypeFriendRequest:
		if m, ok := decode[sp.C2SFriendRequest](b); ok {
			s.friendRequest(ctx, m.Name)
		}
	case sp.C2STypeFriendRespond:
		if m, ok := decode[sp.C2SFriendRespond](b); ok {
			s.friendRespond(ctx, m.Name, m.Accept)
		}
	case sp.C2STypeFriendRemove:
		if m, ok := decode[sp.C2SFriendRemove](b); ok {
			s.friendRemove(ctx, m.Name)
		}
	case sp.C2STypeBlock, sp.C2STypeUnblock, sp.C2STypeMute, sp.C2STypeUnmute:
		if m, ok := decode[sp.C2SBlock](b); ok { // all four share {name}
			s.relationOp(ctx, typ, m.Name)
		}
	case sp.C2STypeSetFilter:
		if m, ok := decode[sp.C2SSetFilter](b); ok {
			s.setFilter(ctx, m.Profanity)
		}
	}
}

// presence updates position, zone and region. A region change sends that
// region's zone history and tells friends and party (they show region).
func (s *Session) presence(ctx context.Context, m sp.C2SPresence) {
	region := trimTo(m.Region, 64)
	zone := trimTo(m.ZoneID, 64)
	s.mu.Lock()
	changed := region != s.region
	s.region, s.zoneID, s.x, s.z, s.hasPos = region, zone, m.X, m.Z, true
	pid := s.partyID
	s.mu.Unlock()
	s.hub.rdb.HSet(ctx, keyPresence(s.charID), "region", region, "zone", zone, "x", m.X, "z", m.Z)
	if changed {
		s.sendHistory(ctx, sp.ChannelZone, region, keyChat(s.worldID, sp.ChannelZone, region), constants.HistoryZone)
		s.hub.notifyFriends(ctx, s.worldID, s.charID)
		if pid != "" {
			s.hub.publishPartyState(ctx, s.worldID, pid)
		}
	}
}

func trimTo(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

// loadRelations reads mutes, blocks and the filter flag from Postgres.
func (s *Session) loadRelations(ctx context.Context) error {
	muted, blocked, filter, err := s.hub.store.Relations(ctx, s.charID)
	if err != nil {
		return err
	}
	names := s.hub.namesOf(ctx, s.worldID, append(append([]string{}, muted...), blocked...))
	s.mu.Lock()
	defer s.mu.Unlock()
	s.filter = filter
	s.muted, s.blocked = map[string]string{}, map[string]string{}
	for _, id := range muted {
		s.muted[id] = orID(names[id], id)
	}
	for _, id := range blocked {
		s.blocked[id] = orID(names[id], id)
	}
	return nil
}

func orID(name, id string) string {
	if name != "" {
		return name
	}
	return id
}

func (s *Session) sendRelations() {
	s.mu.Lock()
	m := sp.S2CRelations{Type: sp.S2CTypeRelations, Muted: sortedNames(s.muted), Blocked: sortedNames(s.blocked), ProfanityFilter: s.filter}
	s.mu.Unlock()
	s.send(m)
}

func sortedNames(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for _, n := range m {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

func (s *Session) setParty(p *partyRef) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.partyID = p.ID
	s.partyMembers = map[string]bool{}
	for _, id := range p.Members {
		s.partyMembers[id] = true
	}
}

// applyStatus reacts to an admin action while connected.
func (s *Session) applyStatus(status string) {
	switch status {
	case "suspended", "banned":
		s.closeWith(sp.ErrorCodeBanned, "this account is "+status, true)
	case "muted":
		s.mu.Lock()
		s.modMuted = true
		s.mu.Unlock()
		s.system("You are muted by a moderator: you can read chat but not send.")
	case "active":
		s.mu.Lock()
		was := s.modMuted
		s.modMuted = false
		s.mu.Unlock()
		if was {
			s.system("A moderator lifted your mute.")
		}
	}
}

func (s *Session) rememberLocal(m sp.ChatMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.localRing = append(s.localRing, m)
	if over := len(s.localRing) - constants.ReportContextMessages; over > 0 {
		s.localRing = append([]sp.ChatMessage(nil), s.localRing[over:]...)
	}
}

// presenceInfo is the subset of a presence hash other sessions read.
type presenceInfo struct {
	Online bool
	Name   string
	Region string
	Zone   string
	Local  bool
}

// presenceOf reads presence for many characters in one round trip.
func (h *Hub) presenceOf(ctx context.Context, ids []string) map[string]presenceInfo {
	out := make(map[string]presenceInfo, len(ids))
	if len(ids) == 0 {
		return out
	}
	pipe := h.rdb.Pipeline()
	cmds := make([]*redis.SliceCmd, len(ids))
	for i, id := range ids {
		cmds[i] = pipe.HMGet(ctx, keyPresence(id), "name", "region", "zone", "local")
	}
	_, _ = pipe.Exec(ctx)
	for i, id := range ids {
		v, err := cmds[i].Result()
		if err != nil || len(v) < 4 || v[0] == nil {
			continue
		}
		str := func(x any) string { s, _ := x.(string); return s }
		out[id] = presenceInfo{Online: true, Name: str(v[0]), Region: str(v[1]), Zone: str(v[2]), Local: str(v[3]) == "1"}
	}
	return out
}
