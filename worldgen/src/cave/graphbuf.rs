//! Serialized cave graph (`cave_graph(atlas)`, layout in worldgen/README.md
//! "Cave graph buffer"): every system's chambers, tunnels, openings and
//! veins. Hosts use it as the enemy navigation graph, for mouth masks, for
//! the cave-system id query (AOI clipping, voice earshot) and as the zone's
//! vein registry. Everything is f32 so every host reads identical values,
//! and the queries below run on the serialized values, not the f64 build.

use super::cell::{align, write_vein, VEIN_REC};
use super::graph::CaveWorld;
use crate::atlas::format::{get_f32, get_u16, get_u32, put_f32, put_u16, put_u32, put_u64};

pub const MAGIC: [u8; 4] = *b"LDCG";
pub const FORMAT: u16 = 1;
pub const HEADER: usize = 64;
pub const SYS_REC: usize = 72;
pub const CH_REC: usize = 32;
pub const TUN_REC: usize = 72;
pub const OPEN_REC: usize = 32;

pub fn serialize(w: &CaveWorld) -> Vec<u8> {
    let ns = w.systems.len();
    let nc: usize = w.systems.iter().map(|s| s.chambers.len()).sum();
    let nt: usize = w.systems.iter().map(|s| s.tunnels.len()).sum();
    let no: usize = w.systems.iter().map(|s| s.openings.len()).sum();
    let nv: usize = w.systems.iter().map(|s| s.veins.len()).sum();
    let sys_off = HEADER;
    let ch_off = sys_off + ns * SYS_REC;
    let tun_off = ch_off + nc * CH_REC;
    let open_off = tun_off + nt * TUN_REC;
    let vein_off = open_off + no * OPEN_REC;
    let total = align(vein_off + nv * VEIN_REC, 8);
    let mut b = vec![0u8; total];
    b[0..4].copy_from_slice(&MAGIC);
    put_u16(&mut b, 4, FORMAT);
    put_u16(&mut b, 6, crate::GEN_VERSION);
    put_u32(&mut b, 8, total as u32);
    put_u32(&mut b, 12, ns as u32);
    put_u32(&mut b, 16, nc as u32);
    put_u32(&mut b, 20, nt as u32);
    put_u32(&mut b, 24, no as u32);
    put_u32(&mut b, 28, nv as u32);
    put_u32(&mut b, 32, sys_off as u32);
    put_u32(&mut b, 36, ch_off as u32);
    put_u32(&mut b, 40, tun_off as u32);
    put_u32(&mut b, 44, open_off as u32);
    put_u32(&mut b, 48, vein_off as u32);
    put_f32(&mut b, 52, w.cave_max_depth as f32);
    put_f32(&mut b, 56, w.gem_rarity_curve as f32);
    let (mut c0, mut t0, mut o0, mut v0) = (0usize, 0usize, 0usize, 0usize);
    for (si, s) in w.systems.iter().enumerate() {
        let o = sys_off + si * SYS_REC;
        put_u64(&mut b, o, s.id);
        put_u16(&mut b, o + 8, s.site_index);
        b[o + 10] = s.region;
        b[o + 11] = s.biome;
        b[o + 12] = s.elem;
        b[o + 13] = s.elem2;
        b[o + 14] = 0;
        b[o + 15] = super::graph::band_of(s.max_depth);
        put_f32(&mut b, o + 16, s.mouth_y as f32);
        put_u32(&mut b, o + 20, c0 as u32);
        put_u16(&mut b, o + 24, s.chambers.len() as u16);
        put_u16(&mut b, o + 26, s.tunnels.len() as u16);
        put_u32(&mut b, o + 28, t0 as u32);
        put_u16(&mut b, o + 32, o0 as u16);
        put_u16(&mut b, o + 34, s.openings.len() as u16);
        put_u32(&mut b, o + 36, v0 as u32);
        put_u16(&mut b, o + 40, s.veins.len() as u16);
        put_u16(&mut b, o + 42, s.deepest);
        for k in 0..6 {
            put_f32(&mut b, o + 44 + k * 4, s.bbox[k] as f32);
        }
        put_f32(&mut b, o + 68, s.max_depth as f32);
        for (k, c) in s.chambers.iter().enumerate() {
            let q = ch_off + (c0 + k) * CH_REC;
            for (n, v) in [c.x, c.y, c.z, c.rx, c.ry, c.floor, c.depth].iter().enumerate() {
                put_f32(&mut b, q + n * 4, *v as f32);
            }
            b[q + 28] = c.flags;
            b[q + 29] = c.band();
            put_u16(&mut b, q + 30, c.parent);
        }
        for (k, t) in s.tunnels.iter().enumerate() {
            let q = tun_off + (t0 + k) * TUN_REC;
            put_u16(&mut b, q, t.a);
            put_u16(&mut b, q + 2, t.b);
            b[q + 4] = t.kind;
            put_f32(&mut b, q + 8, t.r as f32);
            put_f32(&mut b, q + 12, t.stretch as f32);
            put_f32(&mut b, q + 16, t.floor_k.min(1.0e6) as f32);
            for (pi, p) in t.pts.iter().enumerate() {
                for c in 0..3 {
                    put_f32(&mut b, q + 20 + pi * 12 + c * 4, p[c] as f32);
                }
            }
        }
        for (k, op) in s.openings.iter().enumerate() {
            let q = open_off + (o0 + k) * OPEN_REC;
            put_f32(&mut b, q, op.x as f32);
            put_f32(&mut b, q + 4, op.y as f32);
            put_f32(&mut b, q + 8, op.z as f32);
            put_f32(&mut b, q + 12, op.r_mask as f32);
            put_f32(&mut b, q + 16, op.r_zone as f32);
            put_u16(&mut b, q + 20, op.system);
            put_u16(&mut b, q + 22, op.tunnel);
            b[q + 24] = op.kind;
            put_u16(&mut b, q + 26, op.yaw);
        }
        for (k, v) in s.veins.iter().enumerate() {
            write_vein(&mut b, vein_off + (v0 + k) * VEIN_REC, v);
        }
        c0 += s.chambers.len();
        t0 += s.tunnels.len();
        o0 += s.openings.len();
        v0 += s.veins.len();
    }
    b
}

