//! The vertical descriptor buffer (`LDVT`, format 1; byte layout in
//! worldgen/README.md "Vertical world"). Everything about the vertical world
//! that is not a lattice: hosts read openings, shafts, columns, islands and
//! the domain bitmaps for collision, updrafts for the movement step, the
//! rest for rendering, the map, enemies and mining.

use super::*;
use crate::atlas::format::{put_f32, put_u16, put_u32, put_u64};
use crate::cave::cell::write_vein;

pub const HEADER: usize = 128;
pub const ARCH: usize = 40;
pub const ISLAND: usize = 104;
pub const UPDRAFT: usize = 32;
pub const CHAMBER: usize = 72;
pub const CORRIDOR: usize = 32;
pub const POINT: usize = 12;
pub const OPENING: usize = 32;
pub const SHAFT: usize = 32;
pub const COLUMN: usize = 32;
pub const DECO: usize = 24;
pub const VEIN: usize = 32;
pub const DOMAIN: usize = CHUNKS * CHUNKS / 8;

fn f(b: &mut [u8], o: usize, v: f64) {
    put_f32(b, o, v as f32);
}

pub fn serialize(_a: &Atlas, p: &Plan) -> Vec<u8> {
    let n_pts: usize = p.corridors.iter().map(|r| r.pts.len()).sum();
    let sizes = [
        (p.archs.len(), ARCH),
        (p.islands.len(), ISLAND),
        (p.updrafts.len(), UPDRAFT),
        (p.chambers.len(), CHAMBER),
        (p.corridors.len(), CORRIDOR),
        (n_pts, POINT),
        (p.openings.len(), OPENING),
        (p.shafts.len(), SHAFT),
        (p.columns.len(), COLUMN),
        (p.decos.len(), DECO),
        (p.veins.len(), VEIN),
    ];
    let mut offs = [0usize; 11];
    let mut o = HEADER;
    for (k, &(n, sz)) in sizes.iter().enumerate() {
        offs[k] = o;
        o += (n * sz).div_ceil(8) * 8;
    }
    let dom = o;
    o += 3 * DOMAIN;
    let mut b = vec![0u8; o];
    b[0..4].copy_from_slice(b"LDVT");
    put_u16(&mut b, 4, 1);
    put_u16(&mut b, 6, crate::GEN_VERSION);
    put_u32(&mut b, 8, o as u32);
    for (k, &(n, _)) in sizes.iter().enumerate() {
        put_u32(&mut b, 12 + k * 4, n as u32);
        put_u32(&mut b, 56 + k * 4, offs[k] as u32);
    }
    put_u32(&mut b, 100, dom as u32);
    put_u32(&mut b, 104, p.base_sites as u32);
    put_f32(&mut b, 108, under::UNDER_FLOOR_MIN as f32);
    put_f32(&mut b, 112, under::DEPTHS_CEIL_MAX as f32);

    for (i, a) in p.archs.iter().enumerate() {
        let r = offs[0] + i * ARCH;
        put_u64(&mut b, r, a.id);
        f(&mut b, r + 8, a.x);
        f(&mut b, r + 12, a.z);
        f(&mut b, r + 16, a.r);
        f(&mut b, r + 20, a.base);
        f(&mut b, r + 24, a.cloud_y);
        put_u16(&mut b, r + 28, a.site);
        put_u16(&mut b, r + 30, a.first_island);
        put_u16(&mut b, r + 32, a.islands);
        put_u16(&mut b, r + 34, a.town);
    }
    for (i, s) in p.islands.iter().enumerate() {
        let r = offs[1] + i * ISLAND;
        put_u64(&mut b, r, s.id);
        for (k, v) in [s.x, s.z, s.r, s.reach, s.top, s.thick, s.cliff, s.amp].into_iter().enumerate() {
            f(&mut b, r + 8 + k * 4, v);
        }
        b[r + 40] = s.kind;
        b[r + 41] = s.lobes.len().min(4) as u8;
        put_u16(&mut b, r + 42, s.arch);
        put_u16(&mut b, r + 44, s.site);
        b[r + 46] = s.biome;
        put_u32(&mut b, r + 48, s.seed);
        for (k, l) in s.lobes.iter().take(4).enumerate() {
            f(&mut b, r + 52 + k * 12, l[0]);
            f(&mut b, r + 56 + k * 12, l[1]);
            f(&mut b, r + 60 + k * 12, l[2]);
        }
    }
    for (i, u) in p.updrafts.iter().enumerate() {
        let r = offs[2] + i * UPDRAFT;
        for (k, v) in [u.x, u.z, u.r, u.bottom, u.top, u.lift].into_iter().enumerate() {
            f(&mut b, r + k * 4, v);
        }
        b[r + 24] = u.kind;
        put_u16(&mut b, r + 26, u.arch);
    }
    for (i, c) in p.chambers.iter().enumerate() {
        let r = offs[3] + i * CHAMBER;
        put_u64(&mut b, r, c.id);
        let lake = if c.lake == NO_WATER { NO_WATER } else { c.lake };
        for (k, v) in [c.x, c.z, c.rx, c.rz, c.c, c.s, c.floor, c.height, lake, c.lake_e, c.lake_depth, c.reach].into_iter().enumerate() {
            f(&mut b, r + 8 + k * 4, v);
        }
        b[r + 56] = c.layer;
        b[r + 57] = c.kind;
        b[r + 58] = c.tint;
        put_u32(&mut b, r + 60, c.seed);
        put_u16(&mut b, r + 64, c.site);
    }
    let mut pi = 0usize;
    for (i, c) in p.corridors.iter().enumerate() {
        let r = offs[4] + i * CORRIDOR;
        b[r] = c.layer;
        b[r + 1] = c.kind;
        b[r + 2] = c.lava as u8;
        put_u16(&mut b, r + 4, c.from);
        put_u16(&mut b, r + 6, c.to);
        f(&mut b, r + 8, c.hw);
        f(&mut b, r + 12, c.height);
        f(&mut b, r + 16, c.water);
        put_u32(&mut b, r + 20, pi as u32);
        put_u32(&mut b, r + 24, c.pts.len() as u32);
        for q in &c.pts {
            let o = offs[5] + pi * POINT;
            f(&mut b, o, q[0]);
            f(&mut b, o + 4, q[1]);
            f(&mut b, o + 8, q[2]);
            pi += 1;
        }
    }
    for (i, op) in p.openings.iter().enumerate() {
        let r = offs[6] + i * OPENING;
        f(&mut b, r, op.x);
        f(&mut b, r + 4, op.z);
        f(&mut b, r + 8, op.r);
        f(&mut b, r + 12, op.y);
        b[r + 16] = op.into;
        b[r + 17] = op.kind;
        put_u16(&mut b, r + 18, op.yaw);
        put_u16(&mut b, r + 20, op.site);
        put_u16(&mut b, r + 22, op.target);
    }
    for (i, s) in p.shafts.iter().enumerate() {
        let r = offs[7] + i * SHAFT;
        for (k, v) in [s.x, s.z, s.r, s.bottom, s.top].into_iter().enumerate() {
            f(&mut b, r + k * 4, v);
        }
        put_u16(&mut b, r + 20, s.chamber);
    }
    for (i, c) in p.columns.iter().enumerate() {
        let r = offs[8] + i * COLUMN;
        for (k, v) in [c.x, c.z, c.r, c.y0, c.y1].into_iter().enumerate() {
            f(&mut b, r + k * 4, v);
        }
        b[r + 20] = c.layer;
        put_u16(&mut b, r + 22, c.chamber);
    }
    for (i, d) in p.decos.iter().enumerate() {
        let r = offs[9] + i * DECO;
        for (k, v) in [d.x, d.y, d.z, d.size].into_iter().enumerate() {
            f(&mut b, r + k * 4, v);
        }
        b[r + 16] = d.kind;
        b[r + 17] = d.tint;
        b[r + 18] = d.layer;
        b[r + 19] = d.flags;
        put_u16(&mut b, r + 20, d.yaw);
        put_u16(&mut b, r + 22, d.aux);
    }
    for (i, v) in p.veins.iter().enumerate() {
        write_vein(&mut b, offs[10] + i * VEIN, v);
    }
    for layer in 1..=3u8 {
        let base = dom + (layer as usize - 1) * DOMAIN;
        for cz in 0..CHUNKS {
            for cx in 0..CHUNKS {
                if p.domain(layer, cx as i64, cz as i64) {
                    let k = cz * CHUNKS + cx;
                    b[base + k / 8] |= 1 << (k % 8);
                }
            }
        }
    }
    b
}
