package content

import (
	"encoding/json"
	"slices"
	"sort"
	"strconv"

	"lodestone/server/pkg/contentdefs"
	"lodestone/server/zone/internal/dialog"
)

// State is one character's content progress (CR 022; persisted as JSON in
// character_content, in a local profile's save blob, and across a WP16
// handoff): reputation per town, each side quest giver's next request, the
// codex (kills per creature), lore tablets read, achievements (CR 031;
// the CR 023 feats under their old keys) with when each was earned and the
// chosen title, the counters achievements count, vaults discovered and
// their chest timers, and herb patches picked (with their regrow time).
//
// V 2 (CR 031): a state saved before achievements (V 0 or 1) loads as it
// was; its first achievement check earns what its old counters already
// reach in one quiet catch-up (NewAchievements: caughtUp) and makes it V 2.
type State struct {
	V        int            `json:"v"`
	Rep      map[string]int `json:"rep,omitempty"`      // settlement index -> reputation
	Givers   map[string]int `json:"givers,omitempty"`   // "settlement:npc" -> next request seq
	Kills    map[string]int `json:"kills,omitempty"`    // enemy key -> kills (codex: > 0 unlocked)
	Families map[string]int `json:"families,omitempty"` // combat family -> kills
	Tablets  []int          `json:"tablets,omitempty"`  // tablet ids read
	Feats    []string       `json:"feats,omitempty"`    // achievement keys earned, oldest first (the CR 023 feats kept their keys)
	Title    string         `json:"title,omitempty"`    // achievement key whose title shows on the nameplate
	Stats    map[string]int `json:"stats,omitempty"`    // counters (contracts/achievements.yaml lists them): duels, events, kills, casts, cast:fire, gallop...
	// At (CR 031): achievement key -> earned at (unix ms; none for feats earned before CR 031).
	At      map[string]int64  `json:"at,omitempty"`
	Regions uint32            `json:"regions,omitempty"` // bit r = walked in atlas region r
	Vaults  map[string]int64  `json:"vaults,omitempty"`  // atlas site -> last chest (unix ms; 0 = discovered)
	Forage  map[string]int64  `json:"forage,omitempty"`  // herb patch id -> regrows at (unix ms)
	Fish    map[string][2]int `json:"fish,omitempty"`    // playtest 2 fishing: species key -> [landed, best weight g]
	// TamedKinds: playtest 2 pets (CR 029): pet species key -> creatures tamed.
	TamedKinds map[string]int `json:"tamed,omitempty"`
	// Dlg: playtest 4 dialog (CR 049): what this character remembers of each
	// townsperson (towns NPC stable id -> met, talks, affinity, topics heard).
	Dlg   map[string]dialog.Memory `json:"dlg,omitempty"`
	dirty bool
}

// StateVersion is the current saved form (2: CR 031 achievements).
const StateVersion = 2

// NewState is an empty state.
func NewState() *State { return &State{V: StateVersion} }

// LoadState parses a saved state (empty or bad JSON gives a new one). An
// older state keeps its version until its catch-up (see State).
func LoadState(b []byte) *State {
	s := &State{}
	if len(b) == 0 || json.Unmarshal(b, s) != nil {
		return NewState()
	}
	if s.V > StateVersion {
		s.V = StateVersion
	}
	return s
}

// JSON is the saved form.
func (s *State) JSON() []byte {
	b, _ := json.Marshal(s)
	return b
}

// Dirty, MarkSaved, MarkDirty: unsaved changes.
func (s *State) Dirty() bool { return s.dirty }
func (s *State) MarkSaved()  { s.dirty = false }
func (s *State) MarkDirty()  { s.dirty = true }

func bump(m *map[string]int, k string, n int) int {
	if *m == nil {
		*m = map[string]int{}
	}
	(*m)[k] += n
	return (*m)[k]
}

// Add increments counter stat by n.
func (s *State) Add(stat string, n int) int {
	s.dirty = true
	return bump(&s.Stats, stat, n)
}

// Stat is a counter's value.
func (s *State) Stat(stat string) int { return s.Stats[stat] }

// Kill records a kill; first reports the creature's first (a new codex entry).
func (s *State) Kill(enemy, family string, demon bool) (first bool) {
	s.dirty = true
	first = bump(&s.Kills, enemy, 1) == 1
	bump(&s.Families, family, 1)
	if demon {
		bump(&s.Stats, "demons", 1)
	} else {
		bump(&s.Stats, "kills", 1)
	}
	return first
}

// Landed records a fish landed (playtest 2 fishing): first reports a new
// species (a new codex entry), record a new best weight for it. The fish
// counter (feat stat "fish") and, for a legendary, "fishlegend" go up.
func (s *State) Landed(species string, weightG int, legendary bool) (first, record bool) {
	s.dirty = true
	if s.Fish == nil {
		s.Fish = map[string][2]int{}
	}
	r, had := s.Fish[species]
	first = !had
	record = had && weightG > r[1]
	r[0]++
	if weightG > r[1] {
		r[1] = weightG
	}
	s.Fish[species] = r
	bump(&s.Stats, "fish", 1)
	if legendary {
		bump(&s.Stats, "fishlegend", 1)
	}
	return first, record
}

