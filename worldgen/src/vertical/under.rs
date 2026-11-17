//! The Underground (layer 2) and the Depths (layer 3).
//!
//! Tunnel entrances sit on hillsides like cave mouths but far from them; a
//! long tunnel winds down into the hill and comes out on a balcony high on
//! the wall of a vast chamber (100-420 m across, a domed roof 80-150 m up),
//! then a ledge ramp follows the wall down to the floor. Vast chambers are
//! joined by passages and underground rivers; cenote chambers have a lake
//! under one or two skylight shafts to the surface; a few chambers hold a
//! safe camp. Under the deepest chambers a gate in the floor opens on a
//! steep descent into the Depths: halls of lava lakes and ash joined by
//! lava rivers.
//!
//! Everything stays clear of the WP09 cave systems (their bounding boxes)
//! and keeps rock between layers: Underground air never rises above the
//! terrain minus 30 m (except in openings) and never goes below -260 m;
//! Depths air stays under -330 m.

use super::sky::{biome_at, dry, macro_at, macro_range};
use super::*;
use crate::atlas::format::{param, NONE16, RES};
use crate::atlas::region_of;
use crate::cave::graph::CaveWorld;
use crate::ground::Ground;
use crate::names;
use crate::rng::{hash, stable_id, Seq};

const WORLD: f64 = 4096.0;
const TAU: f64 = core::f64::consts::TAU;
/// Deepest Underground floor; highest Depths ceiling.
pub const UNDER_FLOOR_MIN: f64 = -260.0;
pub const DEPTHS_CEIL_MAX: f64 = -330.0;
/// Rock kept over Underground air (below the macro low point).
pub(super) const ROCK: f64 = 34.0;
/// Opening radius of a tunnel mouth.
pub const MOUTH_R: f64 = 12.0;
pub const GATE_R: f64 = 15.0;
/// Chamber wall profile: F rises from WALL_E0 to WALL_E1 by (height + WALL_EXTRA).
pub const WALL_E0: f64 = 0.80;
pub const WALL_E1: f64 = 1.02;
pub const WALL_EXTRA: f64 = 30.0;
pub const WALL_POW: f64 = 1.6;

#[inline]
pub(super) fn d2(ax: f64, az: f64, bx: f64, bz: f64) -> f64 {
    (ax - bx) * (ax - bx) + (az - bz) * (az - bz)
}

pub(super) fn deg(t: f64) -> f64 {
    libm::tan(t * core::f64::consts::PI / 180.0)
}

/// Inverse of the chamber wall profile: the ellipse radius e where the wall
/// stands `y` above the floor (clamped to the wall's foot / top).
pub fn wall_e(y: f64, height: f64) -> f64 {
    let top = height + WALL_EXTRA;
    let s = libm::pow((y / top).clamp(0.0, 1.0), 1.0 / WALL_POW);
    // Solve 3t^2 - 2t^3 = s by bisection.
    let (mut lo, mut hi) = (0.0, 1.0);
    for _ in 0..40 {
        let t = 0.5 * (lo + hi);
        if t * t * (3.0 - 2.0 * t) < s {
            lo = t;
        } else {
            hi = t;
        }
    }
    WALL_E0 + (WALL_E1 - WALL_E0) * 0.5 * (lo + hi)
}

/// World point of ellipse radius e at angle th of chamber c.
pub fn ellipse_pt(c: &Chamber, e: f64, th: f64) -> (f64, f64) {
    let u = c.rx * e * libm::cos(th);
    let v = c.rz * e * libm::sin(th);
    (c.x + u * c.c - v * c.s, c.z + u * c.s + v * c.c)
}

/// Angle on chamber c toward world point (x, z).
pub(super) fn ellipse_angle(c: &Chamber, x: f64, z: f64) -> f64 {
    let (dx, dz) = (x - c.x, z - c.z);
    let u = dx * c.c + dz * c.s;
    let v = -dx * c.s + dz * c.c;
    libm::atan2(v / c.rz, u / c.rx)
}

pub(super) struct CaveBox {
    pub b: [f64; 6],
}

pub(super) fn cave_boxes(cw: &CaveWorld) -> Vec<CaveBox> {
    cw.systems.iter().map(|s| CaveBox { b: s.bbox }).collect()
}

pub(super) fn near_cave(boxes: &[CaveBox], x: f64, z: f64, m: f64) -> Option<f64> {
    let mut lowest: Option<f64> = None;
    for c in boxes {
        if x >= c.b[0] - m && x <= c.b[3] + m && z >= c.b[2] - m && z <= c.b[5] + m {
            lowest = Some(lowest.map_or(c.b[1], |l: f64| l.min(c.b[1])));
        }
    }
    lowest
}

