//! Pass 2: chunk detail, on demand (spec 5). Output layout is documented byte
//! for byte in worldgen/README.md; offsets live in the header so readers never
//! hard-code them.
//!
//! A chunk at LOD `l` is a 65 x 65 lattice with spacing 2^l m starting at
//! (cx * 64, cz * 64), so it covers 64 * 2^l m and cx, cz must be multiples of
//! 2^l (quadtree tiles). Every LOD samples the same `Ground::sample`, so the
//! vertices a coarse tile shares with fine tiles have identical heights and
//! seams match. Scatter, containers and spawn anchors exist only at LOD 0.

use crate::atlas::format::{put_f32, put_u16, put_u32, put_u64, site as S, Atlas, SiteRec, N, RES};
use crate::atlas::region_of;
use crate::atlas::terrain::seed32;
use crate::gen::constants::{CHUNK_SAMPLES, CHUNK_SIZE_M};
use crate::ground::{tri_interp, tri_normal, Ground};
use crate::noise::{noise, smoothstep};
use crate::rng::{hash, mix64, stable_id, unit, unit2, weighted_pick};

pub const MAGIC: [u8; 4] = *b"LDCK";
pub const FORMAT_VERSION: u16 = 1;
pub const HEADER_LEN: usize = 64;
pub const S_: usize = CHUNK_SAMPLES as usize;
pub const SS: usize = S_ * S_;
pub const REC: usize = 24;
pub const MAX_LOD: u32 = 6;
/// Valid chunk coordinates. The world is chunks 0..64; a ring outside it is
/// allowed so the renderer can draw sea floor past the edge.
pub const CHUNK_MIN: i32 = -64;
pub const CHUNK_MAX: i32 = 128;

/// Material layer order in the splat planes.
pub const MAT_GRASS: usize = 0;
pub const MAT_DIRT: usize = 1;
pub const MAT_ROCK: usize = 2;
pub const MAT_SNOW: usize = 3;
pub const MAT_SAND: usize = 4;
pub const MAT_MUD: usize = 5;

/// Stable-id layers (top byte of the packed id before mixing).
pub const LAYER_TREE: u8 = 1;
pub const LAYER_ROCK: u8 = 2;
pub const LAYER_BUSH: u8 = 3;
pub const LAYER_GRASS: u8 = 4;
pub const LAYER_CONTAINER: u8 = 5;
pub const LAYER_SPAWN: u8 = 6;

/// Base material mix per biome [grass, dirt, rock, snow, sand, mud].
const BIOME_MAT: [[f64; 6]; 6] = [
    [0.85, 0.15, 0.0, 0.0, 0.0, 0.0],
    [0.5, 0.45, 0.05, 0.0, 0.0, 0.0],
    [0.45, 0.15, 0.4, 0.0, 0.0, 0.0],
    [0.05, 0.0, 0.25, 0.7, 0.0, 0.0],
    [0.05, 0.35, 0.25, 0.0, 0.35, 0.0],
    [0.45, 0.05, 0.0, 0.0, 0.0, 0.5],
];

