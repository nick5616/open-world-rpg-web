//! Cave graphs (spec 7 step 1): from every cave mouth in the atlas, grow a
//! graph of chambers (nodes with radius and depth) and tunnels (edges with
//! width and curvature) within `caveDensity` and `caveMaxDepth`.
//!
//! Connectivity is guaranteed by construction: every chamber is placed at
//! the end of a new tunnel from a chamber already in the graph, so the graph
//! is a tree rooted at the entrance (plus a few loop edges). It doubles as
//! the enemy navigation graph (chambers = nodes, tunnel polylines = edges).
//!
//! Shape of a system:
//! - an entry ramp from the hillside (the mouth faces downhill) descending
//!   ~20 degrees into an entrance chamber 8-20 m below the mouth;
//! - a "spine" of chambers that descends toward a target depth set by
//!   `caveMaxDepth` and `caveDensity`, with tunnels no steeper than ~30
//!   degrees (long drops become ravines: tall, narrow slots);
//! - side branches and occasional loops;
//! - sometimes a sinkhole: a vertical shaft from a mid-depth chamber to the
//!   sky, the "daylight" that sunsteel ore needs (spec 7 ores table).
//!
//! Systems stay within 150 m (horizontal) of their mouth. Mouths are at
//! least 350 m apart (atlas spacing rule), so systems never merge and a
//! point underground belongs to at most one system (the cave-system id that
//! AOI clipping and voice earshot use).
//!
//! Every placement is validated against the real terrain surface so a
//! chamber or tunnel never breaks through the ground except at its mouth
//! (and sinkholes): roof >= 3 m of rock plus the noise amplitude.

use super::field::{Elem, NOISE_AMP};
use super::veins::{self, Deco, Vein};
use crate::atlas::format::{flag, get_u16, idx, param, sec, site as S, Atlas, SiteRec, N, RES, SITE_REC};
use crate::gen::constants::WORLD_MIN_Y;
use crate::ground::Ground;
use crate::rng::{hash, Seq};

pub const STREAM_CAVE: u64 = 0x4341_5645; // "CAVE"

/// Horizontal reach of a system from its mouth (see module doc).
pub const SYSTEM_REACH: f64 = 150.0;
/// Rock kept above every chamber and tunnel, on top of the noise amplitude.
pub const ROOF_M: f64 = 3.0;
/// Below this depth (under the mouth) a chamber is "mid", below DEEP "deep" (spec 7 depth bands).
pub const BAND_MID: f64 = 64.0;
pub const BAND_DEEP: f64 = 160.0;
/// Steepest tunnel floor we plan, degrees (walkable: WALKABLE_SLOPE_DEG is 50).
const MAX_TUNNEL_SLOPE: f64 = 0.577; // tan 30 deg
/// Surface heights can fall below the macro heightmap by detail noise (up to
/// ~40 m), ridges, terraces and lake beds; a point this far under the macro
/// surface is safely underground without sampling the exact height.
const MACRO_SLACK: f64 = 72.0;

pub const CH_ENTRANCE: u8 = 1;
pub const CH_SUNLIT: u8 = 2;
pub const CH_SHAFT: u8 = 4;
pub const CH_DEEPEST: u8 = 8;

pub const TUN_ENTRY: u8 = 0;
pub const TUN_TUNNEL: u8 = 1;
pub const TUN_RAVINE: u8 = 2;
pub const TUN_SHAFT: u8 = 3;

pub const OPEN_MOUTH: u8 = 0;
pub const OPEN_SINKHOLE: u8 = 1;

#[derive(Clone, Copy, Debug)]
pub struct Chamber {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub rx: f64,
    pub ry: f64,
    pub floor: f64,
    /// Below the mouth surface, meters.
    pub depth: f64,
    pub flags: u8,
    pub parent: u16,
}

impl Chamber {
    pub fn band(&self) -> u8 {
        band_of(self.depth)
    }
}