/// Planar path from `from` to `to` about `len` long: a first leg along
/// `dir` (into the hill), then legs that zig-zag (switchbacks) when the
/// straight line is too short for the descent, wiggled by noise. Points ~14 m apart.
pub(super) fn route(seq: &mut Seq, from: (f64, f64), to: (f64, f64), len: f64, dir: Option<(f64, f64)>) -> Vec<(f64, f64)> {
    let mut pts = vec![from];
    let mut p = from;
    if let Some((dx, dz)) = dir {
        for k in 1..=3 {
            let q = (from.0 + dx * 12.0 * k as f64, from.1 + dz * 12.0 * k as f64);
            pts.push(q);
            p = q;
        }
    }
    let (dx, dz) = (to.0 - p.0, to.1 - p.1);
    let d = libm::sqrt(dx * dx + dz * dz).max(1.0);
    let done = if dir.is_some() { 36.0 } else { 0.0 };
    let need = (len - done).max(d);
    let (ux, uz) = (dx / d, dz / d);
    let (nx, nz) = (-uz, ux);
    let legs = if need > d * 1.15 { 2 + libm::floor(need / 200.0) as usize } else { 1 };
    let amp = if legs > 1 { 0.5 * libm::sqrt(((need / legs as f64).powi(2) - (d / legs as f64).powi(2)).max(0.0)) } else { 0.0 };
    let side0 = if seq.unit() < 0.5 { 1.0 } else { -1.0 };
    let mut corners = Vec::new();
    for l in 1..legs {
        let t = l as f64 / legs as f64;
        let side = if l % 2 == 1 { side0 } else { -side0 };
        corners.push((p.0 + dx * t + nx * amp * side * 2.0, p.1 + dz * t + nz * amp * side * 2.0));
    }
    corners.push(to);
    let wig = seq.range(0.0, 100.0);
    let mut prev = p;
    for c in corners {
        let (ex, ez) = (c.0 - prev.0, c.1 - prev.1);
        let el = libm::sqrt(ex * ex + ez * ez);
        let n = (libm::ceil(el / 14.0) as usize).max(1);
        let (wx, wz) = (-ez / el.max(1e-9), ex / el.max(1e-9));
        for k in 1..=n {
            let t = k as f64 / n as f64;
            let w = if k == n { 0.0 } else { 4.0 * crate::noise::noise(7, wig + (pts.len() as f64) * 0.21, 0.5) * libm::sin(t * core::f64::consts::PI) };
            pts.push((prev.0 + ex * t + wx * w, prev.1 + ez * t + wz * w));
        }
        prev = c;
    }
    pts
}

pub(super) fn path_len(p: &[(f64, f64)]) -> Vec<f64> {
    let mut s = vec![0.0];
    for w in p.windows(2) {
        let l = libm::sqrt(d2(w[0].0, w[0].1, w[1].0, w[1].1));
        s.push(s.last().unwrap() + l);
    }
    s
}

/// Keep `floor + room` under the exact terrain (minus `rock`) along a path,
/// lowering points (never raising), then limit slopes to `max_tan` by
/// lowering neighbours. The first `skip` points (inside the mouth) are kept.
pub(super) fn keep_under(g: &Ground, pts: &mut [[f64; 3]], room: f64, rock: f64, skip: usize, max_tan: f64) {
    let n = pts.len();
    for i in skip..n {
        let mut lo = g.sample(pts[i][0], pts[i][2]).0;
        // Also a little to each side (the corridor is wide).
        for (ox, oz) in [(5.0, 0.0), (-5.0, 0.0), (0.0, 5.0), (0.0, -5.0)] {
            lo = lo.min(g.sample(pts[i][0] + ox, pts[i][2] + oz).0);
        }
        pts[i][1] = pts[i][1].min(lo - rock - room);
    }
    for _ in 0..3 {
        for i in skip.max(1)..n {
            let ds = libm::sqrt(d2(pts[i][0], pts[i][2], pts[i - 1][0], pts[i - 1][2]));
            pts[i][1] = pts[i][1].min(pts[i - 1][1] + max_tan * ds);
        }
        for i in (skip.max(1)..n).rev() {
            if i - 1 < skip {
                break;
            }
            let ds = libm::sqrt(d2(pts[i][0], pts[i][2], pts[i - 1][0], pts[i - 1][2]));
            pts[i - 1][1] = pts[i - 1][1].min(pts[i][1] + max_tan * ds);
        }
    }
}

