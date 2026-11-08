package voice

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Participant is what the reconciler needs from LiveKit's ParticipantInfo.
type Participant struct {
	Sid      string
	Identity string
	Name     string
	// AudioTracks are the sids of the participant's published audio tracks
	// (one microphone in practice).
	AudioTracks []string
}

// API is the slice of LiveKit's RoomService the reconciler uses. LiveKit
// implements it over HTTP; tests use a fake.
type API interface {
	ListParticipants(ctx context.Context, room string) ([]Participant, error)
	UpdateSubscriptions(ctx context.Context, room, identity string, trackSids []string, subscribe bool) error
}

// LiveKit calls RoomService over Twirp with JSON bodies:
// POST {base}/twirp/livekit.RoomService/{Method}, Authorization: Bearer
// <admin JWT for the room>.
type LiveKit struct {
	BaseURL   string // http(s)://host:7880
	APIKey    string
	APISecret string
	HTTP      *http.Client
}

// NewLiveKit builds a client with a short timeout: a reconcile pass must not
// hang on a stuck SFU (the next pass retries).
func NewLiveKit(baseURL, key, secret string) *LiveKit {
	return &LiveKit{BaseURL: strings.TrimRight(baseURL, "/"), APIKey: key, APISecret: secret,
		HTTP: &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{MaxIdleConnsPerHost: 32}}}
}

func (lk *LiveKit) call(ctx context.Context, room, method string, req, resp any) error {
	tok, err := adminToken(lk.APIKey, lk.APISecret, room, time.Now())
	if err != nil {
		return err
	}
	body, err := json.Marshal(req)
	if err != nil {
		return err
	}
	r, err := http.NewRequestWithContext(ctx, http.MethodPost, lk.BaseURL+"/twirp/livekit.RoomService/"+method, bytes.NewReader(body))
	if err != nil {
		return err
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+tok)
	res, err := lk.HTTP.Do(r)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	if err != nil {
		return err
	}
	if res.StatusCode != http.StatusOK {
		var te struct {
			Code string `json:"code"`
			Msg  string `json:"msg"`
		}
		_ = json.Unmarshal(b, &te)
		return &TwirpError{Status: res.StatusCode, Code: te.Code, Msg: te.Msg}
	}
	if resp == nil {
		return nil
	}
	return json.Unmarshal(b, resp)
}

// TwirpError is a non-200 answer from LiveKit.
type TwirpError struct {
	Status    int
	Code, Msg string
}

func (e *TwirpError) Error() string {
	return fmt.Sprintf("livekit: %d %s: %s", e.Status, e.Code, e.Msg)
}

// NotFound reports whether LiveKit said the room or participant does not
// exist (the room is created on first join and closed when empty).
func NotFound(err error) bool {
	te, ok := err.(*TwirpError)
	return ok && (te.Code == "not_found" || te.Status == http.StatusNotFound)
}

// enum decodes a protobuf enum that protojson may write as a name ("AUDIO")
// or a number (1), depending on server options.
type enum string

func (e *enum) UnmarshalJSON(b []byte) error {
	if len(b) > 0 && b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*e = enum(s)
		return nil
	}
	*e = enum(string(b))
	return nil
}

// ListParticipants returns everyone in the room (empty if it does not exist).
func (lk *LiveKit) ListParticipants(ctx context.Context, room string) ([]Participant, error) {
	var resp struct {
		Participants []struct {
			Sid      string `json:"sid"`
			Identity string `json:"identity"`
			Name     string `json:"name"`
			Tracks   []struct {
				Sid  string `json:"sid"`
				Type enum   `json:"type"` // AUDIO = 0 (omitted when default), VIDEO = 1, DATA = 2
			} `json:"tracks"`
		} `json:"participants"`
	}
	if err := lk.call(ctx, room, "ListParticipants", map[string]any{"room": room}, &resp); err != nil {
		if NotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	out := make([]Participant, 0, len(resp.Participants))
	for _, p := range resp.Participants {
		q := Participant{Sid: p.Sid, Identity: p.Identity, Name: p.Name}
		for _, t := range p.Tracks {
			// protojson omits a zero enum, so AUDIO arrives as "" or "0".
			if t.Type == "AUDIO" || t.Type == "" || t.Type == "0" {
				q.AudioTracks = append(q.AudioTracks, t.Sid)
			}
		}
		out = append(out, q)
	}
	return out, nil
}

// UpdateSubscriptions subscribes (or unsubscribes) one participant to tracks.
func (lk *LiveKit) UpdateSubscriptions(ctx context.Context, room, identity string, trackSids []string, subscribe bool) error {
	return lk.call(ctx, room, "UpdateSubscriptions", map[string]any{
		"room": room, "identity": identity, "track_sids": trackSids, "subscribe": subscribe,
	}, nil)
}
