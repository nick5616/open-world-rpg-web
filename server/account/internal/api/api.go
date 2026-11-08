// Package api is the account service's HTTP surface (spec 4: auth, signing
// save blobs for local profiles, characters). Every endpoint is documented in
// server/account/README.md; WP06 and WP08 are written against that file, so
// change both together.
package api

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"lodestone/server/account/internal/firebase"
	"lodestone/server/pkg/accountapi"
	"lodestone/server/pkg/localsave"
	"lodestone/server/pkg/svc"
)

// MaxCharactersPerWorld caps how many characters one account or profile can
// hold in a world. Mostly anti-spam: each character reserves a name forever.
const MaxCharactersPerWorld = 8

// Body limits: saves can reach hundreds of KB (spec 11), and an upgrade
// carries one per character; everything else is tiny.
const (
	smallBody = 64 << 10
	saveBody  = 1 << 20
	bulkBody  = (MaxCharactersPerWorld*2 + 1) << 20
)

// API holds the service's dependencies.
type API struct {
	DB          accountapi.DB
	Saves       *localsave.Store
	SessionPriv ed25519.PrivateKey
	SessionPub  ed25519.PublicKey
	SessionTTL  time.Duration
	// Firebase is nil when no project is configured (local dev): the client
	// then hides the Google button.
	Firebase *firebase.Verifier
	// Providers maps allowed firebase.sign_in_provider values to the
	// accounts.auth_provider we store ("google.com" -> "google").
	Providers map[string]string
	DevAuth   bool
	Log       *slog.Logger
	Metrics   *svc.Metrics
	Now       func() time.Time
}

func (a *API) now() time.Time {
	if a.Now != nil {
		return a.Now()
	}
	return time.Now()
}

// Register mounts every endpoint on mux.
func (a *API) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/auth/config", a.authConfig)
	mux.HandleFunc("POST /v1/auth/firebase", a.authFirebase)
	mux.HandleFunc("POST /v1/auth/dev", a.authDev)
	mux.HandleFunc("POST /v1/local/session", a.localSession)
	mux.HandleFunc("GET /v1/me", a.authed(a.me))
	mux.HandleFunc("GET /v1/worlds", a.worlds)
	mux.HandleFunc("GET /v1/characters", a.authed(a.listCharacters))
	mux.HandleFunc("POST /v1/characters", a.authed(a.createCharacter))
	mux.HandleFunc("POST /v1/local/saves/verify", a.authed(a.verifySave))
	mux.HandleFunc("POST /v1/local/upgrade", a.authed(a.upgrade))
	if a.DevAuth {
		// Simulates a zone save point so the browser flow (and its tests) can
		// produce a newer blob before the zone server exists (WP06/WP14).
		mux.HandleFunc("POST /v1/dev/local/resave", a.authed(a.devResave))
	}
}

// ---- helpers ---------------------------------------------------------------

type apiError struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, apiError{Error: code, Message: msg})
}

func readJSON(w http.ResponseWriter, r *http.Request, limit int64, out any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(out); err != nil {
		fail(w, http.StatusBadRequest, "bad_request", "invalid JSON body: "+err.Error())
		return false
	}
	return true
}

func (a *API) internal(w http.ResponseWriter, r *http.Request, err error) {
	a.Log.Error("request failed", "path", r.URL.Path, "err", err)
	a.Metrics.Add("account_errors_total", 1)
	fail(w, http.StatusInternalServerError, "internal", "internal error")
}

type authedHandler func(w http.ResponseWriter, r *http.Request, s accountapi.Session)

// authed requires a valid session token in the Authorization header.
func (a *API) authed(h authedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := accountapi.BearerToken(r.Header.Get("Authorization"))
		if tok == "" {
			fail(w, http.StatusUnauthorized, "unauthorized", "missing session token")
			return
		}
		s, err := accountapi.VerifySession(a.SessionPub, tok, a.now())
		if err != nil {
			fail(w, http.StatusUnauthorized, "unauthorized", "invalid or expired session")
			return
		}
		h(w, r, s)
	}
}

// SessionResponse is returned by every sign-in endpoint.
type SessionResponse struct {
	Session   string                   `json:"session"`
	ExpiresAt int64                    `json:"expiresAt"` // unix ms
	Kind      string                   `json:"kind"`
	Account   *accountapi.Account      `json:"account,omitempty"`
	Profile   *accountapi.LocalProfile `json:"profile,omitempty"`
	Name      string                   `json:"name,omitempty"`
}