pub fn plan(a: &Atlas, cw: &CaveWorld, p: &mut Plan) {
    let seed = a.seed;
    let g_names = a.param(param::NAME_GRAMMAR) as usize;
    let cave_density = a.param(param::CAVE_DENSITY);
    let sea_y = a.sea_y;
    let spawn = (a.param(param::SPAWN_X), a.param(param::SPAWN_Z));
    let boxes = cave_boxes(cw);
    let mut seq = Seq::new(seed, stream::UNDER);
    let base: Vec<SiteRec> = (0..p.base_sites).map(|i| a.site(i)).collect();
    let mouths: Vec<(f64, f64)> = base.iter().filter(|s| s.category == S::CAT_POI && s.kind == S::POI_CAVE_MOUTH).map(|s| (s.x, s.z)).collect();
    let lifts: Vec<(f64, f64)> = p.updrafts.iter().map(|u| (u.x, u.z)).collect();

    // ---- 1. tunnel entrances: hillsides facing downhill, clear of sites,
    // cave systems and each other; the first within reach of the spawn.
    let n_tun = 4 + libm::round(4.0 * cave_density) as usize;
    let mut cand: Vec<(f64, f64, f64, f64, f64)> = Vec::new(); // score, x, z, gx, gz
    let mut j = 6usize;
    while j < crate::atlas::format::N - 6 {
        let mut i = 6usize;
        while i < crate::atlas::format::N - 6 {
            let (x, z) = (i as f64 * RES + 16.0, j as f64 * RES + 16.0);
            let h = macro_at(a, x, z);
            let gx = (macro_at(a, x + 24.0, z) - macro_at(a, x - 24.0, z)) / 48.0;
            let gz = (macro_at(a, x, z + 24.0) - macro_at(a, x, z - 24.0)) / 48.0;
            let slope = libm::sqrt(gx * gx + gz * gz);
            if h > sea_y + 8.0 && (0.12..0.55).contains(&slope) && dry(a, x, z) && dry(a, x - gx * 40.0, z - gz * 40.0) {
                let u = crate::rng::unit(hash(seed, stream::UNDER, i as i64, j as i64, 0));
                let ds = libm::sqrt(d2(x, z, spawn.0, spawn.1));
                let near_spawn = if (420.0..900.0).contains(&ds) { 2.0 } else { 0.0 };
                cand.push((u + near_spawn + (0.35 - (slope - 0.3).abs()), x, z, gx, gz));
            }
            i += 2;
        }
        j += 2;
    }
    cand.sort_by(|p1, p2| p2.0.partial_cmp(&p1.0).unwrap());
    let mut entrances: Vec<(f64, f64, f64, f64)> = Vec::new(); // x, z, ux, uz (uphill unit)
    for &(_, x, z, gx, gz) in &cand {
        if entrances.len() >= n_tun {
            break;
        }
        if x < 260.0 || z < 260.0 || x > WORLD - 260.0 || z > WORLD - 260.0 {
            continue;
        }
        if entrances.iter().any(|e| d2(e.0, e.1, x, z) < 820.0 * 820.0) {
            continue;
        }
        if mouths.iter().any(|m| d2(m.0, m.1, x, z) < 380.0 * 380.0) || near_cave(&boxes, x, z, 150.0).is_some() {
            continue;
        }
        if base.iter().any(|s| d2(s.x, s.z, x, z) < (s.radius + 70.0) * (s.radius + 70.0)) {
            continue;
        }
        if lifts.iter().any(|l| d2(l.0, l.1, x, z) < 120.0 * 120.0) {
            continue;
        }
        let l = libm::sqrt(gx * gx + gz * gz);
        entrances.push((x, z, gx / l, gz / l));
    }

    // ---- 2. vast chambers: one beyond each entrance (into the hill), then
    // more on a jittered grid, never under a cave system.
    let place_chamber = |p: &mut Plan, seq: &mut Seq, x: f64, z: f64, rx: f64, kind: u8, layer: u8| -> Option<usize> {
        let rz = rx * seq.range(0.62, 0.95);
        let ang = seq.range(0.0, TAU);
        let (c, s) = (libm::cos(ang), libm::sin(ang));
        let reach = rx * 1.12 + 24.0;
        if x < reach + 60.0 || z < reach + 60.0 || x > WORLD - reach - 60.0 || z > WORLD - reach - 60.0 {
            return None;
        }
        if p.chambers.iter().any(|o| o.layer == layer && d2(o.x, o.z, x, z) < (o.reach + reach + 50.0) * (o.reach + reach + 50.0)) {
            return None;
        }
        let mut height = (rx * seq.range(0.55, 0.8)).clamp(70.0, 150.0);
        let floor = if layer == LAYER_UNDER {
            if near_cave(&boxes, x, z, reach + 40.0).is_some() {
                return None;
            }
            let (_, lo) = macro_range(a, x, z, reach + 30.0);
            let top = lo - 15.0 - ROCK;
            let mut floor = top - height;
            if floor < UNDER_FLOOR_MIN {
                height = (top - UNDER_FLOOR_MIN).max(0.0);
                floor = UNDER_FLOOR_MIN;
                if height < 55.0 {
                    return None;
                }
            }
            floor
        } else {
            height = height.min(105.0);
            let floor = seq.range(-480.0, -435.0);
            floor.min(DEPTHS_CEIL_MAX - height)
        };
        let index = p.chambers.len();
        let id = stable_id(idl::CHAMBER, layer as i32, 0, index as u32);
        let lake = match kind {
            ck::CENOTE => true,
            ck::RIVER => true,
            ck::INFERNO => true,
            ck::CRYSTAL | ck::FUNGAL => seq.unit() < 0.45,
            _ => seq.unit() < 0.3,
        };
        let lake_e = if lake { seq.range(0.42, 0.62) } else { 0.0 };
        let tint = match kind {
            ck::CRYSTAL => [1u8, 7, 8, 1][seq.below(4)],
            ck::CENOTE => 8,
            ck::RIVER => [8u8, 1][seq.below(2)],
            ck::FUNGAL => [3u8, 8, 7][seq.below(3)],
            _ => 0,
        };
        p.chambers.push(Chamber {
            layer,
            kind,
            x,
            z,
            rx,
            rz,
            c,
            s,
            floor,
            height,
            lake: if lake { floor + seq.range(1.0, 2.5) } else { NO_WATER },
            lake_e,
            lake_depth: if lake { seq.range(7.0, 12.0) } else { 0.0 },
            seed: (hash(seed, stream::CHAMBER, id as i64, 0, 0) >> 32) as u32,
            tint,
            site: NONE16,
            reach,
            id,
        });
        Some(index)
    };
    let kinds_cycle = [ck::CENOTE, ck::CRYSTAL, ck::RIVER, ck::FUNGAL, ck::CRYSTAL, ck::CENOTE, ck::RIVER, ck::CRYSTAL];
    let mut kind_i = 0usize;
    let mut entrance_chamber: Vec<Option<usize>> = Vec::new();
    for e in &entrances {
        let mut got = None;
        for t in 0..40 {
            let along = seq.range(320.0, 620.0);
            let side = seq.range(-0.9, 0.9);
            let (dx, dz) = (e.2 + -e.3 * side, e.3 + e.2 * side);
            let l = libm::sqrt(dx * dx + dz * dz);
            let (x, z) = (e.0 + dx / l * along, e.1 + dz / l * along);
            let rx = seq.range(85.0, 200.0) * if t > 20 { 0.75 } else { 1.0 };
            // An existing chamber close enough serves this entrance too.
            if let Some(k) = p.chambers.iter().position(|c| c.layer == LAYER_UNDER && d2(c.x, c.z, x, z) < (c.reach + 120.0) * (c.reach + 120.0)) {
                got = Some(k);
                break;
            }
            if let Some(k) = place_chamber(p, &mut seq, x, z, rx, kinds_cycle[kind_i % kinds_cycle.len()], LAYER_UNDER) {
                kind_i += 1;
                got = Some(k);
                break;
            }
        }
        entrance_chamber.push(got);
    }
    let n_vast = (5 + libm::round(3.0 * cave_density) as usize).max(entrances.len() / 2 + 2).min(10);
    let mut tries = 0;
    while p.chambers.iter().filter(|c| c.layer == LAYER_UNDER).count() < n_vast && tries < 300 {
        tries += 1;
        let (x, z) = (seq.range(300.0, WORLD - 300.0), seq.range(300.0, WORLD - 300.0));
        // Near the network (a passage reaches it).
        let near = p.chambers.iter().filter(|c| c.layer == LAYER_UNDER).any(|c| d2(c.x, c.z, x, z) < 900.0 * 900.0);
        if !near && !p.chambers.is_empty() {
            continue;
        }
        let rx = seq.range(70.0, 205.0);
        if place_chamber(p, &mut seq, x, z, rx, kinds_cycle[kind_i % kinds_cycle.len()], LAYER_UNDER).is_some() {
            kind_i += 1;
        }
    }

    // ---- 3. entrance tunnels: from the mouth's downhill rim into the hill,
    // down to a balcony high on the chamber wall, then a ledge ramp to the floor.
    let mut tunnel_sites: Vec<(f64, f64, f64, u16, u16)> = Vec::new(); // x, y, z, yaw, opening
    for (ei, e) in entrances.iter().enumerate() {
        let Some(ci) = entrance_chamber[ei] else { continue };
        let ch = p.chambers[ci].clone();
        let (mx, mz) = (e.0, e.1);
        let (ux, uz) = (e.2, e.3); // uphill, into the hill
        let gb = Ground::new(a, mx - 40.0, mz - 40.0, mx + 40.0, mz + 40.0);
        let (b0x, b0z) = (mx - ux * MOUTH_R, mz - uz * MOUTH_R);
        let y0 = gb.sample(b0x, b0z).0;
        // The balcony: on the wall facing the mouth, a little more than half way up.
        let th = ellipse_angle(&ch, mx, mz);
        let bal_y = ch.floor + (0.5 * ch.height).clamp(38.0, 80.0);
        let e_bal = wall_e(bal_y - ch.floor, ch.height) + 0.035;
        let (bx, bz) = ellipse_pt(&ch, e_bal, th);
        let (ox, oz) = ellipse_pt(&ch, e_bal + 0.16, th); // in the rock behind it
        let drop = (y0 - bal_y).max(0.0);
        let len = drop / deg(24.0) + 60.0;
        let mut tseq = Seq::new(seed ^ ch.id, stream::CORRIDOR ^ ei as u64);
        let plan_pts = route(&mut tseq, (b0x, b0z), (ox, oz), len, Some((ux, uz)));
        let s = path_len(&plan_pts);
        let total = *s.last().unwrap();
        let mut pts: Vec<[f64; 3]> = Vec::new();
        for (k, q) in plan_pts.iter().enumerate() {
            // Gentle first 20 m (the ravine into the hill), then even.
            let first = 20.0 * deg(14.0);
            let y = if s[k] < 20.0 { y0 - s[k] * deg(14.0) } else { y0 - first - (drop - first).max(0.0) * ((s[k] - 20.0) / (total - 20.0).max(1.0)) };
            let y = y.max(bal_y);
            pts.push([q.0, y, q.1]);
        }
        let (mut x0, mut z0, mut x1, mut z1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for q in &pts {
            x0 = x0.min(q[0]);
            z0 = z0.min(q[2]);
            x1 = x1.max(q[0]);
            z1 = z1.max(q[2]);
        }
        let g = Ground::new(a, x0 - 10.0, z0 - 10.0, x1 + 10.0, z1 + 10.0);
        let skip = pts.iter().position(|q| d2(q[0], q[2], mx, mz) > (MOUTH_R + 10.0) * (MOUTH_R + 10.0)).unwrap_or(pts.len());
        keep_under(&g, &mut pts, 8.5, 6.0, skip, deg(33.0));
        // Balcony: flat from the rock into the chamber.
        pts.push([bx, pts.last().unwrap()[1], bz]);
        let bal = pts.last().unwrap()[1];
        // Ledge ramp down the wall.
        let dir = if tseq.unit() < 0.5 { 1.0 } else { -1.0 };
        let mut y = bal;
        let mut t = th;
        let mut guard = 0;
        while y > ch.floor + 1.0 && guard < 200 {
            guard += 1;
            y = (y - 12.0 * deg(16.0)).max(ch.floor + 0.6);
            let ee = (wall_e(y - ch.floor, ch.height) + 0.035).max(WALL_E0 - 0.02);
            let r_avg = 0.5 * (ch.rx + ch.rz) * ee;
            t += dir * 12.0 / r_avg.max(20.0);
            let (rx_, rz_) = ellipse_pt(&ch, ee, t);
            pts.push([rx_, y, rz_]);
        }
        let open_i = p.openings.len() as u16;
        p.openings.push(Opening {
            x: mx,
            z: mz,
            r: MOUTH_R,
            y: y0,
            into: LAYER_UNDER,
            kind: ok::TUNNEL,
            yaw: (libm::atan2(-uz, -ux).rem_euclid(TAU) / TAU * 65536.0) as u16,
            site: NONE16,
            target: p.corridors.len() as u16,
        });
        p.corridors.push(Corridor { layer: LAYER_UNDER, kind: rk::TUNNEL, pts, hw: 4.6, height: 8.5, water: 0.0, lava: false, from: NONE16, to: ci as u16 });
        tunnel_sites.push((mx, y0, mz, p.openings[open_i as usize].yaw, open_i));
    }

    // ---- 4. passages and rivers between vast chambers (MST + a loop).
    let ids: Vec<usize> = (0..p.chambers.len()).filter(|&i| p.chambers[i].layer == LAYER_UNDER).collect();
    connect(a, p, &ids, &boxes, &mut seq, LAYER_UNDER);

    // ---- 5. cenote shafts: skylights from the surface into a lake.
    for &ci in &ids {
        let ch = p.chambers[ci].clone();
        if ch.kind != ck::CENOTE {
            continue;
        }
        let want = 1 + (ch.rx > 140.0) as usize;
        let mut got = 0;
        for k in 0..24 {
            if got >= want {
                break;
            }
            let e = seq.range(0.0, (ch.lake_e * 0.7).max(0.2));
            let th = seq.range(0.0, TAU);
            let (x, z) = ellipse_pt(&ch, e, th);
            let r = seq.range(8.0, 14.0);
            if !dry(a, x, z) || !dry(a, x + r, z) || !dry(a, x - r, z) || !dry(a, x, z + r) || !dry(a, x, z - r) {
                continue;
            }
            if base.iter().any(|s| d2(s.x, s.z, x, z) < (s.radius + 40.0) * (s.radius + 40.0)) {
                continue;
            }
            if p.shafts.iter().any(|o| d2(o.x, o.z, x, z) < (o.r + r + 30.0).powi(2)) || p.openings.iter().any(|o| d2(o.x, o.z, x, z) < (o.r + r + 60.0).powi(2)) {
                continue;
            }
            let _ = k;
            let top = macro_at(a, x, z);
            p.openings.push(Opening { x, z, r, y: top, into: LAYER_UNDER, kind: ok::CENOTE, yaw: 0, site: NONE16, target: ci as u16 });
            p.shafts.push(Shaft { x, z, r, bottom: ch.floor + ch.height * 0.8, top, chamber: ci as u16 });
            got += 1;
        }
    }

    // ---- 6. Depths: halls of lava and ash far below, a gate in the floor
    // of the deepest vast chambers with a steep descent down to them.
    let mut deep: Vec<usize> = ids.clone();
    deep.sort_by(|&i, &j| p.chambers[i].floor.partial_cmp(&p.chambers[j].floor).unwrap().then(i.cmp(&j)));
    let n_gates = (1 + libm::round(cave_density) as usize).min(deep.len());
    let mut gates: Vec<usize> = Vec::new();
    for &ci in &deep {
        if gates.len() >= n_gates {
            break;
        }
        if gates.iter().any(|&g| d2(p.chambers[g].x, p.chambers[g].z, p.chambers[ci].x, p.chambers[ci].z) < 900.0 * 900.0) {
            continue;
        }
        gates.push(ci);
    }
    let mut dseq = Seq::new(seed, stream::DEPTHS);
    let mut d_ids = Vec::new();
    for &gi in &gates {
        let ch = p.chambers[gi].clone();
        // A Depths hall 500-800 m away from the gate.
        let mut hall = None;
        for _ in 0..60 {
            let ang = dseq.range(0.0, TAU);
            let dist = dseq.range(480.0, 800.0);
            let (x, z) = (ch.x + dist * libm::cos(ang), ch.z + dist * libm::sin(ang));
            let kind = if d_ids.len() % 2 == 0 { ck::INFERNO } else { ck::ASHEN };
            let rx = dseq.range(90.0, 190.0);
            if let Some(k) = place_chamber(p, &mut dseq, x, z, rx, kind, LAYER_DEPTHS) {
                hall = Some(k);
                break;
            }
        }
        let Some(hi) = hall else { continue };
        d_ids.push(hi);
        let dh = p.chambers[hi].clone();
        // The gate: on dry floor, on the side facing the hall, off the lake.
        let th = ellipse_angle(&ch, dh.x, dh.z);
        let ge = if ch.lake_e > 0.0 { (ch.lake_e + 0.12).min(0.7) } else { 0.5 };
        let (gx, gz) = ellipse_pt(&ch, ge, th);
        let gy = ch.floor;
        let th2 = ellipse_angle(&dh, gx, gz);
        let bal_y = dh.floor + (0.5 * dh.height).clamp(35.0, 70.0);
        let e_bal = wall_e(bal_y - dh.floor, dh.height) + 0.035;
        let (bx, bz) = ellipse_pt(&dh, e_bal, th2);
        let (ox, oz) = ellipse_pt(&dh, e_bal + 0.16, th2);
        let drop = gy - bal_y;
        let len = drop / deg(27.0) + 40.0;
        let (dx, dz) = (dh.x - gx, dh.z - gz);
        let dl = libm::sqrt(dx * dx + dz * dz);
        let mut cseq = Seq::new(seed ^ dh.id, stream::CORRIDOR ^ 0xD0);
        let route_pts = route(&mut cseq, (gx - dx / dl * GATE_R, gz - dz / dl * GATE_R), (ox, oz), len, Some((dx / dl, dz / dl)));
        let s = path_len(&route_pts);
        let total = *s.last().unwrap();
        let mut pts: Vec<[f64; 3]> = Vec::new();
        for (k, q) in route_pts.iter().enumerate() {
            // Steep first 45 m (out from under the cavern floor), then even.
            let first = 45.0 * deg(36.0);
            let y = if s[k] < 45.0 { gy - s[k] * deg(36.0) } else { gy - first - (drop - first).max(0.0) * ((s[k] - 45.0) / (total - 45.0).max(1.0)) };
            pts.push([q.0, y.max(bal_y), q.1]);
        }
        pts.push([bx, bal_y, bz]);
        let mut y = bal_y;
        let mut t = th2;
        let dir = if cseq.unit() < 0.5 { 1.0 } else { -1.0 };
        let mut guard = 0;
        while y > dh.floor + 1.0 && guard < 200 {
            guard += 1;
            y = (y - 12.0 * deg(16.0)).max(dh.floor + 0.6);
            let ee = (wall_e(y - dh.floor, dh.height) + 0.035).max(WALL_E0 - 0.02);
            t += dir * 12.0 / (0.5 * (dh.rx + dh.rz) * ee).max(20.0);
            let (rx_, rz_) = ellipse_pt(&dh, ee, t);
            pts.push([rx_, y, rz_]);
        }
        p.openings.push(Opening {
            x: gx,
            z: gz,
            r: GATE_R,
            y: gy,
            into: LAYER_DEPTHS,
            kind: ok::GATE,
            yaw: (libm::atan2(dz, dx).rem_euclid(TAU) / TAU * 65536.0) as u16,
            site: NONE16,
            target: gi as u16,
        });
        p.corridors.push(Corridor { layer: LAYER_DEPTHS, kind: rk::DESCENT, pts, hw: 5.0, height: 9.5, water: 0.0, lava: false, from: gi as u16, to: hi as u16 });
        // One more hall off this one (lava river between them).
        for _ in 0..40 {
            let ang = dseq.range(0.0, TAU);
            let dist = dh.reach + dseq.range(160.0, 360.0);
            let (x, z) = (dh.x + dist * libm::cos(ang), dh.z + dist * libm::sin(ang));
            let kind = if d_ids.len() % 2 == 0 { ck::INFERNO } else { ck::ASHEN };
            let rx = dseq.range(80.0, 170.0);
            if let Some(k) = place_chamber(p, &mut dseq, x, z, rx, kind, LAYER_DEPTHS) {
                d_ids.push(k);
                break;
            }
        }
    }
    connect(a, p, &d_ids, &[], &mut dseq, LAYER_DEPTHS);

    // ---- 7. sites: tunnel entrances (surface), named caverns, camps
    // (waypoints underground), Depths gates and halls.
    for (k, &(x, y, z, yaw, oi)) in tunnel_sites.iter().enumerate() {
        let mut nseq = Seq::new(seed ^ (k as u64 + 1), stream::NAMES ^ 0x7E);
        let local = p.sites.len();
        p.sites.push(NewSite {
            category: S::CAT_POI,
            kind: S::POI_TUNNEL,
            size: 0,
            layer: LAYER_SURFACE,
            x,
            y,
            z,
            radius: MOUTH_R + 8.0,
            yaw,
            link_local: NONE16,
            name: names::site_name(g_names, nseq.pick(&["Gate", "Descent", "Underway", "Delve", "Hollowgate"]), &mut nseq),
            biome: biome_at(a, x, z),
            element: 3,
            region: region_of(x, z) as u8,
        });
        p.openings[oi as usize].site = (p.base_sites + local) as u16;
    }
    let mut camps = 0usize;
    for ci in 0..p.chambers.len() {
        let ch = p.chambers[ci].clone();
        let mut nseq = Seq::new(seed ^ ch.id, stream::NAMES);
        let local = p.sites.len();
        let (kind, layer, noun) = if ch.layer == LAYER_UNDER {
            (S::POI_CAVERN, LAYER_UNDER, *nseq.pick(match ch.kind {
                ck::CENOTE => &["Cenote", "Mere", "Blue Hollow", "Well"][..],
                ck::RIVER => &["Rushing Deep", "Riverhall", "Undercourse"][..],
                ck::FUNGAL => &["Glimmerwood", "Lanternmoss", "Glowhall"][..],
                _ => &["Crystal Hall", "Geode", "Shimmerdeep", "Vault of Lights"][..],
            }))
        } else {
            (S::POI_DEPTHS, LAYER_DEPTHS, *nseq.pick(&["Furnace", "Cinderhall", "Ashen Reach", "Maw", "Emberpit"]))
        };
        p.sites.push(NewSite {
            category: S::CAT_POI,
            kind,
            size: ch.kind,
            layer,
            x: ch.x,
            y: ch.floor,
            z: ch.z,
            radius: ch.rx.max(ch.rz),
            yaw: 0,
            link_local: NONE16,
            name: names::site_name(g_names, noun, &mut nseq),
            biome: biome_at(a, ch.x, ch.z),
            element: if layer == LAYER_DEPTHS { 0 } else { [3u8, 1, 7, 5][ch.kind as usize % 4] },
            region: region_of(ch.x, ch.z) as u8,
        });
        p.chambers[ci].site = (p.base_sites + local) as u16;
        // A safe camp (waypoint, campfire, tents) in every other vast chamber
        // and in the first Depths hall, on dry floor off the lake.
        let camp = (ch.layer == LAYER_UNDER && camps < 1 + ids.len() / 2 && ci % 2 == 0) || (ch.layer == LAYER_DEPTHS && d_ids.first() == Some(&ci));
        if camp {
            let th = nseq.range(0.0, TAU);
            let e = (ch.lake_e + 0.12).clamp(0.3, 0.62);
            let (x, z) = ellipse_pt(&ch, e, th);
            p.sites.push(NewSite {
                category: S::CAT_POI,
                kind: S::POI_WAYPOINT,
                size: 0,
                layer: ch.layer,
                x,
                y: ch.floor,
                z,
                radius: 3.0,
                yaw: 0,
                link_local: NONE16,
                name: format!("{} Camp", names::proper(g_names, &mut nseq)),
                biome: biome_at(a, x, z),
                element: 255,
                region: region_of(x, z) as u8,
            });
            camps += 1;
        }
    }
    for oi in 0..p.openings.len() {
        let o = p.openings[oi];
        if o.kind != ok::GATE {
            continue;
        }
        let mut nseq = Seq::new(seed ^ (oi as u64 + 77), stream::NAMES ^ 0x6A);
        let local = p.sites.len();
        p.sites.push(NewSite {
            category: S::CAT_POI,
            kind: S::POI_DEPTHS_GATE,
            size: 0,
            layer: LAYER_UNDER,
            x: o.x,
            y: o.y,
            z: o.z,
            radius: o.r + 6.0,
            yaw: o.yaw,
            link_local: NONE16,
            name: names::site_name(g_names, nseq.pick(&["Hellgate", "Downfall", "Burning Stair", "Abyss"]), &mut nseq),
            biome: biome_at(a, o.x, o.z),
            element: 0,
            region: region_of(o.x, o.z) as u8,
        });
        p.openings[oi].site = (p.base_sites + local) as u16;
    }

    // ---- 8. genVersion 4 (CR 043): the dwarves' camps, strongholds and lower
    // halls, appended after everything above (every index stays).
    super::dwarf::plan(a, cw, p);
}

/// Join chambers of one layer: a minimum spanning tree over centre distance
/// plus one extra edge for a loop; every passage runs rim to rim. In the
/// Underground about half are rivers (from the higher chamber down), in the
/// Depths every one is a lava river.
pub(super) fn connect(a: &Atlas, p: &mut Plan, ids: &[usize], boxes: &[CaveBox], seq: &mut Seq, layer: u8) {
    let n = ids.len();
    if n < 2 {
        return;
    }
    let dist = |p: &Plan, i: usize, j: usize| libm::sqrt(d2(p.chambers[ids[i]].x, p.chambers[ids[i]].z, p.chambers[ids[j]].x, p.chambers[ids[j]].z));
    let mut inn = vec![false; n];
    inn[0] = true;
    let mut edges: Vec<(usize, usize)> = Vec::new();
    for _ in 1..n {
        let mut best: Option<(f64, usize, usize)> = None;
        for i in 0..n {
            if !inn[i] {
                continue;
            }
            for j in 0..n {
                if inn[j] {
                    continue;
                }
                let d = dist(p, i, j);
                if best.is_none_or(|b| d < b.0) {
                    best = Some((d, i, j));
                }
            }
        }
        let (_, i, j) = best.unwrap();
        inn[j] = true;
        edges.push((i, j));
    }
    // One loop: the shortest non-tree edge.
    let mut extra: Option<(f64, usize, usize)> = None;
    for i in 0..n {
        for j in i + 1..n {
            if edges.iter().any(|&(a1, b1)| (a1 == i && b1 == j) || (a1 == j && b1 == i)) {
                continue;
            }
            let d = dist(p, i, j);
            if d < 1300.0 && extra.is_none_or(|e| d < e.0) {
                extra = Some((d, i, j));
            }
        }
    }
    if let Some((_, i, j)) = extra {
        edges.push((i, j));
    }
    for (ei, (i, j)) in edges.into_iter().enumerate() {
        let (ca, cb) = (p.chambers[ids[i]].clone(), p.chambers[ids[j]].clone());
        // Higher floor first (rivers run downhill).
        let (ca, cb, ia, ib) = if ca.floor >= cb.floor { (ca, cb, ids[i], ids[j]) } else { (cb, ca, ids[j], ids[i]) };
        let tha = ellipse_angle(&ca, cb.x, cb.z);
        let thb = ellipse_angle(&cb, ca.x, ca.z);
        let (ax, az) = ellipse_pt(&ca, 0.86, tha);
        let (bx, bz) = ellipse_pt(&cb, 0.86, thb);
        let ya = ca.floor + 1.0;
        let yb = cb.floor + 1.0;
        let river = layer == LAYER_DEPTHS || (ca.lake != NO_WATER && seq.unit() < 0.75) || seq.unit() < 0.35;
        let len = ((ya - yb).abs() / deg(22.0)).max(libm::sqrt(d2(ax, az, bx, bz)));
        let route_pts = route(seq, (ax, az), (bx, bz), len, None);
        let s = path_len(&route_pts);
        let total = *s.last().unwrap();
        let mut pts: Vec<[f64; 3]> = route_pts.iter().enumerate().map(|(k, q)| [q.0, ya + (yb - ya) * (s[k] / total.max(1.0)), q.1]).collect();
        // Keep under the surface (Underground) and under any cave system.
        if layer == LAYER_UNDER {
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
            keep_under(&g, &mut pts, if river { 11.0 } else { 9.0 }, ROCK, 0, deg(30.0));
        }
        let _ = ei;
        p.corridors.push(Corridor {
            layer,
            kind: if river { rk::RIVER } else { rk::PASSAGE },
            pts,
            hw: if river { 7.5 } else { 5.5 },
            height: if river { 13.0 } else { 10.0 },
            water: if river { 2.4 } else { 0.0 },
            lava: layer == LAYER_DEPTHS,
            from: ia as u16,
            to: ib as u16,
        });
    }
}
