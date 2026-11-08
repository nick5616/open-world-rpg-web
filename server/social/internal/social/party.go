package social

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/accountapi"
	"lodestone/server/pkg/constants"
	sp "lodestone/server/pkg/socialproto"
)

// Parties (spec 10): up to PARTY_MAX, invite by name, leader kicks and
// promotes, leaving is instant, state in Redis surviving a member's
// reconnect for PARTY_RECONNECT_GRACE_S.
//
// Every change runs in a WATCH/MULTI transaction over the party record and
// the members' partyof pointers, retried on conflict (the-circle's
// claim_seat loop in room_state.py), because two processes may change the
// same party at once.

// inviteTTL: an unanswered invite lapses quietly after a minute.
const inviteTTL = 60 * time.Second

type partyMember struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type partyRecord struct {
	ID      string        `json:"id"`
	World   string        `json:"world"`
	Leader  string        `json:"leader"`
	Members []partyMember `json:"members"`
	Created int64         `json:"created"`
}

func (p *partyRecord) has(id string) bool {
	for _, m := range p.Members {
		if m.ID == id {
			return true
		}
	}
	return false
}

func (p *partyRecord) memberIDs() []string {
	out := make([]string, len(p.Members))
	for i, m := range p.Members {
		out[i] = m.ID
	}
	return out
}

func (p *partyRecord) remove(id string) {
	kept := p.Members[:0]
	for _, m := range p.Members {
		if m.ID != id {
			kept = append(kept, m)
		}
	}
	p.Members = kept
}

func (p *partyRecord) nameOf(id string) string {
	for _, m := range p.Members {
		if m.ID == id {
			return m.Name
		}
	}
	return ""
}

var errConflict = errors.New("party changed, retry")

func (h *Hub) loadPartyByID(ctx context.Context, pid string) (*partyRecord, error) {
	return readParty(ctx, h.rdb, pid)
}

type getter interface {
	Get(ctx context.Context, key string) *redis.StringCmd
}