func (a *API) issue(w http.ResponseWriter, s accountapi.Session, acc *accountapi.Account, prof *accountapi.LocalProfile) {
	tok, exp := accountapi.SignSession(a.SessionPriv, s, a.now(), a.SessionTTL)
	a.Metrics.Add(fmt.Sprintf(`account_sessions_issued_total{provider=%q}`, s.Provider), 1)
	writeJSON(w, http.StatusOK, SessionResponse{Session: tok, ExpiresAt: exp.UnixMilli(), Kind: s.Kind, Account: acc, Profile: prof, Name: s.Name})
}

// signInAccount upserts the account and refuses suspended or banned ones.
func (a *API) signInAccount(w http.ResponseWriter, r *http.Request, provider, subject, name string) {
	acc, err := a.DB.UpsertAccount(r.Context(), provider, subject)
	if err != nil {
		a.internal(w, r, err)
		return
	}
	if acc.Status == "suspended" || acc.Status == "banned" {
		fail(w, http.StatusForbidden, "account_"+acc.Status, "this account is "+acc.Status)
		return
	}
	a.issue(w, accountapi.Session{Kind: accountapi.KindAccount, Subject: acc.ID, Provider: provider, Name: name}, &acc, nil)
}

// ---- auth ------------------------------------------------------------------

// AuthConfig tells the client which sign-in options to offer.
type AuthConfig struct {
	DevAuth   bool     `json:"devAuth"`
	Firebase  *fbInfo  `json:"firebase"`
	Local     bool     `json:"localProfiles"`
	Providers []string `json:"providers"`
}

type fbInfo struct {
	ProjectID string `json:"projectId"`
}

func (a *API) authConfig(w http.ResponseWriter, _ *http.Request) {
	c := AuthConfig{DevAuth: a.DevAuth, Local: true, Providers: []string{}}
	if a.Firebase != nil {
		c.Firebase = &fbInfo{ProjectID: a.Firebase.ProjectID}
		for p := range a.Providers {
			c.Providers = append(c.Providers, p)
		}
	}
	writeJSON(w, http.StatusOK, c)
}

func (a *API) authFirebase(w http.ResponseWriter, r *http.Request) {
	if a.Firebase == nil {
		fail(w, http.StatusNotFound, "firebase_disabled", "Firebase sign-in is not configured on this server")
		return
	}
	var req struct {
		IDToken string `json:"idToken"`
	}
	if !readJSON(w, r, smallBody, &req) {
		return
	}
	tok, err := a.Firebase.Verify(r.Context(), req.IDToken)
	if err != nil {
		if errors.Is(err, firebase.ErrKeys) {
			a.Log.Error("firebase keys unavailable", "err", err)
			fail(w, http.StatusServiceUnavailable, "auth_unavailable", "sign-in is temporarily unavailable")
			return
		}
		a.Metrics.Add("account_firebase_rejected_total", 1)
		fail(w, http.StatusUnauthorized, "invalid_token", "ID token rejected")
		return
	}
	provider, ok := a.Providers[tok.Provider]
	if !ok {
		fail(w, http.StatusForbidden, "provider_not_allowed", fmt.Sprintf("sign-in provider %q is not enabled", tok.Provider))
		return
	}
	name := tok.Name
	if name == "" {
		name = strings.SplitN(tok.Email, "@", 2)[0]
	}
	a.signInAccount(w, r, provider, tok.UID, name)
}

func (a *API) authDev(w http.ResponseWriter, r *http.Request) {
	if !a.DevAuth {
		fail(w, http.StatusForbidden, "dev_auth_disabled", "dev sign-in is disabled on this server")
		return
	}
	var req struct {
		Username string `json:"username"`
	}
	if !readJSON(w, r, smallBody, &req) {
		return
	}
	u, err := accountapi.ValidateDevUsername(req.Username)
	if err != nil {
		fail(w, http.StatusBadRequest, "invalid_username", err.Error())
		return
	}
	a.signInAccount(w, r, "dev", u, u)
}

// MinProfileSecretLen: the browser sends base64url of 32 random bytes (43
// chars). The secret is what makes a profile id unforgeable, so short ones
// are refused.
const MinProfileSecretLen = 43

