package voice_test

// Process-boundary test for the voice service: builds the social binary and
// runs TWO social processes against a scratch Postgres, the shared Redis and
// a fake LiveKit server API (Twirp, in this test process). It checks, across
// those boundaries:
//   - voice_token: LiveKit URL, room per world, publish vs listen-only grants;
//   - one leader per world: each subscription change reaches LiveKit once;
//   - a zone's earshot message (Redis voice:{world}) becomes UpdateSubscriptions
//     calls with the right tracks, quickly, and deltas unsubscribe;
//   - a block (Postgres) removes voice both ways.
// The real-SFU end of the pipeline is the voice soak (voicebots) and the
// two-browser walk-apart test.

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"lodestone/server/pkg/accountapi"
	"lodestone/server/pkg/accountapi/dbtest"
	"lodestone/server/pkg/earshot"
	sp "lodestone/server/pkg/socialproto"
	"lodestone/server/pkg/ticket"
	"lodestone/server/social/internal/client"
)

type call struct {
	T         time.Time
	Identity  string
	Tracks    []string
	Subscribe bool
}

// fakeLiveKit serves the two RoomService methods the reconciler uses and
// records UpdateSubscriptions calls. It checks the admin JWT like LiveKit.
type fakeLiveKit struct {
	mu    sync.Mutex
	parts []map[string]any
	calls []call
	bad   int
}

