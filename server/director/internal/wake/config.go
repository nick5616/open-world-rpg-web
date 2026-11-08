package wake

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/env"
	"lodestone/server/pkg/svc"
	"lodestone/server/pkg/zoneregistry"
)

// FromEnv builds the Waker from environment variables, or returns
// ErrNotConfigured when LODESTONE_WAKE_PROVIDER is unset/"none" (the default:
// always awake, nothing changes for local development).
//
//	LODESTONE_WAKE_PROVIDER     none | gce | fake
//	LODESTONE_WAKE_IDLE         15m   stop after this long with nobody online
//	LODESTONE_WAKE_READY_URLS   comma-separated URLs that must answer 2xx before
//	                            the world counts as awake (the zone's and social
//	                            service's /healthz on the VM's internal address)
//	LODESTONE_WAKE_GCE_PROJECT / _ZONE / _INSTANCE   the game VM (gce)
//	LODESTONE_WAKE_FAKE_BOOT    8s    simulated boot time (fake)
func FromEnv(rdb *redis.Client, log *slog.Logger, m *svc.Metrics) (*Waker, error) {
	var p Provider
	switch kind := env.Str("LODESTONE_WAKE_PROVIDER", "none"); kind {
	case "none", "":
		return nil, ErrNotConfigured
	case "fake":
		p = NewFake(env.Duration("LODESTONE_WAKE_FAKE_BOOT", 8*time.Second), nil)
	case "gce":
		g := &GCE{
			Project:  env.Str("LODESTONE_WAKE_GCE_PROJECT", ""),
			Zone:     env.Str("LODESTONE_WAKE_GCE_ZONE", ""),
			Instance: env.Str("LODESTONE_WAKE_GCE_INSTANCE", ""),
		}
		for name, v := range map[string]string{"LODESTONE_WAKE_GCE_PROJECT": g.Project, "LODESTONE_WAKE_GCE_ZONE": g.Zone, "LODESTONE_WAKE_GCE_INSTANCE": g.Instance} {
			if v == "" {
				return nil, errMissing(name)
			}
		}
		p = g
	default:
		return nil, fmt.Errorf("wake: unknown LODESTONE_WAKE_PROVIDER %q (none, gce, fake)", kind)
	}
	w := &Waker{
		Provider:  p,
		IdleAfter: env.Duration("LODESTONE_WAKE_IDLE", DefaultIdleAfter),
		Log:       log,
		Metrics:   m,
	}
	if rdb != nil {
		w.Activity = RedisActivity{R: rdb}
		w.Players = func(ctx context.Context) (int, error) { return OnlinePlayers(ctx, rdb, time.Now()) }
	} else {
		w.Activity = &MemoryActivity{}
	}
	if urls := splitList(env.Str("LODESTONE_WAKE_READY_URLS", "")); len(urls) > 0 {
		w.Ready = HTTPReady(urls, &http.Client{Timeout: 3 * time.Second})
	}
	return w, nil
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// HTTPReady returns a readiness check that wants every URL to answer 2xx.
func HTTPReady(urls []string, c *http.Client) func(ctx context.Context) error {
	return func(ctx context.Context) error {
		for _, u := range urls {
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
			if err != nil {
				return err
			}
			res, err := c.Do(req)
			if err != nil {
				return fmt.Errorf("%s: %w", u, err)
			}
			res.Body.Close()
			if res.StatusCode/100 != 2 {
				return fmt.Errorf("%s: HTTP %d", u, res.StatusCode)
			}
		}
		return nil
	}
}

// activityKey holds the last-activity time (unix ms) in the VM's Redis.
const activityKey = "wake:lastActive"

// RedisActivity is the production ActivityStore.
type RedisActivity struct{ R *redis.Client }

// Touch implements ActivityStore (monotonic: a late writer never moves it back).
func (a RedisActivity) Touch(ctx context.Context, t time.Time) error {
	ms := t.UnixMilli()
	// SET only if greater: a tiny Lua script keeps it atomic across director
	// instances.
	return a.R.Eval(ctx, `local v = tonumber(redis.call('GET', KEYS[1]) or '0') if tonumber(ARGV[1]) > v then redis.call('SET', KEYS[1], ARGV[1]) end return 1`, []string{activityKey}, ms).Err()
}

// Last implements ActivityStore.
func (a RedisActivity) Last(ctx context.Context) (time.Time, error) {
	s, err := a.R.Get(ctx, activityKey).Result()
	if err == redis.Nil {
		return time.Time{}, nil
	}
	if err != nil {
		return time.Time{}, err
	}
	ms, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return time.Time{}, err
	}
	return time.UnixMilli(ms), nil
}

// OnlinePlayers sums the player counts of every live zone in every world's
// registry (zones:{worldId}, heartbeat within 15 s).
func OnlinePlayers(ctx context.Context, rdb *redis.Client, now time.Time) (int, error) {
	total := 0
	iter := rdb.Scan(ctx, 0, zoneregistry.Key("*"), 100).Iterator()
	for iter.Next(ctx) {
		worldID := strings.TrimPrefix(iter.Val(), zoneregistry.Key(""))
		live, err := zoneregistry.Live(ctx, rdb, worldID, now)
		if err != nil {
			return 0, err
		}
		for _, e := range live {
			total += e.Players
		}
	}
	return total, iter.Err()
}
