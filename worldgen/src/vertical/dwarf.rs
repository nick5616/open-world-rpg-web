//! The dwarves (playtest 3, genVersion 4, docs/cr/043-dwarves.md): secret
//! camps and great strongholds carved into the Underground, and the cave
//! dressing that makes every tunnel and cavern worth walking.
//!
//! Everything here is appended after the genVersion 3 vertical plan (its
//! chambers, corridors, sites and decorations keep their indices):
//!
//! - **Camps** (3-5 per world): a small walled outpost in a chamber of its
//!   own, 130-230 m off a tunnel or a vast chamber, reached by a narrow
//!   side passage (`rk::SECRET`) marked at its start by a rune-carved
//!   secret door. A hamlet settlement (towns buffer, dwarven style), its
//!   waypoint and the door as sites.
//! - **Strongholds** (1-2): a carved hall city in a great chamber with
//!   three terraces and a throne terrace opposite the great door; a town
//!   settlement; a steep passage from its south rim to the **lower halls**,
//!   a deeper dangerous chamber of old mines (the boss lives there).
//! - **Cave dressing**: timber supports, rails and carts, bones, glowworm
//!   ceilings, ore piles, chests and lore tablets along tunnels and in the
//!   vast chambers.
//!
//! The chambers use the same field maths as every other chamber
//! (`field::chamber_at`, with a flatter floor and, for strongholds, terraces),
//! so hosts need nothing new to walk them.

use super::field::under_at;
use super::tile::TerrainSampler;
use super::under::{cave_boxes, d2, deg, ellipse_angle, ellipse_pt, keep_under, near_cave, path_len, route, CaveBox, ROCK, UNDER_FLOOR_MIN};
use super::*;
use crate::atlas::format::{param, NONE16};
use crate::atlas::region_of;
use crate::cave::graph::CaveWorld;
use crate::cave::veins::{Vein, KIND_GEM, KIND_ORE, ORE_IRON, ORE_SILVER, ORE_STARMETAL, ORE_VOIDGLASS};
use crate::ground::Ground;
use crate::rng::{hash, stable_id, Seq};

const WORLD: f64 = 4096.0;
const TAU: f64 = core::f64::consts::TAU;
/// Height of the stronghold's top terrace over its floor (two risers of half this).
pub const TERRACE_TOP: f64 = 11.0;

fn yaw16(rad: f64) -> u16 {
    ((rad / TAU).rem_euclid(1.0) * 65536.0) as u16
}

/// How the dwarven halls are named.
fn dwarf_name(seq: &mut Seq, hold: bool) -> String {
    const A: [&str; 14] = ["Kor", "Brun", "Thal", "Vor", "Grim", "Dun", "Hald", "Kaz", "Orn", "Bar", "Dro", "Mog", "Tor", "Gal"];
    const CAMP: [&str; 6] = ["hearth", "pick", "nook", "spur", "hollow", "seam"];
    const HOLD: [&str; 6] = ["hold", "deep", "helm", "forge", "halls", "crag"];
    format!("{}{}", seq.pick(&A), seq.pick(if hold { &HOLD } else { &CAMP }))
}

/// Is a chamber one of the dwarves'? (Their decoration is `decorate`'s.)
pub fn is_dwarf(c: &Chamber) -> bool {
    c.kind >= ck::DWARF_CAMP
}

/// Rim floor of a dwarven chamber's passage mouth.
fn rim_floor(c: &Chamber) -> f64 {
    c.floor + if c.kind == ck::STRONGHOLD { TERRACE_TOP } else { 0.0 } + 1.0
}

/// Room for a chamber of influence `reach` at (x, z): in the world, clear of
/// cave systems, chambers, corridors and other dwarven halls.
fn clear(a: &Atlas, p: &Plan, boxes: &[CaveBox], x: f64, z: f64, reach: f64) -> bool {
    let _ = a;
    if x < reach + 60.0 || z < reach + 60.0 || x > WORLD - reach - 60.0 || z > WORLD - reach - 60.0 {
        return false;
    }
    if near_cave(boxes, x, z, reach + 40.0).is_some() {
        return false;
    }
    if p.chambers.iter().any(|o| o.layer == LAYER_UNDER && d2(o.x, o.z, x, z) < (o.reach + reach + 50.0) * (o.reach + reach + 50.0)) {
        return false;
    }
    if p.chambers.iter().any(|o| is_dwarf(o) && d2(o.x, o.z, x, z) < 520.0 * 520.0) {
        return false;
    }
    for r in p.corridors.iter().filter(|r| r.layer == LAYER_UNDER) {
        let m = reach + super::field::corridor_reach(r) + 8.0;
        if r.pts.iter().any(|q| d2(q[0], q[2], x, z) < m * m) {
            return false;
        }
    }
    true
}

/// Floor and height of a chamber at (x, z): as high as the rock over it
/// allows, never under `UNDER_FLOOR_MIN + extra_below`.
fn floor_for(a: &Atlas, x: f64, z: f64, reach: f64, want_h: f64, min_h: f64, extra_below: f64) -> Option<(f64, f64)> {
    let (_, lo) = super::sky::macro_range(a, x, z, reach + 30.0);
    let top = lo - 15.0 - ROCK;
    let mut height = want_h;
    let mut floor = top - height;
    let min_floor = UNDER_FLOOR_MIN + extra_below;
    if floor < min_floor {
        height = top - min_floor;
        floor = min_floor;
        if height < min_h {
            return None;
        }
    }
    Some((floor, height))
}

