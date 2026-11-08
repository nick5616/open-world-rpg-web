// Command bots drives headless bot players against a zone server for soak
// tests (spec 14 "Headless bots"; WP03 acceptance: 150 bots, tick p99 < 5 ms,
// per-client downlink within the spec 9 budget).
//
//	go run ./tools/bots -n 150 -mode spread -duration 60s
//	go run ./tools/bots -n 150 -mode clustered -radius 300 -duration 60s -json out.json
//	go run ./tools/bots -cluster http://127.0.0.1:18301,http://127.0.0.1:18302 -mode cross -n 1000 -duration 10m   (WP16)
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
		mode       = flag.String("mode", "spread", "spread | clustered | cross (WP16: walk back and forth across zone borders; needs -cluster)")
		radius     = flag.Float64("radius", 300, "clustered: disc radius in meters")
		center     = flag.String("center", "2048,2048", "clustered: disc center x,z")
		duration   = flag.Duration("duration", 60*time.Second, "how long to play after the ramp")
		warmup     = flag.Duration("warmup", 8*time.Second, "excluded from rate measurements")
		ramp       = flag.Duration("ramp", 4*time.Second, "spread connects over this long")
		zoneID     = flag.String("zone", os.Getenv("LODESTONE_ZONE_ID"), "zone id for the ticket audience (default: ask the zone's /debug/zone)")
		worldID    = flag.String("world", os.Getenv("LODESTONE_WORLD_ID"), "world id (default: ask the zone's /debug/zone)")
		seed       = flag.Int64("seed", 1, "random seed (spawns, personas)")
		jsonOut    = flag.String("json", "", "write the summary as JSON here")
		metricsURL = flag.String("metrics", "", "zone /metrics URL to scrape before disconnecting (default derived from -url)")
		metricsOut = flag.String("metrics-out", "", "save the scrape here")
		ticketArg  = flag.String("ticket", "", "connect ONE bot with this ticket, or @file (e.g. from the director POST /v1/connect), instead of a self-signed dev ticket")
		terrainArg = flag.String("terrain", "auto", "auto | on | off: predict on the zone's generated terrain (worldgen.wasm, LODESTONE_WORLDGEN_WASM) and spawn on land")
		clusterArg = flag.String("cluster", "", "WP16: comma-separated http bases of cluster zones (any live one will do): follow handoffs, fail over, sample ownership")
		giveUp     = flag.Duration("failover-giveup", 60*time.Second, "WP16: a bot that cannot reconnect for this long counts as dropped")
		sampleArg  = flag.Duration("sample-every", 2*time.Second, "WP16: ownership sampling period (0 = off)")
		borderM    = flag.Float64("border-spawn", 150, "WP16 cross mode: spawn within this distance of a border between zones")
		printChars = flag.Bool("print-characters", false, "print the bots' deterministic character ids and names as JSON and exit (seed a scratch database with them)")
		findBorder = flag.Float64("find-border", 0, "WP16: print a walkable crossing of the region line x = this value (JSON) and exit (needs the zone and its terrain)")
		tickBudget = flag.Float64("tick-budget", 0, "zone tick p99 budget in ms (default 5, or 12 with -cluster: spec 9's 300-player budget)")
	)
	flag.Parse()
	if *printChars {
		type ch struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		out := make([]ch, *n)
		for i := range out {
			out[i] = ch{characterID(i + 1), fmt.Sprintf("bot-%03d", i+1)}
		}
		_ = json.NewEncoder(os.Stdout).Encode(out)
		return
	}

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
	// The zone may serve the official world (a generated uuid), so ask it
	// rather than guess; fall back to the zone's dev defaults. It also names
	// the terrain (seed, spec, genVersion, atlasHash).
	info := zoneIdentity(*zoneURL)
	if *zoneID == "" {
		*zoneID = info.ZoneID
	}
	if *worldID == "" {
		*worldID = info.WorldID
	}
	terrain, err := openTerrain(info, *terrainArg)
	if err != nil {
		fmt.Fprintln(os.Stderr, "bots: terrain:", err)
		os.Exit(1)
	}
	if terrain != nil {
		defer terrain.Close()
		fmt.Fprintf(os.Stderr, "bots: predicting on generated terrain (seed %d, genVersion %s, atlas %s)\n", info.Seed, info.GenVersion, info.AtlasHash)
	}

	if *findBorder > 0 {
		if terrain == nil {
			fmt.Fprintln(os.Stderr, "bots: -find-border needs terrain")
			os.Exit(1)
		}
		x, y, z, ok := findBorderCrossing(terrain, *findBorder)
		if !ok {
			fmt.Fprintln(os.Stderr, "bots: no walkable crossing found")
			os.Exit(1)
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]float64{"x": x, "y": y, "z": z})
		return
	}
	cfg := &botConfig{url: *zoneURL, zoneID: *zoneID, worldID: *worldID, priv: priv, centerX: cx, centerZ: cz,
		worldM: constants.WorldSizeM, warmup: *warmup, pingPeriod: time.Second, ticket: *ticketArg, terrain: terrain}
	if terrain != nil {
		cfg.structures = withStructures(terrain)
	}
	if strings.HasPrefix(cfg.ticket, "@") {
		b, err := os.ReadFile(cfg.ticket[1:])
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		cfg.ticket = strings.TrimSpace(string(b))
	}
	if cfg.ticket != "" {
		*n = 1
	}
	var view *clusterView
	if *clusterArg != "" {
		view = newClusterView(strings.Split(*clusterArg, ","))
		if !view.refresh() {
			fmt.Fprintln(os.Stderr, "bots: no cluster zone answered /debug/cluster at", *clusterArg)
			os.Exit(1)
		}
		cfg.view, cfg.failoverGiveUp = view, *giveUp
	}
	switch *mode {
	case "clustered":
		cfg.radius = *radius
	case "spread":
	case "cross":
		if view == nil {
			fmt.Fprintln(os.Stderr, "mode cross needs -cluster")
			os.Exit(2)
		}
		cfg.cross = true
	default:
		fmt.Fprintln(os.Stderr, "mode must be spread, clustered or cross")
		os.Exit(2)
	}

	rng := rand.New(rand.NewSource(*seed))
	bots := make([]*bot, *n)
	draw := func() (x, z float64) {
		if cfg.radius > 0 {
			r := cfg.radius * math.Sqrt(rng.Float64()) // uniform over the disc
			a := rng.Float64() * 2 * math.Pi
			return cx + r*math.Cos(a), cz + r*math.Sin(a)
		}
		const margin = 100
		for try := 0; ; try++ {
			x, z = margin+rng.Float64()*(cfg.worldM-2*margin), margin+rng.Float64()*(cfg.worldM-2*margin)
			if !cfg.cross || try > 200 {
				return x, z
			}
			// WP16 cross: start near a border between zones.
			if _, _, d, ok := view.nearestForeign(x, z, 0); ok && d < *borderM {
				return x, z
			}
		}
	}
	for i := range bots {
		x, z := draw()
		if terrain != nil {
			x, z = landSpawn(terrain, draw)
		}
		bots[i] = newBot(i+1, cfg, *seed*100003+int64(i), x, z)
	}
	if terrain != nil {
		// Generate the bots' own chunks before connecting: doing it during
		// the ramp competes for CPU with the zone on a shared machine, and a
		// starved bot sends bunched packets that trip the zone's frame
		// budget (dropped frames = resyncs that have nothing to do with
		// terrain).
		t0 := time.Now()
		for _, b := range bots {
			terrain.Want(b.spawnX, b.spawnZ, 48)
		}
		wctx, wcancel := context.WithTimeout(context.Background(), 2*time.Minute)
		_ = terrain.WaitIdle(wctx)
		wcancel()
		fmt.Fprintf(os.Stderr, "bots: terrain warm (%d chunks) in %s\n", terrain.Stats().Chunks, time.Since(t0).Round(time.Millisecond))
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

	var owners *ownershipStats
	sampleDone := make(chan struct{})
	sctx, stopSample := context.WithCancel(ctx)
	if view != nil && *sampleArg > 0 {
		go func() {
			defer close(sampleDone)
			owners = sampleOwnership(sctx, view, bots, *sampleArg)
		}()
	} else {
		close(sampleDone)
	}

	select {
	case <-time.After(*duration):
	case <-ctx.Done():
	}
	stopSample()
	<-sampleDone
	zones := scrapeZones(view)

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

	if view != nil && *tickBudget == 0 {
		*tickBudget = 12
	}
	sum := summarize(bots, *mode, *n, cfg.radius, time.Since(start), scrape, *tickBudget)
	if view != nil {
		clusterVerdict(&sum, bots, owners, zones, *tickBudget)
	}
	if terrain != nil {
		sum.Terrain = terrainSummary(info, terrain, bots)
	}
	printSummary(sum)
	if *jsonOut != "" {
		b, _ := json.MarshalIndent(sum, "", "  ")
		_ = os.WriteFile(*jsonOut, b, 0o644)
	}
	if !sum.Pass {
		os.Exit(3)
	}
}

