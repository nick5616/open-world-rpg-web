// Command fakezone announces a pretend zone server in the Redis zone registry
// and keeps its heartbeat alive, so the director hands out tickets before a
// real zone (WP03) is running. It accepts no connections: use it for director
// and client account-flow work only.
//
//	go run ./server/director/cmd/fakezone                 # official world, whole map
//	go run ./server/director/cmd/fakezone -world <uuid> -zone z-test -endpoint ws://localhost:8092/ws
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

	"lodestone/server/pkg/env"
	"lodestone/server/pkg/zoneregistry"
)

func main() {
	world := flag.String("world", "", "world id (default: the official world in LODESTONE_PG_URL)")
	zone := flag.String("zone", "fake-zone-1", "zone id to announce")
	endpoint := flag.String("endpoint", fmt.Sprintf("ws://localhost:%d/ws", env.Int("LODESTONE_ZONE_PORT", env.DefaultZonePort)), "WebSocket endpoint to advertise")
	once := flag.Bool("once", false, "announce once and exit (the entry goes stale after 15 s)")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *world == "" {
		conn, err := pgx.Connect(ctx, env.PostgresURL())
		if err != nil {
			fail(err)
		}
		err = conn.QueryRow(ctx, `SELECT id::text FROM worlds WHERE official ORDER BY created_at LIMIT 1`).Scan(world)
		conn.Close(ctx)
		if err != nil {
			fail(fmt.Errorf("no official world (start the account service once): %w", err))
		}
	}
	rdb := redis.NewClient(&redis.Options{Addr: env.RedisAddr()})
	defer rdb.Close()
	e := zoneregistry.Entry{ZoneID: *zone, Endpoint: *endpoint}
	announce := func() {
		if err := zoneregistry.Announce(ctx, rdb, *world, e); err != nil {
			fmt.Fprintln(os.Stderr, "fakezone: announce:", err)
		}
	}
	announce()
	fmt.Printf("fakezone: announced zone %q for world %s at %s\n", *zone, *world, *endpoint)
	if *once {
		return
	}
	t := time.NewTicker(zoneregistry.HeartbeatEvery)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			announce()
		case <-ctx.Done():
			_ = zoneregistry.Remove(context.Background(), rdb, *world, *zone)
			fmt.Println("fakezone: removed")
			return
		}
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "fakezone:", err)
	os.Exit(1)
}
