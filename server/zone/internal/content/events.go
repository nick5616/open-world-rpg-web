package content

import (
	"math"

	"lodestone/server/pkg/contentdefs"
)

// World events (CR 022): the zone asks every events.scheduler.everyS
// whether to start one near each player; the answer, the kind and the
// spot's direction and distance are a pure function of the world seed, the
// time slot and the player, so a test (or a second look) gets the same.

// EventPick is the scheduler's answer for one player in one slot.
type EventPick struct {
	Kind  *contentdefs.EventKind
	Angle float64 // radians
	Dist  float64 // metres from the player
	Salt  uint64  // further seeded choices (wave spots, roam legs)
}

// PickEvent decides whether to start an event for player in slot (night:
// the world clock says night). ok=false: not this time.
func PickEvent(seed uint64, slot int64, player uint64, night bool) (EventPick, bool) {
	sc := &contentdefs.D.Events.Scheduler
	h := mix(seed ^ 0xe7e47 ^ uint64(slot)*0x9e3779b97f4a7c15 ^ player*0xc2b2ae3d27d4eb4f)
	if unit(h) >= sc.ChancePerPlayer {
		return EventPick{}, false
	}
	tot := 0.0
	for i := range contentdefs.D.Events.Kinds {
		k := &contentdefs.D.Events.Kinds[i]
		if !k.Night || night {
			tot += k.Weight
		}
	}
	u := unit(mix(h+1)) * tot
	var kind *contentdefs.EventKind
	for i := range contentdefs.D.Events.Kinds {
		k := &contentdefs.D.Events.Kinds[i]
		if k.Night && !night {
			continue
		}
		kind = k
		if u -= k.Weight; u < 0 {
			break
		}
	}
	if kind == nil {
		return EventPick{}, false
	}
	return EventPick{Kind: kind, Angle: unit(mix(h+2)) * 2 * math.Pi, Dist: sc.SpawnMinM + unit(mix(h+3))*(sc.SpawnMaxM-sc.SpawnMinM), Salt: mix(h + 4)}, true
}

// RoamLeg is the behemoth's next waypoint from (x, z): leg metres in a
// seeded direction, turned by `turn` attempts when the glue refuses a spot.
func RoamLeg(salt uint64, leg int, x, z, legM float64, turn int) (float64, float64) {
	a := unit(mix(salt^uint64(leg)*0x9e3779b97f4a7c15)) * 2 * math.Pi
	a += float64(turn) * math.Pi / 3
	return x + legM*math.Cos(a), z + legM*math.Sin(a)
}

// Rewards rolls a won event's gold for one player (seeded per player).
func Rewards(k *contentdefs.EventKind, salt uint64, player uint64) (gold int, ore int, gems int) {
	h := mix(salt ^ player*0x9e3779b97f4a7c15)
	gold = lerpI(k.Reward.Gold, h)
	ore = lerpI(k.Reward.OreQty, mix(h+1))
	gems = lerpI(k.Reward.Gems, mix(h+2))
	return
}
