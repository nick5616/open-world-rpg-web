package director

// Region assignment (WP16, spec 9: "A zone server process owns a set of
// regions, assigned by the director through the Redis zone registry").
//
// Every `every` the director looks at each world that has a zone registry,
// computes zoneregistry.Plan (pool zones get regions, sticky; a dead pool
// zone's regions go back to the primary; pinned regions are left alone)
// and writes zoneassign:{worldId} when it changed. Pool zones read their
// share on their next heartbeat and announce it; every zone then computes
// the same ownership table from the registry (zoneregistry.Owner) and
// hands players off accordingly.
//
// Failover does not wait for this loop: the moment a dead zone's entry goes
// stale (its own TTL, 3 s in cluster mode), Owner() already gives its
// regions to the primary. The loop only makes that stick and splits the
// primary's regions with pool zones that join.
//
// Several director instances (Cloud Run) take a short Redis lease per world
// so only one writes at a time. A director scaled to zero assigns nothing:
// existing assignments stay valid, and failover still works.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/zoneregistry"
)

var instanceID = func() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}()

var renewLease = redis.NewScript(`
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) and 1 or 0`)

// RunAssigner assigns regions every `every` until ctx ends.
func (d *Director) RunAssigner(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		d.assignAll(ctx, every)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (d *Director) assignAll(ctx context.Context, every time.Duration) {
	var cursor uint64
	for {
		keys, next, err := d.RDB.Scan(ctx, cursor, "zones:*", 100).Result()
		if err != nil {
			d.Log.Debug("assigner scan", "err", err)
			return
		}
		for _, k := range keys {
			world := strings.TrimPrefix(k, "zones:")
			if _, err := d.AssignOnce(ctx, world, every*3); err != nil {
				d.Log.Warn("region assignment failed", "world", world, "err", err)
			}
		}
		if next == 0 {
			return
		}
		cursor = next
	}
}

// AssignOnce plans and writes one world's assignment if this instance holds
// the world's lease. Returns the plan written (nil when unchanged or not
// leader).
func (d *Director) AssignOnce(ctx context.Context, worldID string, lease time.Duration) (map[string][]zoneregistry.Region, error) {
	ok, err := renewLease.Run(ctx, d.RDB, []string{"zoneassignlead:" + worldID}, instanceID, lease.Milliseconds()).Int()
	if err != nil && err != redis.Nil {
		return nil, err
	}
	if ok != 1 {
		return nil, nil
	}
	live, err := zoneregistry.Live(ctx, d.RDB, worldID, d.now())
	if err != nil {
		return nil, err
	}
	hasCluster := false
	for _, e := range live {
		if e.Role != "" {
			hasCluster = true
		}
	}
	if !hasCluster {
		return nil, nil // legacy single-zone worlds: nothing to assign
	}
	cur, err := zoneregistry.Assignment(ctx, d.RDB, worldID)
	if err != nil {
		return nil, err
	}
	next := zoneregistry.Plan(live, cur)
	// WP19b: then at most one load move (rebalance.go), and only once the
	// zones have had RebalanceCooldown to hand the last moved region's
	// players over and report their new load.
	if d.Rebalance != nil && sameAssignment(cur, next) {
		d.rebalMu.Lock()
		last := d.lastRebalance[worldID]
		d.rebalMu.Unlock()
		if d.now().Sub(last) >= d.RebalanceCooldown {
			if moved, m := zoneregistry.Rebalance(live, next, *d.Rebalance); m != nil {
				next = moved
				d.rebalMu.Lock()
				if d.lastRebalance == nil {
					d.lastRebalance = map[string]time.Time{}
				}
				d.lastRebalance[worldID] = d.now()
				d.rebalMu.Unlock()
				d.Log.Info("region moved for load", "world", worldID, "move", m.String())
				d.Metrics.Add("director_region_load_moves_total", 1)
			}
		}
	}
	if sameAssignment(cur, next) {
		return nil, nil
	}
	if err := zoneregistry.WriteAssignment(ctx, d.RDB, worldID, next); err != nil {
		return nil, err
	}
	b, _ := json.Marshal(next)
	d.Log.Info("regions assigned", "world", worldID, "assignment", string(b))
	d.Metrics.Add("director_region_assignments_total", 1)
	return next, nil
}

func sameAssignment(a, b map[string][]zoneregistry.Region) bool {
	norm := func(m map[string][]zoneregistry.Region) map[string][]zoneregistry.Region {
		out := map[string][]zoneregistry.Region{}
		for k, v := range m {
			if len(v) == 0 {
				continue
			}
			s := append([]zoneregistry.Region(nil), v...)
			sort.Slice(s, func(i, j int) bool { return s[i].X < s[j].X || s[i].X == s[j].X && s[i].Z < s[j].Z })
			out[k] = s
		}
		return out
	}
	return reflect.DeepEqual(norm(a), norm(b))
}
