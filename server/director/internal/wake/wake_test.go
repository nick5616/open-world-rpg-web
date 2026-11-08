package wake

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/env"
	"lodestone/server/pkg/svc"
	"lodestone/server/pkg/zoneregistry"
)

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) Add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

type rig struct {
	clk     *clock
	vm      *Fake
	act     *MemoryActivity
	players int
	plErr   error
	w       *Waker
}

func newRig() *rig {
	r := &rig{clk: &clock{t: time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)}, act: &MemoryActivity{}}
	r.vm = NewFake(30*time.Second, r.clk.Now)
	r.vm.StopTime = 10 * time.Second
	r.w = &Waker{
		Provider: r.vm, Activity: r.act, Now: r.clk.Now, Log: quiet(), Metrics: svc.NewMetrics(),
		Players: func(context.Context) (int, error) { return r.players, r.plErr },
	}
	return r
}

func TestWakeStartsStoppedVMAndReportsAwakeAfterBoot(t *testing.T) {
	r := newRig()
	ctx := context.Background()
	rep := r.w.Wake(ctx)
	if rep.State != "starting" || rep.Awake || r.vm.Starts != 1 {
		t.Fatalf("first wake: %+v starts=%d", rep, r.vm.Starts)
	}
	// A burst of other first players must not issue more starts.
	for i := 0; i < 5; i++ {
		r.clk.Add(time.Second)
		if rep := r.w.Wake(ctx); rep.Awake {
			t.Fatalf("awake too early: %+v", rep)
		}
	}
	if r.vm.Starts != 1 {
		t.Fatalf("starts = %d, want 1", r.vm.Starts)
	}
	r.clk.Add(30 * time.Second)
	if rep := r.w.Wake(ctx); !rep.Awake || rep.State != "awake" {
		t.Fatalf("after boot: %+v", rep)
	}
}

func TestReadinessGatesAwake(t *testing.T) {
	r := newRig()
	r.vm.SetRunning(r.clk.Now())
	ready := errors.New("zone not up")
	r.w.Ready = func(context.Context) error { return ready }
	if rep := r.w.Wake(context.Background()); rep.Awake || rep.State != "booting" {
		t.Fatalf("not ready: %+v", rep)
	}
	ready = nil
	if rep := r.w.Wake(context.Background()); !rep.Awake {
		t.Fatalf("ready: %+v", rep)
	}
}

func TestIdleStopAfterFifteenMinutesWithNobodyOnline(t *testing.T) {
	r := newRig()
	ctx := context.Background()
	r.w.Wake(ctx)
	r.clk.Add(30 * time.Second) // booted
	if rep := r.w.Wake(ctx); !rep.Awake {
		t.Fatalf("%+v", rep)
	}
	r.clk.Add(14 * time.Minute)
	if stopped, err := r.w.IdleCheck(ctx); err != nil || stopped {
		t.Fatalf("14 min idle: stopped=%v err=%v", stopped, err)
	}
	r.clk.Add(time.Minute + time.Second)
	if stopped, err := r.w.IdleCheck(ctx); err != nil || !stopped {
		t.Fatalf("15 min idle: stopped=%v err=%v", stopped, err)
	}
	if r.vm.Stops != 1 {
		t.Fatalf("stops=%d", r.vm.Stops)
	}
	// While it stops, a new player gets "stopping"; once stopped, it starts again.
	if rep := r.w.Wake(ctx); rep.State != "stopping" {
		t.Fatalf("during stop: %+v", rep)
	}
	r.clk.Add(10 * time.Second)
	if rep := r.w.Wake(ctx); rep.State != "starting" || r.vm.Starts != 2 {
		t.Fatalf("after stop: %+v starts=%d", rep, r.vm.Starts)
	}
}

func TestPlayersOnlineKeepTheWorldAwake(t *testing.T) {
	r := newRig()
	ctx := context.Background()
	r.vm.SetRunning(r.clk.Now())
	r.players = 3
	for i := 0; i < 12; i++ { // an hour of 5-minute ticks
		r.clk.Add(5 * time.Minute)
		if stopped, _ := r.w.IdleCheck(ctx); stopped {
			t.Fatalf("stopped with players online at tick %d", i)
		}
	}
	// Last player leaves: 15 minutes later it stops, not before.
	r.players = 0
	r.clk.Add(10 * time.Minute)
	if stopped, _ := r.w.IdleCheck(ctx); stopped {
		t.Fatal("stopped 10 min after the last player")
	}
	r.clk.Add(5 * time.Minute)
	if stopped, _ := r.w.IdleCheck(ctx); !stopped {
		t.Fatal("not stopped 15 min after the last player")
	}
}

