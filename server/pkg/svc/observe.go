package svc

// WP18 observability additions, shared by every service through svc.New:
//
//   - process/runtime gauges read at scrape time (uptime, goroutines, heap,
//     GC cycles) via runtime/metrics, which does not stop the world the way
//     runtime.ReadMemStats can, so a scrape never adds to a zone tick;
//   - lodestone_build_info{version} from LODESTONE_VERSION (the deploy
//     scripts bake the git sha into every image), so a dashboard can tell
//     which build is serving;
//   - http_requests_total{code} and a small latency histogram for the plain
//     HTTP endpoints (WebSocket upgrades are passed through untouched: they
//     need the raw ResponseWriter to hijack, and their traffic is counted by
//     the services themselves);
//   - LODESTONE_METRICS_TOKEN: when set, /metrics wants "Authorization:
//     Bearer <token>". Cloud Run services are public URLs; their metrics
//     should not be;
//   - CheckDep / LODESTONE_LAZY_DEPS for services on Cloud Run whose
//     Postgres and Redis live on the game VM that sleeps (spec 13).

import (
	"context"
	"crypto/subtle"
	"fmt"
	"net/http"
	"os"
	"runtime"
	"runtime/metrics"
	"strconv"
	"sync/atomic"
	"time"
)

// OnScrape registers f to run right before every /metrics render; use it
// for gauges that are cheap to read but pointless to keep updated.
func (m *Metrics) OnScrape(f func(*Metrics)) {
	m.mu.Lock()
	m.collectors = append(m.collectors, f)
	m.mu.Unlock()
}

func (m *Metrics) collect() {
	m.mu.Lock()
	cs := append([]func(*Metrics){}, m.collectors...)
	m.mu.Unlock()
	for _, f := range cs {
		f(m)
	}
}

// latencyBuckets are seconds; HTTP endpoints here are sign-in, tickets and
// mints, so the interesting range is 1 ms to a few seconds (a mint builds an
// atlas, ~0.5 s).
var latencyBuckets = []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5}

type httpStats struct {
	codes   [6]*atomic.Int64 // index = status/100 (0 unused)
	buckets []*atomic.Int64
	inf     *atomic.Int64
	sumUS   atomic.Int64
}

func (s *Server) observe() {
	m := s.Metrics
	version := os.Getenv("LODESTONE_VERSION")
	if version == "" {
		version = "dev"
	}
	m.SetInt(fmt.Sprintf(`lodestone_build_info{version=%q,go=%q}`, version, runtime.Version()), 1)
	m.Help("lodestone_build_info", "Always 1; labels name the build (LODESTONE_VERSION) and Go version.")
	m.Help("process_uptime_seconds", "Seconds since the service started.")
	m.Help("go_goroutines", "Live goroutines.")
	m.Help("go_heap_bytes", "Bytes in live and unswept heap objects.")
	m.Help("go_gc_cycles_total", "Completed GC cycles.")
	m.Help("http_requests_total", "Plain HTTP requests by status class (WebSocket upgrades excluded).")
	m.Help("http_request_duration_seconds", "Plain HTTP request latency histogram.")

	samples := []metrics.Sample{
		{Name: "/sched/goroutines:goroutines"},
		{Name: "/memory/classes/heap/objects:bytes"},
		{Name: "/gc/cycles/total:gc-cycles"},
	}
	started := s.started
	st := &httpStats{}
	for i := 1; i <= 5; i++ {
		st.codes[i] = m.Int(fmt.Sprintf(`http_requests_total{code="%dxx"}`, i))
	}
	for _, b := range latencyBuckets {
		st.buckets = append(st.buckets, m.Int(`http_request_duration_seconds_bucket{le="`+strconv.FormatFloat(b, 'g', -1, 64)+`"}`))
	}
	st.inf = m.Int(`http_request_duration_seconds_bucket{le="+Inf"}`)
	s.http = st
	m.OnScrape(func(m *Metrics) {
		m.SetFloat("process_uptime_seconds", float64(int(time.Since(started).Seconds())))
		metrics.Read(samples)
		for _, smp := range samples {
			if smp.Value.Kind() != metrics.KindUint64 {
				continue
			}
			v := int64(smp.Value.Uint64())
			switch smp.Name {
			case "/sched/goroutines:goroutines":
				m.SetInt("go_goroutines", v)
			case "/memory/classes/heap/objects:bytes":
				m.SetInt("go_heap_bytes", v)
			case "/gc/cycles/total:gc-cycles":
				m.SetInt("go_gc_cycles_total", v)
			}
		}
		m.SetFloat("http_request_duration_seconds_sum", float64(st.sumUS.Load())/1e6)
		m.SetInt("http_request_duration_seconds_count", st.inf.Load())
	})
}

