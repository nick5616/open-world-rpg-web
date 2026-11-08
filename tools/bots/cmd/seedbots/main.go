// Command seedbots inserts the bots' characters into a (scratch) database so
// zones checkpoint them like real characters (WP16 soak: failover reloads
// the last checkpoint, handoffs fence checkpoints by epoch, progress is
// saved). Reads `go run ./tools/bots -print-characters -n N` JSON on stdin.
//
//	go run ./tools/bots -print-characters -n 1000 | LODESTONE_PG_URL=... go run ./tools/bots/cmd/seedbots
//	LODESTONE_PG_URL=... go run ./tools/bots/cmd/seedbots -move "Alyssa:2023,1500;Bruno:2023,1504"   (place characters by name)
//
// Refuses databases whose name does not start with lodestone_wp (scratch
// databases only; the shared dev database is never seeded with bots).
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"lodestone/server/pkg/env"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "seedbots:", err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) == 3 && os.Args[1] == "-move" {
		return move(os.Args[2])
	}
	var chars []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(os.Stdin).Decode(&chars); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	pool, err := pgxpool.New(ctx, env.PostgresURL())
	if err != nil {
		return err
	}
	defer pool.Close()
	var db string
	if err := pool.QueryRow(ctx, `SELECT current_database()`).Scan(&db); err != nil {
		return err
	}
	if !strings.HasPrefix(db, "lodestone_wp") {
		return fmt.Errorf("refusing to seed bots into %q (scratch databases lodestone_wp* only)", db)
	}
	var world string
	if err := pool.QueryRow(ctx, `SELECT id::text FROM worlds WHERE official ORDER BY created_at LIMIT 1`).Scan(&world); err != nil {
		return fmt.Errorf("official world: %w (mint it first)", err)
	}
	var account string
	err = pool.QueryRow(ctx, `INSERT INTO accounts (auth_provider, auth_subject) VALUES ('dev', 'wp16-bots')
		ON CONFLICT (auth_provider, auth_subject) DO UPDATE SET status = 'active' RETURNING id::text`).Scan(&account)
	if err != nil {
		return err
	}
	rows := make([][]any, len(chars))
	for i, c := range chars {
		// WP04's creation placeholder: the zone treats it as never saved.
		rows[i] = []any{c.ID, account, world, c.Name, `{"x":2048,"y":0,"z":2048}`}
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `CREATE TEMP TABLE seed (id uuid, account_id uuid, world_id uuid, name text, position jsonb) ON COMMIT DROP`); err != nil {
		return err
	}
	if _, err := tx.CopyFrom(ctx, pgx.Identifier{"seed"}, []string{"id", "account_id", "world_id", "name", "position"}, pgx.CopyFromRows(rows)); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `INSERT INTO characters (id, account_id, world_id, name, position)
		SELECT id, account_id, world_id, name, position FROM seed ON CONFLICT (id) DO NOTHING`)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	fmt.Printf("seeded %d bot characters (%d new) into %s, world %s\n", len(chars), tag.RowsAffected(), db, world)
	return nil
}

// move sets characters' saved positions by name (y 0: the zone lifts them
// onto the ground when they join). Scratch databases only.
func move(spec string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, env.PostgresURL())
	if err != nil {
		return err
	}
	defer pool.Close()
	var db string
	if err := pool.QueryRow(ctx, `SELECT current_database()`).Scan(&db); err != nil {
		return err
	}
	if !strings.HasPrefix(db, "lodestone_wp") {
		return fmt.Errorf("refusing to move characters in %q (scratch databases lodestone_wp* only)", db)
	}
	for _, part := range strings.Split(spec, ";") {
		name, xz, ok := strings.Cut(part, ":")
		var x, z float64
		if _, err := fmt.Sscanf(xz, "%g,%g", &x, &z); !ok || err != nil {
			return fmt.Errorf("bad -move entry %q (Name:x,z)", part)
		}
		pos, _ := json.Marshal(map[string]float64{"x": x, "y": 0, "z": z})
		tag, err := pool.Exec(ctx, `UPDATE characters SET position = $2::jsonb WHERE name_lower = lower($1)`, name, pos)
		if err != nil {
			return err
		}
		fmt.Printf("moved %s to %.1f,%.1f (%d rows)\n", name, x, z, tag.RowsAffected())
	}
	return nil
}
