// Package zoneregistry is the Redis zone registry (spec 9 zones, spec 11
// `zones:{worldId}`): zone servers announce their endpoint, owned regions and
// load with a heartbeat; the director reads it to assign players.
//
// Layout: hash `zones:{worldId}`, field = zoneId, value = JSON Entry. Entries
// whose HeartbeatMs is older than StaleAfter are ignored (a crashed zone stops
// heartbeating; nothing has to clean up after it).
package zoneregistry

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"
)

// StaleAfter: three missed 5 s heartbeats.
const StaleAfter = 15 * time.Second

// HeartbeatEvery is how often zones re-announce.
const HeartbeatEvery = 5 * time.Second

// Region is a region coordinate (0..WORLD_REGIONS-1 on each axis).
type Region struct {
	X int `json:"x"`
	Z int `json:"z"`
}

// Entry describes one zone server process.
type Entry struct {
	ZoneID      string   `json:"zoneId"`
	Endpoint    string   `json:"endpoint"` // ws(s)://host:port/ws (WebSocket fallback, always present)
	WTEndpoint  string   `json:"wtEndpoint,omitempty"`
	Regions     []Region `json:"regions"` // empty = owns the whole world (v1 default)
	Players     int      `json:"players"`
	HeartbeatMs int64    `json:"heartbeatMs"`
}

// Key returns the Redis key for a world.
func Key(worldID string) string { return "zones:" + worldID }

// Announce writes/refreshes an entry. Call every HeartbeatEvery.
func Announce(ctx context.Context, rdb *redis.Client, worldID string, e Entry) error {
	e.HeartbeatMs = time.Now().UnixMilli()
	b, err := json.Marshal(e)
	if err != nil {
		return err
	}
	return rdb.HSet(ctx, Key(worldID), e.ZoneID, b).Err()
}

// Remove deletes an entry (graceful shutdown).
func Remove(ctx context.Context, rdb *redis.Client, worldID, zoneID string) error {
	return rdb.HDel(ctx, Key(worldID), zoneID).Err()
}

// Live returns non-stale entries.
func Live(ctx context.Context, rdb *redis.Client, worldID string, now time.Time) ([]Entry, error) {
	m, err := rdb.HGetAll(ctx, Key(worldID)).Result()
	if err != nil {
		return nil, err
	}
	out := make([]Entry, 0, len(m))
	for _, v := range m {
		var e Entry
		if json.Unmarshal([]byte(v), &e) != nil {
			continue
		}
		if now.Sub(time.UnixMilli(e.HeartbeatMs)) > StaleAfter {
			continue
		}
		out = append(out, e)
	}
	return out, nil
}

// Owns reports whether the entry owns region r.
func (e Entry) Owns(r Region) bool {
	if len(e.Regions) == 0 {
		return true
	}
	for _, x := range e.Regions {
		if x == r {
			return true
		}
	}
	return false
}

// Pick returns the live zone owning r with the fewest players, or false.
func Pick(entries []Entry, r Region) (Entry, bool) {
	var best Entry
	found := false
	for _, e := range entries {
		if !e.Owns(r) {
			continue
		}
		if !found || e.Players < best.Players {
			best, found = e, true
		}
	}
	return best, found
}
