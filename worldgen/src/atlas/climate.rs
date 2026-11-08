//! Climate and biomes (spec 5): temperature from altitude, a north-south
//! gradient and the spec bias; moisture from distance to water and the
//! prevailing wind with rain shadows; biome = weighted lookup on
//! (temperature, moisture, altitude, slope).

use super::format::{idx, N, NN, RES, WORLD};
use super::terrain::seed32;
use super::World;
use crate::noise::{clamp01, fbm, smoothstep};
use crate::spec::biome_weight_array;

pub const MEADOW: u8 = 0;
pub const FOREST: u8 = 1;
pub const HIGHLANDS: u8 = 2;
pub const SNOWPEAK: u8 = 3;
pub const BADLANDS: u8 = 4;
pub const WETLAND: u8 = 5;

/// Two-pass chamfer distance transform (meters) from source nodes.
pub fn distance_from(src: &[bool]) -> Vec<f64> {
    let big = 1e9;
    let diag = RES * core::f64::consts::SQRT_2;
    let mut d: Vec<f64> = src.iter().map(|&s| if s { 0.0 } else { big }).collect();
    for j in 0..N {
        for i in 0..N {
            let k = idx(i, j);
            let mut v = d[k];
            if i > 0 {
                v = v.min(d[k - 1] + RES);
            }
            if j > 0 {
                v = v.min(d[k - N] + RES);
                if i > 0 {
                    v = v.min(d[k - N - 1] + diag);
                }
                if i + 1 < N {
                    v = v.min(d[k - N + 1] + diag);
                }
            }
            d[k] = v;
        }
    }
    for j in (0..N).rev() {
        for i in (0..N).rev() {
            let k = idx(i, j);
            let mut v = d[k];
            if i + 1 < N {
                v = v.min(d[k + 1] + RES);
            }
            if j + 1 < N {
                v = v.min(d[k + N] + RES);
                if i + 1 < N {
                    v = v.min(d[k + N + 1] + diag);
                }
                if i > 0 {
                    v = v.min(d[k + N - 1] + diag);
                }
            }
            d[k] = v;
        }
    }
    d
}

/// Bilinear sample of a node grid at world meters (clamped to the world).
pub fn bilinear(g: &[f64], x: f64, z: f64) -> f64 {
    let u = (x / RES).clamp(0.0, (N - 1) as f64);
    let v = (z / RES).clamp(0.0, (N - 1) as f64);
    let i = (libm::floor(u) as usize).min(N - 2);
    let j = (libm::floor(v) as usize).min(N - 2);
    let fu = u - i as f64;
    let fv = v - j as f64;
    let a = g[idx(i, j)] + (g[idx(i + 1, j)] - g[idx(i, j)]) * fu;
    let b = g[idx(i, j + 1)] + (g[idx(i + 1, j + 1)] - g[idx(i, j + 1)]) * fu;
    a + (b - a) * fv
}

pub fn run(w: &mut World) {
    let spec = &w.spec;
    let sea_y = w.sea_y;
    let water_src: Vec<bool> = (0..NN).map(|k| w.sea[k] || w.lake[k] || w.river_w[k] > 0).collect();
    let fresh_src: Vec<bool> = (0..NN).map(|k| w.lake[k] || w.river_w[k] > 0).collect();
    w.dist_water = distance_from(&water_src);
    w.dist_fresh = distance_from(&fresh_src);
    let is_wet: Vec<f64> = (0..NN).map(|k| if w.sea[k] || w.lake[k] { 1.0 } else { 0.0 }).collect();

    // windDirection is where the wind comes FROM (meteorological), with
    // north = -z. Upwind unit vector:
    let a = spec.wind_direction as f64 * core::f64::consts::PI / 180.0;
    let (ux, uz) = (libm::sin(a), -libm::cos(a));
    let s_t = seed32(w.seed, 20);
    let s_m = seed32(w.seed, 21);

    let mut temp = vec![0.0; NN];
    let mut moist = vec![0.0; NN];
    for j in 0..N {
        for i in 0..N {
            let k = idx(i, j);
            let x = i as f64 * RES;
            let z = j as f64 * RES;
            let hk = w.h[k];
            let alt = (hk - sea_y).max(0.0);
            // Broad warm/cold and wet/dry provinces (1.4 km noise) give each world
            // distinct climate zones, so hot dry badlands and cold wet fens can
            // share one 4 km island.
            let t = 0.64 + 0.3 * spec.temperature_bias + 0.16 * (z / WORLD - 0.5) - 0.95 * alt / 600.0 + 0.14 * fbm(s_t, x, z, 1400.0, 3, 0.5);
            temp[k] = clamp01(t);

            // March upwind: the first water found is the moisture source; the
            // highest terrain crossed on the way casts a rain shadow.
            let mut src = 0.12;
            let mut max_rise: f64 = 0.0;
            for step in 1..=30 {
                let d = step as f64 * 48.0;
                let px = x + ux * d;
                let pz = z + uz * d;
                if px < 0.0 || pz < 0.0 || px > WORLD || pz > WORLD {
                    // Off-map upwind is open sea.
                    src = libm::exp(-d / 900.0);
                    break;
                }
                let hb = bilinear(&w.h, px, pz);
                max_rise = max_rise.max(hb - hk);
                if bilinear(&is_wet, px, pz) > 0.5 {
                    src = libm::exp(-d / 900.0);
                    break;
                }
            }
            let shadow = libm::exp(-(max_rise - 30.0).max(0.0) / 180.0);
            let near = libm::exp(-w.dist_water[k] / 300.0);
            let m = 0.2 + 0.35 * near + 0.4 * src * shadow + 0.3 * spec.moisture_bias + 0.3 * fbm(s_m, x, z, 1400.0, 3, 0.5);
            // Raw, before bias: the bias is applied after rank normalization.
            moist[k] = m - 0.3 * spec.moisture_bias;
        }
    }
    // A 4 km island is never far from the sea, so raw moisture is high
    // everywhere. Rank-normalize it over land (uniform 0.05..0.95) so every
    // world has dry and wet provinces in the same places the physics put
    // them, then apply the spec bias on top.
    let mut land: Vec<(f64, usize)> = (0..NN).filter(|&k| !w.sea[k]).map(|k| (moist[k], k)).collect();
    land.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    let n = land.len().max(2) as f64;
    for (r, &(_, k)) in land.iter().enumerate() {
        moist[k] = 0.05 + 0.9 * r as f64 / (n - 1.0);
    }
    for (k, m) in moist.iter_mut().enumerate() {
        let base = if w.sea[k] { 1.0 } else { *m };
        *m = clamp01(base + 0.3 * spec.moisture_bias);
    }
    // Quantize to the stored u8 so later stages agree with the atlas bytes.
    for v in temp.iter_mut() {
        *v = libm::round(*v * 255.0) / 255.0;
    }
    for v in moist.iter_mut() {
        *v = libm::round(*v * 255.0) / 255.0;
    }
    w.temp = temp;
    w.moist = moist;
    biomes(w);
}

