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

// WP19b: after Plan settles, the assigner moves a region off an overloaded
// zone (reported per-region load), at most one per cooldown.
func TestAssignerRebalancesByLoad(t *testing.T) {
	rdb := dbtest.Redis(t)
	ctx := context.Background()
	world := "wp19b-rebal-" + time.Now().Format("150405.000000")
	t.Cleanup(func() {
		rdb.Del(ctx, zoneregistry.Key(world), zoneregistry.AssignKey(world), "zoneassignlead:"+world)
	})
	now := time.Now()
	opt := zoneregistry.DefaultRebalance
	d := &Director{RDB: rdb, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Metrics: svc.NewMetrics(),
		Rebalance: &opt, RebalanceCooldown: 10 * time.Second, Now: func() time.Time { return now }}
	announce := func(e zoneregistry.Entry) {
		e.TTLMs = 600000
		if err := zoneregistry.Announce(ctx, rdb, world, e); err != nil {
			t.Fatal(err)
		}
	}
	// The primary carries a crowd in its (high-x) regions; b is empty.
	crowd := []zoneregistry.RegionLoad{{X: 2, Z: 0, Players: 150}, {X: 3, Z: 0, Players: 150}, {X: 3, Z: 3, Players: 150}}
	announce(zoneregistry.Entry{ZoneID: "p", Endpoint: "ws://p", Role: zoneregistry.RolePrimary, Load: crowd})
	announce(zoneregistry.Entry{ZoneID: "b", Endpoint: "ws://b", Role: zoneregistry.RolePool})
	plan, err := d.AssignOnce(ctx, world, 5*time.Second) // Plan first: b takes x = 0..1
	if err != nil || len(plan["b"]) != 8 {
		t.Fatalf("plan %v err %v", plan, err)
	}
	// Right after Plan changed the map, load moves wait two cooldowns.
	if again, _ := d.AssignOnce(ctx, world, 5*time.Second); again != nil {
		t.Fatalf("moved right after a Plan change: %v", again)
	}
	now = now.Add(21 * time.Second)
	announce(zoneregistry.Entry{ZoneID: "p", Endpoint: "ws://p", Role: zoneregistry.RolePrimary, Load: crowd})
	announce(zoneregistry.Entry{ZoneID: "b", Endpoint: "ws://b", Role: zoneregistry.RolePool})
	plan, err = d.AssignOnce(ctx, world, 5*time.Second) // then one load move
	if err != nil || len(plan["b"]) != 9 {
		t.Fatalf("want one crowded region moved to b, got %v err %v", plan, err)
	}
	if again, _ := d.AssignOnce(ctx, world, 5*time.Second); again != nil {
		t.Fatalf("moved again inside the cooldown: %v", again)
	}
	// After the cooldown, with reports showing p at 300 and b at 150, the
	// split is within the ratio: nothing more moves.
	now = now.Add(11 * time.Second)
	moved := plan["b"][8]
	var pLoad, bLoad []zoneregistry.RegionLoad
	for _, l := range crowd {
		if l.X == moved.X && l.Z == moved.Z {
			bLoad = append(bLoad, l)
		} else {
			pLoad = append(pLoad, l)
		}
	}
	announce(zoneregistry.Entry{ZoneID: "p", Endpoint: "ws://p", Role: zoneregistry.RolePrimary, Load: pLoad})
	announce(zoneregistry.Entry{ZoneID: "b", Endpoint: "ws://b", Role: zoneregistry.RolePool, Load: bLoad, Regions: plan["b"]})
	if again, err := d.AssignOnce(ctx, world, 5*time.Second); again != nil || err != nil {
		t.Fatalf("balanced split moved again: %v %v", again, err)
	}
}
