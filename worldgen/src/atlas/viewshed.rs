//! Viewsheds on the macro heightmap (spec 5, "placing points of interest by
//! visibility"). Radial line-of-sight sweep: rays leave the observer every
//! ~32 m of circumference, march in 20 m steps, and keep the steepest
//! terrain tangent seen so far; a node is visible when a person standing on
//! it (eye height) rises above that tangent. Visibility of a POI *from* the
//! land is close to symmetric with this, which is what the scoring needs.

use super::climate::bilinear;
use super::format::{idx, N, NN, RES, WORLD};

#[derive(Clone)]
pub struct Bits {
    pub w: Vec<u64>,
}

impl Bits {
    pub fn new() -> Self {
        Bits { w: vec![0; NN.div_ceil(64)] }
    }
    #[inline]
    pub fn set(&mut self, k: usize) {
        self.w[k >> 6] |= 1 << (k & 63);
    }
    #[inline]
    pub fn get(&self, k: usize) -> bool {
        self.w[k >> 6] & (1 << (k & 63)) != 0
    }
    pub fn or(&mut self, o: &Bits) {
        for (a, b) in self.w.iter_mut().zip(&o.w) {
            *a |= *b;
        }
    }
    pub fn count(&self) -> usize {
        self.w.iter().map(|x| x.count_ones() as usize).sum()
    }
    /// |self & mask & !cover|
    pub fn gain(&self, mask: &Bits, cover: &Bits) -> usize {
        self.w
            .iter()
            .zip(&mask.w)
            .zip(&cover.w)
            .map(|((a, m), c)| (a & m & !c).count_ones() as usize)
            .sum()
    }
    pub fn and_count(&self, mask: &Bits) -> usize {
        self.w.iter().zip(&mask.w).map(|(a, m)| (a & m).count_ones() as usize).sum()
    }
}

impl Default for Bits {
    fn default() -> Self {
        Self::new()
    }
}

pub const EYE: f64 = 1.8;

/// Viewshed from an observer at (ox, oz) whose eye is `obs_above` meters
/// above the ground there, out to `radius` meters.
pub fn viewshed(h: &[f64], ox: f64, oz: f64, obs_above: f64, radius: f64) -> Bits {
    let mut out = Bits::new();
    let obs = bilinear(h, ox, oz) + obs_above;
    let rays = libm::ceil(2.0 * core::f64::consts::PI * radius / 32.0) as usize;
    let step = 20.0;
    out.set(nearest(ox, oz));
    for r in 0..rays {
        let a = 2.0 * core::f64::consts::PI * r as f64 / rays as f64;
        let (dx, dz) = (libm::cos(a), libm::sin(a));
        let mut max_t = f64::NEG_INFINITY;
        let mut d = step;
        while d <= radius {
            let px = ox + dx * d;
            let pz = oz + dz * d;
            if px < 0.0 || pz < 0.0 || px > WORLD || pz > WORLD {
                break;
            }
            let hb = bilinear(h, px, pz);
            let t = (hb - obs) / d;
            if (hb + EYE - obs) / d >= max_t {
                out.set(nearest(px, pz));
            }
            if t > max_t {
                max_t = t;
            }
            d += step;
        }
    }
    out
}

#[inline]
pub fn nearest(x: f64, z: f64) -> usize {
    let i = (libm::round(x / RES) as i64).clamp(0, N as i64 - 1) as usize;
    let j = (libm::round(z / RES) as i64).clamp(0, N as i64 - 1) as usize;
    idx(i, j)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wall_blocks_view() {
        // Flat ground with a 100 m wall at x = 1024..1056.
        let mut h = vec![0.0; NN];
        for j in 0..N {
            for i in 32..=33 {
                h[idx(i, j)] = 100.0;
            }
        }
        let v = viewshed(&h, 512.0, 2048.0, 2.0, 1500.0);
        assert!(v.get(nearest(800.0, 2048.0)), "in front of the wall is visible");
        assert!(!v.get(nearest(1400.0, 2048.0)), "behind the wall is hidden");
        let v2 = viewshed(&h, 512.0, 2048.0, 300.0, 1500.0);
        assert!(v2.get(nearest(1400.0, 2048.0)), "a tall tower sees over it");
    }
}
