package wake

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeCompute stands in for compute.googleapis.com and the metadata server.
type fakeCompute struct {
	mu     sync.Mutex
	status string
	calls  []string
}

func (f *fakeCompute) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, r.Method+" "+r.URL.Path)
	if r.URL.Path == "/computeMetadata/v1/instance/service-accounts/default/token" {
		if r.Header.Get("Metadata-Flavor") != "Google" {
			w.WriteHeader(403)
			return
		}
		_, _ = w.Write([]byte(`{"access_token":"tok-123","expires_in":3600,"token_type":"Bearer"}`))
		return
	}
	if r.Header.Get("Authorization") != "Bearer tok-123" {
		w.WriteHeader(401)
		return
	}
	const inst = "/compute/v1/projects/proj/zones/us-central1-a/instances/lodestone-game"
	switch {
	case r.Method == "GET" && r.URL.Path == inst:
		_, _ = w.Write([]byte(`{"status":"` + f.status + `","lastStartTimestamp":"2026-11-08T04:00:00.000-08:00"}`))
	case r.Method == "POST" && r.URL.Path == inst+"/start":
		f.status = "STAGING"
		_, _ = w.Write([]byte(`{"kind":"compute#operation"}`))
	case r.Method == "POST" && r.URL.Path == inst+"/resume":
		f.status = "STAGING"
		_, _ = w.Write([]byte(`{"kind":"compute#operation"}`))
	case r.Method == "POST" && r.URL.Path == inst+"/stop":
		f.status = "STOPPING"
		_, _ = w.Write([]byte(`{"kind":"compute#operation"}`))
	default:
		w.WriteHeader(404)
	}
}

// redirect sends every request (metadata.google.internal included) to srv.
type redirect struct{ target *url.URL }

func (rt redirect) RoundTrip(r *http.Request) (*http.Response, error) {
	r2 := r.Clone(r.Context())
	r2.URL.Scheme, r2.URL.Host = rt.target.Scheme, rt.target.Host
	return http.DefaultTransport.RoundTrip(r2)
}

func TestGCEProvider(t *testing.T) {
	fc := &fakeCompute{status: "TERMINATED"}
	srv := httptest.NewServer(fc)
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	g := &GCE{Project: "proj", Zone: "us-central1-a", Instance: "lodestone-game", HTTP: &http.Client{Transport: redirect{u}, Timeout: 5 * time.Second}}
	ctx := context.Background()

	st, err := g.Status(ctx)
	if err != nil || st.State != Stopped {
		t.Fatalf("status: %+v %v", st, err)
	}
	if want := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC); !st.LastStart.Equal(want) {
		t.Fatalf("lastStart %v want %v", st.LastStart, want)
	}
	if err := g.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if st, _ := g.Status(ctx); st.State != Starting {
		t.Fatalf("after start: %+v", st)
	}
	fc.status = "RUNNING"
	if st, _ := g.Status(ctx); st.State != Running {
		t.Fatalf("running: %+v", st)
	}
	if err := g.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	if st, _ := g.Status(ctx); st.State != Stopping {
		t.Fatalf("stopping: %+v", st)
	}
	// A hand-suspended instance is resumed, not started.
	fc.status = "SUSPENDED"
	if st, _ := g.Status(ctx); st.State != Stopped {
		t.Fatalf("suspended: %+v", st)
	}
	if err := g.Start(ctx); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(fc.calls, "\n")
	for _, want := range []string{"POST /compute/v1/projects/proj/zones/us-central1-a/instances/lodestone-game/start", "/resume", "/stop"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing call %q in\n%s", want, joined)
		}
	}
	// The metadata token is fetched once and cached.
	if n := strings.Count(joined, "/token"); n != 1 {
		t.Errorf("token fetched %d times", n)
	}
	// Errors carry the HTTP status.
	g.Instance = "missing"
	if _, err := g.Status(ctx); err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("missing instance: %v", err)
	}
}

func TestMapGCEStatus(t *testing.T) {
	for raw, want := range map[string]State{
		"PROVISIONING": Starting, "STAGING": Starting, "RUNNING": Running,
		"STOPPING": Stopping, "SUSPENDING": Stopping, "TERMINATED": Stopped,
		"SUSPENDED": Stopped, "REPAIRING": Unknown,
	} {
		if got := mapGCEStatus(raw); got != want {
			t.Errorf("%s -> %s, want %s", raw, got, want)
		}
	}
}
