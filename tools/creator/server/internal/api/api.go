// Package api is the creator endpoint's HTTP surface (see ../../README.md):
// config, world list, normalize, mint and the optional vibe path.
package api

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"lodestone/server/pkg/svc"
	"lodestone/tools/creator/server/internal/spec"
	"lodestone/tools/creator/server/internal/store"
	"lodestone/tools/creator/server/internal/vibe"
	"lodestone/tools/creator/server/internal/worldgen"
)

// Config is everything the endpoint reads from the environment.
type Config struct {
	LLM        vibe.Config // Enabled only with LODESTONE_CREATOR_LLM=1
	Token      string      // LODESTONE_CREATOR_TOKEN: bearer token for POSTs (required in production)
	Production bool
}

// ConfigFromEnv reads Config through get (os.Getenv in main, a map in tests).
func ConfigFromEnv(get func(string) string) Config {
	flag := strings.ToLower(strings.TrimSpace(get("LODESTONE_CREATOR_LLM")))
	return Config{
		LLM: vibe.Config{
			Enabled: flag == "1" || flag == "true" || flag == "on",
			APIKey:  get("ANTHROPIC_API_KEY"),
			Model:   get("LODESTONE_CREATOR_LLM_MODEL"),
			BaseURL: get("LODESTONE_CREATOR_LLM_BASE_URL"),
		},
		Token:      get("LODESTONE_CREATOR_TOKEN"),
		Production: get("LODESTONE_ENV") == "production",
	}
}

// WorldStore is the slice of store.Store the handlers use.
type WorldStore interface {
	Insert(ctx context.Context, w store.World) (store.World, bool, error)
	List(ctx context.Context, limit int) ([]store.World, error)
}

// Deps are the endpoint's collaborators.
type Deps struct {
	Gate    *spec.Gate
	Module  *worldgen.Module
	Store   WorldStore
	Cache   vibe.Cache   // vibe cache (Redis in main); only used when the LLM path is on
	HTTP    *http.Client // client for the Messages API; injectable for tests
	Log     *slog.Logger
	Metrics *svc.Metrics
}

// Server holds the handlers' state.
type Server struct {
	cfg   Config
	d     Deps
	vibe  *vibe.Service // nil unless the LLM path is enabled and has a key
	model string
}

// New wires the endpoint. The model client is constructed here and only
// here, and only when cfg.LLM.Enabled and an API key are both present: with
// the flag off there is no object anywhere in the process that could call
// a model (TestFlagOffNeverReachesModel counts requests to prove it).
func New(cfg Config, d Deps) (*Server, error) {
	if cfg.Production && cfg.Token == "" {
		return nil, errors.New("LODESTONE_CREATOR_TOKEN must be set in production: minting creates worlds players see")
	}
	if d.Log == nil {
		d.Log = slog.Default()
	}
	if d.Metrics == nil {
		d.Metrics = svc.NewMetrics()
	}
	s := &Server{cfg: cfg, d: d}
	if cfg.LLM.Enabled {
		llm := cfg.LLM
		llm.HTTP = d.HTTP
		client, err := vibe.NewClient(llm, d.Gate.ModelSchema())
		if err != nil {
			// Flag on but no key: run without it and say so; the UI falls
			// back to sliders with a notice.
			d.Log.Warn("vibe text disabled", "reason", err.Error())
		} else {
			cache := d.Cache
			if cache == nil {
				cache = &vibe.MemoryCache{}
			}
			s.vibe = &vibe.Service{Gen: client, Gate: d.Gate, Cache: cache}
			s.model = client.Model()
			d.Log.Info("vibe text enabled", "model", s.model)
		}
	}
	d.Metrics.Help("creator_mints_total", "Worlds minted, by source (seed, sliders, vibe)")
	d.Metrics.Help("creator_vibe_total", "Vibe requests, by outcome (model, cached, failed, disabled)")
	d.Metrics.Help("creator_rejected_total", "Specs rejected by the normalize gate")
	return s, nil
}

// LLMEnabled reports whether the vibe path is live.
func (s *Server) LLMEnabled() bool { return s.vibe != nil }

