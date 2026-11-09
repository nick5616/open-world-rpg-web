// Package director is the login handoff (spec 4): given a session and a
// character, it finds the zone server that owns the character's region in
// the Redis zone registry and signs the 60 s connect tickets the zone and
// social services verify offline (spec 9, security). Endpoints are documented
// in server/director/README.md.
package director

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/accountapi"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/localsave"
	"lodestone/server/pkg/svc"
	"lodestone/server/pkg/ticket"
	"lodestone/server/pkg/zoneregistry"
)

// WakeRetryAfter is what the client is told to wait while no zone is live.
// Zones heartbeat every 5 s, so polling faster than that only adds load.
const WakeRetryAfter = 5 * time.Second

// Director holds the service's dependencies.
type Director struct {
	DB             accountapi.DB
	RDB            *redis.Client
	SessionPub     ed25519.PublicKey
	TicketPriv     ed25519.PrivateKey
	Saves          *localsave.Store // verify-only (Pub set, Priv nil)
	SocialEndpoint string
	Log            *slog.Logger
	Metrics        *svc.Metrics
	Now            func() time.Time
	// WP19b: load-aware region moves after Plan (zoneregistry.Rebalance);
	// nil = sticky only (pre-WP19b). At most one move per world per
	// RebalanceCooldown.
	Rebalance         *zoneregistry.RebalanceOptions
	RebalanceCooldown time.Duration
	// OnlyWorld, when set, makes the assigner handle just this world, from
	// start-up on (LODESTONE_DIRECTOR_ONLY_WORLD; soaks on shared Redis,
	// where a long-running dev director would otherwise win the lease).
	OnlyWorld         string
	rebalMu           sync.Mutex
	lastRebalance     map[string]time.Time
}

func (d *Director) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

// Register mounts every endpoint on mux.
func (d *Director) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/connect", d.authed(d.connect))
	mux.HandleFunc("POST /v1/social-ticket", d.authed(d.socialTicket))
	mux.HandleFunc("GET /v1/worlds", d.worlds)
	mux.HandleFunc("GET /v1/worlds/{id}/status", d.worldStatus)
}

type apiError struct {
	Error       string `json:"error"`
	Message     string `json:"message"`
	RetryAfterS int    `json:"retryAfterS,omitempty"`
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

func (d *Director) internal(w http.ResponseWriter, r *http.Request, err error) {
	d.Log.Error("request failed", "path", r.URL.Path, "err", err)
	d.Metrics.Add("director_errors_total", 1)
	fail(w, http.StatusInternalServerError, "internal", "internal error")
}

type authedHandler func(w http.ResponseWriter, r *http.Request, s accountapi.Session)

func (d *Director) authed(h authedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := accountapi.BearerToken(r.Header.Get("Authorization"))
		s, err := accountapi.VerifySession(d.SessionPub, tok, d.now())
		if tok == "" || err != nil {
			fail(w, http.StatusUnauthorized, "unauthorized", "missing, invalid or expired session")
			return
		}
		h(w, r, s)
	}
}

// ConnectRequest asks to enter the world as a character.
type ConnectRequest struct {
	CharacterID string `json:"characterId"`
	// Save is the local profile's newest blob for this character. Optional:
	// when present it is verified and its position picks the region; when
	// absent the character starts at the spawn region. The zone server checks
	// the blob again on connect, which is what actually protects the state.
	Save *localsave.Blob `json:"save,omitempty"`
}

// ZoneInfo is where to connect.
type ZoneInfo struct {
	ZoneID     string `json:"zoneId"`
	Endpoint   string `json:"endpoint"`             // WebSocket URL (always present)
	WTEndpoint string `json:"wtEndpoint,omitempty"` // WebTransport URL when the zone offers one
}

// ConnectResponse carries both tickets and endpoints.
type ConnectResponse struct {
	Ticket         string               `json:"ticket"`       // audience zone:<zoneId>
	SocialTicket   string               `json:"socialTicket"` // audience social
	ExpiresAt      int64                `json:"expiresAt"`    // unix ms; both tickets
	Zone           ZoneInfo             `json:"zone"`
	SocialEndpoint string               `json:"socialEndpoint"`
	WorldID        string               `json:"worldId"`
	Region         zoneregistry.Region  `json:"region"`
	Character      accountapi.Character `json:"character"`
	IsLocalProfile bool                 `json:"isLocalProfile"`
}

