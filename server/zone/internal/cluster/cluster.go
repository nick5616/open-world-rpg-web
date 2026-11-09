// Package cluster is the Redis side of multiple zones (WP16): it implements
// game.Cluster (pub/sub control and ghost channels, handoff records, owner
// records, world-stable entity ids, the world presence feed) and keeps the
// zone's registry entry and region ownership table fresh.
//
// Redis layout (spec 11 keys, scoped by world so concurrent test worlds on
// one Redis never collide):
//
//	zones:{worldId}               registry hash (server/pkg/zoneregistry)
//	zoneassign:{worldId}          director's region assignment (zoneregistry.Plan)
//	zoneslot:{worldId}            counter: per-zone entity id ranges
//	zone:{worldId}:{zoneId}       pub/sub: control messages to one zone
//	ghost:{worldId}               pub/sub: ghost-band frames, every zone, 30 Hz
//	hotoken:{worldId}:{token}     pre-connect token record (60 s, single use)
//	hostate:{worldId}:{id}        handoff state in flight (60 s, single use)
//	owner:{worldId}:{charId}      the zone that owns a character now
//	entid:{worldId}               hash charId -> world-stable entity id
//	entid:{worldId}:next          its counter
//	worldpos:{worldId}            hash charId -> presence record (1 Hz)
package cluster

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/zoneregistry"
	"lodestone/server/zone/internal/game"
)

// PlayerIDBase is where world-stable player entity ids start; zone-local
// ids (pickups, enemies) live below it in per-zone 16M ranges (slot << 24,
// slots 1..63).
const PlayerIDBase = 1 << 30

// Redis implements game.Cluster.
type Redis struct {
	RDB   *redis.Client
	World string
	Zone  string
	Log   *slog.Logger

	recv   chan game.ClusterMsg
	owners atomic.Pointer[game.Owners]
	live   atomic.Pointer[[]zoneregistry.Entry]
}

// New makes the cluster plumbing for one zone; call Run.
func New(rdb *redis.Client, world, zone string, log *slog.Logger) *Redis {
	return &Redis{RDB: rdb, World: world, Zone: zone, Log: log, recv: make(chan game.ClusterMsg, 4096)}
}

func (r *Redis) key(parts ...string) string {
	k := parts[0] + ":" + r.World
	for _, p := range parts[1:] {
		k += ":" + p
	}
	return k
}

func (r *Redis) ctlChannel(zone string) string { return "zone:" + r.World + ":" + zone }
func (r *Redis) ghostChannel() string          { return "ghost:" + r.World }

// Slot reserves this zone's local entity id range (1..63) << 24.
func (r *Redis) Slot(ctx context.Context) (uint32, error) {
	n, err := r.RDB.Incr(ctx, "zoneslot:"+r.World).Result()
	if err != nil {
		return 0, err
	}
	return uint32(n%63+1) << 24, nil
}

// Run subscribes and polls the registry until ctx ends.
func (r *Redis) Run(ctx context.Context) {
	go r.pollOwners(ctx)
	for ctx.Err() == nil {
		ps := r.RDB.Subscribe(ctx, r.ctlChannel(r.Zone), r.ghostChannel())
		if _, err := ps.Receive(ctx); err != nil {
			_ = ps.Close()
			r.Log.Warn("cluster subscribe failed; retrying", "err", err)
			select {
			case <-ctx.Done():
			case <-time.After(time.Second):
			}
			continue
		}
		ch := ps.Channel(redis.WithChannelSize(2048))
		for m := range ch {
			if m.Channel == r.ghostChannel() {
				select {
				case r.recv <- game.ClusterMsg{Ghost: true, Data: []byte(m.Payload)}:
				default: // the tick is behind: a newer frame follows in 33 ms
				}
				continue
			}
			select {
			case r.recv <- game.ClusterMsg{Data: []byte(m.Payload)}:
			case <-ctx.Done():
			}
		}
		_ = ps.Close()
	}
}

