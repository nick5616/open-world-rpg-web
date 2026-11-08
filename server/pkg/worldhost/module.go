// Package worldhost runs worldgen.wasm inside Go services (spec 4, 5; WP07).
//
// The browser and the zone server must agree on the ground to the bit, so the
// server does not reimplement any generation: it executes the very same
// worldgen.wasm the client runs, through wazero, with NO host imports (spec 5
// rule 2: all math comes from libm compiled into the module). The ABI and
// buffer layouts are documented in worldgen/README.md; this package is the
// Go binding of it.
//
// Shape of the package:
//
//   - Module: the compiled wasm (compiled once per process; compiling is the
//     slow part, ~0.3-1 s) plus stateless helpers (spec_from_seed,
//     atlas_build, hash_buffer).
//   - World: one world's atlas, copied into a pool of module instances.
//     Instances are single-threaded (ABI rule 4), so concurrency comes from
//     pooling them, never from sharing one.
//   - Terrain: the chunk cache by interest plus the movement.Ground the zone
//     and the bots simulate on. Queries are answered from cached LOD 0 chunk
//     heights in pure Go (bit-identical to the wasm, see height.go) and fall
//     back to a direct collision_height call, so a tick never waits for a
//     chunk to generate.
//
// adapted from worldgen/harness/go/wghost.go (WP01's minimal binding).
package worldhost

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

// ABIVersion is the worldgen ABI this binding implements (worldgen/README.md).
const ABIVersion = 1

// EnvWasmPath names the wasm file; EnvWasmSHA256 optionally pins its content
// hash (full hex or a prefix, e.g. the 16-char one in worldgen-<hash>.wasm).
const (
	EnvWasmPath   = "LODESTONE_WORLDGEN_WASM"
	EnvWasmSHA256 = "LODESTONE_WORLDGEN_WASM_SHA256"
)

// DefaultWasmPath is where `npm run build:wasm` writes the module, relative
// to the repo root.
var DefaultWasmPath = filepath.Join("worldgen", "pkg", "worldgen.wasm")

var exportNames = []string{
	"alloc", "free", "gen_version", "abi_version", "result_len", "error_ptr", "error_len",
	"spec_from_seed", "atlas_build", "atlas_check", "chunk_build", "collision_height",
	"ground_normal", "raycast", "hash_buffer",
	// WP10: swimming needs the water surface on the server exactly as the
	// client sees it; a wasm built before the export is refused (rebuild it).
	"water_height",
}

// ErrNoWasm is returned by LoadFromEnv when no wasm file exists (not built).
var ErrNoWasm = errors.New("worldgen.wasm not found (run `npm run build:wasm` or set " + EnvWasmPath + ")")

// Module is a compiled worldgen.wasm. Safe for concurrent use.
type Module struct {
	rt         wazero.Runtime
	compiled   wazero.CompiledModule
	path       string
	sha        string
	genVersion uint32

	// util serves the stateless one-off calls (spec, atlas build, hash).
	// They are rare (startup, minting), so one mutex-guarded instance is
	// plenty and keeps them off the query pools.
	utilMu sync.Mutex
	util   *instance
}

// Options tune how the module is compiled.
type Options struct {
	// Interpreter selects wazero's interpreter instead of the compiler.
	// Slower (~10x) but available on every GOARCH; output is identical.
	Interpreter bool
}

// ResolvePath finds the wasm file: an absolute path is used as is; a
// relative one is tried against the working directory and then every parent
// directory, so `go test` inside a package and `go run` from the repo root
// both find worldgen/pkg/worldgen.wasm.
func ResolvePath(p string) (string, error) {
	if p == "" {
		p = DefaultWasmPath
	}
	if filepath.IsAbs(p) {
		if _, err := os.Stat(p); err != nil {
			return "", fmt.Errorf("%w: %s", ErrNoWasm, p)
		}
		return p, nil
	}
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		c := filepath.Join(dir, p)
		if _, err := os.Stat(c); err == nil {
			return c, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("%w: %s (searched up from the working directory)", ErrNoWasm, p)
		}
		dir = parent
	}
}

