// Package quests is the zone's quest log (playtest 1, CR 013): accepted
// bounties (WP20's board and bounty keeper), the starter story quest "Ward
// against the night" and anything else built from steps of objectives, with
// map markers for every step. Pure and tick-safe: no I/O, clocks or
// goroutines. The glue to sessions, Events, rewards, persistence and the
// handoff is internal/game/quests.go.
//
// A quest is a list of steps; exactly one step is current. A step has one
// objective (talk to an NPC role in a settlement, hold items, reach a place,
// know a spell, clear the enemies at a site, kill a demon near a site, hand
// items in at a settlement, kill a number of one enemy family) and the markers the map and compass show while
// it is current. Steps whose objective already holds when they become
// current complete at once (a player who already mined the ore skips to the
// blueprint). Everything a quest needs is stored in the log itself (the
// board changes daily, the world doesn't change under a quest), so a saved
// log is self-contained.
package quests

import (
	"encoding/json"
	"errors"
	"math"
	"slices"
)

// Objective kinds.
const (
	ObjTalk   = "talk"   // talk to an NPC of Role in Settlement
	ObjHave   = "have"   // hold any one of Items (alternatives)
	ObjReach  = "reach"  // stand within R of (X, Z)
	ObjKnow   = "know"   // know Spell
	ObjClear  = "clear"  // the enemies at Site (within R of X, Z) are dead
	ObjSlay   = "slay"   // kill a demon within R of (X, Z)
	ObjTurnIn = "turnin" // hand Items[0] in at Settlement's board or bounty keeper
	// Playtest 2 content (CR 022).
	ObjKill    = "kill"    // kill N non-demon enemies (of Family, if set) within R of (X, Z); Quest.Count counts
	ObjGive    = "give"    // talk to NPC (Role/Settlement, NPC if set) holding Items[0]: they take it
	ObjEscort  = "escort"  // stand within R of (X, Z) with the quest's follower close by (Escorter)
	ObjRead    = "read"    // read the lore tablet at atlas Site
	ObjAttune  = "attune"  // attune to any tower crystal
	ObjDungeon = "dungeon" // clear the sealed vault at atlas Site (its keeper falls with you near)
	// Playtest 2 main story (CR 035).
	ObjLevel = "level" // reach character level N (Leveler)
	ObjStory = "story" // a story happening named Family (the vigil held, the Sovereign or the Hush fallen)
	// Playtest 4 first hour (CR 051).
	ObjDo = "do" // do the deed named Family N times (mine, fell, smelt, build, torch, fish, steed); Quest.Count counts
)

// Quest kinds (Event 950 `kind`).
const (
	KindBounty = 0 // a settlement's bounty board / bounty keeper
	KindStory  = 1 // the starter line and other authored quests
	KindSide   = 2 // playtest 2 content: a townsperson's request (CR 022)
	KindMain   = 3 // playtest 2 main story (CR 035): one quest per act, keys "story:main:<act>"
)

// Limits.
const (
	MaxBounties = 5  // WP20's rule: at most five bounties held
	MaxActive   = 12 // bounties + story quests + side quests
	MaxSide     = 6  // CR 022: townsfolk requests held at once
	maxDone     = 64 // remembered completions (today's bounties, finished stories)
)

// Errors returned by Add.
var (
	ErrTooMany = errors.New("quest log full")
	ErrHave    = errors.New("quest already active")
	ErrDone    = errors.New("quest already completed")
	ErrEmpty   = errors.New("quest has no steps")
)

// ItemQty is an item key (contracts/items.yaml) and a quantity.
type ItemQty struct {
	Item string `json:"item"`
	Qty  int    `json:"qty"`
}

// Marker is a place the map and compass show for a step. R > 0 is an area
// (a circle of that radius: "somewhere in here"), 0 a point.
type Marker struct {
	X     float64 `json:"x"`
	Z     float64 `json:"z"`
	R     float64 `json:"r,omitempty"`
	Label string  `json:"label"`
}

