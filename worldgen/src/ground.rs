//! The ground: one pure function `height(x, z)` of the atlas, shared by the
//! chunk detail pass and the collision queries, so the server and the client
//! agree to the bit (spec 8: collision queries live in the wasm crate).
//!
//! height = macro (Catmull-Rom over the 32 m grid)
//!        + erosion-shaped detail noise (amplitude per node from the atlas)
//!        + ridges (highlands, snowpeak) and terraces (badlands mesas)
//!        then river channels and banks cut along the atlas river network.
//!
//! The playable surface is the triangle mesh over the 1 m lattice of
//! `height` rounded to f32; `collision_height` interpolates that mesh, with
//! every quad split along the diagonal from (x0+1, z0) to (x0, z0+1).

use crate::atlas::format::{flag, idx, Atlas, N, RES};
use crate::atlas::hydro::{downstream, NO_FLOW};
use crate::atlas::terrain::seed32;
use crate::gen::constants::{WORLD_MAX_Y, WORLD_MIN_Y};
use crate::noise::{eroded, noise, ridged, smoothstep};

/// Any river segment that can influence a sample has its upstream node within
/// this distance of the sample: reach (<= 39 m) + warp (< 7 m) + one diagonal
/// segment (45.3 m) = 91 m, rounded up.
const RIVER_WINDOW: f64 = 100.0;
const WARP_AMP: f64 = 9.0;

#[derive(Clone, Copy)]
pub struct RiverSeg {
    ax: f64,
    az: f64,
    bx: f64,
    bz: f64,
    ha: f64,
    hb: f64,
    half_w: f64,
    depth: f64,
    reach: f64,
    node: u32,
}

pub struct Ground<'a> {
    pub a: &'a Atlas<'a>,
    pub sea_y: f64,
    s_detail: u32,
    s_ridge: u32,
    s_micro: u32,
    s_warp: u32,
    rivers: Vec<RiverSeg>,
}

/// Per-point blend of the atlas node parameters.
pub struct NodeBlend {
    pub amp: f64,
    pub terrace: f64,
    pub ridge: f64,
    pub lake: f64,
    pub sea: f64,
    pub settlement: f64,
}

