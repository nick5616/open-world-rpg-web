// Command admin is the moderation CLI (spec 10: mute, suspend and ban
// accounts, read reports; no admin UI in v1). It talks to Postgres directly
// and notifies live social sessions through Redis, so a ban takes effect
// immediately, not at next login.
//
//	go run ./server/social/cmd/admin reports [-all] [-n 20]
//	go run ./server/social/cmd/admin report <id>
//	go run ./server/social/cmd/admin resolve <id> "<resolution>"
//	go run ./server/social/cmd/admin mute|unmute|suspend|ban|unban <characterName> [-world <id>] [-reason "..."]
//	go run ./server/social/cmd/admin whois <characterName> [-world <id>]
//
// Actions land on the character's owner: the account (accounts.status, which
// the director also enforces at connect) or, for local profiles, the profile
// (social_sanctions). Every action is written to moderation_log.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/user"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/env"
	"lodestone/server/social/internal/social"
)

func usage() {
	fmt.Fprintln(os.Stderr, `usage: admin <command> [args]
  reports [-all] [-n 20]                 list open reports (all with -all)
  report <id>                            show a report with its captured messages
  resolve <id> "<resolution>"            close a report
  mute|unmute|suspend|ban|unban <name> [-world <uuid>] [-reason "..."]
  whois <name> [-world <uuid>]           show who owns a character and their status`)
	os.Exit(2)
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	cmd, args := os.Args[1], os.Args[2:]
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	world := fs.String("world", "", "world id (default: any world)")
	reason := fs.String("reason", "", "reason, recorded in moderation_log")
	all := fs.Bool("all", false, "include resolved reports")
	n := fs.Int("n", 20, "how many reports")
	// Positional arguments first, flags after (admin ban Troll -reason spam).
	var pos []string
	for len(args) > 0 && len(args[0]) > 0 && args[0][0] != '-' {
		pos, args = append(pos, args[0]), args[1:]
	}
	_ = fs.Parse(args)
	pos = append(pos, fs.Args()...)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, env.PostgresURL())
	if err != nil {
		fail(err)
	}
	defer pool.Close()
	rdb := redis.NewClient(&redis.Options{Addr: env.RedisAddr()})
	defer rdb.Close()
	actor := "admin-cli"
	if u, err := user.Current(); err == nil {
		actor = u.Username
	}
	a := &social.Admin{Store: &social.Store{Pool: pool}, RDB: rdb, Actor: actor}

	switch cmd {
	case "reports":
		rows, err := a.Reports(ctx, !*all, *n)
		if err != nil {
			fail(err)
		}
		if len(rows) == 0 {
			fmt.Println("no reports")
		}
		for _, r := range rows {
			state := "open"
			if r.Resolution != "" {
				state = "resolved: " + r.Resolution
			}
			fmt.Printf("%s  %s  %-8s %s -> %s  %q  [%s]\n", r.ID, r.CreatedAt.Format(time.RFC3339), r.Channel, r.ReporterName, r.ReportedName, r.Reason, state)
		}
	case "report":
		if len(pos) != 1 {
			usage()
		}
		r, err := a.Report(ctx, pos[0])
		if err != nil {
			fail(err)
		}
		var c struct {
			Region   string `json:"region"`
			Messages []struct {
				Channel, FromName, ToName, Text string
				Ts                              float64
			} `json:"messages"`
		}
		_ = json.Unmarshal(r.Context, &c)
		fmt.Printf("report %s (%s)\n  channel %s, region %q\n  %s reported %s (%s): %q\n  resolution: %q\n  context (%d messages):\n",
			r.ID, r.CreatedAt.Format(time.RFC3339), r.Channel, c.Region, r.ReporterName, r.ReportedName, r.ReportedID, r.Reason, r.Resolution, len(c.Messages))
		for _, m := range c.Messages {
			to := ""
			if m.ToName != "" {
				to = " -> " + m.ToName
			}
			fmt.Printf("    %s  %s%s: %s\n", time.UnixMilli(int64(m.Ts)).Format("15:04:05"), m.FromName, to, m.Text)
		}
	case "resolve":
		if len(pos) != 2 {
			usage()
		}
		if err := a.Resolve(ctx, pos[0], pos[1]); err != nil {
			fail(err)
		}
		fmt.Println("resolved", pos[0])
	case "mute", "unmute", "suspend", "ban", "unban":
		if len(pos) != 1 {
			usage()
		}
		s, err := a.Apply(ctx, cmd, *world, pos[0], *reason)
		if err != nil {
			fail(err)
		}
		fmt.Printf("%s %s: %s %s is now %s\n", cmd, s.CharacterName, s.Kind, s.ID, s.Status)
	case "whois":
		if len(pos) != 1 {
			usage()
		}
		s, err := a.ResolveSubject(ctx, *world, pos[0])
		if err != nil {
			fail(err)
		}
		fmt.Printf("%s (character %s, world %s): %s %s, status %s\n", s.CharacterName, s.CharacterID, s.WorldID, s.Kind, s.ID, s.Status)
	default:
		usage()
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "admin:", err)
	os.Exit(1)
}