// Objective is what completes a step.
type Objective struct {
	Kind       string    `json:"kind"`
	Role       int       `json:"role,omitempty"`
	Settlement int       `json:"settlement"`
	Items      []ItemQty `json:"items,omitempty"`
	Spell      string    `json:"spell,omitempty"`
	Site       int       `json:"site"`
	// CR 022: NPC is the towns-buffer NPC index + 1 a talk/give step wants
	// (0: anyone of Role in Settlement); N a kill count; Family the combat
	// family kills must be of ("" any non-demon).
	NPC    int     `json:"npc,omitempty"`
	N      int     `json:"n,omitempty"`
	Family string  `json:"family,omitempty"`
	X      float64 `json:"x,omitempty"`
	Z      float64 `json:"z,omitempty"`
	R      float64 `json:"r,omitempty"`
}

// Step is one stage of a quest.
type Step struct {
	Text    string    `json:"text"`           // the objective in a line ("Mine 4 sunsteel ore")
	Note    string    `json:"note,omitempty"` // where/how, shown under it
	Say     string    `json:"say,omitempty"`  // what the NPC says when a talk step completes
	Obj     Objective `json:"obj"`
	Markers []Marker  `json:"markers,omitempty"`
	Grant   []ItemQty `json:"grant,omitempty"` // handed over when the step completes
}

// Quest is one entry of the log.
type Quest struct {
	ID         uint32 `json:"id"`
	Key        string `json:"key"` // "bounty:<settlement>:<id>", "story:ward"
	Kind       uint8  `json:"kind"`
	Title      string `json:"title"`
	Giver      string `json:"giver"`
	Settlement int    `json:"settlement"`
	Step       int    `json:"step"`
	Steps      []Step `json:"steps"`
	Gold       int    `json:"gold"`
	XP         int64  `json:"xp"`
	Accepted   int64  `json:"accepted"` // unix ms
	// Progress is the current step's count (have/turn-in: units held), for
	// the HUD only; the objective is re-evaluated, never trusted from here.
	Progress int `json:"progress,omitempty"`
	// Count is a kill step's kills so far (CR 022; saved: kills are events,
	// not state that can be re-read).
	Count int `json:"count,omitempty"`
	// CR 022 rewards beyond gold and XP: items handed over at the end,
	// equipment rolls (story quests) and reputation with Settlement.
	Items     []ItemQty `json:"items,omitempty"`
	RollItems int       `json:"rollItems,omitempty"`
	Rep       int       `json:"rep,omitempty"`
	// CR 022 side quests: the giver's towns-buffer NPC index + 1 and their
	// sequence number (finishing it brings the giver's next offer).
	GiverNPC int `json:"giverNpc,omitempty"`
	Seq      int `json:"seq,omitempty"`
	// Start (CR 022) is handed over when the quest is accepted (a
	// delivery's parcel).
	Start []ItemQty `json:"start,omitempty"`
}

// Current is the current step (nil when finished).
func (q *Quest) Current() *Step {
	if q.Step < 0 || q.Step >= len(q.Steps) {
		return nil
	}
	return &q.Steps[q.Step]
}

// Log is a character's quest log.
type Log struct {
	V       int      `json:"v"`
	Active  []*Quest `json:"active"`
	Done    []string `json:"done,omitempty"`    // completed keys, newest last (bounded)
	Started []string `json:"started,omitempty"` // story keys ever started (the starter is offered once)
	Tracked uint32   `json:"tracked,omitempty"`
	dirty   bool
}

// NewLog is an empty log.
func NewLog() *Log { return &Log{V: 1} }

// Load parses a saved log (empty or bad JSON gives a new log).
func Load(b []byte) *Log {
	l := NewLog()
	if len(b) == 0 || json.Unmarshal(b, l) != nil {
		return NewLog()
	}
	l.V = 1
	l.Active = slices.DeleteFunc(l.Active, func(q *Quest) bool { return q == nil || q.Current() == nil })
	return l
}

// JSON is the saved form.
func (l *Log) JSON() []byte {
	b, _ := json.Marshal(l)
	return b
}

// Dirty reports unsaved changes; MarkSaved clears it; MarkDirty sets it.
func (l *Log) Dirty() bool { return l.dirty }
func (l *Log) MarkSaved()  { l.dirty = false }
func (l *Log) MarkDirty()  { l.dirty = true }

// Find returns the active quest with id (nil if none).
func (l *Log) Find(id uint32) *Quest {
	for _, q := range l.Active {
		if q.ID == id {
			return q
		}
	}
	return nil
}

