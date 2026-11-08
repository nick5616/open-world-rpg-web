package worldhost

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// A world is (seed, WorldSpec, genVersion) and minting stores
// (seed, spec, genVersion, atlasHash) in Postgres (spec 6). This file is the
// one place that decides what those columns hold:
//
//   - gen_version: the generator major version as decimal text ("1"), what
//     the wasm's gen_version() returns. Not the wasm content hash: spec 5
//     lets a rebuilt wasm (speedups, new exports) replace the old one for a
//     version as long as every golden hash is unchanged, so pinning the file
//     hash would refuse harmless rebuilds. The content hash is still logged
//     and can be pinned per deployment with LODESTONE_WORLDGEN_WASM_SHA256.
//   - atlas_hash: hash_buffer(atlas) as 16 lower hex digits. Rebuilding the
//     atlas at load and comparing it is the strongest pin there is: it
//     catches an output change even if someone forgot to bump GEN_VERSION.

// ErrGenVersion is returned when a world's gen_version differs from the
// loaded wasm's.
var ErrGenVersion = errors.New("world gen_version does not match the loaded worldgen.wasm")

// ErrAtlasHash is returned when the rebuilt atlas hashes differently from
// the world row.
var ErrAtlasHash = errors.New("rebuilt atlas hash does not match the world row")

// WorldRow is the subset of a `worlds` row that defines the world.
type WorldRow struct {
	Seed       uint64
	Spec       []byte // WorldSpec JSON (jsonb text is fine: atlas_build canonicalizes)
	GenVersion string
	AtlasHash  string
}

// IsPlaceholder reports whether a row was seeded before worldgen was wired
// in (WP04 wrote gen_version "placeholder"; WP03's dev fallback used "dev").
func IsPlaceholder(genVersion string) bool {
	switch strings.TrimSpace(genVersion) {
	case "", "placeholder", "dev":
		return true
	}
	return false
}

// CheckGenVersion refuses a gen_version other than the module's. Accepts
// "1" and "v1".
func (m *Module) CheckGenVersion(gv string) error {
	n, err := strconv.ParseUint(strings.TrimPrefix(strings.TrimSpace(gv), "v"), 10, 32)
	if err != nil || uint32(n) != m.genVersion {
		return fmt.Errorf("%w: world wants %q, worldgen.wasm (sha256 %.16s) is genVersion %d; deploy the wasm for that version (spec 5: old builds stay deployable by hash)",
			ErrGenVersion, gv, m.sha, m.genVersion)
	}
	return nil
}

// Minted is everything a world row needs, plus the opened World.
type Minted struct {
	Seed       uint64
	Spec       []byte // canonical spec JSON (from the atlas)
	Name       string // the spec's display name
	GenVersion string
	AtlasHash  string
	World      *World
}

// Mint builds a world from a seed and an optional spec (nil: spec_from_seed,
// spec 6 way 1) and returns the row values.
func (m *Module) Mint(seed uint64, spec []byte, opt WorldOptions) (Minted, error) {
	if len(spec) == 0 {
		var err error
		if spec, err = m.SpecFromSeed(seed); err != nil {
			return Minted{}, err
		}
	}
	w, err := m.OpenWorld(spec, seed, opt)
	if err != nil {
		return Minted{}, err
	}
	canon := w.SpecJSON()
	var named struct {
		Name string `json:"name"`
	}
	_ = json.Unmarshal(canon, &named)
	return Minted{Seed: seed, Spec: canon, Name: named.Name, GenVersion: m.GenVersionString(),
		AtlasHash: Hex64(w.AtlasHash), World: w}, nil
}

// OpenRow opens a world row, enforcing the pin:
//
//   - a placeholder row (not minted yet) is opened from spec_from_seed(seed),
//     exactly what minting it would store; placeholder=true tells the caller
//     to say so (and, if it owns the row, to mint it);
//   - otherwise gen_version must equal the module's (ErrGenVersion), and the
//     rebuilt atlas must hash to atlas_hash (ErrAtlasHash) unless the row's
//     hash is empty or a placeholder.
func (m *Module) OpenRow(row WorldRow, opt WorldOptions) (mt Minted, placeholder bool, err error) {
	if IsPlaceholder(row.GenVersion) {
		mt, err = m.Mint(row.Seed, nil, opt)
		return mt, true, err
	}
	if err := m.CheckGenVersion(row.GenVersion); err != nil {
		return Minted{}, false, err
	}
	if len(row.Spec) == 0 {
		return Minted{}, false, errors.New("world row has no spec")
	}
	mt, err = m.Mint(row.Seed, row.Spec, opt)
	if err != nil {
		return Minted{}, false, err
	}
	if want := strings.ToLower(strings.TrimSpace(row.AtlasHash)); want != "" && want != "placeholder" && want != mt.AtlasHash {
		mt.World.Close()
		return Minted{}, false, fmt.Errorf("%w: row %s, rebuilt %s (genVersion %s, wasm sha256 %.16s)", ErrAtlasHash, want, mt.AtlasHash, mt.GenVersion, m.sha)
	}
	return mt, false, nil
}
