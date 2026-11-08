package game

import (
	"time"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/voice"
)

// Earshot takes each interval's player positions for proximity voice
// (WP11; voice.Runner in production). Offer must not block: it is called
// from the tick.
type Earshot interface {
	Offer(players []voice.Player, serverTimeMs float64) bool
}

const earshotInterval = time.Duration(constants.EarshotIntervalMs) * time.Millisecond

// earshotTick hands player positions to the earshot runner every
// EARSHOT_INTERVAL_MS (spec 10: 250 ms). The tick only copies positions
// (a few microseconds for hundreds of players); computing the sets and
// publishing them happens on the runner's goroutine. Confirmed positions
// (Move), not the extrapolated view: who hears whom should not depend on a
// guess about late input.
func (s *Server) earshotTick(now time.Time) {
	if s.cfg.Earshot == nil {
		return
	}
	if !s.earshotNext.IsZero() && now.Before(s.earshotNext) {
		return
	}
	// Keep the cadence (next = previous + interval) unless we fell more than
	// an interval behind (a stalled tick), then restart from now.
	if s.earshotNext.IsZero() || now.Sub(s.earshotNext) > earshotInterval {
		s.earshotNext = now
	}
	s.earshotNext = s.earshotNext.Add(earshotInterval)
	// A fresh slice every time: the runner owns it after Offer.
	ps := make([]voice.Player, 0, len(s.sessions))
	for _, e := range s.ents {
		if e.Kind != proto.EntityKindPlayer || e.CharacterID == "" {
			continue
		}
		ps = append(ps, voice.Player{ID: e.CharacterID, X: e.Move.Pos.X, Y: e.Move.Pos.Y, Z: e.Move.Pos.Z})
	}
	s.cfg.Earshot.Offer(ps, s.serverTimeMs())
}

// speakingActivity mirrors the client's InputFlag.speaking into the
// Activity.speaking bit others see (spec 10 "Proximity voice" 4: far players'
// nameplates show who is talking). Listen-only players (local profiles,
// spec 11) cannot transmit, so their bit is never shown.
func (e *Entity) speakingActivity() uint8 {
	if e.ListenOnly || e.lastFrame.Flags&proto.InputFlagSpeaking == 0 {
		return 0
	}
	return proto.ActivitySpeaking
}
