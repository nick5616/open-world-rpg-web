package worldhost

import (
	"hash/fnv"
	"math"

	"lodestone/server/pkg/movement"
)

// SpawnRadiusM scatters new characters around the atlas spawn so a crowd of
// first logins doesn't stack on one point. The atlas spawn is a meadow or
// forest settlement near the middle (worldgen/README.md, "Regions"), whose
// footprint (>= 45 m) is pre-flattened, so 8 m stays inside it.
const SpawnRadiusM = 8.0

// SpawnPoint returns where a character without a saved position starts: a
// dry point within SpawnRadiusM of the atlas spawn, picked by key (the
// character id) so the same character always gets the same point, with y on
// the ground. Generates the chunk synchronously if needed (~5 ms): call it
// from a connection goroutine, never a tick.
func (t *Terrain) SpawnPoint(key string) movement.Vec3 {
	h := fnv.New64a()
	h.Write([]byte(key))
	v := h.Sum64()
	sx, sz := float64(t.w.Header.SpawnX), float64(t.w.Header.SpawnZ)
	for try := 0; try < 24; try++ {
		v = splitmix(v)
		a := float64(v&0xffff) / 65536 * 2 * math.Pi
		// Later tries widen the circle in case the settlement sits on a
		// river bend.
		r := float64((v>>16)&0xffff) / 65536 * SpawnRadiusM * (1 + float64(try)/4)
		x, z := sx+r*math.Cos(a), sz+r*math.Sin(a)
		if p, ok := t.DryPoint(x, z); ok {
			return p
		}
	}
	x, z := sx, sz
	return movement.Vec3{X: x, Y: t.HeightAt(x, z), Z: z}
}

// DryPoint snaps (x, z) to the center of its 1 m cell and reports whether
// that cell is inside the world and above any water (all four lattice
// corners have ground >= water surface). The returned point has y on the
// ground. Generates the chunk synchronously if needed.
func (t *Terrain) DryPoint(x, z float64) (movement.Vec3, bool) {
	ws := float64(WorldChunks * ChunkSize)
	if !(x >= 1 && x < ws-1 && z >= 1 && z < ws-1) {
		return movement.Vec3{}, false
	}
	x, z = math.Floor(x)+0.5, math.Floor(z)+0.5
	if err := t.Ensure(x, z, 0); err != nil {
		return movement.Vec3{}, false
	}
	cx, cz, _ := chunkOf(x, z)
	c, ok := t.Chunk(cx, cz)
	if !ok {
		return movement.Vec3{}, false
	}
	i := int(math.Floor(x)) - int(cx)*ChunkSize
	j := int(math.Floor(z)) - int(cz)*ChunkSize
	for _, d := range [4][2]int{{0, 0}, {1, 0}, {0, 1}, {1, 1}} {
		k := (j+d[1])*ChunkSamples + i + d[0]
		if c.Water[k] > c.Heights[k] {
			return movement.Vec3{}, false
		}
	}
	return movement.Vec3{X: x, Y: c.Height(x, z), Z: z}, true
}

func splitmix(x uint64) uint64 {
	x += 0x9e3779b97f4a7c15
	x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9
	x = (x ^ (x >> 27)) * 0x94d049bb133111eb
	return x ^ (x >> 31)
}
