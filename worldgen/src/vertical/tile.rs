//! Layer tiles (`LDLT`, format 1): a 65 x 65 lattice of a layer's three
//! surfaces at spacing 2^lod m from (cx*64, cz*64), the same tiling as the
//! terrain chunks. LOD 0 tiles hold exactly the collision lattice; coarser
//! tiles sample the same function (seams match across LODs and neighbours).
//!
//! Header (64 bytes): 0 magic `LDLT`, 4 u16 format 1, 6 u16 genVersion,
//! 8 u32 length, 12 u8 layer, 13 u8 lod, 14 u16 S (65), 16 i32 cx, 20 i32 cz,
//! 24 f32 step, 28 u32 flags (1: some air (Underground/Depths) or solid
//! (sky) in the tile, 2: some water or lava above the floor), 32 f32 min A,
//! 36 max A, 40 min B, 44 max B, 48 u32 offset A, 52 offset B, 56 offset W,
//! 60 reserved. Then three S*S f32 arrays (index j*S + i): A = floor (or
//! island top), B = ceiling (or island bottom), W = water / lava surface.

use super::field::{sky_at, under_at};
use super::*;
use crate::atlas::format::{put_f32, put_u16, put_u32};
use crate::ground::Ground;

pub const S: usize = 65;
pub const HEADER: usize = 64;

/// A lazily built terrain sampler over a box (only tunnel mouths ask it).
pub struct TerrainSampler<'a, 'b> {
    a: &'b Atlas<'a>,
    bounds: [f64; 4],
    g: Option<Ground<'b>>,
}

impl<'a, 'b> TerrainSampler<'a, 'b> {
    pub fn new(a: &'b Atlas<'a>, x0: f64, z0: f64, x1: f64, z1: f64) -> Self {
        TerrainSampler { a, bounds: [x0, z0, x1, z1], g: None }
    }
    pub fn at(&mut self, x: f64, z: f64) -> f64 {
        let b = self.bounds;
        let a = self.a;
        let g = self.g.get_or_insert_with(|| Ground::new(a, b[0] - 2.0, b[1] - 2.0, b[2] + 2.0, b[3] + 2.0));
        g.lattice(x, z) as f64
    }
}

pub fn valid(layer: u8, cx: i32, cz: i32, lod: u32) -> bool {
    let step = 1i32 << lod.min(6);
    (1..=3).contains(&layer) && lod <= 6 && (0..64).contains(&cx) && (0..64).contains(&cz) && cx % step == 0 && cz % step == 0
}

pub fn build(a: &Atlas, p: &Plan, layer: u8, cx: i32, cz: i32, lod: u32) -> Result<Vec<u8>, String> {
    if !valid(layer, cx, cz, lod) {
        return Err(format!("layer tile ({layer}, {cx}, {cz}, lod {lod}) out of range"));
    }
    let step = (1u32 << lod) as f64;
    let (x0, z0) = (cx as f64 * 64.0, cz as f64 * 64.0);
    let span = 64.0 * step;
    let mut ts = TerrainSampler::new(a, x0, z0, x0 + span, z0 + span);
    let mut t = |x: f64, z: f64| ts.at(x, z);
    let len = HEADER + 3 * S * S * 4;
    let mut b = vec![0u8; len];
    let (mut min_a, mut max_a, mut min_b, mut max_b) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
    let mut flags = 0u32;
    for j in 0..S {
        for i in 0..S {
            let (x, z) = (x0 + i as f64 * step, z0 + j as f64 * step);
            let s = if layer == LAYER_SKY { sky_at(p, x, z) } else { under_at(p, layer, x, z, &mut t) };
            let (va, vb, vw) = (s.a as f32, s.b as f32, s.w as f32);
            let k = j * S + i;
            put_f32(&mut b, HEADER + k * 4, va);
            put_f32(&mut b, HEADER + (S * S + k) * 4, vb);
            put_f32(&mut b, HEADER + (2 * S * S + k) * 4, vw);
            min_a = min_a.min(va);
            max_a = max_a.max(va);
            min_b = min_b.min(vb);
            max_b = max_b.max(vb);
            let some = if layer == LAYER_SKY { va > vb } else { vb > va };
            if some {
                flags |= 1;
            }
            if layer != LAYER_SKY && vw > va {
                flags |= 2;
            }
        }
    }
    b[0..4].copy_from_slice(b"LDLT");
    put_u16(&mut b, 4, 1);
    put_u16(&mut b, 6, crate::GEN_VERSION);
    put_u32(&mut b, 8, len as u32);
    b[12] = layer;
    b[13] = lod as u8;
    put_u16(&mut b, 14, S as u16);
    put_u32(&mut b, 16, cx as u32);
    put_u32(&mut b, 20, cz as u32);
    put_f32(&mut b, 24, step as f32);
    put_u32(&mut b, 28, flags);
    put_f32(&mut b, 32, min_a);
    put_f32(&mut b, 36, max_a);
    put_f32(&mut b, 40, min_b);
    put_f32(&mut b, 44, max_b);
    put_u32(&mut b, 48, HEADER as u32);
    put_u32(&mut b, 52, (HEADER + S * S * 4) as u32);
    put_u32(&mut b, 56, (HEADER + 2 * S * S * 4) as u32);
    Ok(b)
}

/// Collision value of surface `surf` at (x, z): the triangle mesh over the
/// f32 lattice (`ground::tri_interp`), identical to interpolating LOD 0 tiles.
pub fn height(a: &Atlas, p: &Plan, surf: u32, x: f64, z: f64) -> f64 {
    let x0 = libm::floor(x);
    let z0 = libm::floor(z);
    let mut ts = TerrainSampler::new(a, x0, z0, x0 + 1.0, z0 + 1.0);
    let mut t = |x: f64, z: f64| ts.at(x, z);
    let h00 = super::field::lattice(p, surf, x0, z0, &mut t) as f64;
    let h10 = super::field::lattice(p, surf, x0 + 1.0, z0, &mut t) as f64;
    let h01 = super::field::lattice(p, surf, x0, z0 + 1.0, &mut t) as f64;
    let h11 = super::field::lattice(p, surf, x0 + 1.0, z0 + 1.0, &mut t) as f64;
    crate::ground::tri_interp(h00, h10, h01, h11, x - x0, z - z0)
}
