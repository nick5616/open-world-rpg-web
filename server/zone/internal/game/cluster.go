package game

// Multiple zones (WP16, spec 9 "Zones and handoff", spec 11, spec 13): the
// types the simulation shares with the multi-zone plumbing, and the wire
// formats zones use among themselves. The plumbing itself (Redis pub/sub,
// keys, the registry poll) lives in server/zone/internal/cluster; tests use
// an in-memory hub (cluster_test.go). Decisions: docs/decisions/0016-handoff.md.
//
// Nothing here is the client protocol (contracts/protocol.yaml): these are
// zone-to-zone messages inside one deployment, versioned by their first
// byte (ghost frames) or a JSON shape (control messages, handoff state).

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"time"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/localsave"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/snapshot"
	"lodestone/server/pkg/ticket"
	"lodestone/server/pkg/zoneregistry"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/explore"
)

// Cluster is the multi-zone plumbing. Config.Cluster == nil means a single
// zone owning the whole world: every WP16 code path is then skipped and the
// zone behaves exactly as before.
//
// Every method may block on the network. The simulation calls them only
// from its own worker goroutines (handoff.go) and from connection
// goroutines, never from the tick.
type Cluster interface {
	// Send delivers a control message to one zone (pub/sub zone:{zoneId}).
	Send(ctx context.Context, zoneID string, msg []byte) error
	// Broadcast publishes a ghost frame to every zone of the world (the
	// sender ignores its own).
	Broadcast(ctx context.Context, frame []byte) error
	// Recv delivers control messages addressed to this zone and every
	// zone's ghost frames.
	Recv() <-chan ClusterMsg
	// Put stores a value with a TTL; Take reads and deletes it atomically
	// (nil, nil when missing): handoff records are consumed exactly once.
	Put(ctx context.Context, key string, val []byte, ttl time.Duration) error
	Take(ctx context.Context, key string) ([]byte, error)
	// Swap sets key and returns the previous value (nil when none);
	// DelIf deletes key only while it still holds val.
	Swap(ctx context.Context, key string, val []byte, ttl time.Duration) ([]byte, error)
	DelIf(ctx context.Context, key string, val []byte) error
	// EntityID is the world-stable entity id of a character (the same on
	// every zone, so observers keep one track across a handoff).
	EntityID(ctx context.Context, characterID string) (uint32, error)
	// WritePresence / ReadPresence: the world presence feed (spec 11
	// worldpos:{worldId}), field = character id.
	WritePresence(ctx context.Context, put map[string][]byte, del []string) error
	ReadPresence(ctx context.Context) (map[string][]byte, error)
	// Owners is the latest region ownership table (nil until the first
	// registry read). Cheap; safe from any goroutine.
	Owners() *Owners
}

// ClusterMsg is one delivery from Cluster.Recv.
type ClusterMsg struct {
	Ghost bool // a ghost frame (Broadcast) rather than a control message
	Data  []byte
}

// ZoneInfo is where clients reach a zone.
type ZoneInfo struct {
	ID, Endpoint, WTEndpoint string
}

// Owners is the region -> owning zone table, computed from the live
// registry with zoneregistry.Owner (every zone computes the same one).
type Owners struct {
	Self   string
	Region [constants.WorldRegions][constants.WorldRegions]string // [x][z] zone id, "" = nobody
	Zones  map[string]ZoneInfo
	At     time.Time
}

// OwnersFrom builds the table from live registry entries.
func OwnersFrom(self string, live []zoneregistry.Entry, now time.Time) *Owners {
	o := &Owners{Self: self, Zones: map[string]ZoneInfo{}, At: now}
	for _, e := range live {
		o.Zones[e.ZoneID] = ZoneInfo{ID: e.ZoneID, Endpoint: e.Endpoint, WTEndpoint: e.WTEndpoint}
	}
	for x := 0; x < constants.WorldRegions; x++ {
		for z := 0; z < constants.WorldRegions; z++ {
			if e, ok := zoneregistry.Owner(live, zoneregistry.Region{X: x, Z: z}); ok {
				o.Region[x][z] = e.ZoneID
			}
		}
	}
	return o
}

