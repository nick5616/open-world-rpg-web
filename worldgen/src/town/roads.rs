//! Roads between settlements (spec 5): least-cost paths over the macro
//! heightmap (slope, water and biome costs), merged into one network so
//! later roads reuse earlier ones (that is where forks come from), smoothed,
//! clipped at each settlement's edge (the town's streets take over there),
//! with generated bridges where a road crosses a river and signposts at forks.
//!
//! Roads are drawn on the terrain, not cut into it: flattening them into the
//! heightfield would change every chunk they cross (a genVersion bump, see
//! docs/cr/007-towns.md). Least-cost routing keeps them on gentle ground,
//! and bridges are real collision (decks, ramps, railings).

use super::geom::{dist, push_flat, push_ramp, yaw16, Obb, Terrain};
use super::{bf, bk, layer, pf, pk, stream, Bridge, Prop, Road, Sign, Towns};
use crate::atlas::climate::{SNOWPEAK, WETLAND};
use crate::atlas::format::{flag, idx, site, Atlas, N, NN, RES};
use crate::rng::{hash, stable_id, unit};
use std::cmp::Reverse;
use std::collections::BinaryHeap;

pub const ROAD_WIDTH: f64 = 3.6;
const STEP: f64 = 4.0;
const NONE: u16 = 0xFFFF;

/// One stretch of the network between two terminals (settlements or forks),
/// already smoothed, resampled and clipped.
pub struct Chain {
    pub nodes: Vec<usize>,
    pub points: Vec<[f64; 2]>,
    /// Settlement index at each end (NONE = fork).
    pub ends: [u16; 2],
}

pub struct Net {
    /// Atlas site index of each settlement, ascending (= settlement index).
    pub sites: Vec<usize>,
    pub chains: Vec<Chain>,
    /// Per settlement: the angles (atan2(dz, dx)) at which roads reach its edge.
    pub entries: Vec<Vec<f64>>,
}

fn node_xz(k: usize) -> (f64, f64) {
    ((k % N) as f64 * RES, (k / N) as f64 * RES)
}

const DIRS: [(i32, i32); 8] = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)];