fn gauss(x: f64, mu: f64, sigma: f64) -> f64 {
    let d = (x - mu) / sigma;
    libm::exp(-d * d)
}

/// Biome affinity scores, before spec weights. Returns [meadow..wetland].
pub fn affinity(t: f64, m: f64, alt01: f64, slope: f64, wet_near: f64) -> [f64; 6] {
    let flat = 1.0 - smoothstep(4.0, 12.0, slope);
    [
        gauss(t, 0.58, 0.22) * gauss(m, 0.42, 0.22) * (1.0 - smoothstep(0.35, 0.6, alt01)),
        gauss(t, 0.55, 0.22) * gauss(m, 0.68, 0.2) * (1.0 - smoothstep(0.45, 0.7, alt01)),
        gauss(t, 0.4, 0.17) * (0.35 + smoothstep(0.18, 0.45, alt01)) * (0.7 + 0.6 * smoothstep(10.0, 25.0, slope)),
        2.0 * smoothstep(0.27, 0.17, t),
        gauss(t, 0.74, 0.2) * gauss(m, 0.15, 0.22) * 1.4,
        gauss(m, 0.88, 0.13) * (1.0 - smoothstep(0.08, 0.2, alt01)) * flat * (0.4 + 0.6 * wet_near) * 1.3,
    ]
}

fn biomes(w: &mut World) {
    let weights = biome_weight_array(&w.spec);
    let wmax = weights.iter().cloned().fold(0.0, f64::max);
    let norm: [f64; 6] = if wmax > 0.0 { core::array::from_fn(|b| weights[b] / wmax) } else { [1.0; 6] };
    let sea_y = w.sea_y;
    let s_b = seed32(w.seed, 22);
    let mut biome = vec![0u8; NN];
    for j in 0..N {
        for i in 0..N {
            let k = idx(i, j);
            let x = i as f64 * RES;
            let z = j as f64 * RES;
            // Low-frequency jitter so biome borders wander instead of following contours.
            let jt = 0.05 * fbm(s_b, x, z, 420.0, 3, 0.5);
            let jm = 0.07 * fbm(s_b ^ 0x55, x, z, 420.0, 3, 0.5);
            let alt01 = ((w.h[k] - sea_y) / 560.0).clamp(0.0, 1.0);
            let wet_near = libm::exp(-w.dist_fresh[k] / 160.0);
            let aff = affinity(w.temp[k] + jt, w.moist[k] + jm, alt01, w.slope[k], wet_near);
            let mut best = 0usize;
            let mut best_s = -1.0;
            for b in 0..6 {
                let s = aff[b] * norm[b];
                if s > best_s {
                    best_s = s;
                    best = b;
                }
            }
            biome[k] = best as u8;
        }
    }
    // One majority pass over land removes single-node speckles.
    let mut out = biome.clone();
    for j in 1..N - 1 {
        for i in 1..N - 1 {
            let k = idx(i, j);
            if w.sea[k] {
                continue;
            }
            let mut counts = [0u8; 6];
            for dz in -1i32..=1 {
                for dx in -1i32..=1 {
                    counts[biome[idx((i as i32 + dx) as usize, (j as i32 + dz) as usize)] as usize] += 1;
                }
            }
            let mut best = biome[k] as usize;
            for b in 0..6 {
                if counts[b] > counts[best] {
                    best = b;
                }
            }
            if counts[best] >= 5 {
                out[k] = best as u8;
            }
        }
    }
    w.biome = out;
}
