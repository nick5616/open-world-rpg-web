// Package wake starts the game VM when a player shows up and stops it after
// nobody has been online for a while (spec 13, "wake the world on demand";
// WP18, decision 0018).
//
// The director is the only always-reachable piece (Cloud Run, scale to
// zero), so it owns the decision. The VM is behind a tiny Provider interface:
// GCE in production (gce.go, plain REST, no SDK), Fake in tests and in the
// local rehearsal (fake.go), and none at all by default, which keeps local
// development and every existing test "always awake".
//
// Idle accounting has to survive the director itself scaling to zero: a
// Cloud Run instance is gone ~15 minutes after its last request, so an
// in-memory timer would either never fire or forget the last player. The
// last-activity time therefore lives in an ActivityStore (Redis on the VM,
// which exists exactly as long as the thing it guards), and the idle check
// is driven from outside (Cloud Scheduler hits POST /internal/wake/tick every
// 5 minutes) as well as from inside while an instance is alive. When the
// store is unreachable the VM's own last start time is the floor, so a
// broken Redis can delay a stop by at most one idle window, never forever:
// a forgotten VM is the expensive failure.
package wake

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"

	"lodestone/server/pkg/svc"
)

// State is the provider-neutral VM state.
type State string

const (
	Stopped  State = "stopped"
	Starting State = "starting"
	Running  State = "running"
	Stopping State = "stopping"
	Unknown  State = "unknown"
)

// Status is what a Provider reports.
type Status struct {
	State State
	// LastStart is when the VM last started (zero if unknown). It is the
	// floor for idle accounting when the activity store has nothing.
	LastStart time.Time
}

// Provider controls one game VM. Implementations must be safe for
// concurrent use; Start on a VM that is not stopped and Stop on one that is
// not running may return an error, which the Waker logs and retries later.
type Provider interface {
	Name() string
	Status(ctx context.Context) (Status, error)
	Start(ctx context.Context) error
	Stop(ctx context.Context) error
}

// ActivityStore remembers the last time anyone needed the world.
type ActivityStore interface {
	Touch(ctx context.Context, t time.Time) error
	Last(ctx context.Context) (time.Time, error)
}

// DefaultIdleAfter is spec 13's "stops it after 15 minutes with nobody online".
const DefaultIdleAfter = 15 * time.Minute

// startDebounce stops a burst of first players from each issuing a start
// call while the provider still reports the VM as stopped.
const startDebounce = 20 * time.Second

// Waker is the wake/idle state machine. Zero values for optional fields:
// Ready nil = running means awake; Players nil = no player signal (idle is
// then measured from the last wake/connect only).
type Waker struct {
	Provider  Provider
	Activity  ActivityStore
	Ready     func(ctx context.Context) error
	Players   func(ctx context.Context) (int, error)
	IdleAfter time.Duration
	Now       func() time.Time
	Log       *slog.Logger
	Metrics   *svc.Metrics

	mu        sync.Mutex
	lastStart time.Time // last Start call from this process
	// stuckSince: first Start call of the current stopped spell (zero once the
	// VM leaves Stopped). GCE accepts a start and fails it asynchronously
	// (QUOTA_EXCEEDED, ZONE_RESOURCE_POOL_EXHAUSTED), which the director cannot
	// see without operation permissions, so a VM that stays stopped is the signal.
	stuckSince time.Time
	stuckWarn  time.Time
}

func (w *Waker) now() time.Time {
	if w.Now != nil {
		return w.Now()
	}
	return time.Now()
}

func (w *Waker) idleAfter() time.Duration {
	if w.IdleAfter > 0 {
		return w.IdleAfter
	}
	return DefaultIdleAfter
}

func (w *Waker) count(name string) {
	if w.Metrics != nil {
		w.Metrics.Add(name, 1)
	}
}

// Report is the JSON the client's "waking the world" screen polls.
type Report struct {
	// State: "awake", "starting" (VM booting), "booting" (VM up, services
	// not ready), "stopping" (a stop is finishing; the next poll starts it
	// again), "unknown" (provider error).
	State       string `json:"state"`
	Awake       bool   `json:"awake"`
	Provider    string `json:"provider"`
	RetryAfterS int    `json:"retryAfterS,omitempty"`
}

// Wake is called for every request that means "a player wants the world":
// it records activity and starts the VM if it is stopped.
func (w *Waker) Wake(ctx context.Context) Report {
	now := w.now()
	rep := Report{Provider: w.Provider.Name(), RetryAfterS: 3}
	st, err := w.Provider.Status(ctx)
	if err != nil {
		w.Log.Warn("wake: provider status failed", "err", err)
		w.count("director_wake_errors_total")
		rep.State, rep.RetryAfterS = string(Unknown), 5
		return rep
	}
	// Best effort: while the VM is stopped its Redis is too, and that is fine.
	if w.Activity != nil {
		_ = w.Activity.Touch(ctx, now)
	}
	if st.State != Stopped {
		w.mu.Lock()
		w.stuckSince = time.Time{}
		w.mu.Unlock()
	}
	switch st.State {
	case Stopped:
		w.mu.Lock()
		fresh := now.Sub(w.lastStart) >= startDebounce
		if fresh {
			w.lastStart = now
		}
		if w.stuckSince.IsZero() {
			w.stuckSince = now
		} else if now.Sub(w.stuckSince) > 90*time.Second && now.Sub(w.stuckWarn) > time.Minute {
			w.stuckWarn = now
			w.Log.Error("wake: the game VM is still stopped after repeated start requests; the start is being refused (CPU quota, zone capacity or permissions) - see `gcloud compute operations list --filter=targetLink~<instance>`", "stoppedFor", now.Sub(w.stuckSince).Round(time.Second).String())
			w.count("director_wake_stuck_total")
		}
		w.mu.Unlock()
		if fresh {
			if err := w.Provider.Start(ctx); err != nil {
				w.Log.Warn("wake: start failed", "err", err)
				w.count("director_wake_errors_total")
			} else {
				w.Log.Info("wake: starting the game VM", "provider", rep.Provider)
				w.count("director_wake_starts_total")
			}
		}
		rep.State = string(Starting)
	case Starting:
		rep.State = string(Starting)
	case Stopping:
		rep.State = string(Stopping)
	case Running:
		if w.Ready != nil {
			if err := w.Ready(ctx); err != nil {
				rep.State, rep.RetryAfterS = "booting", 2
				return rep
			}
		}
		rep.State, rep.Awake, rep.RetryAfterS = "awake", true, 0
	default:
		rep.State = string(Unknown)
	}
	return rep
}

