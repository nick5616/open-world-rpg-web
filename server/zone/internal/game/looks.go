package game

// Character looks (pt3 title + creation, CR 047): the build, skin, hair,
// beard and eyes a player chose at creation. They are cosmetic, never change
// while a character is in a zone, and live in the character's stored
// appearance JSON ({"v":1,"look":{...}}: characters.appearance for accounts,
// the signed save state for local profiles), read once at login.
//
// Replication rides the existing Interact + Event path (not the snapshot:
// EntityRecord's u16 mask is full and `appearance` has 2 free bits for the 18
// a look needs): a client that sees a player entity asks once with Interact
// 91 (targetId = the entity id) and the zone answers that client alone with
// Event 1900 (entityId = the player, value = the packed look). Old clients
// never ask and ignore the event; an old zone ignores the Interact. Nothing
// is sent per tick.
//
// Packed look (value, 19 bits, 0 = no look stored): bit 18 set, then
// build (2 bits at 0), skin (3 at 2), hairStyle (3 at 5), hairColor (4 at 8),
// beard (3 at 12), eyes (3 at 15). The client twin is client/src/net/look.ts.

import (
	"context"
	"encoding/json"
	"time"

	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/ratelimit"
)

// Interact 91 `look` and Event 1900 (contracts/events.md).
const (
	InteractLook = 91
	EventLook    = 1900

	LookActAsk = 1 // targetId = the player's entity id
)

// Option counts (client/src/net/look.ts tables): a decoded field is clamped to count-1.
var lookLimits = [6]int{3, 6, 6, 10, 5, 6}

const lookShifts = "\x00\x02\x05\x08\x0c\x0f"

// PackLook packs the stored appearance JSON; 0 when it carries no look.
func PackLook(appearance []byte) uint32 {
	if len(appearance) < 8 {
		return 0
	}
	var a struct {
		Look *struct {
			Build     *int `json:"build"`
			Skin      *int `json:"skin"`
			HairStyle *int `json:"hairStyle"`
			HairColor *int `json:"hairColor"`
			Beard     *int `json:"beard"`
			Eyes      *int `json:"eyes"`
		} `json:"look"`
	}
	if json.Unmarshal(appearance, &a) != nil || a.Look == nil {
		return 0
	}
	fields := [6]*int{a.Look.Build, a.Look.Skin, a.Look.HairStyle, a.Look.HairColor, a.Look.Beard, a.Look.Eyes}
	def := [6]int{1, 2, 2, 1, 0, 0} // the client's DEFAULT_LOOK for a missing field
	v := uint32(1) << 18
	for i, f := range fields {
		n := def[i]
		if f != nil {
			n = min(max(*f, 0), lookLimits[i]-1)
		}
		v |= uint32(n) << lookShifts[i]
	}
	return v
}

// LookStore is the optional account-side read (PGStore implements it).
type LookStore interface {
	LoadAppearance(ctx context.Context, characterID string) ([]byte, error)
}

// lookState is a session's limiter for Interact 91 (a burst for walking into
// a crowd, then a few a second).
type lookState struct{ bucket ratelimit.Bucket }

// lookInteract answers one client's question (tick goroutine).
func (s *Server) lookInteract(sess *session, m *proto.Interact, now time.Time) {
	if m.Action != LookActAsk || sess.ent == nil {
		return
	}
	if sess.looks == nil {
		sess.looks = &lookState{bucket: ratelimit.New(24, 6)}
	}
	if !sess.looks.bucket.Take(now) {
		return
	}
	t := s.entityByID(uint32(m.TargetID))
	if t == nil || t.Kind != proto.EntityKindPlayer || t.x == nil || t.x.look == 0 {
		return
	}
	s.sendEvent(sess, &proto.Event{Kind: EventLook, EntityID: t.ID, Value: int32(t.x.look)})
}