type statusRecorder struct {
	http.ResponseWriter
	code int
}

func (r *statusRecorder) WriteHeader(code int) {
	if r.code == 0 {
		r.code = code
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if r.code == 0 {
		r.code = http.StatusOK
	}
	return r.ResponseWriter.Write(b)
}

// Unwrap lets http.ResponseController reach the real writer (Flush etc.).
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

// instrument counts plain HTTP requests. Upgrades (WebSocket) and requests
// to a Server built without svc.New pass straight through.
func (s *Server) instrument(h http.Handler) http.Handler {
	st := s.http
	if st == nil {
		return h
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Upgrade") != "" {
			h.ServeHTTP(w, r)
			return
		}
		t0 := time.Now()
		rec := &statusRecorder{ResponseWriter: w}
		h.ServeHTTP(rec, r)
		code := rec.code
		if code == 0 {
			code = http.StatusOK
		}
		if c := code / 100; c >= 1 && c <= 5 {
			st.codes[c].Add(1)
		}
		d := time.Since(t0)
		sec := d.Seconds()
		for i, b := range latencyBuckets {
			if sec <= b {
				st.buckets[i].Add(1)
			}
		}
		st.inf.Add(1)
		st.sumUS.Add(d.Microseconds())
	})
}

// metricsAuth guards /metrics with a bearer token when one is configured.
func metricsAuth(token string, h http.Handler) http.Handler {
	if token == "" {
		return h
	}
	want := []byte("Bearer " + token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), want) != 1 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		h.ServeHTTP(w, r)
	})
}

// LazyDeps reports LODESTONE_LAZY_DEPS=1: start serving even when Postgres or
// Redis cannot be reached yet. Set on Cloud Run (director, account, creator):
// their database lives on the game VM, which is stopped while nobody plays,
// and Cloud Run refuses a revision whose container exits at startup. Off by
// default, so local development keeps failing fast on a missing database.
func LazyDeps() bool {
	switch os.Getenv("LODESTONE_LAZY_DEPS") {
	case "1", "true", "yes":
		return true
	}
	return false
}

// CheckDep pings a dependency at startup. A failure is returned (fatal) unless
// LazyDeps is on, in which case it is logged and the service starts anyway;
// pgx pools and go-redis clients reconnect on their own once it is reachable.
func (s *Server) CheckDep(ctx context.Context, name string, ping func(context.Context) error) error {
	if LazyDeps() {
		// A sleeping VM's address just times out; don't hold up the
		// Cloud Run startup probe for the full caller timeout.
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
	}
	err := ping(ctx)
	if err == nil {
		return nil
	}
	if LazyDeps() {
		s.Log.Warn("dependency unreachable at startup; serving anyway (LODESTONE_LAZY_DEPS)", "dep", name, "err", err)
		s.Metrics.Add(fmt.Sprintf(`svc_dep_unreachable_at_start_total{dep=%q}`, name), 1)
		return nil
	}
	return fmt.Errorf("%s: %w", name, err)
}