pub fn band_of(depth: f64) -> u8 {
    if depth >= BAND_DEEP {
        2
    } else if depth >= BAND_MID {
        1
    } else {
        0
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Tunnel {
    pub a: u16,
    pub b: u16,
    pub kind: u8,
    pub r: f64,
    pub stretch: f64,
    pub floor_k: f64,
    /// Axis polyline: 4 points, 3 capsule segments (a quadratic Bezier
    /// sampled at t = 0, 1/3, 2/3, 1: the tunnel's curvature).
    pub pts: [[f64; 3]; 4],
}

/// Where a system meets the sky. The overworld drops heightfield triangles
/// within `r_mask` of (x, z) (README "Cave mouths"); the volume reproduces
/// the terrain surface out to `r_zone`. All fields are f32-exact so every
/// host makes the same mask decisions from the serialized graph.
#[derive(Clone, Copy, Debug)]
pub struct Opening {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub r_mask: f64,
    pub r_zone: f64,
    pub kind: u8,
    pub system: u16,
    pub tunnel: u16,
    /// Direction the opening faces (out of the hill), fraction of a turn x65536.
    pub yaw: u16,
}

impl Opening {
    /// Noise scale at horizontal distance d from this opening: zero inside
    /// the mask (so the hole matches the analytic geometry the mask was sized
    /// for), full strength 8 m further out.
    #[inline]
    pub fn noise_scale(&self, x: f64, z: f64) -> f64 {
        let dx = x - self.x;
        let dz = z - self.z;
        let d = libm::sqrt(dx * dx + dz * dz);
        crate::noise::smoothstep(self.r_mask + 2.0, self.r_mask + 10.0, d)
    }
}

pub struct System {
    pub index: u16,
    pub site_index: u16,
    pub id: u64,
    pub region: u8,
    pub biome: u8,
    pub elem: u8,
    pub elem2: u8,
    pub mouth_x: f64,
    pub mouth_z: f64,
    pub mouth_y: f64,
    pub chambers: Vec<Chamber>,
    pub tunnels: Vec<Tunnel>,
    pub openings: Vec<Opening>,
    pub elems: Vec<Elem>,
    pub veins: Vec<Vein>,
    pub decos: Vec<Deco>,
    pub bbox: [f64; 6],
    pub deepest: u16,
    pub max_depth: f64,
}

/// Everything about one world's caves; built once per atlas and cached by
/// the ABI layer (see `cache.rs`).
pub struct CaveWorld {
    pub seed: u64,
    pub noise_seed: u32,
    pub cave_max_depth: f64,
    pub gem_rarity_curve: f64,
    pub ore_abundance: f64,
    pub cave_density: f64,
    pub systems: Vec<System>,
}

impl CaveWorld {
    pub fn openings(&self) -> impl Iterator<Item = &Opening> {
        self.systems.iter().flat_map(|s| s.openings.iter())
    }
}

/// Spec values the cave pass reads. caveMaxDepth and gemRarityCurve are not
/// in the atlas PARAMS slots (WP01 predates caves), so they come from the
/// canonical spec JSON embedded in the atlas (section SPEC).
pub struct CaveParams {
    pub cave_density: f64,
    pub cave_max_depth: f64,
    pub gem_rarity_curve: f64,
    pub ore_abundance: f64,
    pub sea_y: f64,
    pub peak_h: f64,
}

pub fn params(a: &Atlas) -> Result<CaveParams, String> {
    let spec = crate::spec::parse(a.section(sec::SPEC))?;
    Ok(CaveParams {
        cave_density: a.param(param::CAVE_DENSITY),
        cave_max_depth: spec.cave_max_depth,
        gem_rarity_curve: spec.gem_rarity_curve,
        ore_abundance: a.param(param::ORE_ABUNDANCE),
        sea_y: a.param(param::SEA_Y),
        peak_h: a.param(param::PEAK_H),
    })
}

#[inline]
fn f32r(v: f64) -> f64 {
    v as f32 as f64
}

/// Exact surface height (the f32 lattice value at the nearest lattice point:
/// good to a few cm for clearance checks, and cheap).
struct Surface<'a> {
    a: &'a Atlas<'a>,
    g: Ground<'a>,
}

impl<'a> Surface<'a> {
    fn new(a: &'a Atlas<'a>, x: f64, z: f64) -> Surface<'a> {
        let reach = SYSTEM_REACH + 40.0;
        Surface {
            a,
            g: Ground::new(a, x - reach, z - reach, x + reach, z + reach),
        }
    }
    fn exact(&self, x: f64, z: f64) -> f64 {
        self.g.lattice(libm::round(x), libm::round(z)) as f64
    }
    /// True when `top` is at least ROOF_M + noise under the surface at (x, z).
    /// Uses the macro heightmap as a quick accept for deep points.
    fn under(&self, x: f64, z: f64, top: f64) -> bool {
        let need = top + ROOF_M + NOISE_AMP;
        if need < self.g.macro_h(x, z) - MACRO_SLACK {
            return true;
        }
        need < self.exact(x, z)
    }
    fn node_flags(&self, x: f64, z: f64) -> u8 {
        let i = (libm::round(x / RES) as i64).clamp(0, N as i64 - 1) as usize;
        let j = (libm::round(z / RES) as i64).clamp(0, N as i64 - 1) as usize;
        self.a.nodep(idx(i, j))[3]
    }
    fn biome(&self, x: f64, z: f64) -> u8 {
        let i = (libm::round(x / RES) as i64).clamp(0, N as i64 - 1) as usize;
        let j = (libm::round(z / RES) as i64).clamp(0, N as i64 - 1) as usize;
        self.a.biome(idx(i, j))
    }
}

