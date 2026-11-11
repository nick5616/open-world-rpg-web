package mintdb

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"lodestone/server/pkg/accountapi"
	"lodestone/server/pkg/accountapi/dbtest"
	"lodestone/server/pkg/vertical"
	"lodestone/server/pkg/worldhost"
)

// TestRenewOfficialToVertical (CR 038): a world on the archived genVersion 2
// renewed onto genVersion 3: every site keeps its index and id (the
// vertical sites are appended), a character saved in a tunnel mouth (a new
// hole in the terrain; its position from the new descriptor) moves to the
// spawn marker, one by a village stays (its ground did not change from 2 to 3).
func TestRenewOfficialToVertical(t *testing.T) {
	pool, _ := dbtest.Postgres(t)
	db := accountapi.DB{Pool: pool}
	ctx := context.Background()
	load, _ := loader(t)
	cur, err := load()
	if err != nil {
		t.Fatal(err)
	}
	if cur.GenVersion() < 3 {
		t.Skipf("needs genVersion 3 (have %s)", cur.GenVersionString())
	}
	old, err := worldhost.LoadForGenVersion(ctx, "2")
	if err != nil || old.GenVersionString() != "2" {
		t.Skipf("needs the archived genVersion 2: %v", err)
	}
	defer old.Close(ctx)
	w, _, err := EnsureOfficial(ctx, db, func() (*worldhost.Module, error) { return old, nil }, accountapi.World{Name: "Lodestone", Seed: "20261108"})
	if err != nil || w.GenVersion != "2" {
		t.Fatalf("gv2 official world: %v %+v", err, w)
	}
	mt, err := cur.Mint(20261108, w.Spec, worldhost.WorldOptions{MaxInstances: 1})
	if err != nil {
		t.Fatal(err)
	}
	vb, err := mt.World.VerticalDesc()
	mt.World.Close()
	if err != nil {
		t.Fatal(err)
	}
	vw, err := vertical.Parse(vb)
	if err != nil || len(vw.SurfaceOpenings) == 0 {
		t.Fatalf("descriptor: %v", err)
	}
	hole := vw.SurfaceOpenings[0]
	var acct, inHole, village string
	if err := pool.QueryRow(ctx, `INSERT INTO accounts (auth_provider, auth_subject) VALUES ('test', 'renew3') RETURNING id::text`).Scan(&acct); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		name, pos string
		id        *string
	}{{"Hole", fmt.Sprintf(`{"x":%f,"y":30,"z":%f}`, hole.X+1, hole.Z), &inHole}, {"Village", `{"x":580,"y":30,"z":1190}`, &village}} {
		if err := pool.QueryRow(ctx, `INSERT INTO characters (account_id, world_id, name, position) VALUES ($1, $2, $3, $4::jsonb) RETURNING id::text`, acct, w.ID, c.name, c.pos).Scan(c.id); err != nil {
			t.Fatal(err)
		}
	}
	res, err := RenewOfficial(ctx, db, cur, old)
	if err != nil {
		t.Fatal(err)
	}
	if res.Action != Renewed || res.After.GenVersion != cur.GenVersionString() || !res.KeptAll || res.Moved != 1 {
		t.Fatalf("renewal: %+v", res)
	}
	at := func(id string) (float64, float64) {
		var raw []byte
		if err := pool.QueryRow(ctx, `SELECT position FROM characters WHERE id = $1::uuid`, id).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		var p struct{ X, Z float64 }
		_ = json.Unmarshal(raw, &p)
		return p.X, p.Z
	}
	if x, z := at(inHole); x != 2048 || z != 2048 {
		t.Fatalf("the character in the tunnel mouth was not moved: %v, %v", x, z)
	}
	if x, z := at(village); x != 580 || z != 1190 {
		t.Fatalf("the villager moved: %v, %v", x, z)
	}
}

// curGV is the built generator's genVersion ("3" since CR 038).
func curGV(t *testing.T) string {
	t.Helper()
	load, _ := loader(t)
	m, err := load()
	if err != nil {
		t.Fatal(err)
	}
	return m.GenVersionString()
}
