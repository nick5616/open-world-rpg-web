package main

// WP11: builds the proximity-voice service (server/social/voice) from env.
//
//	LODESTONE_LIVEKIT_URL        ws://localhost:7880  what browsers connect to (sent in voice_token)
//	LODESTONE_LIVEKIT_API_URL    derived (ws -> http)  server API base, if the SFU is reached differently from here
//	LODESTONE_LIVEKIT_KEY        devkey   (LiveKit --dev)
//	LODESTONE_LIVEKIT_SECRET     secret   (LiveKit --dev; refused in production)
//	LODESTONE_VOICE              0 disables voice (voice_token answers "not available")
//	LODESTONE_VOICE_LOCAL_LISTEN_ONLY  1 = local profiles hear but cannot talk (WP11's rule; default 0 since playtest 2)

import (
	"fmt"

	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/accountapi"
	"lodestone/server/pkg/env"
	"lodestone/server/pkg/svc"
	"lodestone/server/social/internal/social"
	"lodestone/server/social/voice"
)

func newVoice(publicURL string, rdb *redis.Client, hub *social.Hub, s *svc.Server) (*voice.Service, error) {
	if !env.Bool("LODESTONE_VOICE", true) || publicURL == "" {
		s.Log.Info("voice disabled")
		return nil, nil
	}
	key := env.Str("LODESTONE_LIVEKIT_KEY", "devkey")
	secret := env.Str("LODESTONE_LIVEKIT_SECRET", "secret")
	if secret == "secret" {
		if accountapi.IsProduction() {
			// LiveKit's --dev secret is public: anyone could mint join tokens.
			return nil, fmt.Errorf("LODESTONE_LIVEKIT_SECRET must be set in production")
		}
		s.Log.Warn("using LiveKit's development key/secret (LiveKit --dev); set LODESTONE_LIVEKIT_KEY/_SECRET for any shared deployment")
	}
	cfg := voice.Config{
		PublicURL: publicURL,
		APIKey:    key,
		APISecret: secret,
		APIBase:   env.Str("LODESTONE_LIVEKIT_API_URL", ""),
	}
	s.Log.Info("voice enabled", "livekit", publicURL)
	return voice.New(cfg, rdb, hub.VoiceHost(), s.Log, s.Metrics, hub.Node()), nil
}
