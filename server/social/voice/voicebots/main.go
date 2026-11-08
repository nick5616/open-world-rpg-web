// Command voicebots is the proximity-voice soak (spec 14 scenario 3, WP11):
// N bots, each a zone player, a social session and a LiveKit participant
// publishing synthetic Opus speech, cluster and then disperse and regroup.
// It records every earshot decision the zone publishes and every
// subscription change each bot's LiveKit client sees, then reports how long
// subscriptions took to follow earshot and whether any pair flapped.
//
// Why Go bots and not headless browsers: 50 Chromium pages each encoding and
// decoding Opus through WebRTC is ~50 renderer processes on one desktop (and
// the soak shares the machine with other agents). Pion bots in one process
// are real WebRTC participants (DTLS, SRTP, ICE, renegotiation on every
// subscription change), which is what the measurement is about; the
// browser audio path is covered by the two-browser test
// (client/src/voice/dev/walkapart.mjs).
//
// It is its own module (not in go.work) so pion and the LiveKit SDK never
// enter the service modules' dependency graph. Run from the repo root:
//
//	node scripts/go.mjs ... (not needed) ->
//	cd server/social/voice/voicebots && GOWORK=off go run . -spawn
//
// -spawn builds and starts a zone and a social service on private ports
// against the shared Redis/Postgres/LiveKit; without it, point -zone/-social
// at running services.
package main

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/earshot"
	"lodestone/server/pkg/ticket"
)

type config struct {
	bots      int
	zoneURL   string
	zoneID    string
	socialURL string
	worldID   string
	redisAddr string
	cx, cz    float64
	clusterR  float64
	priv      ed25519.PrivateKey
	speakFlag bool
	traceBot  int
}

