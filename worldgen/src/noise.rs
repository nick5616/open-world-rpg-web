//! 2D gradient noise with analytic derivatives, and the fractal sums built on
//! it. Pure f64 arithmetic plus `libm::floor`, so every host computes the same
//! bits (determinism rules 1 and 2). Lattice hashing is 32-bit integer math,
//! which is the cheapest thing in wasm.

/// 16 unit gradient directions (k * 22.5 degrees), written as literals so no
/// trig runs at noise time and the constants parse identically everywhere.
const GRAD: [(f64, f64); 16] = [
    (1.0, 0.0),
    (0.923_879_532_511_286_7, 0.382_683_432_365_089_8),
    (0.707_106_781_186_547_6, 0.707_106_781_186_547_6),
    (0.382_683_432_365_089_8, 0.923_879_532_511_286_7),
    (0.0, 1.0),
    (-0.382_683_432_365_089_8, 0.923_879_532_511_286_7),
    (-0.707_106_781_186_547_6, 0.707_106_781_186_547_6),
    (-0.923_879_532_511_286_7, 0.382_683_432_365_089_8),
    (-1.0, 0.0),
    (-0.923_879_532_511_286_7, -0.382_683_432_365_089_8),
    (-0.707_106_781_186_547_6, -0.707_106_781_186_547_6),
    (-0.382_683_432_365_089_8, -0.923_879_532_511_286_7),
    (0.0, -1.0),
    (0.382_683_432_365_089_8, -0.923_879_532_511_286_7),
    (0.707_106_781_186_547_6, -0.707_106_781_186_547_6),
    (0.923_879_532_511_286_7, -0.382_683_432_365_089_8),
];

/// Integer lattice hash (lowbias32 finalizer by C. Wellons).
#[inline]
pub fn lattice(seed: u32, ix: i32, iz: i32) -> u32 {
    let mut h = seed ^ (ix as u32).wrapping_mul(0x8DA6_B343) ^ (iz as u32).wrapping_mul(0xD816_3841);
    h ^= h >> 16;
    h = h.wrapping_mul(0x7FEB_352D);
    h ^= h >> 15;
    h = h.wrapping_mul(0x846C_A68B);
    h ^ (h >> 16)
}

#[inline]
fn grad(seed: u32, ix: i32, iz: i32) -> (f64, f64) {
    GRAD[(lattice(seed, ix, iz) >> 28) as usize]
}

/// Gradient noise value and its partial derivatives (d/dx, d/dz).
/// Quintic fade so the derivative is continuous (no creases in the
/// derivative-damped fractal below). Output roughly in [-0.75, 0.75].
#[inline]
pub fn noise_d(seed: u32, x: f64, z: f64) -> (f64, f64, f64) {
    let xf = libm::floor(x);
    let zf = libm::floor(z);
    let ix = xf as i32;
    let iz = zf as i32;
    let fx = x - xf;
    let fz = z - zf;
    let u = fx * fx * fx * (fx * (fx * 6.0 - 15.0) + 10.0);
    let v = fz * fz * fz * (fz * (fz * 6.0 - 15.0) + 10.0);
    let du = 30.0 * fx * fx * (fx * (fx - 2.0) + 1.0);
    let dv = 30.0 * fz * fz * (fz * (fz - 2.0) + 1.0);
    let ga = grad(seed, ix, iz);
    let gb = grad(seed, ix + 1, iz);
    let gc = grad(seed, ix, iz + 1);
    let gd = grad(seed, ix + 1, iz + 1);
    let va = ga.0 * fx + ga.1 * fz;
    let vb = gb.0 * (fx - 1.0) + gb.1 * fz;
    let vc = gc.0 * fx + gc.1 * (fz - 1.0);
    let vd = gd.0 * (fx - 1.0) + gd.1 * (fz - 1.0);
    let k = va - vb - vc + vd;
    let n = va + u * (vb - va) + v * (vc - va) + u * v * k;
    let dx = ga.0 + u * (gb.0 - ga.0) + v * (gc.0 - ga.0) + u * v * (ga.0 - gb.0 - gc.0 + gd.0) + du * (v * k + vb - va);
    let dz = ga.1 + u * (gb.1 - ga.1) + v * (gc.1 - ga.1) + u * v * (ga.1 - gb.1 - gc.1 + gd.1) + dv * (u * k + vc - va);
    (n, dx, dz)
}

/// Noise value only.
#[inline]
pub fn noise(seed: u32, x: f64, z: f64) -> f64 {
    noise_d(seed, x, z).0
}

