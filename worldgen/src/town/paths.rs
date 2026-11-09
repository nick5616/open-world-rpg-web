//! Footpaths (genVersion 2, playtest 1: "houses built on foundations and
//! paths to get everywhere"): every door (the foot of its steps), ward
//! garden gate and stand of a settlement gets a footpath to the town's
//! streets or square, unless it already opens onto them.
//!
//! One multi-source Dijkstra per settlement on a 1 m grid over its footprint:
//! sources are the street and square cells, obstacles are the settlement's
//! solid boxes (buildings, porches, fences, walls, wells) grown by a body
//! radius and water; steps cost more on slopes, beside walls and across
//! fields. Each target is traced back along the parent pointers until it
//! reaches a street, the square or a path traced before it (so paths branch
//! into each other instead of running side by side), then smoothed and
//! resampled. Paths are draped on the terrain like streets and roads: no
//! chunk changes, no collision, the same bytes on every host.
//!
//! Records: ROADS class 2 (`CLASS_PATH`), surface dirt, `from` = the building
//! it serves (NONE for other targets), `to` = the path it joins (NONE when
//! it ends on a street or the square), `settlement` = its settlement. The
//! first point is the target (door step foot), the last is on the network.

use super::geom::{dist, sub, Obb};
use super::{bf, bflag, bk, role, Road, Towns};
use crate::atlas::format::Atlas;
use crate::ground::Ground;
use std::cmp::Reverse;
use std::collections::BinaryHeap;

/// Road class of a footpath (0 road, 1 town street, 2 footpath).
pub const CLASS_PATH: u8 = 2;
/// Footpath widths (m): doors, and the inn / forge / garden gate.
pub const PATH_W: f64 = 1.4;
pub const PATH_W_WIDE: f64 = 1.8;
const NONE: u16 = 0xFFFF;
/// Obstacles grow by this much (a body radius plus a little).
const BODY: f64 = 0.45;
/// Terrain sample spacing for the slope cost and water (m).
const HSTEP: f64 = 4.0;
/// A target looks this far for a free cell to start from.
const START_R: i64 = 3;

/// What a settlement's paths need from its layout.
pub struct Town<'a> {
    pub settlement: u16,
    pub x: f64,
    pub z: f64,
    /// Grid radius around the centre (the layout radius plus a margin).
    pub r: f64,
    pub square: f64,
    /// Water a path may wade through (m): ankle deep, or the shallows
    /// stilt houses stand in.
    pub wade: f64,
    pub building_first: usize,
    pub box_first: usize,
    pub prop_first: usize,
    /// Street segments (ax, az, bx, bz, half width).
    pub streets: &'a [(f64, f64, f64, f64, f64)],
}

const FREE: u8 = 0;
const BLOCKED: u8 = 1;
const FIELD: u8 = 2;

struct Grid {
    n: usize,
    x0: f64,
    z0: f64,
    cell: Vec<u8>,
    src: Vec<bool>,
    near: Vec<bool>,
    h: Vec<f64>,
}

impl Grid {
    fn xz(&self, k: usize) -> (f64, f64) {
        (self.x0 + (k % self.n) as f64, self.z0 + (k / self.n) as f64)
    }
    fn at(&self, x: f64, z: f64) -> Option<usize> {
        let i = libm::round(x - self.x0) as i64;
        let j = libm::round(z - self.z0) as i64;
        if i < 0 || j < 0 || i >= self.n as i64 || j >= self.n as i64 {
            None
        } else {
            Some(j as usize * self.n + i as usize)
        }
    }
    /// Mark the cells inside a rectangle grown by `pad` with `v` (only
    /// raising FREE -> FIELD -> BLOCKED).
    fn raster(&mut self, o: &Obb, pad: f64, v: u8) {
        let rr = o.radius() + pad + 1.0;
        let i0 = (libm::floor(o.cx - rr - self.x0) as i64).max(0);
        let j0 = (libm::floor(o.cz - rr - self.z0) as i64).max(0);
        let i1 = (libm::ceil(o.cx + rr - self.x0) as i64).min(self.n as i64 - 1);
        let j1 = (libm::ceil(o.cz + rr - self.z0) as i64).min(self.n as i64 - 1);
        for j in j0..=j1 {
            for i in i0..=i1 {
                let k = j as usize * self.n + i as usize;
                let (x, z) = self.xz(k);
                if self.cell[k] < v && o.contains(x, z, pad) {
                    self.cell[k] = v;
                }
            }
        }
    }
}