func readParty(ctx context.Context, g getter, pid string) (*partyRecord, error) {
	if pid == "" {
		return nil, nil
	}
	b, err := g.Get(ctx, keyParty(pid)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var p partyRecord
	if err := json.Unmarshal(b, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

// loadParty returns charID's party, or nil.
func (h *Hub) loadParty(ctx context.Context, charID string) (*partyRecord, error) {
	pid, err := h.rdb.Get(ctx, keyPartyOf(charID)).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	p, err := h.loadPartyByID(ctx, pid)
	if p != nil && !p.has(charID) {
		return nil, nil // stale pointer
	}
	return p, err
}

// partyTx runs fn under WATCH on the given keys, retrying on conflict.
func (h *Hub) partyTx(ctx context.Context, keys []string, fn func(tx *redis.Tx) error) error {
	for i := 0; i < 20; i++ {
		err := h.rdb.Watch(ctx, fn, keys...)
		if errors.Is(err, redis.TxFailedErr) {
			continue
		}
		return err
	}
	return errConflict
}

func writeParty(ctx context.Context, pipe redis.Pipeliner, p *partyRecord) {
	b, _ := json.Marshal(p)
	pipe.Set(ctx, keyParty(p.ID), b, 0)
}

// publishPartyState sends the current party to all its members, with live
// online flags and regions from presence.
func (h *Hub) publishPartyState(ctx context.Context, worldID, pid string) {
	p, err := h.loadPartyByID(ctx, pid)
	if err != nil || p == nil {
		return
	}
	pres := h.presenceOf(ctx, p.memberIDs())
	members := make([]sp.PartyMember, len(p.Members))
	for i, m := range p.Members {
		pi := pres[m.ID]
		members[i] = sp.PartyMember{CharacterID: m.ID, Name: m.Name, Online: pi.Online, Region: pi.Region}
	}
	frame, _ := json.Marshal(sp.S2CPartyState{Type: sp.S2CTypePartyState, PartyID: p.ID, LeaderID: p.Leader, Members: members})
	h.publish(ctx, &envelope{Kind: kindFrame, World: worldID, Targets: p.memberIDs(), Frame: frame,
		Party: &partyRef{ID: p.ID, Members: p.memberIDs()}})
}

func (h *Hub) publishPartyLeft(ctx context.Context, worldID string, ids ...string) {
	frame, _ := json.Marshal(sp.S2CPartyLeft{Type: sp.S2CTypePartyLeft})
	h.publish(ctx, &envelope{Kind: kindFrame, World: worldID, Targets: ids, Frame: frame, Party: &partyRef{}})
}

func (s *Session) partyInvite(ctx context.Context, name string) {
	targetID, targetName, ok := s.hub.resolveName(ctx, s.worldID, name)
	if !ok {
		s.sendErr(sp.ErrorCodeUnknownTarget, fmt.Sprintf("There is no one called %s.", trimTo(name, 32)))
		return
	}
	if targetID == s.charID {
		s.sendErr(sp.ErrorCodeNotAllowed, "You can't invite yourself.")
		return
	}
	s.mu.Lock()
	iBlocked := s.blocked[targetID] != ""
	s.mu.Unlock()
	if iBlocked {
		s.sendErr(sp.ErrorCodeNotAllowed, fmt.Sprintf("You have blocked %s.", targetName))
		return
	}
	if n, _ := s.hub.rdb.Exists(ctx, keyPresence(targetID)).Result(); n == 0 {
		s.sendErr(sp.ErrorCodeUnknownTarget, fmt.Sprintf("%s is offline.", targetName))
		return
	}
	p, err := s.hub.loadParty(ctx, s.charID)
	if err != nil {
		s.sendErr(sp.ErrorCodeInternal, "try again")
		return
	}
	pid := ""
	if p != nil {
		if p.Leader != s.charID {
			s.sendErr(sp.ErrorCodeNotLeader, "Only the party leader can invite.")
			return
		}
		if len(p.Members) >= constants.PartyMax {
			s.sendErr(sp.ErrorCodePartyFull, fmt.Sprintf("Parties hold %d players.", constants.PartyMax))
			return
		}
		if p.has(targetID) {
			s.sendErr(sp.ErrorCodeNotAllowed, fmt.Sprintf("%s is already in your party.", targetName))
			return
		}
		pid = p.ID
	} else {
		// The party only exists once someone accepts; the id is reserved now
		// so the invite and the acceptance name the same party.
		pid = accountapi.NewUUID()
	}
	if other, _ := s.hub.loadParty(ctx, targetID); other != nil {
		s.sendErr(sp.ErrorCodeNotAllowed, fmt.Sprintf("%s is already in a party.", targetName))
		return
	}
	// Blocked by the target: no invite is delivered (spec 10), and like
	// whispers the inviter is not told.
	if blocked, err := s.hub.store.IsBlocked(ctx, targetID, s.charID); err == nil && blocked {
		s.system(fmt.Sprintf("Invited %s to your party.", targetName))
		return
	}
	pipe := s.hub.rdb.TxPipeline()
	pipe.HSet(ctx, keyPartyInv(targetID), pid, s.charID)
	pipe.Expire(ctx, keyPartyInv(targetID), inviteTTL)
	if _, err := pipe.Exec(ctx); err != nil {
		s.sendErr(sp.ErrorCodeInternal, "try again")
		return
	}
	frame, _ := json.Marshal(sp.S2CPartyInvite{Type: sp.S2CTypePartyInvite, PartyID: pid, FromName: s.name})
	s.hub.publish(ctx, &envelope{Kind: kindFrame, World: s.worldID, Targets: []string{targetID}, Frame: frame})
	s.system(fmt.Sprintf("Invited %s to your party.", targetName))
}

func (s *Session) partyRespond(ctx context.Context, pid string, accept bool) {
	inviter, err := s.hub.rdb.HGet(ctx, keyPartyInv(s.charID), pid).Result()
	if err != nil || inviter == "" {
		s.sendErr(sp.ErrorCodeNotAllowed, "That invite has expired.")
		return
	}
	s.hub.rdb.HDel(ctx, keyPartyInv(s.charID), pid)
	if !accept {
		s.hub.SystemMessage(ctx, s.worldID, inviter, fmt.Sprintf("%s declined your party invite.", s.name))
		return
	}
	inviterName := s.hub.namesOf(ctx, s.worldID, []string{inviter})[inviter]
	// Two invites sent before anyone accepted carry two reserved ids. Once
	// the first acceptance forms the inviter's party, later acceptances join
	// that party instead of failing with "inviter is busy".
	if p, _ := s.hub.loadPartyByID(ctx, pid); p == nil {
		if cur, _ := s.hub.loadParty(ctx, inviter); cur != nil && cur.Leader == inviter {
			pid = cur.ID
		}
	}
	var full, busy bool
	err = s.hub.partyTx(ctx, []string{keyParty(pid), keyPartyOf(s.charID), keyPartyOf(inviter)}, func(tx *redis.Tx) error {
		full, busy = false, false
		if cur, _ := tx.Get(ctx, keyPartyOf(s.charID)).Result(); cur != "" && cur != pid {
			if other, _ := readParty(ctx, tx, cur); other != nil && other.has(s.charID) {
				busy = true
				return nil
			}
		}
		p, err := readParty(ctx, tx, pid)
		if err != nil {
			return err
		}
		if p == nil {
			// First acceptance creates the party, led by the inviter, provided
			// the inviter has not joined another party meanwhile.
			if cur, _ := tx.Get(ctx, keyPartyOf(inviter)).Result(); cur != "" && cur != pid {
				if other, _ := readParty(ctx, tx, cur); other != nil && other.has(inviter) {
					busy = true
					return nil
				}
			}
			p = &partyRecord{ID: pid, World: s.worldID, Leader: inviter, Created: nowMs(),
				Members: []partyMember{{ID: inviter, Name: inviterName}}}
		}
		if p.has(s.charID) {
			return nil
		}
		if len(p.Members) >= constants.PartyMax {
			full = true
			return nil
		}
		p.Members = append(p.Members, partyMember{ID: s.charID, Name: s.name})
		_, err = tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
			writeParty(ctx, pipe, p)
			for _, m := range p.Members {
				pipe.Set(ctx, keyPartyOf(m.ID), p.ID, 0)
			}
			return nil
		})
		return err
	})
	switch {
	case err != nil:
		s.sendErr(sp.ErrorCodeInternal, "try again")
	case busy:
		s.sendErr(sp.ErrorCodeNotAllowed, "Leave your current party first.")
	case full:
		s.sendErr(sp.ErrorCodePartyFull, fmt.Sprintf("That party already has %d players.", constants.PartyMax))
	default:
		s.hub.publishPartyState(ctx, s.worldID, pid)
		s.sendHistory(ctx, sp.ChannelParty, pid, keyChat(s.worldID, sp.ChannelParty, pid), constants.HistoryParty)
	}
}

// removeFromParty takes charID out of its party: a leaving leader passes
// leadership to the first online member, and a party of one disbands.
// Returns the party id it left ("" if none).
func (h *Hub) removeFromParty(ctx context.Context, worldID, charID string) (string, error) {
	pid, err := h.rdb.Get(ctx, keyPartyOf(charID)).Result()
	if errors.Is(err, redis.Nil) || pid == "" {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	var remaining []string
	var disbanded bool
	err = h.partyTx(ctx, []string{keyParty(pid), keyPartyOf(charID)}, func(tx *redis.Tx) error {
		remaining, disbanded = nil, false
		p, err := readParty(ctx, tx, pid)
		if err != nil {
			return err
		}
		_, err = tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
			pipe.Del(ctx, keyPartyOf(charID))
			pipe.ZRem(ctx, keyPartyGrace(worldID), charID)
			if p == nil || !p.has(charID) {
				return nil
			}
			p.remove(charID)
			remaining = p.memberIDs()
			if len(p.Members) <= 1 {
				disbanded = true
				pipe.Del(ctx, keyParty(pid))
				for _, id := range remaining {
					pipe.Del(ctx, keyPartyOf(id))
					pipe.ZRem(ctx, keyPartyGrace(worldID), id)
				}
				return nil
			}
			if p.Leader == charID {
				p.Leader = p.Members[0].ID
				pres := h.presenceOf(ctx, remaining)
				for _, m := range p.Members {
					if pres[m.ID].Online {
						p.Leader = m.ID
						break
					}
				}
			}
			writeParty(ctx, pipe, p)
			return nil
		})
		return err
	})
	if err != nil {
		return "", err
	}
	h.publishPartyLeft(ctx, worldID, charID)
	if disbanded {
		if len(remaining) > 0 {
			h.publishPartyLeft(ctx, worldID, remaining...)
			for _, id := range remaining {
				h.SystemMessage(ctx, worldID, id, "Your party disbanded.")
			}
		}
	} else if len(remaining) > 0 {
		h.publishPartyState(ctx, worldID, pid)
	}
	return pid, nil
}

