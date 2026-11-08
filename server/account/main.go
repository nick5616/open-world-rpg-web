// Command account is the account service (spec 4, WP04): Firebase and dev
// sign-in, local profiles and their signed save blobs, worlds and characters.
// Endpoints are documented in server/account/README.md.
package main

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"lodestone/server/account/internal/api"
	"lodestone/server/account/internal/firebase"
	"lodestone/server/pkg/accountapi"
	"lodestone/server/pkg/env"
	"lodestone/server/pkg/localsave"
	"lodestone/server/pkg/svc"
)

// DefaultWorldSeed seeds the official world until the creator tool mints
// worlds (WP17). The date the spec was written.
const DefaultWorldSeed = "20261108"

func main() {
	s := svc.New("account", env.Addr("LODESTONE_ACCOUNT_PORT", env.DefaultAccountPort))
	if err := run(s); err != nil {
		s.Log.Error("exit", "err", err)
		os.Exit(1)
	}
}

func run(s *svc.Server) error {
	prod := accountapi.IsProduction()
	devAuth := env.Bool("LODESTONE_DEV_AUTH", !prod)
	if prod && devAuth {
		// Dev auth signs anyone in by username: one misplaced env var must not
		// open production to that.
		return errors.New("LODESTONE_DEV_AUTH is refused when LODESTONE_ENV=production")
	}

	sessPriv, devSess, err := accountapi.SessionPrivateKeyFromEnv()
	if err != nil {
		return err
	}
	savePriv, devSave, err := localsave.PrivateKeyFromEnv()
	if err != nil {
		return err
	}
	if err := checkDevKeys(s.Log, prod, map[string]bool{"LODESTONE_SESSION_PRIVATE_KEY": devSess, "LODESTONE_SAVE_PRIVATE_KEY": devSave}); err != nil {
		return err
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

	db := accountapi.DB{Pool: pool}
	if err := seedWorld(ctx, s.Log, db); err != nil {
		return fmt.Errorf("seed world: %w", err)
	}

	a := &api.API{
		DB:          db,
		Saves:       &localsave.Store{RDB: rdb, Priv: savePriv, Pub: savePriv.Public().(ed25519.PublicKey), AdoptMissing: true},
		SessionPriv: sessPriv,
		SessionPub:  sessPriv.Public().(ed25519.PublicKey),
		SessionTTL:  env.Duration("LODESTONE_SESSION_TTL", accountapi.DefaultSessionTTL),
		Providers:   providers(env.Str("LODESTONE_FIREBASE_PROVIDERS", "google.com")),
		DevAuth:     devAuth,
		Log:         s.Log,
		Metrics:     s.Metrics,
	}
	if pid := env.Str("LODESTONE_FIREBASE_PROJECT_ID", ""); pid != "" {
		a.Firebase = &firebase.Verifier{ProjectID: pid, JWKSURL: env.Str("LODESTONE_FIREBASE_JWKS_URL", firebase.GoogleJWKSURL)}
	} else if prod {
		return errors.New("LODESTONE_FIREBASE_PROJECT_ID is required in production (no other account sign-in exists)")
	}
	if devAuth {
		s.Log.Warn("dev auth enabled: anyone can sign in by username (LODESTONE_DEV_AUTH=0 to disable)")
	}
	a.Register(s.Mux)
	s.Log.Info("account ready", "firebase", a.Firebase != nil, "devAuth", devAuth, "production", prod)
	return s.Run(svc.CORS(env.Str("LODESTONE_CORS_ORIGIN", "*"), s.Mux), nil)
}

// checkDevKeys warns about well-known development keys, and refuses them in
// production: anyone with the repo could mint sessions or saves.
func checkDevKeys(log *slog.Logger, prod bool, used map[string]bool) error {
	for name, dev := range used {
		if !dev {
			continue
		}
		if prod {
			return fmt.Errorf("%s must be set in production", name)
		}
		log.Warn("using the insecure development key; set it for any shared deployment", "env", name)
	}
	return nil
}

// providers parses "google.com,github.com" into firebase provider ->
// accounts.auth_provider ("google", "github").
func providers(s string) map[string]string {
	m := map[string]string{}
	for _, p := range strings.Split(s, ",") {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		m[p] = strings.TrimSuffix(p, ".com")
	}
	return m
}

// seedWorld makes sure one official world exists. The spec JSON and
// gen_version are placeholders until worldgen's spec_from_seed is wired in
// (WP01 merge); see docs/STATUS.md.
func seedWorld(ctx context.Context, log *slog.Logger, db accountapi.DB) error {
	seed := env.Str("LODESTONE_WORLD_SEED", DefaultWorldSeed)
	if _, err := strconv.ParseUint(seed, 10, 64); err != nil {
		return fmt.Errorf("LODESTONE_WORLD_SEED must be a uint64: %w", err)
	}
	spec, _ := json.Marshal(map[string]any{"placeholder": true, "seed": seed, "note": "replace with worldgen spec_from_seed (WP01)"})
	w, created, err := db.EnsureOfficialWorld(ctx, accountapi.World{
		Name: env.Str("LODESTONE_WORLD_NAME", "Lodestone"), Seed: seed, Spec: spec,
		GenVersion: "placeholder", AtlasHash: "placeholder",
	})
	if err != nil {
		return err
	}
	log.Info("official world", "id", w.ID, "seed", w.Seed, "created", created)
	return nil
}
