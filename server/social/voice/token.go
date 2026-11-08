// Package voice is the social service's half of proximity voice (spec 10
// "Proximity voice", WP11): LiveKit join tokens for `voice_token`, and the
// reconciler that turns the zones' earshot sets (lodestone/server/pkg/earshot)
// plus parties, blocks and mutes into LiveKit subscriptions, with
// auto-subscribe off. It talks to LiveKit's server API (Twirp over HTTP with
// JSON bodies) directly instead of through the LiveKit Go SDK: we need three
// calls and an HS256 JWT, and the SDK would pull pion/WebRTC and gRPC into
// the social service.
package voice

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// VideoGrant is LiveKit's grant object (the JWT "video" claim). Field names
// are LiveKit's (livekit/protocol auth.VideoGrant).
type VideoGrant struct {
	RoomCreate           bool     `json:"roomCreate,omitempty"`
	RoomList             bool     `json:"roomList,omitempty"`
	RoomAdmin            bool     `json:"roomAdmin,omitempty"`
	RoomJoin             bool     `json:"roomJoin,omitempty"`
	Room                 string   `json:"room,omitempty"`
	CanPublish           *bool    `json:"canPublish,omitempty"`
	CanSubscribe         *bool    `json:"canSubscribe,omitempty"`
	CanPublishData       *bool    `json:"canPublishData,omitempty"`
	CanPublishSources    []string `json:"canPublishSources,omitempty"`
	CanUpdateOwnMetadata *bool    `json:"canUpdateOwnMetadata,omitempty"`
}

type claims struct {
	Issuer    string     `json:"iss"`
	Subject   string     `json:"sub,omitempty"`
	ID        string     `json:"jti,omitempty"`
	NotBefore int64      `json:"nbf"`
	Expires   int64      `json:"exp"`
	Name      string     `json:"name,omitempty"`
	Video     VideoGrant `json:"video"`
}

func ptr(b bool) *bool { return &b }

// signJWT makes an HS256 JWT LiveKit accepts (api key as issuer, secret as
// the HMAC key).
func signJWT(apiKey, secret string, c claims) (string, error) {
	if apiKey == "" || secret == "" {
		return "", errors.New("voice: LiveKit api key/secret not configured")
	}
	c.Issuer = apiKey
	head := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	body, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	msg := head + "." + base64.RawURLEncoding.EncodeToString(body)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(msg))
	return msg + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

// JoinToken is a participant token for one world's room.
//
//   - identity = character id: the zones' earshot sets name players by
//     character id, so subscriptions map 1:1 with no lookup.
//   - name = character name: the client matches a speaker to the zone entity
//     it interpolates by name (zone first-sight records carry names, not
//     character ids).
//   - canPublish false = listen-only (local profiles, spec 10/11, and players
//     muted by a moderator). Publishing is limited to the microphone.
//   - canSubscribe is true because LiveKit refuses server-side subscriptions
//     for a participant without it. The client connects with autoSubscribe
//     off and never subscribes itself; the server decides (see STATUS for the
//     gap: a modified client could subscribe to tracks on its own).
//   - canPublishData false: voice needs no data channel, and chat already has
//     its moderated path.
func JoinToken(apiKey, secret, room, identity, name string, canPublish bool, ttl time.Duration, now time.Time) (string, error) {
	g := VideoGrant{
		RoomJoin:             true,
		Room:                 room,
		CanPublish:           ptr(canPublish),
		CanSubscribe:         ptr(true),
		CanPublishData:       ptr(false),
		CanUpdateOwnMetadata: ptr(false),
	}
	if canPublish {
		g.CanPublishSources = []string{"microphone"}
	}
	return signJWT(apiKey, secret, claims{
		Subject: identity, ID: identity, Name: name,
		NotBefore: now.Add(-10 * time.Second).Unix(), // tolerate small clock skew with the SFU
		Expires:   now.Add(ttl).Unix(),
		Video:     g,
	})
}

// adminToken authorizes server API calls on one room (short-lived; minted
// per call batch).
func adminToken(apiKey, secret, room string, now time.Time) (string, error) {
	return signJWT(apiKey, secret, claims{
		NotBefore: now.Add(-10 * time.Second).Unix(),
		Expires:   now.Add(5 * time.Minute).Unix(),
		Video:     VideoGrant{RoomAdmin: true, RoomList: true, RoomCreate: true, Room: room},
	})
}

// RoomName is the one LiveKit room per world (spec 10 "Proximity voice" 6:
// shard by region only if the soak shows participant fan-out is the
// bottleneck; see docs/decisions/0011-proximity-voice.md).
func RoomName(worldID string) string { return "world-" + worldID }

// APIURL turns the client-facing LiveKit URL (ws:// or wss://) into the
// server API base (http:// or https://).
func APIURL(u string) string {
	switch {
	case strings.HasPrefix(u, "wss://"):
		return "https://" + strings.TrimPrefix(u, "wss://")
	case strings.HasPrefix(u, "ws://"):
		return "http://" + strings.TrimPrefix(u, "ws://")
	}
	return u
}
