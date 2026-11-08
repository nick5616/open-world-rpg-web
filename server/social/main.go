// Command social: chat, whispers, parties, friends, presence, voice tokens (WP08).
//
// WP00 stub: it only serves /healthz and /metrics so `npm run dev` brings up
// every service (gate G0). The owning work package replaces this body.
package main

import (
	"os"

	"lodestone/server/pkg/env"
	"lodestone/server/pkg/svc"
)

func main() {
	s := svc.New("social", env.Addr("LODESTONE_SOCIAL_PORT", env.DefaultSocialPort))
	if err := s.Run(svc.CORS(env.Str("LODESTONE_CORS_ORIGIN", "*"), s.Mux), nil); err != nil {
		s.Log.Error("exit", "err", err)
		os.Exit(1)
	}
}