// pollOwners refreshes the ownership table every second.
func (r *Redis) pollOwners(ctx context.Context) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		r.RefreshOwners(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// RefreshOwners reads the registry once (also used at startup).
func (r *Redis) RefreshOwners(ctx context.Context) {
	qctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	now := time.Now()
	live, err := zoneregistry.Live(qctx, r.RDB, r.World, now)
	if err != nil {
		r.Log.Debug("registry read failed; keeping the last ownership table", "err", err)
		return
	}
	r.live.Store(&live)
	r.owners.Store(game.OwnersFrom(r.Zone, live, now))
}

// Live is the last registry read.
func (r *Redis) Live() []zoneregistry.Entry {
	if p := r.live.Load(); p != nil {
		return *p
	}
	return nil
}

// Owners implements game.Cluster.
func (r *Redis) Owners() *game.Owners { return r.owners.Load() }

// Recv implements game.Cluster.
func (r *Redis) Recv() <-chan game.ClusterMsg { return r.recv }

// Send implements game.Cluster.
func (r *Redis) Send(ctx context.Context, zone string, msg []byte) error {
	return r.RDB.Publish(ctx, r.ctlChannel(zone), msg).Err()
}

// Broadcast implements game.Cluster.
func (r *Redis) Broadcast(ctx context.Context, frame []byte) error {
	return r.RDB.Publish(ctx, r.ghostChannel(), frame).Err()
}

// The game passes keys like "hotoken:<tok>"; scope them by world.
func (r *Redis) scoped(k string) string {
	for i := 0; i < len(k); i++ {
		if k[i] == ':' {
			return k[:i] + ":" + r.World + k[i:]
		}
	}
	return k + ":" + r.World
}

// Put implements game.Cluster.
func (r *Redis) Put(ctx context.Context, k string, v []byte, ttl time.Duration) error {
	return r.RDB.Set(ctx, r.scoped(k), v, ttl).Err()
}

// Take implements game.Cluster (GETDEL: exactly one taker).
func (r *Redis) Take(ctx context.Context, k string) ([]byte, error) {
	b, err := r.RDB.GetDel(ctx, r.scoped(k)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	return b, err
}

// Swap implements game.Cluster (SET ... GET).
func (r *Redis) Swap(ctx context.Context, k string, v []byte, ttl time.Duration) ([]byte, error) {
	old, err := r.RDB.SetArgs(ctx, r.scoped(k), v, redis.SetArgs{Get: true, TTL: ttl}).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	return old, err
}

var delIf = redis.NewScript(`if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`)

// DelIf implements game.Cluster.
func (r *Redis) DelIf(ctx context.Context, k string, v []byte) error {
	return delIf.Run(ctx, r.RDB, []string{r.scoped(k)}, string(v)).Err()
}

var entityID = redis.NewScript(`
local id = redis.call('HGET', KEYS[1], ARGV[1])
if id then return tonumber(id) end
id = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1], ARGV[1], id)
return id`)

// EntityID implements game.Cluster: PlayerIDBase + a per-world counter,
// fixed per character for the world's life.
func (r *Redis) EntityID(ctx context.Context, char string) (uint32, error) {
	n, err := entityID.Run(ctx, r.RDB, []string{r.key("entid"), r.key("entid", "next")}, char).Int64()
	if err != nil {
		return 0, err
	}
	if n <= 0 || n >= PlayerIDBase {
		return 0, errors.New("entity id space exhausted: " + strconv.FormatInt(n, 10))
	}
	return uint32(PlayerIDBase + n), nil
}

// WritePresence implements game.Cluster.
func (r *Redis) WritePresence(ctx context.Context, put map[string][]byte, del []string) error {
	if len(put) == 0 && len(del) == 0 {
		return nil
	}
	pipe := r.RDB.Pipeline()
	if len(put) > 0 {
		vals := make([]any, 0, 2*len(put))
		for k, v := range put {
			vals = append(vals, k, v)
		}
		pipe.HSet(ctx, r.key("worldpos"), vals...)
	}
	if len(del) > 0 {
		pipe.HDel(ctx, r.key("worldpos"), del...)
	}
	_, err := pipe.Exec(ctx)
	return err
}

// ReadPresence implements game.Cluster.
func (r *Redis) ReadPresence(ctx context.Context) (map[string][]byte, error) {
	m, err := r.RDB.HGetAll(ctx, r.key("worldpos")).Result()
	if err != nil {
		return nil, err
	}
	out := make(map[string][]byte, len(m))
	for k, v := range m {
		out[k] = []byte(v)
	}
	return out, nil
}

// ---- registry heartbeat ----

// Announcer heartbeats a cluster zone's registry entry: role, regions
// (static, or the director's assignment for pool zones), a short TTL.
type Announcer struct {
	R       *Redis
	Entry   zoneregistry.Entry // ZoneID, endpoints, Role, Debug, static Regions
	Static  bool               // Regions are pinned by env (never read the assignment)
	Every   time.Duration
	Players func() int
	// Load reports players per region (WP19b: the director's load moves);
	// nil = not reported.
	Load func() []zoneregistry.RegionLoad
}

// Run heartbeats until ctx ends; on exit the caller removes the entry.
func (a *Announcer) Run(ctx context.Context) {
	t := time.NewTicker(a.Every)
	defer t.Stop()
	failing := false
	for {
		e := a.Entry
		e.Players = a.Players()
		if a.Load != nil {
			e.Load = a.Load()
		}
		actx, cancel := context.WithTimeout(ctx, 2*time.Second)
		if e.Role == zoneregistry.RolePool && !a.Static {
			if rs, err := zoneregistry.ReadAssignment(actx, a.R.RDB, a.R.World, e.ZoneID); err == nil {
				e.Regions = rs
			} else {
				e.Regions = a.lastRegions()
			}
		}
		err := zoneregistry.Announce(actx, a.R.RDB, a.R.World, e)
		cancel()
		if err == nil {
			a.Entry.Regions = e.Regions
			a.R.RefreshOwners(ctx) // our own change shows up at once
		}
		switch {
		case err != nil && !failing:
			a.R.Log.Warn("zone registry announce failing", "err", err)
			failing = true
		case err == nil && failing:
			a.R.Log.Info("zone registry announce recovered")
			failing = false
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (a *Announcer) lastRegions() []zoneregistry.Region { return a.Entry.Regions }