#[allow(clippy::too_many_arguments)]
fn add_chamber(p: &mut Plan, seed: u64, seq: &mut Seq, kind: u8, x: f64, z: f64, rx: f64, rz: f64, floor: f64, height: f64) -> usize {
    let ang = seq.range(0.0, TAU);
    let (c, s) = (libm::cos(ang), libm::sin(ang));
    let index = p.chambers.len();
    let id = stable_id(idl::CHAMBER, LAYER_UNDER as i32, 0, index as u32);
    p.chambers.push(Chamber {
        layer: LAYER_UNDER,
        kind,
        x,
        z,
        rx,
        rz,
        c,
        s,
        floor,
        height,
        lake: NO_WATER,
        lake_e: 0.0,
        lake_depth: 0.0,
        seed: (hash(seed, stream::CHAMBER, id as i64, 0, 0) >> 32) as u32,
        tint: 6,
        site: NONE16,
        reach: rx * 1.12 + 24.0,
        id,
    });
    index
}

/// A start point on chamber `sc`'s wall toward angle `th`, off the ledge ramps
/// and passages that already run along it (they would cut ledges into the
/// new passage): the nearest angle to `th` whose point is 20 m clear.
fn wall_start(p: &Plan, sc: &Chamber, th: f64, e: f64) -> (f64, f64) {
    for k in 0..25 {
        let off = ((k + 1) / 2) as f64 * 0.12 * if k % 2 == 1 { 1.0 } else { -1.0 };
        let (x, z) = ellipse_pt(sc, e, th + off);
        let busy = p.corridors.iter().filter(|r| r.layer == LAYER_UNDER).any(|r| r.pts.iter().any(|q| d2(q[0], q[2], x, z) < 20.0 * 20.0));
        if !busy {
            return (x, z);
        }
    }
    ellipse_pt(sc, e, th)
}

