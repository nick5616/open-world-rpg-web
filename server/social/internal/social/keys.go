package social

import (
	"strings"

	sp "lodestone/server/pkg/socialproto"
)

// Redis key layout (spec 11, extended where a channel needs a sub-scope).
// Everything that names a channel stays under chat:{worldId}:{channel} so a
// KEYS/SCAN by world still finds it all.
//
//	presence:{charId}                      HASH  online session: name, world, zone, region, x, z, node, sid, ts (TTL PRESENCE_TTL_S)
//	online:{worldId}                       HASH  charId -> session id (what the reaper walks)
//	name:{worldId}:{lowercaseName}         STR   charId (no TTL: names never change)
//	charname:{charId}                      STR   display name (id -> name for ticket-only characters)
//	party:{partyId}                        STR   JSON partyRecord
//	partyof:{charId}                       STR   partyId
//	partyinv:{charId}                      HASH  partyId -> inviter charId (TTL 60 s)
//	partygrace:{worldId}                   ZSET  charId -> unix ms deadline (offline members, PARTY_RECONNECT_GRACE_S)
//	chat:{worldId}:global                  LIST  last HISTORY_GLOBAL messages
//	chat:{worldId}:zone:{region}           LIST  last HISTORY_ZONE
//	chat:{worldId}:party:{partyId}         LIST  last HISTORY_PARTY
//	chat:{worldId}:whisper:{idA}:{idB}     LIST  last HISTORY_WHISPER, ids sorted, 24 h
//	chat:{worldId}:system:{charId}         LIST  last HISTORY_SYSTEM
//	whisperconv:{worldId}:{charId}         ZSET  partnerId -> last message ms (24 h)
//	social:worlds                          SET   worlds with live sessions (reaper scope)
//	pub/sub social:{worldId}               cross-process delivery (bus.go)

func keyPresence(charID string) string    { return "presence:" + charID }
func keyOnline(worldID string) string     { return "online:" + worldID }
func keyName(worldID, name string) string { return "name:" + worldID + ":" + strings.ToLower(name) }
func keyCharName(charID string) string    { return "charname:" + charID }
func keyParty(partyID string) string      { return "party:" + partyID }
func keyPartyOf(charID string) string     { return "partyof:" + charID }
func keyPartyInv(charID string) string    { return "partyinv:" + charID }
func keyPartyGrace(worldID string) string { return "partygrace:" + worldID }
func keyWhisperConv(worldID, charID string) string {
	return "whisperconv:" + worldID + ":" + charID
}

const keyWorlds = "social:worlds"

// Channel returns the pub/sub channel for a world.
func Channel(worldID string) string { return "social:" + worldID }

func keyChat(worldID string, ch sp.Channel, scope string) string {
	k := "chat:" + worldID + ":" + string(ch)
	if scope != "" {
		k += ":" + scope
	}
	return k
}

// convScope orders two character ids so both sides name the same list.
func convScope(a, b string) string {
	if a > b {
		a, b = b, a
	}
	return a + ":" + b
}
