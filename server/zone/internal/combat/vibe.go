package combat

// Playtest 2 vibe explorer (docs/cr/036-vibe-explorer.md): what the dev
// console's vibe commands change in the combat world. Only the game
// package's dev console calls these, on a zone started with
// LODESTONE_ZONE_DEV=1.

import (
	"math"
	"slices"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/movement"
)

// DevRespawnArea makes every atlas group anchored in the square [x0, x1) x
// [z0, z1) come back now: spawned ones are removed (and spawn again on the
// next pass with the same composition, at the area's level as it is now),
// cleared ones forget their respawn timer. Returns how many groups and how
// many live members were removed.
func (w *World) DevRespawnArea(x0, z0, x1, z1 float64) (groups, removed int) {
	for _, g := range w.Groups {
		if !g.AreaLevel || g.Retired || g.Anchor.X < x0 || g.Anchor.X >= x1 || g.Anchor.Z < z0 || g.Anchor.Z >= z1 {
			continue
		}
		groups++
		if g.Spawned {
			for _, e := range g.Members {
				if e.Alive() {
					removed++
				}
				w.removeEnemy(e)
			}
			g.Members = nil
			g.Spawned = false
			g.spawns-- // the same composition comes back
		}
		g.respawn = 0
	}
	return groups, removed
}

// DevTypical places the enemies a camp of this biome and region element
// would have (the atlas camp table, with the tier's beginner share), n of
// them (0: the camp's own count), at level, at a walkable spot near at.
func (w *World) DevTypical(at movement.Vec3, biome, element, level int, tier *combatdefs.DifficultyTier, n int, salt uint64) *Group {
	probe := &Group{Kind: GroupCamp, Biome: biome, Element: element, Seed: mix(salt ^ uint64(math.Float64bits(at.X)) ^ uint64(math.Float64bits(at.Z))<<1), tier: tier}
	keys, _, _ := w.composition(probe)
	if n > 0 && len(keys) > 0 {
		base := slices.Clone(keys)
		keys = keys[:0]
		for i := 0; i < n; i++ {
			keys = append(keys, base[i%len(base)])
		}
	}
	if len(keys) == 0 {
		return nil
	}
	at.Y = w.ground.HeightAt(at.X, at.Z)
	return w.AddGroup(&Group{Kind: GroupTest, Anchor: at, Radius: 10, Comp: keys, Level: max(1, level), Site: -1, Element: element, Biome: biome})
}

// DevFreeze stops (on) or restarts every group's AI: frozen groups stand
// like training dummies (Group.Dummy). Groups that were already dummies stay
// so. Call it again while frozen to catch groups added since (it only
// touches groups not yet marked); marked is the set it froze.
func (w *World) DevFreeze(on bool, marked map[*Group]bool) {
	if on {
		for _, g := range w.Groups {
			if !g.Dummy {
				g.Dummy = true
				marked[g] = true
			}
		}
		return
	}
	for g := range marked {
		g.Dummy = false
		delete(marked, g)
	}
}

// MacroGrid is the atlas's macro node grid for the vibe explorer's terrain
// features: n x n nodes res metres apart, the ground height and water
// surface per node, the NODEP flags (NodeSea, NodeLake, NodeRiver) and the
// biome. ok=false when the atlas lacks the sections.
type MacroGrid struct {
	N      int
	Res    float64
	Height []float32
	Water  []float32
	Flags  []uint8
}

// Macro decodes the macro grid (allocates; call once).
func (a *AtlasInfo) Macro() (MacroGrid, bool) {
	n := a.biomeN
	if n < 2 || len(a.macroH) != 4*n*n || len(a.macroW) != 4*n*n || a.WorldSize <= 0 {
		return MacroGrid{}, false
	}
	f32 := func(b []byte, i int) float32 {
		return math.Float32frombits(uint32(b[4*i]) | uint32(b[4*i+1])<<8 | uint32(b[4*i+2])<<16 | uint32(b[4*i+3])<<24)
	}
	g := MacroGrid{N: n, Res: a.WorldSize / float64(n-1), Height: make([]float32, n*n), Water: make([]float32, n*n), Flags: make([]uint8, n*n)}
	for i := range g.Height {
		g.Height[i] = f32(a.macroH, i)
		g.Water[i] = f32(a.macroW, i)
		if len(a.nodep) == 4*n*n {
			g.Flags[i] = a.nodep[4*i+3]
		}
	}
	return g, true
}