func TestBrokenActivityStoreFallsBackToVMStartTime(t *testing.T) {
	// Redis on the VM is broken: no players signal, no activity store. The
	// VM must still stop one idle window after it started (cost safety).
	r := newRig()
	ctx := context.Background()
	r.act.Fail = true
	r.plErr = errors.New("redis down")
	r.vm.SetRunning(r.clk.Now())
	r.clk.Add(14 * time.Minute)
	if stopped, _ := r.w.IdleCheck(ctx); stopped {
		t.Fatal("stopped early")
	}
	r.clk.Add(2 * time.Minute)
	if stopped, err := r.w.IdleCheck(ctx); !stopped || err != nil {
		t.Fatalf("broken store: stopped=%v err=%v", stopped, err)
	}
}

func TestProviderOutage(t *testing.T) {
	r := newRig()
	r.vm.FailStatus = true
	if rep := r.w.Wake(context.Background()); rep.State != "unknown" || rep.Awake {
		t.Fatalf("%+v", rep)
	}
	if stopped, err := r.w.IdleCheck(context.Background()); stopped || err == nil {
		t.Fatalf("outage idle check: stopped=%v err=%v", stopped, err)
	}
}

func TestGateAndEndpoints(t *testing.T) {
	r := newRig()
	r.vm.BootTime = 0 // instantly running after start
	mux := http.NewServeMux()
	r.w.Register(mux, "cron-secret")
	inner := http.NewServeMux()
	inner.HandleFunc("POST /v1/connect", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"ticket":"t"}`)) })
	inner.HandleFunc("GET /v1/worlds", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"worlds":[]}`)) })
	mux.Handle("/", inner)
	srv := httptest.NewServer(r.w.Gate(map[string]bool{"/v1/connect": true}, mux))
	defer srv.Close()

	post := func(path, auth string) (*http.Response, map[string]any) {
		req, _ := http.NewRequest("POST", srv.URL+path, nil)
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var m map[string]any
		_ = json.NewDecoder(res.Body).Decode(&m)
		return res, m
	}

	// Asleep: connect starts the VM and answers waking_world without
	// reaching the handler (which would need Postgres).
	r.vm.BootTime = time.Hour
	res, body := post("/v1/connect", "")
	if res.StatusCode != 503 || body["error"] != "waking_world" || res.Header.Get("Retry-After") == "" {
		t.Fatalf("asleep connect: %d %v", res.StatusCode, body)
	}
	if r.vm.Starts != 1 {
		t.Fatalf("starts=%d", r.vm.Starts)
	}
	// Ungated paths pass through.
	if res, _ := http.Get(srv.URL + "/v1/worlds"); res.StatusCode != 200 {
		t.Fatalf("worlds: %d", res.StatusCode)
	}
	// /v1/wake polls.
	if _, body := post("/v1/wake", ""); body["state"] != "starting" || body["provider"] != "fake" {
		t.Fatalf("wake: %v", body)
	}
	r.clk.Add(2 * time.Hour)
	if _, body := post("/v1/wake", ""); body["awake"] != true {
		t.Fatalf("wake after boot: %v", body)
	}
	if res, body := post("/v1/connect", ""); res.StatusCode != 200 || body["ticket"] != "t" {
		t.Fatalf("awake connect: %d %v", res.StatusCode, body)
	}
	// Cron tick needs the token.
	if res, _ := post("/internal/wake/tick", ""); res.StatusCode != 401 {
		t.Fatalf("tick without token: %d", res.StatusCode)
	}
	if res, body := post("/internal/wake/tick", "Bearer cron-secret"); res.StatusCode != 200 || body["stopped"] != false {
		t.Fatalf("tick: %d %v", res.StatusCode, body)
	}
	r.clk.Add(16 * time.Minute)
	if _, body := post("/internal/wake/tick", "Bearer cron-secret"); body["stopped"] != true {
		t.Fatalf("idle tick: %v", body)
	}
}

