// Command director is the login handoff (spec 4, WP04): it verifies a
// session, picks the zone server for the character's region from the Redis
// zone registry, and signs zone and social connect tickets. Endpoints are
// documented in server/director/README.md.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"lodestone/server/director/internal/director"
	"lodestone/server/pkg/accountapi"
	"lodestone/server/pkg/env"
	"lodestone/server/pkg/localsave"
	"lodestone/server/pkg/svc"
	"lodestone/server/pkg/ticket"
)

func main() {
	s := svc.New("director", env.Addr("LODESTONE_DIRECTOR_PORT", env.DefaultDirectorPort))
	if err := run(s); err != nil {
		s.Log.Error("exit", "err", err)
		os.Exit(1)
	}
}

func run(s *svc.Server) error {
	prod := accountapi.IsProduction()
	ticketPriv, devTicket, err := ticket.PrivateKeyFromEnv()
	if err != nil {
		return err
	}
	sessPub, devSess, err := accountapi.SessionPublicKeyFromEnv()
	if err != nil {
		return err
	}
	savePub, devSave, err := localsave.PublicKeyFromEnv()
	if err != nil {
		return err
	}
	for name, dev := range map[string]bool{"LODESTONE_TICKET_PRIVATE_KEY": devTicket, "LODESTONE_SESSION_PUBLIC_KEY": devSess, "LODESTONE_SAVE_PUBLIC_KEY": devSave} {
		if !dev {
			continue
		}
		if prod {
			// Anyone with the repo could mint tickets with the dev key.
			return fmt.Errorf("%s must be set in production", name)
		}
		s.Log.Warn("using the insecure development key; set it for any shared deployment", "env", name)
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
	social := env.Str("LODESTONE_SOCIAL_URL", fmt.Sprintf("ws://localhost:%d/ws", env.Int("LODESTONE_SOCIAL_PORT", env.DefaultSocialPort)))
	if social == "" {
		return errors.New("LODESTONE_SOCIAL_URL is empty")
	}
	d := &director.Director{
		DB: accountapi.DB{Pool: pool}, RDB: rdb,
		SessionPub: sessPub, TicketPriv: ticketPriv,
		Saves:          &localsave.Store{RDB: rdb, Pub: savePub, AdoptMissing: true},
		SocialEndpoint: social,
		Log:            s.Log, Metrics: s.Metrics,
	}
	d.Register(s.Mux)
	s.Log.Info("director ready", "social", social, "production", prod)
	return s.Run(svc.CORS(env.Str("LODESTONE_CORS_ORIGIN", "*"), s.Mux), nil)
}
