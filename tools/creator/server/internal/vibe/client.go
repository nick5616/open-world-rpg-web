// Package vibe is the optional, last-resort "vibe text" path of spec 6: one
// call to a small Claude model whose output is constrained to the WorldSpec
// schema, then the same normalize gate as every other spec (structural
// validation -> clamp -> strict validation), at most one retry, and a cache
// keyed by sha256(normalized prompt + specVersion).
//
// Pillar 10: generative AI is the last resort and the game works fully
// without it. Nothing in this package is constructed unless the operator set
// LODESTONE_CREATOR_LLM=1 *and* ANTHROPIC_API_KEY (see New); with the flag
// off the creator has no model client at all, which the api tests prove by
// counting requests on an injected transport. It never runs for players, at
// runtime or per chunk: only the creator tool's endpoint calls it, and only
// the clamped name and enum fields of a validated spec can reach players.
package vibe

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Defaults for the Messages API call.
const (
	DefaultModel   = "claude-haiku-5-5" // a small model is plenty for ~35 numbers
	DefaultBaseURL = "https://api.anthropic.com"
	// APIVersion is the anthropic-version header. 2026-10-21 rejects sampling
	// parameters, which this request never sends.
	APIVersion = "2026-10-21"
	// MaxTokens leaves room for adaptive thinking (on by default on Haiku 5.5)
	// plus a ~1.5 KB JSON object.
	MaxTokens = 8000
)

// ErrDisabled means the LLM path is off (flag unset or no API key).
var ErrDisabled = errors.New("vibe text is disabled (set LODESTONE_CREATOR_LLM=1 and ANTHROPIC_API_KEY on the creator server)")

// Config enables and points the model client.
type Config struct {
	Enabled bool   // LODESTONE_CREATOR_LLM=1
	APIKey  string // ANTHROPIC_API_KEY
	Model   string
	BaseURL string // tests point this at a fake Messages API
	// HTTP is injectable so tests use a fake server; nil = a client with a
	// 60 s timeout.
	HTTP *http.Client
}

// Client makes the one Messages API call.
type Client struct {
	cfg    Config
	schema map[string]any
}

// NewClient builds the model client. It refuses to exist when the flag is
// off or the key is missing, so a disabled creator cannot hold one.
func NewClient(cfg Config, modelSchema map[string]any) (*Client, error) {
	if !cfg.Enabled || strings.TrimSpace(cfg.APIKey) == "" {
		return nil, ErrDisabled
	}
	if cfg.Model == "" {
		cfg.Model = DefaultModel
	}
	if cfg.BaseURL == "" {
		cfg.BaseURL = DefaultBaseURL
	}
	if cfg.HTTP == nil {
		cfg.HTTP = &http.Client{Timeout: 60 * time.Second}
	}
	return &Client{cfg: cfg, schema: modelSchema}, nil
}

// Model is the model id in use (for logs and /v1/config).
func (c *Client) Model() string { return c.cfg.Model }

// systemPrompt is fixed (no timestamps or ids) so the prefix stays cacheable
// across calls. It explains what the numbers mean; the schema constrains the
// shape. The model cannot inject prose that reaches players: every string it
// returns is an enum except `name`, which is cleaned and blocklisted.
const systemPrompt = `You fill in a WorldSpec: the parameters of a procedurally generated open-world RPG map (a 4 km square island world of meadows, forests, highlands, snowpeaks, badlands and wetlands, with caves, gems, towns, structures and demons at night). A creator describes the world they want in a few words; reply with the WorldSpec that best matches it.

Field guide (all numbers are plain decimals):
- seaLevel 0..1 (higher = more water), landFraction 0.3..0.9 (share of the map that is land; archipelagos ~0.35, continents ~0.8), mountainHeight 0..1, roughness 0..1, plateaus 0..1 (mesas and terraces), riverDensity 0..1.
- temperatureBias -1..1 (cold to hot), moistureBias -1..1 (dry to wet), windDirection 0..359 degrees the prevailing wind comes from, stormFrequency 0..1.
- biomeWeights: meadow, forest, highlands, snowpeak, badlands, wetland, each 0..1; only their ratios matter, so give the dominant biome 1 and the rest in proportion.
- elementWeights: fire, ice, lightning, earth, wind, light, dark, void, each 0..1; the elemental character of the rocks and gems; void should stay low unless asked for.
- caveDensity 0..1, caveMaxDepth 64..256 meters, gemRarityCurve 0.5..3 (higher = gems rarer near the surface), oreAbundance 0..1.
- dangerCurve 0..1 (how fast difficulty rises away from spawn), enemyDensity 0..1, demonIntensity 0..1 (how dangerous nights are).
- flammability 0..1, nightLength 0.2..0.6 of a day, settlementDensity 0..1, structureDensity 0..1.
- palette, lootThemes (up to 4) and nameGrammar must use the listed values only.
- name: an original world name of 3 to 40 characters using only letters, digits, spaces, apostrophes and hyphens. Never use names, places or terms from existing games, books or films.
- specVersion is 1. seed: write "0" (the tool sets the real seed).

Keep values moderate unless the description clearly asks for an extreme: the world must stay playable.`

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type request struct {
	Model        string         `json:"model"`
	MaxTokens    int            `json:"max_tokens"`
	System       string         `json:"system"`
	Messages     []message      `json:"messages"`
	OutputConfig map[string]any `json:"output_config"`
}

type response struct {
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	StopReason string `json:"stop_reason"`
	Error      *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

// Generate asks the model for a WorldSpec matching prompt and returns the
// raw JSON object it produced (unvalidated: the caller normalizes it).
//
// Structured output: output_config.format with the WorldSpec JSON schema
// (minus the keywords the API cannot enforce; spec.Gate.ModelSchema). We use
// that rather than a forced tool call because forced tool_choice is being
// removed from newer models, and JSON output needs no tool round trip.
func (c *Client) Generate(ctx context.Context, prompt string) ([]byte, error) {
	body, err := json.Marshal(request{
		Model:     c.cfg.Model,
		MaxTokens: MaxTokens,
		System:    systemPrompt,
		Messages:  []message{{Role: "user", Content: "Describe-a-world request from the creator:\n<description>\n" + prompt + "\n</description>"}},
		OutputConfig: map[string]any{
			"effort": "low",
			"format": map[string]any{"type": "json_schema", "schema": c.schema},
		},
	})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.cfg.BaseURL, "/")+"/v1/messages", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-api-key", c.cfg.APIKey)
	req.Header.Set("anthropic-version", APIVersion)
	resp, err := c.cfg.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("messages api: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	var r response
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("messages api: status %d, unreadable body", resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		msg := http.StatusText(resp.StatusCode)
		if r.Error != nil {
			msg = r.Error.Type + ": " + r.Error.Message
		}
		return nil, fmt.Errorf("messages api: status %d: %s", resp.StatusCode, msg)
	}
	// A refusal or a cut-off answer may not match the schema; treat both as
	// failures rather than reading content.
	switch r.StopReason {
	case "end_turn", "stop_sequence":
	default:
		return nil, fmt.Errorf("messages api: stop_reason %q", r.StopReason)
	}
	for _, b := range r.Content {
		if b.Type == "text" && strings.TrimSpace(b.Text) != "" {
			return []byte(b.Text), nil
		}
	}
	return nil, errors.New("messages api: no text block in the response")
}
