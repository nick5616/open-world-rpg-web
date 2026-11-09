package main

// Playtest 2 (CR 019): duel results in party chat. The zone posts a system
// line through the social service's bus (the same envelope as the
// Bitchin' announcement, items.go), addressed to the party members it hosts.

import (
	"context"
	"encoding/json"
	"log/slog"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/env"
	"lodestone/server/pkg/socialproto"
)

// partyChat returns the game.Config.PartyChat hook (nil without Redis).
func partyChat(worldID string, log *slog.Logger) func(targets []string, text string) {
	if env.Bool("LODESTONE_ZONE_NO_REDIS", false) {
		return nil
	}
	rdb := redis.NewClient(&redis.Options{Addr: env.RedisAddr()})
	return func(targets []string, text string) {
		if len(targets) == 0 {
			return
		}
		e := map[string]any{"k": "chat", "w": worldID, "t": targets, "m": socialproto.ChatMessage{
			ID: "duel-" + strconv.FormatInt(time.Now().UnixNano(), 36), Channel: socialproto.ChannelParty, FromName: "Duel", Text: text,
			Ts: float64(time.Now().UnixMilli())}}
		b, _ := json.Marshal(e)
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			if err := rdb.Publish(ctx, "social:"+worldID, b).Err(); err != nil {
				log.Warn("duel result not posted to party chat", "err", err)
			}
		}()
	}
}