func (s *Session) partyLeave(ctx context.Context) {
	pid, err := s.hub.removeFromParty(ctx, s.worldID, s.charID)
	if err != nil {
		s.sendErr(sp.ErrorCodeInternal, "try again")
		return
	}
	if pid == "" {
		s.sendErr(sp.ErrorCodeNotAllowed, "You are not in a party.")
	}
}

// leaderTarget checks the caller leads a party containing name.
func (s *Session) leaderTarget(ctx context.Context, name string) (*partyRecord, string, bool) {
	p, err := s.hub.loadParty(ctx, s.charID)
	if err != nil || p == nil {
		s.sendErr(sp.ErrorCodeNotAllowed, "You are not in a party.")
		return nil, "", false
	}
	if p.Leader != s.charID {
		s.sendErr(sp.ErrorCodeNotLeader, "Only the party leader can do that.")
		return nil, "", false
	}
	for _, m := range p.Members {
		if lower(m.Name) == lower(name) && m.ID != s.charID {
			return p, m.ID, true
		}
	}
	s.sendErr(sp.ErrorCodeUnknownTarget, fmt.Sprintf("%s is not in your party.", trimTo(name, 32)))
	return nil, "", false
}

func (s *Session) partyKick(ctx context.Context, name string) {
	p, target, ok := s.leaderTarget(ctx, name)
	if !ok {
		return
	}
	targetName := p.nameOf(target)
	if _, err := s.hub.removeFromParty(ctx, s.worldID, target); err != nil {
		s.sendErr(sp.ErrorCodeInternal, "try again")
		return
	}
	s.hub.SystemMessage(ctx, s.worldID, target, "You were removed from the party.")
	s.system(fmt.Sprintf("Removed %s from the party.", targetName))
}

