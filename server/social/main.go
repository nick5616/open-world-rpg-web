// Command social is the social service (spec 10, WP08): chat channels,
// whispers, parties, friends, presence and moderation over the JSON
// WebSocket in contracts/social.yaml. See README.md.
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/accountapi"
	"lodestone/server/pkg/env"
	"lodestone/server/pkg/svc"
	"lodestone/server/pkg/ticket"
	"lodestone/server/social/internal/social"
)

func main() {
	s := svc.New("social", env.Addr("LODESTONE_SOCIAL_PORT", env.DefaultSocialPort))
	if err := run(s); err != nil {
		s.Log.Error("exit", "err", err)
		os.Exit(1)
	}
}

func run(s *svc.Server) error {
	pub, devKey, err := ticket.PublicKeyFromEnv()
	if err != nil {
		return err
	}
	if devKey {
		if accountapi.IsProduction() {
			// The dev key is in the repo: anyone could mint social tickets.
			return fmt.Errorf("LODESTONE_TICKET_PUBLIC_KEY must be set in production")
		}
		s.Log.Warn("using the insecure development ticket key; set LODESTONE_TICKET_PUBLIC_KEY for any shared deployment")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, env.PostgresURL())
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		return fmt.Errorf("postgres: %w", err)
	}
	rdb := redis.NewClient(&redis.Options{Addr: env.RedisAddr()})
	defer rdb.Close()
	if err := rdb.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("redis: %w", err)
	}

	origin := env.Str("LODESTONE_CORS_ORIGIN", "*")
	cfg := social.Config{
		TicketPub:      pub,
		OriginPatterns: social.ParseOrigins(origin),
		PresenceTTL:    env.Duration("LODESTONE_SOCIAL_PRESENCE_TTL", 0),
		ReapEvery:      env.Duration("LODESTONE_SOCIAL_REAP_EVERY", 0),
		PartyGrace:     env.Duration("LODESTONE_SOCIAL_PARTY_GRACE", 0),
		VoiceURL:       env.Str("LODESTONE_LIVEKIT_URL", env.DefaultLiveKitURL),
	}
	hub := social.NewHub(cfg, rdb, &social.Store{Pool: pool}, s.Log, s.Metrics)
	hub.Start()
	s.Log.Info("social hub started", "node", hub.Node())
	s.Mux.Handle("GET /ws", hub.Handler())
	return s.Run(svc.CORS(origin, s.Mux), func(ctx context.Context) { hub.Stop(ctx) })
}
