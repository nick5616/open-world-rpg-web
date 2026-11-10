package content

import (
	"slices"
	"strings"

	"lodestone/server/pkg/contentdefs"
)

// Achievements (playtest 2, CR 031; docs/cr/031-achievements.md): one
// table (contracts/achievements.yaml), each earned when a counter reaches
// its count. The counters live in State.Stats (plus what the state already
// keeps: families, regions, tablets, the codex, fish, tamed kinds, vaults);
// the zone glue (internal/game/achievements.go) feeds them from every
// system and answers the few that live elsewhere (towers, level, the best
// pet's level). Earned keys stay in State.Feats, so the CR 023 feats a
// character earned carry over under the same keys.

// Has reports an earned achievement.
func (s *State) Has(key string) bool { return slices.Contains(s.Feats, key) }

// EarnedAt is when key was earned (unix ms; 0 before CR 031 or not earned).
func (s *State) EarnedAt(key string) int64 { return s.At[key] }

// Points is the sum of the earned achievements' points.
func (s *State) Points() int {
	n := 0
	for _, k := range s.Feats {
		if a := contentdefs.D.Achievement(k); a != nil {
			n += a.Pts
		}
	}
	return n
}

// TitleText is the shown title ("" none).
func (s *State) TitleText() string {
	if s.Title == "" || !s.Has(s.Title) {
		return ""
	}
	if a := contentdefs.D.Achievement(s.Title); a != nil {
		return a.Title
	}
	return ""
}

// SetTitle shows achievement key's title ("" none); false if not earned or untitled.
func (s *State) SetTitle(key string) bool {
	if key != "" {
		a := contentdefs.D.Achievement(key)
		if a == nil || a.Title == "" || !s.Has(key) {
			return false
		}
	}
	if s.Title != key {
		s.Title = key
		s.dirty = true
	}
	return true
}

// SetMax raises counter stat to v (a best: flighthigh).
func (s *State) SetMax(stat string, v int) bool {
	if v <= s.Stats[stat] {
		return false
	}
	if s.Stats == nil {
		s.Stats = map[string]int{}
	}
	s.Stats[stat] = v
	s.dirty = true
	return true
}

// StatFunc answers an achievement stat the state does not keep (the glue:
// towers, level, petlevel).
type StatFunc func(stat string) int

// prefixed counts the counters "<prefix>:..." above zero (schools, eventkinds).
func (s *State) prefixed(prefix string) int {
	n := 0
	for k, v := range s.Stats {
		if v > 0 && strings.HasPrefix(k, prefix) {
			n++
		}
	}
	return n
}

// Stat2 is the state's own answer for an achievement stat (-1: not the state's).
func (s *State) Stat2(stat string) int {
	switch {
	case strings.HasPrefix(stat, "family:"):
		return s.Families[stat[7:]]
	case strings.HasPrefix(stat, "fish:"):
		return s.Fish[stat[5:]][0]
	case stat == "regions":
		return s.RegionsWalked()
	case stat == "tablets":
		return len(s.Tablets)
	case stat == "codex":
		return s.Codex()
	case stat == "fishspecies":
		return len(s.Fish)
	case stat == "tamedspecies":
		return len(s.TamedKinds)
	case stat == "vaultsfound":
		return len(s.Vaults)
	case stat == "schools":
		return s.prefixed("cast:")
	case stat == "eventkinds":
		return s.prefixed("event:")
	case stat == "honored":
		return s.Honored()
	case stat == "quests":
		return s.Stats["side"] + s.Stats["stories"]
	case stat == "towers" || stat == "level" || stat == "petlevel":
		return -1 // the glue (internal/game/achievements.go)
	}
	return s.Stats[stat]
}

// Value is stat's value: the state's own, else stat's (nil: 0).
func (s *State) Value(stat string, glue StatFunc) int {
	if v := s.Stat2(stat); v >= 0 {
		return v
	}
	if glue != nil {
		return glue(stat)
	}
	return 0
}

// CatchingUp reports a state saved before CR 031 that has not had its
// catch-up yet.
func (s *State) CatchingUp() bool { return s.V < StateVersion }

// NewAchievements earns every achievement whose stat now reaches its count
// (at nowMs) and returns them (the glue pays the rewards and tells the
// player). The first titled one becomes the title when none is chosen.
// caughtUp: this was an older state's first check (CR 031 migration): what
// it earned comes from counters kept before achievements existed, and the
// glue tells the player once instead of one toast each.
func (s *State) NewAchievements(glue StatFunc, nowMs int64) (out []*contentdefs.Achievement, caughtUp bool) {
	caughtUp = s.CatchingUp()
	if caughtUp {
		s.V = StateVersion
		s.dirty = true
	}
	for i := range contentdefs.D.Achievements {
		a := &contentdefs.D.Achievements[i]
		if s.Has(a.Key) || s.Value(a.Stat, glue) < a.N {
			continue
		}
		s.Feats = append(s.Feats, a.Key)
		if s.At == nil {
			s.At = map[string]int64{}
		}
		s.At[a.Key] = nowMs
		s.dirty = true
		out = append(out, a)
		if s.Title == "" && a.Title != "" {
			s.Title = a.Key
		}
	}
	return out, caughtUp
}

// Progress is every achievement's counter value, except hidden ones not
// yet earned (their counts stay a secret).
func (s *State) Progress(glue StatFunc) map[string]int {
	out := make(map[string]int, len(contentdefs.D.Achievements))
	for i := range contentdefs.D.Achievements {
		a := &contentdefs.D.Achievements[i]
		if a.Hidden && !s.Has(a.Key) {
			continue
		}
		out[a.Key] = s.Value(a.Stat, glue)
	}
	return out
}
