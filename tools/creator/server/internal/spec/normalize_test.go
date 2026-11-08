package spec

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func testGate(t *testing.T) *Gate {
	t.Helper()
	p, err := FindRepoFile(SchemaRel, ".")
	if err != nil {
		t.Fatal(err)
	}
	g, err := LoadGate(p)
	if err != nil {
		t.Fatal(err)
	}
	return g
}

type fixtureFile struct {
	Cases []struct {
		Name   string          `json:"name"`
		Input  json.RawMessage `json:"input"`
		Expect struct {
			OK      bool            `json:"ok"`
			Spec    json.RawMessage `json:"spec"`
			Changes json.RawMessage `json:"changes"`
		} `json:"expect"`
	} `json:"cases"`
}

func generic(t *testing.T, b []byte) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// TestSharedFixtures is the TS/Go agreement test: every case produced by the
// TS normalizer (tools/creator/fixtures/normalize.json) must come out of the
// Go port with the same verdict, the same spec (exact float equality) and the
// same change list in the same order.
func TestSharedFixtures(t *testing.T) {
	g := testGate(t)
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "fixtures", "normalize.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f fixtureFile
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Cases) < 30 {
		t.Fatalf("only %d fixture cases", len(f.Cases))
	}
	for _, c := range f.Cases {
		t.Run(c.Name, func(t *testing.T) {
			res, err := g.Normalize(c.Input)
			if !c.Expect.OK {
				var rej *RejectedError
				if !errors.As(err, &rej) {
					t.Fatalf("want rejection, got err=%v spec=%s", err, res.JSON)
				}
				return
			}
			if err != nil {
				t.Fatalf("want ok, got %v", err)
			}
			if got, want := generic(t, res.JSON), generic(t, c.Expect.Spec); !reflect.DeepEqual(got, want) {
				t.Fatalf("spec differs\n got  %s\n want %s", res.JSON, c.Expect.Spec)
			}
			cb, _ := json.Marshal(res.Changes)
			if got, want := generic(t, cb), generic(t, c.Expect.Changes); !reflect.DeepEqual(got, want) {
				t.Fatalf("changes differ\n got  %s\n want %s", cb, c.Expect.Changes)
			}
		})
	}
}

func TestNormalizeIsIdempotent(t *testing.T) {
	g := testGate(t)
	b, _ := os.ReadFile(filepath.Join("..", "..", "..", "fixtures", "normalize.json"))
	var f fixtureFile
	_ = json.Unmarshal(b, &f)
	for _, c := range f.Cases {
		if !c.Expect.OK {
			continue
		}
		first, err := g.Normalize(c.Input)
		if err != nil {
			t.Fatal(err)
		}
		second, err := g.Normalize(first.JSON)
		if err != nil {
			t.Fatalf("%s: renormalizing failed: %v", c.Name, err)
		}
		if string(second.JSON) != string(first.JSON) || len(second.Changes) != 0 {
			t.Fatalf("%s: not idempotent: %s -> %s (%v)", c.Name, first.JSON, second.JSON, second.Changes)
		}
	}
}

func TestNegativeZero(t *testing.T) {
	// JSON.stringify(-0) is "0", so the fixture file cannot carry -0; check it here.
	g := testGate(t)
	b, _ := os.ReadFile(filepath.Join("..", "..", "..", "fixtures", "normalize.json"))
	var f fixtureFile
	_ = json.Unmarshal(b, &f)
	in := strings.Replace(string(f.Cases[0].Input), `"plateaus": 0.347`, `"plateaus": -0`, 1)
	if in == string(f.Cases[0].Input) {
		t.Fatal("fixture shape changed; update this test")
	}
	res, err := g.Normalize([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(res.JSON), `"plateaus":0,`) {
		t.Fatalf("-0 leaked into %s", res.JSON)
	}
}

func TestModelSchemaHasNoUnsupportedKeywords(t *testing.T) {
	g := testGate(t)
	b, _ := json.Marshal(g.ModelSchema())
	s := string(b)
	for _, k := range []string{`"minimum"`, `"maximum"`, `"pattern"`, `"maxItems"`, `"uniqueItems"`, `"minLength"`, `"maxLength"`, `"$schema"`, `"$id"`} {
		if strings.Contains(s, k) {
			t.Errorf("model schema still has %s", k)
		}
	}
	for _, k := range []string{`"additionalProperties":false`, `"required"`, `"enum"`, `"seaLevel"`, `"biomeWeights"`} {
		if !strings.Contains(s, k) {
			t.Errorf("model schema lost %s", k)
		}
	}
}

func TestCleanNameAndBlocklist(t *testing.T) {
	cases := map[string]string{
		"  a\tb  ":                "a b",
		"Isles!!!of---Frost":      "Isles of---Frost",
		strings.Repeat("ab ", 30): "ab ab ab ab ab ab ab ab ab ab ab ab ab a",
		"Ærø Bay":                 "r Bay",
	}
	for in, want := range cases {
		if got := CleanName(in, 40); got != want {
			t.Errorf("CleanName(%q) = %q, want %q", in, got, want)
		}
	}
	if BlockedStem("Lavender Wanderer") != "" || BlockedStem("Ender Wastes") != "ender" || BlockedStem("Wolf's-Odinsgate") != "odin" {
		t.Error("blocklist word-prefix rule broken")
	}
}