// Codex is the number of creatures in the codex.
func (s *State) Codex() int { return len(s.Kills) }

// RepOf is settlement si's reputation.
func (s *State) RepOf(si int) int { return s.Rep[strconv.Itoa(si)] }

// AddRep raises settlement si's reputation; it returns the new value and
// the tier before and after.
func (s *State) AddRep(si, n int) (rep, before, after int) {
	before = contentdefs.D.TierOf(s.RepOf(si))
	rep = bump(&s.Rep, strconv.Itoa(si), n)
	s.dirty = true
	return rep, before, contentdefs.D.TierOf(rep)
}

// Honored counts towns at the top reputation tier.
func (s *State) Honored() int {
	top := len(contentdefs.D.Reputation.Tiers) - 1
	n := 0
	for _, v := range s.Rep {
		if contentdefs.D.TierOf(v) == top {
			n++
		}
	}
	return n
}

func giverKey(si, npc int) string { return strconv.Itoa(si) + ":" + strconv.Itoa(npc) }

// GiverSeq is the next request seq of giver npc in settlement si.
func (s *State) GiverSeq(si, npc int) int { return s.Givers[giverKey(si, npc)] }

// GiverDone moves giver npc on past seq.
func (s *State) GiverDone(si, npc, seq int) {
	if s.GiverSeq(si, npc) <= seq {
		if s.Givers == nil {
			s.Givers = map[string]int{}
		}
		s.Givers[giverKey(si, npc)] = seq + 1
		s.dirty = true
	}
}

// ReadTablet records tablet id; it reports a first read.
func (s *State) ReadTablet(id int) bool {
	if slices.Contains(s.Tablets, id) {
		return false
	}
	s.Tablets = append(s.Tablets, id)
	sort.Ints(s.Tablets)
	s.dirty = true
	return true
}

// Walked records region r; it reports a first visit.
func (s *State) Walked(r int) bool {
	if r < 0 || r >= 32 || s.Regions&(1<<r) != 0 {
		return false
	}
	s.Regions |= 1 << r
	s.dirty = true
	return true
}

// RegionsWalked counts regions walked in.
func (s *State) RegionsWalked() int {
	n := 0
	for r := s.Regions; r != 0; r &= r - 1 {
		n++
	}
	return n
}

// VaultSeen records a discovered vault; it reports a first discovery.
func (s *State) VaultSeen(site int) bool {
	k := strconv.Itoa(site)
	if _, ok := s.Vaults[k]; ok {
		return false
	}
	if s.Vaults == nil {
		s.Vaults = map[string]int64{}
	}
	s.Vaults[k] = 0
	s.dirty = true
	return true
}

// VaultKnown reports a discovered vault.
func (s *State) VaultKnown(site int) bool {
	_, ok := s.Vaults[strconv.Itoa(site)]
	return ok
}

// VaultChest is when the vault's chest was last opened (unix ms, 0 never).
func (s *State) VaultChest(site int) int64 { return s.Vaults[strconv.Itoa(site)] }

// OpenVaultChest records a chest opening at nowMs.
func (s *State) OpenVaultChest(site int, nowMs int64) {
	if s.Vaults == nil {
		s.Vaults = map[string]int64{}
	}
	s.Vaults[strconv.Itoa(site)] = nowMs
	s.dirty = true
}

// VaultSites lists discovered vault sites.
func (s *State) VaultSites() []int {
	var out []int
	for k := range s.Vaults {
		if v, err := strconv.Atoi(k); err == nil {
			out = append(out, v)
		}
	}
	sort.Ints(out)
	return out
}

// Picked reports a herb patch still regrowing at nowMs.
func (s *State) Picked(id uint32, nowMs int64) bool {
	return s.Forage[strconv.FormatUint(uint64(id), 10)] > nowMs
}

// Pick records patch id regrowing until untilMs, pruning old entries.
func (s *State) Pick(id uint32, untilMs, nowMs int64) {
	if s.Forage == nil {
		s.Forage = map[string]int64{}
	}
	for k, v := range s.Forage {
		if v <= nowMs {
			delete(s.Forage, k)
		}
	}
	s.Forage[strconv.FormatUint(uint64(id), 10)] = untilMs
	s.dirty = true
}

// DlgMem is what this character remembers of townsperson npc (a towns NPC id).
func (s *State) DlgMem(npc uint64) dialog.Memory { return s.Dlg[strconv.FormatUint(npc, 10)] }

// SetDlgMem stores that memory.
func (s *State) SetDlgMem(npc uint64, m dialog.Memory) {
	if s.Dlg == nil {
		s.Dlg = map[string]dialog.Memory{}
	}
	s.Dlg[strconv.FormatUint(npc, 10)] = m
	s.dirty = true
}
