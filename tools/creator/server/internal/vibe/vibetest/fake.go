// Package vibetest is a fake Anthropic Messages API for tests and the
// headless e2e run: no test ever calls the real API. It checks the request
// has the shape the creator promises (key header, version header, model,
// JSON-schema structured output) and answers with a WorldSpec built from
// keywords in the description, deliberately out of range in places (so the
// clamp shows up in evidence) and with one unknown loot tag (so tag dropping
// does too).
//
// Markers in the description script failures:
//
//	[fail-once]    first answer is schema-invalid, the retry is fine
//	[fail-always]  every answer is schema-invalid
//	[refuse]       stop_reason "refusal"
//	[http500]      HTTP 500 api_error
package vibetest

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
)

// Fake is an http.Handler serving POST /v1/messages.
type Fake struct {
	Requests atomic.Int64
	mu       sync.Mutex
	seen     map[string]int // per-description call count, for [fail-once]
	LastBody []byte
	// WantKey, when set, must match x-api-key.
	WantKey string
}

var descRe = regexp.MustCompile(`(?s)<description>\n(.*)\n</description>`)

func (f *Fake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.Requests.Add(1)
	if r.Method != http.MethodPost || r.URL.Path != "/v1/messages" {
		apiError(w, http.StatusNotFound, "not_found_error", "unknown route "+r.URL.Path)
		return
	}
	body, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	f.LastBody = body
	f.mu.Unlock()
	if r.Header.Get("x-api-key") == "" || (f.WantKey != "" && r.Header.Get("x-api-key") != f.WantKey) {
		apiError(w, http.StatusUnauthorized, "authentication_error", "invalid x-api-key")
		return
	}
	if r.Header.Get("anthropic-version") == "" {
		apiError(w, http.StatusBadRequest, "invalid_request_error", "anthropic-version header is required")
		return
	}
	var req struct {
		Model        string `json:"model"`
		MaxTokens    int    `json:"max_tokens"`
		Messages     []struct{ Role, Content string }
		OutputConfig struct {
			Format struct {
				Type   string         `json:"type"`
				Schema map[string]any `json:"schema"`
			} `json:"format"`
		} `json:"output_config"`
	}
	if err := json.Unmarshal(body, &req); err != nil || req.Model == "" || req.MaxTokens <= 0 || len(req.Messages) != 1 {
		apiError(w, http.StatusBadRequest, "invalid_request_error", "malformed request")
		return
	}
	if req.OutputConfig.Format.Type != "json_schema" || req.OutputConfig.Format.Schema["properties"] == nil {
		apiError(w, http.StatusBadRequest, "invalid_request_error", "expected output_config.format json_schema")
		return
	}
	m := descRe.FindStringSubmatch(req.Messages[0].Content)
	if m == nil {
		apiError(w, http.StatusBadRequest, "invalid_request_error", "no <description> in the user message")
		return
	}
	desc := m[1]
	f.mu.Lock()
	if f.seen == nil {
		f.seen = map[string]int{}
	}
	f.seen[desc]++
	n := f.seen[desc]
	f.mu.Unlock()

	switch {
	case strings.Contains(desc, "[http500]"):
		apiError(w, http.StatusInternalServerError, "api_error", "scripted failure")
		return
	case strings.Contains(desc, "[refuse]"):
		reply(w, "refusal", "")
		return
	case strings.Contains(desc, "[fail-always]"), strings.Contains(desc, "[fail-once]") && n == 1:
		reply(w, "end_turn", `{"specVersion":1,"name":"Half A World","seed":"0"}`)
		return
	}
	b, _ := json.Marshal(SpecFor(desc))
	reply(w, "end_turn", string(b))
}

func reply(w http.ResponseWriter, stop, text string) {
	content := []map[string]any{}
	if text != "" {
		content = append(content, map[string]any{"type": "text", "text": text})
	}
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"id": "msg_fake", "type": "message", "role": "assistant", "model": "claude-haiku-5-5",
		"content": content, "stop_reason": stop,
		"usage": map[string]int{"input_tokens": 900, "output_tokens": 400},
	})
}