// ByKey returns the active quest with key (nil if none).
func (l *Log) ByKey(key string) *Quest {
	for _, q := range l.Active {
		if q.Key == key {
			return q
		}
	}
	return nil
}

// IsDone reports whether key was completed (and is still remembered).
func (l *Log) IsDone(key string) bool { return slices.Contains(l.Done, key) }

// HasStarted reports whether a story quest was ever started.
func (l *Log) HasStarted(key string) bool { return slices.Contains(l.Started, key) }

// Bounties counts held bounties.
func (l *Log) Bounties() int { return l.count(KindBounty) }

func (l *Log) count(kind uint8) int {
	n := 0
	for _, q := range l.Active {
		if q.Kind == kind {
			n++
		}
	}
	return n
}

// Add puts q in the log (refusing duplicates, completed keys and a full log).
func (l *Log) Add(q *Quest) error {
	switch {
	case len(q.Steps) == 0:
		return ErrEmpty
	case l.ByKey(q.Key) != nil || l.Find(q.ID) != nil:
		return ErrHave
	case l.IsDone(q.Key):
		return ErrDone
	case len(l.Active) >= MaxActive || (q.Kind == KindBounty && l.Bounties() >= MaxBounties) || (q.Kind == KindSide && l.count(KindSide) >= MaxSide):
		return ErrTooMany
	}
	l.Active = append(l.Active, q)
	if (q.Kind == KindStory || q.Kind == KindMain) && !l.HasStarted(q.Key) {
		l.Started = append(l.Started, q.Key)
	}
	if l.Tracked == 0 || l.Find(l.Tracked) == nil {
		l.Tracked = q.ID
	}
	l.dirty = true
	return nil
}

// Remove drops quest id (abandon, or after completion). Returns it.
func (l *Log) Remove(id uint32) *Quest {
	for i, q := range l.Active {
		if q.ID == id {
			l.Active = slices.Delete(l.Active, i, i+1)
			if l.Tracked == id {
				l.Tracked = 0
				if len(l.Active) > 0 {
					l.Tracked = l.Active[0].ID
				}
			}
			l.dirty = true
			return q
		}
	}
	return nil
}

// Track sets the tracked quest (0 or an active id).
func (l *Log) Track(id uint32) bool {
	if id != 0 && l.Find(id) == nil {
		return false
	}
	if l.Tracked != id {
		l.Tracked = id
		l.dirty = true
	}
	return true
}

func (l *Log) markDone(key string) {
	l.Done = append(l.Done, key)
	if len(l.Done) > maxDone {
		// Keep story completions forever; forget the oldest bounties.
		for i, k := range l.Done {
			if len(k) < 6 || k[:6] != "story:" {
				l.Done = slices.Delete(l.Done, i, i+1)
				break
			}
		}
		if len(l.Done) > maxDone {
			l.Done = l.Done[len(l.Done)-maxDone:]
		}
	}
}

// Facts is what the rules ask the world about a character.
type Facts interface {
	// Have counts units of item the character holds (equipped included).
	Have(item string) int
	// Knows reports whether the character knows spell.
	Knows(spell string) bool
	// Pos is the character's position (x, z).
	Pos() (x, z float64)
	// Quiet reports that no live enemy guards (x, z) within r (clear
	// objectives complete on arrival when the place is already quiet).
	Quiet(site int, x, z, r float64) bool
}

// Happening is something the glue must act on (rewards, Events).
type Happening struct {
	Quest    *Quest
	Step     int  // the step that completed
	Finished bool // the whole quest completed (Quest already removed)
}

// Escorter is optional on Facts (CR 022): whether quest id's follower (a
// rescued villager) is close to the character.
type Escorter interface {
	Escorted(questID uint32) bool
}

// Leveler is optional on Facts (CR 035): the character's level.
type Leveler interface {
	Level() int
}

// Signal is an event in the world a step may be waiting for.
type Signal struct {
	Kind       string // ObjTalk (also completes ObjGive), ObjClear, ObjSlay, ObjTurnIn, ObjKill, ObjRead, ObjAttune, ObjDungeon
	Role       int
	Settlement int
	NPC        int     // talk: the towns-buffer NPC index + 1 (0 unknown)
	Site       int     // clear: the cleared group's site (-1 none); read/dungeon: the atlas site
	X, Z       float64 // clear/slay/kill: where it happened
	Family     string  // kill: the enemy's combat family; story: the happening's tag; do: the deed
}

