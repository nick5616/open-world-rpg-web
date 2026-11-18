package vertical

// The collision core: the Go twin of VerticalGroundCore in
// worldgen/js/src/vertical.ts (README "Vertical world: collision and ground
// dispatch"). f64, same operation order, explicit conversions around
// products so no FMA is fused (Go spec "Floating-point operators").

import (
	"math"

	"lodestone/server/pkg/movement"
)

// Dispatch constants (TS: VC).
const (
	SkyLedge  = 3.0
	BodyH     = 1.8
	Below     = 0.5
	Above     = 1.0
	Ext       = 40.0
	Under     = 2.0
	Radius    = 0.4
	SolidEps  = 0.01
	OpenHalf  = 5000.0
	PushStep  = 0.5
	PushSteps = 24
	ShaftBand = 2.5
	// Bedrock is the bottom of the world (playtest 5): under the Depths'
	// deepest floor (about -455 m) and its Ext snap band. The ground is never
	// lower, so a fall no layer or cave catches ends here instead of going on
	// for ever. TS: VC.bedrock.
	Bedrock = -500.0
)

// Source is the collision value of a surface at (x, z): the wasm
// layer_height, or the same bits from LOD 0 tiles.
type Source interface {
	LayerHeight(surf int, x, z float64) float64
}

// TriInterp is the triangle mesh over a 1 m f32 lattice (worldgen
// ground::tri_interp, same order).
func TriInterp(h00, h10, h01, h11, fx, fz float64) float64 {
	if fx+fz <= 1 {
		return h00 + float64((h10-h00)*fx) + float64((h01-h00)*fz)
	}
	return h11 + float64((h01-h11)*(1-fx)) + float64((h10-h11)*(1-fz))
}

// TileValue is the collision value of surf at (x, z) from a LOD 0 tile
// holding it (cx, cz = floor(floor(x)/64), floor(floor(z)/64)).
func TileValue(t *Tile, surf int, x, z float64) float64 {
	arr := t.A
	switch surf % 3 {
	case 1:
		arr = t.B
	case 2:
		arr = t.W
	}
	x0 := math.Floor(x)
	z0 := math.Floor(z)
	i := int(x0) - t.Cx*64
	j := int(z0) - t.Cz*64
	return TriInterp(float64(arr[j*TileS+i]), float64(arr[j*TileS+i+1]), float64(arr[(j+1)*TileS+i]), float64(arr[(j+1)*TileS+i+1]), x-x0, z-z0)
}

// SurfLayer is the layer a surface belongs to.
func SurfLayer(surf int) int {
	switch {
	case surf >= 6:
		return LayerSky
	case surf >= 3:
		return LayerDepths
	}
	return LayerUnder
}

func masked(openings []Opening, x, z float64) bool {
	x0 := math.Floor(x)
	z0 := math.Floor(z)
	var cx, cz float64
	if (x-x0)+(z-z0) <= 1 {
		cx, cz = x0+1.0/3.0, z0+1.0/3.0
	} else {
		cx, cz = x0+2.0/3.0, z0+2.0/3.0
	}
	for i := range openings {
		o := &openings[i]
		dx := cx - o.X
		dz := cz - o.Z
		if float64(dx*dx)+float64(dz*dz) < float64(o.R*o.R) {
			return true
		}
	}
	return false
}

// SurfaceMasked: is the terrain triangle under (x, z) a hole (tunnel mouth, cenote)?
func (w *World) SurfaceMasked(x, z float64) bool {
	return len(w.SurfaceOpenings) > 0 && masked(w.SurfaceOpenings, x, z)
}

// Ground is the movement ground with the vertical world over and under
// Base (terrain, structures, caves). See the TS class for the rules.
type Ground struct {
	Base movement.Ground
	W    *World
	Src  Source
}

// HeightAt is the base surface (non-step callers).
func (g *Ground) HeightAt(x, z float64) float64 { return g.Base.HeightAt(x, z) }

// WaterAt is the base surface water.
func (g *Ground) WaterAt(x, z float64) float64 { return movement.WaterAt(g.Base, x, z) }

