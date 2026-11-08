//! `cave_build(atlas, cx, cy, cz)` (spec 5/7): one cave volume cell, 64 x 32
//! x 64 m, sampled every 2 m (33 x 17 x 33 samples) and meshed with surface
//! nets inside the module, so the client renders and the server collides
//! against identical triangles. Layout of the output buffer: worldgen/README.md
//! "Cave cell buffer".
//!
//! Seams: each cell also samples one extra layer on its low x, y and z sides
//! and owns exactly the sample edges whose base lies in [0, 32) x [0, 16) x
//! [0, 32). Every quad a cell emits is built from cubes it can see, and the
//! field is a pure function of world position, so the vertices it shares
//! with a neighbor are bit-identical and the meshes close without stitching.
//!
//! Mouths: within an opening's zone the volume also treats everything above
//! the terrain surface as air, so it reproduces the hillside around the hole
//! (the heightfield drops its triangles inside the mask radius). Elsewhere a
//! roof clamp keeps 2.5 m of rock under the surface no matter what noise
//! does. Triangles of the reproduced surface beyond mask + 2 m are dropped,
//! leaving a 2 m overlap ring under the rock-arch prop.

use super::field::{eval, Elem, FAR};
use super::graph::{band_of, CaveWorld, Opening};
use super::veins::VEIN_MINED;
use crate::atlas::format::{put_f32, put_u16, put_u32, put_u64, Atlas};
use crate::ground::Ground;

pub const CELL_W: f64 = 64.0;
pub const CELL_H: f64 = 32.0;
pub const SAMPLE: f64 = 2.0;
/// Output samples per edge (x/z) and vertically.
pub const NX: usize = 33;
pub const NY: usize = 17;
/// Padded sample grid (one extra layer on the low side).
const PX: usize = NX + 1;
const PY: usize = NY + 1;
/// Cubes: i in [-1, 31], j in [-1, 15].
const CX: usize = NX;
const CY: usize = NY;
/// Collision column bins (2 m) over local x/z in [-2, 66).
pub const BINS: usize = 34;

pub const CY_MIN: i32 = -8;
pub const CY_MAX: i32 = 23;

pub const MAGIC: [u8; 4] = *b"LDCV";
pub const FORMAT: u16 = 1;
pub const HEADER: usize = 96;
pub const VEIN_REC: usize = 32;
pub const DECO_REC: usize = 16;
pub const EDIT_REC: usize = 32;

pub const FLAG_MESH: u32 = 1;
pub const FLAG_ZONE: u32 = 2;
pub const FLAG_EDITED: u32 = 4;

/// Roof clamp: rock kept under the surface outside mouth zones.
const ROOF_CLAMP: f64 = 2.5;
/// Triangles of the reproduced surface are kept out to r_mask + this.
const SURFACE_KEEP: f64 = 2.0;

/// A carve edit (spec 7: mining carves a 1.5 m sphere, restored on respawn).
#[derive(Clone, Copy, Debug)]
pub struct Edit {
    pub vein_id: u64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub r: f64,
}

pub fn parse_edits(b: &[u8]) -> Vec<Edit> {
    use crate::atlas::format::{get_f32, get_u64};
    b.chunks_exact(EDIT_REC)
        .map(|e| Edit {
            vein_id: get_u64(e, 0),
            x: get_f32(e, 8) as f64,
            y: get_f32(e, 12) as f64,
            z: get_f32(e, 16) as f64,
            r: (get_f32(e, 20) as f64).clamp(0.0, 4.0),
        })
        .filter(|e| e.x.is_finite() && e.y.is_finite() && e.z.is_finite() && e.r.is_finite())
        .collect()
}

#[inline]
fn sidx(i: i32, j: i32, k: i32) -> usize {
    (((j + 1) as usize * PX) + (k + 1) as usize) * PX + (i + 1) as usize
}

#[inline]
fn cidx(i: i32, j: i32, k: i32) -> usize {
    (((j + 1) as usize * CX) + (k + 1) as usize) * CX + (i + 1) as usize
}

pub fn valid_cell(cx: i32, cy: i32, cz: i32) -> bool {
    (0..64).contains(&cx) && (0..64).contains(&cz) && (CY_MIN..=CY_MAX).contains(&cy)
}

