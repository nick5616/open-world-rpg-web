// Command director is the login handoff (spec 4, WP04): it verifies a
// session, picks the zone server for the character's region from the Redis
// zone registry, and signs zone and social connect tickets. Endpoints are
// documented in server/director/README.md.
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"lodestone/server/director/internal/director"
	"lodestone/server/director/internal/wake"
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
	// WP18: CheckDep is fatal as before unless LODESTONE_LAZY_DEPS=1 (Cloud
	// Run: Postgres and Redis sleep with the game VM, and the director must
	// stay up to wake it).
	if err := s.CheckDep(ctx, "postgres", pool.Ping); err != nil {
		return err
	}
	rdb := redis.NewClient(&redis.Options{Addr: env.RedisAddr()})
	defer rdb.Close()
	if err := s.CheckDep(ctx, "redis", func(c context.Context) error { return rdb.Ping(c).Err() }); err != nil {
		return err
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
	// WP16: region assignment for cluster worlds (internal/director/assign.go).
	if every := env.Duration("LODESTONE_DIRECTOR_ASSIGN_EVERY", 2*time.Second); every > 0 {
		actx, stopAssign := context.WithCancel(context.Background())
		defer stopAssign()
		go d.RunAssigner(actx, every)
	}
	handler, stopWake, err := withWake(s, rdb)
	if err != nil {
		return err
	}
	defer stopWake()
	s.Log.Info("director ready", "social", social, "production", prod)
	return s.Run(svc.CORS(env.Str("LODESTONE_CORS_ORIGIN", "*"), handler), nil)
}

// withWake mounts wake-on-demand (WP18, internal/wake): POST /v1/wake for the
// client's "waking the world" screen and, with a provider configured, the
// gate that starts the game VM on connect plus the idle stopper. Without
// LODESTONE_WAKE_PROVIDER the world is always awake (local dev, tests).
func withWake(s *svc.Server, rdb *redis.Client) (http.Handler, func(), error) {
	w, err := wake.FromEnv(rdb, s.Log, s.Metrics)
	if errors.Is(err, wake.ErrNotConfigured) {
		wake.AlwaysAwake(s.Mux)
		return s.Mux, func() {}, nil
	}
	if err != nil {
		return nil, nil, err
	}
	w.Register(s.Mux, env.Str("LODESTONE_WAKE_CRON_TOKEN", ""))
	ctx, cancel := context.WithCancel(context.Background())
	go w.Loop(ctx, env.Duration("LODESTONE_WAKE_CHECK_EVERY", time.Minute))
	s.Log.Info("wake on demand", "provider", w.Provider.Name(), "idleAfter", w.IdleAfter.String())
	gated := map[string]bool{"/v1/connect": true, "/v1/social-ticket": true}
	return w.Gate(gated, s.Mux), cancel, nil
}
