// Package svc is the common shell every Go service starts with: structured
// logging, /healthz, /metrics (Prometheus text format) and graceful shutdown.
// Observability from day one (spec section 13).
package svc

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// Logger returns a JSON slog logger tagged with the service name.
func Logger(service string) *slog.Logger {
	l := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})).With("svc", service)
	slog.SetDefault(l)
	return l
}

// Metrics is a tiny dependency-free Prometheus registry. Names may carry
// labels inline, e.g. `zone_bytes_out_total{zone="z1"}`.
type Metrics struct {
	mu         sync.Mutex
	ints       map[string]*atomic.Int64
	floats     map[string]float64
	help       map[string]string
	collectors []func(*Metrics) // run on every scrape (observe.go)
}

// NewMetrics creates an empty registry.
func NewMetrics() *Metrics {
	return &Metrics{ints: map[string]*atomic.Int64{}, floats: map[string]float64{}, help: map[string]string{}}
}

// Int returns (creating if needed) an integer metric cell; keep the pointer
// on hot paths to skip the map lookup.
func (m *Metrics) Int(name string) *atomic.Int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.ints[name]
	if !ok {
		c = &atomic.Int64{}
		m.ints[name] = c
	}
	return c
}

// Add increments an integer metric.
func (m *Metrics) Add(name string, d int64) { m.Int(name).Add(d) }

// SetInt sets an integer gauge.
func (m *Metrics) SetInt(name string, v int64) { m.Int(name).Store(v) }

// SetFloat sets a float gauge (e.g. tick time percentiles in ms).
func (m *Metrics) SetFloat(name string, v float64) {
	m.mu.Lock()
	m.floats[name] = v
	m.mu.Unlock()
}

// Help documents a metric family.
func (m *Metrics) Help(family, text string) {
	m.mu.Lock()
	m.help[family] = text
	m.mu.Unlock()
}

// ServeHTTP renders Prometheus text exposition format.
func (m *Metrics) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	m.collect()
	m.mu.Lock()
	lines := make([]string, 0, len(m.ints)+len(m.floats)+len(m.help))
	for f, h := range m.help {
		lines = append(lines, fmt.Sprintf("# HELP %s %s", f, h))
	}
	for k, v := range m.ints {
		lines = append(lines, fmt.Sprintf("%s %d", k, v.Load()))
	}
	for k, v := range m.floats {
		lines = append(lines, fmt.Sprintf("%s %g", k, v))
	}
	m.mu.Unlock()
	sort.Strings(lines)
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	for _, l := range lines {
		fmt.Fprintln(w, l)
	}
}

// Server bundles a mux with health and metrics endpoints.
type Server struct {
	Name    string
	Addr    string
	Mux     *http.ServeMux
	Metrics *Metrics
	Log     *slog.Logger
	started time.Time
	http    *httpStats // observe.go
}

// New creates a service shell that will listen on addr (e.g. ":8092").
func New(name, addr string) *Server {
	s := &Server{Name: name, Addr: addr, Mux: http.NewServeMux(), Metrics: NewMetrics(), Log: Logger(name), started: time.Now()}
	s.Mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"ok":true,"svc":%q,"uptimeS":%d}`, name, int(time.Since(s.started).Seconds()))
	})
	s.Mux.Handle("GET /metrics", metricsAuth(os.Getenv("LODESTONE_METRICS_TOKEN"), s.Metrics))
	s.observe() // WP18: process/runtime/build/http metrics (observe.go)
	return s
}

// CORS wraps a handler with CORS for the browser client, which runs on another
// origin in dev. Production narrows origin via LODESTONE_CORS_ORIGIN.
func CORS(origin string, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h.ServeHTTP(w, r)
	})
}

// Run serves until SIGINT/SIGTERM, then shuts down gracefully. onStop runs
// after the listener closes (flush write-behind queues, close pools).
func (s *Server) Run(handler http.Handler, onStop func(context.Context)) error {
	return s.RunContext(context.Background(), handler, onStop)
}

// RunContext is Run with a parent context: cancelling it shuts down exactly
// like a signal does (the zone uses this for LODESTONE_ZONE_EXIT_AFTER, since
// Windows cannot deliver SIGINT to a background process).
func (s *Server) RunContext(parent context.Context, handler http.Handler, onStop func(context.Context)) error {
	if handler == nil {
		handler = s.Mux
	}
	srv := &http.Server{Addr: s.Addr, Handler: s.instrument(handler), ReadHeaderTimeout: 10 * time.Second}
	ctx, stop := signal.NotifyContext(parent, os.Interrupt, syscall.SIGTERM)
	defer stop()
	errc := make(chan error, 1)
	go func() {
		s.Log.Info("listening", "addr", s.Addr)
		errc <- srv.ListenAndServe()
	}()
	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		s.Log.Info("shutting down")
	}
	sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(sctx)
	if onStop != nil {
		onStop(sctx)
	}
	return nil
}