func apiError(w http.ResponseWriter, status int, typ, msg string) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"type": "error", "error": map[string]string{"type": typ, "message": msg}})
}

// SpecFor builds a keyword-driven WorldSpec answer for a description.
func SpecFor(desc string) map[string]any {
	d := strings.ToLower(desc)
	has := func(words ...string) bool {
		for _, w := range words {
			if strings.Contains(d, w) {
				return true
			}
		}
		return false
	}
	s := map[string]any{
		"specVersion": 1, "name": nameFrom(desc), "seed": "0",
		"seaLevel": 0.45, "landFraction": 0.6, "mountainHeight": 0.6, "roughness": 0.5, "plateaus": 0.2, "riverDensity": 0.55,
		"temperatureBias": 0.0, "moistureBias": 0.0, "windDirection": 270, "stormFrequency": 0.3,
		"biomeWeights":   map[string]any{"meadow": 1, "forest": 0.9, "highlands": 0.6, "snowpeak": 0.4, "badlands": 0.4, "wetland": 0.5},
		"elementWeights": map[string]any{"fire": 0.5, "ice": 0.5, "lightning": 0.5, "earth": 0.6, "wind": 0.5, "light": 0.5, "dark": 0.4, "void": 0.1},
		"caveDensity":    0.5, "caveMaxDepth": 160, "gemRarityCurve": 1.5, "oreAbundance": 0.5,
		"dangerCurve": 0.5, "enemyDensity": 0.5, "demonIntensity": 0.5,
		"flammability": 0.5, "nightLength": 0.35, "settlementDensity": 0.5, "structureDensity": 0.5,
		"palette": "verdant", "lootThemes": []any{"ancient", "rustic"}, "nameGrammar": "pastoral",
	}
	bw := s["biomeWeights"].(map[string]any)
	ew := s["elementWeights"].(map[string]any)
	if has("archipelago", "islands", "isles") {
		s["landFraction"], s["seaLevel"], s["nameGrammar"] = 0.34, 0.62, "coastal"
	}
	if has("drowned", "sunken") {
		s["lootThemes"] = []any{"drowned", "ancient", "gothic"} // "gothic" is not in the vocabulary
		bw["wetland"] = 1.0
	}
	if has("cathedral", "temple") {
		s["structureDensity"] = 0.85
	}
	if has("cold", "frozen", "icy", "winter") {
		s["temperatureBias"], s["palette"] = -0.75, "frost"
		bw["snowpeak"], bw["meadow"] = 1.0, 0.5
		ew["ice"] = 1.0
	}
	if has("lots of caves", "caves", "caverns") {
		s["caveDensity"] = 1.4 // out of range on purpose: the clamp must catch it
		s["caveMaxDepth"] = 300.0
		s["oreAbundance"] = 0.8
	}
	if has("desert", "badlands", "scorched") {
		s["moistureBias"], s["palette"] = -0.8, "ashen"
		bw["badlands"] = 1.0
		ew["fire"] = 1.0
	}
	return s
}

func nameFrom(desc string) string {
	// Clean marker text away, then title-case the first few words.
	d := regexp.MustCompile(`\[[a-z0-9-]+\]`).ReplaceAllString(desc, " ")
	words := strings.FieldsFunc(d, func(r rune) bool { return r == ',' || r == ' ' || r == '.' })
	var out []string
	for _, w := range words {
		if len(out) == 3 {
			break
		}
		if len(w) < 3 || w == "lots" || w == "with" || w == "and" {
			continue
		}
		out = append(out, strings.ToUpper(w[:1])+w[1:])
	}
	if len(out) == 0 {
		return "Nameless Reach"
	}
	return "The " + strings.Join(out, " ")
}