// LoadFromEnv loads the module named by LODESTONE_WORLDGEN_WASM (default
// worldgen/pkg/worldgen.wasm) and checks LODESTONE_WORLDGEN_WASM_SHA256 when
// set.
func LoadFromEnv(ctx context.Context) (*Module, error) {
	path, err := ResolvePath(os.Getenv(EnvWasmPath))
	if err != nil {
		return nil, err
	}
	m, err := Load(ctx, path, Options{})
	if err != nil {
		return nil, err
	}
	if want := strings.ToLower(strings.TrimSpace(os.Getenv(EnvWasmSHA256))); want != "" && !strings.HasPrefix(m.sha, want) {
		_ = m.Close(ctx)
		return nil, fmt.Errorf("%s has sha256 %s, but %s pins %s", path, m.sha, EnvWasmSHA256, want)
	}
	return m, nil
}

// Load reads and compiles a worldgen.wasm file.
func Load(ctx context.Context, path string, opt Options) (*Module, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	m, err := Compile(ctx, b, opt)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	m.path = path
	return m, nil
}

// Compile compiles wasm bytes and checks the ABI and that the module imports
// nothing (a host import would be a way for host math to sneak in and break
// determinism, spec 5 rule 2).
func Compile(ctx context.Context, wasm []byte, opt Options) (*Module, error) {
	cfg := wazero.NewRuntimeConfigCompiler()
	if opt.Interpreter {
		cfg = wazero.NewRuntimeConfigInterpreter()
	}
	rt := wazero.NewRuntimeWithConfig(ctx, cfg)
	compiled, err := rt.CompileModule(ctx, wasm)
	if err != nil {
		_ = rt.Close(ctx)
		return nil, err
	}
	if imps := compiled.ImportedFunctions(); len(imps) > 0 {
		_ = rt.Close(ctx)
		mod, name, _ := imps[0].Import()
		return nil, fmt.Errorf("worldgen.wasm imports %s.%s; it must import nothing", mod, name)
	}
	sum := sha256.Sum256(wasm)
	m := &Module{rt: rt, compiled: compiled, sha: hex.EncodeToString(sum[:])}
	in, err := m.newInstance(ctx)
	if err != nil {
		_ = rt.Close(ctx)
		return nil, err
	}
	abi, err := in.call1(in.fn.abiVersion)
	if err != nil || abi != ABIVersion {
		_ = rt.Close(ctx)
		return nil, fmt.Errorf("worldgen.wasm abi_version %d, this host speaks %d (err %v)", abi, ABIVersion, err)
	}
	gv, err := in.call1(in.fn.genVersion)
	if err != nil {
		_ = rt.Close(ctx)
		return nil, err
	}
	m.genVersion = uint32(gv)
	m.util = in
	return m, nil
}

// Close releases the runtime and every instance created from it.
func (m *Module) Close(ctx context.Context) error { return m.rt.Close(ctx) }

// GenVersion is the generator major version baked into the module.
func (m *Module) GenVersion() uint32 { return m.genVersion }

// GenVersionString is GenVersion as stored in worlds.gen_version and sent in
// Welcome ("1").
func (m *Module) GenVersionString() string { return fmt.Sprint(m.genVersion) }

// SHA256 is the hex content hash of the wasm bytes (the deployable artifact
// is worldgen-<sha256[:16]>.wasm, spec 5).
func (m *Module) SHA256() string { return m.sha }

// Path is the file the module was loaded from ("" for Compile).
func (m *Module) Path() string { return m.path }

func (m *Module) withUtil(f func(in *instance) error) error {
	m.utilMu.Lock()
	defer m.utilMu.Unlock()
	if m.util == nil || m.util.broken {
		in, err := m.newInstance(context.Background())
		if err != nil {
			return err
		}
		m.util = in
	}
	return f(m.util)
}