func TestAlwaysAwakeWithoutProvider(t *testing.T) {
	t.Setenv("LODESTONE_WAKE_PROVIDER", "")
	if _, err := FromEnv(nil, quiet(), svc.NewMetrics()); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("FromEnv without provider: %v", err)
	}
	mux := http.NewServeMux()
	AlwaysAwake(mux)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("POST", "/v1/wake", nil))
	if !strings.Contains(rec.Body.String(), `"awake":true`) || !strings.Contains(rec.Body.String(), `"provider":"none"`) {
		t.Fatalf("%s", rec.Body.String())
	}
}

func TestFromEnv(t *testing.T) {
	t.Setenv("LODESTONE_WAKE_PROVIDER", "gce")
	t.Setenv("LODESTONE_WAKE_GCE_PROJECT", "p")
	t.Setenv("LODESTONE_WAKE_GCE_ZONE", "")
	t.Setenv("LODESTONE_WAKE_GCE_INSTANCE", "")
	if _, err := FromEnv(nil, quiet(), svc.NewMetrics()); err == nil || !strings.Contains(err.Error(), "ZONE") {
		t.Fatalf("missing zone: %v", err)
	}
	t.Setenv("LODESTONE_WAKE_GCE_ZONE", "us-central1-a")
	t.Setenv("LODESTONE_WAKE_GCE_INSTANCE", "lodestone-game")
	t.Setenv("LODESTONE_WAKE_IDLE", "20m")
	t.Setenv("LODESTONE_WAKE_READY_URLS", "http://10.0.0.2:8092/healthz, http://10.0.0.2:8093/healthz")
	w, err := FromEnv(nil, quiet(), svc.NewMetrics())
	if err != nil {
		t.Fatal(err)
	}
	if w.Provider.Name() != "gce" || w.IdleAfter != 20*time.Minute || w.Ready == nil {
		t.Fatalf("%+v", w)
	}
	t.Setenv("LODESTONE_WAKE_PROVIDER", "bogus")
	if _, err := FromEnv(nil, quiet(), svc.NewMetrics()); err == nil {
		t.Fatal("bogus provider accepted")
	}
}

func TestHTTPReady(t *testing.T) {
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	defer ok.Close()
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(503) }))
	defer bad.Close()
	c := &http.Client{Timeout: time.Second}
	if err := HTTPReady([]string{ok.URL}, c)(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := HTTPReady([]string{ok.URL, bad.URL}, c)(context.Background()); err == nil {
		t.Fatal("503 counted as ready")
	}
}

// Real Redis (skipped when the local compose Redis is down). A private DB
// number keeps the SCAN away from other packages' live zone entries.
func TestRedisActivityAndOnlinePlayers(t *testing.T) {
	rdb := redis.NewClient(&redis.Options{Addr: env.RedisAddr(), DB: 13})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		if env.Bool("LODESTONE_REQUIRE_INFRA", false) {
			t.Fatalf("redis: %v", err)
		}
		t.Skipf("redis unavailable: %v", err)
	}
	defer rdb.Close()
	t.Cleanup(func() {
		rdb.Del(context.Background(), activityKey, zoneregistry.Key("w-a"), zoneregistry.Key("w-b"))
	})
	rdb.Del(ctx, activityKey)
	a := RedisActivity{R: rdb}
	if last, err := a.Last(ctx); err != nil || !last.IsZero() {
		t.Fatalf("empty: %v %v", last, err)
	}
	t1 := time.UnixMilli(1_800_000_000_000)
	_ = a.Touch(ctx, t1)
	_ = a.Touch(ctx, t1.Add(-time.Minute)) // never moves back
	if last, _ := a.Last(ctx); !last.Equal(t1) {
		t.Fatalf("last=%v want %v", last, t1)
	}
	_ = zoneregistry.Announce(ctx, rdb, "w-a", zoneregistry.Entry{ZoneID: "z1", Players: 2})
	_ = zoneregistry.Announce(ctx, rdb, "w-a", zoneregistry.Entry{ZoneID: "z2", Players: 1})
	_ = zoneregistry.Announce(ctx, rdb, "w-b", zoneregistry.Entry{ZoneID: "z3", Players: 4})
	n, err := OnlinePlayers(ctx, rdb, time.Now())
	if err != nil || n != 7 {
		t.Fatalf("online=%d err=%v", n, err)
	}
	// Stale heartbeats don't count.
	if n, _ := OnlinePlayers(ctx, rdb, time.Now().Add(time.Minute)); n != 0 {
		t.Fatalf("stale online=%d", n)
	}
}
