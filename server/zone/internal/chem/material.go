// Package chem is the chemistry engine (WP15, spec 8 "Systems"): a coarse
// 2 m grid of material states for flammable and freezable things, fire that
// spreads cell to cell along the shared wind field and makes updrafts, ice
// that freezes water into walkable sheets and puts fires out, earth pillars,
// and rain that douses fires.
//
// Sync events, not results (spec 8): the zone schedules operations
// (ignite, freeze, extinguish, pillar) a few steps ahead and broadcasts them
// as Events 520-523; every client runs the same deterministic simulation
// (client/src/systems/chem, a line-for-line TS twin) from those events, the
// world's materials (a pure function of terrain, atlas and seed), the seeded
// wind and the seeded rain. Everything the simulation decides is integer
// arithmetic on cell indices and whole steps, plus comparisons of wasm
// heights that are bit-identical on both sides (WP07/WP10), so two clients
// and the zone agree cell for cell. The fallback (spec 8: server-sent
// burned-cell bitmaps per chunk at 2 Hz) rides behind the same client
// interface (Events 524/525, codec.go).
//
// The zone stays authoritative for damage (burning cells set enemies
// alight) and for the edit log; nothing here is persisted (fires are
// minutes long; burnt grass regrows in an in-game day).
package chem

import (
	"lodestone/server/pkg/constants"
)

// Materials (what a cell is made of; derived, never sent).
const (
	MatNone  uint8 = 0 // bare ground, rock, snow, streets: nothing happens
	MatGrass uint8 = 1 // dry grass: catches easily, burns ~20 s
	MatBrush uint8 = 2 // woody undergrowth (forest): slower to catch, burns longer
	MatDamp  uint8 = 3 // damp wetland grass: barely spreads
	MatWater uint8 = 4 // freezable
)

// Cell states (sent in baselines and bitmaps).
const (
	StNone    uint8 = 0
	StBurning uint8 = 1
	StBurnt   uint8 = 2 // also "put out": not flammable until it regrows
	StFrozen  uint8 = 3
)

// GridN is the number of cells along a world edge (4096 m / 2 m).
const GridN = constants.WorldSizeM / constants.MaterialGridM

// CellM is the cell edge in meters.
const CellM = constants.MaterialGridM

// ChunkCells is the chemistry chunk edge in cells; ChunksN chunks per edge.
const (
	ChunkCells = constants.ChemChunkCells
	ChunksN    = GridN / ChunkCells
)

// CellID packs cell (ix, iz): iz * GridN + ix.
func CellID(ix, iz int) uint32 { return uint32(iz*GridN + ix) }

// CellXZ unpacks a cell id.
func CellXZ(id uint32) (ix, iz int) { return int(id % GridN), int(id / GridN) }

// CellAt is the cell under world position (x, z) (floor; may be outside the world).
func CellAt(x, z float64) (ix, iz int) { return floorInt(x / CellM), floorInt(z / CellM) }

// InWorld reports a cell inside the grid.
func InWorld(ix, iz int) bool { return ix >= 0 && iz >= 0 && ix < GridN && iz < GridN }

// CellCenter is the world position of a cell's centre.
func CellCenter(ix, iz int) (x, z float64) {
	return float64(ix*CellM + CellM/2), float64(iz*CellM + CellM/2)
}

// ChunkOf is the chemistry chunk id of a cell (cz * ChunksN + cx).
func ChunkOf(id uint32) uint32 {
	ix, iz := CellXZ(id)
	return uint32((iz/ChunkCells)*ChunksN + ix/ChunkCells)
}

func floorInt(v float64) int {
	i := int(v)
	if float64(i) > v {
		i--
	}
	return i
}

// Flammable reports a material fire can spread into.
func Flammable(m uint8) bool { return m == MatGrass || m == MatBrush || m == MatDamp }

// Source is what the simulation reads about the world: a cell's material
// and the bare terrain and water heights at its centre. The game's source is
// TerrainMaterial; tests use synthetic ones.
type Source interface {
	Material(ix, iz int) uint8
	Height(ix, iz int) float64
	Water(ix, iz int) float64
}

// Heights is the terrain the material function reads (worldhost.Terrain:
// collision_height and water_height, bit-identical to the client's wasm).
type Heights interface {
	HeightAt(x, z float64) float64
	WaterAt(x, z float64) float64
}

