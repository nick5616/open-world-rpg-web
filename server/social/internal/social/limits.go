package social

import (
	"time"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/ratelimit"
	sp "lodestone/server/pkg/socialproto"
)

// Per-session token buckets (spec 10 moderation), the-circle's
// consumers.py pattern via server/pkg/ratelimit: there each socket had
// chat_bucket = Bucket(8, 1); here every channel gets its own bucket so a
// burst in party chat cannot starve a whisper, and global gets slow mode.
//
// Why these numbers: people type at most about one line per 2 s sustained;
// a burst lets someone paste three quick lines ("wait" / "no" / "left!")
// without hitting a wall. Anything faster than the refill is a script.
type limits struct {
	frames   ratelimit.Bucket // every inbound frame, the cheap first gate
	global   ratelimit.Bucket // slow mode: 1 per GLOBAL_SLOW_MODE_MS, no burst
	zone     ratelimit.Bucket
	local    ratelimit.Bucket
	party    ratelimit.Bucket
	whisper  ratelimit.Bucket
	social   ratelimit.Bucket // invites, friend requests, block/mute: each touches Postgres or Redis transactions
	report   ratelimit.Bucket
	presence ratelimit.Bucket
}

// LimitConfig lets tests and the flood tool see the configured numbers.
type LimitConfig struct {
	FramesBurst, FramesPerS     float64
	ZoneBurst, ZonePerS         float64
	LocalBurst, LocalPerS       float64
	PartyBurst, PartyPerS       float64
	WhisperBurst, WhisperPerS   float64
	SocialBurst, SocialPerS     float64
	ReportBurst, ReportPerS     float64
	PresenceBurst, PresencePerS float64
	GlobalSlowMode              time.Duration
}

// DefaultLimits are the production numbers.
func DefaultLimits() LimitConfig {
	return LimitConfig{
		// 30 frames burst / 15 per s covers presence at 2 Hz plus pings plus
		// chat with plenty of headroom; past that the client is broken or hostile.
		FramesBurst: 30, FramesPerS: 15,
		ZoneBurst: 4, ZonePerS: 0.5,
		LocalBurst: 5, LocalPerS: 1,
		PartyBurst: 8, PartyPerS: 1, // the-circle's chat bucket
		WhisperBurst: 5, WhisperPerS: 1,
		SocialBurst: 10, SocialPerS: 0.5,
		ReportBurst: 3, ReportPerS: 1.0 / 60,
		// The client sends presence at 2 Hz; extra frames are dropped silently
		// (latest wins), never answered with an error.
		PresenceBurst: 6, PresencePerS: 4,
		GlobalSlowMode: constants.GlobalSlowModeMs * time.Millisecond,
	}
}

func newLimits(c LimitConfig) limits {
	return limits{
		frames:   ratelimit.New(c.FramesBurst, c.FramesPerS),
		global:   ratelimit.New(1, 1/c.GlobalSlowMode.Seconds()),
		zone:     ratelimit.New(c.ZoneBurst, c.ZonePerS),
		local:    ratelimit.New(c.LocalBurst, c.LocalPerS),
		party:    ratelimit.New(c.PartyBurst, c.PartyPerS),
		whisper:  ratelimit.New(c.WhisperBurst, c.WhisperPerS),
		social:   ratelimit.New(c.SocialBurst, c.SocialPerS),
		report:   ratelimit.New(c.ReportBurst, c.ReportPerS),
		presence: ratelimit.New(c.PresenceBurst, c.PresencePerS),
	}
}

// chat returns the bucket for a chat channel and the error code to send
// when it is empty.
func (l *limits) chat(ch sp.Channel) (*ratelimit.Bucket, sp.ErrorCode) {
	switch ch {
	case sp.ChannelGlobal:
		return &l.global, sp.ErrorCodeSlowMode
	case sp.ChannelZone:
		return &l.zone, sp.ErrorCodeRateLimited
	case sp.ChannelLocal:
		return &l.local, sp.ErrorCodeRateLimited
	case sp.ChannelParty:
		return &l.party, sp.ErrorCodeRateLimited
	case sp.ChannelWhisper:
		return &l.whisper, sp.ErrorCodeRateLimited
	}
	return nil, sp.ErrorCodeNotAllowed
}