fn site_yaw(a: &Atlas, i: usize) -> u16 {
    get_u16(a.section(sec::SITES), 8 + i * SITE_REC + 44)
}

/// Build every cave system of a world. Order: mouth sites in atlas order.
pub fn build_world(a: &Atlas) -> Result<CaveWorld, String> {
    let p = params(a)?;
    let mut systems = Vec::new();
    for i in 0..a.site_count() {
        let s = a.site(i);
        if s.category != S::CAT_POI || s.kind != S::POI_CAVE_MOUTH {
            continue;
        }
        let index = systems.len() as u16;
        if let Some(sys) = build_system(a, &p, index, &s, site_yaw(a, i)) {
            systems.push(sys);
        }
    }
    let noise_seed = crate::atlas::terrain::seed32(a.seed, 0x0C47);
    let mut w = CaveWorld {
        seed: a.seed,
        noise_seed,
        cave_max_depth: p.cave_max_depth,
        gem_rarity_curve: p.gem_rarity_curve,
        ore_abundance: p.ore_abundance,
        cave_density: p.cave_density,
        systems,
    };
    veins::place_all(a, &p, &mut w);
    Ok(w)
}

fn polyline(a: [f64; 3], b: [f64; 3], bend: f64) -> [[f64; 3]; 4] {
    // Quadratic Bezier with the control point pushed sideways by `bend`
    // (fraction of the horizontal length), sampled at thirds.
    let dx = b[0] - a[0];
    let dz = b[2] - a[2];
    let ctrl = [(a[0] + b[0]) * 0.5 - dz * bend, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5 + dx * bend];
    let q = |t: f64| -> [f64; 3] {
        let u = 1.0 - t;
        [
            u * u * a[0] + 2.0 * u * t * ctrl[0] + t * t * b[0],
            u * u * a[1] + 2.0 * u * t * ctrl[1] + t * t * b[1],
            u * u * a[2] + 2.0 * u * t * ctrl[2] + t * t * b[2],
        ]
    };
    [a, q(1.0 / 3.0), q(2.0 / 3.0), b]
}

struct Builder<'a> {
    surf: Surface<'a>,
    seq: Seq,
    mouth: (f64, f64, f64),
    max_depth: f64,
    chambers: Vec<Chamber>,
    tunnels: Vec<Tunnel>,
    degree: Vec<u8>,
}