/// A side passage from `from` (x, y, z on some corridor or chamber rim) to
/// the rim of chamber `to`. Returns the corridor index.
#[allow(clippy::too_many_arguments)]
fn passage(a: &Atlas, p: &mut Plan, boxes: &[CaveBox], seq: &mut Seq, from: [f64; 3], to: usize, from_ch: u16, hw: f64, height: f64, rim_e: f64) -> usize {
    let ch = p.chambers[to].clone();
    let th = ellipse_angle(&ch, from[0], from[2]);
    let (bx, bz) = ellipse_pt(&ch, rim_e, th);
    let yb = rim_floor(&ch);
    let len = ((from[1] - yb).abs() / deg(24.0)).max(libm::sqrt(d2(from[0], from[2], bx, bz)));
    let route_pts = route(seq, (from[0], from[2]), (bx, bz), len, None);
    let s = path_len(&route_pts);
    let total = *s.last().unwrap();
    let mut pts: Vec<[f64; 3]> = route_pts.iter().enumerate().map(|(k, q)| [q.0, from[1] + (yb - from[1]) * (s[k] / total.max(1.0)), q.1]).collect();
    let (mut x0, mut z0, mut x1, mut z1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for q in &pts {
        x0 = x0.min(q[0]);
        z0 = z0.min(q[2]);
        x1 = x1.max(q[0]);
        z1 = z1.max(q[2]);
    }
    let g = Ground::new(a, x0 - 10.0, z0 - 10.0, x1 + 10.0, z1 + 10.0);
    for q in pts.iter_mut() {
        if let Some(cy) = near_cave(boxes, q[0], q[2], 30.0) {
            q[1] = q[1].min(cy - 40.0);
        }
        q[1] = q[1].max(UNDER_FLOOR_MIN);
    }
    // The start stays where it joins the network; the rest keeps under the terrain.
    keep_under(&g, &mut pts, height + 1.5, ROCK, 2, deg(30.0));
    p.corridors.push(Corridor { layer: LAYER_UNDER, kind: rk::SECRET, pts, hw, height, water: 0.0, lava: false, from: from_ch, to: to as u16 });
    p.corridors.len() - 1
}

/// The dwarves' part of the plan (appended last: every earlier chamber,
/// corridor and site keeps its index). Sites are appended too.
pub fn plan(a: &Atlas, cw: &CaveWorld, p: &mut Plan) {
    let seed = a.seed;
    let boxes = cave_boxes(cw);
    let cd = a.param(param::CAVE_DENSITY);
    let mut seq = Seq::new(seed, stream::DWARF);
    let vast: Vec<usize> = (0..p.chambers.len()).filter(|&i| p.chambers[i].layer == LAYER_UNDER).collect();
    if vast.is_empty() {
        return;
    }
    let spawn = (a.param(param::SPAWN_X), a.param(param::SPAWN_Z));
    // Tunnels nearest the spawn first (the first camp is the easiest to find).
    let mut tunnels: Vec<usize> = (0..p.corridors.len()).filter(|&i| p.corridors[i].layer == LAYER_UNDER && p.corridors[i].kind == rk::TUNNEL).collect();
    tunnels.sort_by(|&i, &j| {
        let (pi, pj) = (p.corridors[i].pts[0], p.corridors[j].pts[0]);
        d2(pi[0], pi[2], spawn.0, spawn.1).partial_cmp(&d2(pj[0], pj[2], spawn.0, spawn.1)).unwrap().then(i.cmp(&j))
    });
    let n_hold = 1 + (cd > 0.45) as usize;
    let n_camp = 3 + libm::round(2.0 * cd) as usize;

    // (chamber, settlement kind, passage corridor, lower halls chamber)
    struct Hall {
        ch: usize,
        door: usize,
        lower: Option<usize>,
    }
    let mut halls: Vec<Hall> = Vec::new();

    // ---- strongholds
    for _ in 0..n_hold {
        let mut done = false;
        for t in 0..160 {
            let src = vast[seq.below(vast.len())];
            let sc = p.chambers[src].clone();
            let ang = seq.range(0.0, TAU);
            let rx = seq.range(150.0, 190.0) * if t > 80 { 0.8 } else { 1.0 };
            let reach = rx * 1.12 + 24.0;
            let dist = sc.reach + reach + seq.range(60.0, 220.0);
            let (x, z) = (sc.x + dist * libm::cos(ang), sc.z + dist * libm::sin(ang));
            if !clear(a, p, &boxes, x, z, reach) {
                continue;
            }
            let Some((floor, height)) = floor_for(a, x, z, reach, seq.range(78.0, 100.0), 60.0, 34.0) else { continue };
            // The lower halls: 460+ m away, 30-45 m deeper.
            let l_rx = seq.range(105.0, 125.0);
            let l_reach = l_rx * 1.12 + 24.0;
            let mut lower: Option<(f64, f64, f64, f64, f64)> = None;
            for _ in 0..40 {
                let la = seq.range(0.0, TAU);
                let ld = reach + l_reach + seq.range(70.0, 160.0);
                let (lx, lz) = (x + ld * libm::cos(la), z + ld * libm::sin(la));
                // A trial hall has to clear the stronghold too (not yet in the plan).
                if d2(lx, lz, x, z) < (reach + l_reach + 50.0).powi(2) || !clear(a, p, &boxes, lx, lz, l_reach) {
                    continue;
                }
                let drop = seq.range(30.0, 45.0);
                let lf = (floor - drop).max(UNDER_FLOOR_MIN);
                let (_, lo) = super::sky::macro_range(a, lx, lz, l_reach + 30.0);
                let top = lo - 15.0 - ROCK;
                let h = (top - lf).min(seq.range(46.0, 58.0));
                if h < 40.0 || floor - lf < 14.0 {
                    continue;
                }
                lower = Some((lx, lz, lf, h, l_rx));
                break;
            }
            let Some((lx, lz, lf, lh, l_rx)) = lower else { continue };
            let rz = rx * seq.range(0.7, 0.85);
            let s = add_chamber(p, seed, &mut seq, ck::STRONGHOLD, x, z, rx, rz, floor, height);
            let l_rz = l_rx * seq.range(0.72, 0.9);
            let l = add_chamber(p, seed, &mut seq, ck::LOWER_HALLS, lx, lz, l_rx, l_rz, lf, lh);
            // The Deep Road: from the nearest vast chamber's wall to the great door.
            let th = ellipse_angle(&sc, x, z);
            let (ax, az) = wall_start(p, &sc, th, 0.86);
            let door = passage(a, p, &boxes, &mut seq, [ax, sc.floor + 1.0, az], s, src as u16, 5.0, 10.0, 0.84);
            // The mines' stair: from the stronghold's rim toward the lower halls.
            let sh = p.chambers[s].clone();
            let th2 = ellipse_angle(&sh, lx, lz);
            let (mx, mz) = ellipse_pt(&sh, 0.82, th2);
            passage(a, p, &boxes, &mut seq, [mx, rim_floor(&sh), mz], l, s as u16, 4.4, 8.8, 0.84);
            halls.push(Hall { ch: s, door, lower: Some(l) });
            done = true;
            break;
        }
        let _ = done;
    }

    // ---- camps
    let mut camps = 0usize;
    let mut tun_i = 0usize;
    let mut tries = 0usize;
    while camps < n_camp && tries < 400 {
        tries += 1;
        // The source: a point on a tunnel (while there are tunnels), else a vast chamber's wall.
        let by_tunnel = tun_i < tunnels.len();
        let (from, from_ch, sx, sz, dirx, dirz) = if by_tunnel {
            let r = &p.corridors[tunnels[tun_i % tunnels.len()]];
            let k = ((r.pts.len() as f64 * seq.range(0.35, 0.7)) as usize).clamp(2, r.pts.len() - 3);
            let (a0, b0) = (r.pts[k - 1], r.pts[k + 1]);
            let (tx, tz) = (b0[0] - a0[0], b0[2] - a0[2]);
            let tl = libm::sqrt(tx * tx + tz * tz).max(1e-6);
            let side = if seq.unit() < 0.5 { 1.0 } else { -1.0 };
            (r.pts[k], NONE16, r.pts[k][0], r.pts[k][2], -tz / tl * side, tx / tl * side)
        } else {
            let src = vast[seq.below(vast.len())];
            let sc = &p.chambers[src];
            let th = seq.range(0.0, TAU);
            let (wx, wz) = wall_start(p, sc, th, 0.86);
            let (dx, dz) = (wx - sc.x, wz - sc.z);
            let l = libm::sqrt(dx * dx + dz * dz).max(1e-6);
            ([wx, sc.floor + 1.0, wz], src as u16, wx, wz, dx / l, dz / l)
        };
        let rx = seq.range(56.0, 68.0);
        let reach = rx * 1.12 + 24.0;
        let jitter = seq.range(-0.5, 0.5);
        let (ux, uz) = (dirx - dirz * jitter, dirz + dirx * jitter);
        let ul = libm::sqrt(ux * ux + uz * uz);
        let dist = reach + 42.0 + seq.range(30.0, 130.0);
        let (x, z) = (sx + ux / ul * dist, sz + uz / ul * dist);
        if tries % 6 == 0 && by_tunnel {
            tun_i += 1;
        }
        if !clear(a, p, &boxes, x, z, reach) {
            continue;
        }
        let Some((top_floor, height)) = floor_for(a, x, z, reach, seq.range(26.0, 32.0), 22.0, 6.0) else { continue };
        let floor = top_floor.min(from[1]).max(UNDER_FLOOR_MIN + 6.0);
        if from[1] - floor > 60.0 {
            continue;
        }
        let rz = rx * seq.range(0.75, 0.95);
        let c = add_chamber(p, seed, &mut seq, ck::DWARF_CAMP, x, z, rx, rz, floor, height);
        let door = passage(a, p, &boxes, &mut seq, from, c, from_ch, 3.4, 7.0, 0.84);
        halls.push(Hall { ch: c, door, lower: None });
        camps += 1;
        if by_tunnel {
            tun_i += 1;
        }
    }

    // ---- sites
    let g_names = a.param(param::NAME_GRAMMAR) as usize;
    let _ = g_names;
    for h in &halls {
        let ch = p.chambers[h.ch].clone();
        let hold = ch.kind == ck::STRONGHOLD;
        let mut nseq = Seq::new(seed ^ ch.id, stream::NAMES ^ 0xD3);
        let name = dwarf_name(&mut nseq, hold);
        let local = p.sites.len();
        let biome = super::sky::biome_at(a, ch.x, ch.z);
        p.sites.push(NewSite {
            category: S::CAT_SETTLEMENT,
            kind: 0,
            size: if hold { S::SIZE_TOWN } else { S::SIZE_HAMLET },
            layer: LAYER_UNDER,
            x: ch.x,
            y: ch.floor,
            z: ch.z,
            radius: if hold { 130.0 } else { 45.0 },
            yaw: 0,
            link_local: NONE16,
            name,
            biome,
            element: 3,
            region: region_of(ch.x, ch.z) as u8,
        });
        let abs = (p.base_sites + local) as u16;
        p.chambers[h.ch].site = abs;
        // The hall's waypoint stone (linked to it like a surface town's).
        p.sites.push(NewSite {
            category: S::CAT_POI,
            kind: S::POI_WAYPOINT,
            size: 1,
            layer: LAYER_UNDER,
            x: ch.x,
            y: ch.floor,
            z: ch.z,
            radius: 3.0,
            yaw: 0,
            link_local: local as u16,
            name: String::new(),
            biome,
            element: 255,
            region: region_of(ch.x, ch.z) as u8,
        });
        // The door (the secret door of a camp, the great door of a stronghold).
        let r = &p.corridors[h.door];
        let dp = if hold { r.pts[r.pts.len() - 1] } else { r.pts[1.min(r.pts.len() - 1)] };
        let dn = if hold { format!("Great Door of {}", p.sites[local].name) } else { format!("Hidden Door of {}", p.sites[local].name) };
        p.sites.push(NewSite {
            category: S::CAT_POI,
            kind: S::POI_DWARF_DOOR,
            size: hold as u8,
            layer: LAYER_UNDER,
            x: dp[0],
            y: dp[1],
            z: dp[2],
            radius: 8.0,
            yaw: 0,
            link_local: local as u16,
            name: dn,
            biome,
            element: 3,
            region: region_of(dp[0], dp[2]) as u8,
        });
        if let Some(l) = h.lower {
            let lc = p.chambers[l].clone();
            let mut lseq = Seq::new(seed ^ lc.id, stream::NAMES ^ 0xD4);
            let lname = format!("{} {}", p.sites[local].name, lseq.pick(&["Lower Halls", "Deep Mines", "Under-Delve"]));
            let lsite = p.sites.len();
            p.sites.push(NewSite {
                category: S::CAT_POI,
                kind: S::POI_LOWER_HALLS,
                size: 0,
                layer: LAYER_UNDER,
                x: lc.x,
                y: lc.floor,
                z: lc.z,
                radius: lc.rx.max(lc.rz),
                yaw: 0,
                link_local: local as u16,
                name: lname,
                biome,
                element: 5,
                region: region_of(lc.x, lc.z) as u8,
            });
            p.chambers[l].site = (p.base_sites + lsite) as u16;
        }
    }
}

// ---------------------------------------------------------------------------
// Decoration (rendering, chests and tablets, columns, veins), appended.
// ---------------------------------------------------------------------------

struct Dec<'a, 'b, 'c> {
    p: &'a Plan,
    ts: &'a mut TerrainSampler<'b, 'c>,
    decos: &'a mut Vec<Deco>,
}

