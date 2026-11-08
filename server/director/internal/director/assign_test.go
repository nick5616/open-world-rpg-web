package director

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"lodestone/server/pkg/accountapi/dbtest"
	"lodestone/server/pkg/svc"
	"lodestone/server/pkg/zoneregistry"
)

// WP16: the assigner against the shared Redis with fake registry entries.
func TestAssignerSplitsAndFailsOver(t *testing.T) {
	rdb := dbtest.Redis(t)
	ctx := context.Background()
	world := "wp16-assign-" + time.Now().Format("150405.000000")
	t.Cleanup(func() {
		rdb.Del(ctx, zoneregistry.Key(world), zoneregistry.AssignKey(world), "zoneassignlead:"+world)
	})
	d := &Director{RDB: rdb, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Metrics: svc.NewMetrics()}
	announce := func(e zoneregistry.Entry) {
		if err := zoneregistry.Announce(ctx, rdb, world, e); err != nil {
			t.Fatal(err)
		}
	}
	announce(zoneregistry.Entry{ZoneID: "p", Endpoint: "ws://p", Role: zoneregistry.RolePrimary, TTLMs: 3000})
	announce(zoneregistry.Entry{ZoneID: "b", Endpoint: "ws://b", Role: zoneregistry.RolePool, TTLMs: 3000})
	plan, err := d.AssignOnce(ctx, world, 5*time.Second)
	if err != nil || len(plan["b"]) != 8 {
		t.Fatalf("plan %v err %v", plan, err)
	}
	// Unchanged on the next run (sticky, nothing written).
	if again, _ := d.AssignOnce(ctx, world, 5*time.Second); again != nil {
		t.Fatalf("rewrote an unchanged plan: %v", again)
	}
	rs, _ := zoneregistry.ReadAssignment(ctx, rdb, world, "b")
	announce(zoneregistry.Entry{ZoneID: "b", Endpoint: "ws://b", Role: zoneregistry.RolePool, TTLMs: 3000, Regions: rs})
	live, _ := zoneregistry.Live(ctx, rdb, world, time.Now())
	if z, _ := pickZone(live, zoneregistry.Region{X: 0, Z: 0}); z.ZoneID != "b" {
		t.Fatalf("region 0,0 should route to b, got %q", z.ZoneID)
	}
	if z, _ := pickZone(live, zoneregistry.Region{X: 3, Z: 3}); z.ZoneID != "p" {
		t.Fatalf("region 3,3 should route to the primary, got %q", z.ZoneID)
	}
	// b dies (stale): routing falls back at once, the assigner makes it stick.
	announce(zoneregistry.Entry{ZoneID: "p", Endpoint: "ws://p", Role: zoneregistry.RolePrimary, TTLMs: 30000})
	d.Now = func() time.Time { return time.Now().Add(4 * time.Second) }
	live, _ = zoneregistry.Live(ctx, rdb, world, d.now())
	if z, _ := pickZone(live, zoneregistry.Region{X: 0, Z: 0}); z.ZoneID != "p" {
		t.Fatalf("after b died, region 0,0 should route to the primary, got %q", z.ZoneID)
	}
	plan, err = d.AssignOnce(ctx, world, 5*time.Second)
	if err != nil || plan == nil || len(plan["b"]) != 0 {
		t.Fatalf("dead zone kept regions: %v %v", plan, err)
	}
}
