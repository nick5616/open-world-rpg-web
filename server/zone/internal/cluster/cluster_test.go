package cluster

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"lodestone/server/pkg/accountapi/dbtest"
	"lodestone/server/pkg/zoneregistry"
)

// Against the shared Redis, in a world of its own (keys removed after).
func TestRedisCluster(t *testing.T) {
	rdb := dbtest.Redis(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	world := "wp16-cluster-test-" + time.Now().Format("150405.000000")
	t.Cleanup(func() {
		keys, _ := rdb.Keys(context.Background(), "*"+world+"*").Result()
		if len(keys) > 0 {
			rdb.Del(context.Background(), keys...)
		}
	})
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	a, b := New(rdb, world, "a", log), New(rdb, world, "b", log)
	go a.Run(ctx)
	go b.Run(ctx)

	// Single-use records.
	if err := a.Put(ctx, "hotoken:t1", []byte("rec"), time.Minute); err != nil {
		t.Fatal(err)
	}
	if v, _ := b.Take(ctx, "hotoken:t1"); string(v) != "rec" {
		t.Fatalf("take %q", v)
	}
	if v, _ := b.Take(ctx, "hotoken:t1"); v != nil {
		t.Fatal("token taken twice")
	}
	if n, _ := rdb.Exists(ctx, "hotoken:"+world+":t1").Result(); n != 0 {
		t.Fatal("key not scoped by world or not deleted")
	}
	// Owner records.
	if old, _ := a.Swap(ctx, "owner:c1", []byte("a"), time.Minute); old != nil {
		t.Fatalf("fresh swap returned %q", old)
	}
	if old, _ := b.Swap(ctx, "owner:c1", []byte("b"), time.Minute); string(old) != "a" {
		t.Fatalf("swap returned %q", old)
	}
	_ = a.DelIf(ctx, "owner:c1", []byte("a")) // not a's any more: kept
	if v, _ := rdb.Get(ctx, "owner:"+world+":c1").Result(); v != "b" {
		t.Fatalf("DelIf deleted someone else's record: %q", v)
	}
	// Entity ids: stable per character, distinct, above PlayerIDBase.
	id1, _ := a.EntityID(ctx, "c1")
	id1b, _ := b.EntityID(ctx, "c1")
	id2, _ := b.EntityID(ctx, "c2")
	if id1 != id1b || id1 == id2 || id1 <= PlayerIDBase {
		t.Fatalf("ids %d %d %d", id1, id1b, id2)
	}
	// Presence.
	_ = a.WritePresence(ctx, map[string][]byte{"c1": []byte("p1"), "c9": []byte("x")}, nil)
	_ = a.WritePresence(ctx, nil, []string{"c9"})
	if m, _ := b.ReadPresence(ctx); len(m) != 1 || string(m["c1"]) != "p1" {
		t.Fatalf("presence %v", m)
	}
	// Control messages and ghost frames.
	time.Sleep(200 * time.Millisecond) // subscriptions
	if err := a.Send(ctx, "b", []byte(`{"t":"ready"}`)); err != nil {
		t.Fatal(err)
	}
	if err := a.Broadcast(ctx, []byte{1, 2, 3}); err != nil {
		t.Fatal(err)
	}
	gotCtl, gotGhost := false, false
	for !(gotCtl && gotGhost) {
		select {
		case m := <-b.Recv():
			if m.Ghost {
				gotGhost = string(m.Data) == "\x01\x02\x03"
			} else {
				gotCtl = string(m.Data) == `{"t":"ready"}`
			}
		case <-ctx.Done():
			t.Fatalf("delivery: ctl %v ghost %v", gotCtl, gotGhost)
		}
	}
	// Heartbeat and ownership: a pool zone announces the director's regions.
	_ = zoneregistry.WriteAssignment(ctx, rdb, world, map[string][]zoneregistry.Region{"b": {{X: 0, Z: 0}}})
	ann := func(r *Redis, role string) *Announcer {
		return &Announcer{R: r, Entry: zoneregistry.Entry{ZoneID: r.Zone, Endpoint: "ws://" + r.Zone, Role: role, TTLMs: 3000}, Every: 100 * time.Millisecond, Players: func() int { return 0 }}
	}
	actx, stop := context.WithCancel(ctx)
	defer stop()
	go ann(a, zoneregistry.RolePrimary).Run(actx)
	go ann(b, zoneregistry.RolePool).Run(actx)
	deadline := time.Now().Add(5 * time.Second)
	for {
		if o := a.Owners(); o != nil && o.Region[0][0] == "b" && o.Region[3][3] == "a" && o.Zones["b"].Endpoint == "ws://b" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("ownership never converged: %+v", a.Owners())
		}
		time.Sleep(50 * time.Millisecond)
	}
	if s, _ := a.Slot(ctx); s == 0 || s>>24 < 1 || s>>24 > 63 {
		t.Fatalf("slot %d", s)
	}
}