// Resolve returns the layer a point at feet height y stands in (0 base,
// 1 sky island, 2 Underground, 3 Depths) and its floor (unset for 0).
func (g *Ground) Resolve(x, y, z float64) (int, float64) {
	w, s := g.W, g.Src
	if w.InDomain(LayerSky, x, z) {
		t := s.LayerHeight(SurfSkyTop, x, z)
		b := s.LayerHeight(SurfSkyBottom, x, z)
		if t-b > SolidEps {
			if y >= t-SkyLedge {
				return LayerSky, t
			}
			if y+BodyH > b {
				return LayerSky, y
			}
		}
	}
	isMasked := len(w.SurfaceOpenings) > 0 && masked(w.SurfaceOpenings, x, z)
	if isMasked || y < g.Base.HeightAt(x, z)-Under {
		gate := len(w.GateOpenings) > 0 && masked(w.GateOpenings, x, z)
		uOK := !gate && w.InDomain(LayerUnder, x, z)
		dOK := w.InDomain(LayerDepths, x, z)
		var uf, df float64
		if uOK {
			uf = s.LayerHeight(SurfUFloor, x, z)
			uc := s.LayerHeight(SurfUCeil, x, z)
			top := uf
			if uc > uf {
				top = uc
			}
			if y >= uf-Below && y <= top+Above {
				return LayerUnder, uf
			}
		}
		if dOK {
			df = s.LayerHeight(SurfDFloor, x, z)
			dc := s.LayerHeight(SurfDCeil, x, z)
			top := df
			if dc > df {
				top = dc
			}
			if y >= df-Below && y <= top+Above {
				return LayerDepths, df
			}
		}
		gu, gd := math.Inf(1), math.Inf(1)
		if uOK && y < uf-Below && y >= uf-Ext {
			gu = uf - y
		}
		if dOK && y < df-Below && y >= df-Ext {
			gd = df - y
		}
		if !math.IsInf(gu, 1) && gu <= gd {
			return LayerUnder, uf
		}
		if !math.IsInf(gd, 1) {
			return LayerDepths, df
		}
	}
	return LayerSurface, 0
}

// LayerAt is the layer of a point (gameplay: light, difficulty, interest).
func (g *Ground) LayerAt(x, y, z float64) int {
	l, _ := g.Resolve(x, y, z)
	return l
}

func (g *Ground) baseLevel(y float64) movement.Ground { return movement.AtLevel(g.Base, y) }

// FloorAt is the ground under feet height y at (x, z).
func (g *Ground) FloorAt(x, y, z float64) float64 {
	if l, f := g.Resolve(x, y, z); l != LayerSurface {
		return f
	}
	if h := g.baseLevel(y).HeightAt(x, z); h >= Bedrock {
		return h
	}
	return Bedrock
}

// WaterAtLevel is the water (or lava) for feet at y: the layer's underground,
// none on an island, else the base level view's.
func (g *Ground) WaterAtLevel(x, y, z float64) float64 {
	switch l, _ := g.Resolve(x, y, z); l {
	case LayerUnder:
		return g.Src.LayerHeight(SurfUWater, x, z)
	case LayerDepths:
		return g.Src.LayerHeight(SurfDLava, x, z)
	case LayerSky:
		return math.Inf(-1)
	}
	return movement.WaterAt(g.baseLevel(y), x, z)
}

// AtLevel implements movement.LevelGround.
func (g *Ground) AtLevel(y float64) movement.Ground { return Level{G: g, Y: y, base: g.baseLevel(y)} }

// Level is Ground viewed at feet height Y (one movement step).
type Level struct {
	G    *Ground
	Y    float64
	base movement.Ground
}

func (l Level) HeightAt(x, z float64) float64 { return l.G.FloorAt(x, l.Y, z) }
func (l Level) WaterAt(x, z float64) float64  { return l.G.WaterAtLevel(x, l.Y, z) }
func (l Level) Collide(x, y, z float64) movement.CollideResult {
	return l.G.collide(x, y, z, l.base)
}

// Collide is the push-out with the base's at the feet level.
func (g *Ground) Collide(x, y, z float64) movement.CollideResult {
	return g.collide(x, y, z, g.baseLevel(y))
}

