package social

import (
	"context"
	"fmt"
	"sort"
	"time"

	"lodestone/server/pkg/constants"
	sp "lodestone/server/pkg/socialproto"
)

// Friends, mute, block, filter and reports (spec 10).

// refreshFriends rebuilds and sends this session's friends list, and caches
// the accepted ids (whisper permission for local profiles). Called from the
// bus goroutine too, so it runs async to keep the bus moving.
func (s *Session) refreshFriends() {
	go func() {
		ctx, cancel := contextFor(s)
		defer cancel()
		rows, err := s.hub.store.Friends(ctx, s.charID)
		if err != nil {
			return
		}
		ids := make([]string, len(rows))
		for i, r := range rows {
			ids[i] = r.ID
		}
		names := s.hub.namesOf(ctx, s.worldID, ids)
		pres := s.hub.presenceOf(ctx, ids)
		list := make([]sp.Friend, 0, len(rows))
		accepted := map[string]bool{}
		for _, r := range rows {
			f := sp.Friend{CharacterID: r.ID, Name: orID(names[r.ID], r.ID), State: sp.FriendState(r.State)}
			// Online status and region only for accepted friends: a pending
			// request must not reveal where a stranger is.
			if r.State == string(sp.FriendStateAccepted) {
				accepted[r.ID] = true
				f.Online, f.Region = pres[r.ID].Online, pres[r.ID].Region
			}
			list = append(list, f)
		}
		sort.Slice(list, func(i, j int) bool {
			if list[i].Online != list[j].Online {
				return list[i].Online
			}
			return lower(list[i].Name) < lower(list[j].Name)
		})
		s.mu.Lock()
		s.friends = accepted
		s.mu.Unlock()
		s.send(sp.S2CFriends{Type: sp.S2CTypeFriends, Friends: list})
	}()
}

// notifyFriends tells everyone who lists charID (friend or request) to
// refresh, e.g. when charID comes online, goes offline or changes region.
func (h *Hub) notifyFriends(ctx context.Context, worldID, charID string) {
	rows, err := h.store.Friends(ctx, charID)
	if err != nil || len(rows) == 0 {
		return
	}
	ids := make([]string, 0, len(rows))
	for _, r := range rows {
		if r.State == string(sp.FriendStateAccepted) {
			ids = append(ids, r.ID)
		}
	}
	if len(ids) > 0 {
		h.publish(ctx, &envelope{Kind: kindFriends, World: worldID, Targets: ids})
	}
}

func (s *Session) friendRequest(ctx context.Context, name string) {
	targetID, targetName, ok := s.hub.resolveName(ctx, s.worldID, name)
	if !ok {
		s.sendErr(sp.ErrorCodeUnknownTarget, fmt.Sprintf("There is no one called %s.", trimTo(name, 32)))
		return
	}
	if targetID == s.charID {
		s.sendErr(sp.ErrorCodeNotAllowed, "You can't befriend yourself.")
		return
	}
	s.mu.Lock()
	iBlocked := s.blocked[targetID] != ""
	s.mu.Unlock()
	if iBlocked {
		s.sendErr(sp.ErrorCodeNotAllowed, fmt.Sprintf("You have blocked %s.", targetName))
		return
	}
	requester, state, exists, err := s.hub.store.FriendLink(ctx, s.charID, targetID)
	if err != nil {
		s.sendErr(sp.ErrorCodeInternal, "try again")
		return
	}
	switch {
	case exists && state == "accepted":
		s.system(fmt.Sprintf("%s is already your friend.", targetName))
		return
	case exists && requester == targetID:
		// They asked first: asking back is accepting.
		s.friendRespond(ctx, targetName, true)
		return
	case exists:
		s.system(fmt.Sprintf("Friend request to %s is pending.", targetName))
		return
	}
	for _, id := range []string{s.charID, targetID} {
		n, err := s.hub.store.CountFriends(ctx, id)
		if err != nil {
			s.sendErr(sp.ErrorCodeInternal, "try again")
			return
		}
		if n >= constants.FriendsMax {
			if id == s.charID {
				s.sendErr(sp.ErrorCodeNotAllowed, fmt.Sprintf("Friends lists hold %d players.", constants.FriendsMax))
			} else {
				s.sendErr(sp.ErrorCodeNotAllowed, fmt.Sprintf("%s's friends list is full.", targetName))
			}
			return
		}
	}
	// Blocked by the target: pretend it was sent (no probing for blocks).
	if blocked, err := s.hub.store.IsBlocked(ctx, targetID, s.charID); err == nil && blocked {
		s.system(fmt.Sprintf("Friend request sent to %s.", targetName))
		return
	}
	if err := s.hub.store.AddFriendRequest(ctx, s.worldID, s.charID, targetID); err != nil {
		s.sendErr(sp.ErrorCodeInternal, "try again")
		return
	}
	s.system(fmt.Sprintf("Friend request sent to %s.", targetName))
	s.hub.SystemMessage(ctx, s.worldID, targetID, fmt.Sprintf("%s sent you a friend request.", s.name))
	s.hub.publish(ctx, &envelope{Kind: kindFriends, World: s.worldID, Targets: []string{s.charID, targetID}})
}

