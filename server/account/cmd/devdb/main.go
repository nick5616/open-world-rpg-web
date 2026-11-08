// Command devdb creates or drops a scratch database on the shared local
// Postgres, for end-to-end runs that must not touch anyone else's rows
// (several package agents share one Postgres).
//
//	go run ./server/account/cmd/devdb create lodestone_wp04_e2e   # drop-if-exists, create, migrate; prints its URL
//	go run ./server/account/cmd/devdb drop lodestone_wp04_e2e     # also clears its worlds' zone registry keys
package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/env"
	"lodestone/server/pkg/migrate"
	"lodestone/server/pkg/zoneregistry"
)

// Only scratch-looking names, so a typo can never drop the shared database.
var nameRe = regexp.MustCompile(`^lodestone_wp04_[a-z0-9_]+$`)

func main() {
	if len(os.Args) != 3 || !nameRe.MatchString(os.Args[2]) {
		fail(fmt.Errorf("usage: devdb create|drop lodestone_wp04_<suffix>"))
	}
	cmd, name := os.Args[1], os.Args[2]
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, env.PostgresURL())
	if err != nil {
		fail(err)
	}
	defer admin.Close(ctx)
	u, _ := url.Parse(env.PostgresURL())
	u.Path = "/" + name
	switch cmd {
	case "create":
		dropDB(ctx, admin, u.String(), name)
		if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
			fail(err)
		}
		conn, err := pgx.Connect(ctx, u.String())
		if err != nil {
			fail(err)
		}
		defer conn.Close(ctx)
		migs, err := migrate.Load(env.Str("LODESTONE_MIGRATIONS", filepath.Join("contracts", "migrations")))
		if err != nil {
			fail(err)
		}
		if _, err := migrate.Apply(ctx, conn, migs); err != nil {
			fail(err)
		}
		fmt.Println(u.String())
	case "drop":
		dropDB(ctx, admin, u.String(), name)
	default:
		fail(fmt.Errorf("unknown command %q", cmd))
	}
}

func dropDB(ctx context.Context, admin *pgx.Conn, dbURL, name string) {
	// Clear zone registry entries for this database's worlds first, so fake
	// zones from an e2e run don't linger in the shared Redis.
	if conn, err := pgx.Connect(ctx, dbURL); err == nil {
		rows, err := conn.Query(ctx, `SELECT id::text FROM worlds`)
		if err == nil {
			rdb := redis.NewClient(&redis.Options{Addr: env.RedisAddr()})
			for rows.Next() {
				var id string
				if rows.Scan(&id) == nil {
					rdb.Del(ctx, zoneregistry.Key(id))
				}
			}
			rows.Close()
			_ = rdb.Close()
		}
		conn.Close(ctx)
	}
	if _, err := admin.Exec(ctx, "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)"); err != nil {
		fail(err)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "devdb:", err)
	os.Exit(1)
}
