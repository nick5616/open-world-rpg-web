// Package earshot is the zone -> social message that carries proximity-voice
// earshot sets (spec 10 "Proximity voice" 1, WP11). Zones compute who can hear
// whom every EARSHOT_INTERVAL_MS and publish it here; the social service's
// voice leader turns the sets into LiveKit subscriptions. CR 003 documents it.
//
// Wire: one JSON object per Redis pub/sub message on Channel(worldID):
//
//	{"v":1,"zone":"zone-dev-1","seq":42,"t":1762600000123.4,"full":false,
//	 "sets":{"<listener charId>":["<speaker charId>", ...]},
//	 "gone":["<charId>"]}
//
// Fields:
//   - sets: listener -> the speakers they should hear, sorted by id. A
//     listener with nobody in earshot is present with an empty list when
//     that changed (and in every full message).
//   - full: true on every FullEvery-th message; sets then lists EVERY player
//     the zone owns, and the receiver drops any listener it attributed to
//     this zone that is missing. Pub/sub is fire-and-forget, so this bounds
//     how long a lost delta can leave a subscription wrong (2 s).
//   - full false: only listeners whose set changed since the previous
//     message. No change, no message.
//   - gone: players who left this zone since the previous message.
//   - t: server Unix milliseconds when the positions were taken (latency
//     metrics: the receiver measures apply time - t).
//
// Why a dedicated channel and not the social bus (social:{worldId}, spec 11):
// every social process decodes every bus envelope, but only one process per
// world (the voice leader) needs earshot sets, and at 4 Hz per zone they are
// the largest stream in the system. Party members are NOT in these sets: the
// social service owns parties and adds them (spec 10 "Proximity voice" 2).
package earshot

import "lodestone/server/pkg/constants"

// Version is Message.V; receivers ignore other versions.
const Version = 1

// FullEvery: one full message per this many intervals (8 x 250 ms = 2 s).
const FullEvery = 8

// StaleAfterMs: a receiver drops a zone's sets when it has heard nothing from
// it for this long (zone crashed or shut down without a final message).
const StaleAfterMs = 3 * FullEvery * constants.EarshotIntervalMs

// Message is one earshot publication.
type Message struct {
	V    int                 `json:"v"`
	Zone string              `json:"zone"`
	Seq  uint64              `json:"seq"`
	T    float64             `json:"t"`
	Full bool                `json:"full,omitempty"`
	Sets map[string][]string `json:"sets"`
	Gone []string            `json:"gone,omitempty"`
}

// Channel is the Redis pub/sub channel for a world's earshot sets.
func Channel(worldID string) string { return "voice:" + worldID }