impl<'a> Ground<'a> {
    /// A ground evaluator valid for samples inside [x0, x1] x [z0, z1].
    pub fn new(a: &'a Atlas<'a>, x0: f64, z0: f64, x1: f64, z1: f64) -> Ground<'a> {
        let seed = a.seed;
        let mut rivers = Vec::new();
        let i0 = (libm::floor((x0 - RIVER_WINDOW) / RES) as i64).clamp(0, N as i64 - 1) as usize;
        let i1 = (libm::ceil((x1 + RIVER_WINDOW) / RES) as i64).clamp(0, N as i64 - 1) as usize;
        let j0 = (libm::floor((z0 - RIVER_WINDOW) / RES) as i64).clamp(0, N as i64 - 1) as usize;
        let j1 = (libm::ceil((z1 + RIVER_WINDOW) / RES) as i64).clamp(0, N as i64 - 1) as usize;
        for j in j0..=j1 {
            for i in i0..=i1 {
                let k = idx(i, j);
                let w = a.river(k);
                if w == 0 || a.flow(k) == NO_FLOW {
                    continue;
                }
                let Some(dk) = downstream(a.section(crate::atlas::format::sec::FLOW), k) else {
                    continue;
                };
                let width = w as f64;
                let ha = a.height(k);
                let hb = a.height(dk).max(a.water(dk));
                rivers.push(RiverSeg {
                    ax: i as f64 * RES,
                    az: j as f64 * RES,
                    bx: (dk % N) as f64 * RES,
                    bz: (dk / N) as f64 * RES,
                    ha,
                    hb,
                    half_w: width * 0.5,
                    depth: 0.8 + 0.12 * width,
                    reach: width * 0.5 + 6.0 + width,
                    node: k as u32,
                });
            }
        }
        Ground {
            a,
            sea_y: a.sea_y,
            s_detail: seed32(seed, 100),
            s_ridge: seed32(seed, 101),
            s_micro: seed32(seed, 102),
            s_warp: seed32(seed, 103),
            rivers,
        }
    }

    /// Catmull-Rom interpolation of the macro heightmap.
    #[inline]
    pub fn macro_h(&self, x: f64, z: f64) -> f64 {
        let u = x / RES;
        let v = z / RES;
        let uf = libm::floor(u);
        let vf = libm::floor(v);
        let fu = u - uf;
        let fv = v - vf;
        let iu = uf as i64;
        let iv = vf as i64;
        let wu = cr_weights(fu);
        let wv = cr_weights(fv);
        let mut sum = 0.0;
        for (b, &wvb) in wv.iter().enumerate() {
            let j = (iv - 1 + b as i64).clamp(0, N as i64 - 1) as usize;
            let mut row = 0.0;
            for (c, &wuc) in wu.iter().enumerate() {
                let i = (iu - 1 + c as i64).clamp(0, N as i64 - 1) as usize;
                row += wuc * self.a.height(idx(i, j));
            }
            sum += wvb * row;
        }
        sum
    }

    /// Bilinear blend of node params; flags become 0..1 weights.
    #[inline]
    pub fn blend(&self, x: f64, z: f64) -> NodeBlend {
        let (k00, k10, k01, k11, fu, fv) = cell(x, z);
        let w = [(1.0 - fu) * (1.0 - fv), fu * (1.0 - fv), (1.0 - fu) * fv, fu * fv];
        let mut nb = NodeBlend {
            amp: 0.0,
            terrace: 0.0,
            ridge: 0.0,
            lake: 0.0,
            sea: 0.0,
            settlement: 0.0,
        };
        for (n, k) in [k00, k10, k01, k11].into_iter().enumerate() {
            let p = self.a.nodep(k);
            let wn = w[n];
            nb.amp += wn * p[0] as f64 * 0.1;
            nb.terrace += wn * p[1] as f64 * (1.0 / 255.0);
            nb.ridge += wn * p[2] as f64 * (1.0 / 255.0);
            if p[3] & flag::LAKE != 0 {
                nb.lake += wn;
            }
            if p[3] & flag::SEA != 0 {
                nb.sea += wn;
            }
            if p[3] & flag::SETTLEMENT != 0 {
                nb.settlement += wn;
            }
        }
        nb
    }

    /// Any lake node within one node of the cell around (x, z)? (The lake
    /// warp is under 14 m, so a warped lookup never leaves this window.)
    #[inline]
    fn near_lake(&self, x: f64, z: f64) -> bool {
        let i = (libm::floor(x / RES) as i64).clamp(0, N as i64 - 2);
        let j = (libm::floor(z / RES) as i64).clamp(0, N as i64 - 2);
        for jj in (j - 1).max(0)..=(j + 2).min(N as i64 - 1) {
            for ii in (i - 1).max(0)..=(i + 2).min(N as i64 - 1) {
                if self.a.nodep(idx(ii as usize, jj as usize))[3] & flag::LAKE != 0 {
                    return true;
                }
            }
        }
        false
    }

    /// Lake mask (bilinear weight of lake nodes, 0..1) and lake level (the
    /// highest lake among the four nodes around the point).
    #[inline]
    fn lake_at(&self, x: f64, z: f64) -> (f64, f64) {
        let (k00, k10, k01, k11, fu, fv) = cell(x, z);
        let w = [(1.0 - fu) * (1.0 - fv), fu * (1.0 - fv), (1.0 - fu) * fv, fu * fv];
        let mut level = f64::NEG_INFINITY;
        let mut weight = 0.0;
        for (n, k) in [k00, k10, k01, k11].into_iter().enumerate() {
            if self.a.nodep(k)[3] & flag::LAKE != 0 {
                level = level.max(self.a.water(k));
                weight += w[n];
            }
        }
        (weight, level)
    }

    /// Ground height (f64, before the f32 rounding of the surface) and the
    /// water surface height at a point. Water is never NaN: where there is no
    /// lake or river it is sea level, which lies under dry land.
    pub fn sample(&self, x: f64, z: f64) -> (f64, f64) {
        let hm = self.macro_h(x, z);
        let nb = self.blend(x, z);
        let sea_y = self.sea_y;
        let amp = nb.amp * smoothstep(sea_y - 8.0, sea_y + 12.0, hm);
        let mut h = hm;
        if amp > 0.0 {
            h += amp * eroded(self.s_detail, x, z, 150.0, 6, 0.5);
            h += 0.12 * amp.min(3.0) * noise(self.s_micro, x / 2.7, z / 2.7);
            if nb.ridge > 0.0 {
                h += nb.ridge * amp * 1.3 * (ridged(self.s_ridge, x, z, 200.0, 3, 0.5) - 0.3);
            }
        }
        if nb.terrace > 0.004 {
            // Mesas: 9 m steps with steep risers (climbable cliffs, spec 8).
            let step = 9.0;
            let t = (h - sea_y) / step;
            let k = libm::floor(t);
            let f = smoothstep(0.25, 0.75, t - k);
            h += (sea_y + (k + f) * step - h) * nb.terrace;
        }
        let mut water = self.sea_y;
        if !self.rivers.is_empty() {
            // Warp the lookup point so D8 river polylines meander.
            let wx = x + WARP_AMP * noise(self.s_warp, x / 90.0, z / 90.0);
            let wz = z + WARP_AMP * noise(self.s_warp ^ 0x5bd1_e995, x / 90.0, z / 90.0);
            let mut best: Option<(f64, f64, usize)> = None;
            for (si, s) in self.rivers.iter().enumerate() {
                let (d, t) = seg_dist(wx, wz, s);
                if d > s.reach {
                    continue;
                }
                let better = match best {
                    None => true,
                    Some((bd, _, bi)) => d < bd || (d == bd && s.node < self.rivers[bi].node),
                };
                if better {
                    best = Some((d, t, si));
                }
            }
            if let Some((d, t, si)) = best {
                let s = &self.rivers[si];
                let ref_h = s.ha + (s.hb - s.ha) * t;
                let surface = ref_h - 0.25 * s.depth;
                if d < s.half_w {
                    let q = d / s.half_w;
                    h = ref_h - s.depth + 0.9 * s.depth * q * q;
                    water = water.max(surface);
                } else {
                    let wgt = 1.0 - smoothstep(s.half_w, s.reach, d);
                    let target = ref_h - 0.1 * s.depth + (d - s.half_w) * 0.12;
                    h += (target - h) * wgt;
                    if d < s.half_w + 1.5 {
                        water = water.max(surface);
                    }
                }
            }
        }
        if self.near_lake(x, z) {
            // Lakes go last so they override river banks. The shore follows a
            // warped bilinear lake mask (an organic contour, not the 32 m node
            // cells): ground ramps gently up to a low bank (level + 0.3 m) by
            // mask 0.3, then blends from bank to the natural lake bed by 0.75.
            // Water is only reported inside mask 0.15, so the filled flats
            // around a lake (just under its level) never show as flooded cells.
            let lx = x + 14.0 * noise(self.s_warp ^ 0x1b87_3593, x / 70.0, z / 70.0);
            let lz = z + 14.0 * noise(self.s_warp ^ 0xcc9e_2d51, x / 70.0, z / 70.0);
            let (lw, level) = self.lake_at(lx, lz);
            if lw > 0.0 {
                let depth = (level - hm).clamp(2.0, 12.0);
                let bank = h.max(level + 0.3);
                let h1 = h + (bank - h) * smoothstep(0.0, 0.3, lw);
                h = h1 + (level - depth - h1) * smoothstep(0.3, 0.75, lw);
                if lw > 0.15 {
                    water = water.max(level);
                }
            }
        }
        let h = h.clamp(WORLD_MIN_Y + 1.0, WORLD_MAX_Y - 1.0);
        debug_assert!(h.is_finite() && water.is_finite());
        (h, water)
    }

    /// The surface height at a lattice point, rounded to f32 as stored.
    #[inline]
    pub fn lattice(&self, x: f64, z: f64) -> f32 {
        self.sample(x, z).0 as f32
    }
}