// resolve loads the session's character and checks the owner may play.
// It writes the HTTP error itself and returns ok=false on failure.
func (d *Director) resolve(w http.ResponseWriter, r *http.Request, s accountapi.Session, characterID string) (accountapi.Character, bool) {
	ctx := r.Context()
	id := accountapi.NormalizeUUID(characterID)
	if id == "" {
		fail(w, http.StatusBadRequest, "bad_request", "characterId must be a UUID")
		return accountapi.Character{}, false
	}
	switch s.Kind {
	case accountapi.KindAccount:
		acc, err := d.DB.GetAccount(ctx, s.Subject)
		if err != nil {
			d.notFoundOr(w, r, err)
			return accountapi.Character{}, false
		}
		// Checked here, not only at sign-in: sessions live 12 h and a ban must
		// stop new tickets immediately.
		if acc.Status == "suspended" || acc.Status == "banned" {
			fail(w, http.StatusForbidden, "account_"+acc.Status, "this account is "+acc.Status)
			return accountapi.Character{}, false
		}
	case accountapi.KindLocal:
		p, err := d.DB.GetLocalProfile(ctx, s.Subject)
		if err != nil {
			d.notFoundOr(w, r, err)
			return accountapi.Character{}, false
		}
		if p.UpgradedAccountID != nil {
			fail(w, http.StatusGone, "profile_upgraded", "this local profile was upgraded; sign in with the account")
			return accountapi.Character{}, false
		}
	}
	c, err := d.DB.GetCharacter(ctx, accountapi.OwnerOf(s), id)
	if err != nil {
		d.notFoundOr(w, r, err)
		return accountapi.Character{}, false
	}
	return c, true
}

func (d *Director) notFoundOr(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, accountapi.ErrNotFound) {
		fail(w, http.StatusNotFound, "not_found", "no such character for this session")
		return
	}
	d.internal(w, r, err)
}

func (d *Director) claims(s accountapi.Session, c accountapi.Character, audience string, now time.Time) ticket.Claims {
	cl := ticket.Claims{CharacterID: c.ID, CharacterName: c.Name, WorldID: c.WorldID, Audience: audience, IssuedAt: now}
	if s.Kind == accountapi.KindLocal {
		cl.ProfileID, cl.IsLocalProfile = s.Subject, true
	} else {
		cl.AccountID = s.Subject
	}
	return cl
}