impl Builder<'_> {
    fn chamber_ok(&self, c: &Chamber) -> bool {
        let (mx, _, mz) = self.mouth;
        let hd = libm::sqrt((c.x - mx) * (c.x - mx) + (c.z - mz) * (c.z - mz));
        if hd + c.rx > SYSTEM_REACH || c.x - c.rx < 24.0 || c.z - c.rx < 24.0 || c.x + c.rx > 4072.0 || c.z + c.rx > 4072.0 {
            return false;
        }
        if c.depth > self.max_depth || c.floor < WORLD_MIN_Y + 12.0 {
            return false;
        }
        for o in &self.chambers {
            let d = libm::sqrt((o.x - c.x) * (o.x - c.x) + (o.y - c.y) * (o.y - c.y) + (o.z - c.z) * (o.z - c.z));
            if d < o.rx + c.rx + 4.0 {
                return false;
            }
        }
        let top = c.y + c.ry;
        let k = c.rx * 0.8;
        [(0.0, 0.0), (k, 0.0), (-k, 0.0), (0.0, k), (0.0, -k)]
            .iter()
            .all(|(ox, oz)| self.surf.under(c.x + ox, c.z + oz, top))
    }

    fn tunnel_ok(&self, t: &Tunnel, skip_near: Option<(f64, f64, f64)>) -> bool {
        // Sample the axis every ~6 m; the roof must stay under the surface,
        // except near the opening the entry ramp is meant to break through.
        for s in 0..3 {
            let (p, q) = (t.pts[s], t.pts[s + 1]);
            let len = libm::sqrt((q[0] - p[0]) * (q[0] - p[0]) + (q[2] - p[2]) * (q[2] - p[2]));
            let n = (libm::ceil(len / 6.0) as usize).max(1);
            for k in 0..=n {
                let f = k as f64 / n as f64;
                let x = p[0] + (q[0] - p[0]) * f;
                let y = p[1] + (q[1] - p[1]) * f;
                let z = p[2] + (q[2] - p[2]) * f;
                if let Some((ox, oz, r)) = skip_near {
                    if (x - ox) * (x - ox) + (z - oz) * (z - oz) < r * r {
                        continue;
                    }
                }
                if !self.surf.under(x, z, y + t.r * t.stretch) {
                    return false;
                }
            }
        }
        true
    }

    fn push(&mut self, c: Chamber, t: Tunnel) {
        self.degree[t.a as usize] += 1;
        self.degree.push(1);
        self.chambers.push(c);
        self.tunnels.push(t);
    }

    fn tunnel_between(&mut self, ai: usize, c: &Chamber, depth_frac: f64) -> Tunnel {
        let pa = self.chambers[ai];
        // Tighter with depth (spec 7), but never under 2.3 m: floor to roof
        // is 1.6 r, and a 1.8 m player plus a jump needs ~3 m of it.
        let r = ((3.3 - 1.0 * depth_frac) * (0.85 + 0.3 * self.seq.unit())).max(2.3);
        let drop = pa.floor - c.floor;
        let hl = libm::sqrt((c.x - pa.x) * (c.x - pa.x) + (c.z - pa.z) * (c.z - pa.z)).max(1.0);
        // Long steep drops become ravines (tall narrow slots) some of the time.
        let ravine = drop / hl > 0.42 && self.seq.unit() < 0.55;
        let (kind, r, stretch, floor_k) = if ravine { (TUN_RAVINE, 2.3, 2.6, 0.45) } else { (TUN_TUNNEL, r, 1.0, 0.6) };
        let a = [pa.x, pa.floor + floor_k * r, pa.z];
        let b = [c.x, c.floor + floor_k * r, c.z];
        let bend = (self.seq.unit() - 0.5) * 0.5;
        Tunnel {
            a: ai as u16,
            b: self.chambers.len() as u16,
            kind,
            r,
            stretch,
            floor_k,
            pts: polyline(a, b, bend),
        }
    }

    /// Try to hang a new chamber off `parent` heading roughly `heading`.
    fn try_chamber(&mut self, parent: usize, heading: f64, drop: f64, len_min: f64, len_max: f64) -> Option<(Chamber, Tunnel)> {
        let pa = self.chambers[parent];
        let len = (libm::fabs(drop) / MAX_TUNNEL_SLOPE).clamp(len_min, len_max);
        let floor = pa.floor - drop;
        let depth = self.mouth.1 - floor;
        let depth_frac = (depth / self.max_depth).clamp(0.0, 1.0);
        let rx = (9.5 - 4.5 * depth_frac) * (0.8 + 0.4 * self.seq.unit());
        let ry = rx * (0.55 + 0.2 * self.seq.unit());
        let x = pa.x + libm::cos(heading) * len;
        let z = pa.z + libm::sin(heading) * len;
        let c = Chamber {
            x,
            y: floor + 0.55 * ry,
            z,
            rx,
            ry,
            floor,
            depth,
            flags: 0,
            parent: parent as u16,
        };
        if !self.chamber_ok(&c) {
            return None;
        }
        let t = self.tunnel_between(parent, &c, depth_frac);
        if !self.tunnel_ok(&t, None) {
            return None;
        }
        Some((c, t))
    }
}

