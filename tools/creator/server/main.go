// Command server is the creator tool's Go endpoint (spec 6, WP17): it mints
// worlds (spec_from_seed or a normalized creator spec -> atlas_build ->
// worlds row), lists them, and, only with LODESTONE_CREATOR_LLM=1 and
// ANTHROPIC_API_KEY, turns vibe text into a spec. Never runs for players.
// See README.md.
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/env"
	"lodestone/server/pkg/svc"
	"lodestone/tools/creator/server/internal/api"
	"lodestone/tools/creator/server/internal/spec"
	"lodestone/tools/creator/server/internal/store"
	"lodestone/tools/creator/server/internal/vibe"
	"lodestone/tools/creator/server/internal/worldgen"
)

func main() {
	s := svc.New("creator", env.Addr("LODESTONE_CREATOR_PORT", env.DefaultCreatorPort))
	if err := run(s); err != nil {
		s.Log.Error("exit", "err", err)
		os.Exit(1)
	}
}

// repoFile resolves an env override or a repo-relative default, searching
// up from the working directory and the executable.
func repoFile(envKey, rel string) (string, error) {
	if p := os.Getenv(envKey); p != "" {
		return p, nil
	}
	starts := []string{"."}
	if exe, err := os.Executable(); err == nil {
		starts = append(starts, filepath.Dir(exe))
	}
	p, err := spec.FindRepoFile(rel, starts...)
	if err != nil {
		return "", fmt.Errorf("%w (set %s)", err, envKey)
	}
	return p, nil
}

func run(s *svc.Server) error {
	cfg := api.ConfigFromEnv(os.Getenv)
	schemaPath, err := repoFile("LODESTONE_WORLDSPEC_SCHEMA", spec.SchemaRel)
	if err != nil {
		return err
	}
	gate, err := spec.LoadGate(schemaPath)
	if err != nil {
		return err
	}
	wasmPath, err := repoFile("LODESTONE_WORLDGEN_WASM", filepath.Join("worldgen", "pkg", "worldgen.wasm"))
	if err != nil {
		return fmt.Errorf("%w; run `npm run build:wasm`", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	mod, err := worldgen.Load(ctx, wasmPath)
	if err != nil {
		return err
	}
	defer mod.Close(context.Background())
	s.Log.Info("worldgen loaded", "wasm", wasmPath, "sha256", mod.SHA256[:16], "genVersion", mod.GenVersion)

	pool, err := pgxpool.New(ctx, env.PostgresURL())
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		return fmt.Errorf("postgres: %w", err)
	}

	// Redis only backs the vibe cache, so it is only dialed when the LLM
	// path is on.
	var cache vibe.Cache
	if cfg.LLM.Enabled {
		rdb := redis.NewClient(&redis.Options{Addr: env.RedisAddr()})
		defer rdb.Close()
		if err := rdb.Ping(ctx).Err(); err != nil {
			s.Log.Warn("redis unavailable; vibe cache is in-memory for this process", "err", err)
			cache = &vibe.MemoryCache{}
		} else {
			cache = vibe.RedisCache{R: rdb, TTL: env.Duration("LODESTONE_CREATOR_VIBE_TTL", 30*24*time.Hour)}
		}
	}

	server, err := api.New(cfg, api.Deps{
		Gate: gate, Module: mod, Store: &store.Store{Pool: pool}, Cache: cache,
		HTTP: &http.Client{Timeout: 60 * time.Second}, Log: s.Log, Metrics: s.Metrics,
	})
	if err != nil {
		return err
	}
	server.Register(s.Mux)
	s.Log.Info("creator ready", "llm", server.LLMEnabled(), "auth", cfg.Token != "")
	return s.Run(svc.CORS(env.Str("LODESTONE_CORS_ORIGIN", "*"), s.Mux), nil)
}