// killCounts reports whether sig is a kill a kill step counts (R 0:
// anywhere, the starter quest's slimes).
func killCounts(o *Objective, sig *Signal) bool {
	return sig != nil && sig.Kind == ObjKill && (o.R <= 0 || math.Hypot(sig.X-o.X, sig.Z-o.Z) <= o.R) && (o.Family == "" || o.Family == sig.Family)
}

// doCounts reports whether sig is a deed a do step counts (CR 051).
func doCounts(o *Objective, sig *Signal) bool {
	return sig != nil && sig.Kind == ObjDo && o.Family == sig.Family
}

// counts reports whether sig advances the counting step o (kill or do).
func counts(o *Objective, sig *Signal) bool {
	switch o.Kind {
	case ObjKill:
		return killCounts(o, sig)
	case ObjDo:
		return doCounts(o, sig)
	}
	return false
}

func isCounter(o *Objective) bool { return o.Kind == ObjKill || o.Kind == ObjDo }

// met reports whether the step's objective holds now (state objectives) or
// is satisfied by sig (event objectives).
func met(qid uint32, s *Step, f Facts, sig *Signal) bool {
	o := &s.Obj
	switch o.Kind {
	case ObjHave:
		for _, it := range o.Items {
			if f.Have(it.Item) >= it.Qty {
				return true
			}
		}
	case ObjKnow:
		return f.Knows(o.Spell)
	case ObjReach:
		x, z := f.Pos()
		return math.Hypot(x-o.X, z-o.Z) <= o.R
	case ObjTalk:
		return sig != nil && sig.Kind == ObjTalk && sig.Role == o.Role && sig.Settlement == o.Settlement && (o.NPC == 0 || o.NPC == sig.NPC)
	case ObjGive:
		return sig != nil && sig.Kind == ObjTalk && sig.Role == o.Role && sig.Settlement == o.Settlement && (o.NPC == 0 || o.NPC == sig.NPC) &&
			len(o.Items) > 0 && f.Have(o.Items[0].Item) >= o.Items[0].Qty
	case ObjKill, ObjDo:
		return false // counted in Advance (Quest.Count)
	case ObjEscort:
		x, z := f.Pos()
		es, ok := f.(Escorter)
		return ok && math.Hypot(x-o.X, z-o.Z) <= o.R && es.Escorted(qid)
	case ObjRead, ObjDungeon:
		return sig != nil && sig.Kind == o.Kind && sig.Site == o.Site
	case ObjAttune:
		// CR 035: a main story step names its tower (Site); an attunement
		// of an already attuned crystal counts (the glue signals it too).
		return sig != nil && sig.Kind == ObjAttune && (o.Site < 0 || o.Site == sig.Site)
	case ObjLevel:
		lv, ok := f.(Leveler)
		return ok && lv.Level() >= o.N
	case ObjStory:
		return sig != nil && sig.Kind == ObjStory && sig.Family == o.Family
	case ObjClear:
		if sig != nil && sig.Kind == ObjClear && (sig.Site == o.Site && o.Site >= 0 || math.Hypot(sig.X-o.X, sig.Z-o.Z) <= o.R) {
			return true
		}
		if sig == nil {
			x, z := f.Pos()
			return math.Hypot(x-o.X, z-o.Z) <= o.R && f.Quiet(o.Site, o.X, o.Z, o.R+20)
		}
	case ObjSlay:
		return sig != nil && sig.Kind == ObjSlay && math.Hypot(sig.X-o.X, sig.Z-o.Z) <= o.R
	case ObjTurnIn:
		return sig != nil && sig.Kind == ObjTurnIn && sig.Settlement == o.Settlement && len(o.Items) > 0 && f.Have(o.Items[0].Item) >= o.Items[0].Qty
	}
	return false
}

