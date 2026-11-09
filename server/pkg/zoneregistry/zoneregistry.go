// Package zoneregistry is the Redis zone registry (spec 9 zones, spec 11
// `zones:{worldId}`): zone servers announce their endpoint, owned regions and
// load with a heartbeat; the director reads it to assign players.
//
// Layout: hash `zones:{worldId}`, field = zoneId, value = JSON Entry. Entries
// whose HeartbeatMs is older than StaleAfter (or the entry's own TTLMs) are
// ignored (a crashed zone stops heartbeating; nothing has to clean up after
// it).
//
// WP16 (multiple zones): region ownership is a pure function of the live
// entries (Owner), computed identically by every zone, the director and the
// bots. The director assigns regions to pool zones through
// `zoneassign:{worldId}` (Plan); the primary owns whatever nobody claims.
package zoneregistry

import (
	"context"
	"encoding/json"
	"math"
	"sort"
	"time"

	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/constants"
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

// Roles (WP16). A zone started without cluster mode announces no role and
// no regions, which means "owns the whole world" exactly as before WP16.
const (
	// RolePrimary owns every region no live zone claims explicitly (spec
	// 13: a dead spot zone's regions fail over to the primary).
	RolePrimary = "primary"
	// RolePool owns only the regions the director assigned to it
	// (zoneassign:{worldId}); with none assigned it owns nothing.
	RolePool = "pool"
)

// Entry describes one zone server process.
type Entry struct {
	ZoneID      string   `json:"zoneId"`
	Endpoint    string   `json:"endpoint"` // ws(s)://host:port/ws (WebSocket fallback, always present)
	WTEndpoint  string   `json:"wtEndpoint,omitempty"`
	Regions     []Region `json:"regions"` // explicit regions; empty with no Role = owns the whole world (v1 default)
	Players     int      `json:"players"`
	HeartbeatMs int64    `json:"heartbeatMs"`
	// WP16 (multi-zone). Role is "" (legacy whole-world zone), primary or
	// pool. Cluster zones heartbeat faster and declare their own staleness
	// (TTLMs) so a dead zone's regions fail over in seconds, not 15 s.
	Role  string `json:"role,omitempty"`
	TTLMs int64  `json:"ttlMs,omitempty"`
	// Debug is the zone's HTTP base (http://host:port) for tools (bots read
	// /debug/cluster from any live zone).
	Debug string `json:"debug,omitempty"`
	// Load is the players this zone simulates per region (WP19b,
	// rebalance.go): the director moves regions off a zone well over its
	// share. Omitted by zones that do not report it.
	Load []RegionLoad `json:"load,omitempty"`
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
		if !e.LiveAt(now) {
			continue
		}
		out = append(out, e)
	}
	return out, nil
}

// LiveAt reports whether the entry's heartbeat is fresh at now.
func (e Entry) LiveAt(now time.Time) bool {
	stale := StaleAfter
	if e.TTLMs > 0 {
		stale = time.Duration(e.TTLMs) * time.Millisecond
	}
	return now.Sub(time.UnixMilli(e.HeartbeatMs)) <= stale
}

// Owns reports whether the entry may serve region r (Pick's notion: a
// whole-world zone serves everything; a pool zone only its regions).
func (e Entry) Owns(r Region) bool {
	if e.Role == RolePool {
		return e.Claims(r)
	}
	if len(e.Regions) == 0 || e.Role == RolePrimary {
		return true
	}
	return e.Claims(r)
}

// Claims reports whether r is in the entry's explicit region list.
func (e Entry) Claims(r Region) bool {
	for _, x := range e.Regions {
		if x == r {
			return true
		}
	}
	return false
}

// fallback reports whether the entry takes regions nobody claims: a
// primary, or a legacy zone announcing no regions and no role.
func (e Entry) fallback() bool {
	return e.Role == RolePrimary || (e.Role == "" && len(e.Regions) == 0)
}

// Pick returns the live zone owning r with the fewest players, or false.
// (WP04's load-balancing pick among equals; WP16's director routes with
// Owner, which every zone agrees on.)
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

// Owner is THE owner of region r among live entries (WP16): the zone that
// claims r explicitly, else the fallback zone (primary or legacy
// whole-world). Ties go to the lowest ZoneID, never to load: every zone,
// the director and the bots compute ownership from the same registry read,
// and they must all agree on one owner, or two zones would each simulate
// half of the players standing in the same place (who then could not see
// each other). ok=false when no live zone can take r.
func Owner(live []Entry, r Region) (Entry, bool) {
	var best Entry
	found, explicit := false, false
	for _, e := range live {
		switch {
		case e.Claims(r):
			if !explicit || e.ZoneID < best.ZoneID {
				best, found, explicit = e, true, true
			}
		case !explicit && e.fallback() && (!found || e.ZoneID < best.ZoneID):
			best, found = e, true
		}
	}
	return best, found
}

