// Command bots drives headless bot players against a zone server for soak
// tests (spec 14 "Headless bots"; WP03 acceptance: 150 bots, tick p99 < 5 ms,
// per-client downlink within the spec 9 budget).
//
//	go run ./tools/bots -n 150 -mode spread -duration 60s
//	go run ./tools/bots -n 150 -mode clustered -radius 300 -duration 60s -json out.json
//
// Spread: bots spawn uniformly over the world (typical exploring density,
// budget 64 kbps). Clustered: bots spawn in a disc and steer back into it, so
// every bot has 100+ players in view (budget 160 kbps). Spawn points use the
// zone's dev-only `?spawn=x,z` (enabled when the zone runs with the dev
// ticket key). Rates exclude the first -warmup seconds (connect ramp and
// full first snapshots).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/ticket"
)

func main() {
	var (
		zoneURL    = flag.String("url", "ws://localhost:8092/ws", "zone WebSocket URL")
		n          = flag.Int("n", 150, "number of bots")
		mode       = flag.String("mode", "spread", "spread | clustered")
		radius     = flag.Float64("radius", 300, "clustered: disc radius in meters")
		center     = flag.String("center", "2048,2048", "clustered: disc center x,z")
		duration   = flag.Duration("duration", 60*time.Second, "how long to play after the ramp")
		warmup     = flag.Duration("warmup", 8*time.Second, "excluded from rate measurements")
		ramp       = flag.Duration("ramp", 4*time.Second, "spread connects over this long")
		zoneID     = flag.String("zone", envOr("LODESTONE_ZONE_ID", "zone-dev-1"), "zone id (ticket audience)")
		worldID    = flag.String("world", envOr("LODESTONE_WORLD_ID", "00000000-0000-0000-0000-000000000001"), "world id")
		seed       = flag.Int64("seed", 1, "random seed (spawns, personas)")
		jsonOut    = flag.String("json", "", "write the summary as JSON here")
		metricsURL = flag.String("metrics", "", "zone /metrics URL to scrape before disconnecting (default derived from -url)")
		metricsOut = flag.String("metrics-out", "", "save the scrape here")
	)
	flag.Parse()

	priv, dev, err := ticket.PrivateKeyFromEnv()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if dev {
		fmt.Fprintln(os.Stderr, "bots: signing tickets with the development key")
	}
	cx, cz := 2048.0, 2048.0
	fmt.Sscanf(*center, "%f,%f", &cx, &cz)

	cfg := &botConfig{url: *zoneURL, zoneID: *zoneID, worldID: *worldID, priv: priv, centerX: cx, centerZ: cz,
		worldM: constants.WorldSizeM, warmup: *warmup, pingPeriod: time.Second}
	if *mode == "clustered" {
		cfg.radius = *radius
	} else if *mode != "spread" {
		fmt.Fprintln(os.Stderr, "mode must be spread or clustered")
		os.Exit(2)
	}

	rng := rand.New(rand.NewSource(*seed))
	bots := make([]*bot, *n)
	for i := range bots {
		var x, z float64
		if cfg.radius > 0 {
			r := cfg.radius * math.Sqrt(rng.Float64()) // uniform over the disc
			a := rng.Float64() * 2 * math.Pi
			x, z = cx+r*math.Cos(a), cz+r*math.Sin(a)
		} else {
			const margin = 100
			x = margin + rng.Float64()*(cfg.worldM-2*margin)
			z = margin + rng.Float64()*(cfg.worldM-2*margin)
		}
		bots[i] = newBot(i+1, cfg, *seed*100003+int64(i), x, z)
	}

	ctx, cancel := context.WithCancel(context.Background())
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt)
	go func() { <-sig; cancel() }()

	start := time.Now()
	var wg sync.WaitGroup
	for i, b := range bots {
		wg.Add(1)
		go func(b *bot) { defer wg.Done(); b.run(ctx) }(b)
		if *n > 1 {
			time.Sleep(*ramp / time.Duration(*n))
		}
		_ = i
	}
	fmt.Fprintf(os.Stderr, "bots: %d connecting in %s mode, playing %s\n", *n, *mode, duration.String())

	select {
	case <-time.After(*duration):
	case <-ctx.Done():
	}

	// Scrape the zone while every bot is still connected: its per-client
	// bandwidth and 60 s tick window cover exactly the soak.
	scrape := ""
	murl := *metricsURL
	if murl == "" {
		murl = deriveMetricsURL(*zoneURL)
	}
	if murl != "" {
		scrape = fetch(murl)
		if *metricsOut != "" && scrape != "" {
			_ = os.WriteFile(*metricsOut, []byte(scrape), 0o644)
		}
	}
	cancel()
	wg.Wait()

	sum := summarize(bots, *mode, *n, cfg.radius, time.Since(start), scrape)
	printSummary(sum)
	if *jsonOut != "" {
		b, _ := json.MarshalIndent(sum, "", "  ")
		_ = os.WriteFile(*jsonOut, b, 0o644)
	}
	if !sum.Pass {
		os.Exit(3)
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func deriveMetricsURL(ws string) string {
	u, err := url.Parse(ws)
	if err != nil {
		return ""
	}
	u.Scheme = strings.Replace(strings.Replace(u.Scheme, "wss", "https", 1), "ws", "http", 1)
	u.Path, u.RawQuery = "/metrics", ""
	return u.String()
}

func fetch(u string) string {
	c := http.Client{Timeout: 5 * time.Second}
	r, err := c.Get(u)
	if err != nil {
		fmt.Fprintln(os.Stderr, "metrics scrape:", err)
		return ""
	}
	defer r.Body.Close()
	b, _ := io.ReadAll(r.Body)
	return string(b)
}

// Summary is the soak result (printed and optionally saved as JSON).
type Summary struct {
	Mode           string             `json:"mode"`
	Bots           int                `json:"bots"`
	Connected      int                `json:"connected"`
	RadiusM        float64            `json:"radiusM,omitempty"`
	WallS          float64            `json:"wallS"`
	GoVersion      string             `json:"go"`
	OS             string             `json:"os"`
	DownKbps       Q                  `json:"downKbps"`
	UpKbps         Q                  `json:"upKbps"`
	EntsInView     Q                  `json:"entitiesInView"`
	SnapBytes      Q                  `json:"snapshotBytes"`
	RTTms          Q                  `json:"rttMs"`
	Snapshots      int                `json:"snapshots"`
	FullSnapshots  int                `json:"fullSnapshots"`
	DecodeErrors   int                `json:"decodeErrors"`
	ApplyErrors    int                `json:"applyErrors"`
	PredChecks     int                `json:"predictionChecks"`
	PredErrMaxCm   int32              `json:"predictionErrMaxCm"`
	PredResyncs    int                `json:"predictionResyncs"`
	Kicks          map[string]int     `json:"kicks"`
	Errors         map[string]int     `json:"errors"`
	Personas       map[string]int     `json:"personas"`
	Zone           map[string]float64 `json:"zone"`
	BudgetDownKbps float64            `json:"budgetDownKbps"`
	BudgetUpKbps   float64            `json:"budgetUpKbps"`
	BudgetTickP99  float64            `json:"budgetTickP99Ms"`
	Pass           bool               `json:"pass"`
	Failures       []string           `json:"failures,omitempty"`
	PerBot         []botStats         `json:"perBot"`
}

// Q is a distribution across bots.
type Q struct {
	Avg float64 `json:"avg"`
	P50 float64 `json:"p50"`
	P95 float64 `json:"p95"`
	Max float64 `json:"max"`
}

func pct(v []float64, p float64) float64 {
	if len(v) == 0 {
		return 0
	}
	s := append([]float64(nil), v...)
	sort.Float64s(s)
	return s[min(len(s)-1, int(float64(len(s))*p))]
}

func dist(v []float64) Q {
	if len(v) == 0 {
		return Q{}
	}
	var a float64
	for _, x := range v {
		a += x
	}
	r := func(x float64) float64 { return math.Round(x*100) / 100 }
	return Q{Avg: r(a / float64(len(v))), P50: r(pct(v, 0.5)), P95: r(pct(v, 0.95)), Max: r(pct(v, 1))}
}

func summarize(bots []*bot, mode string, n int, radius float64, wall time.Duration, scrape string) Summary {
	s := Summary{Mode: mode, Bots: n, RadiusM: radius, WallS: math.Round(wall.Seconds()*10) / 10, GoVersion: runtime.Version(), OS: runtime.GOOS + "/" + runtime.GOARCH,
		Kicks: map[string]int{}, Errors: map[string]int{}, Personas: map[string]int{}, BudgetUpKbps: 24, BudgetTickP99: 5}
	s.BudgetDownKbps = 64
	if mode == "clustered" {
		s.BudgetDownKbps = 160
	}
	var down, up, ents, snapB, rtt []float64
	for _, b := range bots {
		b.mu.Lock()
		st := b.st
		b.mu.Unlock()
		s.Personas[st.Persona]++
		if st.Error != "" {
			s.Errors[st.Error]++
		}
		if st.Kick != "" {
			s.Kicks[st.Kick]++
		}
		if st.Connected {
			s.Connected++
			down = append(down, st.DownKbps)
			up = append(up, st.UpKbps)
			ents = append(ents, st.EntsAvg)
			snapB = append(snapB, st.SnapBytesAvg)
			if st.RTTp50 > 0 {
				rtt = append(rtt, st.RTTp50)
			}
		}
		s.Snapshots += st.Snapshots
		s.FullSnapshots += st.FullSnapshots
		s.DecodeErrors += st.DecodeErrors
		s.ApplyErrors += st.ApplyErrors
		s.PredChecks += st.PredChecks
		s.PredResyncs += st.PredResyncs
		if st.PredErrMaxCm > s.PredErrMaxCm {
			s.PredErrMaxCm = st.PredErrMaxCm
		}
		st.DownKbps = math.Round(st.DownKbps*100) / 100
		st.UpKbps = math.Round(st.UpKbps*100) / 100
		st.EntsAvg = math.Round(st.EntsAvg*10) / 10
		st.SnapBytesAvg = math.Round(st.SnapBytesAvg)
		s.PerBot = append(s.PerBot, st)
	}
	s.DownKbps, s.UpKbps, s.EntsInView, s.SnapBytes, s.RTTms = dist(down), dist(up), dist(ents), dist(snapB), dist(rtt)
	s.Zone = parseZoneMetrics(scrape)

	fail := func(f string, a ...any) { s.Failures = append(s.Failures, fmt.Sprintf(f, a...)) }
	if s.Connected < n {
		fail("%d of %d bots connected", s.Connected, n)
	}
	if s.DownKbps.Max > s.BudgetDownKbps {
		fail("downlink max %.1f kbps > %.0f", s.DownKbps.Max, s.BudgetDownKbps)
	}
	if s.UpKbps.Max > s.BudgetUpKbps {
		fail("uplink max %.1f kbps > %.0f", s.UpKbps.Max, s.BudgetUpKbps)
	}
	if p99, ok := s.Zone[`zone_tick_ms{q="p99"}`]; ok && p99 >= s.BudgetTickP99 {
		fail("zone tick p99 %.3f ms >= %.0f", p99, s.BudgetTickP99)
	}
	if s.DecodeErrors+s.ApplyErrors > 0 {
		fail("%d decode / %d apply errors", s.DecodeErrors, s.ApplyErrors)
	}
	s.Pass = len(s.Failures) == 0
	return s
}

// parseZoneMetrics keeps the zone_* samples that matter for the verdict.
func parseZoneMetrics(scrape string) map[string]float64 {
	out := map[string]float64{}
	for _, line := range strings.Split(scrape, "\n") {
		if !strings.HasPrefix(line, "zone_") {
			continue
		}
		i := strings.LastIndexByte(line, ' ')
		if i < 0 {
			continue
		}
		var v float64
		if _, err := fmt.Sscanf(line[i+1:], "%g", &v); err == nil {
			out[line[:i]] = v
		}
	}
	return out
}

func printSummary(s Summary) {
	fmt.Printf("== bots: %s, %d/%d connected, %.0f s wall (%s, %s)\n", s.Mode, s.Connected, s.Bots, s.WallS, s.OS, s.GoVersion)
	fmt.Printf("downlink kbps   avg %7.2f  p50 %7.2f  p95 %7.2f  max %7.2f   (budget %.0f)\n", s.DownKbps.Avg, s.DownKbps.P50, s.DownKbps.P95, s.DownKbps.Max, s.BudgetDownKbps)
	fmt.Printf("uplink kbps     avg %7.2f  p50 %7.2f  p95 %7.2f  max %7.2f   (budget %.0f)\n", s.UpKbps.Avg, s.UpKbps.P50, s.UpKbps.P95, s.UpKbps.Max, s.BudgetUpKbps)
	fmt.Printf("entities/view   avg %7.1f  p50 %7.1f  p95 %7.1f  max %7.1f\n", s.EntsInView.Avg, s.EntsInView.P50, s.EntsInView.P95, s.EntsInView.Max)
	fmt.Printf("snapshot bytes  avg %7.1f  p50 %7.1f  p95 %7.1f  max %7.1f\n", s.SnapBytes.Avg, s.SnapBytes.P50, s.SnapBytes.P95, s.SnapBytes.Max)
	fmt.Printf("rtt ms          p50 %7.2f  max %7.2f\n", s.RTTms.P50, s.RTTms.Max)
	fmt.Printf("snapshots %d (full %d), decode errors %d, apply errors %d\n", s.Snapshots, s.FullSnapshots, s.DecodeErrors, s.ApplyErrors)
	fmt.Printf("prediction: %d checks, max error %d cm, %d resyncs\n", s.PredChecks, s.PredErrMaxCm, s.PredResyncs)
	fmt.Printf("personas %v kicks %v errors %v\n", s.Personas, s.Kicks, s.Errors)
	keys := []string{`zone_tick_ms{q="p50"}`, `zone_tick_ms{q="p99"}`, `zone_tick_ms{q="max"}`, `zone_tick_jitter_ms{q="p50"}`, `zone_tick_jitter_ms{q="p99"}`, `zone_tick_jitter_ms{q="max"}`,
		"zone_players", `zone_client_down_kbps{q="max"}`, `zone_client_up_kbps{q="max"}`, `zone_aoi_entities_avg{ring="near"}`, `zone_aoi_entities_avg{ring="mid"}`, `zone_aoi_entities_avg{ring="far"}`,
		"zone_aoi_entities_max", "zone_snapshot_bytes_avg", "zone_writebehind_depth", "zone_speed_violations_total", "zone_input_frames_dropped_total"}
	for _, k := range keys {
		if v, ok := s.Zone[k]; ok {
			fmt.Printf("  %-40s %g\n", k, v)
		}
	}
	if s.Pass {
		fmt.Println("PASS")
	} else {
		fmt.Println("FAIL:", strings.Join(s.Failures, "; "))
	}
}