func (s *Session) friendRespond(ctx context.Context, name string, accept bool) {
	otherID, otherName, ok := s.hub.resolveName(ctx, s.worldID, name)
	if !ok {
		s.sendErr(sp.ErrorCodeUnknownTarget, fmt.Sprintf("There is no one called %s.", trimTo(name, 32)))
		return
	}
	if accept {
		done, err := s.hub.store.AcceptFriend(ctx, otherID, s.charID)
		if err != nil {
			s.sendErr(sp.ErrorCodeInternal, "try again")
			return
		}
		if !done {
			s.sendErr(sp.ErrorCodeNotAllowed, fmt.Sprintf("No friend request from %s.", otherName))
			return
		}
		s.hub.SystemMessage(ctx, s.worldID, otherID, fmt.Sprintf("%s accepted your friend request.", s.name))
		s.system(fmt.Sprintf("You and %s are now friends.", otherName))
	} else {
		if _, err := s.hub.store.RemoveFriend(ctx, otherID, s.charID); err != nil {
			s.sendErr(sp.ErrorCodeInternal, "try again")
			return
		}
	}
	s.hub.publish(ctx, &envelope{Kind: kindFriends, World: s.worldID, Targets: []string{s.charID, otherID}})
}

func (s *Session) friendRemove(ctx context.Context, name string) {
	otherID, otherName, ok := s.hub.resolveName(ctx, s.worldID, name)
	if !ok {
		s.sendErr(sp.ErrorCodeUnknownTarget, fmt.Sprintf("There is no one called %s.", trimTo(name, 32)))
		return
	}
	removed, err := s.hub.store.RemoveFriend(ctx, s.charID, otherID)
	if err != nil {
		s.sendErr(sp.ErrorCodeInternal, "try again")
		return
	}
	if removed {
		s.system(fmt.Sprintf("Removed %s from your friends.", otherName))
	}
	s.hub.publish(ctx, &envelope{Kind: kindFriends, World: s.worldID, Targets: []string{s.charID, otherID}})
}

// relationOp handles block, unblock, mute and unmute.
func (s *Session) relationOp(ctx context.Context, typ, name string) {
	otherID, otherName, ok := s.hub.resolveName(ctx, s.worldID, name)
	if !ok {
		s.sendErr(sp.ErrorCodeUnknownTarget, fmt.Sprintf("There is no one called %s.", trimTo(name, 32)))
		return
	}
	if otherID == s.charID {
		s.sendErr(sp.ErrorCodeNotAllowed, "That's you.")
		return
	}
	var err error
	var note string
	switch typ {
	case sp.C2STypeBlock:
		err = s.hub.store.Block(ctx, s.charID, otherID)
		note = fmt.Sprintf("Blocked %s: you won't see their messages, whispers or invites.", otherName)
	case sp.C2STypeUnblock:
		err = s.hub.store.Unblock(ctx, s.charID, otherID)
		note = fmt.Sprintf("Unblocked %s.", otherName)
	case sp.C2STypeMute:
		err = s.hub.store.Mute(ctx, s.charID, otherID)
		note = fmt.Sprintf("Muted %s.", otherName)
	case sp.C2STypeUnmute:
		err = s.hub.store.Unmute(ctx, s.charID, otherID)
		note = fmt.Sprintf("Unmuted %s.", otherName)
	}
	if err != nil {
		s.sendErr(sp.ErrorCodeInternal, "try again")
		return
	}
	s.mu.Lock()
	switch typ {
	case sp.C2STypeBlock:
		s.blocked[otherID] = otherName
		delete(s.friends, otherID)
	case sp.C2STypeUnblock:
		delete(s.blocked, otherID)
	case sp.C2STypeMute:
		s.muted[otherID] = otherName
	case sp.C2STypeUnmute:
		delete(s.muted, otherID)
	}
	s.mu.Unlock()
	if s.hub.voice != nil {
		s.hub.voice.Nudge(s.worldID) // WP11: voice applies the block/mute now, not at the next refresh
	}
	s.sendRelations()
	s.system(note)
	if typ == sp.C2STypeBlock {
		// Block ended any friendship: both lists change.
		s.hub.publish(ctx, &envelope{Kind: kindFriends, World: s.worldID, Targets: []string{s.charID, otherID}})
	}
}