// SpecFromSeed returns the canonical WorldSpec JSON spec_from_seed picks for
// a seed (spec 6, way 1).
func (m *Module) SpecFromSeed(seed uint64) ([]byte, error) {
	var out []byte
	err := m.withUtil(func(in *instance) error {
		p, err := in.call(in.fn.specFromSeed, seed&0xffffffff, seed>>32)
		if err != nil {
			return err
		}
		if uint32(p) == 0 {
			return in.lastError()
		}
		n, err := in.call1(in.fn.resultLen)
		if err != nil {
			return err
		}
		out, err = in.read(uint32(p), uint32(n))
		return err
	})
	return out, err
}

// BuildAtlas runs pass 1 (spec 5) and returns a copy of the atlas bytes.
// ~0.3-0.5 s; call it once per world per process.
func (m *Module) BuildAtlas(specJSON []byte, seed uint64) ([]byte, error) {
	var out []byte
	err := m.withUtil(func(in *instance) error {
		p, n, err := in.atlasBuild(specJSON, seed)
		if err != nil {
			return err
		}
		out, err = in.read(p, n)
		in.free(p, n)
		return err
	})
	return out, err
}

// Hash is hash_buffer (FNV-1a 64) computed inside the module.
func (m *Module) Hash(b []byte) (uint64, error) {
	var h uint64
	err := m.withUtil(func(in *instance) error {
		var err error
		h, err = in.hash(b)
		return err
	})
	return h, err
}

// FNV1a64 is hash_buffer in pure Go (used to cross-check, and to hash atlas
// bytes without a wasm round trip).
func FNV1a64(b []byte) uint64 {
	h := uint64(0xcbf29ce484222325)
	for _, c := range b {
		h ^= uint64(c)
		h *= 0x100000001b3
	}
	return h
}

// Hex64 formats a 64-bit hash the way worlds.atlas_hash stores it (16 lower
// hex digits, the same as hex64 in @lodestone/worldgen).
func Hex64(h uint64) string { return fmt.Sprintf("%016x", h) }

// instance is one instantiated module. Not safe for concurrent use.
type instance struct {
	mod    api.Module
	mem    api.Memory
	fn     fns
	stack  [8]uint64
	broken bool // trapped: unusable (ABI rule 5), drop it

	atlasPtr, atlasLen uint32 // atlas copied in by World, 0 if none
	outPtr             uint32 // 24-byte scratch for ground_normal
}

type fns struct {
	alloc, free, genVersion, abiVersion, resultLen, errorPtr, errorLen,
	specFromSeed, atlasBuild, atlasCheck, chunkBuild, collisionHeight,
	groundNormal, raycast, hashBuffer, waterHeight api.Function
}

func (m *Module) newInstance(ctx context.Context) (*instance, error) {
	mod, err := m.rt.InstantiateModule(ctx, m.compiled, wazero.NewModuleConfig().WithName(""))
	if err != nil {
		return nil, err
	}
	get := map[string]api.Function{}
	for _, name := range exportNames {
		f := mod.ExportedFunction(name)
		if f == nil {
			_ = mod.Close(ctx)
			return nil, fmt.Errorf("worldgen.wasm lacks export %q", name)
		}
		get[name] = f
	}
	in := &instance{mod: mod, mem: mod.Memory(), fn: fns{
		alloc: get["alloc"], free: get["free"], genVersion: get["gen_version"], abiVersion: get["abi_version"],
		resultLen: get["result_len"], errorPtr: get["error_ptr"], errorLen: get["error_len"],
		specFromSeed: get["spec_from_seed"], atlasBuild: get["atlas_build"], atlasCheck: get["atlas_check"],
		chunkBuild: get["chunk_build"], collisionHeight: get["collision_height"], groundNormal: get["ground_normal"],
		raycast: get["raycast"], hashBuffer: get["hash_buffer"], waterHeight: get["water_height"],
	}}
	return in, nil
}

