package content

// Playtest 2 dev console (docs/cr/032-dev-console.md): unlock achievements
// without their counters (LODESTONE_ZONE_DEV zones only; the game glue pays
// the rewards and tells the player as a real unlock does).

import (
	"slices"

	"lodestone/server/pkg/contentdefs"
)

// DevEarn earns the given achievements (nil = every one) not earned yet and
// returns them, like NewAchievements does for counters that reached their count.
func (s *State) DevEarn(keys []string, nowMs int64) []*contentdefs.Achievement {
	var out []*contentdefs.Achievement
	for i := range contentdefs.D.Achievements {
		a := &contentdefs.D.Achievements[i]
		if s.Has(a.Key) || keys != nil && !slices.Contains(keys, a.Key) {
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
	return out
}