#[inline]
fn cr_weights(f: f64) -> [f64; 4] {
    [
        ((-0.5 * f + 1.0) * f - 0.5) * f,
        (1.5 * f - 2.5) * f * f + 1.0,
        ((-1.5 * f + 2.0) * f + 0.5) * f,
        (0.5 * f - 0.5) * f * f,
    ]
}

/// The four nodes around (x, z) and the fractional position inside the cell.
#[inline]
fn cell(x: f64, z: f64) -> (usize, usize, usize, usize, f64, f64) {
    let u = (x / RES).clamp(0.0, (N - 1) as f64);
    let v = (z / RES).clamp(0.0, (N - 1) as f64);
    let i = (libm::floor(u) as usize).min(N - 2);
    let j = (libm::floor(v) as usize).min(N - 2);
    (idx(i, j), idx(i + 1, j), idx(i, j + 1), idx(i + 1, j + 1), u - i as f64, v - j as f64)
}

#[inline]
fn seg_dist(px: f64, pz: f64, s: &RiverSeg) -> (f64, f64) {
    let dx = s.bx - s.ax;
    let dz = s.bz - s.az;
    let l2 = dx * dx + dz * dz;
    let t = if l2 > 0.0 {
        (((px - s.ax) * dx + (pz - s.az) * dz) / l2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let qx = s.ax + dx * t - px;
    let qz = s.az + dz * t - pz;
    (libm::sqrt(qx * qx + qz * qz), t)
}

/// Interpolate the surface triangle mesh from the four corner heights of a
/// 1 m cell (fx, fz in [0, 1]). Exactly this expression, in this order, in
/// f64: hosts that reimplement it from chunk heights get identical bits.
#[inline]
pub fn tri_interp(h00: f64, h10: f64, h01: f64, h11: f64, fx: f64, fz: f64) -> f64 {
    if fx + fz <= 1.0 {
        h00 + (h10 - h00) * fx + (h01 - h00) * fz
    } else {
        h11 + (h01 - h11) * (1.0 - fx) + (h10 - h11) * (1.0 - fz)
    }
}

/// Upward unit normal of the surface triangle containing (fx, fz).
pub fn tri_normal(h00: f64, h10: f64, h01: f64, h11: f64, fx: f64, fz: f64) -> [f64; 3] {
    let (dx, dz) = if fx + fz <= 1.0 { (h10 - h00, h01 - h00) } else { (h11 - h01, h11 - h10) };
    let len = libm::sqrt(dx * dx + 1.0 + dz * dz);
    [-dx / len, 1.0 / len, -dz / len]
}

/// Ground height at any point (spec 5 `collision_height`): the surface mesh
/// over the 1 m lattice, identical to what chunk heights describe.
pub fn collision_height(a: &Atlas, x: f64, z: f64) -> f64 {
    let x0 = libm::floor(x);
    let z0 = libm::floor(z);
    let g = Ground::new(a, x0, z0, x0 + 1.0, z0 + 1.0);
    let h00 = g.lattice(x0, z0) as f64;
    let h10 = g.lattice(x0 + 1.0, z0) as f64;
    let h01 = g.lattice(x0, z0 + 1.0) as f64;
    let h11 = g.lattice(x0 + 1.0, z0 + 1.0) as f64;
    tri_interp(h00, h10, h01, h11, x - x0, z - z0)
}

/// Normal of the surface at a point, and its slope in degrees.
pub fn ground_normal(a: &Atlas, x: f64, z: f64) -> ([f64; 3], f64) {
    let x0 = libm::floor(x);
    let z0 = libm::floor(z);
    let g = Ground::new(a, x0, z0, x0 + 1.0, z0 + 1.0);
    let h00 = g.lattice(x0, z0) as f64;
    let h10 = g.lattice(x0 + 1.0, z0) as f64;
    let h01 = g.lattice(x0, z0 + 1.0) as f64;
    let h11 = g.lattice(x0 + 1.0, z0 + 1.0) as f64;
    let n = tri_normal(h00, h10, h01, h11, x - x0, z - z0);
    let slope = libm::acos(n[1].clamp(-1.0, 1.0)) * (180.0 / core::f64::consts::PI);
    (n, slope)
}

/// Longest ray `raycast` will march, in meters (cost is ~4 height samples per
/// 1 m cell crossed).
pub const RAY_MAX: f64 = 1024.0;

/// Ray against the surface mesh. Returns the distance along the normalized
/// direction to the first hit, or -1 when nothing is hit within `max_dist`.
#[allow(clippy::too_many_arguments)]
pub fn raycast(a: &Atlas, ox: f64, oy: f64, oz: f64, dx: f64, dy: f64, dz: f64, max_dist: f64) -> f64 {
    let len = libm::sqrt(dx * dx + dy * dy + dz * dz);
    if len == 0.0 || !len.is_finite() || !(ox.is_finite() && oy.is_finite() && oz.is_finite()) {
        return -1.0;
    }
    let (dx, dy, dz) = (dx / len, dy / len, dz / len);
    let max_d = max_dist.clamp(0.0, RAY_MAX);
    let ex = ox + dx * max_d;
    let ez = oz + dz * max_d;
    let g = Ground::new(a, ox.min(ex) - 1.0, oz.min(ez) - 1.0, ox.max(ex) + 1.0, oz.max(ez) + 1.0);
    // 2D DDA over 1 m cells.
    let mut ix = libm::floor(ox);
    let mut iz = libm::floor(oz);
    let step_x = if dx > 0.0 { 1.0 } else { -1.0 };
    let step_z = if dz > 0.0 { 1.0 } else { -1.0 };
    let t_dx = if dx != 0.0 { 1.0 / libm::fabs(dx) } else { f64::INFINITY };
    let t_dz = if dz != 0.0 { 1.0 / libm::fabs(dz) } else { f64::INFINITY };
    let mut t_mx = if dx > 0.0 {
        (ix + 1.0 - ox) * t_dx
    } else if dx < 0.0 {
        (ox - ix) * t_dx
    } else {
        f64::INFINITY
    };
    let mut t_mz = if dz > 0.0 {
        (iz + 1.0 - oz) * t_dz
    } else if dz < 0.0 {
        (oz - iz) * t_dz
    } else {
        f64::INFINITY
    };
    let mut t0 = 0.0;
    loop {
        let t1 = t_mx.min(t_mz).min(max_d);
        let h00 = g.lattice(ix, iz) as f64;
        let h10 = g.lattice(ix + 1.0, iz) as f64;
        let h01 = g.lattice(ix, iz + 1.0) as f64;
        let h11 = g.lattice(ix + 1.0, iz + 1.0) as f64;
        let p00 = [ix, h00, iz];
        let p10 = [ix + 1.0, h10, iz];
        let p01 = [ix, h01, iz + 1.0];
        let p11 = [ix + 1.0, h11, iz + 1.0];
        let o = [ox, oy, oz];
        let d = [dx, dy, dz];
        let mut hit = f64::INFINITY;
        for tri in [[p00, p10, p01], [p11, p01, p10]] {
            if let Some(t) = ray_tri(o, d, tri) {
                if t >= t0 - 1e-9 && t <= t1 + 1e-9 && t < hit {
                    hit = t;
                }
            }
        }
        if hit.is_finite() {
            return hit.max(0.0);
        }
        if t1 >= max_d {
            return -1.0;
        }
        t0 = t1;
        if t_mx < t_mz {
            ix += step_x;
            t_mx += t_dx;
        } else {
            iz += step_z;
            t_mz += t_dz;
        }
    }
}

/// Moller-Trumbore, two-sided.
fn ray_tri(o: [f64; 3], d: [f64; 3], t: [[f64; 3]; 3]) -> Option<f64> {
    let e1 = sub(t[1], t[0]);
    let e2 = sub(t[2], t[0]);
    let p = cross(d, e2);
    let det = dot(e1, p);
    if libm::fabs(det) < 1e-12 {
        return None;
    }
    let inv = 1.0 / det;
    let s = sub(o, t[0]);
    let u = dot(s, p) * inv;
    if !(0.0..=1.0).contains(&u) {
        return None;
    }
    let q = cross(s, e1);
    let v = dot(d, q) * inv;
    if v < 0.0 || u + v > 1.0 {
        return None;
    }
    let tt = dot(e2, q) * inv;
    if tt >= 0.0 {
        Some(tt)
    } else {
        None
    }
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