func (d *Director) connect(w http.ResponseWriter, r *http.Request, s accountapi.Session) {
	var req ConnectRequest
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return
	}
	c, ok := d.resolve(w, r, s, req.CharacterID)
	if !ok {
		return
	}
	pos := c.Position
	if req.Save != nil {
		if !c.Local {
			fail(w, http.StatusBadRequest, "bad_request", "account characters have no local save")
			return
		}
		if req.Save.ProfileID != s.Subject || req.Save.CharacterID != c.ID || req.Save.WorldID != c.WorldID {
			fail(w, http.StatusForbidden, "wrong_profile", "this save belongs to another character")
			return
		}
		err := d.Saves.Verify(r.Context(), *req.Save)
		switch {
		case errors.Is(err, localsave.ErrSignature), errors.Is(err, localsave.ErrMalformed):
			fail(w, http.StatusBadRequest, "bad_signature", "this save was modified or is not a Lodestone save")
			return
		case errors.Is(err, localsave.ErrStale):
			fail(w, http.StatusConflict, "stale_save", "a newer save of this character exists")
			return
		case err != nil:
			d.internal(w, r, err)
			return
		}
		if st, err := req.Save.DecodeState(); err == nil {
			pos = st.Position
			c.Level, c.XP, c.Position = st.Level, st.XP, st.Position
		}
	}
	region := accountapi.RegionOf(pos)
	now := d.now()
	live, err := zoneregistry.Live(r.Context(), d.RDB, c.WorldID, now)
	if err != nil {
		d.internal(w, r, err)
		return
	}
	zone, found := pickZone(live, region)
	if !found {
		// Spec 13: the game VM may be asleep. The client shows "waking the
		// world" and retries; waking the VM itself is WP19's infra hook.
		d.Metrics.Add("director_waking_total", 1)
		w.Header().Set("Retry-After", strconv.Itoa(int(WakeRetryAfter/time.Second)))
		writeJSON(w, http.StatusServiceUnavailable, apiError{Error: "waking_world", Message: "Waking the world… no zone server is online for this region yet.", RetryAfterS: int(WakeRetryAfter / time.Second)})
		return
	}
	zc := d.claims(s, c, ticket.AudienceZone(zone.ZoneID), now)
	sc := d.claims(s, c, ticket.AudienceSocial, now)
	zt := ticket.Sign(d.TicketPriv, zc)
	st := ticket.Sign(d.TicketPriv, sc)
	d.Metrics.Add(fmt.Sprintf(`director_tickets_issued_total{kind=%q}`, s.Kind), 1)
	d.Log.Info("ticket issued", "character", c.ID, "zone", zone.ZoneID, "region", region, "local", c.Local)
	writeJSON(w, http.StatusOK, ConnectResponse{
		Ticket: zt, SocialTicket: st, ExpiresAt: now.Add(constants.TicketTtlS * time.Second).UnixMilli(),
		Zone:           ZoneInfo{ZoneID: zone.ZoneID, Endpoint: zone.Endpoint, WTEndpoint: zone.WTEndpoint},
		SocialEndpoint: d.SocialEndpoint, WorldID: c.WorldID, Region: region, Character: c, IsLocalProfile: c.Local,
	})
}

// pickZone routes a region to its owner (WP16: zoneregistry.Owner, the same
// function every cluster zone uses, so the director never sends a player to
// a zone that would immediately hand them elsewhere). Zones that list the
// region explicitly win over the primary / whole-world zones; ties go to
// the lowest zone id, never to load (two zones splitting the players in one
// place could not see each other). In v1 a single whole-world zone takes
// everyone, as before.
func pickZone(live []zoneregistry.Entry, r zoneregistry.Region) (zoneregistry.Entry, bool) {
	return zoneregistry.Owner(live, r)
}

// socialTicket re-issues only the social ticket, for reconnecting the social
// socket (spec 10: social stays up across zone handoffs) without a zone pick.
func (d *Director) socialTicket(w http.ResponseWriter, r *http.Request, s accountapi.Session) {
	var req struct {
		CharacterID string `json:"characterId"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		fail(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return
	}
	c, ok := d.resolve(w, r, s, req.CharacterID)
	if !ok {
		return
	}
	now := d.now()
	writeJSON(w, http.StatusOK, map[string]any{
		"socialTicket": ticket.Sign(d.TicketPriv, d.claims(s, c, ticket.AudienceSocial, now)),
		"expiresAt":    now.Add(constants.TicketTtlS * time.Second).UnixMilli(), "socialEndpoint": d.SocialEndpoint,
	})
}

func (d *Director) worlds(w http.ResponseWriter, r *http.Request) {
	ws, err := d.DB.ListWorlds(r.Context())
	if err != nil {
		d.internal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"worlds": ws})
}

// worldStatus lets the "waking the world" screen poll cheaply.
func (d *Director) worldStatus(w http.ResponseWriter, r *http.Request) {
	id := accountapi.NormalizeUUID(r.PathValue("id"))
	if id == "" {
		fail(w, http.StatusBadRequest, "bad_request", "world id must be a UUID")
		return
	}
	live, err := zoneregistry.Live(r.Context(), d.RDB, id, d.now())
	if err != nil {
		d.internal(w, r, err)
		return
	}
	players := 0
	for _, z := range live {
		players += z.Players
	}
	writeJSON(w, http.StatusOK, map[string]any{"worldId": id, "awake": len(live) > 0, "zones": len(live), "players": players})
}