func main() {
	cfg := &config{}
	flag.IntVar(&cfg.bots, "bots", 50, "voice bots")
	spawn := flag.Bool("spawn", false, "build and start zone + social on private ports")
	zonePort := flag.Int("zone-port", 18392, "zone port with -spawn")
	socialPort := flag.Int("social-port", 18393, "social port with -spawn")
	livekitURL := flag.String("livekit", "ws://localhost:7880", "LiveKit URL the spawned social service hands out (see README: the compose LiveKit's UDP range fits ~25 participants)")
	flag.StringVar(&cfg.zoneURL, "zone", "", "zone ws URL (default from -spawn)")
	flag.StringVar(&cfg.zoneID, "zone-id", "zone-voicesoak", "zone id (ticket audience)")
	flag.StringVar(&cfg.socialURL, "social", "", "social ws URL (default from -spawn)")
	flag.StringVar(&cfg.worldID, "world", "00000000-0000-4000-8000-00000000b011", "world id (uuid)")
	flag.StringVar(&cfg.redisAddr, "redis", envOr("LODESTONE_REDIS_ADDR", "localhost:56379"), "redis")
	flag.Float64Var(&cfg.clusterR, "cluster", 14, "cluster radius, m")
	flag.BoolVar(&cfg.speakFlag, "speaking-flag", true, "set InputFlag.speaking while publishing")
	flag.IntVar(&cfg.traceBot, "trace-bot", -1, "log one bot's LiveKit SDK debug output (SDP timing)")
	hold := flag.Duration("hold", 10*time.Second, "clustered hold")
	disperse := flag.Duration("disperse", 20*time.Second, "walk outward")
	regroup := flag.Duration("regroup", 22*time.Second, "walk back")
	out := flag.String("out", "", "evidence path prefix (writes .txt, .json)")
	opusPath := flag.String("opus", "testdata/speech.opus.bin", "Opus packets ([u16 len][bytes]...)")
	flag.Parse()
	cfg.cx, cfg.cz = 2048, 2048
	priv, _, err := ticket.PrivateKeyFromEnv()
	must(err)
	cfg.priv = priv

	packets, err := loadOpus(*opusPath)
	must(err)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if *spawn {
		// Killed by exit() on every path (os.Exit skips defers, and a
		// leftover social on the port would silently serve the next run).
		spawnServices(cfg, *zonePort, *socialPort, *livekitURL)
	}

	rec := newRecorder()
	rdb := redis.NewClient(&redis.Options{Addr: cfg.redisAddr})
	sub := rdb.Subscribe(ctx, earshot.Channel(cfg.worldID))
	if _, err := sub.Receive(ctx); err != nil {
		must(fmt.Errorf("redis subscribe: %w", err))
	}
	go func() {
		for m := range sub.Channel(redis.WithChannelSize(1024)) {
			rec.earshot([]byte(m.Payload))
		}
	}()

	logf("voice soak: %d bots, cluster r=%.0f m around (%.0f, %.0f), world %s", cfg.bots, cfg.clusterR, cfg.cx, cfg.cz, cfg.worldID)
	rng := rand.New(rand.NewSource(11))
	bots := make([]*bot, cfg.bots)
	for i := range bots {
		bots[i] = newBot(i, cfg, rec, rng)
	}
	start := time.Now()
	var wg sync.WaitGroup
	for i, b := range bots {
		wg.Add(1)
		go func(b *bot) {
			defer wg.Done()
			if err := b.joinZone(ctx); err != nil {
				b.fail("zone: %v", err)
				return
			}
			url, tok, err := b.voiceToken(ctx)
			if err != nil {
				b.fail("token: %v", err)
				return
			}
			if err := b.joinVoice(url, tok); err != nil {
				b.fail("livekit: %v", err)
			}
		}(b)
		time.Sleep(time.Duration(60+i%3*20) * time.Millisecond) // stagger joins like players trickling in
	}
	wg.Wait()
	ready := 0
	for _, b := range bots {
		if b.readyAt > 0 {
			ready++
		}
	}
	logf("joined: %d/%d voice-ready in %.1f s", ready, cfg.bots, time.Since(start).Seconds())

	// One pacer for every bot's microphone: 20 ms Opus frames, each bot at
	// its own offset into the clip so they don't talk in unison.
	go func() {
		t := time.NewTicker(20 * time.Millisecond)
		defer t.Stop()
		n := 0
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
			for i, b := range bots {
				b.writeSample(packets[(n+i*7)%len(packets)])
			}
			n++
		}
	}()

	time.Sleep(6 * time.Second) // settle: initial subscriptions land
	phase := func(name string, walk int, d time.Duration) {
		rec.phase(name)
		logf("phase %s (%.0f s)", name, d.Seconds())
		for _, b := range bots {
			b.setWalk(walk)
		}
		time.Sleep(d)
	}
	phase("clustered", 0, *hold)
	phase("disperse", 1, *disperse)
	phase("apart", 0, 6*time.Second)
	phase("regroup", -1, *regroup)
	phase("regrouped", 0, *hold)
	rec.phase("end")

	socialMetrics := scrape(strings.Replace(strings.Replace(cfg.socialURL, "ws://", "http://", 1), "/ws", "/metrics", 1), "voice_")
	socialDebug := scrape(strings.Replace(strings.Replace(cfg.socialURL, "ws://", "http://", 1), "/ws", "/debug/voice", 1), "")
	zoneMetrics := scrape(strings.Replace(strings.Replace(cfg.zoneURL, "ws://", "http://", 1), "/ws", "/metrics", 1), "zone_earshot|zone_tick_ms{|zone_players")

	for _, b := range bots {
		b.leave()
	}
	cancel()
	time.Sleep(300 * time.Millisecond)

	ev, pos, readyAt := rec.snapshot()
	s := analyze(ev, pos, readyAt, cfg.bots)
	rec.mu.Lock()
	s.ZoneMessages = rec.msgs
	fulls := rec.fulls
	rec.mu.Unlock()

	var errs []string
	for _, b := range bots {
		for _, e := range b.errs {
			errs = append(errs, b.name+": "+e)
		}
	}
	sort.Strings(errs)

	var sb strings.Builder
	fmt.Fprintf(&sb, "WP11 voice soak (spec 14 scenario 3) — %s\n", time.Now().Format(time.RFC3339))
	fmt.Fprintf(&sb, "machine: %s/%s, %d CPUs; LiveKit 1.8 (docker, --dev); bots: Go + pion (server-sdk-go v2.19.0), synthetic Opus speech 32 kbps\n", runtime.GOOS, runtime.GOARCH, runtime.NumCPU())
	fmt.Fprintf(&sb, "bots %d, voice-ready %d; phases: settle 6 s, clustered %v, disperse %v (walk 4.9 m/s outward), apart 6 s, regroup %v, regrouped %v\n",
		s.Bots, s.Ready, *hold, *disperse, *regroup, *hold)
	fmt.Fprintf(&sb, "zone earshot messages %d (%d full)\n", s.ZoneMessages, fulls)
	fmt.Fprintf(&sb, "earshot pair changes after voice-ready: %d; reflected at the listener: %d; missed: %d\n", s.ZoneTransitions, s.Matched, s.Missed)
	fmt.Fprintf(&sb, "latency zone decision -> listener hears (TrackSubscribed) / stops hearing (last audio packet + 20 ms = forwarding stopped) (ms): %s\n", fq(s.LatencyMs))
	fmt.Fprintf(&sb, "  subscribe: %s\n  unsubscribe, media stopped: %s\n", fq(s.LatencySubMs), fq(s.LatencyUnsubMediaMs))
	fmt.Fprintf(&sb, "  unsubscribe, track ended (includes LiveKit's 1 s downtrack flush, sfu/downtrack.go flushTimeout): %s\n", fq(s.LatencyUnsubMs))
	fmt.Fprintf(&sb, "  within 500 ms: %.2f%%\n", s.Within500*100)
	fmt.Fprintf(&sb, "latency distance crossing (40 m in / 48 m out) -> listener event (ms, %d pairs not driven by the 12-cap): %s\n", s.GeoSamples, fq(s.GeoLatencyMs))
	fmt.Fprintf(&sb, "initial subscriptions (pair already in earshot when voice-ready): %d, latency %s\n", s.Initial, fq(s.InitialLatencyMs))
	fmt.Fprintf(&sb, "observed subscription changes %d over %d pairs ever subscribed; max changes per pair %d; histogram %v\n", s.ObservedChanges, s.PairsSubscribed, s.MaxChangesPerPair, s.ChangesHistogram)
	fmt.Fprintf(&sb, "flaps (reversal within 2 s): listener %d, zone %d; extra observed changes without a zone decision: %d\n", s.Flaps, s.ZoneFlaps, s.Extra)
	fmt.Fprintf(&sb, "audio: %d RTP packets received by bots on subscribed tracks\n", rec.packets.Load())
	fmt.Fprintf(&sb, "bot errors: %d %v\n", len(errs), errs)
	fmt.Fprintf(&sb, "social metrics:\n%s\nsocial /debug/voice: %s\nzone metrics:\n%s\n", socialMetrics, socialDebug, zoneMetrics)
	fmt.Fprintf(&sb, "VERDICT: %s\n", s.Verdict)
	fmt.Print(sb.String())
	if *out != "" {
		must(os.WriteFile(*out+".txt", []byte(sb.String()), 0o644))
		// Compact: every event of a 50-bot run is a few thousand lines indented.
		js, _ := json.Marshal(map[string]any{"summary": s, "errors": errs, "events": ev})
		must(os.WriteFile(*out+".json", js, 0o644))
		logf("wrote %s.txt and .json", *out)
	}
	if !s.Pass {
		exit(1)
	}
	exit(0)
}