// OwnerAt returns the owner of the region containing (x, z).
func (o *Owners) OwnerAt(x, z float64) string {
	r := zoneregistry.RegionAt(x, z)
	return o.Region[r.X][r.Z]
}

// NearestForeign returns the closest region owned by a zone other than not
// (and not unowned), with its owner and the horizontal distance from (x, z)
// to that region (0 when standing in it). With not = the zone owning (x, z)
// it is the distance to the nearest border with another zone; with not =
// another zone, how deep (x, z) lies inside that zone's territory.
func (o *Owners) NearestForeign(x, z float64, not string) (zone string, dist float64) {
	size := zoneregistry.RegionSizeM
	dist = math.Inf(1)
	for rx := 0; rx < constants.WorldRegions; rx++ {
		for rz := 0; rz < constants.WorldRegions; rz++ {
			id := o.Region[rx][rz]
			if id == "" || id == not {
				continue
			}
			x0, z0 := float64(rx)*size, float64(rz)*size
			dx := math.Max(0, math.Max(x0-x, x-(x0+size)))
			dz := math.Max(0, math.Max(z0-z, z-(z0+size)))
			if d := math.Hypot(dx, dz); d < dist {
				zone, dist = id, d
			}
		}
	}
	return zone, dist
}

// ---- control messages (pub/sub zone:{zoneId}, JSON, a few per handoff) ----

// Control message types.
const (
	ctlReady    = "ready"    // sender holds a standby session for C: C can be transferred to it
	ctlUnready  = "unready"  // that standby is gone
	ctlTransfer = "transfer" // C's state is at key K: admit it (sender keeps a standby for C)
	ctlRelease  = "release"  // C logged in on the sender: hand C's live state over (duplicate login across zones)
	ctlNone     = "none"     // answer to release: C isn't live here
	// Building doors (doors_sync.go): the zone owning a door's position is
	// its authority. Door/DoorNo carry the asking character (or "" for an
	// NPC); DoorSet has none.
	ctlDoor    = "door"    // to the owner: please open (A 1) / close (A 2) door D for player By
	ctlDoorNo  = "doorno"  // owner -> asker: refused, A = Event 972 reason
	ctlDoorSet = "doorset" // owner -> every zone: door D is now open (A 1) / closed (A 2)
)

type ctlMsg struct {
	T    string `json:"t"`
	From string `json:"f"`
	Char string `json:"c"`
	Key  string `json:"k,omitempty"`
	// Doors (ctlDoor*): the door prop's stable id, the action or state, who.
	Door uint64 `json:"d,omitempty"`
	A    int    `json:"a,omitempty"`
	By   uint32 `json:"b,omitempty"`
}

func (m ctlMsg) encode() []byte { b, _ := json.Marshal(m); return b }

func decodeCtl(b []byte) (ctlMsg, error) {
	var m ctlMsg
	err := json.Unmarshal(b, &m)
	door := m.T == ctlDoor || m.T == ctlDoorNo || m.T == ctlDoorSet
	if err == nil && (m.T == "" || (m.Char == "" && !door)) {
		err = errors.New("control message without type or character")
	}
	return m, err
}

// ---- handoff state (a Put/Take record, JSON) ----