func (in *instance) close() { _ = in.mod.Close(context.Background()) }

// call invokes f with args using the instance's reusable stack (no
// allocation per call: collision queries run thousands of times a second).
// A trap marks the instance broken.
func (in *instance) call(f api.Function, args ...uint64) (uint64, error) {
	if in.broken {
		return 0, errors.New("worldgen instance is broken (trapped earlier)")
	}
	st := in.stack[:]
	copy(st, args)
	if err := f.CallWithStack(context.Background(), st); err != nil {
		in.broken = true
		return 0, err
	}
	return st[0], nil
}

func (in *instance) call1(f api.Function) (uint64, error) { return in.call(f) }

// read copies n bytes at ptr: views die when memory grows on the next call
// (ABI rule 2).
func (in *instance) read(ptr, n uint32) ([]byte, error) {
	b, ok := in.mem.Read(ptr, n)
	if !ok {
		return nil, fmt.Errorf("wasm read [%d, +%d) out of range", ptr, n)
	}
	return append([]byte(nil), b...), nil
}

func (in *instance) lastError() error {
	p, err := in.call1(in.fn.errorPtr)
	if err != nil {
		return err
	}
	n, err := in.call1(in.fn.errorLen)
	if err != nil {
		return err
	}
	b, err := in.read(uint32(p), uint32(n))
	if err != nil {
		return err
	}
	return fmt.Errorf("worldgen: %s", b)
}

func (in *instance) alloc(n uint32) (uint32, error) {
	p, err := in.call(in.fn.alloc, uint64(n))
	if err != nil {
		return 0, err
	}
	if uint32(p) == 0 {
		return 0, fmt.Errorf("worldgen alloc(%d) failed", n)
	}
	return uint32(p), nil
}

func (in *instance) free(p, n uint32) { _, _ = in.call(in.fn.free, uint64(p), uint64(n)) }

// put copies b into a fresh block; the caller frees it.
func (in *instance) put(b []byte) (uint32, error) {
	n := uint32(len(b))
	if n == 0 {
		n = 1 // alloc(0) may legitimately return 0
	}
	p, err := in.alloc(n)
	if err != nil {
		return 0, err
	}
	if !in.mem.Write(p, b) {
		return 0, errors.New("wasm write out of range")
	}
	return p, nil
}

func (in *instance) atlasBuild(spec []byte, seed uint64) (uint32, uint32, error) {
	sp, err := in.put(spec)
	if err != nil {
		return 0, 0, err
	}
	defer in.free(sp, max(uint32(len(spec)), 1))
	p, err := in.call(in.fn.atlasBuild, uint64(sp), uint64(len(spec)), seed&0xffffffff, seed>>32)
	if err != nil {
		return 0, 0, err
	}
	if uint32(p) == 0 {
		return 0, 0, in.lastError()
	}
	n, err := in.call1(in.fn.resultLen)
	if err != nil {
		return 0, 0, err
	}
	return uint32(p), uint32(n), nil
}

func (in *instance) hash(b []byte) (uint64, error) {
	p, err := in.put(b)
	if err != nil {
		return 0, err
	}
	defer in.free(p, max(uint32(len(b)), 1))
	return in.call(in.fn.hashBuffer, uint64(p), uint64(len(b)))
}

// loadAtlas copies atlas bytes into this instance and validates them with
// atlas_check (ABI rule 4: every instance needs its own copy).
func (in *instance) loadAtlas(atlas []byte) error {
	p, err := in.put(atlas)
	if err != nil {
		return err
	}
	ok, err := in.call(in.fn.atlasCheck, uint64(p))
	if err != nil {
		return err
	}
	if uint32(ok) != 1 {
		in.free(p, uint32(len(atlas)))
		return in.lastError()
	}
	in.atlasPtr, in.atlasLen = p, uint32(len(atlas))
	if in.outPtr, err = in.alloc(24); err != nil {
		return err
	}
	return nil
}
