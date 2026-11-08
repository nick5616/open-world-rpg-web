// Command e2ezones prepares the WP08 two-browser test: it announces two
// stand-in zones that split the world (zone-west owns region columns 0-1,
// zone-east 2-3) so the director hands two players tickets for DIFFERENT
// zones, and it can move a character so it spawns in the other half.
// Like the director's fakezone, the zones accept no connections; the social
// service only needs the zone id the client presents.
//
//	go run ./server/social/cmd/e2ezones announce            # until killed
//	go run ./server/social/cmd/e2ezones move -name Bob -x 500 -z 500
//
// Uses LODESTONE_PG_URL / LODESTONE_REDIS_ADDR and the official world.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/env"
	"lodestone/server/pkg/zoneregistry"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: e2ezones announce | move -name N -x X -z Z")
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	conn, err := pgx.Connect(ctx, env.PostgresURL())
	if err != nil {
		fail(err)
	}
	defer conn.Close(context.Background())
	var world string
	if err := conn.QueryRow(ctx, `SELECT id::text FROM worlds WHERE official ORDER BY created_at LIMIT 1`).Scan(&world); err != nil {
		fail(fmt.Errorf("no official world (start the account service once): %w", err))
	}

	switch os.Args[1] {
	case "move":
		fs := flag.NewFlagSet("move", flag.ExitOnError)
		name := fs.String("name", "", "character name")
		x := fs.Float64("x", 500, "x")
		z := fs.Float64("z", 500, "z")
		_ = fs.Parse(os.Args[2:])
		tag, err := conn.Exec(ctx, `UPDATE characters SET position = jsonb_build_object('x', $3::float8, 'y', 0, 'z', $4::float8)
			WHERE world_id = $1::uuid AND name_lower = lower($2)`, world, *name, *x, *z)
		if err != nil {
			fail(err)
		}
		fmt.Printf("moved %s to (%.0f, %.0f): %d row(s)\n", *name, *x, *z, tag.RowsAffected())
	case "announce":
		rdb := redis.NewClient(&redis.Options{Addr: env.RedisAddr()})
		defer rdb.Close()
		var west, east []zoneregistry.Region
		for rx := 0; rx < constants.WorldRegions; rx++ {
			for rz := 0; rz < constants.WorldRegions; rz++ {
				r := zoneregistry.Region{X: rx, Z: rz}
				if rx < constants.WorldRegions/2 {
					west = append(west, r)
				} else {
					east = append(east, r)
				}
			}
		}
		zones := []zoneregistry.Entry{
			{ZoneID: "zone-west", Endpoint: "ws://localhost:1/ws", Regions: west},
			{ZoneID: "zone-east", Endpoint: "ws://localhost:2/ws", Regions: east},
		}
		announce := func() {
			for _, z := range zones {
				if err := zoneregistry.Announce(ctx, rdb, world, z); err != nil {
					fmt.Fprintln(os.Stderr, "announce:", err)
				}
			}
		}
		announce()
		fmt.Printf("e2ezones: zone-west + zone-east announced for world %s\n", world)
		t := time.NewTicker(zoneregistry.HeartbeatEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				for _, z := range zones {
					_ = zoneregistry.Remove(context.Background(), rdb, world, z.ZoneID)
				}
				return
			case <-t.C:
				announce()
			}
		}
	default:
		fail(fmt.Errorf("unknown command %q", os.Args[1]))
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "e2ezones:", err)
	os.Exit(1)
}
