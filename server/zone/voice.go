package main

// WP11 proximity voice: the zone's earshot publisher. The tick hands player
// positions to a voice.Runner every EARSHOT_INTERVAL_MS; the runner computes
// the sets on its own goroutine and publishes them to Redis
// (lodestone/server/pkg/earshot, channel voice:{worldId}), where the social
// service's voice leader turns them into LiveKit subscriptions.

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/earshot"
	"lodestone/server/pkg/env"
	"lodestone/server/pkg/svc"
	"lodestone/server/zone/internal/voice"
)

type redisEarshot struct {
	rdb     *redis.Client
	channel string
}

func (p *redisEarshot) Publish(ctx context.Context, m *earshot.Message) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return p.rdb.Publish(ctx, p.channel, b).Err()
}

// startEarshot returns the runner the zone config takes, or nil when voice is
// off (LODESTONE_ZONE_NO_REDIS, or LODESTONE_ZONE_EARSHOT=0). Its Redis
// client is its own, so a slow publish never queues behind the registry
// heartbeat (or the other way round).
func startEarshot(ctx context.Context, worldID, zoneID string, m *svc.Metrics, log *slog.Logger) *voice.Runner {
	if env.Bool("LODESTONE_ZONE_NO_REDIS", false) || !env.Bool("LODESTONE_ZONE_EARSHOT", true) {
		log.Info("earshot publishing off")
		return nil
	}
	rdb := redis.NewClient(&redis.Options{Addr: env.RedisAddr()})
	r := voice.NewRunner(zoneID, &redisEarshot{rdb: rdb, channel: earshot.Channel(worldID)})
	var lastErr atomic.Int64
	r.OnError = func(err error) {
		// One line per 10 s at most: Redis down would otherwise log 4 per second.
		if now := time.Now().Unix(); now-lastErr.Load() >= 10 {
			lastErr.Store(now)
			log.Warn("earshot publish failing", "err", err)
		}
	}
	m.Help("zone_earshot_published_total", "Earshot messages published (WP11).")
	m.Help("zone_earshot_skipped_total", "Earshot intervals skipped because the previous one was still publishing.")
	m.Help("zone_earshot_failed_total", "Earshot publishes that failed.")
	m.Help("zone_earshot_changes_total", "Listener sets that changed (delta messages).")
	m.Help("zone_earshot_pairs", "Listener->speaker entries in the current sets.")
	m.Help("zone_earshot_compute_us", "Time to compute the last interval's sets (runner goroutine, not the tick).")
	go r.Run(ctx)
	go func() {
		defer rdb.Close()
		t := time.NewTicker(time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
			m.SetInt("zone_earshot_published_total", r.Published.Load())
			m.SetInt("zone_earshot_skipped_total", r.Skipped.Load())
			m.SetInt("zone_earshot_failed_total", r.Failed.Load())
			m.SetInt("zone_earshot_changes_total", r.Changes.Load())
			m.SetInt("zone_earshot_pairs", r.Pairs.Load())
			m.SetInt("zone_earshot_compute_us", r.LastComputeUs.Load())
		}
	}()
	log.Info("earshot publishing", "channel", earshot.Channel(worldID), "intervalMs", constants.EarshotIntervalMs)
	return r
}