/// Settlement sites, road graph, chains and entry angles.
pub fn plan(a: &Atlas) -> Net {
    let mut sites = Vec::new();
    for i in 0..a.site_count() {
        if a.site(i).category == site::CAT_SETTLEMENT {
            sites.push(i);
        }
    }
    let ns = sites.len();
    let recs: Vec<_> = sites.iter().map(|&i| a.site(i)).collect();
    let home: Vec<usize> = recs
        .iter()
        .map(|s| {
            let i = libm::round(s.x / RES).clamp(0.0, (N - 1) as f64) as usize;
            let j = libm::round(s.z / RES).clamp(0.0, (N - 1) as f64) as usize;
            idx(i, j)
        })
        .collect();

    // Edges: a minimum spanning tree over straight-line distance (Prim,
    // ties by index) plus each settlement's nearest neighbours within 1.4 km,
    // so the network has loops rather than one long tree.
    let d = |p: usize, q: usize| dist(recs[p].x, recs[p].z, recs[q].x, recs[q].z);
    let mut edges: Vec<(f64, usize, usize)> = Vec::new();
    if ns > 1 {
        let mut inn = vec![false; ns];
        inn[0] = true;
        for _ in 1..ns {
            let mut best: Option<(f64, usize, usize)> = None;
            for p in 0..ns {
                if !inn[p] {
                    continue;
                }
                for q in 0..ns {
                    if inn[q] {
                        continue;
                    }
                    let v = d(p, q);
                    if best.is_none_or(|b| v < b.0) {
                        best = Some((v, p.min(q), p.max(q)));
                    }
                }
            }
            let b = best.unwrap();
            let add = if inn[b.1] { b.2 } else { b.1 };
            inn[add] = true;
            edges.push(b);
        }
        for p in 0..ns {
            let mut near: Vec<(f64, usize)> = (0..ns).filter(|&q| q != p).map(|q| (d(p, q), q)).collect();
            near.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap().then(x.1.cmp(&y.1)));
            for &(v, q) in near.iter().take(2) {
                let e = (v, p.min(q), p.max(q));
                if v < 1400.0 && !edges.iter().any(|x| x.1 == e.1 && x.2 == e.2) {
                    edges.push(e);
                }
            }
        }
    }
    edges.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap().then(x.1.cmp(&y.1)).then(x.2.cmp(&y.2)));

    // Least-cost paths, cheaper along roads already laid.
    let mut on_road = vec![false; NN];
    let mut adj: Vec<Vec<u32>> = vec![Vec::new(); NN];
    for &(_, p, q) in &edges {
        if let Some(path) = dijkstra(a, &recs, p, q, home[p], home[q], &on_road) {
            for w in path.windows(2) {
                let (u, v) = (w[0], w[1]);
                on_road[u] = true;
                on_road[v] = true;
                if !adj[u].contains(&(v as u32)) {
                    adj[u].push(v as u32);
                    adj[v].push(u as u32);
                }
            }
        }
    }
    for l in adj.iter_mut() {
        l.sort_unstable();
    }

    // Chains between terminals (settlement nodes and nodes of degree != 2).
    let mut settle_at = vec![NONE; NN];
    for (si, &k) in home.iter().enumerate() {
        settle_at[k] = si as u16;
    }
    let terminal = |k: usize| settle_at[k] != NONE || (!adj[k].is_empty() && adj[k].len() != 2);
    let mut seen_edge: Vec<(u32, u32)> = Vec::new();
    let mut chains = Vec::new();
    for k in 0..NN {
        if !terminal(k) {
            continue;
        }
        for &n0 in &adj[k] {
            let key = (k.min(n0 as usize) as u32, k.max(n0 as usize) as u32);
            if seen_edge.contains(&key) {
                continue;
            }
            let mut nodes = vec![k];
            let mut prev = k;
            let mut cur = n0 as usize;
            loop {
                seen_edge.push((prev.min(cur) as u32, prev.max(cur) as u32));
                nodes.push(cur);
                if terminal(cur) {
                    break;
                }
                let next = adj[cur].iter().map(|&x| x as usize).find(|&x| x != prev).unwrap();
                prev = cur;
                cur = next;
            }
            let ends = [settle_at[nodes[0]], settle_at[*nodes.last().unwrap()]];
            chains.push(Chain {
                nodes,
                points: Vec::new(),
                ends,
            });
        }
    }

    // Smooth, resample, clip at settlement edges; record entry angles.
    let mut entries = vec![Vec::new(); ns];
    for ch in chains.iter_mut() {
        let mut pts: Vec<[f64; 2]> = ch.nodes.iter().map(|&k| node_xz(k)).map(|(x, z)| [x, z]).collect();
        for _ in 0..3 {
            pts = chaikin(&pts);
        }
        let mut pts = resample(&pts, STEP);
        for end in 0..2 {
            let si = ch.ends[end];
            if si == NONE {
                continue;
            }
            let s = &recs[si as usize];
            if end == 1 {
                pts.reverse();
            }
            // Drop points inside the settlement; end exactly on its edge.
            let r = s.radius;
            let mut cut = 0;
            while cut + 1 < pts.len() && dist(pts[cut + 1][0], pts[cut + 1][1], s.x, s.z) < r {
                cut += 1;
            }
            if cut + 1 < pts.len() {
                let (p, q) = (pts[cut], pts[cut + 1]);
                let dp = dist(p[0], p[1], s.x, s.z);
                let dq = dist(q[0], q[1], s.x, s.z);
                let t = if dq > dp { ((r - dp) / (dq - dp)).clamp(0.0, 1.0) } else { 0.0 };
                let e = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
                pts.drain(0..=cut);
                pts.insert(0, e);
                // Snap to the exact edge so the street meets the road.
                let ang = libm::atan2(e[1] - s.z, e[0] - s.x);
                pts[0] = [s.x + r * libm::cos(ang), s.z + r * libm::sin(ang)];
                entries[si as usize].push(ang);
            }
            if end == 1 {
                pts.reverse();
            }
        }
        ch.points = pts;
    }
    for e in entries.iter_mut() {
        e.sort_by(|x, y| x.partial_cmp(y).unwrap());
        // Two roads into the same side of a town share one street.
        let mut keep: Vec<f64> = Vec::new();
        for &v in e.iter() {
            if keep.iter().all(|&k| ang_diff(k, v) > 0.5) {
                keep.push(v);
            }
        }
        *e = keep;
    }
    Net { sites, chains, entries }
}

pub fn ang_diff(a: f64, b: f64) -> f64 {
    let tau = 2.0 * core::f64::consts::PI;
    let mut d = (a - b).abs() % tau;
    if d > core::f64::consts::PI {
        d = tau - d;
    }
    d
}

