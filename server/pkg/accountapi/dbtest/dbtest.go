// Package dbtest gives integration tests their own throwaway Postgres
// database and a Redis client, against the shared local infra
// (`npm run infra:up`). Every test database is created fresh, migrated with
// contracts/migrations, and dropped afterwards, because several package
// agents share one Postgres and must never see each other's rows.
//
// Tests skip when infra is unreachable, unless LODESTONE_REQUIRE_INFRA=1
// (CI), where a missing database is a failure.
package dbtest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/env"
	"lodestone/server/pkg/migrate"
)

func unavailable(t testing.TB, what string, err error) {
	t.Helper()
	if env.Bool("LODESTONE_REQUIRE_INFRA", false) {
		t.Fatalf("%s unavailable: %v", what, err)
	}
	t.Skipf("%s unavailable (run `npm run infra:up`): %v", what, err)
}

// MigrationsDir locates contracts/migrations from this source file, so tests
// work from any module directory.
func MigrationsDir() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "contracts", "migrations")
}

// Postgres creates database lodestone_wp04_t_<random>, applies every
// migration, and drops it when the test ends. Returns a pool and its URL (for
// child processes).
func Postgres(t testing.TB) (*pgxpool.Pool, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, env.PostgresURL())
	if err != nil {
		unavailable(t, "postgres", err)
	}
	var rb [4]byte
	_, _ = rand.Read(rb[:])
	name := "lodestone_wp04_t_" + hex.EncodeToString(rb[:])
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		admin.Close(ctx)
		t.Fatal(err)
	}
	u, _ := url.Parse(env.PostgresURL())
	u.Path = "/" + name
	dbURL := u.String()

	conn, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	migs, err := migrate.Load(MigrationsDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := migrate.Apply(ctx, conn, migs); err != nil {
		t.Fatal(err)
	}
	conn.Close(ctx)

	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		c, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		// WITH (FORCE) drops even if a child process left a connection open.
		_, _ = admin.Exec(c, "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
		admin.Close(c)
	})
	return pool, dbURL
}

// Redis returns a client on the shared Redis. Tests must use unique keys
// (random profile and world ids do this naturally) and clean up after themselves.
func Redis(t testing.TB) *redis.Client {
	t.Helper()
	rdb := redis.NewClient(&redis.Options{Addr: env.RedisAddr()})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		unavailable(t, "redis", err)
	}
	t.Cleanup(func() { _ = rdb.Close() })
	return rdb
}