func (f *fakeLiveKit) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	parts := strings.Split(tok, ".")
	mac := hmac.New(sha256.New, []byte("secret"))
	if len(parts) == 3 {
		mac.Write([]byte(parts[0] + "." + parts[1]))
	}
	if len(parts) != 3 || base64.RawURLEncoding.EncodeToString(mac.Sum(nil)) != parts[2] || !strings.Contains(decodeSeg(parts[1]), `"roomAdmin":true`) {
		f.mu.Lock()
		f.bad++
		f.mu.Unlock()
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"code":"unauthenticated","msg":"bad token"}`)
		return
	}
	body, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case strings.HasSuffix(r.URL.Path, "/ListParticipants"):
		_ = json.NewEncoder(w).Encode(map[string]any{"participants": f.parts})
	case strings.HasSuffix(r.URL.Path, "/UpdateSubscriptions"):
		var req struct {
			Identity  string   `json:"identity"`
			TrackSids []string `json:"track_sids"`
			Subscribe bool     `json:"subscribe"`
		}
		_ = json.Unmarshal(body, &req)
		slices.Sort(req.TrackSids)
		f.calls = append(f.calls, call{time.Now(), req.Identity, req.TrackSids, req.Subscribe})
		_, _ = io.WriteString(w, `{}`)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func decodeSeg(s string) string {
	b, _ := base64.RawURLEncoding.DecodeString(s)
	return string(b)
}

func (f *fakeLiveKit) setParticipants(ps ...[3]string) { // identity, sid, audio track ("" = none)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.parts = nil
	for _, p := range ps {
		var tracks []map[string]any
		if p[2] != "" {
			tracks = append(tracks, map[string]any{"sid": p[2], "type": "AUDIO", "source": "MICROPHONE"})
		}
		f.parts = append(f.parts, map[string]any{"sid": p[1], "identity": p[0], "name": p[0], "tracks": tracks})
	}
}

func (f *fakeLiveKit) since(i int) []call {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls[min(i, len(f.calls)):])
}

func (f *fakeLiveKit) n() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func startSocial(t *testing.T, bin, pgURL, apiURL string, extraEnv ...string) string {
	t.Helper()
	port := freePort(t)
	logf, err := os.Create(filepath.Join(t.TempDir(), fmt.Sprintf("social-%d.log", port)))
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bin)
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("LODESTONE_SOCIAL_PORT=%d", port),
		"LODESTONE_PG_URL="+pgURL,
		"LODESTONE_LIVEKIT_URL=wss://voice.example.test",
		"LODESTONE_LIVEKIT_API_URL="+apiURL,
		"LODESTONE_LIVEKIT_KEY=devkey",
		"LODESTONE_LIVEKIT_SECRET=secret",
	)
	cmd.Env = append(cmd.Env, extraEnv...)
	cmd.Stdout, cmd.Stderr = logf, logf
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
		logf.Close()
		if t.Failed() {
			b, _ := os.ReadFile(logf.Name())
			t.Logf("social :%d log:\n%s", port, b)
		}
	})
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if r, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/healthz", port)); err == nil {
			r.Body.Close()
			if r.StatusCode == 200 {
				return fmt.Sprintf("ws://127.0.0.1:%d/ws", port)
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("social process did not become healthy")
	return ""
}

func TestVoiceAcrossProcesses(t *testing.T) {
	pool, pgURL := dbtest.Postgres(t)
	rdb := dbtest.Redis(t)
	bin := filepath.Join(t.TempDir(), "social")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	if out, err := exec.Command("go", "build", "-o", bin, "lodestone/server/social").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	lk := &fakeLiveKit{}
	api := httptest.NewServer(lk)
	defer api.Close()
	// The second process keeps WP11's listen-only rule for local profiles
	// (the kill switch); the first runs the playtest 2 default (they talk).
	urls := []string{startSocial(t, bin, pgURL, api.URL), startSocial(t, bin, pgURL, api.URL, "LODESTONE_VOICE_LOCAL_LISTEN_ONLY=1")}

	world := accountapi.NewUUID()
	alice, bob, lina := accountapi.NewUUID(), accountapi.NewUUID(), accountapi.NewUUID()
	t.Cleanup(func() {
		ctx := context.Background()
		rdb.SRem(ctx, "social:worlds", world)
		rdb.Del(ctx, "voicelead:"+world, "online:"+world)
		for _, id := range []string{alice, bob, lina} {
			rdb.Del(ctx, "presence:"+id, "charname:"+id)
		}
	})
	priv, _, _ := ticket.PrivateKeyFromEnv()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// voice_token over the real socket, on both processes.
	tokenFor := func(url string, c ticket.Claims) map[string]any {
		t.Helper()
		cl, _, err := client.Connect(ctx, url, ticket.Sign(priv, c))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(cl.Close)
		if err := cl.Send(ctx, sp.C2SVoiceToken{Type: sp.C2STypeVoiceToken}); err != nil {
			t.Fatal(err)
		}
		wctx, wcancel := context.WithTimeout(ctx, 5*time.Second)
		defer wcancel()
		f, err := cl.WaitFor(wctx, client.Type(sp.S2CTypeVoiceToken))
		if err != nil {
			t.Fatalf("voice_token: %v", err)
		}
		var m sp.S2CVoiceToken
		_ = f.Decode(&m)
		if m.URL != "wss://voice.example.test" || m.Room != "world-"+world {
			t.Fatalf("voice_token url/room: %+v", m)
		}
		var claims map[string]any
		_ = json.Unmarshal([]byte(decodeSeg(strings.Split(m.Token, ".")[1])), &claims)
		return claims
	}
	ca := tokenFor(urls[0], ticket.Claims{AccountID: accountapi.NewUUID(), CharacterID: alice, CharacterName: "Alice", WorldID: world, Audience: ticket.AudienceSocial})
	cl := tokenFor(urls[1], ticket.Claims{ProfileID: accountapi.NewUUID(), CharacterID: lina, CharacterName: "Lina", WorldID: world, Audience: ticket.AudienceSocial, IsLocalProfile: true})
	va, vl := ca["video"].(map[string]any), cl["video"].(map[string]any)
	if ca["sub"] != alice || va["canPublish"] != true || va["roomJoin"] != true || va["canPublishData"] != false {
		t.Fatalf("account token claims %+v", ca)
	}
	if cl["sub"] != lina || vl["canPublish"] != false || vl["canSubscribe"] != true {
		t.Fatalf("with LODESTONE_VOICE_LOCAL_LISTEN_ONLY=1 a local profile must get a listen-only token: %+v", cl)
	}
	// Playtest 2 default: a local profile may talk (microphone only).
	lp := accountapi.NewUUID()
	t.Cleanup(func() { rdb.Del(context.Background(), "presence:"+lp, "charname:"+lp) })
	cp := tokenFor(urls[0], ticket.Claims{ProfileID: accountapi.NewUUID(), CharacterID: lp, CharacterName: "Pia", WorldID: world, Audience: ticket.AudienceSocial, IsLocalProfile: true})
	if vp := cp["video"].(map[string]any); cp["sub"] != lp || vp["canPublish"] != true || fmt.Sprint(vp["canPublishSources"]) != "[microphone]" {
		t.Fatalf("a local profile must be able to talk by default: %+v", cp)
	}

	lk.setParticipants([3]string{alice, "PA_a", "TR_a"}, [3]string{bob, "PA_b", "TR_b"}, [3]string{lina, "PA_l", ""})
	time.Sleep(2 * time.Second) // a roster poll (1.5 s while the room was empty) on whichever process leads

	publish := func(m earshot.Message) {
		t.Helper()
		m.V, m.Zone, m.T = earshot.Version, "zone-test", float64(time.Now().UnixMicro())/1000
		b, _ := json.Marshal(m)
		if err := rdb.Publish(ctx, earshot.Channel(world), b).Err(); err != nil {
			t.Fatal(err)
		}
	}
	// expect waits until the calls since `from` contain exactly want (in any
	// order), then checks nothing else arrives for a moment (one leader).
	expect := func(what string, from int, want []call, maxWait time.Duration) []call {
		t.Helper()
		key := func(c call) string { return fmt.Sprintf("%s %v %v", c.Identity, c.Tracks, c.Subscribe) }
		var ws []string
		for _, w := range want {
			ws = append(ws, key(w))
		}
		slices.Sort(ws)
		deadline := time.Now().Add(maxWait)
		var got []string
		var calls []call
		for {
			calls = lk.since(from)
			got = got[:0]
			for _, c := range calls {
				got = append(got, key(c))
			}
			slices.Sort(got)
			if slices.Equal(got, ws) || time.Now().After(deadline) {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		if !slices.Equal(got, ws) {
			t.Fatalf("%s: LiveKit calls %v, want %v", what, got, ws)
		}
		time.Sleep(400 * time.Millisecond)
		if extra := lk.since(from + len(calls)); len(extra) > 0 {
			t.Fatalf("%s: extra calls (two leaders?) %+v", what, extra)
		}
		return calls
	}

	// Earshot: Alice hears Bob and Lina, Bob hears Alice, Lina hears Alice.
	// Lina has no track (listen-only), so nobody subscribes to her.
	n0 := lk.n()
	t0 := time.Now()
	publish(earshot.Message{Full: true, Sets: map[string][]string{alice: {bob, lina}, bob: {alice}, lina: {alice}}})
	calls := expect("earshot -> subscriptions", n0, []call{
		{Identity: alice, Tracks: []string{"TR_b"}, Subscribe: true},
		{Identity: bob, Tracks: []string{"TR_a"}, Subscribe: true},
		{Identity: lina, Tracks: []string{"TR_a"}, Subscribe: true},
	}, 2*time.Second)
	var worst time.Duration
	for _, c := range calls {
		worst = max(worst, c.T.Sub(t0))
	}
	t.Logf("earshot published -> last UpdateSubscriptions: %v", worst)
	if worst > 500*time.Millisecond {
		t.Fatalf("subscriptions took %v (> 500 ms) to follow earshot", worst)
	}

	// Delta: Bob walks away from Alice.
	n1 := lk.n()
	publish(earshot.Message{Sets: map[string][]string{alice: {lina}, bob: {}}})
	expect("delta -> unsubscribe", n1, []call{
		{Identity: alice, Tracks: []string{"TR_b"}, Subscribe: false},
		{Identity: bob, Tracks: []string{"TR_a"}, Subscribe: false},
	}, 2*time.Second)

	// Bob blocks Alice (Postgres); within a relations refresh (2 s) the pair
	// must stay silent both ways even when the zone puts them in earshot.
	if _, err := pool.Exec(ctx, `INSERT INTO social_blocks (blocker, blocked) VALUES ($1, $2)`, bob, alice); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2500 * time.Millisecond)
	n2 := lk.n()
	publish(earshot.Message{Sets: map[string][]string{alice: {bob, lina}, bob: {alice}}})
	time.Sleep(800 * time.Millisecond)
	for _, c := range lk.since(n2) {
		if (c.Identity == alice && slices.Contains(c.Tracks, "TR_b")) || (c.Identity == bob && slices.Contains(c.Tracks, "TR_a")) {
			t.Fatalf("blocked pair subscribed: %+v", c)
		}
	}
	if lk.bad != 0 {
		t.Fatalf("%d LiveKit calls with a bad admin token", lk.bad)
	}
}
