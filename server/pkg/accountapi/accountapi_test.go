package accountapi

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"sync"
	"testing"
	"time"

	"lodestone/server/pkg/accountapi/dbtest"
	"lodestone/server/pkg/localsave"
	"lodestone/server/pkg/zoneregistry"
)

func TestSessionRoundTrip(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	now := time.UnixMilli(1_762_560_000_000)
	tok, exp := SignSession(priv, Session{Kind: KindAccount, Subject: "acc-1", Provider: "google", Name: "Nicole"}, now, time.Hour)
	if !strings.HasPrefix(tok, "lss1.") || !exp.Equal(now.Add(time.Hour)) {
		t.Fatal(tok, exp)
	}
	s, err := VerifySession(pub, tok, now.Add(59*time.Minute))
	if err != nil || s.Subject != "acc-1" || s.Kind != KindAccount || s.Provider != "google" {
		t.Fatal(s, err)
	}
	if _, err := VerifySession(pub, tok, now.Add(time.Hour)); !errors.Is(err, ErrSessionExpired) {
		t.Fatal("want expired", err)
	}
	other, _, _ := ed25519.GenerateKey(rand.Reader)
	if _, err := VerifySession(other, tok, now); !errors.Is(err, ErrSessionSignature) {
		t.Fatal("want signature", err)
	}
	// Swap the payload for one claiming another subject: signature must fail.
	parts := strings.Split(tok, ".")
	forged, _ := SignSession(priv, Session{Kind: KindAccount, Subject: "acc-2"}, now, time.Hour)
	parts[1] = strings.Split(forged, ".")[1]
	if _, err := VerifySession(pub, strings.Join(parts[:2], ".")+"."+strings.Split(tok, ".")[2], now); !errors.Is(err, ErrSessionSignature) {
		t.Fatal("forged payload accepted", err)
	}
	for _, bad := range []string{"", "lss1.x", "nope.a.b", "lss1.a.b"} {
		if _, err := VerifySession(pub, bad, now); !errors.Is(err, ErrSessionMalformed) {
			t.Fatalf("%q: %v", bad, err)
		}
	}
	if BearerToken("Bearer abc") != "abc" || BearerToken("bearer  abc ") != "abc" || BearerToken("Basic x") != "" {
		t.Fatal("bearer parsing")
	}
}