// collide: base push-out (bv's, else the base's), then island sides and
// undersides, layer ceilings, columns and shaft walls.
func (g *Ground) collide(x0, y0, z0 float64, bv movement.Ground) movement.CollideResult {
	x, y, z := x0, y0, z0
	var px, pz float64
	ceil := false
	var bc movement.Collider
	if c, ok := bv.(movement.Collider); ok {
		bc = c
	} else if c, ok := g.Base.(movement.Collider); ok {
		bc = c
	}
	if bc != nil {
		r := bc.Collide(x0, y0, z0)
		x, y, z, px, pz, ceil = r.X, r.Y, r.Z, r.PushX, r.PushZ, r.Ceiling
	}
	s := g.Src
	l, _ := g.Resolve(x, y, z)
	if l == LayerSky {
		t := s.LayerHeight(SurfSkyTop, x, z)
		b := s.LayerHeight(SurfSkyBottom, x, z)
		if t-b > SolidEps && y < t-SkyLedge && y+BodyH > b {
			if y < b {
				y = b - BodyH
				ceil = true
			} else if isl := g.W.IslandAt(x, z); isl != nil {
				dx := x - isl.X
				dz := z - isl.Z
				d := math.Sqrt(float64(dx*dx) + float64(dz*dz))
				if d > 1e-9 {
					dx = dx / d
					dz = dz / d
				} else {
					dx, dz = 1, 0
				}
				for k := 1; k <= PushSteps; k++ {
					qx := x + float64(dx*(PushStep*float64(k)))
					qz := z + float64(dz*(PushStep*float64(k)))
					if s.LayerHeight(SurfSkyTop, qx, qz)-s.LayerHeight(SurfSkyBottom, qx, qz) <= SolidEps {
						mx := dx * (PushStep*float64(k) + Radius)
						mz := dz * (PushStep*float64(k) + Radius)
						x = x + mx
						z = z + mz
						px = px + mx
						pz = pz + mz
						break
					}
				}
			}
		}
	} else if l == LayerUnder || l == LayerDepths {
		cs, fs := SurfUCeil, SurfUFloor
		if l == LayerDepths {
			cs, fs = SurfDCeil, SurfDFloor
		}
		c := s.LayerHeight(cs, x, z)
		f := s.LayerHeight(fs, x, z)
		if c < OpenHalf && c > f && y+BodyH > c && y < c {
			y = c - BodyH
			ceil = true
		}
		for i := range g.W.Columns {
			col := &g.W.Columns[i]
			if col.Layer != l || y+BodyH <= col.Y0 || y >= col.Y1 {
				continue
			}
			dx := x - col.X
			dz := z - col.Z
			rr := col.R + Radius
			d2 := float64(dx*dx) + float64(dz*dz)
			if d2 >= float64(rr*rr) {
				continue
			}
			d := math.Sqrt(d2)
			if d > 1e-9 {
				dx = dx / d
				dz = dz / d
			} else {
				dx, dz = 1, 0
			}
			m := rr - d
			x = x + float64(dx*m)
			z = z + float64(dz*m)
			px = px + float64(dx*m)
			pz = pz + float64(dz*m)
		}
	}
	for i := range g.W.Shafts {
		sh := &g.W.Shafts[i]
		dx := x - sh.X
		dz := z - sh.Z
		d := math.Sqrt(float64(dx*dx) + float64(dz*dz))
		inner := sh.R - Radius
		if d <= inner || d >= sh.R+ShaftBand {
			continue
		}
		if y >= g.Base.HeightAt(x, z)-Under {
			continue
		}
		if y+1 <= s.LayerHeight(SurfUCeil, x, z) {
			continue
		}
		dx = dx / d
		dz = dz / d
		m := d - inner
		x = x - float64(dx*m)
		z = z - float64(dz*m)
		px = px - float64(dx*m)
		pz = pz - float64(dz*m)
	}
	return movement.CollideResult{X: x, Y: y, Z: z, PushX: px, PushZ: pz, Ceiling: ceil}
}

// IslandAt is the island whose reach covers (x, z) most deeply, or nil.
func (w *World) IslandAt(x, z float64) *Island {
	var best *Island
	bestM := math.Inf(1)
	for i := range w.Islands {
		is := &w.Islands[i]
		dx := x - is.X
		dz := z - is.Z
		m := math.Sqrt(float64(dx*dx)+float64(dz*dz)) - is.Reach
		if m < 4 && m < bestM {
			bestM = m
			best = is
		}
	}
	return best
}

// Updrafts is the vertical world's wind columns as the movement step's
// UpdraftField (TS: VerticalUpdrafts).
type Updrafts []Updraft

// LiftAt implements movement.UpdraftField.
func (u Updrafts) LiftAt(x, y, z float64) float64 {
	best := 0.0
	for i := range u {
		c := &u[i]
		if y > c.Top || y < c.Bottom {
			continue
		}
		dx := x - c.X
		dz := z - c.Z
		if float64(dx*dx)+float64(dz*dz) <= float64(c.R*c.R) && c.Lift > best {
			best = c.Lift
		}
	}
	return best
}

// InSkyBand: is (x, y, z) in the sky over an archipelago (above its clouds)?
func (w *World) InSkyBand(x, y, z float64) bool {
	for i := range w.Archs {
		a := &w.Archs[i]
		if y < a.CloudY-60 {
			continue
		}
		dx := x - a.X
		dz := z - a.Z
		r := a.R + 220
		if float64(dx*dx)+float64(dz*dz) <= float64(r*r) {
			return true
		}
	}
	return false
}

// ChamberAt is the chamber of a layer whose padded ellipse contains (x, z), or nil.
func (w *World) ChamberAt(layer int, x, z, pad float64) *Chamber {
	for i := range w.Chambers {
		c := &w.Chambers[i]
		if c.Layer != layer {
			continue
		}
		dx := x - c.X
		dz := z - c.Z
		u := float64(dx*c.C) + float64(dz*c.S)
		v := -float64(dx*c.S) + float64(dz*c.C)
		if float64((u/c.Rx)*(u/c.Rx))+float64((v/c.Rz)*(v/c.Rz)) <= pad*pad {
			return c
		}
	}
	return nil
}

// Wind is the vertical world's whole effect on gliders (the zone's updraft
// field): its wind columns' lift (Updrafts) and free gliding in the sky
// over an archipelago (movement.FreeGlider). TS: client/src/sim/verticalWind.ts.
type Wind struct{ W *World }

// LiftAt implements movement.UpdraftField.
func (w Wind) LiftAt(x, y, z float64) float64 { return Updrafts(w.W.Updrafts).LiftAt(x, y, z) }

// FreeGlideAt implements movement.FreeGlider: the sky band over an archipelago.
func (w Wind) FreeGlideAt(x, y, z float64) bool { return w.W.InSkyBand(x, y, z) }
