//! Continent mask and macro heightmap at MACRO_RES_M (spec 5, atlas pass).
//!
//! The world is one landmass inside a guaranteed sea border, so the 4096 m
//! square ends naturally at a coast. Every region gets a land "anchor" bump
//! because spec 5 promises each region a tower and a settlement; a region of
//! open sea could hold neither.

use super::format::{idx, N, NN, RES, WORLD};
use super::World;
use crate::gen::constants::WORLD_REGIONS;
use crate::noise::{fbm, ridged, smoothstep};
use crate::rng::Seq;

/// Minimum land nodes per region (about 8% of a region's ~1000 nodes):
/// enough room for a settlement, a tower and a few structures.
const MIN_REGION_LAND: usize = 80;

pub fn seed32(seed: u64, salt: u32) -> u32 {
    let h = crate::rng::hash(seed, 0x4E4F_4953, salt as i64, 0, 0); // "NOIS"
    (h ^ (h >> 32)) as u32
}

pub fn generate(w: &mut World) {
    let spec = &w.spec;
    let seed = w.seed;
    let s_warp_x = seed32(seed, 1);
    let s_warp_z = seed32(seed, 2);
    let s_cont = seed32(seed, 3);
    let s_hills = seed32(seed, 4);
    let s_mmask = seed32(seed, 5);
    let s_ridge = seed32(seed, 6);
    let s_plat = seed32(seed, 7);
    let s_sea = seed32(seed, 8);

    // One anchor per region, kept 30% inside the region so it never sits on
    // the sea border.
    let region_m = WORLD / WORLD_REGIONS as f64;
    let mut seq = Seq::new(seed, 0x414E_4348); // "ANCH"
    let mut anchors = Vec::new();
    for rz in 0..WORLD_REGIONS {
        for rx in 0..WORLD_REGIONS {
            let ax = (rx as f64 + seq.range(0.3, 0.7)) * region_m;
            let az = (rz as f64 + seq.range(0.3, 0.7)) * region_m;
            anchors.push((ax, az));
        }
    }
    let mut bump_strength = vec![0.42f64; anchors.len()];

    // Static fields that do not depend on bump strength.
    let mut base = vec![0.0f64; NN];
    let mut border = vec![0.0f64; NN];
    for j in 0..N {
        for i in 0..N {
            let x = i as f64 * RES;
            let z = j as f64 * RES;
            let wx = x + 420.0 * fbm(s_warp_x, x, z, 1500.0, 3, 0.5);
            let wz = z + 420.0 * fbm(s_warp_z, x, z, 1500.0, 3, 0.5);
            let cont = fbm(s_cont, wx, wz, 2100.0, 5, 0.5);
            let dx = x / WORLD - 0.5;
            let dz = z / WORLD - 0.5;
            let r = libm::sqrt(dx * dx + dz * dz) / 0.5;
            let radial = 1.0 - smoothstep(0.3, 1.15, r);
            let edge = x.min(WORLD - x).min(z).min(WORLD - z) / WORLD;
            base[idx(i, j)] = 0.5 * cont + 0.55 * radial;
            border[idx(i, j)] = smoothstep(0.012, 0.085, edge);
        }
    }

    let land_fraction = spec.land_fraction;
    let mut mask = vec![0.0f64; NN];
    let mut threshold = 0.0;
    for _attempt in 0..6 {
        for j in 0..N {
            for i in 0..N {
                let x = i as f64 * RES;
                let z = j as f64 * RES;
                let mut bump: f64 = 0.0;
                for (k, &(ax, az)) in anchors.iter().enumerate() {
                    let d2 = (x - ax) * (x - ax) + (z - az) * (z - az);
                    bump = bump.max(bump_strength[k] * libm::exp(-d2 / (2.0 * 240.0 * 240.0)));
                }
                let b = border[idx(i, j)];
                mask[idx(i, j)] = (base[idx(i, j)] + bump) * b - (1.0 - b) * 1.5;
            }
        }
        // Quantile threshold: exactly `landFraction` of nodes end up as land.
        let mut sorted = mask.clone();
        sorted.sort_by(|a, b| a.total_cmp(b));
        let qi = (((1.0 - land_fraction) * NN as f64) as usize).min(NN - 1);
        threshold = sorted[qi];
        // Check every region has room; strengthen the anchors of those that don't.
        let mut short = false;
        for (k, _) in anchors.iter().enumerate() {
            let rx = k % WORLD_REGIONS as usize;
            let rz = k / WORLD_REGIONS as usize;
            let land = count_region(&mask, threshold, rx, rz);
            if land < MIN_REGION_LAND {
                bump_strength[k] += 0.35;
                short = true;
            }
        }
        if !short {
            break;
        }
    }

    let mut max_m = f64::MIN;
    let mut min_m = f64::MAX;
    for &m in &mask {
        max_m = max_m.max(m);
        min_m = min_m.min(m);
    }
    let land_span = (max_m - threshold).max(1e-6);
    let sea_span = (threshold - min_m).max(1e-6);

    let sea_y = w.sea_y;
    let peak_h = w.peak_h;
    let hill_amp = 18.0 + 45.0 * spec.roughness;
    let plateaus = spec.plateaus;
    let mut h = vec![0.0f64; NN];
    for j in 0..N {
        for i in 0..N {
            let k = idx(i, j);
            let x = i as f64 * RES;
            let z = j as f64 * RES;
            let m = mask[k];
            if m > threshold {
                let ln = (m - threshold) / land_span;
                let coast_rise = smoothstep(0.0, 0.45, ln);
                let hills = fbm(s_hills, x, z, 650.0, 5, 0.42 + 0.2 * spec.roughness) * 0.5 + 0.5;
                let mmask = smoothstep(-0.2, 0.4, fbm(s_mmask, x, z, 1700.0, 3, 0.5)) * smoothstep(0.04, 0.3, ln);
                let ridge = ridged(s_ridge, x + 300.0, z - 200.0, 1050.0, 5, 0.5);
                let mut above = 2.0 + 75.0 * libm::pow(ln, 0.9) + hill_amp * hills * coast_rise + peak_h * mmask * libm::pow(ridge, 1.35);
                // Plateaus: terrace the macro surface into mesas where the mask allows.
                let pmask = smoothstep(0.05, 0.45, fbm(s_plat, x, z, 1300.0, 3, 0.5)) * plateaus;
                if pmask > 0.0 {
                    let step = 26.0;
                    let t = above / step;
                    let kf = libm::floor(t);
                    let f = smoothstep(0.3, 0.7, t - kf);
                    above += ((kf + f) * step - above) * pmask;
                }
                h[k] = sea_y + above.max(1.5);
            } else {
                let sn = (threshold - m) / sea_span;
                let floor = sea_y - 3.0 - 70.0 * smoothstep(0.0, 0.6, sn) + 4.0 * fbm(s_sea, x, z, 500.0, 3, 0.5);
                h[k] = floor.min(sea_y - 1.5);
            }
            h[k] = h[k].clamp(-180.0, 740.0);
        }
    }
    w.h = h;
    w.anchors = anchors;
}

fn count_region(mask: &[f64], t: f64, rx: usize, rz: usize) -> usize {
    let per = (N - 1) / WORLD_REGIONS as usize;
    let mut c = 0;
    for j in rz * per..(rz + 1) * per {
        for i in rx * per..(rx + 1) * per {
            if mask[idx(i, j)] > t {
                c += 1;
            }
        }
    }
    c
}