pub fn build(a: &Atlas, w: &CaveWorld, cx: i32, cy: i32, cz: i32, edits: &[Edit]) -> Result<Vec<u8>, String> {
    if !valid_cell(cx, cy, cz) {
        return Err(format!("cave cell ({cx},{cy},{cz}) outside 0..63 x {CY_MIN}..{CY_MAX} x 0..63"));
    }
    let ox = cx as f64 * CELL_W;
    let oy = cy as f64 * CELL_H;
    let oz = cz as f64 * CELL_W;
    // Padded sample box plus the noise/smooth margins already in each AABB.
    let pbox = [ox - SAMPLE, oy - SAMPLE, oz - SAMPLE, ox + CELL_W, oy + CELL_H, oz + CELL_W];

    // Elements touching the cell, in (system, element) order; the systems
    // they belong to decide which openings scale the noise.
    let mut elems: Vec<Elem> = Vec::new();
    let mut sys_in: Vec<u16> = Vec::new();
    for s in &w.systems {
        if s.bbox[0] > pbox[3] || s.bbox[3] < pbox[0] || s.bbox[1] > pbox[4] || s.bbox[4] < pbox[1] || s.bbox[2] > pbox[5] || s.bbox[5] < pbox[2] {
            continue;
        }
        let before = elems.len();
        elems.extend(s.elems.iter().filter(|e| e.overlaps(&pbox)).copied());
        if elems.len() > before {
            sys_in.push(s.index);
        }
    }
    let noise_open: Vec<Opening> = sys_in.iter().flat_map(|&si| w.systems[si as usize].openings.iter().copied()).collect();
    // Openings whose zone reaches this cell's columns and height.
    let zones: Vec<Opening> = w
        .openings()
        .filter(|o| {
            let nx = o.x.clamp(pbox[0], pbox[3]);
            let nz = o.z.clamp(pbox[2], pbox[5]);
            (nx - o.x) * (nx - o.x) + (nz - o.z) * (nz - o.z) < o.r_zone * o.r_zone && o.y + 24.0 > pbox[1] && o.y - 24.0 < pbox[4]
        })
        .copied()
        .collect();
    let carves: Vec<Edit> = edits
        .iter()
        .filter(|e| e.x + e.r >= pbox[0] && e.x - e.r <= pbox[3] && e.y + e.r >= pbox[1] && e.y - e.r <= pbox[4] && e.z + e.r >= pbox[2] && e.z - e.r <= pbox[5])
        .copied()
        .collect();

    // Surface heights at the 2 m columns: the heightfield lattice values,
    // needed for mouth zones and for the roof clamp near the surface.
    let mut hcol: Vec<f64> = Vec::new();
    let need_h = !zones.is_empty() || {
        let top = elems.iter().map(|e| e.aabb[4]).fold(f64::MIN, f64::max);
        !elems.is_empty() && {
            let g = Ground::new(a, ox, oz, ox, oz);
            let mut lo = f64::MAX;
            for (x, z) in [(ox, oz), (ox + CELL_W, oz), (ox, oz + CELL_W), (ox + CELL_W, oz + CELL_W), (ox + 32.0, oz + 32.0)] {
                lo = lo.min(g.macro_h(x, z));
            }
            top > lo - 75.0
        }
    };
    if need_h {
        let g = Ground::new(a, ox - SAMPLE, oz - SAMPLE, ox + CELL_W, oz + CELL_W);
        hcol.reserve(PX * PX);
        for k in -1..=32i32 {
            for i in -1..=32i32 {
                hcol.push(g.lattice(ox + SAMPLE * i as f64, oz + SAMPLE * k as f64) as f64);
            }
        }
    }

    // ---- sample the padded field
    let mut field = vec![FAR as f32; PX * PY * PX];
    let any = !elems.is_empty() || !zones.is_empty() || !carves.is_empty();
    if any {
        for k in -1..=32i32 {
            let z = oz + SAMPLE * k as f64;
            for i in -1..=32i32 {
                let x = ox + SAMPLE * i as f64;
                let ns = noise_open.iter().map(|o| o.noise_scale(x, z)).fold(1.0, f64::min);
                let (h, in_zone) = if need_h {
                    let h = hcol[((k + 1) as usize) * PX + (i + 1) as usize];
                    let inz = zones.iter().any(|o| (x - o.x) * (x - o.x) + (z - o.z) * (z - o.z) < o.r_zone * o.r_zone);
                    (h, inz)
                } else {
                    (0.0, false)
                };
                for j in -1..=16i32 {
                    let y = oy + SAMPLE * j as f64;
                    let p = [x, y, z];
                    let mut f = if elems.is_empty() { FAR } else { eval(&elems, w.noise_seed, p, ns) };
                    if need_h {
                        if in_zone {
                            f = f.min(h - y);
                        } else {
                            f = f.max(y - (h - ROOF_CLAMP));
                        }
                    }
                    for e in &carves {
                        let d = libm::sqrt((x - e.x) * (x - e.x) + (y - e.y) * (y - e.y) + (z - e.z) * (z - e.z)) - e.r;
                        f = f.min(d);
                    }
                    field[sidx(i, j, k)] = f.clamp(-FAR, FAR) as f32;
                }
            }
        }
    }

    // ---- surface nets
    let mut vmap = vec![u16::MAX; CX * CY * CX];
    let mut pos: Vec<[f64; 3]> = Vec::new();
    let mut nrm: Vec<[f64; 3]> = Vec::new();
    let mut tris: Vec<[u16; 3]> = Vec::new();
    let fv = |i: i32, j: i32, k: i32| field[sidx(i, j, k)] as f64;

    let mut vertex = |i: i32, j: i32, k: i32, pos: &mut Vec<[f64; 3]>, nrm: &mut Vec<[f64; 3]>| -> u16 {
        let ci = cidx(i, j, k);
        if vmap[ci] != u16::MAX {
            return vmap[ci];
        }
        let mut c = [0.0f64; 8];
        for (n, cv) in c.iter_mut().enumerate() {
            *cv = fv(i + (n & 1) as i32, j + ((n >> 1) & 1) as i32, k + ((n >> 2) & 1) as i32);
        }
        // 12 cube edges as corner pairs (bit 0 = x, 1 = y, 2 = z).
        const EDGES: [(usize, usize); 12] = [(0, 1), (2, 3), (4, 5), (6, 7), (0, 2), (1, 3), (4, 6), (5, 7), (0, 4), (1, 5), (2, 6), (3, 7)];
        let (mut sx, mut sy, mut sz, mut cnt) = (0.0, 0.0, 0.0, 0.0);
        for &(e0, e1) in EDGES.iter() {
            let (f0, f1) = (c[e0], c[e1]);
            if (f0 < 0.0) != (f1 < 0.0) {
                let t = f0 / (f0 - f1);
                let p0 = [(e0 & 1) as f64, ((e0 >> 1) & 1) as f64, ((e0 >> 2) & 1) as f64];
                let p1 = [(e1 & 1) as f64, ((e1 >> 1) & 1) as f64, ((e1 >> 2) & 1) as f64];
                sx += p0[0] + (p1[0] - p0[0]) * t;
                sy += p0[1] + (p1[1] - p0[1]) * t;
                sz += p0[2] + (p1[2] - p0[2]) * t;
                cnt += 1.0;
            }
        }
        let (lx, ly, lz) = if cnt > 0.0 { (sx / cnt, sy / cnt, sz / cnt) } else { (0.5, 0.5, 0.5) };
        let p = [
            (ox + SAMPLE * (i as f64 + lx)) as f32 as f64,
            (oy + SAMPLE * (j as f64 + ly)) as f32 as f64,
            (oz + SAMPLE * (k as f64 + lz)) as f32 as f64,
        ];
        // Gradient of the trilinear field at the cube center; rock is
        // positive, so the air-facing normal is minus the gradient.
        let gx = (c[1] + c[3] + c[5] + c[7]) - (c[0] + c[2] + c[4] + c[6]);
        let gy = (c[2] + c[3] + c[6] + c[7]) - (c[0] + c[1] + c[4] + c[5]);
        let gz = (c[4] + c[5] + c[6] + c[7]) - (c[0] + c[1] + c[2] + c[3]);
        let l = libm::sqrt(gx * gx + gy * gy + gz * gz);
        let n = if l > 1e-12 { [-gx / l, -gy / l, -gz / l] } else { [0.0, 1.0, 0.0] };
        let id = pos.len() as u16;
        pos.push(p);
        nrm.push(n);
        vmap[ci] = id;
        id
    };

    if any {
        for j in 0..16i32 {
            for k in 0..32i32 {
                for i in 0..32i32 {
                    let f0 = fv(i, j, k);
                    let s0 = f0 < 0.0;
                    // (far sample, the 4 cubes around the edge in +axis winding order)
                    let quads: [((i32, i32, i32), [(i32, i32, i32); 4]); 3] = [
                        ((i + 1, j, k), [(i, j - 1, k - 1), (i, j, k - 1), (i, j, k), (i, j - 1, k)]),
                        ((i, j + 1, k), [(i - 1, j, k - 1), (i - 1, j, k), (i, j, k), (i, j, k - 1)]),
                        ((i, j, k + 1), [(i - 1, j - 1, k), (i, j - 1, k), (i, j, k), (i - 1, j, k)]),
                    ];
                    for (far, cubes) in quads.iter() {
                        let s1 = fv(far.0, far.1, far.2) < 0.0;
                        if s0 == s1 {
                            continue;
                        }
                        let v: Vec<u16> = cubes.iter().map(|c| vertex(c.0, c.1, c.2, &mut pos, &mut nrm)).collect();
                        // Air on the far (+axis) side keeps the winding.
                        let (a0, a1, a2, a3) = if !s0 && s1 { (v[0], v[1], v[2], v[3]) } else { (v[0], v[3], v[2], v[1]) };
                        tris.push([a0, a1, a2]);
                        tris.push([a0, a2, a3]);
                    }
                }
            }
        }
    }

    // ---- drop reproduced-surface triangles beyond the kept ring
    if !zones.is_empty() && !hcol.is_empty() {
        let hat = |x: f64, z: f64| -> f64 {
            let u = ((x - ox) / SAMPLE + 1.0).clamp(0.0, (PX - 1) as f64);
            let v = ((z - oz) / SAMPLE + 1.0).clamp(0.0, (PX - 1) as f64);
            let i0 = (libm::floor(u) as usize).min(PX - 2);
            let k0 = (libm::floor(v) as usize).min(PX - 2);
            let (fu, fv2) = (u - i0 as f64, v - k0 as f64);
            let h00 = hcol[k0 * PX + i0];
            let h10 = hcol[k0 * PX + i0 + 1];
            let h01 = hcol[(k0 + 1) * PX + i0];
            let h11 = hcol[(k0 + 1) * PX + i0 + 1];
            h00 + (h10 - h00) * fu + (h01 - h00) * fv2 + (h00 - h10 - h01 + h11) * fu * fv2
        };
        tris.retain(|t| {
            let (p0, p1, p2) = (pos[t[0] as usize], pos[t[1] as usize], pos[t[2] as usize]);
            let gx = (p0[0] + p1[0] + p2[0]) / 3.0;
            let gy = (p0[1] + p1[1] + p2[1]) / 3.0;
            let gz = (p0[2] + p1[2] + p2[2]) / 3.0;
            let near = zones.iter().any(|o| {
                let r = o.r_mask + SURFACE_KEEP;
                (gx - o.x) * (gx - o.x) + (gz - o.z) * (gz - o.z) <= r * r
            });
            near || gy <= hat(gx, gz) - 1.2
        });
    }

    // Compact away vertices only dropped triangles used, so the buffer has
    // no orphans (renderers bound-check, colliders never see them).
    let mut remap = vec![u16::MAX; pos.len()];
    let mut cpos: Vec<[f64; 3]> = Vec::new();
    let mut cnrm: Vec<[f64; 3]> = Vec::new();
    for t in tris.iter_mut() {
        for v in t.iter_mut() {
            let o = *v as usize;
            if remap[o] == u16::MAX {
                remap[o] = cpos.len() as u16;
                cpos.push(pos[o]);
                cnrm.push(nrm[o]);
            }
            *v = remap[o];
        }
    }

    // ---- collision columns (CSR): triangle ids per 2 m xz bin
    let bin = |v: f64, o: f64| -> usize { (libm::floor((v - o + SAMPLE) / SAMPLE).max(0.0) as usize).min(BINS - 1) };
    let mut counts = vec![0u32; BINS * BINS];
    let ranges: Vec<(usize, usize, usize, usize)> = tris
        .iter()
        .map(|t| {
            let ps = [cpos[t[0] as usize], cpos[t[1] as usize], cpos[t[2] as usize]];
            let (mut x0, mut x1, mut z0, mut z1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
            for p in ps {
                x0 = x0.min(p[0]);
                x1 = x1.max(p[0]);
                z0 = z0.min(p[2]);
                z1 = z1.max(p[2]);
            }
            (bin(x0, ox), bin(x1, ox), bin(z0, oz), bin(z1, oz))
        })
        .collect();
    for &(a0, a1, b0, b1) in &ranges {
        for bz in b0..=b1 {
            for bx in a0..=a1 {
                counts[bz * BINS + bx] += 1;
            }
        }
    }
    let mut offs = vec![0u32; BINS * BINS + 1];
    for k in 0..BINS * BINS {
        offs[k + 1] = offs[k] + counts[k];
    }
    let mut fill = offs.clone();
    let mut col_tris = vec![0u32; offs[BINS * BINS] as usize];
    for (ti, &(a0, a1, b0, b1)) in ranges.iter().enumerate() {
        for bz in b0..=b1 {
            for bx in a0..=a1 {
                let k = bz * BINS + bx;
                col_tris[fill[k] as usize] = ti as u32;
                fill[k] += 1;
            }
        }
    }

    // ---- veins and decorations owned by this cell (position inside it)
    let inside = |x: f64, y: f64, z: f64| x >= ox && x < ox + CELL_W && y >= oy && y < oy + CELL_H && z >= oz && z < oz + CELL_W;
    let mut veins = Vec::new();
    let mut decos = Vec::new();
    let mut sys_main = u16::MAX;
    let mut band = 0u8;
    for &si in &sys_in {
        let s = &w.systems[si as usize];
        if sys_main == u16::MAX {
            sys_main = si;
            band = band_of(s.mouth_y - (oy + CELL_H * 0.5));
        }
        veins.extend(s.veins.iter().filter(|v| inside(v.x, v.y, v.z)).copied());
        decos.extend(s.decos.iter().filter(|d| inside(d.x, d.y, d.z)).copied());
    }
    for v in veins.iter_mut() {
        if edits.iter().any(|e| e.vein_id == v.id) {
            v.flags |= VEIN_MINED;
        }
    }

    // ---- serialize
    let nv = cpos.len();
    let nt = tris.len();
    let dens_off = HEADER;
    let dens_len = NX * NY * NX;
    let pos_off = align(dens_off + dens_len, 8);
    let nrm_off = pos_off + nv * 12;
    let idx_off = nrm_off + nv * 4;
    let col_off = align(idx_off + nt * 6, 8);
    let col_len = (BINS * BINS + 1) * 4 + col_tris.len() * 4;
    let vein_off = align(col_off + col_len, 8);
    let deco_off = vein_off + veins.len() * VEIN_REC;
    let total = align(deco_off + decos.len() * DECO_REC, 8);
    let mut b = vec![0u8; total];
    b[0..4].copy_from_slice(&MAGIC);
    put_u16(&mut b, 4, FORMAT);
    put_u16(&mut b, 6, crate::GEN_VERSION);
    put_u32(&mut b, 8, total as u32);
    put_u32(&mut b, 12, cx as u32);
    put_u32(&mut b, 16, cy as u32);
    put_u32(&mut b, 20, cz as u32);
    let mut flags = 0;
    if nt > 0 {
        flags |= FLAG_MESH;
    }
    if !zones.is_empty() {
        flags |= FLAG_ZONE;
    }
    if !edits.is_empty() {
        flags |= FLAG_EDITED;
    }
    put_u32(&mut b, 24, flags);
    put_u32(&mut b, 28, nv as u32);
    put_u32(&mut b, 32, nt as u32);
    put_u32(&mut b, 36, dens_off as u32);
    put_u32(&mut b, 40, pos_off as u32);
    put_u32(&mut b, 44, nrm_off as u32);
    put_u32(&mut b, 48, idx_off as u32);
    put_u32(&mut b, 52, col_off as u32);
    put_u32(&mut b, 56, col_len as u32);
    put_u32(&mut b, 60, vein_off as u32);
    put_u16(&mut b, 64, veins.len() as u16);
    put_u16(&mut b, 66, decos.len() as u16);
    put_u32(&mut b, 68, deco_off as u32);
    put_u16(&mut b, 72, sys_main);
    b[74] = band;
    let (mut ymin, mut ymax) = (0.0f32, 0.0f32);
    if nv > 0 {
        ymin = f32::MAX;
        ymax = f32::MIN;
        for p in &cpos {
            ymin = ymin.min(p[1] as f32);
            ymax = ymax.max(p[1] as f32);
        }
    }
    put_f32(&mut b, 76, ymin);
    put_f32(&mut b, 80, ymax);
    // Density: i8, field clamped to +-8 m in 1/16 m steps, index (j*33 + k)*33 + i.
    for j in 0..NY as i32 {
        for k in 0..NX as i32 {
            for i in 0..NX as i32 {
                let f = field[sidx(i, j, k)] as f64;
                let q = libm::round(f * 15.875).clamp(-127.0, 127.0) as i8;
                b[dens_off + ((j as usize * NX) + k as usize) * NX + i as usize] = q as u8;
            }
        }
    }
    for (n, p) in cpos.iter().enumerate() {
        put_f32(&mut b, pos_off + n * 12, p[0] as f32);
        put_f32(&mut b, pos_off + n * 12 + 4, p[1] as f32);
        put_f32(&mut b, pos_off + n * 12 + 8, p[2] as f32);
    }
    for (n, nn) in cnrm.iter().enumerate() {
        let o = nrm_off + n * 4;
        b[o] = snorm8(nn[0]);
        b[o + 1] = snorm8(nn[1]);
        b[o + 2] = snorm8(nn[2]);
        let vy = cpos[n][1];
        b[o + 3] = if sys_main == u16::MAX { 0 } else { band_of(w.systems[sys_main as usize].mouth_y - vy) };
    }
    for (n, t) in tris.iter().enumerate() {
        for (c, v) in t.iter().enumerate() {
            put_u16(&mut b, idx_off + n * 6 + c * 2, *v);
        }
    }
    for (n, o) in offs.iter().enumerate() {
        put_u32(&mut b, col_off + n * 4, *o);
    }
    let tri_base = col_off + (BINS * BINS + 1) * 4;
    for (n, t) in col_tris.iter().enumerate() {
        put_u32(&mut b, tri_base + n * 4, *t);
    }
    for (n, v) in veins.iter().enumerate() {
        write_vein(&mut b, vein_off + n * VEIN_REC, v);
    }
    for (n, d) in decos.iter().enumerate() {
        let o = deco_off + n * DECO_REC;
        put_f32(&mut b, o, d.x as f32);
        put_f32(&mut b, o + 4, d.y as f32);
        put_f32(&mut b, o + 8, d.z as f32);
        b[o + 12] = d.kind;
        b[o + 13] = d.variant;
        b[o + 14] = d.scale;
        b[o + 15] = d.yaw;
    }
    Ok(b)
}

pub fn write_vein(b: &mut [u8], o: usize, v: &super::veins::Vein) {
    put_u64(b, o, v.id);
    put_f32(b, o + 8, v.x as f32);
    put_f32(b, o + 12, v.y as f32);
    put_f32(b, o + 16, v.z as f32);
    b[o + 20] = snorm8(v.n[0]);
    b[o + 21] = snorm8(v.n[1]);
    b[o + 22] = snorm8(v.n[2]);
    b[o + 23] = v.kind;
    b[o + 24] = v.material;
    b[o + 25] = v.element;
    put_u16(b, o + 26, v.hp);
    b[o + 28] = v.size;
    b[o + 29] = v.flags;
    b[o + 30] = v.band;
    b[o + 31] = (v.chamber & 0xFF) as u8;
}

#[inline]
fn snorm8(v: f64) -> u8 {
    (libm::round(v.clamp(-1.0, 1.0) * 127.0) as i8) as u8
}

#[inline]
pub fn align(v: usize, a: usize) -> usize {
    v.div_ceil(a) * a
}