// progress is the HUD count for a step.
func progress(q *Quest, s *Step, f Facts) int {
	switch s.Obj.Kind {
	case ObjKill, ObjDo:
		return min(q.Count, s.Obj.N)
	case ObjHave, ObjTurnIn, ObjGive:
		if len(s.Obj.Items) > 0 {
			return min(f.Have(s.Obj.Items[0].Item), s.Obj.Items[0].Qty)
		}
	}
	return 0
}

// Advance re-evaluates every active quest (sig nil: state objectives only,
// e.g. after an inventory change or on the periodic position check) and
// returns what completed. Completed quests are removed and remembered.
func (l *Log) Advance(f Facts, sig *Signal, out []Happening) []Happening {
	for i := 0; i < len(l.Active); i++ {
		q := l.Active[i]
		qs := sig
		for {
			s := q.Current()
			if s == nil {
				break
			}
			if isCounter(&s.Obj) && counts(&s.Obj, qs) {
				q.Count++
				l.dirty = true
				qs = nil
				if q.Count < s.Obj.N {
					break
				}
			} else if isCounter(&s.Obj) && q.Count >= s.Obj.N && s.Obj.N > 0 {
				// already counted (a reloaded log)
			} else if !met(q.ID, s, f, qs) {
				break
			}
			out = append(out, Happening{Quest: q, Step: q.Step})
			q.Step++
			q.Progress, q.Count = 0, 0
			l.dirty = true
			qs = nil // one signal completes one step; later steps need their own
		}
		if s := q.Current(); s != nil {
			if p := progress(q, s, f); p != q.Progress {
				q.Progress = p
				l.dirty = true
			}
			continue
		}
		l.Remove(q.ID)
		l.markDone(q.Key)
		out[len(out)-1].Finished = true
		i--
	}
	return out
}

// Wants reports whether any current step needs the periodic position check
// (reach and clear objectives), so the glue skips players who don't.
func (l *Log) Wants() bool {
	for _, q := range l.Active {
		if s := q.Current(); s != nil && (s.Obj.Kind == ObjReach || s.Obj.Kind == ObjClear || s.Obj.Kind == ObjEscort || s.Obj.Kind == ObjLevel) {
			return true
		}
	}
	return false
}

// Needs reports whether any current step is an objective of kind k.
func (l *Log) Needs(k string) bool {
	for _, q := range l.Active {
		if s := q.Current(); s != nil && s.Obj.Kind == k {
			return true
		}
	}
	return false
}

// ForceStep completes quest key's current step if it is step (a party
// member did it beside you: CR 035) and returns what happened (nil when the
// quest is not at that step). The step's own grants are the glue's to pay.
func (l *Log) ForceStep(key string, step int, out []Happening) []Happening {
	q := l.ByKey(key)
	if q == nil || q.Step != step || q.Current() == nil {
		return out
	}
	out = append(out, Happening{Quest: q, Step: q.Step})
	q.Step++
	q.Progress, q.Count = 0, 0
	l.dirty = true
	if q.Current() == nil {
		l.Remove(q.ID)
		l.markDone(q.Key)
		out[len(out)-1].Finished = true
	}
	return out
}

// SetStep moves quest key to step (a failed story event rolls back; CR 035
// catch-up moves forward without the steps' happenings). False when the
// quest is not held or step is out of range.
func (l *Log) SetStep(key string, step int) bool {
	q := l.ByKey(key)
	if q == nil || step < 0 || step >= len(q.Steps) {
		return false
	}
	if q.Step != step {
		q.Step = step
		q.Progress, q.Count = 0, 0
		l.dirty = true
	}
	return true
}

// MarkDone remembers key as completed without holding it (CR 035 catch-up:
// acts a party member finished for you).
func (l *Log) MarkDone(key string) {
	if !l.IsDone(key) {
		l.markDone(key)
		l.dirty = true
	}
	if !l.HasStarted(key) {
		l.Started = append(l.Started, key)
	}
}

// Forget drops key from the completed and started lists (CR 035 dev
// console: replaying the main story).
func (l *Log) Forget(key string) {
	n := len(l.Done) + len(l.Started)
	l.Done = slices.DeleteFunc(l.Done, func(k string) bool { return k == key })
	l.Started = slices.DeleteFunc(l.Started, func(k string) bool { return k == key })
	if len(l.Done)+len(l.Started) != n {
		l.dirty = true
	}
}