// zoneIdentity reads the zone's /debug/zone (ids, seed, genVersion, spec,
// atlasHash), or returns the zone's dev ids if that fails.
func zoneIdentity(ws string) zoneInfo {
	u := strings.TrimSuffix(deriveMetricsURL(ws), "/metrics") + "/debug/zone"
	var id zoneInfo
	if body := fetch(u); body != "" && json.Unmarshal([]byte(body), &id) == nil && id.ZoneID != "" {
		return id
	}
	fmt.Fprintln(os.Stderr, "bots: could not read", u, "; using dev zone/world ids")
	return zoneInfo{ZoneID: "zone-dev-1", WorldID: "00000000-0000-0000-0000-000000000001"}
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
	PredMismatch   int                `json:"predictionMismatches"`
	Terrain        map[string]any     `json:"terrain,omitempty"`
	Kicks          map[string]int     `json:"kicks"`
	Errors         map[string]int     `json:"errors"`
	Personas       map[string]int     `json:"personas"`
	Zone           map[string]float64 `json:"zone"`
	BudgetDownKbps float64            `json:"budgetDownKbps"`
	BudgetUpKbps   float64            `json:"budgetUpKbps"`
	BudgetTickP99  float64            `json:"budgetTickP99Ms"`
	Pass           bool               `json:"pass"`
	Failures       []string           `json:"failures,omitempty"`
	Cluster        *ClusterSummary    `json:"cluster,omitempty"`
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

func summarize(bots []*bot, mode string, n int, radius float64, wall time.Duration, scrape string, tickBudget float64) Summary {
	if tickBudget <= 0 {
		tickBudget = 5
	}
	s := Summary{Mode: mode, Bots: n, RadiusM: radius, WallS: math.Round(wall.Seconds()*10) / 10, GoVersion: runtime.Version(), OS: runtime.GOOS + "/" + runtime.GOARCH,
		Kicks: map[string]int{}, Errors: map[string]int{}, Personas: map[string]int{}, BudgetUpKbps: 24, BudgetTickP99: tickBudget}
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
		s.PredMismatch += st.PredMismatch
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
	s.BudgetTickP99 = tickBudget
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
	fmt.Printf("prediction: %d checks, %d mismatches (>= 1 cm), max error %d cm, %d resyncs\n", s.PredChecks, s.PredMismatch, s.PredErrMaxCm, s.PredResyncs)
	if s.Terrain != nil {
		b, _ := json.Marshal(s.Terrain)
		fmt.Printf("terrain: %s\n", b)
	}
	fmt.Printf("personas %v kicks %v errors %v\n", s.Personas, s.Kicks, s.Errors)
	keys := []string{`zone_tick_ms{q="p50"}`, `zone_tick_ms{q="p99"}`, `zone_tick_ms{q="max"}`, `zone_tick_jitter_ms{q="p50"}`, `zone_tick_jitter_ms{q="p99"}`, `zone_tick_jitter_ms{q="max"}`,
		"zone_players", `zone_client_down_kbps{q="max"}`, `zone_client_up_kbps{q="max"}`, `zone_aoi_entities_avg{ring="near"}`, `zone_aoi_entities_avg{ring="mid"}`, `zone_aoi_entities_avg{ring="far"}`,
		"zone_aoi_entities_max", "zone_snapshot_bytes_avg", "zone_writebehind_depth", "zone_speed_violations_total", "zone_input_frames_dropped_total",
		"zone_terrain_chunks", `zone_terrain_queries_total{path="cache"}`, `zone_terrain_queries_total{path="wasm"}`, "zone_terrain_generated_total", "zone_terrain_gen_ms_mean", "zone_terrain_gen_ms_max", "zone_terrain_dropped_total"}
	for _, k := range keys {
		if v, ok := s.Zone[k]; ok {
			fmt.Printf("  %-40s %g\n", k, v)
		}
	}
	if c := s.Cluster; c != nil {
		printCluster(c)
	}
	if s.Pass {
		fmt.Println("PASS")
	} else {
		fmt.Println("FAIL:", strings.Join(s.Failures, "; "))
	}
}
