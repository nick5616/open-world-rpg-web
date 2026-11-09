package worldhost

// Archived generators (spec 5 "keeping old worlds working"): a world pins
// its genVersion forever, so a host must be able to load the generator a
// world was minted with even after the default build moved on. The repo
// keeps each superseded content-hashed build in worldgen/archive/ with a
// manifest (genVersion -> file, sha256, golden table, source commit); a
// deployment ships the same directory next to worldgen.wasm (and the
// object-storage archive holds every worldgen-<hash>.wasm ever published).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// EnvArchive names the directory holding manifest.json and the archived
// wasm files (default worldgen/archive, searched upward like the wasm).
const EnvArchive = "LODESTONE_WORLDGEN_ARCHIVE"

// DefaultArchiveDir is the archive relative to the repo root.
var DefaultArchiveDir = filepath.Join("worldgen", "archive")

// ArchiveEntry is one archived generator.
type ArchiveEntry struct {
	GenVersion uint32 `json:"genVersion"`
	File       string `json:"file"`
	SHA256     string `json:"sha256"`
	Golden     string `json:"golden"`
	Source     string `json:"source"`
}

// Archive is worldgen/archive/manifest.json.
type Archive struct {
	Dir      string         `json:"-"`
	Versions []ArchiveEntry `json:"versions"`
}

// ErrNoArchive is returned when no archive directory exists.
var ErrNoArchive = errors.New("worldgen archive not found")

// LoadArchive reads the manifest from LODESTONE_WORLDGEN_ARCHIVE (default
// worldgen/archive, searched from the working directory upward).
func LoadArchive() (*Archive, error) {
	dir := os.Getenv(EnvArchive)
	if dir == "" {
		dir = DefaultArchiveDir
	}
	p, err := ResolvePath(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrNoArchive, dir)
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	a := &Archive{Dir: filepath.Dir(p)}
	if err := json.Unmarshal(raw, a); err != nil {
		return nil, fmt.Errorf("%s: %w", p, err)
	}
	return a, nil
}

// Entry returns the archived generator for a genVersion.
func (a *Archive) Entry(gv uint32) (ArchiveEntry, bool) {
	for _, e := range a.Versions {
		if e.GenVersion == gv {
			return e, true
		}
	}
	return ArchiveEntry{}, false
}

// Load compiles an archived generator and checks its content hash and
// genVersion against the manifest.
func (a *Archive) Load(ctx context.Context, e ArchiveEntry) (*Module, error) {
	m, err := Load(ctx, filepath.Join(a.Dir, e.File), Options{})
	if err != nil {
		return nil, err
	}
	if !strings.EqualFold(m.SHA256(), e.SHA256) || m.genVersion != e.GenVersion {
		_ = m.Close(ctx)
		return nil, fmt.Errorf("archived %s: sha256 %s genVersion %d, manifest says %s / %d", e.File, m.SHA256(), m.genVersion, e.SHA256, e.GenVersion)
	}
	return m, nil
}

// ParseGenVersion reads a worlds.gen_version value ("2" or "v2"); ok=false
// for placeholders and anything unparsable.
func ParseGenVersion(gv string) (uint32, bool) {
	if IsPlaceholder(gv) {
		return 0, false
	}
	n, err := strconv.ParseUint(strings.TrimPrefix(strings.TrimSpace(gv), "v"), 10, 32)
	return uint32(n), err == nil
}

// LoadForGenVersion loads the generator for a world row's gen_version: the
// default module (LoadFromEnv) when it matches (or the row is a
// placeholder), else the archived build for that version. Without an
// archived match it returns the default module, so OpenRow reports the pin
// error (ErrGenVersion) exactly as before.
func LoadForGenVersion(ctx context.Context, gv string) (*Module, error) {
	m, err := LoadFromEnv(ctx)
	if err != nil {
		return nil, err
	}
	want, ok := ParseGenVersion(gv)
	if !ok || want == m.genVersion {
		return m, nil
	}
	a, err := LoadArchive()
	if err != nil {
		// No archive: the caller's pin check (OpenRow) explains the mismatch.
		return m, nil
	}
	e, found := a.Entry(want)
	if !found {
		return m, nil
	}
	old, err := a.Load(ctx, e)
	if err != nil {
		_ = m.Close(ctx)
		return nil, err
	}
	_ = m.Close(ctx)
	return old, nil
}
