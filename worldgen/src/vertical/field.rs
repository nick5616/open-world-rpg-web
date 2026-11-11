//! Lattice values of the vertical layers (README "Vertical world").
//!
//! `under_at` / `sky_at` give the f64 value of every surface at a point;
//! the lattice stores them rounded to f32 at integer points, and every host
//! collides with the triangle mesh over that lattice (`ground::tri_interp`),
//! exactly like the terrain. Tiles and `layer_height` are the only callers
//! that round; nothing here depends on evaluation order beyond the fixed
//! order of the grid lists (smooth unions are not associative in f64).
//!
//! Underground / Depths at a point: every feature (chamber, corridor) whose
//! influence covers it gives a floor F_f, a roof C_f and water W_f. The floor
//! is the smooth minimum of every F_f (walls rise from any feature, corridors
//! carve shelves into chamber walls); the ceiling is the smooth maximum of
//! the roofs of features that are open there; no open feature = rock
//! (C = F). Openings then override: inside a tunnel mouth the floor is capped
//! by the terrain and the roof is open sky; near one the roof stays 3 m
//! under the terrain; a cenote shaft opens the roof; a Depths gate opens the
//! Depths into the Underground chamber above it.

use super::under::{WALL_E0, WALL_E1, WALL_EXTRA, WALL_POW};
use super::*;
use crate::cave::field::smin;
use crate::noise::{fbm, noise, ridged, smoothstep};

/// Values of one layer at a point: a = floor / island top, b = ceiling /
/// island bottom, w = water or lava surface (NO_WATER = none).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct S3 {
    pub a: f64,
    pub b: f64,
    pub w: f64,
}

/// Blend widths of the unions (m).
const K_FLOOR: f64 = 8.0;
const K_ROOF: f64 = 10.0;
/// A chamber counts as open where its roof clears its floor by this much.
const OPEN_GAP: f64 = 8.0;
/// Margin around an opening's radius where lattice points take the opening's
/// values (a masked triangle's corners lie within r + 0.95 m).
pub const OPEN_MARGIN: f64 = 1.5;
/// How far from a tunnel mouth the roof is kept under the terrain.
const MOUTH_CAP: f64 = 48.0;
/// Value of a point no feature reaches (rock).
const ROCK_U: f64 = 0.0;
const ROCK_D: f64 = -360.0;

#[inline]
fn smax(a: f64, b: f64, k: f64) -> f64 {
    -smin(-a, -b, k)
}

/// Influence half-width of a corridor around its polyline.
pub fn corridor_reach(r: &Corridor) -> f64 {
    r.hw * 2.8 + 6.0
}

/// (F, C, W, open) of a chamber at (x, z), None outside its influence.
fn chamber_at(c: &Chamber, x: f64, z: f64) -> Option<(f64, f64, f64, bool)> {
    let (dx, dz) = (x - c.x, z - c.z);
    if dx * dx + dz * dz > c.reach * c.reach {
        return None;
    }
    let u = dx * c.c + dz * c.s;
    let v = -dx * c.s + dz * c.c;
    let e0 = libm::sqrt((u / c.rx) * (u / c.rx) + (v / c.rz) * (v / c.rz));
    if e0 > 1.2 {
        return None;
    }
    let sd = c.seed;
    let e = e0 * (1.0 + 0.04 * noise(sd, x / 38.0, z / 38.0));
    let sw = smoothstep(WALL_E0, WALL_E1, e);
    let wall = (c.height + WALL_EXTRA) * libm::pow(sw, WALL_POW) + 3.0 * sw * noise(sd ^ 5, x / 9.0, z / 9.0);
    let ground = 1.6 * fbm(sd ^ 1, x, z, 34.0, 3, 0.5);
    let mut f = c.floor + ground * (1.0 - sw) + wall;
    if c.lake_e > 0.0 {
        f -= c.lake_depth * (1.0 - smoothstep(0.0, c.lake_e, e));
    }
    let drip = 5.0 * (ridged(sd ^ 2, x, z, 22.0, 2, 0.5) - 0.45).max(0.0) + 2.5 * fbm(sd ^ 3, x, z, 50.0, 2, 0.5);
    let roof = c.floor + c.height * (1.0 - 0.28 * e * e) - drip;
    let w = if c.lake_e > 0.0 && e < c.lake_e + 0.3 { c.lake } else { NO_WATER };
    Some((f, roof, w, roof > f + OPEN_GAP))
}