fn seg_d(px: f64, pz: f64, ax: f64, az: f64, bx: f64, bz: f64) -> f64 {
    let (dx, dz) = (bx - ax, bz - az);
    let l2 = dx * dx + dz * dz;
    let t = if l2 > 0.0 {
        (((px - ax) * dx + (pz - az) * dz) / l2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    dist(px, pz, ax + dx * t, az + dz * t)
}

/// The targets of a settlement: (point, building or NONE, width).
fn targets(t: &Towns, tw: &Town) -> Vec<([f64; 2], u16, f64)> {
    let mut out = Vec::new();
    for bi in tw.building_first..t.buildings.len() {
        let b = &t.buildings[bi];
        let o = Obb {
            cx: b.x,
            cz: b.z,
            c: b.c,
            s: b.s,
            hx: b.hx,
            hz: b.hz,
        };
        let wide = matches!(b.role, role::INN | role::FORGE | role::GARDEN);
        let w = if wide { PATH_W_WIDE } else { PATH_W };
        let p = match b.role {
            role::GARDEN => o.at(0.0, -b.hz - 0.7),
            role::STALL => o.at(0.0, -b.hz - 1.2),
            _ if b.floors == 0 => continue,
            _ => {
                // The foot of the door steps (the ramp box's low end), else
                // the ground just outside the door / porch.
                let first = b.box_first as usize;
                let ramp = t.boxes[first..first + b.box_count as usize].iter().find(|x| x.kind == bk::RAMP);
                match ramp {
                    Some(rb) => {
                        let (c, s) = (rb.c as f64, rb.s as f64);
                        let hx = rb.hx as f64 + 0.3;
                        (rb.cx as f64 - c * hx, rb.cz as f64 - s * hx)
                    }
                    None => {
                        let porch = if b.flags & bflag::PORCH != 0 { 2.0 } else { 0.0 };
                        o.at(b.door_u, -b.hz - porch - 0.7)
                    }
                }
            }
        };
        out.push(([p.0, p.1], bi as u16, w));
    }
    out
}

pub fn build(a: &Atlas, t: &mut Towns, tw: &Town) {
    let n = (libm::ceil(tw.r * 2.0) as usize) + 3;
    let x0 = libm::floor(tw.x - tw.r) - 1.0;
    let z0 = libm::floor(tw.z - tw.r) - 1.0;
    // Terrain every HSTEP m (heights for the slope cost, water to avoid).
    let g = Ground::new(a, x0 - HSTEP, z0 - HSTEP, x0 + n as f64 + HSTEP, z0 + n as f64 + HSTEP);
    let hn = n / HSTEP as usize + 2;
    let mut hh = vec![0.0f64; hn * hn];
    let mut depth = vec![0.0f64; hn * hn];
    for jj in 0..hn {
        for ii in 0..hn {
            let (h, w) = g.sample(x0 + HSTEP * ii as f64, z0 + HSTEP * jj as f64);
            let (h, w) = (h as f32 as f64, w as f32 as f64);
            hh[jj * hn + ii] = h;
            depth[jj * hn + ii] = if w > h + 0.05 { w - h } else { 0.0 };
        }
    }
    let mut gr = Grid {
        n,
        x0,
        z0,
        cell: vec![FREE; n * n],
        src: vec![false; n * n],
        near: vec![false; n * n],
        h: vec![0.0; n * n],
    };
    for k in 0..n * n {
        let (i, j) = (k % n, k / n);
        let hs = HSTEP as usize;
        let node = ((j + hs / 2) / hs).min(hn - 1) * hn + ((i + hs / 2) / hs).min(hn - 1);
        gr.h[k] = hh[node];
        let (x, z) = gr.xz(k);
        if depth[node] > tw.wade || dist(x, z, tw.x, tw.z) > tw.r {
            gr.cell[k] = BLOCKED;
        } else if depth[node] > 0.0 {
            gr.cell[k] = FIELD; // shallow water: allowed, avoided
        }
    }
    // Obstacles: every solid box of the settlement (buildings, porches,
    // fences, stalls, the well and board, walls, gate towers).
    for bx in &t.boxes[tw.box_first..] {
        if bx.flags & bf::SOLID == 0 {
            continue;
        }
        let o = Obb {
            cx: bx.cx as f64,
            cz: bx.cz as f64,
            c: bx.c as f64,
            s: bx.s as f64,
            hx: bx.hx as f64,
            hz: bx.hz as f64,
        };
        gr.raster(&o, BODY, BLOCKED);
    }
    // Fields behind farms: allowed, but paths keep to their edges.
    for b in &t.buildings[tw.building_first..] {
        if b.flags & bflag::FIELD != 0 {
            let o = Obb {
                cx: b.x,
                cz: b.z,
                c: b.c,
                s: b.s,
                hx: b.hx,
                hz: b.hz,
            };
            gr.raster(&sub(&o, 0.0, b.hz + 0.8 + 4.5, b.hx, 4.5), 0.0, FIELD);
        }
    }
    for k in 0..n * n {
        if gr.cell[k] == BLOCKED {
            continue;
        }
        let (x, z) = gr.xz(k);
        let on_street = dist(x, z, tw.x, tw.z) <= tw.square || tw.streets.iter().any(|&(ax, az, bx, bz, hw)| seg_d(x, z, ax, az, bx, bz) <= hw);
        gr.src[k] = on_street;
        let (i, j) = ((k % n) as i64, (k / n) as i64);
        gr.near[k] = [(1i64, 0i64), (-1, 0), (0, 1), (0, -1)].iter().any(|&(di, dj)| {
            let (a2, b2) = (i + di, j + dj);
            a2 < 0 || b2 < 0 || a2 >= n as i64 || b2 >= n as i64 || gr.cell[b2 as usize * n + a2 as usize] == BLOCKED
        });
    }

    // Multi-source Dijkstra with integer costs (centimetre-ish units), ties
    // by cell index: the same parents on every host.
    let mut d = vec![u32::MAX; n * n];
    let mut parent = vec![u32::MAX; n * n];
    let mut heap: BinaryHeap<Reverse<(u32, u32)>> = BinaryHeap::new();
    for k in 0..n * n {
        if gr.src[k] {
            d[k] = 0;
            heap.push(Reverse((0, k as u32)));
        }
    }
    const NB: [(i64, i64, f64); 8] = [
        (1, 0, 1.0),
        (-1, 0, 1.0),
        (0, 1, 1.0),
        (0, -1, 1.0),
        (1, 1, core::f64::consts::SQRT_2),
        (-1, 1, core::f64::consts::SQRT_2),
        (1, -1, core::f64::consts::SQRT_2),
        (-1, -1, core::f64::consts::SQRT_2),
    ];
    while let Some(Reverse((dk, k))) = heap.pop() {
        let k = k as usize;
        if dk > d[k] {
            continue;
        }
        let (i, j) = ((k % n) as i64, (k / n) as i64);
        for &(di, dj, len) in &NB {
            let (a2, b2) = (i + di, j + dj);
            if a2 < 0 || b2 < 0 || a2 >= n as i64 || b2 >= n as i64 {
                continue;
            }
            let m = b2 as usize * n + a2 as usize;
            if gr.cell[m] == BLOCKED {
                continue;
            }
            if di != 0 && dj != 0 && (gr.cell[j as usize * n + a2 as usize] == BLOCKED || gr.cell[b2 as usize * n + i as usize] == BLOCKED) {
                continue;
            }
            let grade = (gr.h[m] - gr.h[k]) / len;
            let mut c = len * (1.0 + 4.0 * grade * grade);
            if gr.near[m] {
                c += 0.6;
            }
            if gr.cell[m] == FIELD {
                c *= 3.0;
            }
            let nd = dk.saturating_add(libm::round(c * 100.0) as u32);
            if nd < d[m] {
                d[m] = nd;
                parent[m] = k as u32;
                heap.push(Reverse((nd, m as u32)));
            }
        }
    }

    // The settlement's solid boxes as rectangles (line-of-sight checks from
    // a target to its first cell).
    let solids: Vec<Obb> = t.boxes[tw.box_first..]
        .iter()
        .filter(|b| b.flags & bf::SOLID != 0)
        .map(|b| Obb {
            cx: b.cx as f64,
            cz: b.cz as f64,
            c: b.c as f64,
            s: b.s as f64,
            hx: b.hx as f64,
            hz: b.hz as f64,
        })
        .collect();

    // Trace every target back to the network or to an earlier path.
    let mut owner = vec![NONE; n * n];
    for (p, bi, w) in targets(t, tw) {
        let Some(k0) = gr.at(p[0], p[1]) else { continue };
        let near: Vec<&Obb> = solids
            .iter()
            .filter(|o| dist(o.cx, o.cz, p[0], p[1]) < o.radius() + START_R as f64 + 2.0)
            .collect();
        let clear = |x: f64, z: f64| -> bool {
            let l = dist(x, z, p[0], p[1]);
            let steps = (libm::ceil(l / 0.25) as usize).max(1);
            (0..=steps).all(|q| {
                let f = q as f64 / steps as f64;
                let (sx, sz) = (p[0] + (x - p[0]) * f, p[1] + (z - p[1]) * f);
                !near.iter().any(|o| o.contains(sx, sz, 0.1))
            })
        };
        // Start from the nearest reachable free cell around the target.
        let (ci, cj) = ((k0 % n) as i64, (k0 / n) as i64);
        let mut start: Option<(f64, usize)> = None;
        for dj in -START_R..=START_R {
            for di in -START_R..=START_R {
                let (a2, b2) = (ci + di, cj + dj);
                if a2 < 0 || b2 < 0 || a2 >= n as i64 || b2 >= n as i64 {
                    continue;
                }
                let m = b2 as usize * n + a2 as usize;
                if d[m] == u32::MAX {
                    continue;
                }
                let (x, z) = gr.xz(m);
                let dd = dist(x, z, p[0], p[1]);
                if start.is_none_or(|s| dd < s.0) && clear(x, z) {
                    start = Some((dd, m));
                }
            }
        }
        let Some((_, mut k)) = start else { continue };
        let mut cells = vec![k];
        while !gr.src[k] && owner[k] == NONE && parent[k] != u32::MAX {
            k = parent[k] as usize;
            cells.push(k);
        }
        if cells.len() < 3 {
            continue; // opens onto the street or the square already
        }
        let joins = owner[k];
        let ri = t.roads.len() as u16;
        for &c in &cells[..cells.len() - 1] {
            owner[c] = ri;
        }
        let mut pts: Vec<[f64; 2]> = vec![p];
        pts.extend(cells.iter().map(|&c| {
            let (x, z) = gr.xz(c);
            [x, z]
        }));
        let pts = smooth(&pts);
        let mut out = Vec::with_capacity(pts.len());
        let mut length = 0.0;
        for (q, pt) in pts.iter().enumerate() {
            if q > 0 {
                length += dist(pts[q - 1][0], pts[q - 1][1], pt[0], pt[1]);
            }
            out.push([pt[0], g.sample(pt[0], pt[1]).0, pt[1]]);
        }
        t.roads.push(Road {
            points: out,
            from: bi,
            to: joins,
            width: w,
            class: CLASS_PATH,
            surface: 0,
            settlement: tw.settlement,
            length,
        });
    }
    let _ = tw.prop_first;
}

/// Drop collinear grid steps, round the corners (Chaikin x2, ends kept) and
/// resample every ~1.5 m.
fn smooth(p: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let mut v: Vec<[f64; 2]> = Vec::with_capacity(p.len());
    for (i, &q) in p.iter().enumerate() {
        if i > 0 && i + 1 < p.len() {
            let a = p[i - 1];
            let b = p[i + 1];
            let cross = (q[0] - a[0]) * (b[1] - q[1]) - (q[1] - a[1]) * (b[0] - q[0]);
            if cross == 0.0 && i > 1 {
                continue;
            }
        }
        v.push(q);
    }
    for _ in 0..2 {
        if v.len() < 3 {
            break;
        }
        let mut nv = vec![v[0]];
        for w in v.windows(2) {
            let (a, b) = (w[0], w[1]);
            nv.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
            nv.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
        }
        nv.push(*v.last().unwrap());
        v = nv;
    }
    // Resample.
    let mut out = vec![v[0]];
    let mut acc = 0.0;
    for w in v.windows(2) {
        let l = dist(w[0][0], w[0][1], w[1][0], w[1][1]);
        acc += l;
        if acc >= 1.5 {
            out.push(w[1]);
            acc = 0.0;
        }
    }
    let last = *v.last().unwrap();
    if out.last().is_none_or(|q| q[0] != last[0] || q[1] != last[1]) {
        out.push(last);
    }
    out
}
