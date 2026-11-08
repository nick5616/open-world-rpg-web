package wake

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// GCE controls one Compute Engine instance through the public REST API with
// plain net/http: no Google SDK in game code (spec 13 rule 5, "portable by
// design"). On Cloud Run the access token comes from the metadata server
// for the service's own identity, which the deploy script grants
// compute.instances.get/start/stop on this one instance only.
type GCE struct {
	Project, Zone, Instance string
	// BaseURL defaults to https://compute.googleapis.com (tests point it at
	// an httptest server).
	BaseURL string
	// Token returns an OAuth access token; nil = the metadata server.
	Token func(ctx context.Context) (string, error)
	HTTP  *http.Client

	mu        sync.Mutex
	lastRaw   string
	tok       string
	tokExpiry time.Time
}

// Name implements Provider.
func (g *GCE) Name() string { return "gce" }

func (g *GCE) client() *http.Client {
	if g.HTTP != nil {
		return g.HTTP
	}
	return &http.Client{Timeout: 15 * time.Second}
}

func (g *GCE) instanceURL(suffix string) string {
	base := g.BaseURL
	if base == "" {
		base = "https://compute.googleapis.com"
	}
	return fmt.Sprintf("%s/compute/v1/projects/%s/zones/%s/instances/%s%s",
		strings.TrimRight(base, "/"), url.PathEscape(g.Project), url.PathEscape(g.Zone), url.PathEscape(g.Instance), suffix)
}

// metadataTokenURL is the GCE/Cloud Run metadata server's token endpoint.
const metadataTokenURL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"

func (g *GCE) token(ctx context.Context) (string, error) {
	if g.Token != nil {
		return g.Token(ctx)
	}
	g.mu.Lock()
	if g.tok != "" && time.Until(g.tokExpiry) > time.Minute {
		t := g.tok
		g.mu.Unlock()
		return t, nil
	}
	g.mu.Unlock()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, metadataTokenURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Metadata-Flavor", "Google")
	res, err := g.client().Do(req)
	if err != nil {
		return "", fmt.Errorf("metadata token: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("metadata token: HTTP %d", res.StatusCode)
	}
	var body struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return "", fmt.Errorf("metadata token: %w", err)
	}
	g.mu.Lock()
	g.tok, g.tokExpiry = body.AccessToken, time.Now().Add(time.Duration(body.ExpiresIn)*time.Second)
	g.mu.Unlock()
	return body.AccessToken, nil
}

func (g *GCE) do(ctx context.Context, method, u string, out any) error {
	tok, err := g.token(ctx)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, method, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	res, err := g.client().Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode/100 != 2 {
		return fmt.Errorf("compute %s %s: HTTP %d: %s", method, u, res.StatusCode, strings.TrimSpace(string(b)))
	}
	if out != nil {
		return json.Unmarshal(b, out)
	}
	return nil
}

// mapGCEStatus maps Compute Engine instance states onto ours.
func mapGCEStatus(s string) State {
	switch s {
	case "PROVISIONING", "STAGING":
		return Starting
	case "RUNNING":
		return Running
	case "STOPPING", "SUSPENDING":
		return Stopping
	case "TERMINATED", "STOPPED", "SUSPENDED":
		return Stopped
	}
	return Unknown // REPAIRING, or something new
}

// Status implements Provider.
func (g *GCE) Status(ctx context.Context) (Status, error) {
	var body struct {
		Status             string `json:"status"`
		LastStartTimestamp string `json:"lastStartTimestamp"`
		LastResumeTime     string `json:"lastResumeTimestamp"`
	}
	if err := g.do(ctx, http.MethodGet, g.instanceURL("?fields=status,lastStartTimestamp,lastResumeTimestamp"), &body); err != nil {
		return Status{}, err
	}
	g.mu.Lock()
	g.lastRaw = body.Status
	g.mu.Unlock()
	st := Status{State: mapGCEStatus(body.Status)}
	for _, ts := range []string{body.LastStartTimestamp, body.LastResumeTime} {
		if t, err := time.Parse(time.RFC3339, ts); err == nil && t.After(st.LastStart) {
			st.LastStart = t
		}
	}
	return st, nil
}

// Start implements Provider. A suspended instance (someone suspended it by
// hand) needs resume rather than start.
func (g *GCE) Start(ctx context.Context) error {
	g.mu.Lock()
	raw := g.lastRaw
	g.mu.Unlock()
	verb := "/start"
	if raw == "SUSPENDED" {
		verb = "/resume"
	}
	return g.do(ctx, http.MethodPost, g.instanceURL(verb), nil)
}

// Stop implements Provider.
func (g *GCE) Stop(ctx context.Context) error {
	return g.do(ctx, http.MethodPost, g.instanceURL("/stop"), nil)
}

// errMissing reports a missing GCE setting.
func errMissing(name string) error {
	return errors.New("wake: " + name + " is required for LODESTONE_WAKE_PROVIDER=gce")
}