// IdleCheck stops a running VM nobody has needed for IdleAfter. It returns
// true when it issued a stop.
func (w *Waker) IdleCheck(ctx context.Context) (bool, error) {
	now := w.now()
	st, err := w.Provider.Status(ctx)
	if err != nil {
		w.count("director_wake_errors_total")
		return false, fmt.Errorf("provider status: %w", err)
	}
	if st.State != Running {
		return false, nil
	}
	if w.Players != nil {
		n, err := w.Players(ctx)
		if w.Metrics != nil && err == nil {
			w.Metrics.SetInt("director_wake_players_online", int64(n))
		}
		if err == nil && n > 0 {
			if w.Activity != nil {
				_ = w.Activity.Touch(ctx, now)
			}
			return false, nil
		}
		// An error is "no evidence of players", not "players": see the
		// package comment.
	}
	last := st.LastStart
	if w.Activity != nil {
		if t, err := w.Activity.Last(ctx); err == nil && t.After(last) {
			last = t
		}
	}
	if last.IsZero() {
		// Nothing to measure from (provider without a start time and an
		// empty store): start the clock now rather than stopping blind.
		if w.Activity != nil {
			_ = w.Activity.Touch(ctx, now)
		}
		return false, nil
	}
	idle := now.Sub(last)
	if w.Metrics != nil {
		w.Metrics.SetFloat("director_wake_idle_seconds", float64(int(idle.Seconds())))
	}
	if idle < w.idleAfter() {
		return false, nil
	}
	w.Log.Info("wake: nobody online, stopping the game VM", "idle", idle.Round(time.Second).String(), "provider", w.Provider.Name())
	if err := w.Provider.Stop(ctx); err != nil {
		w.count("director_wake_errors_total")
		return false, fmt.Errorf("stop: %w", err)
	}
	w.count("director_wake_stops_total")
	return true, nil
}

// Loop runs IdleCheck every interval until ctx ends (the in-process half of
// idle accounting; Cloud Scheduler covers the time no instance is alive).
func (w *Waker) Loop(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		if _, err := w.IdleCheck(cctx); err != nil {
			w.Log.Warn("wake: idle check", "err", err)
		}
		cancel()
	}
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.Header().Set("Cache-Control", "no-store")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(v)
}

// Register mounts POST /v1/wake (public: the client polls it before sign-in,
// when the account service's database may still be asleep) and, when
// cronToken is set, POST /internal/wake/tick for Cloud Scheduler.
func (w *Waker) Register(mux *http.ServeMux, cronToken string) {
	mux.HandleFunc("POST /v1/wake", func(rw http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		writeJSON(rw, http.StatusOK, w.Wake(ctx))
	})
	if cronToken == "" {
		return
	}
	want := []byte("Bearer " + cronToken)
	mux.HandleFunc("POST /internal/wake/tick", func(rw http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), want) != 1 {
			writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		stopped, err := w.IdleCheck(ctx)
		if err != nil {
			writeJSON(rw, http.StatusBadGateway, map[string]any{"error": "idle_check_failed", "message": err.Error()})
			return
		}
		writeJSON(rw, http.StatusOK, map[string]any{"stopped": stopped})
	})
}

// AlwaysAwake answers POST /v1/wake when no provider is configured (local
// development, tests): the client's gate passes straight through.
func AlwaysAwake(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/wake", func(rw http.ResponseWriter, _ *http.Request) {
		writeJSON(rw, http.StatusOK, Report{State: "awake", Awake: true, Provider: "none"})
	})
}

// Gate wraps the director's player endpoints: while the world is not awake
// it starts it and answers 503 waking_world (the client already retries on
// that, WP04), without touching Postgres, which lives on the sleeping VM.
func (w *Waker) Gate(paths map[string]bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !paths[r.URL.Path] {
			next.ServeHTTP(rw, r)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		rep := w.Wake(ctx)
		cancel()
		if rep.Awake {
			next.ServeHTTP(rw, r)
			return
		}
		retry := rep.RetryAfterS
		if retry <= 0 {
			retry = 3
		}
		rw.Header().Set("Retry-After", strconv.Itoa(retry))
		w.count("director_waking_total")
		writeJSON(rw, http.StatusServiceUnavailable, map[string]any{
			"error": "waking_world", "message": "The world is waking up (" + rep.State + ").", "retryAfterS": retry,
		})
	})
}

// ErrNotConfigured is returned by FromEnv when no provider is configured.
var ErrNotConfigured = errors.New("wake: no provider configured")