func hashSecret(s string) []byte {
	h := sha256.Sum256([]byte("lodestone-local-profile\x00" + s))
	return h[:]
}

func (a *API) localSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ProfileID     string `json:"profileId"`
		ProfileSecret string `json:"profileSecret"`
	}
	if !readJSON(w, r, smallBody, &req) {
		return
	}
	id := accountapi.NormalizeUUID(req.ProfileID)
	if id == "" || len(req.ProfileSecret) < MinProfileSecretLen || len(req.ProfileSecret) > 256 {
		fail(w, http.StatusBadRequest, "bad_request", "profileId must be a UUID and profileSecret at least 43 characters")
		return
	}
	p, created, err := a.DB.ClaimLocalProfile(r.Context(), id, hashSecret(req.ProfileSecret))
	if errors.Is(err, accountapi.ErrProfileSecret) {
		fail(w, http.StatusForbidden, "profile_secret", "this profile id belongs to another browser")
		return
	}
	if err != nil {
		a.internal(w, r, err)
		return
	}
	if p.UpgradedAccountID != nil {
		fail(w, http.StatusGone, "profile_upgraded", "this local profile was upgraded to an account; sign in with that account")
		return
	}
	if created {
		a.Metrics.Add("account_local_profiles_created_total", 1)
	}
	a.issue(w, accountapi.Session{Kind: accountapi.KindLocal, Subject: p.ID, Provider: "local"}, nil, &p)
}

func (a *API) me(w http.ResponseWriter, r *http.Request, s accountapi.Session) {
	resp := map[string]any{"kind": s.Kind, "subject": s.Subject, "provider": s.Provider, "name": s.Name, "expiresAt": s.Expires.UnixMilli()}
	switch s.Kind {
	case accountapi.KindAccount:
		acc, err := a.DB.GetAccount(r.Context(), s.Subject)
		if err != nil {
			a.notFoundOr(w, r, err)
			return
		}
		resp["account"] = acc
	case accountapi.KindLocal:
		p, err := a.DB.GetLocalProfile(r.Context(), s.Subject)
		if err != nil {
			a.notFoundOr(w, r, err)
			return
		}
		resp["profile"] = p
	}
	writeJSON(w, http.StatusOK, resp)
}

func (a *API) notFoundOr(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, accountapi.ErrNotFound) {
		fail(w, http.StatusNotFound, "not_found", "not found")
		return
	}
	a.internal(w, r, err)
}

// ---- worlds and characters ------------------------------------------------

func (a *API) worlds(w http.ResponseWriter, r *http.Request) {
	ws, err := a.DB.ListWorlds(r.Context())
	if err != nil {
		a.internal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"worlds": ws})
}

func (a *API) listCharacters(w http.ResponseWriter, r *http.Request, s accountapi.Session) {
	world := r.URL.Query().Get("worldId")
	if world != "" && accountapi.NormalizeUUID(world) == "" {
		fail(w, http.StatusBadRequest, "bad_request", "worldId must be a UUID")
		return
	}
	cs, err := a.DB.ListCharacters(r.Context(), accountapi.OwnerOf(s), accountapi.NormalizeUUID(world))
	if err != nil {
		a.internal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"characters": cs})
}

// CreateCharacterResponse carries the initial save blob for local profiles.
type CreateCharacterResponse struct {
	Character accountapi.Character `json:"character"`
	Save      *localsave.Blob      `json:"save,omitempty"`
}