func TestValidateName(t *testing.T) {
	good := map[string]string{"Nicole": "Nicole", "  ab_c ": "ab_c", "Zed42": "Zed42", "abcdefghijklmnop": "abcdefghijklmnop"}
	for in, want := range good {
		if got, err := ValidateName(in); err != nil || got != want {
			t.Errorf("%q: %q %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "ab", "abcdefghijklmnopq", "1abc", "_abc", "has space", "Nicоle", "admin", "ADMIN", "a__b", "semi;colon"} {
		if _, err := ValidateName(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	if u, err := ValidateDevUsername(" Alice-1 "); err != nil || u != "alice-1" {
		t.Error(u, err)
	}
	if _, err := ValidateDevUsername("a b"); err == nil {
		t.Error("space accepted")
	}
}

func TestRegionOf(t *testing.T) {
	cases := []struct {
		p    localsave.Vec3
		want zoneregistry.Region
	}{
		{localsave.Vec3{X: 0, Z: 0}, zoneregistry.Region{X: 0, Z: 0}},
		{localsave.Vec3{X: 1023.9, Z: 1024}, zoneregistry.Region{X: 0, Z: 1}},
		{localsave.Vec3{X: 2048, Z: 2048}, zoneregistry.Region{X: 2, Z: 2}},
		{localsave.Vec3{X: 4095, Z: 5000}, zoneregistry.Region{X: 3, Z: 3}},
		{localsave.Vec3{X: -5, Z: math.NaN()}, zoneregistry.Region{X: 0, Z: 0}},
	}
	for _, c := range cases {
		if got := RegionOf(c.p); got != c.want {
			t.Errorf("%+v: got %+v want %+v", c.p, got, c.want)
		}
	}
}

func newDB(t *testing.T) DB {
	pool, _ := dbtest.Postgres(t)
	return DB{Pool: pool}
}

func seedWorld(t *testing.T, d DB) World {
	w, created, err := d.EnsureOfficialWorld(context.Background(), World{Name: "Test", Seed: "18446744073709551615", Spec: json.RawMessage(`{"placeholder":true}`), GenVersion: "placeholder", AtlasHash: "placeholder"})
	if err != nil || !created {
		t.Fatal(err, created)
	}
	return w
}

func TestDBWorldsAndCharacters(t *testing.T) {
	d := newDB(t)
	ctx := context.Background()
	w := seedWorld(t, d)
	if w.Seed != "18446744073709551615" || !w.Official {
		t.Fatal("max uint64 seed must round-trip as a string", w)
	}
	again, created, err := d.EnsureOfficialWorld(ctx, World{Name: "Other", Seed: "1", Spec: json.RawMessage(`{}`)})
	if err != nil || created || again.ID != w.ID {
		t.Fatal("second seed must be a no-op", again, created, err)
	}

	acc, err := d.UpsertAccount(ctx, "dev", "alice")
	if err != nil {
		t.Fatal(err)
	}
	acc2, _ := d.UpsertAccount(ctx, "dev", "alice")
	if acc2.ID != acc.ID {
		t.Fatal("upsert must be idempotent")
	}
	owner := Owner{Kind: KindAccount, ID: acc.ID}
	c, err := d.CreateCharacter(ctx, owner, w.ID, "Nicole", nil, SpawnPosition())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.CreateCharacter(ctx, owner, w.ID, "NICOLE", nil, SpawnPosition()); !errors.Is(err, ErrNameTaken) {
		t.Fatal("case-insensitive uniqueness", err)
	}
	// A local profile cannot take the name either: uniqueness spans both tables.
	p, created, err := d.ClaimLocalProfile(ctx, NewUUID(), hash("s1"))
	if err != nil || !created {
		t.Fatal(err)
	}
	local := Owner{Kind: KindLocal, ID: p.ID}
	if _, err := d.CreateCharacter(ctx, local, w.ID, "nicole", nil, SpawnPosition()); !errors.Is(err, ErrNameTaken) {
		t.Fatal("cross-table uniqueness", err)
	}
	lc, err := d.CreateCharacter(ctx, local, w.ID, "Wanderer", nil, SpawnPosition())
	if err != nil || !lc.Local {
		t.Fatal(lc, err)
	}
	if _, err := d.CreateCharacter(ctx, owner, w.ID, "wanderer", nil, SpawnPosition()); !errors.Is(err, ErrNameTaken) {
		t.Fatal("reverse cross-table uniqueness", err)
	}
	list, _ := d.ListCharacters(ctx, owner, w.ID)
	if len(list) != 1 || list[0].ID != c.ID || list[0].Position != SpawnPosition() {
		t.Fatal(list)
	}
	if _, err := d.GetCharacter(ctx, local, c.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("other owner's character must look missing", err)
	}
	if _, _, err := d.ClaimLocalProfile(ctx, p.ID, hash("wrong")); !errors.Is(err, ErrProfileSecret) {
		t.Fatal("secret mismatch", err)
	}
}

// Concurrent creates of one name: exactly one wins, across both tables.
func TestDBConcurrentNameRace(t *testing.T) {
	d := newDB(t)
	ctx := context.Background()
	w := seedWorld(t, d)
	var wg sync.WaitGroup
	results := make(chan error, 8)
	for i := range 8 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			var o Owner
			if i%2 == 0 {
				a, _ := d.UpsertAccount(ctx, "dev", NewUUID())
				o = Owner{Kind: KindAccount, ID: a.ID}
			} else {
				p, _, _ := d.ClaimLocalProfile(ctx, NewUUID(), hash("x"))
				o = Owner{Kind: KindLocal, ID: p.ID}
			}
			_, err := d.CreateCharacter(ctx, o, w.ID, "Racer", nil, SpawnPosition())
			results <- err
		}(i)
	}
	wg.Wait()
	close(results)
	wins := 0
	for err := range results {
		if err == nil {
			wins++
		} else if !errors.Is(err, ErrNameTaken) {
			t.Fatal(err)
		}
	}
	if wins != 1 {
		t.Fatal("winners:", wins)
	}
}

func TestDBUpgradeLocalProfile(t *testing.T) {
	d := newDB(t)
	ctx := context.Background()
	w := seedWorld(t, d)
	p, _, _ := d.ClaimLocalProfile(ctx, NewUUID(), hash("s"))
	local := Owner{Kind: KindLocal, ID: p.ID}
	c1, _ := d.CreateCharacter(ctx, local, w.ID, "Alpha", nil, SpawnPosition())
	c2, _ := d.CreateCharacter(ctx, local, w.ID, "Beta", nil, SpawnPosition())
	acc, _ := d.UpsertAccount(ctx, "google", "uid-123")

	st1 := localsave.NewCharacterState(c1.ID, w.ID, "Alpha", localsave.Vec3{X: 100, Y: 5, Z: 3000}, json.RawMessage(`{"hair":2}`))
	st1.Level, st1.XP = 7, 4200
	st1.Progress.SpellsKnown = []string{"fireball"}
	st1.Items = []localsave.Item{{ID: "i1", Kind: "weapon", BaseID: "sword_iron", ItemLevel: 3, Rarity: 2, RollSeed: 99}}
	st2 := localsave.NewCharacterState(c2.ID, w.ID, "Beta", SpawnPosition(), nil)

	// Missing one character's save: refused, nothing changes.
	if _, err := d.UpgradeLocalProfile(ctx, p.ID, acc.ID, map[string]localsave.State{c1.ID: st1}); !errors.Is(err, ErrUpgradeMismatch) {
		t.Fatal("partial upgrade", err)
	}
	if cs, _ := d.ListCharacters(ctx, local, ""); len(cs) != 2 {
		t.Fatal("partial upgrade must roll back", cs)
	}

	moved, err := d.UpgradeLocalProfile(ctx, p.ID, acc.ID, map[string]localsave.State{c1.ID: st1, c2.ID: st2})
	if err != nil || len(moved) != 2 {
		t.Fatal(moved, err)
	}
	accOwner := Owner{Kind: KindAccount, ID: acc.ID}
	got, err := d.GetCharacter(ctx, accOwner, c1.ID)
	if err != nil || got.Level != 7 || got.XP != 4200 || got.Position.Z != 3000 || got.Name != "Alpha" {
		t.Fatal(got, err)
	}
	var spells []string
	var items int
	_ = d.Pool.QueryRow(ctx, `SELECT spells_known FROM character_progress WHERE character_id = $1`, c1.ID).Scan(&spells)
	_ = d.Pool.QueryRow(ctx, `SELECT count(*) FROM items WHERE owner_character_id = $1 AND roll_seed = 99`, c1.ID).Scan(&items)
	if len(spells) != 1 || items != 1 {
		t.Fatal("progress/items not copied", spells, items)
	}
	if cs, _ := d.ListCharacters(ctx, local, ""); len(cs) != 0 {
		t.Fatal("local rows must be gone", cs)
	}
	prof, _ := d.GetLocalProfile(ctx, p.ID)
	if prof.UpgradedAccountID == nil || *prof.UpgradedAccountID != acc.ID {
		t.Fatal("profile not marked upgraded", prof)
	}
	if _, err := d.UpgradeLocalProfile(ctx, p.ID, acc.ID, map[string]localsave.State{}); !errors.Is(err, ErrProfileUpgraded) {
		t.Fatal("double upgrade", err)
	}
	// Names stay reserved after the move.
	if _, err := d.CreateCharacter(ctx, accOwner, w.ID, "alpha", nil, SpawnPosition()); !errors.Is(err, ErrNameTaken) {
		t.Fatal(err)
	}
}

func hash(s string) []byte {
	h := sha256.Sum256([]byte(s))
	return h[:]
}