/// (F, C, W, open) of a corridor at (x, z), None outside its influence.
fn corridor_at(r: &Corridor, x: f64, z: f64) -> Option<(f64, f64, f64, bool)> {
    let reach = corridor_reach(r);
    let mut best = (f64::MAX, 0usize, 0.0);
    for k in 0..r.pts.len().saturating_sub(1) {
        let (a, b) = (r.pts[k], r.pts[k + 1]);
        let (ex, ez) = (b[0] - a[0], b[2] - a[2]);
        let l2 = ex * ex + ez * ez;
        let t = if l2 > 0.0 { (((x - a[0]) * ex + (z - a[2]) * ez) / l2).clamp(0.0, 1.0) } else { 0.0 };
        let (qx, qz) = (a[0] + ex * t - x, a[2] + ez * t - z);
        let d = qx * qx + qz * qz;
        if d < best.0 {
            best = (d, k, t);
        }
    }
    let d = libm::sqrt(best.0);
    if d > reach {
        return None;
    }
    let (a, b) = (r.pts[best.1], r.pts[best.1 + 1]);
    let fy = a[1] + (b[1] - a[1]) * best.2;
    let q = d / r.hw;
    let floor = fy + 0.5 * noise(0x51 ^ (best.1 as u32), x / 7.0, z / 7.0) * (1.0 - smoothstep(0.0, 0.6, q)).max(0.3);
    let mut f = floor + (r.height + 18.0) * libm::pow(smoothstep(0.62, 1.25, q), 1.3);
    if r.water > 0.0 {
        f -= r.water * (1.0 - smoothstep(0.0, 0.62, q));
    }
    let roof = fy + r.height * libm::sqrt((1.0 - 0.85 * q * q).max(0.0));
    let w = if r.water > 0.0 && q < 0.75 { fy - 0.25 } else { NO_WATER };
    Some((f, roof, w, roof > f + 1.0))
}

/// Underground (layer 2) or Depths (layer 3) values at (x, z). `terrain`
/// returns the terrain lattice value (f32 rounded, as f64) at an integer
/// point; it is only called near tunnel mouths.
pub fn under_at(p: &Plan, layer: u8, x: f64, z: f64, terrain: &mut dyn FnMut(f64, f64) -> f64) -> S3 {
    let (cx, cz) = (libm::floor(x / 64.0) as i64, libm::floor(z / 64.0) as i64);
    let mut f: Option<f64> = None;
    let mut c: Option<f64> = None;
    let mut w = NO_WATER;
    for &r in p.refs(layer, cx, cz) {
        let v = if r & CHAMBER_REF != 0 { chamber_at(&p.chambers[(r & !CHAMBER_REF) as usize], x, z) } else { corridor_at(&p.corridors[r as usize], x, z) };
        let Some((ff, cc, ww, open)) = v else { continue };
        f = Some(match f {
            None => ff,
            Some(v) => smin(v, ff, K_FLOOR),
        });
        if open {
            c = Some(match c {
                None => cc,
                Some(v) => smax(v, cc, K_ROOF),
            });
        }
        if ww > w {
            w = ww;
        }
    }
    let rock = if layer == LAYER_UNDER { ROCK_U } else { ROCK_D };
    let mut fa = f.unwrap_or(rock);
    let mut cb = c.unwrap_or(fa);
    for o in &p.openings {
        if o.into != layer {
            continue;
        }
        let d2 = (x - o.x) * (x - o.x) + (z - o.z) * (z - o.z);
        let inner = o.r + OPEN_MARGIN;
        match o.kind {
            ok::TUNNEL => {
                if d2 < inner * inner {
                    fa = fa.min(terrain(x, z));
                    cb = OPEN_C;
                } else if d2 < (o.r + MOUTH_CAP) * (o.r + MOUTH_CAP) {
                    cb = cb.min(terrain(x, z) - 3.0);
                }
            }
            ok::CENOTE => {
                if d2 < inner * inner {
                    cb = OPEN_C;
                }
            }
            _ => {
                // A Depths gate: the Depths open into the Underground chamber above.
                if d2 < (o.r + 40.0) * (o.r + 40.0) {
                    let u = under_at(p, LAYER_UNDER, x, z, terrain);
                    if d2 < inner * inner {
                        fa = fa.min(u.a);
                        cb = cb.max(u.b);
                    } else {
                        cb = cb.min(u.a - 6.0);
                    }
                }
            }
        }
    }
    if cb < fa + 0.25 {
        cb = fa;
    }
    S3 { a: fa, b: cb, w }
}