func (a *API) createCharacter(w http.ResponseWriter, r *http.Request, s accountapi.Session) {
	var req struct {
		WorldID    string          `json:"worldId"`
		Name       string          `json:"name"`
		Appearance json.RawMessage `json:"appearance"`
	}
	if !readJSON(w, r, smallBody, &req) {
		return
	}
	worldID := accountapi.NormalizeUUID(req.WorldID)
	if worldID == "" {
		fail(w, http.StatusBadRequest, "bad_request", "worldId must be a UUID")
		return
	}
	name, err := accountapi.ValidateName(req.Name)
	if err != nil {
		fail(w, http.StatusBadRequest, "invalid_name", err.Error())
		return
	}
	if len(req.Appearance) > 0 && (len(req.Appearance) > 4096 || req.Appearance[0] != '{') {
		fail(w, http.StatusBadRequest, "bad_request", "appearance must be a JSON object under 4 KB")
		return
	}
	ctx := r.Context()
	if _, err := a.DB.GetWorld(ctx, worldID); err != nil {
		if errors.Is(err, accountapi.ErrNotFound) {
			fail(w, http.StatusNotFound, "world_not_found", "no such world")
			return
		}
		a.internal(w, r, err)
		return
	}
	owner := accountapi.OwnerOf(s)
	if s.Kind == accountapi.KindLocal && !a.localProfileActive(w, r, s.Subject) {
		return
	}
	existing, err := a.DB.ListCharacters(ctx, owner, worldID)
	if err != nil {
		a.internal(w, r, err)
		return
	}
	if len(existing) >= MaxCharactersPerWorld {
		fail(w, http.StatusConflict, "too_many_characters", fmt.Sprintf("at most %d characters per world", MaxCharactersPerWorld))
		return
	}
	spawn := accountapi.SpawnPosition()
	c, err := a.DB.CreateCharacter(ctx, owner, worldID, name, req.Appearance, spawn)
	if errors.Is(err, accountapi.ErrNameTaken) {
		fail(w, http.StatusConflict, "name_taken", "that name is taken in this world")
		return
	}
	if err != nil {
		a.internal(w, r, err)
		return
	}
	resp := CreateCharacterResponse{Character: c}
	if c.Local {
		// The account service issues the first blob (counter 1); zone servers
		// issue every later one at save points.
		st := localsave.NewCharacterState(c.ID, worldID, c.Name, spawn, req.Appearance)
		blob, err := a.Saves.Issue(ctx, s.Subject, c.ID, worldID, st.Marshal())
		if err != nil {
			// Without a blob the browser could never play this character, and a
			// retry would hit name_taken against our own reservation. Undo the
			// reservation so the retry starts clean.
			if derr := a.DB.DeleteLocalCharacter(context.WithoutCancel(ctx), s.Subject, c.ID); derr != nil {
				a.Log.Error("could not release name after failed save issue", "character", c.ID, "err", derr)
			}
			a.internal(w, r, fmt.Errorf("issue initial save: %w", err))
			return
		}
		resp.Save = &blob
	}
	a.Metrics.Add(fmt.Sprintf(`account_characters_created_total{kind=%q}`, s.Kind), 1)
	writeJSON(w, http.StatusCreated, resp)
}

// localProfileActive refuses profiles that were upgraded after the session
// was issued (sessions live 12 h; an upgrade must take effect immediately).
func (a *API) localProfileActive(w http.ResponseWriter, r *http.Request, id string) bool {
	p, err := a.DB.GetLocalProfile(r.Context(), id)
	if err != nil {
		a.notFoundOr(w, r, err)
		return false
	}
	if p.UpgradedAccountID != nil {
		fail(w, http.StatusGone, "profile_upgraded", "this local profile was upgraded to an account")
		return false
	}
	return true
}

// ---- local saves -----------------------------------------------------------

// checkSave verifies a blob belongs to the session's profile, is signed by us
// and carries the newest counter. It writes the HTTP error itself.
func (a *API) checkSave(ctx context.Context, w http.ResponseWriter, r *http.Request, profileID string, b localsave.Blob) (localsave.State, bool) {
	if b.ProfileID != profileID {
		fail(w, http.StatusForbidden, "wrong_profile", "this save belongs to another profile")
		return localsave.State{}, false
	}
	err := a.Saves.Verify(ctx, b)
	switch {
	case errors.Is(err, localsave.ErrSignature), errors.Is(err, localsave.ErrMalformed):
		a.Metrics.Add("account_saves_rejected_total{reason=\"signature\"}", 1)
		fail(w, http.StatusBadRequest, "bad_signature", "this save was modified or is not a Lodestone save")
		return localsave.State{}, false
	case errors.Is(err, localsave.ErrStale):
		a.Metrics.Add("account_saves_rejected_total{reason=\"stale\"}", 1)
		fail(w, http.StatusConflict, "stale_save", "a newer save of this character exists")
		return localsave.State{}, false
	case errors.Is(err, localsave.ErrNoRecord):
		fail(w, http.StatusConflict, "no_record", "the server has no record of this save")
		return localsave.State{}, false
	case err != nil:
		a.internal(w, r, err)
		return localsave.State{}, false
	}
	st, err := b.DecodeState()
	if err != nil || st.CharacterID != b.CharacterID || st.WorldID != b.WorldID {
		fail(w, http.StatusBadRequest, "bad_signature", "save state does not match its envelope")
		return localsave.State{}, false
	}
	return st, true
}

