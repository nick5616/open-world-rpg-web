package structures

import "lodestone/server/pkg/movement"

// Tower geometry (WP12, spec 8 "Towers: climb to the top to reveal the
// region's map"). Every constant here has a twin in
// client/src/world/structures/towers.ts; the golden test catches drift.
//
// The shape is a stepped stone tower: a 4 m flat top, an upper wall 13 m
// tall, a 1.4 m ledge to rest on, then the lower wall down to the terrain.
// Walls are 80 degrees: inside WP10's 50-89 degree climbing band with margin
// on both sides (a 90 degree wall is not a function of x, z; anything under
// ~70 looks like a ramp, not a tower). The ledge splits a ~28 m climb into
// two, because at spec 8's 2 m/s a single 28 m wall would be 14 s on the
// stamina wheel.
const (
	// TowerWallSlope is tan(80 deg) written out as a literal: both languages
	// must start from the same bits and neither may call tan at runtime
	// (host math differs in the last ulp; spec 5 rule 2's spirit).
	TowerWallSlope = 5.671281819617709
	// TowerTopRadius is the flat top's radius, m (where the map reveal and
	// the fast-travel arrival point are).
	TowerTopRadius = 4.0
	// TowerUpperDrop is the upper wall's height, m; the ledge sits there.
	TowerUpperDrop = 13.0
	// TowerLedgeWidth is the rest ledge's width, m.
	TowerLedgeWidth = 1.4
	// TowerHeight is the top's height above the highest ground sampled
	// under the platform and ledge, m. The atlas viewshed assumed a 30 m
	// tower (site visHeight); 28 m above the highest point of the base keeps
	// the top at or above that over the uneven peaks towers stand on.
	TowerHeight = 28.0
	// towerSkirt is how far below the lowest ground near the tower the lower
	// wall is extended, m, so it disappears into the terrain on every side.
	towerSkirt = 3.0
)

// Unit vectors for the 8 and 16 sample directions, as literals (no cos/sin
// at runtime, same reason as TowerWallSlope).
const s2 = 0.7071067811865476 // sqrt(1/2)

var dirs8 = [8][2]float64{{1, 0}, {s2, s2}, {0, 1}, {-s2, s2}, {-1, 0}, {-s2, -s2}, {0, -1}, {s2, -s2}}

var dirs16 = [16][2]float64{
	{1, 0}, {0.9238795325112867, 0.3826834323650898}, {s2, s2}, {0.3826834323650898, 0.9238795325112867},
	{0, 1}, {-0.3826834323650898, 0.9238795325112867}, {-s2, s2}, {-0.9238795325112867, 0.3826834323650898},
	{-1, 0}, {-0.9238795325112867, -0.3826834323650898}, {-s2, -s2}, {-0.3826834323650898, -0.9238795325112867},
	{0, -1}, {0.3826834323650898, -0.9238795325112867}, {s2, -s2}, {0.9238795325112867, -0.3826834323650898},
}

// TowerProfile returns the breakpoints shared by every tower: radii and
// drops below the top.
func TowerProfile() (r, drop []float64) {
	// Variables, not one constant expression: Go evaluates constant
	// arithmetic exactly at compile time, which rounded r1 one ulp away from
	// the IEEE division the TS twin does at runtime (the golden test caught it).
	top, upper, slope, ledge := float64(TowerTopRadius), float64(TowerUpperDrop), float64(TowerWallSlope), float64(TowerLedgeWidth)
	r1 := top + upper/slope
	return []float64{top, r1, r1 + ledge}, []float64{0, upper, upper}
}

// NewTower builds the tower standing at (cx, cz) on base: the top is
// TowerHeight above the highest ground under the platform and ledge, the
// lower wall reaches towerSkirt below the lowest ground within 6 m of the
// ledge. base must be the plain terrain (not an overlay), and the same
// terrain the other host uses, so both derive the same TopY and MaxR.
func NewTower(base movement.Ground, cx, cz float64) *Radial {
	r, drop := TowerProfile()
	rl := r[len(r)-1]
	hi := base.HeightAt(cx, cz)
	for _, d := range dirs8 {
		if h := base.HeightAt(cx+float64(d[0]*rl), cz+float64(d[1]*rl)); h > hi {
			hi = h
		}
	}
	lo := base.HeightAt(cx, cz)
	ro := rl + 6
	for _, d := range dirs16 {
		if h := base.HeightAt(cx+float64(d[0]*ro), cz+float64(d[1]*ro)); h < lo {
			lo = h
		}
	}
	top := hi + TowerHeight
	bottom := lo - towerSkirt
	// Radius where the lower wall reaches bottom.
	maxR := rl + (top-TowerUpperDrop-bottom)/TowerWallSlope
	return NewRadial(cx, cz, top, r, drop, TowerWallSlope, maxR)
}

// TowerBottom is the height where the tower's lower wall ends (its MaxR):
// renderers extend the mesh down to here.
func TowerBottom(t *Radial) float64 {
	d, _ := t.dropAt(t.MaxR)
	return t.TopY - d
}