/// Plain fractal sum, normalized to roughly [-1, 1]. `period` in meters.
pub fn fbm(seed: u32, x: f64, z: f64, period: f64, octaves: u32, gain: f64) -> f64 {
    let mut sum = 0.0;
    let mut amp = 1.0;
    let mut norm = 0.0;
    let mut px = x / period;
    let mut pz = z / period;
    for o in 0..octaves {
        sum += amp * noise(seed.wrapping_add(o.wrapping_mul(0x9E37_79B9)), px, pz);
        norm += amp;
        amp *= gain;
        // Rotate ~37 degrees and double: breaks up lattice alignment between octaves.
        let nx = 1.6 * px - 1.2 * pz;
        let nz = 1.2 * px + 1.6 * pz;
        px = nx;
        pz = nz;
    }
    sum / norm * 1.4
}

/// Ridged fractal in [0, 1]: sharp crests where the noise crosses zero, with
/// each octave weighted by the previous one so ridges branch like real ranges.
pub fn ridged(seed: u32, x: f64, z: f64, period: f64, octaves: u32, gain: f64) -> f64 {
    let mut sum = 0.0;
    let mut amp = 1.0;
    let mut norm = 0.0;
    let mut weight = 1.0;
    let mut px = x / period;
    let mut pz = z / period;
    for o in 0..octaves {
        let n = noise(seed.wrapping_add(o.wrapping_mul(0x9E37_79B9)), px, pz);
        let r = 1.0 - libm::fabs(n) * 1.5;
        let r = if r < 0.0 { 0.0 } else { r };
        let r = r * r * weight;
        weight = if r * 2.0 > 1.0 { 1.0 } else { r * 2.0 };
        sum += r * amp;
        norm += amp;
        amp *= gain;
        let nx = 1.6 * px - 1.2 * pz;
        let nz = 1.2 * px + 1.6 * pz;
        px = nx;
        pz = nz;
    }
    sum / norm
}

/// Derivative-damped fractal ("erosion-shaped" detail). Octaves are
/// attenuated where earlier octaves are steep, so slopes stay smooth and
/// detail collects in valleys and on flats, which reads as weathered terrain
/// (technique after I. Quilez, "Terrain raymarching"). Roughly [-1, 1].
pub fn eroded(seed: u32, x: f64, z: f64, period: f64, octaves: u32, gain: f64) -> f64 {
    let mut sum = 0.0;
    let mut amp = 1.0;
    let mut norm = 0.0;
    let mut dx = 0.0;
    let mut dz = 0.0;
    let mut px = x / period;
    let mut pz = z / period;
    for o in 0..octaves {
        let (n, ndx, ndz) = noise_d(seed.wrapping_add(o.wrapping_mul(0x9E37_79B9)), px, pz);
        dx += ndx;
        dz += ndz;
        sum += amp * n / (1.0 + dx * dx + dz * dz);
        norm += amp;
        amp *= gain;
        let nx = 1.6 * px - 1.2 * pz;
        let nz = 1.2 * px + 1.6 * pz;
        px = nx;
        pz = nz;
    }
    sum / norm * 1.6
}

#[inline]
pub fn smoothstep(e0: f64, e1: f64, x: f64) -> f64 {
    let t = clamp01((x - e0) / (e1 - e0));
    t * t * (3.0 - 2.0 * t)
}

#[inline]
pub fn clamp01(x: f64) -> f64 {
    if x < 0.0 {
        0.0
    } else if x > 1.0 {
        1.0
    } else {
        x
    }
}

#[inline]
pub fn clamp(x: f64, lo: f64, hi: f64) -> f64 {
    if x < lo {
        lo
    } else if x > hi {
        hi
    } else {
        x
    }
}

#[inline]
pub fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derivative_matches_finite_difference() {
        let e = 1e-6;
        for i in 0..50 {
            let x = i as f64 * 0.37 + 0.11;
            let z = i as f64 * -0.53 + 3.7;
            let (_, dx, dz) = noise_d(9, x, z);
            let fdx = (noise(9, x + e, z) - noise(9, x - e, z)) / (2.0 * e);
            let fdz = (noise(9, x, z + e) - noise(9, x, z - e)) / (2.0 * e);
            assert!((dx - fdx).abs() < 1e-4, "dx {dx} vs {fdx}");
            assert!((dz - fdz).abs() < 1e-4, "dz {dz} vs {fdz}");
        }
    }

    #[test]
    fn ranges() {
        for i in 0..2000 {
            let x = i as f64 * 13.7;
            let z = i as f64 * 7.3;
            let f = fbm(1, x, z, 300.0, 5, 0.5);
            let r = ridged(2, x, z, 300.0, 5, 0.5);
            let e = eroded(3, x, z, 300.0, 6, 0.5);
            assert!(f.is_finite() && (-2.0..=2.0).contains(&f));
            assert!((0.0..=1.0).contains(&r));
            assert!(e.is_finite() && (-2.5..=2.5).contains(&e));
        }
    }

    #[test]
    fn zero_at_lattice() {
        assert_eq!(noise(5, 3.0, -4.0), 0.0);
    }
}
