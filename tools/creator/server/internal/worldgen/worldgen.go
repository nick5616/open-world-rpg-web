// Package worldgen runs worldgen.wasm under wazero to mint worlds: the
// creator needs exactly three things from the generator (spec_from_seed,
// atlas_build, hash_buffer) to compute what a `worlds` row stores.
//
// Adapted from worldgen/harness/go/wghost.go (that package says "copy, don't
// import": it exists for the golden harness). WP07's server/pkg/worldhost is
// the long-term shared host but was not on main when this package was
// written; the row format below matches its mint.go so worlds minted here
// open in WP07's zone without conversion:
//   - gen_version: the generator major version as decimal text ("1"), i.e.
//     gen_version(), not the wasm file hash (spec 5 lets a golden-identical
//     rebuild replace the file);
//   - atlas_hash: hash_buffer(atlas) as 16 lower-case hex digits;
//   - spec: the canonical spec JSON embedded in the atlas (SPEC section).
package worldgen

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

// ABIVersion is the wasm ABI this host speaks (worldgen/README.md).
const ABIVersion = 1

// Module is a compiled worldgen.wasm. Safe for concurrent use: every call
// gets its own instance, and mu bounds memory to one atlas build at a time
// (an atlas build peaks at tens of MB of wasm memory; minting is rare).
type Module struct {
	rt         wazero.Runtime
	compiled   wazero.CompiledModule
	mu         sync.Mutex
	GenVersion uint32
	SHA256     string // hex sha256 of the wasm file, for logs
}

// Load compiles the wasm at path.
func Load(ctx context.Context, path string) (*Module, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read worldgen.wasm (run `npm run build:wasm`): %w", err)
	}
	return New(ctx, b)
}

// New compiles wasm bytes and checks the ABI.
func New(ctx context.Context, wasm []byte) (*Module, error) {
	rt := wazero.NewRuntime(ctx)
	compiled, err := rt.CompileModule(ctx, wasm)
	if err != nil {
		_ = rt.Close(ctx)
		return nil, err
	}
	sum := sha256.Sum256(wasm)
	m := &Module{rt: rt, compiled: compiled, SHA256: hex.EncodeToString(sum[:])}
	err = m.with(ctx, func(in *instance) error {
		if abi := uint32(in.call("abi_version")); abi != ABIVersion {
			return fmt.Errorf("worldgen.wasm ABI %d, creator expects %d", abi, ABIVersion)
		}
		m.GenVersion = uint32(in.call("gen_version"))
		return nil
	})
	if err != nil {
		_ = rt.Close(ctx)
		return nil, err
	}
	return m, nil
}

// Close releases the runtime.
func (m *Module) Close(ctx context.Context) error { return m.rt.Close(ctx) }

// GenVersionString is what a worlds row stores in gen_version.
func (m *Module) GenVersionString() string { return strconv.FormatUint(uint64(m.GenVersion), 10) }

type instance struct {
	ctx context.Context
	mod api.Module
}

// trap carries a wasm trap out of call (a trap leaves the instance unusable;
// with an instance per call there is nothing to repair).
type trap struct{ err error }

func (in *instance) call(name string, args ...uint64) uint64 {
	f := in.mod.ExportedFunction(name)
	if f == nil {
		panic(trap{fmt.Errorf("worldgen.wasm lacks export %q", name)})
	}
	res, err := f.Call(in.ctx, args...)
	if err != nil {
		panic(trap{fmt.Errorf("%s: %w", name, err)})
	}
	if len(res) == 0 {
		return 0
	}
	return res[0]
}

func (in *instance) read(ptr, n uint32) []byte {
	b, ok := in.mod.Memory().Read(ptr, n)
	if !ok {
		panic(trap{errors.New("wasm read out of range")})
	}
	// Copy: the view dies if memory grows on the next call.
	return append([]byte(nil), b...)
}

func (in *instance) lastError() error {
	p := uint32(in.call("error_ptr"))
	n := uint32(in.call("error_len"))
	return errors.New(string(in.read(p, n)))
}

func (m *Module) with(ctx context.Context, fn func(*instance) error) (err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	mod, err := m.rt.InstantiateModule(ctx, m.compiled, wazero.NewModuleConfig().WithName(""))
	if err != nil {
		return err
	}
	defer mod.Close(ctx)
	defer func() {
		if r := recover(); r != nil {
			t, ok := r.(trap)
			if !ok {
				panic(r)
			}
			err = t.err
		}
	}()
	return fn(&instance{ctx: ctx, mod: mod})
}

// SpecFromSeed returns spec_from_seed(seed) as JSON (spec 6, way 1).
func (m *Module) SpecFromSeed(ctx context.Context, seed uint64) ([]byte, error) {
	var out []byte
	err := m.with(ctx, func(in *instance) error {
		p := uint32(in.call("spec_from_seed", seed&0xffffffff, seed>>32))
		out = in.read(p, uint32(in.call("result_len")))
		return nil
	})
	return out, err
}

// Atlas summarizes a built atlas: what a worlds row needs plus a few numbers
// for the mint log.
type Atlas struct {
	GenVersion string
	AtlasHash  string // 16 lower hex digits
	SpecJSON   []byte // canonical spec from the atlas SPEC section
	Bytes      int
	Sites      int
	SeaY       float32
	SpawnX     float32
	SpawnZ     float32
	BuildTime  time.Duration
}

// BuildAtlas runs atlas_build on a spec (validated JSON whose seed equals
// seed) and hashes the result.
func (m *Module) BuildAtlas(ctx context.Context, specJSON []byte, seed uint64) (Atlas, error) {
	var a Atlas
	err := m.with(ctx, func(in *instance) error {
		sp := uint32(in.call("alloc", uint64(len(specJSON))))
		if sp == 0 || !in.mod.Memory().Write(sp, specJSON) {
			return errors.New("alloc spec failed")
		}
		t0 := time.Now()
		p := uint32(in.call("atlas_build", uint64(sp), uint64(len(specJSON)), seed&0xffffffff, seed>>32))
		a.BuildTime = time.Since(t0)
		if p == 0 {
			return fmt.Errorf("atlas_build: %w", in.lastError())
		}
		n := uint32(in.call("result_len"))
		hash := in.call("hash_buffer", uint64(p), uint64(n))
		buf := in.read(p, n)
		a.GenVersion = m.GenVersionString()
		a.AtlasHash = fmt.Sprintf("%016x", hash)
		a.Bytes = int(n)
		return parseHeader(buf, &a)
	})
	return a, err
}

// parseHeader reads the few header fields and the SPEC section
// (worldgen/README.md "Atlas buffer (format 1)").
func parseHeader(b []byte, a *Atlas) error {
	if len(b) < 64+16*8 || string(b[0:4]) != "LDAT" {
		return errors.New("atlas: bad magic")
	}
	le := binary.LittleEndian
	f32 := func(off int) float32 { return math.Float32frombits(le.Uint32(b[off:])) }
	a.SeaY, a.SpawnX, a.SpawnZ = f32(32), f32(36), f32(40)
	a.Sites = int(le.Uint32(b[52:]))
	off, n := le.Uint32(b[64:]), le.Uint32(b[68:]) // directory entry 0 = SPEC
	if n == 0 || uint64(off)+uint64(n) > uint64(len(b)) {
		return errors.New("atlas: missing SPEC section")
	}
	a.SpecJSON = append([]byte(nil), b[off:off+n]...)
	return nil
}
