package main

import (
	"log/slog"

	"lodestone/server/pkg/env"
)

// devConsole reads LODESTONE_ZONE_DEV (playtest 2 dev console, CR 032;
// internal/game/devconsole.go): the zone takes the console's cheats only
// with it set to 1, which scripts/dev.mjs does for `npm run dev` and no
// deploy ever does (devconsole_test.go reads infra/ to keep it so). As a
// second lock it needs the insecure development ticket key too: a zone that
// verifies real tickets (LODESTONE_TICKET_PUBLIC_KEY set, every deploy)
// refuses dev mode even if the variable leaks into its environment.
func devConsole(log *slog.Logger, devKey bool) bool {
	return devConsoleFrom(env.Bool("LODESTONE_ZONE_DEV", false), devKey, log)
}

func devConsoleFrom(flag, devKey bool, log *slog.Logger) bool {
	if !flag {
		return false
	}
	if !devKey {
		log.Error("LODESTONE_ZONE_DEV=1 ignored: this zone verifies real tickets (LODESTONE_TICKET_PUBLIC_KEY), the dev console is for local development only")
		return false
	}
	log.Warn("DEV CONSOLE ON (LODESTONE_ZONE_DEV=1): clients may give items, teleport, spawn enemies and change the world; never on a shared server")
	return true
}