func (a *API) verifySave(w http.ResponseWriter, r *http.Request, s accountapi.Session) {
	if s.Kind != accountapi.KindLocal {
		fail(w, http.StatusForbidden, "local_only", "only local-profile sessions have saves")
		return
	}
	var req struct {
		Save localsave.Blob `json:"save"`
	}
	if !readJSON(w, r, saveBody, &req) {
		return
	}
	st, ok := a.checkSave(r.Context(), w, r, s.Subject, req.Save)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "counter": req.Save.Counter, "characterId": st.CharacterID, "name": st.Name, "level": st.Level})
}

func (a *API) devResave(w http.ResponseWriter, r *http.Request, s accountapi.Session) {
	if s.Kind != accountapi.KindLocal {
		fail(w, http.StatusForbidden, "local_only", "only local-profile sessions have saves")
		return
	}
	var req struct {
		Save localsave.Blob `json:"save"`
		Set  struct {
			Level    *int            `json:"level"`
			XP       *int64          `json:"xp"`
			Position *localsave.Vec3 `json:"position"`
		} `json:"set"`
	}
	if !readJSON(w, r, saveBody, &req) {
		return
	}
	st, ok := a.checkSave(r.Context(), w, r, s.Subject, req.Save)
	if !ok {
		return
	}
	if req.Set.Level != nil {
		st.Level = *req.Set.Level
	}
	if req.Set.XP != nil {
		st.XP = *req.Set.XP
	}
	if req.Set.Position != nil {
		st.Position = *req.Set.Position
	}
	blob, err := a.Saves.Issue(r.Context(), s.Subject, st.CharacterID, st.WorldID, st.Marshal())
	if err != nil {
		a.internal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"save": blob})
}

func (a *API) upgrade(w http.ResponseWriter, r *http.Request, s accountapi.Session) {
	if s.Kind != accountapi.KindAccount {
		fail(w, http.StatusForbidden, "account_only", "sign in to an account first, then upgrade the local profile into it")
		return
	}
	var req struct {
		LocalSession string           `json:"localSession"`
		Saves        []localsave.Blob `json:"saves"`
	}
	if !readJSON(w, r, bulkBody, &req) {
		return
	}
	// Owning the local profile is proven by its own session token, so the
	// profile secret never has to travel with an account request.
	ls, err := accountapi.VerifySession(a.SessionPub, req.LocalSession, a.now())
	if err != nil || ls.Kind != accountapi.KindLocal {
		fail(w, http.StatusUnauthorized, "unauthorized", "localSession must be a valid local-profile session")
		return
	}
	ctx := r.Context()
	states := map[string]localsave.State{}
	for _, b := range req.Saves {
		if _, dup := states[b.CharacterID]; dup {
			fail(w, http.StatusBadRequest, "bad_request", "one save per character")
			return
		}
		st, ok := a.checkSave(ctx, w, r, ls.Subject, b)
		if !ok {
			return
		}
		states[b.CharacterID] = st
	}
	moved, err := a.DB.UpgradeLocalProfile(ctx, ls.Subject, s.Subject, states)
	switch {
	case errors.Is(err, accountapi.ErrProfileUpgraded):
		fail(w, http.StatusGone, "profile_upgraded", "this local profile was already upgraded")
		return
	case errors.Is(err, accountapi.ErrUpgradeMismatch):
		fail(w, http.StatusConflict, "upgrade_mismatch", err.Error())
		return
	case errors.Is(err, accountapi.ErrNotFound):
		fail(w, http.StatusNotFound, "not_found", "unknown local profile")
		return
	case err != nil:
		a.internal(w, r, err)
		return
	}
	// The counters only guarded the browser copies, which are now just a
	// cache; drop them rather than wait 180 days.
	if err := a.Saves.RDB.Del(ctx, localsave.Key(ls.Subject)).Err(); err != nil {
		a.Log.Warn("could not delete localsave record after upgrade", "profile", ls.Subject, "err", err)
	}
	a.Metrics.Add("account_local_upgrades_total", 1)
	a.Log.Info("local profile upgraded", "profile", ls.Subject, "account", s.Subject, "characters", len(moved))
	writeJSON(w, http.StatusOK, map[string]any{"accountId": s.Subject, "characters": moved})
}
