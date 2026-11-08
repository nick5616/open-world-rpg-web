package svc

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func scrape(t *testing.T, h http.Handler, auth string) (int, string) {
	t.Helper()
	req := httptest.NewRequest("GET", "/metrics", nil)
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	b, _ := io.ReadAll(rec.Body)
	return rec.Code, string(b)
}

func TestObserveRuntimeAndHTTPMetrics(t *testing.T) {
	t.Setenv("LODESTONE_VERSION", "abc123")
	s := New("test", ":0")
	s.Mux.HandleFunc("GET /ok", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	s.Mux.HandleFunc("GET /missing", func(w http.ResponseWriter, _ *http.Request) { http.Error(w, "no", http.StatusNotFound) })
	h := s.instrument(s.Mux)
	for _, p := range []string{"/ok", "/ok", "/missing"} {
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", p, nil))
	}
	// Upgrades are not counted (they need the raw writer to hijack).
	up := httptest.NewRequest("GET", "/ok", nil)
	up.Header.Set("Upgrade", "websocket")
	h.ServeHTTP(httptest.NewRecorder(), up)

	code, body := scrape(t, s.Mux, "")
	if code != 200 {
		t.Fatalf("scrape %d", code)
	}
	for _, want := range []string{
		`lodestone_build_info{version="abc123"`,
		`http_requests_total{code="2xx"} 2`,
		`http_requests_total{code="4xx"} 1`,
		`http_request_duration_seconds_bucket{le="+Inf"} 3`,
		`http_request_duration_seconds_count 3`,
		"go_goroutines ",
		"go_heap_bytes ",
		"process_uptime_seconds ",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q in\n%s", want, body)
		}
	}
}

func TestMetricsToken(t *testing.T) {
	t.Setenv("LODESTONE_METRICS_TOKEN", "s3cret")
	s := New("test", ":0")
	if code, _ := scrape(t, s.Mux, ""); code != http.StatusUnauthorized {
		t.Fatalf("no token: %d", code)
	}
	if code, _ := scrape(t, s.Mux, "Bearer wrong"); code != http.StatusUnauthorized {
		t.Fatalf("wrong token: %d", code)
	}
	if code, _ := scrape(t, s.Mux, "Bearer s3cret"); code != http.StatusOK {
		t.Fatalf("right token: %d", code)
	}
	// Health stays open for load balancers and uptime checks.
	rec := httptest.NewRecorder()
	s.Mux.ServeHTTP(rec, httptest.NewRequest("GET", "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("healthz %d", rec.Code)
	}
}

func TestCheckDep(t *testing.T) {
	s := New("test", ":0")
	down := func(context.Context) error { return errors.New("connection refused") }
	if err := s.CheckDep(context.Background(), "postgres", down); err == nil {
		t.Fatal("strict mode must fail on an unreachable dependency")
	}
	t.Setenv("LODESTONE_LAZY_DEPS", "1")
	if err := s.CheckDep(context.Background(), "postgres", down); err != nil {
		t.Fatalf("lazy mode: %v", err)
	}
	if _, body := scrape(t, s.Mux, ""); !strings.Contains(body, `svc_dep_unreachable_at_start_total{dep="postgres"} 1`) {
		t.Fatalf("lazy failure not counted:\n%s", body)
	}
}