/// Signed distance-like value of an island's lobed outline (> 0 inside, m).
pub fn island_sd(isl: &Island, x: f64, z: f64) -> f64 {
    let wx = x + 5.0 * noise(isl.seed, x / 32.0, z / 32.0);
    let wz = z + 5.0 * noise(isl.seed ^ 7, x / 32.0, z / 32.0);
    let mut sd = f64::MIN;
    for l in &isl.lobes {
        let (dx, dz) = (wx - (isl.x + l[0]), wz - (isl.z + l[1]));
        sd = sd.max(l[2] - libm::sqrt(dx * dx + dz * dz));
    }
    sd
}

/// Top height of island `isl` at an inside point (the sky towns' ground).
pub fn island_top(isl: &Island, x: f64, z: f64, sd: f64) -> f64 {
    let s = isl.seed;
    let mut relief = isl.amp * fbm(s ^ 1, x, z, 64.0, 3, 0.5);
    if isl.kind == ik::CRAG {
        relief += isl.amp * 0.8 * ridged(s ^ 4, x, z, 40.0, 3, 0.5);
    }
    let rim = 3.0 * (1.0 - smoothstep(0.0, 5.0, sd));
    isl.top + relief - rim
}

/// Sky values at (x, z): a = island top, b = island bottom (a > b inside an
/// island; a = b elsewhere).
pub fn sky_at(p: &Plan, x: f64, z: f64) -> S3 {
    let (cx, cz) = (libm::floor(x / 64.0) as i64, libm::floor(z / 64.0) as i64);
    for &r in p.refs(LAYER_SKY, cx, cz) {
        let isl = &p.islands[r as usize];
        let (dx, dz) = (x - isl.x, z - isl.z);
        if dx * dx + dz * dz > (isl.reach + 4.0) * (isl.reach + 4.0) {
            continue;
        }
        let sd = island_sd(isl, x, z);
        if sd <= -3.0 {
            continue;
        }
        if sd <= 0.0 {
            let meet = isl.top - 3.0 - 0.5 * isl.cliff;
            return S3 { a: meet, b: meet, w: NO_WATER };
        }
        let s = isl.seed;
        let t = island_top(isl, x, z, sd);
        let depth = isl.thick * libm::pow((sd / (isl.r * 0.95)).clamp(0.0, 1.0), 0.6) * (0.78 + 0.35 * fbm(s ^ 2, x, z, 45.0, 3, 0.5));
        let spikes = 9.0 * (ridged(s ^ 3, x, z, 14.0, 2, 0.5) - 0.55).max(0.0) * smoothstep(2.0, 12.0, sd);
        let b = (isl.top - isl.cliff - depth - spikes).min(t - 3.0);
        return S3 { a: t, b, w: NO_WATER };
    }
    S3 { a: 0.0, b: 0.0, w: NO_WATER }
}

/// The f32 lattice value of surface `surf` (0..8: U floor, U ceiling,
/// U water, D floor, D ceiling, D lava, sky top, sky bottom, sky water) at
/// an integer point.
pub fn lattice(p: &Plan, surf: u32, x: f64, z: f64, terrain: &mut dyn FnMut(f64, f64) -> f64) -> f32 {
    let s = match surf / 3 {
        0 => under_at(p, LAYER_UNDER, x, z, terrain),
        1 => under_at(p, LAYER_DEPTHS, x, z, terrain),
        _ => sky_at(p, x, z),
    };
    (match surf % 3 {
        0 => s.a,
        1 => s.b,
        _ => s.w,
    }) as f32
}
