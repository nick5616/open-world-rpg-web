package localsave

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"lodestone/server/pkg/accountapi/dbtest"
)

func testKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

func sampleState() []byte {
	return NewCharacterState("c1", "w1", "Nicole", Vec3{X: 10, Y: 2, Z: 30}, nil).Marshal()
}

func TestBuildVerifyRoundTrip(t *testing.T) {
	pub, priv := testKey(t)
	b := Build(priv, "p1", "c1", "w1", 7, sampleState(), time.UnixMilli(1_762_560_000_000))
	if err := VerifySignature(pub, b); err != nil {
		t.Fatal(err)
	}
	// Survives a JSON round trip, as it does through IndexedDB and export files.
	raw, _ := json.Marshal(b)
	var back Blob
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatal(err)
	}
	if err := VerifySignature(pub, back); err != nil {
		t.Fatal("round trip broke signature:", err)
	}
	st, err := back.DecodeState()
	if err != nil || st.Name != "Nicole" || st.Position.Z != 30 || st.Level != 1 {
		t.Fatalf("state %+v %v", st, err)
	}
}

func TestTamperedBlobsFail(t *testing.T) {
	pub, priv := testKey(t)
	good := Build(priv, "p1", "c1", "w1", 3, sampleState(), time.Now())
	cases := map[string]func(*Blob){
		"state edited":     func(b *Blob) { b.State = strings.Replace(b.State, `"level":1`, `"level":99`, 1) },
		"counter bumped":   func(b *Blob) { b.Counter = 1000 },
		"profile swapped":  func(b *Blob) { b.ProfileID = "p2" },
		"character moved":  func(b *Blob) { b.CharacterID = "c2" },
		"world changed":    func(b *Blob) { b.WorldID = "w2" },
		"issuedAt changed": func(b *Blob) { b.IssuedAt++ },
	}
	for name, mut := range cases {
		b := good
		mut(&b)
		if err := VerifySignature(pub, b); !errors.Is(err, ErrSignature) {
			t.Errorf("%s: want ErrSignature, got %v", name, err)
		}
	}
	other, _ := testKey(t)
	if err := VerifySignature(other, good); !errors.Is(err, ErrSignature) {
		t.Errorf("wrong key: got %v", err)
	}
	bad := good
	bad.Sig = "!!"
	if err := VerifySignature(pub, bad); !errors.Is(err, ErrMalformed) {
		t.Errorf("garbage sig: got %v", err)
	}
	bad = good
	bad.Format = "something-else"
	if err := VerifySignature(pub, bad); !errors.Is(err, ErrMalformed) {
		t.Errorf("format: got %v", err)
	}
}

// Field boundaries are length-prefixed, so shifting bytes between adjacent
// fields cannot produce the same signed message.
func TestSignedBytesUnambiguous(t *testing.T) {
	a := Blob{V: 1, ProfileID: "ab", CharacterID: "c", WorldID: "w", Counter: 1}
	b := Blob{V: 1, ProfileID: "a", CharacterID: "bc", WorldID: "w", Counter: 1}
	if string(a.signedBytes()) == string(b.signedBytes()) {
		t.Fatal("ambiguous encoding")
	}
}

func TestDevKeysPair(t *testing.T) {
	priv, dev, err := PrivateKeyFromEnv()
	if err != nil || !dev {
		t.Fatal("expected dev key", err)
	}
	pub, _, _ := PublicKeyFromEnv()
	if err := VerifySignature(pub, Build(priv, "p", "c", "w", 1, []byte(`{}`), time.Now())); err != nil {
		t.Fatal(err)
	}
}

func randID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return "test-" + hex.EncodeToString(b[:])
}

// Integration: counters in the shared Redis.
func TestStoreCounters(t *testing.T) {
	rdb := dbtest.Redis(t)
	ctx := context.Background()
	pub, priv := testKey(t)
	s := &Store{RDB: rdb, Priv: priv, Pub: pub, AdoptMissing: true}
	profile := randID()
	t.Cleanup(func() { rdb.Del(context.Background(), Key(profile)) })

	b1, err := s.Issue(ctx, profile, "c1", "w1", sampleState())
	if err != nil {
		t.Fatal(err)
	}
	if b1.Counter != 1 {
		t.Fatal("first counter", b1.Counter)
	}
	if err := s.Verify(ctx, b1); err != nil {
		t.Fatal("newest blob rejected:", err)
	}
	b2, _ := s.Issue(ctx, profile, "c1", "w1", sampleState())
	if err := s.Verify(ctx, b1); !errors.Is(err, ErrStale) {
		t.Fatal("old blob accepted:", err)
	}
	if err := s.Verify(ctx, b2); err != nil {
		t.Fatal(err)
	}
	// A second character's counter is independent: saving c2 must not
	// invalidate c1's newest blob.
	c2, _ := s.Issue(ctx, profile, "c2", "w1", sampleState())
	if c2.Counter != 1 {
		t.Fatal("c2 counter", c2.Counter)
	}
	if err := s.Verify(ctx, b2); err != nil {
		t.Fatal("c1 invalidated by c2 save:", err)
	}
	// Edited blob fails before the counter is even consulted.
	tampered := b2
	tampered.State = strings.Replace(tampered.State, `"xp":0`, `"xp":999999`, 1)
	if err := s.Verify(ctx, tampered); !errors.Is(err, ErrSignature) {
		t.Fatal("tampered accepted:", err)
	}
	// TTL is set (180 days by default).
	if ttl := rdb.TTL(ctx, Key(profile)).Val(); ttl < 179*24*time.Hour {
		t.Fatal("ttl", ttl)
	}
	if n, _ := s.Latest(ctx, profile, "c1"); n != 2 {
		t.Fatal("latest", n)
	}
}

func TestStoreMissingRecord(t *testing.T) {
	rdb := dbtest.Redis(t)
	ctx := context.Background()
	pub, priv := testKey(t)
	profile := randID()
	t.Cleanup(func() { rdb.Del(context.Background(), Key(profile)) })
	blob := Build(priv, profile, "c1", "w1", 5, sampleState(), time.Now())

	strict := &Store{RDB: rdb, Pub: pub}
	if err := strict.Verify(ctx, blob); !errors.Is(err, ErrNoRecord) {
		t.Fatal("want ErrNoRecord", err)
	}
	adopt := &Store{RDB: rdb, Pub: pub, AdoptMissing: true}
	if err := adopt.Verify(ctx, blob); err != nil {
		t.Fatal(err)
	}
	if n, _ := adopt.Latest(ctx, profile, "c1"); n != 5 {
		t.Fatal("adopted counter", n)
	}
	older := Build(priv, profile, "c1", "w1", 4, sampleState(), time.Now())
	if err := adopt.Verify(ctx, older); !errors.Is(err, ErrStale) {
		t.Fatal("older accepted after adopt", err)
	}
	// A higher, correctly signed counter means the record is behind: accept and raise.
	newer := Build(priv, profile, "c1", "w1", 9, sampleState(), time.Now())
	if err := adopt.Verify(ctx, newer); err != nil {
		t.Fatal(err)
	}
	if n, _ := adopt.Latest(ctx, profile, "c1"); n != 9 {
		t.Fatal("raised counter", n)
	}
}
