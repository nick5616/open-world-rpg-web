package voice

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net"
	"slices"
	"strings"
	"testing"
	"time"

	"lodestone/server/pkg/earshot"
)

func decodeJWT(t *testing.T, tok, secret string) claims {
	t.Helper()
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatalf("not a JWT: %q", tok)
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if base64.RawURLEncoding.EncodeToString(mac.Sum(nil)) != parts[2] {
		t.Fatal("bad HS256 signature")
	}
	var c claims
	b, _ := base64.RawURLEncoding.DecodeString(parts[1])
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

func TestJoinTokenGrants(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	tok, err := JoinToken("devkey", "secret", "world-w", "char-1", "Alice", true, 10*time.Minute, now)
	if err != nil {
		t.Fatal(err)
	}
	c := decodeJWT(t, tok, "secret")
	if c.Issuer != "devkey" || c.Subject != "char-1" || c.Name != "Alice" || c.Expires != now.Add(10*time.Minute).Unix() || c.NotBefore > now.Unix() {
		t.Fatalf("claims %+v", c)
	}
	g := c.Video
	if !g.RoomJoin || g.Room != "world-w" || !*g.CanPublish || !*g.CanSubscribe || *g.CanPublishData || !slices.Equal(g.CanPublishSources, []string{"microphone"}) || g.RoomAdmin {
		t.Fatalf("publisher grant %+v", g)
	}
	tok, _ = JoinToken("devkey", "secret", "world-w", "char-2", "Lina", false, time.Minute, now)
	g = decodeJWT(t, tok, "secret").Video
	if *g.CanPublish || !*g.CanSubscribe || len(g.CanPublishSources) != 0 {
		t.Fatalf("listen-only grant %+v", g)
	}
	if _, err := JoinToken("", "", "r", "i", "n", true, time.Minute, now); err == nil {
		t.Fatal("missing key/secret must fail")
	}
	if APIURL("ws://localhost:7880") != "http://localhost:7880" || APIURL("wss://sfu.example") != "https://sfu.example" {
		t.Fatal("APIURL")
	}
}

func parts(ids ...string) []Participant {
	out := make([]Participant, len(ids))
	for i, id := range ids {
		out[i] = Participant{Sid: "PA_" + id, Identity: id, Name: id, AudioTracks: []string{"TR_" + id}}
	}
	return out
}

func msg(zone string, seq uint64, full bool, sets map[string][]string, gone ...string) *earshot.Message {
	return &earshot.Message{V: earshot.Version, Zone: zone, Seq: seq, T: float64(1000 + seq*250), Full: full, Sets: sets, Gone: gone}
}

// apply runs a plan against an in-memory "LiveKit" and returns the result.
func apply(r *Reconciler, lk map[string]map[string]bool, heal bool) []Change {
	ch := r.Plan(heal)
	for _, c := range ch {
		have := lk[c.Identity]
		if have == nil {
			have = map[string]bool{}
			lk[c.Identity] = have
		}
		for _, t := range c.Tracks {
			if c.Subscribe {
				have[t] = true
			} else {
				delete(have, t)
			}
		}
		r.Done(c, true)
	}
	r.ClearPending()
	return ch
}

func subs(lk map[string]map[string]bool, id string) []string {
	var out []string
	for t := range lk[id] {
		out = append(out, t)
	}
	slices.Sort(out)
	return out
}

func TestReconcileFollowsEarshot(t *testing.T) {
	r := NewReconciler()
	lk := map[string]map[string]bool{}
	r.SetParticipants(parts("a", "b", "c"))
	r.ApplyEarshot(msg("z1", 0, true, map[string][]string{"a": {"b"}, "b": {"a"}, "c": {}}))
	ch := apply(r, lk, false)
	if len(ch) != 2 || !slices.Equal(subs(lk, "a"), []string{"TR_b"}) || !slices.Equal(subs(lk, "b"), []string{"TR_a"}) || len(subs(lk, "c")) != 0 {
		t.Fatalf("after first message: %v changes, lk %v", ch, lk)
	}
	if ch[0].PendingT != 1000 {
		t.Fatalf("pending time should be the message's t: %+v", ch[0])
	}
	// Idempotent: nothing to do on a second pass.
	if ch := apply(r, lk, false); len(ch) != 0 {
		t.Fatalf("second pass should be empty: %v", ch)
	}
	// c walks up to a: delta adds c to a's set and a to c's.
	r.ApplyEarshot(msg("z1", 1, false, map[string][]string{"a": {"b", "c"}, "c": {"a"}}))
	apply(r, lk, false)
	if !slices.Equal(subs(lk, "a"), []string{"TR_b", "TR_c"}) || !slices.Equal(subs(lk, "c"), []string{"TR_a"}) {
		t.Fatalf("after delta: %v", lk)
	}
	// Full message without b: b's set is dropped (b's subscriptions removed).
	r.ApplyEarshot(msg("z1", 8, true, map[string][]string{"a": {"c"}, "c": {"a"}}))
	apply(r, lk, false)
	if len(subs(lk, "b")) != 0 || !slices.Equal(subs(lk, "a"), []string{"TR_c"}) {
		t.Fatalf("after full without b: %v", lk)
	}
	// gone: c left the zone.
	r.ApplyEarshot(msg("z1", 9, false, map[string][]string{"a": {}}, "c"))
	apply(r, lk, false)
	if len(subs(lk, "a")) != 0 || len(subs(lk, "c")) != 0 {
		t.Fatalf("after gone: %v", lk)
	}
}

func TestReconcilePartyBlocksMutes(t *testing.T) {
	r := NewReconciler()
	lk := map[string]map[string]bool{}
	r.SetParticipants(parts("a", "b", "c", "d"))
	// Nobody in earshot of anyone, but a and d are partied (any distance).
	r.ApplyEarshot(msg("z1", 0, true, map[string][]string{"a": {"b", "c"}, "b": {"a"}, "c": {"a"}, "d": {}}))
	r.SetRelations(map[string][]string{"a": {"d"}, "d": {"a"}}, nil, nil)
	apply(r, lk, false)
	if !slices.Equal(subs(lk, "a"), []string{"TR_b", "TR_c", "TR_d"}) || !slices.Equal(subs(lk, "d"), []string{"TR_a"}) {
		t.Fatalf("party: %v", lk)
	}
	// b blocks a: neither hears the other. c mutes... a mutes c: a stops hearing c, c still hears a.
	r.SetRelations(map[string][]string{"a": {"d"}, "d": {"a"}}, [][2]string{{"b", "a"}}, [][2]string{{"a", "c"}})
	apply(r, lk, false)
	if !slices.Equal(subs(lk, "a"), []string{"TR_d"}) || len(subs(lk, "b")) != 0 || !slices.Equal(subs(lk, "c"), []string{"TR_a"}) {
		t.Fatalf("block both ways + mute one way: %v", lk)
	}
	if r.Hears("a", "b") || r.Hears("b", "a") || r.Hears("a", "c") || !r.Hears("c", "a") || !r.Hears("a", "d") {
		t.Fatal("Hears disagrees with the rules")
	}
}

func TestReconcileRosterChanges(t *testing.T) {
	r := NewReconciler()
	lk := map[string]map[string]bool{}
	r.ApplyEarshot(msg("z1", 0, true, map[string][]string{"a": {"b"}, "b": {"a"}}))
	r.SetParticipants([]Participant{{Sid: "PA_a", Identity: "a"}}) // a joined, has no track; b not in the room yet
	if ch := apply(r, lk, false); len(ch) != 0 {
		t.Fatalf("nothing to subscribe yet: %v", ch)
	}
	if u := r.Unknown(); !slices.Equal(u, []string{"b"}) {
		t.Fatalf("b is wanted but unknown: %v", u)
	}
	r.SetParticipants(parts("a", "b")) // b joined with a track, a published too
	apply(r, lk, false)
	if !slices.Equal(subs(lk, "a"), []string{"TR_b"}) || !slices.Equal(subs(lk, "b"), []string{"TR_a"}) {
		t.Fatalf("after joins: %v", lk)
	}
	// a reconnects: new participant sid, no subscriptions on LiveKit's side.
	delete(lk, "a")
	ps := parts("a", "b")
	ps[0].Sid = "PA_a2"
	r.SetParticipants(ps)
	ch := apply(r, lk, false)
	if len(ch) != 1 || ch[0].Sid != "PA_a2" || !slices.Equal(subs(lk, "a"), []string{"TR_b"}) {
		t.Fatalf("reconnect must resubscribe: %v %v", ch, lk)
	}
	// b republishes (new track sid): a moves to the new track.
	ps[1].AudioTracks = []string{"TR_b2"}
	r.SetParticipants(ps)
	apply(r, lk, false)
	if !slices.Equal(subs(lk, "a"), []string{"TR_b2"}) {
		t.Fatalf("republish: %v", lk)
	}
}

func TestReconcileHealAndFailures(t *testing.T) {
	r := NewReconciler()
	r.SetParticipants(parts("a", "b"))
	r.ApplyEarshot(msg("z1", 0, true, map[string][]string{"a": {"b"}, "b": {"a"}}))
	ch := r.Plan(false)
	for _, c := range ch {
		r.Done(c, false) // LiveKit failed
	}
	if again := r.Plan(false); len(again) != 2 {
		t.Fatalf("failed changes must be retried: %v", again)
	}
	for _, c := range r.Plan(false) {
		r.Done(c, true)
	}
	if len(r.Plan(false)) != 0 {
		t.Fatal("applied state not recorded")
	}
	if h := r.Plan(true); len(h) != 2 || !h[0].Subscribe {
		t.Fatalf("heal re-sends every desired subscription: %v", h)
	}
}

func TestReconcileZoneHandoffAndExpiry(t *testing.T) {
	r := NewReconciler()
	r.SetParticipants(parts("a", "b", "c"))
	r.ApplyEarshot(msg("west", 0, true, map[string][]string{"a": {"b"}, "b": {"a"}}))
	r.ApplyEarshot(msg("east", 0, true, map[string][]string{"c": {}}))
	// a crosses to east: east now reports a; west's later full drops a without
	// touching east's claim.
	r.ApplyEarshot(msg("east", 1, false, map[string][]string{"a": {"c"}, "c": {"a"}}))
	r.ApplyEarshot(msg("west", 8, true, map[string][]string{"b": {}}))
	if d := r.Desired("a"); !slices.Equal(d, []string{"c"}) {
		t.Fatalf("a belongs to east now: %v", d)
	}
	// east goes silent: after StaleAfterMs its sets are dropped.
	r.ExpireZones(3250 + earshot.StaleAfterMs + 1)
	if d := r.Desired("a"); len(d) != 0 {
		t.Fatalf("stale zone's sets must expire: %v", d)
	}
	if d := r.Desired("b"); len(d) != 0 {
		t.Fatalf("west (not stale... its last t was 3000) %v", d)
	}
}

// LiveKit integration: our JWT and JSON bodies against the real SFU (the
// docker compose LiveKit, --dev keys). Skips when it is not running.
func TestLiveKitAPI(t *testing.T) {
	c, err := net.DialTimeout("tcp", "127.0.0.1:7880", 300*time.Millisecond)
	if err != nil {
		t.Skip("LiveKit not running on :7880")
	}
	c.Close()
	lk := NewLiveKit("http://127.0.0.1:7880", "devkey", "secret")
	ctx := context.Background()
	ps, err := lk.ListParticipants(ctx, "lodestone-test-empty-room")
	if err != nil || len(ps) != 0 {
		t.Fatalf("empty room: %v %v", ps, err)
	}
	// (UpdateSubscriptions on a room that does not exist hangs until the
	// client timeout on LiveKit 1.8, which is why the reconciler only calls it
	// for participants in the current roster and with a 1 s timeout. The
	// voice soak exercises it against live rooms.)
	bad := NewLiveKit("http://127.0.0.1:7880", "devkey", "wrong-secret")
	if _, err := bad.ListParticipants(ctx, "x"); err == nil {
		t.Fatal("a token signed with the wrong secret must be refused")
	}
}
