//! 3D gradient noise for cave walls (spec 7 "tunnels become swept capsules
//! with noise"). Same rules as `noise.rs`: pure f64 arithmetic plus
//! `libm::floor`, a 32-bit integer lattice hash, gradient constants written as
//! literals, so every host computes identical bits.

/// The 12 cube-edge gradients (Perlin's improved-noise set). Not normalized:
/// all have length sqrt(2), which only scales the output range.
const G3: [(f64, f64, f64); 12] = [
    (1.0, 1.0, 0.0),
    (-1.0, 1.0, 0.0),
    (1.0, -1.0, 0.0),
    (-1.0, -1.0, 0.0),
    (1.0, 0.0, 1.0),
    (-1.0, 0.0, 1.0),
    (1.0, 0.0, -1.0),
    (-1.0, 0.0, -1.0),
    (0.0, 1.0, 1.0),
    (0.0, -1.0, 1.0),
    (0.0, 1.0, -1.0),
    (0.0, -1.0, -1.0),
];

/// lowbias32 finalizer over a 3D lattice point (C. Wellons).
#[inline]
fn hash3(seed: u32, ix: i32, iy: i32, iz: i32) -> u32 {
    let mut h = seed ^ (ix as u32).wrapping_mul(0x8DA6_B343) ^ (iy as u32).wrapping_mul(0xCB1A_B31F) ^ (iz as u32).wrapping_mul(0xD816_3841);
    h ^= h >> 16;
    h = h.wrapping_mul(0x7FEB_352D);
    h ^= h >> 15;
    h = h.wrapping_mul(0x846C_A68B);
    h ^ (h >> 16)
}

#[inline]
fn grad_dot(seed: u32, ix: i32, iy: i32, iz: i32, x: f64, y: f64, z: f64) -> f64 {
    // Multiply-shift into [0, 12) instead of `%`, so all 12 gradients are
    // equally likely without a division.
    let g = G3[(((hash3(seed, ix, iy, iz) >> 16) * 12) >> 16) as usize];
    g.0 * x + g.1 * y + g.2 * z
}

#[inline]
fn fade(t: f64) -> f64 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

/// Gradient noise in roughly [-1, 1], zero on lattice points.
pub fn noise3(seed: u32, x: f64, y: f64, z: f64) -> f64 {
    let xf = libm::floor(x);
    let yf = libm::floor(y);
    let zf = libm::floor(z);
    let (ix, iy, iz) = (xf as i32, yf as i32, zf as i32);
    let (fx, fy, fz) = (x - xf, y - yf, z - zf);
    let (u, v, w) = (fade(fx), fade(fy), fade(fz));
    let n000 = grad_dot(seed, ix, iy, iz, fx, fy, fz);
    let n100 = grad_dot(seed, ix + 1, iy, iz, fx - 1.0, fy, fz);
    let n010 = grad_dot(seed, ix, iy + 1, iz, fx, fy - 1.0, fz);
    let n110 = grad_dot(seed, ix + 1, iy + 1, iz, fx - 1.0, fy - 1.0, fz);
    let n001 = grad_dot(seed, ix, iy, iz + 1, fx, fy, fz - 1.0);
    let n101 = grad_dot(seed, ix + 1, iy, iz + 1, fx - 1.0, fy, fz - 1.0);
    let n011 = grad_dot(seed, ix, iy + 1, iz + 1, fx, fy - 1.0, fz - 1.0);
    let n111 = grad_dot(seed, ix + 1, iy + 1, iz + 1, fx - 1.0, fy - 1.0, fz - 1.0);
    let x00 = n000 + u * (n100 - n000);
    let x10 = n010 + u * (n110 - n010);
    let x01 = n001 + u * (n101 - n001);
    let x11 = n011 + u * (n111 - n011);
    let y0 = x00 + v * (x10 - x00);
    let y1 = x01 + v * (x11 - x01);
    y0 + w * (y1 - y0)
}

/// Two-octave wall noise used by the cave density: a 6 m swell plus a 2.7 m
/// roughness, roughly [-1, 1]. Octaves use different seeds and a rotated
/// lattice so their grids never line up (visible as banding on walls).
#[inline]
pub fn wall_noise(seed: u32, x: f64, y: f64, z: f64) -> f64 {
    let a = noise3(seed, x * (1.0 / 6.0), y * (1.0 / 6.0), z * (1.0 / 6.0));
    let (rx, rz) = (0.8 * x - 0.6 * z, 0.6 * x + 0.8 * z);
    let b = noise3(seed ^ 0x9E37_79B9, rx * (1.0 / 2.7), y * (1.0 / 2.7), rz * (1.0 / 2.7));
    0.72 * a + 0.38 * b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_on_lattice_and_bounded() {
        assert_eq!(noise3(3, 2.0, -5.0, 7.0), 0.0);
        for i in 0..5000 {
            let p = i as f64;
            let v = noise3(11, p * 0.37, p * -0.21 + 3.3, p * 0.13 - 9.1);
            assert!(v.is_finite() && (-1.5..=1.5).contains(&v), "{v}");
            let w = wall_noise(5, p * 1.7, p * 0.3, -p * 0.9);
            assert!((-1.6..=1.6).contains(&w));
        }
    }

    #[test]
    fn deterministic() {
        assert_eq!(noise3(1, 0.5, 1.25, -3.75).to_bits(), noise3(1, 0.5, 1.25, -3.75).to_bits());
        assert_ne!(noise3(1, 0.5, 1.25, -3.75), noise3(2, 0.5, 1.25, -3.75));
    }
}