// spawned are the zone and social processes -spawn started.
var spawned []*exec.Cmd

// exit kills spawned services, then exits.
func exit(code int) {
	for _, p := range spawned {
		_ = p.Process.Kill()
		_, _ = p.Process.Wait()
	}
	os.Exit(code)
}

func fq(q Quant) string {
	return fmt.Sprintf("n=%d p50 %.0f / p95 %.0f / p99 %.0f / max %.0f (mean %.0f)", q.N, q.P50, q.P95, q.P99, q.Max, q.Mean)
}

func loadOpus(p string) ([][]byte, error) {
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	var out [][]byte
	for len(b) >= 2 {
		n := int(b[0]) | int(b[1])<<8
		if len(b) < 2+n {
			return nil, fmt.Errorf("truncated opus file")
		}
		out = append(out, b[2:2+n])
		b = b[2+n:]
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no packets in %s", p)
	}
	return out, nil
}

// spawnServices builds the zone and social binaries from the workspace and
// starts them on private ports against the shared infra.
func spawnServices(cfg *config, zonePort, socialPort int, livekitURL string) {
	for _, p := range []int{zonePort, socialPort} {
		// A leftover service on the port would answer /healthz and silently
		// serve this run with old code: refuse instead.
		l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err != nil {
			must(fmt.Errorf("port %d is taken (a previous soak still running?): %v", p, err))
		}
		l.Close()
	}
	root, err := filepath.Abs("../../../..")
	must(err)
	tmp, err := os.MkdirTemp("", "voicesoak")
	must(err)
	exe := ""
	if runtime.GOOS == "windows" {
		exe = ".exe"
	}
	build := func(pkg, name string) string {
		out := filepath.Join(tmp, name+exe)
		cmd := exec.Command("go", "build", "-o", out, pkg)
		cmd.Dir = root
		cmd.Env = withoutEnv(os.Environ(), "GOWORK")
		if b, err := cmd.CombinedOutput(); err != nil {
			must(fmt.Errorf("build %s: %v\n%s", pkg, err, b))
		}
		return out
	}
	zoneBin := build("./server/zone", "zone")
	socialBin := build("./server/social", "social")
	logDir := envOr("VOICESOAK_LOGS", tmp)
	start := func(bin, name string, env ...string) *exec.Cmd {
		f, err := os.Create(filepath.Join(logDir, name+".log"))
		must(err)
		cmd := exec.Command(bin)
		cmd.Env = append(os.Environ(), env...)
		cmd.Stdout, cmd.Stderr = f, f
		must(cmd.Start())
		return cmd
	}
	z := start(zoneBin, "zone",
		fmt.Sprintf("LODESTONE_ZONE_PORT=%d", zonePort),
		"LODESTONE_ZONE_ID="+cfg.zoneID,
		"LODESTONE_WORLD_ID="+cfg.worldID,
		"LODESTONE_ZONE_NO_DB=1",
		"LODESTONE_ZONE_WT_ADDR=off",
		"LODESTONE_ZONE_DEV_SPAWN=1",
		"LODESTONE_WORLDGEN_WASM="+filepath.Join(tmp, "absent.wasm"), // flat ground: bots predict exactly
		"LODESTONE_ZONE_PUBLIC_URL="+fmt.Sprintf("ws://127.0.0.1:%d/ws", zonePort),
	)
	s := start(socialBin, "social", fmt.Sprintf("LODESTONE_SOCIAL_PORT=%d", socialPort), "LODESTONE_LIVEKIT_URL="+livekitURL)
	cfg.zoneURL = fmt.Sprintf("ws://127.0.0.1:%d/ws", zonePort)
	cfg.socialURL = fmt.Sprintf("ws://127.0.0.1:%d/ws", socialPort)
	for _, u := range []string{fmt.Sprintf("http://127.0.0.1:%d/healthz", zonePort), fmt.Sprintf("http://127.0.0.1:%d/healthz", socialPort)} {
		deadline := time.Now().Add(30 * time.Second)
		for {
			r, err := http.Get(u)
			if err == nil {
				r.Body.Close()
				if r.StatusCode == 200 {
					break
				}
			}
			if time.Now().After(deadline) {
				must(fmt.Errorf("%s not healthy (logs in %s)", u, logDir))
			}
			time.Sleep(200 * time.Millisecond)
		}
	}
	logf("spawned zone :%d and social :%d (logs in %s)", zonePort, socialPort, logDir)
	spawned = append(spawned, z, s)
}

func scrape(u, filter string) string {
	r, err := http.Get(u)
	if err != nil {
		return "(" + err.Error() + ")"
	}
	defer r.Body.Close()
	b, _ := io.ReadAll(r.Body)
	if filter == "" {
		return strings.TrimSpace(string(b))
	}
	var keep []string
	pats := strings.Split(filter, "|")
	for _, l := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(l, "#") {
			continue
		}
		for _, p := range pats {
			if strings.HasPrefix(l, p) {
				keep = append(keep, "  "+l)
				break
			}
		}
	}
	return strings.Join(keep, "\n")
}

func withoutEnv(env []string, key string) []string {
	out := env[:0:0]
	for _, e := range env {
		if !strings.HasPrefix(e, key+"=") {
			out = append(out, e)
		}
	}
	return out
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func logf(format string, a ...any) {
	fmt.Fprintf(os.Stderr, time.Now().Format("15:04:05.000")+" "+format+"\n", a...)
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "voicebots:", err)
		exit(2)
	}
}