// HandoffState is everything the next owner needs to continue a character
// exactly where the last one stopped (spec 9: "ownership transfers when
// they cross"; spec 11: reads happen on login and zone transfer). The
// movement state round-trips bit-exactly (encoding/json writes the shortest
// float64 text that parses back to the same bits), which is what keeps the
// client's prediction agreeing across the switch.
type HandoffState struct {
	Claims    handoffClaims    `json:"claims"`
	From      string           `json:"from"`
	AtMs      int64            `json:"atMs"`
	Epoch     int64            `json:"epoch"` // checkpoint fence of the sender (persist.go)
	EntityID  uint32           `json:"entityId"`
	Move      movement.State   `json:"move"`
	Prev      movement.State   `json:"prev"` // last state that passed validation
	View      movement.State   `json:"view"` // observers' extrapolated view (WP06), continued as is
	Guess     int              `json:"guess"`
	Yaw       float64          `json:"yaw"`
	Pitch     float64          `json:"pitch"`
	LastSeq   uint32           `json:"lastSeq"`
	LastFrame proto.InputFrame `json:"lastFrame"`
	Level     uint8            `json:"level"`
	// CaveSys is the cave system the player stands in (-1 surface): the
	// new owner admits mid-tick, after its caveTick, and interest clipping
	// and the earshot cave rule (G3) read it before the next one.
	CaveSys   int    `json:"caveSys"`
	Health    uint16 `json:"health"`
	HealthMax uint16 `json:"healthMax"`
	// WP13 combat: profile (loadouts, skills, known spells) plus the runtime
	// state (health, mana, cooldowns in input seqs, tick timers as time left).
	Combat *combat.PlayerHandoff `json:"combat,omitempty"`
	// WP12 exploration (nil Progress: none).
	Progress   *explore.Progress `json:"progress,omitempty"`
	ReadOnly   bool              `json:"readOnly,omitempty"`
	Local      *localSaveJSON    `json:"local,omitempty"`
	LastTravel int64             `json:"lastTravelMs,omitempty"`
	PartyKey   string            `json:"partyKey,omitempty"`
	// Ext carries state of packages that register a HandoffField (WP13
	// combat, WP14 items...), keyed by field name.
	Ext map[string]json.RawMessage `json:"ext,omitempty"`
}

type handoffClaims struct {
	AccountID     string `json:"a,omitempty"`
	ProfileID     string `json:"p,omitempty"`
	CharacterID   string `json:"c"`
	CharacterName string `json:"n"`
	WorldID       string `json:"w"`
	Local         bool   `json:"l,omitempty"`
}

func claimsJSON(c ticket.Claims) handoffClaims {
	return handoffClaims{AccountID: c.AccountID, ProfileID: c.ProfileID, CharacterID: c.CharacterID, CharacterName: c.CharacterName, WorldID: c.WorldID, Local: c.IsLocalProfile}
}

func (h handoffClaims) claims(zoneID string) ticket.Claims {
	return ticket.Claims{AccountID: h.AccountID, ProfileID: h.ProfileID, CharacterID: h.CharacterID, CharacterName: h.CharacterName,
		WorldID: h.WorldID, IsLocalProfile: h.Local, Audience: ticket.AudienceZone(zoneID)}
}

type localSaveJSON struct {
	ProfileID string          `json:"profileId"`
	State     localsave.State `json:"state"`
}

// HandoffField lets another package carry its per-character state across a
// handoff: Save runs on the old owner's tick when the character leaves,
// Load on the new owner's tick when it arrives (before Welcome). Register
// from an init function; names must be unique.
type HandoffField struct {
	Name string
	Save func(s *Server, e *Entity) json.RawMessage
	Load func(s *Server, e *Entity, data json.RawMessage)
}

var handoffFields []HandoffField

// RegisterHandoffField adds f (call from init).
func RegisterHandoffField(f HandoffField) { handoffFields = append(handoffFields, f) }

// tokenRecord is a pre-connect token's record: who may connect to To with
// it (the old owner From verified their ticket), single use, 60 s.
type tokenRecord struct {
	Claims handoffClaims `json:"claims"`
	From   string        `json:"from"`
	To     string        `json:"to"`
}

// HandoffTicketPrefix marks a Hello ticket that is a pre-connect token (a
// ZoneTransfer's ticket), not a director-signed connect ticket.
const HandoffTicketPrefix = "ho1."