// Register mounts the routes on mux.
func (s *Server) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/config", s.handleConfig)
	mux.HandleFunc("GET /v1/worlds", s.handleWorlds)
	mux.HandleFunc("POST /v1/normalize", s.auth(s.handleNormalize))
	mux.HandleFunc("POST /v1/mint", s.auth(s.handleMint))
	mux.HandleFunc("POST /v1/vibe", s.auth(s.handleVibe))
}

func (s *Server) auth(h http.HandlerFunc) http.HandlerFunc {
	if s.cfg.Token == "" {
		return h
	}
	want := []byte("Bearer " + s.cfg.Token)
	return func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), want) != 1 {
			writeErr(w, http.StatusUnauthorized, "unauthorized", "missing or wrong bearer token", nil)
			return
		}
		h(w, r)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string, details []string) {
	body := map[string]any{"error": code, "message": msg}
	if len(details) > 0 {
		body["details"] = details
	}
	writeJSON(w, status, body)
}

// readBody caps request bodies: a WorldSpec is ~1.5 KB.
func readBody(w http.ResponseWriter, r *http.Request, v any) bool {
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
	if err == nil {
		err = json.Unmarshal(b, v)
	}
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "body must be a JSON object under 64 KB: "+err.Error(), nil)
		return false
	}
	return true
}

func (s *Server) handleConfig(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"llm":         s.vibe != nil,
		"model":       s.model,
		"genVersion":  s.d.Module.GenVersionString(),
		"wasmSha256":  s.d.Module.SHA256,
		"specVersion": s.d.Gate.SpecVersion,
		"auth":        s.cfg.Token != "",
	})
}

func (s *Server) handleWorlds(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	worlds, err := s.d.Store.List(r.Context(), limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"worlds": worlds})
}

func (s *Server) reject(w http.ResponseWriter, err error) {
	var rej *spec.RejectedError
	if errors.As(err, &rej) {
		s.d.Metrics.Add("creator_rejected_total", 1)
		writeErr(w, http.StatusUnprocessableEntity, "invalid_spec", "the WorldSpec was rejected", rej.Errors)
		return
	}
	writeErr(w, http.StatusInternalServerError, "internal", err.Error(), nil)
}

func (s *Server) handleNormalize(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Spec json.RawMessage `json:"spec"`
	}
	if !readBody(w, r, &req) {
		return
	}
	res, err := s.d.Gate.Normalize(req.Spec)
	if err != nil {
		s.reject(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"spec": json.RawMessage(res.JSON), "changes": res.Changes})
}

// mintRequest: either {"seed"} (spec_from_seed, untouched) or {"spec"}
// (normalized first). source labels the spec's origin in logs/metrics.
type mintRequest struct {
	Seed   string          `json:"seed"`
	Spec   json.RawMessage `json:"spec"`
	Source string          `json:"source"`
}

func parseSeed(s string) (uint64, error) {
	return strconv.ParseUint(strings.TrimSpace(s), 10, 64)
}

