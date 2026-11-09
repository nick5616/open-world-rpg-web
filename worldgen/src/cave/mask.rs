//! Mouth masks (spec 7 "Cave mouths"): which overworld heightfield
//! triangles to drop because the cave volume replaces them. A triangle of
//! the 1 m surface mesh (README "Collision": cell (x0, z0), triangle 0 below
//! the diagonal from (x0+1, z0) to (x0, z0+1), triangle 1 above it) is
//! masked when its centroid lies strictly within `r_mask` of an opening:
//!
//!   tri 0 centroid (x0 + 1/3, z0 + 1/3), tri 1 centroid (x0 + 2/3, z0 + 2/3)
//!   masked  <=>  (cx - ox)^2 + (cz - oz)^2 < r_mask^2   (f64, f32 opening values)
//!
//! The rule is analytic so a host can apply it from the graph buffer's
//! openings without calling `cave_mask` (the client tile builder and both
//! movement grounds do); `cave_mask` exists for the golden table and tools.
//! This is a new output beside chunk_build, so the chunk buffer (and every
//! chunk hash) is unchanged: genVersion stays 1 (see docs/cr/003).

use super::graph::{CaveWorld, Opening};
use crate::atlas::format::{put_u16, put_u32};

pub const MAGIC: [u8; 4] = *b"LDCM";
pub const FORMAT: u16 = 1;
pub const HEADER: usize = 24;
pub const BITS_LEN: usize = 64 * 64 * 2 / 8;

/// Is the heightfield triangle `tri` (0 or 1) of the 1 m cell at integer
/// (x0, z0) dropped by any of `openings`?
#[inline]
pub fn tri_masked(openings: &[Opening], x0: f64, z0: f64, tri: u32) -> bool {
    let (cx, cz) = if tri == 0 {
        (x0 + 1.0 / 3.0, z0 + 1.0 / 3.0)
    } else {
        (x0 + 2.0 / 3.0, z0 + 2.0 / 3.0)
    };
    openings.iter().any(|o| {
        let dx = cx - o.x;
        let dz = cz - o.z;
        dx * dx + dz * dz < o.r_mask * o.r_mask
    })
}

/// Is the surface under point (x, z) dropped (the triangle containing it is masked)?
pub fn point_masked(openings: &[Opening], x: f64, z: f64) -> bool {
    let x0 = libm::floor(x);
    let z0 = libm::floor(z);
    let tri = if (x - x0) + (z - z0) <= 1.0 { 0 } else { 1 };
    tri_masked(openings, x0, z0, tri)
}

pub fn build(w: &CaveWorld, cx: i32, cz: i32) -> Vec<u8> {
    let x0 = cx as f64 * 64.0;
    let z0 = cz as f64 * 64.0;
    let near: Vec<Opening> = w
        .openings()
        .filter(|o| o.x + o.r_mask > x0 - 1.0 && o.x - o.r_mask < x0 + 65.0 && o.z + o.r_mask > z0 - 1.0 && o.z - o.r_mask < z0 + 65.0)
        .copied()
        .collect();
    let mut b = vec![0u8; HEADER + BITS_LEN];
    b[0..4].copy_from_slice(&MAGIC);
    put_u16(&mut b, 4, FORMAT);
    put_u16(&mut b, 6, crate::GEN_VERSION);
    put_u32(&mut b, 8, cx as u32);
    put_u32(&mut b, 12, cz as u32);
    let mut count = 0u32;
    if !near.is_empty() {
        for z in 0..64usize {
            for x in 0..64usize {
                for tri in 0..2u32 {
                    if tri_masked(&near, x0 + x as f64, z0 + z as f64, tri) {
                        let bit = ((z * 64 + x) << 1) | tri as usize;
                        b[HEADER + (bit >> 3)] |= 1 << (bit & 7);
                        count += 1;
                    }
                }
            }
        }
    }
    put_u32(&mut b, 16, count);
    b
}