impl Dec<'_, '_, '_> {
    fn at(&mut self, x: f64, z: f64) -> super::field::S3 {
        let ts = &mut *self.ts;
        under_at(self.p, LAYER_UNDER, x, z, &mut |x, z| ts.at(x, z))
    }

    #[allow(clippy::too_many_arguments)]
    fn put(&mut self, kind: u8, x: f64, z: f64, size: f64, tint: u8, flags: u8, yaw: u16, aux: u16) {
        let v = self.at(x, z);
        let y = if flags & df::HANG != 0 { v.b } else { v.a };
        if flags & df::HANG != 0 && (v.b < v.a + 3.0 || v.b > 5000.0) {
            return;
        }
        self.decos.push(Deco { x, y, z, size, kind, tint, layer: LAYER_UNDER, flags, yaw, aux });
    }
}

fn corridor_dir(r: &Corridor, k: usize) -> (f64, f64) {
    let (a0, b0) = (r.pts[k.saturating_sub(1)], r.pts[(k + 1).min(r.pts.len() - 1)]);
    let (tx, tz) = (b0[0] - a0[0], b0[2] - a0[2]);
    let l = libm::sqrt(tx * tx + tz * tz).max(1e-6);
    (tx / l, tz / l)
}

pub fn decorate(a: &Atlas, p: &Plan, ts: &mut TerrainSampler, decos: &mut Vec<Deco>, columns: &mut Vec<Column>, veins: &mut Vec<Vein>) {
    let seed = a.seed;
    let mut d = Dec { p, ts, decos };

    // ---- tunnels, passages and the dwarves' roads: supports, rails, carts,
    // glowworms, bones, chests, tablets.
    for ri in 0..p.corridors.len() {
        let r = &p.corridors[ri];
        if r.layer != LAYER_UNDER || !matches!(r.kind, rk::TUNNEL | rk::PASSAGE | rk::SECRET) || r.pts.len() < 4 {
            continue;
        }
        let mut seq = Seq::new(seed ^ (ri as u64 + 1).wrapping_mul(0x9E37_79B9), stream::DRESS);
        let secret = r.kind == rk::SECRET;
        let n = r.pts.len();
        let s = path_len(&r.pts.iter().map(|q| (q[0], q[2])).collect::<Vec<_>>());
        let total = s[n - 1];
        // The way in: a rune-carved door, half hidden in the wall (the camps' and the Deep Road's).
        if secret && (r.from == NONE16 || !is_dwarf(&p.chambers[r.from as usize])) {
            let (dx, dz) = corridor_dir(r, 1);
            d.put(dk::SECRET_DOOR, r.pts[1][0], r.pts[1][2], r.hw * 2.2, 6, df::LIGHT, yaw16(libm::atan2(dz, dx)), ri as u16);
        }
        // Supports (old timber arches) every 50-90 m.
        let mut next = if r.kind == rk::TUNNEL { 46.0 } else { 24.0 };
        for k in 1..n - 1 {
            if s[k] >= next && s[k] < total - 20.0 {
                next = s[k] + seq.range(50.0, 90.0);
                if seq.unit() < if secret { 0.95 } else { 0.7 } {
                    let (dx, dz) = corridor_dir(r, k);
                    d.put(dk::SUPPORT, r.pts[k][0], r.pts[k][2], r.hw * 1.7, 5, 0, yaw16(libm::atan2(dz, dx)), ri as u16);
                }
            }
        }
        // Rails: the whole dwarven road; a spur (a 6-segment stretch ending in a cart) on tunnels.
        let (k0, k1) = if secret { (1, n - 1) } else if r.kind == rk::TUNNEL { (n * 4 / 10, (n * 4 / 10 + 6).min(n - 2)) } else { (0, 0) };
        for k in k0..k1 {
            let (a0, b0) = (r.pts[k], r.pts[k + 1]);
            let (mx, mz) = ((a0[0] + b0[0]) * 0.5, (a0[2] + b0[2]) * 0.5);
            let (dx, dz) = (b0[0] - a0[0], b0[2] - a0[2]);
            let l = libm::sqrt(dx * dx + dz * dz);
            d.put(dk::RAILS, mx, mz, l, 5, 0, yaw16(libm::atan2(dz, dx)), ri as u16);
            if (k - k0) % 9 == 4 || (!secret && k + 1 == k1) {
                let off = r.hw * 0.0;
                d.put(dk::MINECART, mx + dz / l.max(1e-6) * off, mz - dx / l.max(1e-6) * off, 1.6, 5, 0, yaw16(libm::atan2(dz, dx) + seq.range(-0.15, 0.15)), ri as u16);
            }
        }
        // Glowworm ceilings: turquoise clusters hanging over the way.
        let mut gnext = seq.range(20.0, 50.0);
        for k in 1..n - 1 {
            if s[k] >= gnext {
                gnext = s[k] + seq.range(26.0, 60.0);
                d.put(dk::GLOWWORMS, r.pts[k][0], r.pts[k][2], seq.range(3.0, 5.5), 8, df::HANG, yaw16(seq.range(0.0, TAU)), ri as u16);
            }
        }
        // Bones, a collapse, a chest, a tablet.
        for _ in 0..(1 + (total / 160.0) as usize) {
            let k = 1 + seq.below(n - 2);
            let (dx, dz) = corridor_dir(r, k);
            let side = r.hw * seq.range(0.2, 0.55) * if seq.unit() < 0.5 { 1.0 } else { -1.0 };
            d.put(dk::BONES, r.pts[k][0] - dz * side, r.pts[k][2] + dx * side, seq.range(0.9, 1.7), 9, 0, yaw16(seq.range(0.0, TAU)), ri as u16);
        }
        if !secret && seq.unit() < 0.6 {
            let k = 2 + seq.below(n - 4);
            let (dx, dz) = corridor_dir(r, k);
            d.put(dk::COLLAPSE, r.pts[k][0], r.pts[k][2], r.hw * 0.9, 5, 0, yaw16(libm::atan2(dz, dx)), ri as u16);
        }
        for c in 0..(1 + (total / 320.0) as usize).min(3) {
            let k = ((n as f64) * seq.range(0.2, 0.9)) as usize;
            let k = k.clamp(2, n - 3);
            let (dx, dz) = corridor_dir(r, k);
            let side = r.hw * 0.62 * if c % 2 == 0 { 1.0 } else { -1.0 };
            d.put(dk::CHEST, r.pts[k][0] - dz * side, r.pts[k][2] + dx * side, 1.0, if secret { 2 } else { 1 }, df::INTERACT, yaw16(libm::atan2(dz, dx) + 1.5), ri as u16);
        }
        if r.kind != rk::PASSAGE || seq.unit() < 0.4 {
            let k = (n / 2).clamp(2, n - 3);
            let (dx, dz) = corridor_dir(r, k);
            let side = r.hw * 0.6;
            d.put(dk::TABLET, r.pts[k][0] - dz * side, r.pts[k][2] + dx * side, 1.2, 5, df::INTERACT, yaw16(libm::atan2(dz, dx) + 1.57), (hash(seed, stream::DRESS, ri as i64, 7, 0) >> 48) as u16);
        }
    }

    // ---- the vast chambers: old workings and the dead.
    for ci in 0..p.chambers.len() {
        let ch = &p.chambers[ci];
        if ch.layer != LAYER_UNDER || is_dwarf(ch) {
            continue;
        }
        let mut seq = Seq::new(seed ^ ch.id, stream::DRESS);
        let area = ch.rx * ch.rz / 10000.0;
        let spot = |seq: &mut Seq, lo: f64, hi: f64| ellipse_pt(ch, seq.range(lo, hi), seq.range(0.0, TAU));
        for _ in 0..(3.0 + 2.0 * area) as usize {
            let (x, z) = spot(&mut seq, 0.25, 0.85);
            let v = d.at(x, z);
            if v.w > v.a - 0.2 || v.b < v.a + 4.0 {
                continue;
            }
            d.put(dk::BONES, x, z, seq.range(1.0, 2.2), 9, 0, yaw16(seq.range(0.0, TAU)), ci as u16);
        }
        for _ in 0..((8.0 + 5.0 * area) as usize).min(40) {
            let (x, z) = spot(&mut seq, 0.1, 0.8);
            d.put(dk::GLOWWORMS, x, z, seq.range(4.0, 9.0), 8, df::HANG, yaw16(seq.range(0.0, TAU)), ci as u16);
        }
        let n_chest = 1 + (ch.rx > 140.0) as usize;
        for _ in 0..n_chest * 8 {
            if d.decos.iter().filter(|q| q.kind == dk::CHEST && q.aux == ci as u16 && q.flags & df::INTERACT != 0).count() >= n_chest {
                break;
            }
            let (x, z) = spot(&mut seq, 0.5, 0.85);
            let v = d.at(x, z);
            if v.w > v.a - 0.2 || v.b < v.a + 4.0 {
                continue;
            }
            d.put(dk::CHEST, x, z, 1.0, 1, df::INTERACT, yaw16(seq.range(0.0, TAU)), ci as u16);
        }
        // Old workings: a cart on a few rails, timber frames, a collapse.
        let th = seq.range(0.0, TAU);
        let (x, z) = ellipse_pt(ch, 0.6, th);
        let v = d.at(x, z);
        if v.w <= v.a - 0.2 && v.b > v.a + 6.0 {
            let yaw = seq.range(0.0, TAU);
            for k in 0..3 {
                d.put(dk::RAILS, x + libm::cos(yaw) * 14.0 * k as f64, z + libm::sin(yaw) * 14.0 * k as f64, 14.0, 5, 0, yaw16(yaw), ci as u16);
            }
            d.put(dk::MINECART, x + libm::cos(yaw) * 36.0, z + libm::sin(yaw) * 36.0, 1.6, 5, 0, yaw16(yaw + 0.2), ci as u16);
            d.put(dk::SUPPORT, x - libm::cos(yaw) * 6.0, z - libm::sin(yaw) * 6.0, 7.0, 5, 0, yaw16(yaw), ci as u16);
        }
        for _ in 0..2 {
            let (x, z) = spot(&mut seq, 0.3, 0.8);
            let v = d.at(x, z);
            if v.w > v.a - 0.2 || v.b < v.a + 4.0 {
                continue;
            }
            d.put(dk::ORE_PILE, x, z, seq.range(1.2, 2.2), 1, 0, yaw16(seq.range(0.0, TAU)), ci as u16);
        }
        if seq.unit() < 0.45 {
            let (x, z) = spot(&mut seq, 0.5, 0.8);
            d.put(dk::TABLET, x, z, 1.2, 5, df::INTERACT, yaw16(seq.range(0.0, TAU)), (hash(seed, stream::DRESS, ci as i64, 9, 0) >> 48) as u16);
        }
    }

    // ---- the dwarves' halls.
    for ci in 0..p.chambers.len() {
        let ch = &p.chambers[ci];
        if !is_dwarf(ch) {
            continue;
        }
        let mut seq = Seq::new(seed ^ ch.id, stream::DRESS ^ 0xD);
        let ring = |seq: &mut Seq, lo: f64, hi: f64| {
            let e = seq.range(lo, hi);
            ellipse_pt(ch, e, seq.range(0.0, TAU))
        };
        // The door corridor and its rim mouth.
        let door = p.corridors.iter().position(|r| r.kind == rk::SECRET && r.to as usize == ci);
        let th_door = door.map(|k| {
            let q = p.corridors[k].pts[p.corridors[k].pts.len() - 1];
            ellipse_angle(ch, q[0], q[2])
        });
        match ch.kind {
            ck::DWARF_CAMP => {
                // A rune gate where the road comes in, braziers and pillars at the rim, banners.
                if let Some(th) = th_door {
                    let (x, z) = ellipse_pt(ch, 0.8, th);
                    let yaw = libm::atan2(ch.z - z, ch.x - x);
                    d.put(dk::DWARF_DOOR, x, z, 7.0, 6, df::LIGHT, yaw16(yaw), ci as u16);
                    for side in [-1.0, 1.0] {
                        let (px, pz) = (x - libm::sin(yaw) * 5.5 * side, z + libm::cos(yaw) * 5.5 * side);
                        d.put(dk::BRAZIER, px, pz, 1.4, 0, 0, 0, ci as u16);
                    }
                }
                for k in 0..8 {
                    let th = TAU * k as f64 / 8.0 + seq.range(-0.15, 0.15);
                    let (x, z) = ellipse_pt(ch, 0.74, th);
                    d.put(dk::BRAZIER, x, z, 1.4, 0, if k % 4 == 1 { df::LIGHT } else { 0 }, 0, ci as u16);
                    if k % 2 == 0 {
                        d.put(dk::BANNER, x, z, 4.2, 6, 0, yaw16(libm::atan2(ch.z - z, ch.x - x)), ci as u16);
                    }
                }
                for _ in 0..3 {
                    let (x, z) = ring(&mut seq, 0.72, 0.72);
                    d.put(dk::ORE_PILE, x, z, seq.range(1.4, 2.4), 1, 0, yaw16(seq.range(0.0, TAU)), ci as u16);
                }
                for _ in 0..10 {
                    let (x, z) = ring(&mut seq, 0.1, 0.9);
                    d.put(dk::STALACTITE, x, z, seq.range(3.0, 9.0), 6, df::HANG, yaw16(seq.range(0.0, TAU)), ci as u16);
                }
                for _ in 0..8 {
                    let (x, z) = ring(&mut seq, 0.1, 0.8);
                    d.put(dk::GLOWWORMS, x, z, seq.range(3.0, 6.0), 8, df::HANG, yaw16(seq.range(0.0, TAU)), ci as u16);
                }
                let (x, z) = ring(&mut seq, 0.76, 0.76);
                d.put(dk::CHEST, x, z, 1.0, 2, df::INTERACT, yaw16(seq.range(0.0, TAU)), ci as u16);
                let (x, z) = ring(&mut seq, 0.74, 0.74);
                d.put(dk::TABLET, x, z, 1.2, 6, df::INTERACT, yaw16(libm::atan2(ch.z - z, ch.x - x)), (hash(seed, stream::DRESS, ci as i64, 11, 0) >> 48) as u16);
                n_veins(&mut d, veins, ch, ci, &mut seq, 3, false);
            }
            ck::STRONGHOLD => {
                let th = th_door.unwrap_or(0.0);
                // The great door at the rim, its pillars, statues and the processional braziers.
                let (dx0, dz0) = ellipse_pt(ch, 0.83, th);
                let yaw = libm::atan2(ch.z - dz0, ch.x - dx0);
                d.put(dk::DWARF_DOOR, dx0, dz0, 17.0, 6, df::LIGHT, yaw16(yaw), ci as u16);
                for side in [-1.0, 1.0] {
                    let (px, pz) = (dx0 - libm::sin(yaw) * 13.0 * side, dz0 + libm::cos(yaw) * 13.0 * side);
                    d.put(dk::DWARF_PILLAR, px, pz, 22.0, 6, 0, yaw16(yaw), ci as u16);
                    let (sx, sz) = (dx0 + libm::cos(yaw) * 9.0 - libm::sin(yaw) * 17.0 * side, dz0 + libm::sin(yaw) * 9.0 + libm::cos(yaw) * 17.0 * side);
                    d.put(dk::STATUE, sx, sz, 11.0, 6, 0, yaw16(yaw), ci as u16);
                }
                for k in 1..=10 {
                    let t = k as f64 / 11.0;
                    let (ax, az) = (dx0 + (ch.x - dx0) * t, dz0 + (ch.z - dz0) * t);
                    for side in [-1.0, 1.0] {
                        let (px, pz) = (ax - libm::sin(yaw) * 9.0 * side, az + libm::cos(yaw) * 9.0 * side);
                        d.put(dk::BRAZIER, px, pz, 1.8, 0, if k % 3 == 0 && side > 0.0 { df::LIGHT } else { 0 }, 0, ci as u16);
                        if k % 2 == 0 {
                            d.put(dk::BANNER, px, pz, 5.5, 6, 0, yaw16(yaw + 1.57 * side), ci as u16);
                        }
                    }
                }
                // The throne terrace, opposite the door: throne, rune circle, a colonnade.
                let tth = th + core::f64::consts::PI;
                let (tx, tz) = ellipse_pt(ch, 0.68, tth);
                let tyaw = libm::atan2(ch.z - tz, ch.x - tx);
                d.put(dk::THRONE, tx, tz, 9.0, 6, df::LIGHT, yaw16(tyaw), ci as u16);
                d.put(dk::RUNES, tx + libm::cos(tyaw) * 14.0, tz + libm::sin(tyaw) * 14.0, 13.0, 6, df::LIGHT, 0, ci as u16);
                for k in 0..8 {
                    let a2 = TAU * k as f64 / 8.0;
                    let (px, pz) = (tx + libm::cos(a2) * 24.0, tz + libm::sin(a2) * 24.0);
                    let v = d.at(px, pz);
                    if v.b - v.a >= 25.0 && v.b < 5000.0 {
                        columns.push(Column { x: px, z: pz, r: 3.2, y0: v.a, y1: v.b, layer: LAYER_UNDER, chamber: ci as u16 });
                    }
                }
                // Forge glow in the smiths' quarter, stalactites and glowworms, ore.
                for k in 0..6 {
                    let (x, z) = ellipse_pt(ch, seq.range(0.35, 0.5), TAU * k as f64 / 6.0 + seq.range(-0.2, 0.2));
                    d.put(dk::FORGEGLOW, x, z, seq.range(3.0, 5.0), 0, if k % 3 == 0 { df::LIGHT } else { 0 }, yaw16(seq.range(0.0, TAU)), ci as u16);
                }
                for _ in 0..40 {
                    let (x, z) = ring(&mut seq, 0.1, 0.9);
                    d.put(dk::STALACTITE, x, z, seq.range(5.0, 18.0), 6, df::HANG, yaw16(seq.range(0.0, TAU)), ci as u16);
                }
                for _ in 0..24 {
                    let (x, z) = ring(&mut seq, 0.1, 0.85);
                    d.put(dk::GLOWWORMS, x, z, seq.range(5.0, 11.0), 8, df::HANG, yaw16(seq.range(0.0, TAU)), ci as u16);
                }
                for _ in 0..5 {
                    let (x, z) = ring(&mut seq, 0.3, 0.7);
                    d.put(dk::ORE_PILE, x, z, seq.range(1.6, 2.8), 1, 0, yaw16(seq.range(0.0, TAU)), ci as u16);
                }
                for _ in 0..2 {
                    let (x, z) = ring(&mut seq, 0.55, 0.7);
                    d.put(dk::CHEST, x, z, 1.1, 3, df::INTERACT, yaw16(seq.range(0.0, TAU)), ci as u16);
                }
                let (x, z) = ellipse_pt(ch, 0.64, tth + 0.35);
                d.put(dk::TABLET, x, z, 1.4, 6, df::INTERACT, yaw16(tyaw), (hash(seed, stream::DRESS, ci as i64, 13, 0) >> 48) as u16);
                // The mines' stair: an iron-bound gate at its start.
                if let Some(k) = p.corridors.iter().position(|r| r.kind == rk::SECRET && r.from as usize == ci) {
                    let q = p.corridors[k].pts[0];
                    let (dx, dz) = corridor_dir(&p.corridors[k], 1);
                    d.put(dk::DWARF_DOOR, q[0] + dx * 3.0, q[2] + dz * 3.0, 8.5, 5, df::LIGHT, yaw16(libm::atan2(dz, dx) + core::f64::consts::PI), ci as u16);
                }
                n_veins(&mut d, veins, ch, ci, &mut seq, 8, false);
            }
            _ => {
                // The lower halls: old mines, the fallen, a rune circle for what waits.
                d.put(dk::RUNES, ch.x, ch.z, 22.0, 7, df::LIGHT, 0, ci as u16);
                for _ in 0..14 {
                    let (x, z) = ring(&mut seq, 0.2, 0.85);
                    d.put(dk::BONES, x, z, seq.range(1.0, 2.4), 9, 0, yaw16(seq.range(0.0, TAU)), ci as u16);
                }
                for k in 0..4 {
                    let yaw = seq.range(0.0, TAU);
                    let (x, z) = ring(&mut seq, 0.4, 0.8);
                    for j in 0..3 {
                        d.put(dk::RAILS, x + libm::cos(yaw) * 14.0 * j as f64, z + libm::sin(yaw) * 14.0 * j as f64, 14.0, 5, 0, yaw16(yaw), ci as u16);
                    }
                    d.put(dk::MINECART, x + libm::cos(yaw) * 36.0, z + libm::sin(yaw) * 36.0, 1.6, 5, 0, yaw16(yaw + k as f64 * 0.3), ci as u16);
                }
                for _ in 0..7 {
                    let (x, z) = ring(&mut seq, 0.3, 0.85);
                    d.put(dk::SUPPORT, x, z, seq.range(6.0, 9.0), 5, 0, yaw16(seq.range(0.0, TAU)), ci as u16);
                }
                for _ in 0..6 {
                    let (x, z) = ring(&mut seq, 0.3, 0.85);
                    d.put(dk::COLLAPSE, x, z, seq.range(4.0, 8.0), 5, 0, yaw16(seq.range(0.0, TAU)), ci as u16);
                }
                for _ in 0..8 {
                    let (x, z) = ring(&mut seq, 0.3, 0.85);
                    d.put(dk::ORE_PILE, x, z, seq.range(1.4, 2.8), 4, 0, yaw16(seq.range(0.0, TAU)), ci as u16);
                }
                for _ in 0..4 {
                    let (x, z) = ring(&mut seq, 0.2, 0.8);
                    d.put(dk::BRAZIER, x, z, 1.8, 0, df::LIGHT, 0, ci as u16);
                }
                for _ in 0..26 {
                    let (x, z) = ring(&mut seq, 0.1, 0.85);
                    d.put(dk::GLOWWORMS, x, z, seq.range(4.0, 9.0), 7, df::HANG, yaw16(seq.range(0.0, TAU)), ci as u16);
                }
                for _ in 0..24 {
                    let (x, z) = ring(&mut seq, 0.1, 0.9);
                    d.put(dk::STALACTITE, x, z, seq.range(4.0, 16.0), 6, df::HANG, yaw16(seq.range(0.0, TAU)), ci as u16);
                }
                for _ in 0..3 {
                    let (x, z) = ring(&mut seq, 0.5, 0.8);
                    d.put(dk::CHEST, x, z, 1.1, 3, df::INTERACT, yaw16(seq.range(0.0, TAU)), ci as u16);
                }
                for k in 0..2 {
                    let (x, z) = ring(&mut seq, 0.4, 0.7);
                    d.put(dk::TABLET, x, z, 1.3, 7, df::INTERACT, yaw16(seq.range(0.0, TAU)), (hash(seed, stream::DRESS, ci as i64, 15 + k, 0) >> 48) as u16);
                }
                for _ in 0..5 {
                    let (x, z) = ring(&mut seq, 0.25, 0.7);
                    let v = d.at(x, z);
                    if v.b - v.a >= 25.0 && v.b < 5000.0 && columns.iter().all(|c| d2(c.x, c.z, x, z) > 900.0) {
                        columns.push(Column { x, z, r: seq.range(3.0, 5.0), y0: v.a, y1: v.b, layer: LAYER_UNDER, chamber: ci as u16 });
                    }
                }
                n_veins(&mut d, veins, ch, ci, &mut seq, 12, true);
            }
        }
    }
}