// RegionAt maps a world position (m) to its region, clamped to the world.
func RegionAt(x, z float64) Region {
	size := float64(constants.RegionChunks * constants.ChunkSizeM)
	clamp := func(v float64) int {
		if math.IsNaN(v) {
			return 0
		}
		return max(0, min(constants.WorldRegions-1, int(math.Floor(v/size))))
	}
	return Region{X: clamp(x), Z: clamp(z)}
}

// RegionSizeM is the edge of one region in meters (1024 in v1).
const RegionSizeM = float64(constants.RegionChunks * constants.ChunkSizeM)

// ---- director region assignment (WP16) ----

// AssignKey is the hash the director writes: field zoneId, value JSON
// []Region. Pool zones read their field and announce it as Regions.
func AssignKey(worldID string) string { return "zoneassign:" + worldID }

// ReadAssignment returns the regions the director assigned to zoneID.
func ReadAssignment(ctx context.Context, rdb *redis.Client, worldID, zoneID string) ([]Region, error) {
	b, err := rdb.HGet(ctx, AssignKey(worldID), zoneID).Bytes()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var rs []Region
	if err := json.Unmarshal(b, &rs); err != nil {
		return nil, err
	}
	return rs, nil
}

// Assignment is the director's whole map: zoneId -> regions.
func Assignment(ctx context.Context, rdb *redis.Client, worldID string) (map[string][]Region, error) {
	m, err := rdb.HGetAll(ctx, AssignKey(worldID)).Result()
	if err != nil {
		return nil, err
	}
	out := make(map[string][]Region, len(m))
	for k, v := range m {
		var rs []Region
		if json.Unmarshal([]byte(v), &rs) == nil {
			out[k] = rs
		}
	}
	return out, nil
}

// WriteAssignment replaces the director's map in one transaction.
func WriteAssignment(ctx context.Context, rdb *redis.Client, worldID string, a map[string][]Region) error {
	pipe := rdb.TxPipeline()
	pipe.Del(ctx, AssignKey(worldID))
	for z, rs := range a {
		if len(rs) == 0 {
			continue
		}
		b, _ := json.Marshal(rs)
		pipe.HSet(ctx, AssignKey(worldID), z, b)
	}
	_, err := pipe.Exec(ctx)
	return err
}

// Plan is the director's assignment policy (pure, so it is unit-tested and
// the same everywhere): pool zones get regions, the primary keeps the rest.
//
//   - Sticky: a live pool zone keeps what it has (moving a region moves its
//     players, which costs each of them a handoff).
//   - A dead (not live) pool zone's regions are dropped from the map, so the
//     primary keeps them (spec 13 failover; Owner() already falls back the
//     moment the dead entry goes stale, this only makes it stick).
//   - A live pool zone with nothing gets ceil(n/(k+1)) of the n regions the
//     primary currently holds (k = empty pool zones still waiting), taken in
//     region order (x-major), so splits are contiguous stripes and the
//     primary keeps the tail.
//   - No primary live: nothing changes (no fallback to receive regions).
//
// Regions zones pin themselves (LODESTONE_ZONE_REGIONS, role "") are never
// assigned to a pool zone.
func Plan(live []Entry, cur map[string][]Region) map[string][]Region {
	next := map[string][]Region{}
	var pools []string
	hasPrimary := false
	pinned := map[Region]bool{}
	for _, e := range live {
		switch e.Role {
		case RolePool:
			pools = append(pools, e.ZoneID)
		case RolePrimary:
			hasPrimary = true
		default:
			for _, r := range e.Regions {
				pinned[r] = true
			}
		}
	}
	if !hasPrimary {
		for k, v := range cur {
			next[k] = v
		}
		return next
	}
	sort.Strings(pools)
	taken := map[Region]bool{}
	for _, z := range pools {
		for _, r := range cur[z] {
			if !taken[r] && !pinned[r] {
				taken[r] = true
				next[z] = append(next[z], r)
			}
		}
	}
	var empty []string
	for _, z := range pools {
		if len(next[z]) == 0 {
			empty = append(empty, z)
		}
	}
	for i, z := range empty {
		var free []Region
		for x := 0; x < constants.WorldRegions; x++ {
			for zz := 0; zz < constants.WorldRegions; zz++ {
				r := Region{X: x, Z: zz}
				if !taken[r] && !pinned[r] {
					free = append(free, r)
				}
			}
		}
		k := len(empty) - i            // pool zones still waiting, this one included
		n := (len(free) + k) / (k + 1) // ceil(len/(k+1)): the primary keeps a share too
		if n == 0 {
			break
		}
		for _, r := range free[:n] {
			taken[r] = true
			next[z] = append(next[z], r)
		}
	}
	return next
}
