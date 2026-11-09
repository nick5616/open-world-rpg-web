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
	"lodestone/server/pkg/worldhost"
	"lodestone/server/pkg/worldhost/mintdb"
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
	// WP18: fatal as before unless LODESTONE_LAZY_DEPS=1 (Cloud Run, database
	// asleep on the game VM): then serve now and seed the world once it wakes.
	var pgErr error
	if err := s.CheckDep(ctx, "postgres", func(c context.Context) error { pgErr = pool.Ping(c); return pgErr }); err != nil {
		return err
	}
	rdb := redis.NewClient(&redis.Options{Addr: env.RedisAddr()})
	defer rdb.Close()
	if err := s.CheckDep(ctx, "redis", func(c context.Context) error { return rdb.Ping(c).Err() }); err != nil {
		return err
	}

	db := accountapi.DB{Pool: pool}
	if pgErr == nil {
		if err := seedWorld(ctx, s.Log, db); err != nil {
			return fmt.Errorf("seed world: %w", err)
		}
	} else {
		go seedWorldWhenReachable(s.Log, db)
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

// seedWorldWhenReachable retries seedWorld until Postgres answers (lazy
// startup only; WP18). Minting the same official world twice is a no-op.
func seedWorldWhenReachable(log *slog.Logger, db accountapi.DB) {
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		err := db.Pool.Ping(ctx)
		if err == nil {
			err = seedWorld(ctx, log, db)
		}
		cancel()
		if err == nil {
			return
		}
		log.Warn("seed world: waiting for postgres", "err", err)
		time.Sleep(10 * time.Second)
	}
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

// renewDevWorld: outside production, an official world minted on an older
// genVersion than the built worldgen.wasm is renewed in place onto it
// (playtest 1 towns/density moved the generator to genVersion 2; spec 5
// rule 5 "world renewal"; mintdb.RenewOfficial keeps the row, its
// characters and their progress). LODESTONE_WORLD_RENEW=0 turns it off;
// production never renews by itself (operators run `mintworld -official
// -renew`, docs/decisions/0022-towns-terrain-density.md).
func renewDevWorld(ctx context.Context, log *slog.Logger, db accountapi.DB, w accountapi.World) {
	if accountapi.IsProduction() || !env.Bool("LODESTONE_WORLD_RENEW", true) {
		return
	}
	cur, err := worldhost.LoadFromEnv(ctx)
	if err != nil {
		return
	}
	defer cur.Close(ctx)
	if v, ok := worldhost.ParseGenVersion(w.GenVersion); !ok || v >= cur.GenVersion() {
		return
	}
	old, err := worldhost.LoadForGenVersion(ctx, w.GenVersion)
	if err != nil || old.GenVersionString() != w.GenVersion {
		log.Warn("official world is on an older genVersion and its archived generator is missing; not renewing", "genVersion", w.GenVersion, "err", err)
		if old != nil {
			_ = old.Close(ctx)
		}
		return
	}
	defer old.Close(ctx)
	res, err := mintdb.RenewOfficial(ctx, db, cur, old)
	if err != nil {
		log.Warn("official world renewal failed; zones keep serving it on its archived generator", "err", err)
		return
	}
	log.Info("official world renewed (dev)", "id", res.After.ID, "genVersion", res.Before.GenVersion+" -> "+res.After.GenVersion,
		"atlasHash", res.Before.AtlasHash+" -> "+res.After.AtlasHash, "movedCharacters", res.Moved)
}

// seedWorld makes sure one official world exists and is minted: spec from
// worldgen's spec_from_seed, the wasm's gen_version and the atlas hash
// (WP07, server/pkg/worldhost/mintdb; a placeholder row from before is
// upgraded in place, keeping its seed). Without a built worldgen.wasm it
// falls back to WP04's placeholder row, which zones open from the seed
// alone.
func seedWorld(ctx context.Context, log *slog.Logger, db accountapi.DB) error {
	seed := env.Str("LODESTONE_WORLD_SEED", DefaultWorldSeed)
	if _, err := strconv.ParseUint(seed, 10, 64); err != nil {
		return fmt.Errorf("LODESTONE_WORLD_SEED must be a uint64: %w", err)
	}
	name := env.Str("LODESTONE_WORLD_NAME", "Lodestone")
	var mod *worldhost.Module
	load := func() (*worldhost.Module, error) {
		var err error
		mod, err = worldhost.LoadFromEnv(ctx)
		return mod, err
	}
	w, action, err := mintdb.EnsureOfficial(ctx, db, load, accountapi.World{Name: name, Seed: seed})
	if mod != nil {
		_ = mod.Close(ctx) // the account service needs no wasm after minting
	}
	if err == nil {
		log.Info("official world", "id", w.ID, "seed", w.Seed, "genVersion", w.GenVersion, "atlasHash", w.AtlasHash, "action", action)
		if action == mintdb.AlreadyMinted {
			renewDevWorld(ctx, log, db, w)
		}
		return nil
	}
	if !errors.Is(err, worldhost.ErrNoWasm) {
		return err
	}
	log.Warn("worldgen.wasm not built: official world stays a placeholder (zones derive it from the seed); run `npm run build:wasm` and restart to mint it", "err", err)
	spec, _ := json.Marshal(map[string]any{"placeholder": true, "seed": seed, "note": "minted from spec_from_seed when worldgen.wasm is available (WP07)"})
	w, created, err := db.EnsureOfficialWorld(ctx, accountapi.World{
		Name: name, Seed: seed, Spec: spec,
		GenVersion: "placeholder", AtlasHash: "placeholder",
	})
	if err != nil {
		return err
	}
	log.Info("official world", "id", w.ID, "seed", w.Seed, "created", created)
	return nil
}