func (s *Session) setFilter(ctx context.Context, on bool) {
	if err := s.hub.store.SetFilter(ctx, s.charID, on); err != nil {
		s.sendErr(sp.ErrorCodeInternal, "try again")
		return
	}
	s.mu.Lock()
	s.filter = on
	s.mu.Unlock()
	s.sendRelations()
}

// report captures the last REPORT_CONTEXT_MESSAGES of the channel or
// whisper conversation into Postgres (spec 10). Context is raw text, from
// the shared history where there is one and from what this reader actually
// received for local chat (which keeps no shared history).
func (s *Session) report(ctx context.Context, m sp.C2SReport) {
	otherID, otherName, ok := s.hub.resolveName(ctx, s.worldID, m.Name)
	if !ok {
		s.sendErr(sp.ErrorCodeUnknownTarget, fmt.Sprintf("There is no one called %s.", trimTo(m.Name, 32)))
		return
	}
	n := int64(constants.ReportContextMessages)
	var msgs []sp.ChatMessage
	s.mu.Lock()
	region := s.region
	local := append([]sp.ChatMessage(nil), s.localRing...)
	s.mu.Unlock()
	switch m.Channel {
	case sp.ChannelGlobal:
		msgs = s.hub.readHistory(ctx, keyChat(s.worldID, sp.ChannelGlobal, ""), n)
	case sp.ChannelZone:
		msgs = s.hub.readHistory(ctx, keyChat(s.worldID, sp.ChannelZone, region), n)
	case sp.ChannelParty:
		if p, _ := s.hub.loadParty(ctx, s.charID); p != nil {
			msgs = s.hub.readHistory(ctx, keyChat(s.worldID, sp.ChannelParty, p.ID), n)
		}
	case sp.ChannelWhisper:
		msgs = s.hub.readHistory(ctx, keyChat(s.worldID, sp.ChannelWhisper, convScope(s.charID, otherID)), n)
	case sp.ChannelLocal:
		msgs = local
	case sp.ChannelSystem:
		msgs = s.hub.readHistory(ctx, keyChat(s.worldID, sp.ChannelSystem, s.charID), n)
	default:
		s.sendErr(sp.ErrorCodeNotAllowed, "unknown channel")
		return
	}
	if msgs == nil {
		msgs = []sp.ChatMessage{}
	}
	id, err := s.hub.store.InsertReport(ctx, Report{
		WorldID: s.worldID, Reporter: s.charID, ReporterName: s.name, Reported: otherID, ReportedName: otherName,
		Channel: string(m.Channel), Reason: trimTo(m.Reason, 500),
		Context: map[string]any{"region": region, "messages": msgs},
	})
	if err != nil {
		s.sendErr(sp.ErrorCodeInternal, "Report not saved; try again.")
		return
	}
	s.hub.metrics.Add("social_reports_total", 1)
	s.hub.log.Info("report", "id", id, "reporter", s.charID, "reported", otherID, "channel", m.Channel, "messages", len(msgs))
	s.system(fmt.Sprintf("Thanks. Your report about %s was sent to the moderators.", otherName))
}

func contextFor(s *Session) (context.Context, context.CancelFunc) {
	return context.WithTimeout(s.ctx, 10*time.Second)
}