func (s *Session) partyPromote(ctx context.Context, name string) {
	p, target, ok := s.leaderTarget(ctx, name)
	if !ok {
		return
	}
	err := s.hub.partyTx(ctx, []string{keyParty(p.ID)}, func(tx *redis.Tx) error {
		cur, err := readParty(ctx, tx, p.ID)
		if err != nil || cur == nil {
			return err
		}
		if cur.Leader != s.charID || !cur.has(target) {
			return nil
		}
		cur.Leader = target
		_, err = tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error { writeParty(ctx, pipe, cur); return nil })
		return err
	})
	if err != nil {
		s.sendErr(sp.ErrorCodeInternal, "try again")
		return
	}
	s.hub.publishPartyState(ctx, s.worldID, p.ID)
}

// rejoinParty runs at auth: a member reconnecting within the grace period
// is still in the party; everyone sees them come back online.
func (s *Session) rejoinParty(ctx context.Context) {
	p, err := s.hub.loadParty(ctx, s.charID)
	if err != nil {
		return
	}
	if p == nil {
		s.hub.rdb.Del(ctx, keyPartyOf(s.charID))
		return
	}
	s.hub.publishPartyState(ctx, s.worldID, p.ID)
	s.sendHistory(ctx, sp.ChannelParty, p.ID, keyChat(s.worldID, sp.ChannelParty, p.ID), constants.HistoryParty)
}

// expireParties drops members whose grace period ran out while offline.
func (h *Hub) expireParties(ctx context.Context, worldID string) {
	due, err := h.rdb.ZRangeByScore(ctx, keyPartyGrace(worldID), &redis.ZRangeBy{Min: "-inf", Max: fmt.Sprint(nowMs())}).Result()
	if err != nil {
		return
	}
	for _, id := range due {
		// ZREM returning 1 elects this process to do the removal.
		if n, _ := h.rdb.ZRem(ctx, keyPartyGrace(worldID), id).Result(); n != 1 {
			continue
		}
		if online, _ := h.rdb.Exists(ctx, keyPresence(id)).Result(); online == 1 {
			continue // came back on another process
		}
		if pid, err := h.removeFromParty(ctx, worldID, id); err == nil && pid != "" {
			h.metrics.Add("social_party_grace_expired_total", 1)
			h.log.Info("party grace expired", "char", id, "party", pid)
		}
	}
}