/// Veins in a dwarven chamber's walls.
fn n_veins(d: &mut Dec, veins: &mut Vec<Vein>, ch: &Chamber, ci: usize, seq: &mut Seq, n: usize, rich: bool) {
    for vi in 0..n {
        let th = seq.range(0.0, TAU);
        let e = seq.range(0.8, 0.9);
        let (x, z) = ellipse_pt(ch, e, th);
        let v = d.at(x, z);
        if v.b < v.a + 3.0 {
            continue;
        }
        let (cx2, cz2) = ellipse_pt(ch, e - 0.08, th);
        let (nx, nz) = (cx2 - x, cz2 - z);
        let nl = libm::sqrt(nx * nx + nz * nz).max(1e-9);
        let gem = seq.unit() < if rich { 0.3 } else { 0.2 };
        let (kind, material, element, hp) = if gem {
            let m = [1u8, 4, 7, 8, 9, 2][seq.below(6)];
            (KIND_GEM, m, if m < 8 { m } else { 255 }, 150)
        } else {
            let m = if rich { [ORE_IRON, ORE_SILVER, ORE_STARMETAL, ORE_VOIDGLASS][seq.below(4)] } else { [ORE_IRON, ORE_SILVER, ORE_IRON][seq.below(3)] };
            (KIND_ORE, m, 255, if rich { 220 } else { 150 })
        };
        veins.push(Vein {
            id: stable_id(idl::VEIN, 2, ci as i32 + 100, vi as u32),
            x,
            y: v.a + 0.6,
            z,
            n: [nx / nl * 0.8, 0.6, nz / nl * 0.8],
            kind,
            material,
            element,
            hp,
            size: 3 + seq.below(5) as u8,
            flags: 0,
            band: 3,
            chamber: ci as u16,
            system: 0xFFFF,
        });
    }
}
