// Command migrate applies contracts/migrations to LODESTONE_PG_URL.
// Run from the repo root: `npm run migrate`.
package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/jackc/pgx/v5"

	"lodestone/server/pkg/env"
	"lodestone/server/pkg/migrate"
)

func main() {
	dir := env.Str("LODESTONE_MIGRATIONS", filepath.Join("contracts", "migrations"))
	migs, err := migrate.Load(dir)
	if err != nil {
		fail(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	var conn *pgx.Conn
	// Postgres may still be starting under docker compose: retry briefly.
	for i := 0; ; i++ {
		conn, err = pgx.Connect(ctx, env.PostgresURL())
		if err == nil {
			break
		}
		if i >= 30 {
			fail(err)
		}
		time.Sleep(time.Second)
	}
	defer conn.Close(context.Background())
	done, err := migrate.Apply(ctx, conn, migs)
	if err != nil {
		fail(err)
	}
	if len(done) == 0 {
		fmt.Println("migrate: up to date")
	}
	for _, n := range done {
		fmt.Println("migrate: applied", n)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "migrate:", err)
	os.Exit(1)
}