struct Layer {
    id: u8,
    cell: f64,
    min_d: f64,
    density: [f64; 6],
    max_slope: f64,
    /// Species/kind weights per biome; kind = index into the row.
    kinds: [&'static [f64]; 6],
}

// Tree kinds: 0 oak, 1 birch, 2 broadleaf, 3 pine, 4 snow fir, 5 dead tree, 6 acacia, 7 willow, 8 cypress.
// Rock kinds: 0 boulder, 1 slab, 2 spire, 3 mossy, 4 snowy.
// Bush kinds: 0 shrub, 1 berry bush, 2 fern, 3 dry scrub, 4 reeds, 5 heather.
// Grass kinds: 0 tuft, 1 tall grass, 2 flowers, 3 dry grass, 4 snow grass, 5 marsh grass.
const LAYERS: [Layer; 4] = [
    Layer {
        id: LAYER_TREE,
        cell: 4.0,
        min_d: 3.4,
        density: [0.05, 0.6, 0.14, 0.12, 0.02, 0.18],
        max_slope: 34.0,
        kinds: [
            &[3.0, 2.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            &[1.0, 1.5, 3.0, 1.5, 0.0, 0.0, 0.0, 0.0, 0.0],
            &[0.0, 0.5, 0.0, 3.0, 0.5, 0.2, 0.0, 0.0, 0.0],
            &[0.0, 0.0, 0.0, 1.0, 3.0, 0.2, 0.0, 0.0, 0.0],
            &[0.0, 0.0, 0.0, 0.0, 0.0, 2.0, 2.0, 0.0, 0.0],
            &[0.0, 0.5, 0.0, 0.0, 0.0, 0.3, 0.0, 2.0, 2.0],
        ],
    },
    Layer {
        id: LAYER_ROCK,
        cell: 8.0,
        min_d: 6.0,
        density: [0.05, 0.07, 0.3, 0.22, 0.28, 0.03],
        max_slope: 60.0,
        kinds: [
            &[3.0, 1.0, 0.0, 0.5, 0.0],
            &[1.0, 0.5, 0.0, 3.0, 0.0],
            &[2.0, 2.0, 1.0, 0.5, 0.0],
            &[1.0, 0.5, 0.5, 0.0, 3.0],
            &[1.0, 1.0, 2.0, 0.0, 0.0],
            &[0.5, 0.5, 0.0, 3.0, 0.0],
        ],
    },
    Layer {
        id: LAYER_BUSH,
        cell: 4.0,
        min_d: 3.0,
        density: [0.08, 0.22, 0.1, 0.03, 0.1, 0.22],
        max_slope: 40.0,
        kinds: [
            &[2.0, 1.5, 0.0, 0.0, 0.0, 0.5],
            &[1.0, 1.0, 3.0, 0.0, 0.0, 0.0],
            &[1.0, 0.0, 0.0, 0.5, 0.0, 3.0],
            &[1.0, 0.0, 0.0, 0.0, 0.0, 1.0],
            &[0.5, 0.0, 0.0, 3.0, 0.0, 0.0],
            &[0.5, 0.0, 1.0, 0.0, 3.0, 0.0],
        ],
    },
    Layer {
        id: LAYER_GRASS,
        cell: 2.0,
        min_d: 1.6,
        density: [0.55, 0.22, 0.3, 0.03, 0.06, 0.5],
        max_slope: 40.0,
        kinds: [
            &[3.0, 1.5, 1.5, 0.0, 0.0, 0.0],
            &[2.0, 1.0, 0.5, 0.0, 0.0, 0.0],
            &[2.0, 0.5, 0.3, 0.5, 0.0, 0.0],
            &[0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            &[0.0, 0.0, 0.0, 3.0, 0.0, 0.0],
            &[1.0, 1.0, 0.0, 0.0, 0.0, 3.0],
        ],
    },
];

/// Container kinds: 0 chest, 1 buried cache, 2 urn, 3 crate.
const CONTAINER_KINDS: [[f64; 4]; 6] = [
    [2.0, 1.0, 0.0, 1.0],
    [2.0, 1.0, 0.0, 0.5],
    [1.0, 0.5, 2.0, 0.0],
    [2.0, 0.0, 1.0, 0.0],
    [1.0, 2.0, 1.0, 0.0],
    [2.0, 0.5, 1.0, 0.0],
];

/// Spawn-anchor enemy tables: 0..5 = the biome's wild table, then special
/// tables for anchors tied to a site.
pub const ENEMY_BANDIT: u8 = 6;
pub const ENEMY_DEMON: u8 = 7;
pub const ENEMY_GUARDIAN: u8 = 8;

struct Rec {
    id: u64,
    x: f32,
    y: f32,
    z: f32,
    kind: u8,
    variant: u8,
    scale: u8,
    yaw: u8,
}

pub fn build(a: &Atlas, cx: i32, cz: i32, lod: u32) -> Result<Vec<u8>, String> {
    if lod > MAX_LOD {
        return Err(format!("lod {lod} > {MAX_LOD}"));
    }
    let stride = 1i32 << lod;
    if !(CHUNK_MIN..CHUNK_MAX).contains(&cx) || !(CHUNK_MIN..CHUNK_MAX).contains(&cz) {
        return Err(format!("chunk ({cx}, {cz}) outside [{CHUNK_MIN}, {CHUNK_MAX})"));
    }
    if cx.rem_euclid(stride) != 0 || cz.rem_euclid(stride) != 0 {
        return Err(format!("lod {lod} tiles need cx, cz multiples of {stride}"));
    }
    let step = stride as f64;
    let x0 = (cx * CHUNK_SIZE_M) as f64;
    let z0 = (cz * CHUNK_SIZE_M) as f64;
    let span = CHUNK_SIZE_M as f64 * step;
    let g = Ground::new(a, x0 - step, z0 - step, x0 + span + step, z0 + span + step);

    // Heights on a 67 x 67 apron (one extra ring for slope), water on 65 x 65.
    const A: usize = S_ + 2;
    let mut hg = vec![0f32; A * A];
    let mut water = vec![0f32; SS];
    for j in 0..A {
        for i in 0..A {
            let x = x0 + (i as f64 - 1.0) * step;
            let z = z0 + (j as f64 - 1.0) * step;
            let (h, w) = g.sample(x, z);
            hg[j * A + i] = h as f32;
            if (1..=S_).contains(&i) && (1..=S_).contains(&j) {
                water[(j - 1) * S_ + (i - 1)] = w as f32;
            }
        }
    }

    // Splat weights.
    let s_splat = seed32(a.seed, 110);
    let mut splat_a = vec![0u8; SS * 4];
    let mut splat_b = vec![0u8; SS * 4];
    let mut min_h = f32::MAX;
    let mut max_h = f32::MIN;
    let mut wet_any = false;
    for j in 0..S_ {
        for i in 0..S_ {
            let h = hg[(j + 1) * A + i + 1];
            min_h = min_h.min(h);
            max_h = max_h.max(h);
            let wv = water[j * S_ + i];
            if wv > h {
                wet_any = true;
            }
            let gx = (hg[(j + 1) * A + i + 2] - hg[(j + 1) * A + i]) as f64 / (2.0 * step);
            let gz = (hg[(j + 2) * A + i + 1] - hg[j * A + i + 1]) as f64 / (2.0 * step);
            let slope = libm::atan(libm::sqrt(gx * gx + gz * gz)) * (180.0 / core::f64::consts::PI);
            let x = x0 + i as f64 * step;
            let z = z0 + j as f64 * step;
            let (bw, t, m) = biome_mix(a, x, z);
            let nvar = noise(s_splat, x / 23.0, z / 23.0);
            let wts = splat(&bw, t, m, h as f64, wv as f64, slope, g.sea_y, nvar);
            let q = quantize(&wts);
            let o = (j * S_ + i) * 4;
            splat_a[o..o + 4].copy_from_slice(&q[0..4]);
            splat_b[o] = q[4];
            splat_b[o + 1] = q[5];
            let mut dom = 0;
            for b in 0..6 {
                if bw[b] > bw[dom] {
                    dom = b;
                }
            }
            splat_b[o + 2] = dom as u8;
            splat_b[o + 3] = libm::round(m * 255.0) as u8;
        }
    }

    let mut scatter: Vec<Rec> = Vec::new();
    let mut containers: Vec<Rec> = Vec::new();
    let mut spawns: Vec<Rec> = Vec::new();
    let in_world = (0..64).contains(&cx) && (0..64).contains(&cz);
    if lod == 0 && in_world {
        let ctx = Ctx {
            a,
            g: &g,
            cx,
            cz,
            x0,
            z0,
            hg: &hg,
            water: &water,
            sites: nearby_sites(a, x0, z0),
        };
        for layer in &LAYERS {
            ctx.scatter_layer(layer, &mut scatter);
        }
        ctx.anchors(&mut containers, &mut spawns);
    }

    // Serialize.
    let off_h = HEADER_LEN;
    let off_w = off_h + SS * 4;
    let off_a = off_w + SS * 4;
    let off_b = off_a + SS * 4;
    let off_r = (off_b + SS * 4).next_multiple_of(8);
    let n_rec = scatter.len() + containers.len() + spawns.len();
    let total = off_r + n_rec * REC;
    let mut out = vec![0u8; total];
    out[0..4].copy_from_slice(&MAGIC);
    put_u16(&mut out, 4, FORMAT_VERSION);
    put_u16(&mut out, 6, crate::GEN_VERSION);
    put_u32(&mut out, 8, total as u32);
    put_u32(&mut out, 12, cx as u32);
    put_u32(&mut out, 16, cz as u32);
    out[20] = lod as u8;
    out[21] = (wet_any as u8) | (((n_rec > 0) as u8) << 1);
    put_u16(&mut out, 22, S_ as u16);
    put_f32(&mut out, 24, step as f32);
    put_f32(&mut out, 28, min_h);
    put_f32(&mut out, 32, max_h);
    put_u32(&mut out, 36, off_h as u32);
    put_u32(&mut out, 40, off_w as u32);
    put_u32(&mut out, 44, off_a as u32);
    put_u32(&mut out, 48, off_b as u32);
    put_u32(&mut out, 52, off_r as u32);
    put_u16(&mut out, 56, scatter.len() as u16);
    put_u16(&mut out, 58, containers.len() as u16);
    put_u16(&mut out, 60, spawns.len() as u16);
    put_u16(&mut out, 62, REC as u16);
    for j in 0..S_ {
        for i in 0..S_ {
            put_f32(&mut out, off_h + (j * S_ + i) * 4, hg[(j + 1) * A + i + 1]);
        }
    }
    for (k, w) in water.iter().enumerate() {
        put_f32(&mut out, off_w + k * 4, *w);
    }
    out[off_a..off_a + SS * 4].copy_from_slice(&splat_a);
    out[off_b..off_b + SS * 4].copy_from_slice(&splat_b);
    for (n, r) in scatter.iter().chain(containers.iter()).chain(spawns.iter()).enumerate() {
        let o = off_r + n * REC;
        put_u64(&mut out, o, r.id);
        put_f32(&mut out, o + 8, r.x);
        put_f32(&mut out, o + 12, r.y);
        put_f32(&mut out, o + 16, r.z);
        out[o + 20] = r.kind;
        out[o + 21] = r.variant;
        out[o + 22] = r.scale;
        out[o + 23] = r.yaw;
    }
    Ok(out)
}

/// Bilinear biome weights, temperature and moisture at a point.
fn biome_mix(a: &Atlas, x: f64, z: f64) -> ([f64; 6], f64, f64) {
    let u = (x / RES).clamp(0.0, (N - 1) as f64);
    let v = (z / RES).clamp(0.0, (N - 1) as f64);
    let i = (libm::floor(u) as usize).min(N - 2);
    let j = (libm::floor(v) as usize).min(N - 2);
    let fu = u - i as f64;
    let fv = v - j as f64;
    let mut bw = [0.0; 6];
    let mut t = 0.0;
    let mut m = 0.0;
    for (k, w) in [
        (j * N + i, (1.0 - fu) * (1.0 - fv)),
        (j * N + i + 1, fu * (1.0 - fv)),
        ((j + 1) * N + i, (1.0 - fu) * fv),
        ((j + 1) * N + i + 1, fu * fv),
    ] {
        bw[a.biome(k) as usize] += w;
        t += w * a.temp(k);
        m += w * a.moist(k);
    }
    (bw, t, m)
}

#[allow(clippy::too_many_arguments)]
fn splat(bw: &[f64; 6], t: f64, m: f64, h: f64, water: f64, slope: f64, sea_y: f64, nvar: f64) -> [f64; 6] {
    let mut w = [0.0; 6];
    for b in 0..6 {
        for (mat, wm) in w.iter_mut().enumerate() {
            *wm += bw[b] * BIOME_MAT[b][mat];
        }
    }
    // Dirt patches where the variation noise is high and the ground is dry.
    let patch = (nvar * 0.6).max(0.0) * (1.0 - m * 0.5);
    let moved = w[MAT_GRASS].min(patch);
    w[MAT_GRASS] -= moved;
    w[MAT_DIRT] += moved;
    let over = |w: &mut [f64; 6], mat: usize, k: f64| {
        let k = k.clamp(0.0, 1.0);
        for x in w.iter_mut() {
            *x *= 1.0 - k;
        }
        w[mat] += k;
    };
    over(&mut w, MAT_ROCK, smoothstep(28.0, 45.0, slope));
    over(&mut w, MAT_SNOW, smoothstep(0.3, 0.18, t + 0.04 * nvar) * (1.0 - smoothstep(38.0, 55.0, slope)));
    let above = h - water;
    if above < 1.5 {
        let wet = smoothstep(1.5, 0.2, above);
        let sea_shore = libm::fabs(water - sea_y) < 0.01;
        let mat = if sea_shore || bw[4] > 0.5 { MAT_SAND } else { MAT_MUD };
        over(&mut w, mat, wet * (1.0 - smoothstep(30.0, 45.0, slope)));
    }
    w
}

/// Quantize to u8 summing to exactly 255; rounding error goes to the largest.
fn quantize(w: &[f64; 6]) -> [u8; 6] {
    let sum: f64 = w.iter().sum();
    let mut q = [0u8; 6];
    if sum <= 0.0 {
        q[MAT_DIRT] = 255;
        return q;
    }
    let mut total: i32 = 0;
    let mut big = 0;
    for i in 0..6 {
        let v = libm::round(w[i] / sum * 255.0).clamp(0.0, 255.0) as i32;
        q[i] = v as u8;
        total += v;
        if w[i] > w[big] {
            big = i;
        }
    }
    q[big] = (q[big] as i32 + 255 - total).clamp(0, 255) as u8;
    q
}

fn nearby_sites(a: &Atlas, x0: f64, z0: f64) -> Vec<SiteRec> {
    let span = CHUNK_SIZE_M as f64;
    (0..a.site_count())
        .map(|i| a.site(i))
        .filter(|s| {
            let r = s.radius + 2.0;
            s.x + r >= x0 && s.x - r <= x0 + span && s.z + r >= z0 && s.z - r <= z0 + span
        })
        .collect()
}

struct Ctx<'a, 'b> {
    a: &'b Atlas<'a>,
    g: &'b Ground<'a>,
    cx: i32,
    cz: i32,
    x0: f64,
    z0: f64,
    hg: &'b [f32],
    water: &'b [f32],
    sites: Vec<SiteRec>,
}

const STREAM_SCATTER: u64 = 0x5343_4154; // "SCAT"

impl<'a, 'b> Ctx<'a, 'b> {
    /// Surface height and slope at a point inside this LOD-0 chunk, from the
    /// chunk's own lattice. Equal to `collision_height` at the same point.
    fn surface(&self, x: f64, z: f64) -> (f64, f64) {
        const A: usize = S_ + 2;
        let lx = (x - self.x0).clamp(0.0, 64.0);
        let lz = (z - self.z0).clamp(0.0, 64.0);
        let i = (libm::floor(lx) as usize).min(63);
        let j = (libm::floor(lz) as usize).min(63);
        let at = |ii: usize, jj: usize| self.hg[(jj + 1) * A + ii + 1] as f64;
        let (fx, fz) = (lx - i as f64, lz - j as f64);
        let (h00, h10, h01, h11) = (at(i, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1));
        let y = tri_interp(h00, h10, h01, h11, fx, fz);
        let n = tri_normal(h00, h10, h01, h11, fx, fz);
        let slope = libm::acos(n[1].clamp(-1.0, 1.0)) * (180.0 / core::f64::consts::PI);
        (y, slope)
    }

    fn water_at(&self, x: f64, z: f64) -> f64 {
        let i = (libm::round(x - self.x0) as i64).clamp(0, 64) as usize;
        let j = (libm::round(z - self.z0) as i64).clamp(0, 64) as usize;
        self.water[j * S_ + i] as f64
    }

    /// Inside a settlement footprint (true) or another site's footprint.
    fn footprint(&self, x: f64, z: f64) -> (bool, bool) {
        let mut settle = false;
        let mut other = false;
        for s in &self.sites {
            let d2 = (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z);
            // genVersion 2: settlements keep trees out of their (tighter)
            // layout radius only, so woods and orchards come up to the
            // houses; the client still hides scatter on lots, streets and
            // footpaths by stable id (client/src/world/buildings/clearance.ts).
            let r = if s.category == S::CAT_SETTLEMENT {
                s.radius * crate::town::layout::LAYOUT_SCALE[(s.size as usize).min(2)]
            } else {
                s.radius
            };
            if d2 <= r * r {
                if s.category == S::CAT_SETTLEMENT {
                    settle = true;
                } else {
                    other = true;
                }
            }
        }
        (settle, other)
    }

    /// Atlas-only density: deliberately independent of the chunk lattice so
    /// a neighbor chunk evaluating the same candidate gets the same answer.
    fn density(&self, layer: &Layer, x: f64, z: f64) -> f64 {
        let (bw, _t, m) = biome_mix(self.a, x, z);
        let nb = self.g.blend(x, z);
        if nb.sea > 0.5 || nb.lake > 0.5 {
            return 0.0;
        }
        let mut d: f64 = (0..6).map(|b| bw[b] * layer.density[b]).sum();
        match layer.id {
            LAYER_TREE => {
                let c = smoothstep(-0.25, 0.25, noise(seed32(self.a.seed, 111), x / 180.0, z / 180.0));
                d *= (0.25 + 0.75 * c) * (0.5 + m);
            }
            LAYER_GRASS => d *= 0.6 + 0.6 * m,
            _ => {}
        }
        d
    }

    /// Seamless Poisson-disk scatter: one jittered candidate per world-aligned
    /// cell; a candidate survives unless a neighbor candidate within `min_d`
    /// has a higher priority hash. Purely local, so neighboring chunks agree
    /// on their shared border without seeing each other.
    fn scatter_layer(&self, layer: &Layer, out: &mut Vec<Rec>) {
        let seed = self.a.seed;
        let n = (CHUNK_SIZE_M as f64 / layer.cell) as i32;
        let gx0 = self.cx * n;
        let gz0 = self.cz * n;
        let stream = STREAM_SCATTER ^ layer.id as u64;
        let w = (n + 2) as usize;
        // (x, z, priority, alive)
        let mut cand: Vec<(f64, f64, u64, bool)> = Vec::with_capacity(w * w);
        for gz in gz0 - 1..gz0 + n + 1 {
            for gx in gx0 - 1..gx0 + n + 1 {
                let h = hash(seed, stream, gx as i64, gz as i64, 0);
                let x = (gx as f64 + 0.15 + 0.7 * unit(h)) * layer.cell;
                let z = (gz as f64 + 0.15 + 0.7 * unit2(h)) * layer.cell;
                let alive = unit(mix64(h ^ 0x0123_4567_89AB_CDEF)) < self.density(layer, x, z);
                cand.push((x, z, h, alive));
            }
        }
        let min2 = layer.min_d * layer.min_d;
        for lj in 0..n {
            for li in 0..n {
                let c = cand[(lj + 1) as usize * w + (li + 1) as usize];
                if !c.3 {
                    continue;
                }
                let mut keep = true;
                'nb: for dj in -1i32..=1 {
                    for di in -1i32..=1 {
                        if di == 0 && dj == 0 {
                            continue;
                        }
                        let o = cand[(lj + 1 + dj) as usize * w + (li + 1 + di) as usize];
                        if !o.3 {
                            continue;
                        }
                        let d2 = (o.0 - c.0) * (o.0 - c.0) + (o.1 - c.1) * (o.1 - c.1);
                        if d2 < min2 && o.2 > c.2 {
                            keep = false;
                            break 'nb;
                        }
                    }
                }
                if !keep {
                    continue;
                }
                // Final, chunk-local filters (only ever remove points).
                let x = c.0 as f32 as f64;
                let z = c.1 as f32 as f64;
                let (y, slope) = self.surface(x, z);
                if slope > layer.max_slope || y < self.water_at(x, z) + 0.15 {
                    continue;
                }
                let (settle, other) = self.footprint(x, z);
                if (settle || other) && layer.id != LAYER_GRASS {
                    continue;
                }
                let (bw, _, _) = biome_mix(self.a, x, z);
                let h2 = mix64(c.2 ^ 0x5555_AAAA_5555_AAAA);
                let kind = pick_kind(&bw, &layer.kinds, unit(h2));
                let index = (lj * n + li) as u32;
                out.push(Rec {
                    id: stable_id(layer.id, self.cx, self.cz, index),
                    x: x as f32,
                    y: y as f32,
                    z: z as f32,
                    kind,
                    variant: (h2 >> 8) as u8,
                    scale: (h2 >> 16) as u8,
                    yaw: (h2 >> 24) as u8,
                });
            }
        }
    }

    fn anchors(&self, containers: &mut Vec<Rec>, spawns: &mut Vec<Rec>) {
        let a = self.a;
        let seed = a.seed;
        let enemy_density = a.param(crate::atlas::format::param::ENEMY_DENSITY);
        let theme_mask = a.param(crate::atlas::format::param::LOOT_THEME_MASK) as u32;
        let spawn_x = a.param(crate::atlas::format::param::SPAWN_X);
        let spawn_z = a.param(crate::atlas::format::param::SPAWN_Z);
        let themes: Vec<u8> = (0..32u8).filter(|i| theme_mask & (1 << i) != 0).collect();
        let theme = |h: u64| -> u8 {
            if themes.is_empty() {
                255
            } else {
                themes[((unit(h) * themes.len() as f64) as usize).min(themes.len() - 1)]
            }
        };
        // Wild anchors: one candidate per 32 m cell.
        for lj in 0..2 {
            for li in 0..2 {
                let index = (lj * 2 + li) as u32;
                for (layer, out) in [(LAYER_CONTAINER, &mut *containers), (LAYER_SPAWN, &mut *spawns)] {
                    let h = hash(seed, STREAM_SCATTER ^ (layer as u64) << 8, self.cx as i64, self.cz as i64, index as i64);
                    let x = (self.x0 + (li as f64 + 0.2 + 0.6 * unit(h)) * 32.0) as f32 as f64;
                    let z = (self.z0 + (lj as f64 + 0.2 + 0.6 * unit2(h)) * 32.0) as f32 as f64;
                    let danger = a.region_danger(region_of(x, z));
                    let (y, slope) = self.surface(x, z);
                    let (settle, other) = self.footprint(x, z);
                    if y < self.water_at(x, z) + 0.2 || settle || other {
                        continue;
                    }
                    let (bw, _, _) = biome_mix(a, x, z);
                    let h2 = mix64(h ^ 0x0F0F_0F0F_0F0F_0F0F);
                    let u = unit(h2);
                    if layer == LAYER_CONTAINER {
                        if slope > 30.0 || u >= 0.05 + 0.1 * danger {
                            continue;
                        }
                        let kind = weighted_pick(&mix_rows(&bw, &CONTAINER_KINDS), unit2(h2)) as u8;
                        out.push(rec(stable_id(layer, self.cx, self.cz, index), x, y, z, kind, theme(h2 >> 3), danger, h2));
                    } else {
                        let near_spawn = (x - spawn_x) * (x - spawn_x) + (z - spawn_z) * (z - spawn_z) < 300.0 * 300.0;
                        if slope > 40.0 || near_spawn || self.near_settlement(x, z, 64.0) || u >= enemy_density * (0.1 + 0.3 * danger) {
                            continue;
                        }
                        let mut dom = 0;
                        for b in 0..6 {
                            if bw[b] > bw[dom] {
                                dom = b;
                            }
                        }
                        let group = 1 + (unit2(h2) * 3.0) as u8 + (danger > 0.6) as u8;
                        out.push(rec(stable_id(layer, self.cx, self.cz, index), x, y, z, dom as u8, group, danger, h2));
                    }
                }
            }
        }
        // Anchors tied to sites whose center lies in this chunk. Index space
        // 0x1000 + site * 8 + k keeps them clear of the wild cells above.
        for s in &self.sites {
            if !(s.x >= self.x0 && s.x < self.x0 + 64.0 && s.z >= self.z0 && s.z < self.z0 + 64.0) {
                continue;
            }
            let danger = a.region_danger(s.region as usize);
            let (n_cont, n_spawn, table): (usize, usize, u8) = match (s.category, s.kind) {
                (S::CAT_STRUCTURE, S::ST_BANDIT_CAMP) => (1 + s.size as usize, 3, ENEMY_BANDIT),
                (S::CAT_STRUCTURE, S::ST_DEMON_LAIR) => (2, 2, ENEMY_DEMON),
                (S::CAT_STRUCTURE, S::ST_WIZARD_TOWER) | (S::CAT_STRUCTURE, S::ST_SUNKEN_TEMPLE) => (2, 2, ENEMY_GUARDIAN),
                (S::CAT_STRUCTURE, _) => (1 + s.size as usize, 1 + (s.size as usize).min(1), 255),
                (S::CAT_POI, S::POI_ENEMY_CAMP) => (1 + s.size as usize / 2, 3 + s.size as usize, 255),
                (S::CAT_POI, S::POI_TOWER) => (1, 1, ENEMY_GUARDIAN),
                (S::CAT_POI, S::POI_LANDMARK) => (((s.seed & 1) == 0) as usize, 0, 255),
                _ => (0, 0, 255),
            };
            for k in 0..(n_cont + n_spawn) {
                let is_cont = k < n_cont;
                let index = 0x1000 + (s.index as u32) * 8 + k as u32;
                let layer = if is_cont { LAYER_CONTAINER } else { LAYER_SPAWN };
                let h = hash(seed, STREAM_SCATTER ^ 0x5349, s.id as i64, k as i64, 0);
                let ang = unit(h) * 2.0 * core::f64::consts::PI;
                let r = (0.25 + 0.5 * unit2(h)) * s.radius.min(30.0);
                let x = (s.x + r * libm::cos(ang)).clamp(self.x0, self.x0 + 63.999) as f32 as f64;
                let z = (s.z + r * libm::sin(ang)).clamp(self.z0, self.z0 + 63.999) as f32 as f64;
                let (y, _) = self.surface(x, z);
                let h2 = mix64(h);
                if is_cont {
                    let kind = if s.kind == S::POI_LANDMARK && s.category == S::CAT_POI { 1 } else { 0 };
                    containers.push(rec(stable_id(layer, self.cx, self.cz, index), x, y, z, kind, theme(h2), danger, h2));
                } else {
                    let tbl = if table == 255 {
                        let (bw, _, _) = biome_mix(a, x, z);
                        let mut dom = 0;
                        for b in 0..6 {
                            if bw[b] > bw[dom] {
                                dom = b;
                            }
                        }
                        dom as u8
                    } else {
                        table
                    };
                    let group = 1 + (unit2(h2) * 3.0) as u8;
                    spawns.push(rec(stable_id(layer, self.cx, self.cz, index), x, y, z, tbl, group, danger, h2));
                }
            }
        }
    }

    /// Near any settlement in the world (not just this chunk's site list:
    /// the margin reaches past the chunk).
    fn near_settlement(&self, x: f64, z: f64, margin: f64) -> bool {
        (0..self.a.site_count()).any(|i| {
            let s = self.a.site(i);
            let r = s.radius + margin;
            s.category == S::CAT_SETTLEMENT && (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z) < r * r
        })
    }
}

#[allow(clippy::too_many_arguments)]
fn rec(id: u64, x: f64, y: f64, z: f64, kind: u8, variant: u8, danger: f64, h: u64) -> Rec {
    Rec {
        id,
        x: x as f32,
        y: y as f32,
        z: z as f32,
        kind,
        variant,
        scale: libm::round(danger.clamp(0.0, 1.0) * 255.0) as u8,
        yaw: (h >> 40) as u8,
    }
}

fn mix_rows<const K: usize>(bw: &[f64; 6], rows: &[[f64; K]; 6]) -> [f64; K] {
    let mut w = [0.0; K];
    for b in 0..6 {
        for k in 0..K {
            w[k] += bw[b] * rows[b][k];
        }
    }
    w
}

fn pick_kind(bw: &[f64; 6], rows: &[&[f64]; 6], u: f64) -> u8 {
    let k = rows[0].len();
    let mut w = vec![0.0; k];
    for b in 0..6 {
        for (i, x) in w.iter_mut().enumerate() {
            *x += bw[b] * rows[b][i];
        }
    }
    weighted_pick(&w, u) as u8
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atlas;
    use crate::atlas::format::get_f32;
    use crate::ground::collision_height;
    use crate::spec::spec_from_seed;

    fn atlas_bytes() -> Vec<u8> {
        atlas::build(&spec_from_seed(7), 7).unwrap()
    }

    #[test]
    fn chunk_heights_match_collision() {
        let ab = atlas_bytes();
        let a = Atlas::parse(&ab).unwrap();
        for (cx, cz) in [(32, 32), (10, 50), (0, 0), (63, 17)] {
            let c = build(&a, cx, cz, 0).unwrap();
            for (i, j) in [(0, 0), (64, 64), (13, 41), (64, 0), (5, 64)] {
                let h = get_f32(&c, HEADER_LEN + (j * S_ + i) * 4) as f64;
                let x = (cx * 64 + i as i32) as f64;
                let z = (cz * 64 + j as i32) as f64;
                assert_eq!(h.to_bits(), collision_height(&a, x, z).to_bits(), "chunk ({cx},{cz}) sample ({i},{j})");
            }
        }
    }

    /// WP10: `water_height` at a lattice point is the chunk's water sample,
    /// over chunks with lakes, rivers and dry land, so hosts can evaluate it
    /// from chunk water (Go fast path, TS `chunkWaterHeight`).
    #[test]
    fn chunk_water_matches_water_height() {
        let ab = atlas_bytes();
        let a = Atlas::parse(&ab).unwrap();
        let mut wet = 0;
        for cz in (0..64).step_by(7) {
            for cx in (0..64).step_by(7) {
                let c = build(&a, cx, cz, 0).unwrap();
                let woff = crate::atlas::format::get_u32(&c, 40) as usize;
                wet += (c[21] & 1) as i32;
                for (i, j) in [(0, 0), (64, 64), (13, 41), (64, 0), (5, 64), (32, 32)] {
                    let w = get_f32(&c, woff + (j * S_ + i) * 4) as f64;
                    let x = (cx * 64 + i as i32) as f64;
                    let z = (cz * 64 + j as i32) as f64;
                    assert_eq!(
                        w.to_bits(),
                        crate::ground::water_height(&a, x, z).to_bits(),
                        "chunk ({cx},{cz}) sample ({i},{j})"
                    );
                }
            }
        }
        assert!(wet > 0, "expected some chunks with water above ground");
    }

    #[test]
    fn lod_seams_match() {
        let ab = atlas_bytes();
        let a = Atlas::parse(&ab).unwrap();
        let c0 = build(&a, 32, 32, 0).unwrap();
        let c1 = build(&a, 32, 32, 1).unwrap();
        // LOD1 sample (i, j) sits at 2i, 2j; inside the LOD0 tile for i, j <= 32.
        for j in 0..=32 {
            for i in 0..=32 {
                let h0 = get_f32(&c0, HEADER_LEN + (2 * j * S_ + 2 * i) * 4);
                let h1 = get_f32(&c1, HEADER_LEN + (j * S_ + i) * 4);
                assert_eq!(h0.to_bits(), h1.to_bits());
            }
        }
    }

    #[test]
    fn neighbor_edges_match() {
        let ab = atlas_bytes();
        let a = Atlas::parse(&ab).unwrap();
        let l = build(&a, 20, 20, 0).unwrap();
        let r = build(&a, 21, 20, 0).unwrap();
        for j in 0..S_ {
            let hl = get_f32(&l, HEADER_LEN + (j * S_ + 64) * 4);
            let hr = get_f32(&r, HEADER_LEN + (j * S_) * 4);
            assert_eq!(hl.to_bits(), hr.to_bits());
        }
    }

    #[test]
    fn scatter_y_matches_collision_and_ids_unique() {
        let ab = atlas_bytes();
        let a = Atlas::parse(&ab).unwrap();
        let mut ids = Vec::new();
        for (cx, cz) in [(30, 30), (31, 30), (12, 40)] {
            let c = build(&a, cx, cz, 0).unwrap();
            let off = crate::atlas::format::get_u32(&c, 52) as usize;
            let n = crate::atlas::format::get_u16(&c, 56) as usize
                + crate::atlas::format::get_u16(&c, 58) as usize
                + crate::atlas::format::get_u16(&c, 60) as usize;
            for r in 0..n {
                let o = off + r * REC;
                ids.push(crate::atlas::format::get_u64(&c, o));
                let x = get_f32(&c, o + 8) as f64;
                let y = get_f32(&c, o + 12);
                let z = get_f32(&c, o + 16) as f64;
                assert_eq!(y.to_bits(), (collision_height(&a, x, z) as f32).to_bits());
            }
        }
        let n = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), n);
    }

    #[test]
    fn rejects_bad_lod_alignment() {
        let ab = atlas_bytes();
        let a = Atlas::parse(&ab).unwrap();
        assert!(build(&a, 1, 0, 1).is_err());
        assert!(build(&a, 0, 0, 7).is_err());
        assert!(build(&a, 200, 0, 0).is_err());
    }

    #[test]
    fn splat_sums_to_255() {
        let ab = atlas_bytes();
        let a = Atlas::parse(&ab).unwrap();
        let c = build(&a, 25, 33, 0).unwrap();
        let oa = crate::atlas::format::get_u32(&c, 44) as usize;
        let ob = crate::atlas::format::get_u32(&c, 48) as usize;
        for k in 0..SS {
            let s: u32 = (0..4).map(|m| c[oa + k * 4 + m] as u32).sum::<u32>() + c[ob + k * 4] as u32 + c[ob + k * 4 + 1] as u32;
            assert_eq!(s, 255);
        }
    }
}
