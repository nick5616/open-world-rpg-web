package mintdb

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"lodestone/server/pkg/accountapi"
	"lodestone/server/pkg/accountapi/dbtest"
	"lodestone/server/pkg/worldhost"
)

// TestRenewOfficial: a world minted on genVersion 1 (the archived build) is
// renewed in place onto the current generator: same id, seed and spec, the
// new gen_version and atlas_hash, progress kept (every old site keeps its
// index and id), a character saved by a village moved to the spawn marker,
// one far from every village left where it was; a second run is a no-op.
func TestRenewOfficial(t *testing.T) {
	pool, _ := dbtest.Postgres(t)
	db := accountapi.DB{Pool: pool}
	ctx := context.Background()
	load, _ := loader(t)
	cur, err := load()
	if err != nil {
		t.Fatal(err)
	}
	old, err := worldhost.LoadForGenVersion(ctx, "1")
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close(ctx)
	if old.GenVersionString() != "1" || cur.GenVersionString() == "1" {
		t.Skipf("needs the archived genVersion 1 and a newer current build (have %s / %s)", old.GenVersionString(), cur.GenVersionString())
	}
	w, _, err := EnsureOfficial(ctx, db, func() (*worldhost.Module, error) { return old, nil }, accountapi.World{Name: "Lodestone", Seed: "20261108"})
	if err != nil || w.GenVersion != "1" || w.AtlasHash != "50ae4562cfd25265" {
		t.Fatalf("gv1 official world: %v %+v", err, w)
	}
	var acct, near, far string
	if err := pool.QueryRow(ctx, `INSERT INTO accounts (auth_provider, auth_subject) VALUES ('test', 'renew') RETURNING id::text`).Scan(&acct); err != nil {
		t.Fatal(err)
	}
	// Staecgair (a timber village of seed 20261108 at ~(576, 1184)) and the
	// sea corner far from everything.
	for _, c := range []struct {
		name, pos string
		id        *string
	}{{"Near", `{"x":580,"y":30,"z":1190}`, &near}, {"Far", `{"x":40,"y":5,"z":40}`, &far}} {
		if err := pool.QueryRow(ctx, `INSERT INTO characters (account_id, world_id, name, position) VALUES ($1, $2, $3, $4::jsonb) RETURNING id::text`, acct, w.ID, c.name, c.pos).Scan(c.id); err != nil {
			t.Fatal(err)
		}
	}
	res, err := RenewOfficial(ctx, db, cur, old)
	if err != nil {
		t.Fatal(err)
	}
	if res.Action != Renewed || res.After.ID != w.ID || res.After.Seed != w.Seed || res.After.GenVersion != cur.GenVersionString() || res.After.AtlasHash == w.AtlasHash || !res.KeptAll || res.Moved != 1 {
		t.Fatalf("renewal: %+v", res)
	}
	pos := func(id string) string {
		var raw []byte
		if err := pool.QueryRow(ctx, `SELECT position FROM characters WHERE id = $1::uuid`, id).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		var p struct{ X, Z float64 }
		_ = json.Unmarshal(raw, &p)
		return fmt.Sprint(p.X, ",", p.Z)
	}
	if pos(near) != "2048,2048" || pos(far) != "40,40" {
		t.Fatalf("positions after renewal: near %s, far %s", pos(near), pos(far))
	}
	// The renewed row opens on the current build with its new pin.
	mt, _, err := cur.OpenRow(worldhost.WorldRow{Seed: 20261108, Spec: res.After.Spec, GenVersion: res.After.GenVersion, AtlasHash: res.After.AtlasHash}, worldhost.WorldOptions{MaxInstances: 1})
	if err != nil {
		t.Fatal(err)
	}
	mt.World.Close()
	again, err := RenewOfficial(ctx, db, cur, old)
	if err != nil || again.Action != AlreadyCurrent {
		t.Fatalf("second renewal: %v %+v", err, again.Action)
	}
}
