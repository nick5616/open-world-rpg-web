package game

// CR 040 follow-up: what is cleared inside a player's base never grows back.

import (
	"context"
	"testing"
	"time"

	"lodestone/server/pkg/campdefs"
	"lodestone/server/pkg/worldedit"
)

func TestInBaseNeverRegrows(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.WorldEdit = &WorldEditSetup{Overlay: worldedit.New()} })
	var errs []string
	_ = h.srv.Do(context.Background(), func() {
		s := h.srv
		s.campInit()
		s.campIndex(&campPiece{ID: 77, Kind: bkind("foundation_wood"), Owner: "o", XCm: 100000, ZCm: 100000, X: 1000, Z: 1000})
		if !s.inBase(1004, 1000) || s.inBase(1020, 1000) || s.inBase(1000, 1007) {
			errs = append(errs, "a building piece makes its surroundings (6 m) a base, no more")
		}
		hr := campdefs.D.Build.Hearth.WardRadiusM
		s.campIndex(&campPiece{ID: 78, Kind: bkind("hearth"), Owner: "o", XCm: 300000, ZCm: 300000, X: 3000, Z: 3000})
		if !s.inBase(3000+hr-1, 3000) || s.inBase(3000+hr+2, 3000) {
			errs = append(errs, "a hearth's ward is a base")
		}
		// A removal due to regrow now, over a base: it waits instead of growing back.
		s.we.init()
		now := time.Now()
		s.we.add(&removedObj{id: 5, x: 1002, z: 1000, cx: 15, cz: 15, at: now.Add(-time.Second)})
		s.worldEditTick(1, now)
		if s.we.removed[5] == nil || !s.we.removed[5].at.After(now) {
			errs = append(errs, "regrew inside a base")
		}
		s.we.add(&removedObj{id: 6, x: 1500, z: 1500, cx: 23, cz: 23, at: now.Add(-time.Second)})
		s.worldEditTick(2, now)
		if s.we.removed[6] != nil {
			errs = append(errs, "did not regrow outside a base")
		}
	})
	for _, e := range errs {
		t.Error(e)
	}
}