fn build_system(a: &Atlas, p: &CaveParams, index: u16, site: &SiteRec, yaw: u16) -> Option<System> {
    let surf = Surface::new(a, site.x, site.z);
    let mut seq = Seq::new(a.seed ^ (site.seed as u64) << 17, STREAM_CAVE ^ site.index as u64);
    let theta = yaw as f64 / 65536.0 * core::f64::consts::TAU;
    // Site yaw faces downhill; "in" is uphill, into the hill.
    let (dx, dz) = (libm::cos(theta), libm::sin(theta));
    let (ux, uz) = (-dx, -dz);
    let (sx, sz) = (site.x, site.z);
    let hm = surf.exact(sx, sz);
    let max_depth = p.cave_max_depth.min(hm - WORLD_MIN_Y - 24.0);
    if max_depth < 40.0 {
        return None;
    }

    // ---- entry ramp: start on the open hillside where the ground has fallen
    // 1.4 m below the mouth, so the ramp floor meets the surface instead of
    // leaving a pit at the end of the trench.
    let re = 2.8 + 0.5 * seq.unit();
    let mut s0 = 3.0;
    for d in 3..=12 {
        s0 = d as f64;
        if surf.exact(sx - ux * s0, sz - uz * s0) <= hm - 1.4 {
            break;
        }
    }
    let p0x = sx - ux * s0;
    let p0z = sz - uz * s0;
    let p0_floor = surf.exact(p0x, p0z) - 0.25;

    // ---- entrance chamber: 18-24 m into the hill, floor 8-20 m under the
    // mouth (deeper when the hill above is thin).
    let dist = 18.0 + 6.0 * seq.unit();
    let rx = 7.0 + 2.0 * seq.unit();
    let ry = rx * 0.62;
    let mut entrance = None;
    for k in 0..4 {
        let floor = hm - (8.0 + 4.0 * seq.unit()) - 4.0 * k as f64;
        let c = Chamber {
            x: sx + ux * dist,
            y: floor + 0.55 * ry,
            z: sz + uz * dist,
            rx,
            ry,
            floor,
            depth: hm - floor,
            flags: CH_ENTRANCE,
            parent: 0xFFFF,
        };
        let k8 = rx * 0.8;
        if [(0.0, 0.0), (k8, 0.0), (-k8, 0.0), (0.0, k8), (0.0, -k8)]
            .iter()
            .all(|(ox, oz)| surf.under(c.x + ox, c.z + oz, c.y + ry))
        {
            entrance = Some(c);
            break;
        }
    }
    let entrance = entrance?;
    let entry = Tunnel {
        a: 0,
        b: 0,
        kind: TUN_ENTRY,
        r: re,
        stretch: 1.0,
        floor_k: 0.6,
        pts: polyline(
            [p0x, p0_floor + 0.6 * re, p0z],
            [entrance.x, entrance.floor + 0.6 * re, entrance.z],
            (seq.unit() - 0.5) * 0.2,
        ),
    };

    // ---- opening: where along the ramp does the roof go under the ground
    // (with enough rock for the roof clamp)? The mask covers the stretch
    // from the ramp start (s0 outside) to that point (s1 inside).
    let mut s1 = None;
    let total = s0 + dist;
    let mut st = 0.0;
    while st <= total {
        let f = st / total;
        let q = bezier_at(&entry.pts, f);
        let s_in = st - s0;
        let ground = surf.exact(q[0], q[2]);
        if s_in > 0.0 && q[1] + re + 1.0 < ground - 2.5 {
            s1 = Some(s_in);
            break;
        }
        st += 1.0;
    }
    let s1 = s1?;
    if s1 > 18.0 {
        return None;
    }
    let mid = (s1 - s0) * 0.5;
    let r_mask = f32r(((s0 + s1) * 0.5 + 1.0).max(re + 2.5).min(14.0));
    let ox = f32r(sx + ux * mid);
    let oz = f32r(sz + uz * mid);
    let mouth_open = Opening {
        x: ox,
        y: f32r(surf.exact(ox, oz)),
        z: oz,
        r_mask,
        r_zone: f32r(r_mask + 3.0),
        kind: OPEN_MOUTH,
        system: index,
        tunnel: 0,
        yaw,
    };

    let mut b = Builder {
        surf,
        seq,
        mouth: (sx, hm, sz),
        max_depth,
        chambers: vec![entrance],
        tunnels: vec![],
        degree: vec![1],
    };
    b.tunnels.push(entry);

    // ---- spine: descend toward the target depth.
    let n_target = 4 + libm::round(7.0 * p.cave_density) as usize + b.seq.below(3);
    let target = (max_depth * (0.5 + 0.42 * p.cave_density + 0.08 * b.seq.unit())).min(max_depth - 6.0);
    let spine_len = (((n_target as f64) * 0.6).ceil() as usize).max(3);
    let mut heading = libm::atan2(uz, ux);
    let mut cur = 0usize;
    for k in 1..spine_len {
        let remaining = target - b.chambers[cur].depth;
        let left = (spine_len - k) as f64;
        let per = (remaining / left).max(4.0) * (0.75 + 0.5 * b.seq.unit());
        let mut placed = None;
        for attempt in 0..14 {
            let pc = b.chambers[cur];
            let back = libm::atan2(sz - pc.z, sx - pc.x);
            let far = libm::sqrt((pc.x - sx) * (pc.x - sx) + (pc.z - sz) * (pc.z - sz)) > 95.0;
            let spread = 0.7 + 1.6 * attempt as f64 / 14.0;
            let h = if far { back + (b.seq.unit() - 0.5) * 2.0 } else { heading + (b.seq.unit() - 0.5) * spread };
            let drop = per * (1.0 - attempt as f64 / 20.0);
            if let Some(ct) = b.try_chamber(cur, h, drop, 24.0, 68.0) {
                placed = Some((ct, h));
                break;
            }
        }
        let Some(((c, t), h)) = placed else { break };
        heading = h;
        cur = b.chambers.len();
        b.push(c, t);
    }

    // ---- side branches: small drops (or slight climbs) off any chamber.
    let mut tries = 0;
    while b.chambers.len() < n_target && tries < n_target * 6 {
        tries += 1;
        let cand: Vec<usize> = (0..b.chambers.len()).filter(|&i| b.degree[i] < 4).collect();
        if cand.is_empty() {
            break;
        }
        let parent = cand[b.seq.below(cand.len())];
        let h = b.seq.unit() * core::f64::consts::TAU;
        let drop = -3.0 + 13.0 * b.seq.unit();
        if let Some((c, t)) = b.try_chamber(parent, h, drop, 20.0, 40.0) {
            b.push(c, t);
        }
    }

    // ---- loops: join a few close chamber pairs that are not yet adjacent.
    let mut loops = 0;
    let nch = b.chambers.len();
    'outer: for i in 0..nch {
        for j in (i + 1)..nch {
            if loops >= 2 {
                break 'outer;
            }
            let (ci, cj) = (b.chambers[i], b.chambers[j]);
            let hd = libm::sqrt((ci.x - cj.x) * (ci.x - cj.x) + (ci.z - cj.z) * (ci.z - cj.z));
            let adjacent = b.tunnels.iter().any(|t| (t.a as usize == i && t.b as usize == j) || (t.a as usize == j && t.b as usize == i));
            if adjacent || hd > 46.0 || libm::fabs(ci.floor - cj.floor) > hd * MAX_TUNNEL_SLOPE || b.seq.unit() > 0.35 {
                continue;
            }
            let depth_frac = ((b.mouth.1 - cj.floor) / max_depth).clamp(0.0, 1.0);
            let mut t = b.tunnel_between(i, &cj, depth_frac);
            t.b = j as u16;
            if t.kind == TUN_TUNNEL && b.tunnel_ok(&t, None) {
                b.tunnels.push(t);
                loops += 1;
            }
        }
    }

    let mut openings = vec![mouth_open];
    let mut chambers = b.chambers;
    let mut tunnels = b.tunnels;

    // ---- sinkhole: a shaft from a mid-depth chamber up to the sky.
    let p_sink = 0.25 + 0.35 * p.cave_density;
    if b.seq.unit() < p_sink {
        let mut best: Option<usize> = None;
        for (i, c) in chambers.iter().enumerate().skip(1) {
            if c.depth < 36.0 || c.depth > BAND_DEEP {
                continue;
            }
            let dm = libm::sqrt((c.x - sx) * (c.x - sx) + (c.z - sz) * (c.z - sz));
            if dm < 40.0 {
                continue;
            }
            let fl = b.surf.node_flags(c.x, c.z);
            if fl & (flag::SEA | flag::LAKE | flag::RIVER | flag::SETTLEMENT) != 0 {
                continue;
            }
            if best.is_none_or(|bi| c.depth > chambers[bi].depth) {
                best = Some(i);
            }
        }
        if let Some(ci) = best {
            let c = chambers[ci];
            let top = b.surf.exact(c.x, c.z);
            let rs = 3.2 + 0.8 * b.seq.unit();
            let ti = tunnels.len() as u16;
            tunnels.push(Tunnel {
                a: ci as u16,
                b: ci as u16,
                kind: TUN_SHAFT,
                r: rs,
                stretch: 1.0,
                floor_k: 1.0e6,
                pts: polyline([c.x, c.y, c.z], [c.x, top + 6.0, c.z], 0.0),
            });
            chambers[ci].flags |= CH_SUNLIT | CH_SHAFT;
            let rm = f32r(rs + 2.0);
            openings.push(Opening {
                x: f32r(c.x),
                y: f32r(top),
                z: f32r(c.z),
                r_mask: rm,
                r_zone: f32r(rm + 3.0),
                kind: OPEN_SINKHOLE,
                system: index,
                tunnel: ti,
                yaw: 0,
            });
        }
    }
    // "Caves near peaks" touch daylight at the entrance (spec 7 sunsteel).
    if hm - p.sea_y > 0.55 * p.peak_h {
        chambers[0].flags |= CH_SUNLIT;
    }

    let mut deepest = 0usize;
    for (i, c) in chambers.iter().enumerate() {
        if c.depth > chambers[deepest].depth {
            deepest = i;
        }
    }
    chambers[deepest].flags |= CH_DEEPEST;

    // ---- field primitives, in a fixed order: chambers, then tunnel segments.
    let mut elems = Vec::new();
    for c in &chambers {
        elems.push(Elem::chamber([c.x, c.y, c.z], c.rx, c.ry, c.floor, index));
    }
    for t in &tunnels {
        for s in 0..3 {
            elems.push(Elem::segment(t.pts[s], t.pts[s + 1], t.r, t.stretch, t.floor_k, index));
        }
    }
    let mut bbox = [f64::MAX, f64::MAX, f64::MAX, f64::MIN, f64::MIN, f64::MIN];
    for e in &elems {
        for k in 0..3 {
            bbox[k] = bbox[k].min(e.aabb[k]);
            bbox[k + 3] = bbox[k + 3].max(e.aabb[k + 3]);
        }
    }
    let reg = site.region as usize;
    let rb = a.section(sec::REGIONS);
    let max_d = chambers[deepest].depth;
    Some(System {
        index,
        site_index: site.index as u16,
        id: site.id,
        region: site.region,
        biome: Surface::biome(&b.surf, sx, sz),
        elem: rb[reg * 32 + 2],
        elem2: rb[reg * 32 + 3],
        mouth_x: sx,
        mouth_z: sz,
        mouth_y: hm,
        chambers,
        tunnels,
        openings,
        elems,
        veins: Vec::new(),
        decos: Vec::new(),
        bbox,
        deepest: deepest as u16,
        max_depth: max_d,
    })
}

/// Point on a tunnel polyline at fraction f of its parameter (uniform over the 3 segments).
pub fn bezier_at(pts: &[[f64; 3]; 4], f: f64) -> [f64; 3] {
    let t = (f * 3.0).clamp(0.0, 3.0);
    let s = (libm::floor(t) as usize).min(2);
    let u = t - s as f64;
    let (p, q) = (pts[s], pts[s + 1]);
    [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u, p[2] + (q[2] - p[2]) * u]
}

/// Deterministic per-system unit random (for placements outside the build sequence).
pub fn sys_unit(seed: u64, stream: u64, a: i64, b: i64, c: i64) -> f64 {
    crate::rng::unit(hash(seed, stream, a, b, c))
}