func randomToken() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// Keys (the Cluster implementation namespaces them by world).
func tokenKey(tok string) string  { return "hotoken:" + tok }
func stateKey(id string) string   { return "hostate:" + id }
func ownerKey(char string) string { return "owner:" + char }

// ---- ghost frames (Broadcast, binary, every tick) ----

// ghostVersion is the first byte of a ghost frame.
const ghostVersion = 1

// ghostRec is one mirrored entity: its wire state plus the moment (source
// server time) it describes, so receivers can place it on their own clock.
type ghostRec struct {
	snapshot.EntState
	T float64 // source server time (ms) of this state
}

type ghostFrame struct {
	Zone string
	Recs []ghostRec
	Gone []uint32 // entities that left the source zone for good (logout)
}

func writeEnt(w *proto.Writer, r *ghostRec) {
	q := &r.EntState
	w.U32(q.ID)
	w.U8(uint8(q.Kind))
	w.F64(r.T)
	w.I32(q.X)
	w.I32(q.Y)
	w.I32(q.Z)
	w.I16(q.Vx)
	w.I16(q.Vy)
	w.I16(q.Vz)
	w.U8(q.Yaw)
	w.U8(q.Pitch)
	w.U8(q.HealthPct)
	w.U8(q.Activity)
	w.U16(q.TypeID)
	w.Str(q.Name)
	w.U8(q.Level)
	w.U32(q.PartyID)
}

func readEnt(r *proto.Reader) ghostRec {
	var g ghostRec
	q := &g.EntState
	q.ID = r.U32()
	q.Kind = proto.EntityKind(r.U8())
	g.T = r.F64()
	q.X, q.Y, q.Z = r.I32(), r.I32(), r.I32()
	q.Vx, q.Vy, q.Vz = r.I16(), r.I16(), r.I16()
	q.Yaw, q.Pitch, q.HealthPct, q.Activity = r.U8(), r.U8(), r.U8(), r.U8()
	q.TypeID = r.U16()
	q.Name = r.Str()
	q.Level = r.U8()
	q.PartyID = r.U32()
	return g
}

func encodeGhosts(w *proto.Writer, f *ghostFrame) []byte {
	w.Reset()
	w.U8(ghostVersion)
	w.Str(f.Zone)
	w.U16(uint16(len(f.Recs)))
	for i := range f.Recs {
		writeEnt(w, &f.Recs[i])
	}
	w.U16(uint16(len(f.Gone)))
	for _, id := range f.Gone {
		w.U32(id)
	}
	return append([]byte(nil), w.B...)
}

func decodeGhosts(b []byte) (ghostFrame, error) {
	var f ghostFrame
	if len(b) == 0 || b[0] != ghostVersion {
		return f, errors.New("ghost frame: unknown version")
	}
	r := proto.Reader{B: b, Off: 1}
	f.Zone = r.Str()
	n := r.Count()
	for i := 0; i < n && r.Err == nil; i++ {
		f.Recs = append(f.Recs, readEnt(&r))
	}
	n = r.Count()
	for i := 0; i < n && r.Err == nil; i++ {
		f.Gone = append(f.Gone, r.U32())
	}
	return f, r.Err
}

// Presence records (worldpos:{worldId}) reuse the entity encoding plus the
// owning zone: spec 11 "every player's position at 1 Hz for the far ring
// across zones".
func encodePresence(zone string, r *ghostRec) []byte {
	var w proto.Writer
	w.U8(ghostVersion)
	w.Str(zone)
	writeEnt(&w, r)
	return w.B
}

func decodePresence(b []byte) (zone string, g ghostRec, err error) {
	if len(b) == 0 || b[0] != ghostVersion {
		return "", g, errors.New("presence: unknown version")
	}
	r := proto.Reader{B: b, Off: 1}
	zone = r.Str()
	g = readEnt(&r)
	return zone, g, r.Err
}
