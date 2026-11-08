package store

import (
	"context"
	"sync"
	"testing"

	"lodestone/server/pkg/accountapi/dbtest"
)

func TestInsertDedupesAndLists(t *testing.T) {
	pool, _ := dbtest.Postgres(t) // scratch database, dropped after the test
	s := &Store{Pool: pool}
	ctx := context.Background()
	w := World{Name: "Test Isles", Seed: "18446744073709551615", Spec: []byte(`{"name":"Test Isles"}`), GenVersion: "1", AtlasHash: "00112233aabbccdd"}

	// Concurrent mints of the same world produce exactly one row.
	var wg sync.WaitGroup
	results := make([]bool, 6)
	ids := make([]string, 6)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			got, existed, err := s.Insert(ctx, w)
			if err != nil {
				t.Error(err)
				return
			}
			results[i], ids[i] = existed, got.ID
		}(i)
	}
	wg.Wait()
	fresh := 0
	for i, existed := range results {
		if !existed {
			fresh++
		}
		if ids[i] != ids[0] {
			t.Fatalf("different ids: %v", ids)
		}
	}
	if fresh != 1 {
		t.Fatalf("%d fresh inserts, want 1", fresh)
	}

	w2 := w
	w2.AtlasHash = "ffffffffffffffff"
	got, existed, err := s.Insert(ctx, w2)
	if err != nil || existed || got.Official || got.Seed != w.Seed {
		t.Fatalf("second world: %+v existed=%v err=%v", got, existed, err)
	}
	list, err := s.List(ctx, 10)
	if err != nil || len(list) != 2 || list[0].ID != got.ID {
		t.Fatalf("list: %+v %v", list, err)
	}
	if string(list[1].Spec) != `{"name": "Test Isles"}` {
		t.Fatalf("spec round trip: %s", list[1].Spec)
	}
}
