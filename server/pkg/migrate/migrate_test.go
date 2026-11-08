package migrate

import (
	"path/filepath"
	"testing"
)

func TestLoadOrdersRealMigrations(t *testing.T) {
	migs, err := Load(filepath.Join("..", "..", "..", "contracts", "migrations"))
	if err != nil {
		t.Fatal(err)
	}
	if len(migs) == 0 || migs[0].Version != 1 {
		t.Fatalf("expected 0001 first, got %+v", migs)
	}
	for i := 1; i < len(migs); i++ {
		if migs[i].Version <= migs[i-1].Version {
			t.Fatal("not ordered")
		}
	}
}
