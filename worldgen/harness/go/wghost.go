// Package harness is the Go/wazero host of the worldgen determinism harness
// (spec 5 rule 5, spec 14). It runs the same worldgen.wasm the browser runs
// and checks it against worldgen/golden/golden.json.
//
// Host is a minimal binding of the ABI in worldgen/README.md; WP07's
// server/pkg/worldhost can start from it (copy, don't import: this module
// lives in worldgen/ and only exists for the harness).
package harness

import (
	"context"
	"errors"
	"fmt"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

// Host wraps one instantiated worldgen.wasm module. Not safe for concurrent
// use: wasm instances are single-threaded; run one Host per goroutine.
type Host struct {
	mod api.Module
	fn  map[string]api.Function
}

var exports = []string{
	"alloc", "free", "gen_version", "abi_version", "result_len", "error_ptr", "error_len",
	"spec_from_seed", "atlas_build", "atlas_check", "chunk_build", "collision_height",
	"ground_normal", "raycast", "hash_buffer",
}

// New instantiates worldgen.wasm in rt. The module imports nothing.
func New(ctx context.Context, rt wazero.Runtime, wasm []byte) (*Host, error) {
	mod, err := rt.InstantiateWithConfig(ctx, wasm, wazero.NewModuleConfig().WithName(""))
	if err != nil {
		return nil, err
	}
	h := &Host{mod: mod, fn: map[string]api.Function{}}
	for _, name := range exports {
		f := mod.ExportedFunction(name)
		if f == nil {
			return nil, fmt.Errorf("worldgen.wasm lacks export %q", name)
		}
		h.fn[name] = f
	}
	return h, nil
}

func (h *Host) call(ctx context.Context, name string, args ...uint64) uint64 {
	res, err := h.fn[name].Call(ctx, args...)
	if err != nil {
		panic(fmt.Sprintf("%s: %v", name, err))
	}
	if len(res) == 0 {
		return 0
	}
	return res[0]
}

func (h *Host) read(ptr, n uint32) []byte {
	b, ok := h.mod.Memory().Read(ptr, n)
	if !ok {
		panic("read out of range")
	}
	// Copy: the view is invalidated if memory grows on the next call.
	return append([]byte(nil), b...)
}

func (h *Host) lastError(ctx context.Context) error {
	p := uint32(h.call(ctx, "error_ptr"))
	n := uint32(h.call(ctx, "error_len"))
	return errors.New(string(h.read(p, n)))
}

// GenVersion is the generator major version baked into the module.
func (h *Host) GenVersion(ctx context.Context) uint32 { return uint32(h.call(ctx, "gen_version")) }

// AtlasBuild builds an atlas from WorldSpec JSON and returns its pointer and
// length in wasm memory (free with Free).
func (h *Host) AtlasBuild(ctx context.Context, specJSON []byte, seed uint64) (uint32, uint32, error) {
	sp := uint32(h.call(ctx, "alloc", uint64(len(specJSON))))
	defer h.call(ctx, "free", uint64(sp), uint64(len(specJSON)))
	if !h.mod.Memory().Write(sp, specJSON) {
		return 0, 0, errors.New("write spec out of range")
	}
	p := uint32(h.call(ctx, "atlas_build", uint64(sp), uint64(len(specJSON)), seed&0xffffffff, seed>>32))
	if p == 0 {
		return 0, 0, h.lastError(ctx)
	}
	return p, uint32(h.call(ctx, "result_len")), nil
}

// Free releases memory returned by AtlasBuild.
func (h *Host) Free(ctx context.Context, ptr, n uint32) { h.call(ctx, "free", uint64(ptr), uint64(n)) }

// ChunkBuild returns a copy of the chunk buffer (layout in README).
func (h *Host) ChunkBuild(ctx context.Context, atlas uint32, cx, cz int32, lod uint32) ([]byte, error) {
	p := uint32(h.call(ctx, "chunk_build", uint64(atlas), api.EncodeI32(cx), api.EncodeI32(cz), uint64(lod)))
	if p == 0 {
		return nil, h.lastError(ctx)
	}
	return h.read(p, uint32(h.call(ctx, "result_len"))), nil
}

// CollisionHeight is the server's ground query.
func (h *Host) CollisionHeight(ctx context.Context, atlas uint32, x, z float64) float64 {
	return api.DecodeF64(h.call(ctx, "collision_height", uint64(atlas), api.EncodeF64(x), api.EncodeF64(z)))
}

// HashRange hashes bytes already in wasm memory (FNV-1a 64).
func (h *Host) HashRange(ctx context.Context, ptr, n uint32) uint64 {
	return h.call(ctx, "hash_buffer", uint64(ptr), uint64(n))
}

// Hash copies b into wasm memory and hashes it there.
func (h *Host) Hash(ctx context.Context, b []byte) uint64 {
	p := uint32(h.call(ctx, "alloc", uint64(len(b))))
	defer h.call(ctx, "free", uint64(p), uint64(len(b)))
	h.mod.Memory().Write(p, b)
	return h.HashRange(ctx, p, uint32(len(b)))
}

// FNV1a64 is the same hash in pure Go, to cross-check hash_buffer.
func FNV1a64(b []byte) uint64 {
	h := uint64(0xcbf29ce484222325)
	for _, c := range b {
		h ^= uint64(c)
		h *= 0x100000001b3
	}
	return h
}