func (s *Server) handleMint(w http.ResponseWriter, r *http.Request) {
	var req mintRequest
	if !readBody(w, r, &req) {
		return
	}
	ctx := r.Context()
	t0 := time.Now()
	var specJSON []byte
	var seed uint64
	var changes []spec.Change
	source := req.Source
	switch {
	case len(req.Spec) > 0 && string(req.Spec) != "null":
		res, err := s.d.Gate.Normalize(req.Spec)
		if err != nil {
			s.reject(w, err)
			return
		}
		seed, _ = parseSeed(res.Spec.Seed) // the gate guarantees a uint64
		specJSON, changes = res.JSON, res.Changes
		if source != "vibe" && source != "preset" {
			source = "sliders"
		}
	case req.Seed != "":
		var err error
		if seed, err = parseSeed(req.Seed); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_seed", "seed must be a uint64 in decimal", nil)
			return
		}
		// Way 1 of spec 6: the generator picks every field. Minted untouched
		// (no clamp: its own output is in range, and renormalizing weights
		// would make a different world than "this seed").
		if specJSON, err = s.d.Module.SpecFromSeed(ctx, seed); err != nil {
			writeErr(w, http.StatusInternalServerError, "worldgen", err.Error(), nil)
			return
		}
		if err := s.d.Gate.ValidateStrict(specJSON); err != nil {
			s.reject(w, err)
			return
		}
		source = "seed"
	default:
		writeErr(w, http.StatusBadRequest, "bad_request", `send {"seed": "<uint64>"} or {"spec": {...}}`, nil)
		return
	}
	atlas, err := s.d.Module.BuildAtlas(ctx, specJSON, seed)
	if err != nil {
		writeErr(w, http.StatusUnprocessableEntity, "worldgen", err.Error(), nil)
		return
	}
	var named struct {
		Name string `json:"name"`
	}
	_ = json.Unmarshal(atlas.SpecJSON, &named)
	world, existed, err := s.d.Store.Insert(ctx, store.World{
		Name: named.Name, Seed: strconv.FormatUint(seed, 10), Spec: atlas.SpecJSON,
		GenVersion: atlas.GenVersion, AtlasHash: atlas.AtlasHash,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db_error", err.Error(), nil)
		return
	}
	s.d.Metrics.Add(`creator_mints_total{source="`+source+`"}`, 1)
	s.d.Log.Info("minted world", "source", source, "id", world.ID, "name", world.Name, "seed", world.Seed,
		"genVersion", world.GenVersion, "atlasHash", world.AtlasHash, "existed", existed,
		"atlasBytes", atlas.Bytes, "sites", atlas.Sites, "atlasMs", atlas.BuildTime.Milliseconds(),
		"totalMs", time.Since(t0).Milliseconds(), "clampChanges", len(changes), "wasmSha256", s.d.Module.SHA256[:16])
	status := http.StatusCreated
	if existed {
		status = http.StatusOK
	}
	if changes == nil {
		changes = []spec.Change{}
	}
	writeJSON(w, status, map[string]any{
		"world": world, "existed": existed, "source": source, "changes": changes,
		"atlas": map[string]any{"bytes": atlas.Bytes, "sites": atlas.Sites, "buildMs": atlas.BuildTime.Milliseconds(),
			"seaY": atlas.SeaY, "spawn": map[string]float32{"x": atlas.SpawnX, "z": atlas.SpawnZ}},
		"wasmSha256": s.d.Module.SHA256,
	})
}

func randomSeed() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return strconv.FormatUint(binary.LittleEndian.Uint64(b[:]), 10)
}

func (s *Server) handleVibe(w http.ResponseWriter, r *http.Request) {
	if s.vibe == nil {
		s.d.Metrics.Add(`creator_vibe_total{outcome="disabled"}`, 1)
		writeErr(w, http.StatusServiceUnavailable, "llm_disabled", vibe.ErrDisabled.Error(), nil)
		return
	}
	var req struct {
		Prompt string `json:"prompt"`
		Seed   string `json:"seed"`
	}
	if !readBody(w, r, &req) {
		return
	}
	seed := strings.TrimSpace(req.Seed)
	if seed == "" {
		seed = randomSeed()
	} else if _, err := parseSeed(seed); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_seed", "seed must be a uint64 in decimal", nil)
		return
	}
	res, err := s.vibe.Vibe(r.Context(), req.Prompt, seed)
	if errors.Is(err, vibe.ErrBadPrompt) {
		writeErr(w, http.StatusBadRequest, "bad_prompt", err.Error(), nil)
		return
	}
	var fe *vibe.FailedError
	if errors.As(err, &fe) {
		s.d.Metrics.Add(`creator_vibe_total{outcome="failed"}`, 1)
		s.d.Log.Warn("vibe failed", "promptChars", len(req.Prompt), "reasons", fe.Reasons)
		writeErr(w, http.StatusBadGateway, "llm_failed", "the model did not produce a valid WorldSpec; use the sliders", fe.Reasons)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error(), nil)
		return
	}
	outcome := "model"
	if res.Cached {
		outcome = "cached"
	}
	s.d.Metrics.Add(`creator_vibe_total{outcome="`+outcome+`"}`, 1)
	s.d.Log.Info("vibe spec", "outcome", outcome, "attempts", res.Attempts, "cacheKey", res.CacheKey[:16],
		"name", res.Spec.Name, "seed", res.Spec.Seed, "clampChanges", len(res.Changes))
	writeJSON(w, http.StatusOK, map[string]any{
		"spec": json.RawMessage(res.JSON), "changes": res.Changes, "cached": res.Cached,
		"attempts": res.Attempts, "model": s.model,
	})
}