/// Read-only view used by the queries (and mirrored by the TS and Go readers).
pub struct GraphView<'a> {
    pub b: &'a [u8],
}

impl GraphView<'_> {
    fn u32(&self, o: usize) -> usize {
        get_u32(self.b, o) as usize
    }
    fn f(&self, o: usize) -> f64 {
        get_f32(self.b, o) as f64
    }
    pub fn systems(&self) -> usize {
        self.u32(12)
    }

    /// Which cave system contains p (index), or -1. A point counts as inside
    /// when it is within 2 m of a chamber's or tunnel's air (no noise), so
    /// it is answerable from the graph alone, in microseconds, without any
    /// mesh. See README "Cave-system id".
    pub fn system_at(&self, x: f64, y: f64, z: f64) -> i32 {
        const PAD: f64 = 2.0;
        let (sys_off, ch_off, tun_off) = (self.u32(32), self.u32(36), self.u32(40));
        for s in 0..self.systems() {
            let o = sys_off + s * SYS_REC;
            if x < self.f(o + 44) || y < self.f(o + 48) || z < self.f(o + 52) || x > self.f(o + 56) || y > self.f(o + 60) || z > self.f(o + 64) {
                continue;
            }
            let c0 = self.u32(o + 20);
            let nc = get_u16(self.b, o + 24) as usize;
            for k in 0..nc {
                let q = ch_off + (c0 + k) * CH_REC;
                let (cx, cy, cz, rx, ry, floor) = (self.f(q), self.f(q + 4), self.f(q + 8), self.f(q + 12), self.f(q + 16), self.f(q + 20));
                if y < floor - PAD {
                    continue;
                }
                let dx = (x - cx) / (rx + PAD);
                let dy = (y - cy) / (ry + PAD);
                let dz = (z - cz) / (rx + PAD);
                if dx * dx + dy * dy + dz * dz <= 1.0 {
                    return s as i32;
                }
            }
            let t0 = self.u32(o + 28);
            let nt = get_u16(self.b, o + 26) as usize;
            for k in 0..nt {
                let q = tun_off + (t0 + k) * TUN_REC;
                let (r, stretch) = (self.f(q + 8), self.f(q + 12));
                for sgi in 0..3 {
                    let pa = q + 20 + sgi * 12;
                    let pb = pa + 12;
                    let (ax, ay, az) = (self.f(pa), self.f(pa + 4) / stretch, self.f(pa + 8));
                    let (bx, by, bz) = (self.f(pb), self.f(pb + 4) / stretch, self.f(pb + 8));
                    let (px, py, pz) = (x, y / stretch, z);
                    let (ex, ey, ez) = (bx - ax, by - ay, bz - az);
                    let l2 = ex * ex + ey * ey + ez * ez;
                    let t = if l2 > 0.0 {
                        (((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / l2).clamp(0.0, 1.0)
                    } else {
                        0.0
                    };
                    let (qx, qy, qz) = (ax + ex * t - px, ay + ey * t - py, az + ez * t - pz);
                    let rr = r + PAD;
                    if qx * qx + qy * qy + qz * qz <= rr * rr {
                        return s as i32;
                    }
                }
            }
        }
        -1
    }
}