fn chaikin(p: &[[f64; 2]]) -> Vec<[f64; 2]> {
    if p.len() < 3 {
        return p.to_vec();
    }
    let mut out = vec![p[0]];
    for w in p.windows(2) {
        let (a, b) = (w[0], w[1]);
        out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
        out.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    out.push(*p.last().unwrap());
    out
}

fn resample(p: &[[f64; 2]], step: f64) -> Vec<[f64; 2]> {
    let mut out = vec![p[0]];
    let mut carry = 0.0;
    for w in p.windows(2) {
        let (a, b) = (w[0], w[1]);
        let l = dist(a[0], a[1], b[0], b[1]);
        if l <= 0.0 {
            continue;
        }
        let mut t = step - carry;
        while t < l {
            out.push([a[0] + (b[0] - a[0]) * t / l, a[1] + (b[1] - a[1]) * t / l]);
            t += step;
        }
        carry = l - (t - step);
    }
    let last = *p.last().unwrap();
    if dist(out.last().unwrap()[0], out.last().unwrap()[1], last[0], last[1]) > 0.5 {
        out.push(last);
    } else {
        *out.last_mut().unwrap() = last;
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn dijkstra(a: &Atlas, recs: &[crate::atlas::format::SiteRec], p: usize, q: usize, from: usize, to: usize, on_road: &[bool]) -> Option<Vec<usize>> {
    let diag = RES * libm::sqrt(2.0);
    let (sp, sq) = (&recs[p], &recs[q]);
    let mut cost = vec![f64::INFINITY; NN];
    let mut prev = vec![u32::MAX; NN];
    let mut heap = BinaryHeap::new();
    cost[from] = 0.0;
    heap.push(Reverse((0u64, from as u32)));
    while let Some(Reverse((cb, k))) = heap.pop() {
        let k = k as usize;
        let c = f64::from_bits(cb);
        if c > cost[k] {
            continue;
        }
        if k == to {
            break;
        }
        let (i, j) = ((k % N) as i32, (k / N) as i32);
        for (di, dj) in DIRS {
            let (ni, nj) = (i + di, j + dj);
            if ni < 0 || nj < 0 || ni >= N as i32 || nj >= N as i32 {
                continue;
            }
            let n = idx(ni as usize, nj as usize);
            let f = a.nodep(n)[3];
            if f & (flag::SEA | flag::LAKE) != 0 && n != to {
                continue;
            }
            let d = if di != 0 && dj != 0 { diag } else { RES };
            let slope = (a.height(n) - a.height(k)).abs() / d;
            let mut w = d * (1.0 + 30.0 * slope * slope);
            if slope > 0.35 {
                w *= 3.0;
            }
            w *= match a.biome(n) {
                SNOWPEAK => 1.8,
                WETLAND => 1.5,
                1 => 1.15,
                2 => 1.2,
                4 => 1.1,
                _ => 1.0,
            };
            if f & flag::RIVER != 0 {
                w += 120.0;
            }
            if f & flag::SETTLEMENT != 0 {
                let (x, z) = node_xz(n);
                if dist(x, z, sp.x, sp.z) > sp.radius && dist(x, z, sq.x, sq.z) > sq.radius {
                    w *= 4.0;
                }
            }
            if on_road[n] {
                w *= 0.55;
            }
            let nc = c + w;
            if nc < cost[n] {
                cost[n] = nc;
                prev[n] = k as u32;
                heap.push(Reverse((nc.to_bits(), n as u32)));
            }
        }
    }
    if !cost[to].is_finite() {
        return None;
    }
    let mut path = vec![to];
    let mut k = to;
    while k != from {
        k = prev[k] as usize;
        path.push(k);
    }
    path.reverse();
    Some(path)
}

/// Turn the planned chains into road records, bridges, signposts and
/// roadside lanterns (after the settlements, which add their streets first).
pub fn finish(a: &Atlas, net: Net, t: &mut Towns) {
    let ter = Terrain::new(a);
    let seed = a.seed;
    let first_road = t.roads.len();
    for (ci, ch) in net.chains.iter().enumerate() {
        if ch.points.len() < 2 {
            continue;
        }
        let pts: Vec<[f64; 3]> = ch.points.iter().map(|p| [p[0], ter.sample(p[0], p[1]).0, p[1]]).collect();
        let length = pts.windows(2).map(|w| dist(w[0][0], w[0][2], w[1][0], w[1][2])).sum();
        let town_end = ch.ends.iter().any(|&e| e != NONE && t.settlements[e as usize].size == site::SIZE_TOWN);
        let road_index = t.roads.len() as u16;
        bridges(&ter, seed, &pts, road_index, ci, t);
        t.roads.push(Road {
            points: pts,
            from: ch.ends[0],
            to: ch.ends[1],
            width: ROAD_WIDTH,
            class: 0,
            surface: town_end as u8,
            settlement: NONE,
            length,
        });
    }
    signposts(&ter, seed, &net, t);
    lanterns(seed, first_road, t);
}

fn bridges(ter: &Terrain, seed: u64, pts: &[[f64; 3]], road: u16, ci: usize, t: &mut Towns) {
    let wet: Vec<(bool, f64)> = pts
        .iter()
        .map(|p| {
            let (h, w) = ter.sample(p[0], p[2]);
            (w > h + 0.2, w)
        })
        .collect();
    let mut i = 0;
    let mut nb = 0u32;
    while i < pts.len() {
        if !wet[i].0 {
            i += 1;
            continue;
        }
        let mut j = i;
        let mut water = wet[i].1;
        while j + 1 < pts.len() && wet[j + 1].0 {
            j += 1;
            water = water.max(wet[j].1);
        }
        // Dry ends: the samples before and after the wet run.
        let ia = i.saturating_sub(1);
        let ib = (j + 1).min(pts.len() - 1);
        let (pa, pb) = (pts[ia], pts[ib]);
        let span = dist(pa[0], pa[2], pb[0], pb[2]);
        if span < 2.0 || span > 90.0 || ia == i || ib == j {
            i = j + 1;
            continue;
        }
        let (dx, dz) = ((pb[0] - pa[0]) / span, (pb[2] - pa[2]) / span);
        let (ax, az) = (pa[0] - dx * 2.0, pa[2] - dz * 2.0);
        let (bx, bz) = (pb[0] + dx * 2.0, pb[2] + dz * 2.0);
        let ga = ter.height(ax, az);
        let gb = ter.height(bx, bz);
        let deck = ga.max(gb).max(water + 1.3) + 0.2;
        let yaw = libm::atan2(dz, dx);
        let len = dist(ax, az, bx, bz);
        let bi = t.bridges.len() as u16;
        let box_first = t.boxes.len() as u32;
        let width = ROAD_WIDTH + 0.6;
        let deck_o = Obb::new((ax + bx) * 0.5, (az + bz) * 0.5, yaw, len * 0.5, width * 0.5);
        push_flat(&mut t.boxes, &deck_o, deck - 0.5, deck, bk::DECK, bf::WALK | bf::CEIL, bi);
        for side in [-1.0, 1.0] {
            let r = super::geom::sub(&deck_o, 0.0, side * (width * 0.5 - 0.1), len * 0.5, 0.1);
            push_flat(&mut t.boxes, &r, deck - 0.5, deck + 1.0, bk::RAILING, bf::SOLID, bi);
        }
        for (ex, ez, g, outward) in [(ax, az, ga, -1.0), (bx, bz, gb, 1.0)] {
            let rise = deck - g;
            if rise <= 0.25 {
                continue;
            }
            let l = (rise * 2.6).max(2.0);
            let ro = Obb::new(ex + dx * outward * l * 0.5, ez + dz * outward * l * 0.5, yaw, l * 0.5, width * 0.5);
            let gout = ter.height(ex + dx * outward * l, ez + dz * outward * l);
            let (t1, t2) = if outward < 0.0 { (gout, deck) } else { (deck, gout) };
            push_ramp(&mut t.boxes, &ro, g.min(gout) - 1.0, t1, t2, bk::BRIDGE_RAMP, bf::WALK, bi);
        }
        let style = (unit(hash(seed, stream::ROADS, ci as i64, nb as i64, 1)) < 0.5) as u8;
        t.bridges.push(Bridge {
            id: stable_id(layer::BRIDGE, ci as i32, 0, nb),
            ax,
            az,
            bx,
            bz,
            deck_y: deck,
            width,
            water_y: water,
            road,
            style,
            box_first,
            box_count: (t.boxes.len() as u32 - box_first) as u16,
        });
        nb += 1;
        i = j + 1;
    }
}

/// A signpost at every fork, one arm per road leaving it, pointing at the
/// nearest settlement along that road.
fn signposts(ter: &Terrain, _seed: u64, net: &Net, t: &mut Towns) {
    let mut forks: Vec<usize> = Vec::new();
    for ch in &net.chains {
        for (e, &k) in [ch.nodes[0], *ch.nodes.last().unwrap()].iter().enumerate() {
            if ch.ends[e] == NONE && !forks.contains(&k) {
                forks.push(k);
            }
        }
    }
    forks.sort_unstable();
    for (fi, &k) in forks.iter().enumerate() {
        let (fx, fz) = node_xz(k);
        let mut arms = [(0u16, NONE); 3];
        let mut n = 0;
        let mut mean = (0.0, 0.0);
        for (ci, ch) in net.chains.iter().enumerate() {
            let at = if ch.nodes[0] == k {
                0
            } else if *ch.nodes.last().unwrap() == k {
                1
            } else {
                continue;
            };
            if ch.points.len() < 3 {
                continue;
            }
            let p = if at == 0 { ch.points[2] } else { ch.points[ch.points.len() - 3] };
            let yaw = libm::atan2(p[1] - fz, p[0] - fx);
            mean.0 += libm::cos(yaw);
            mean.1 += libm::sin(yaw);
            if n < 3 {
                arms[n] = (yaw16(yaw), nearest_settlement(net, ci, at));
                n += 1;
            }
        }
        if n < 3 {
            continue;
        }
        // Stand beside the fork, away from the roads.
        let ml = libm::sqrt(mean.0 * mean.0 + mean.1 * mean.1).max(1e-6);
        let (x, z) = (fx - mean.0 / ml * 4.0, fz - mean.1 / ml * 4.0);
        t.signs.push(Sign {
            id: stable_id(layer::SIGN, 0, 0, fi as u32),
            x,
            y: ter.height(x, z),
            z,
            arms,
        });
    }
}

/// Settlement reached first when leaving the fork along chain `ci` (which
/// touches the fork at end `at`), by breadth-first search over chains.
fn nearest_settlement(net: &Net, ci: usize, at: usize) -> u16 {
    let mut queue = vec![(ci, 1 - at)];
    let mut seen = vec![ci];
    let mut q = 0;
    while q < queue.len() && q < 64 {
        let (c, end) = queue[q];
        q += 1;
        let ch = &net.chains[c];
        if ch.ends[end] != NONE {
            return ch.ends[end];
        }
        let k = if end == 0 { ch.nodes[0] } else { *ch.nodes.last().unwrap() };
        for (c2, ch2) in net.chains.iter().enumerate() {
            if seen.contains(&c2) {
                continue;
            }
            if ch2.nodes[0] == k {
                seen.push(c2);
                queue.push((c2, 1));
            } else if *ch2.nodes.last().unwrap() == k {
                seen.push(c2);
                queue.push((c2, 0));
            }
        }
    }
    NONE
}

/// Spec 8: lanterns line the main roads near towns (every 28 m within
/// 260 m of a settlement edge, alternating sides).
fn lanterns(seed: u64, first_road: usize, t: &mut Towns) {
    let mut n = 0u32;
    for ri in first_road..t.roads.len() {
        let pts = t.roads[ri].points.clone();
        let mut acc = 0.0;
        let mut side = 1.0;
        for w in pts.windows(2) {
            let (p, q) = (w[0], w[1]);
            let l = dist(p[0], p[2], q[0], q[2]);
            acc += l;
            if acc < 28.0 || l <= 0.0 {
                continue;
            }
            acc = 0.0;
            let near = t
                .settlements
                .iter()
                .enumerate()
                .map(|(i, s)| (dist(p[0], p[2], s.x, s.z) - s.radius, i))
                .fold((f64::INFINITY, 0usize), |b, v| if v.0 < b.0 { v } else { b });
            if near.0 > 260.0 {
                continue;
            }
            let (dx, dz) = ((q[0] - p[0]) / l, (q[2] - p[2]) / l);
            let off = ROAD_WIDTH * 0.5 + 0.9;
            let (x, z) = (p[0] - dz * off * side, p[2] + dx * off * side);
            side = -side;
            let _ = seed;
            t.props.push(Prop {
                id: stable_id(layer::PROP, 0x3FFF, 1, n),
                x: x as f32,
                y: p[1] as f32,
                z: z as f32,
                yaw: yaw16(libm::atan2(dz, dx)),
                kind: pk::LANTERN,
                variant: 1,
                building: NONE,
                settlement: near.1 as u16,
                flags: pf::LIGHT,
                scale: 64,
                structure: NONE,
            });
            n += 1;
        }
    }
}