// TerrainMaterial derives materials from the world (spec 8: "derived from
// scatter and biome"): water where the water surface stands above the
// ground, nothing inside settlements (macro node flag), otherwise a seeded
// mix by biome that stands in for the biome's scatter density (meadows are
// mostly grass, forests brush and grass, snow never burns). The TS twin is
// client/src/systems/chem/material.ts.
type TerrainMaterial struct {
	T        Heights
	Seed     uint64
	GridN    int    // atlas macro grid nodes per edge
	MacroRes int    // meters between nodes
	Biome    []byte // GridN x GridN biome ids (0 meadow .. 5 wetland)
	Node     []byte // 4 bytes per node; byte 3 bit 3 = settlement
	cache    map[uint32]uint8
}

// NewTerrainMaterial builds the material function from the raw atlas.
func NewTerrainMaterial(t Heights, seed uint64, atlas []byte) *TerrainMaterial {
	m := &TerrainMaterial{T: t, Seed: seed, cache: map[uint32]uint8{}}
	m.GridN, m.MacroRes, m.Biome, m.Node = parseAtlasGrids(atlas)
	return m
}

// Material implements Source.
func (m *TerrainMaterial) Material(ix, iz int) uint8 {
	if !InWorld(ix, iz) {
		return MatNone
	}
	id := CellID(ix, iz)
	if v, ok := m.cache[id]; ok {
		return v
	}
	v := m.compute(ix, iz)
	if len(m.cache) > 1<<20 {
		clear(m.cache)
	}
	m.cache[id] = v
	return v
}

func (m *TerrainMaterial) compute(ix, iz int) uint8 {
	x, z := CellCenter(ix, iz)
	if m.T.WaterAt(x, z) > m.T.HeightAt(x, z)+0.05 {
		return MatWater
	}
	biome := 0
	if m.GridN > 0 && m.MacroRes > 0 {
		i := min(m.GridN-1, (ix*CellM+CellM/2+m.MacroRes/2)/m.MacroRes)
		j := min(m.GridN-1, (iz*CellM+CellM/2+m.MacroRes/2)/m.MacroRes)
		n := j*m.GridN + i
		if 4*n+3 < len(m.Node) && m.Node[4*n+3]&8 != 0 {
			return MatNone // settlement: streets and stone don't burn
		}
		if n < len(m.Biome) {
			biome = int(m.Biome[n])
		}
	}
	return BiomeMaterial(m.Seed, ix, iz, biome)
}

// BiomeMaterial is the seeded material of a dry cell in a biome.
func BiomeMaterial(seed uint64, ix, iz, biome int) uint8 {
	r := hash4(seed, uint32(ix), uint32(iz), 0x6d617400, 0) % 100
	switch biome {
	case 0: // meadow
		if r < 72 {
			return MatGrass
		}
	case 1: // forest
		if r < 40 {
			return MatBrush
		}
		if r < 80 {
			return MatGrass
		}
	case 2: // highlands
		if r < 50 {
			return MatGrass
		}
	case 4: // badlands: dry scrub
		if r < 38 {
			return MatGrass
		}
	case 5: // wetland
		if r < 55 {
			return MatDamp
		}
	}
	return MatNone // snowpeak, bare
}

// Height implements Source (bare terrain at the cell centre).
func (m *TerrainMaterial) Height(ix, iz int) float64 {
	x, z := CellCenter(ix, iz)
	return m.T.HeightAt(x, z)
}

// Water implements Source.
func (m *TerrainMaterial) Water(ix, iz int) float64 {
	x, z := CellCenter(ix, iz)
	return m.T.WaterAt(x, z)
}

// parseAtlasGrids reads the macro grid size, resolution, biome and node
// parameter sections from the raw atlas (worldgen/README.md "LDAT").
func parseAtlasGrids(b []byte) (gridN, macroRes int, biome, node []byte) {
	if len(b) < 192 {
		return 0, 0, nil, nil
	}
	sec := func(k int) []byte {
		o := 64 + k*8
		off := int(le32(b[o:]))
		n := int(le32(b[o+4:]))
		if n == 0 || off+n > len(b) {
			return nil
		}
		return b[off : off+n]
	}
	biome = sec(6)
	node = sec(9)
	n := 0
	for n*n < len(biome) {
		n++
	}
	if n*n != len(biome) || n < 2 {
		return 0, 0, nil, nil
	}
	return n, constants.WorldSizeM / (n - 1), biome, node
}

func le32(b []byte) uint32 {
	return uint32(b[0]) | uint32(b[1])<<8 | uint32(b[2])<<16 | uint32(b[3])<<24
}
