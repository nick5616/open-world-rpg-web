//! Sky archipelagos (layer 1): islands at 300-800 m over the land, a sky town
//! or a palace on the big ones, ruins, the wind that carries you up.
//!
//! Placement reads only the base atlas (macro heights, water flags, base
//! sites, spawn), so it gives the same plan before and after the vertical
//! sites are appended.

use super::*;
use crate::atlas::format::{flag, idx, param, NONE16, N, RES};
use crate::atlas::region_of;
use crate::names;
use crate::rng::{hash, stable_id, Seq};

/// Highest macro node within r of (x, z) (and the lowest), over the grid.
pub(crate) fn macro_range(a: &Atlas, x: f64, z: f64, r: f64) -> (f64, f64) {
    let i0 = (libm::floor((x - r) / RES) as i64).clamp(0, N as i64 - 1);
    let i1 = (libm::ceil((x + r) / RES) as i64).clamp(0, N as i64 - 1);
    let j0 = (libm::floor((z - r) / RES) as i64).clamp(0, N as i64 - 1);
    let j1 = (libm::ceil((z + r) / RES) as i64).clamp(0, N as i64 - 1);
    let (mut hi, mut lo) = (f64::MIN, f64::MAX);
    for j in j0..=j1 {
        for i in i0..=i1 {
            let (nx, nz) = (i as f64 * RES, j as f64 * RES);
            if (nx - x) * (nx - x) + (nz - z) * (nz - z) > (r + RES) * (r + RES) {
                continue;
            }
            let h = a.height(idx(i as usize, j as usize));
            hi = hi.max(h);
            lo = lo.min(h);
        }
    }
    if hi == f64::MIN {
        (0.0, 0.0)
    } else {
        (hi, lo)
    }
}

/// Is the macro node nearest (x, z) dry land (no sea, lake or river)?
pub(crate) fn dry(a: &Atlas, x: f64, z: f64) -> bool {
    let i = (libm::round(x / RES) as i64).clamp(0, N as i64 - 1) as usize;
    let j = (libm::round(z / RES) as i64).clamp(0, N as i64 - 1) as usize;
    a.nodep(idx(i, j))[3] & (flag::SEA | flag::LAKE | flag::RIVER) == 0
}

/// Bilinear macro height (cheap; not the exact surface).
pub(crate) fn macro_at(a: &Atlas, x: f64, z: f64) -> f64 {
    let u = (x / RES).clamp(0.0, (N - 1) as f64);
    let v = (z / RES).clamp(0.0, (N - 1) as f64);
    let i = (libm::floor(u) as usize).min(N - 2);
    let j = (libm::floor(v) as usize).min(N - 2);
    let (fu, fv) = (u - i as f64, v - j as f64);
    let h00 = a.height(idx(i, j));
    let h10 = a.height(idx(i + 1, j));
    let h01 = a.height(idx(i, j + 1));
    let h11 = a.height(idx(i + 1, j + 1));
    h00 * (1.0 - fu) * (1.0 - fv) + h10 * fu * (1.0 - fv) + h01 * (1.0 - fu) * fv + h11 * fu * fv
}

pub(crate) fn biome_at(a: &Atlas, x: f64, z: f64) -> u8 {
    let i = (libm::round(x / RES) as i64).clamp(0, N as i64 - 1) as usize;
    let j = (libm::round(z / RES) as i64).clamp(0, N as i64 - 1) as usize;
    a.biome(idx(i, j))
}

#[inline]
fn d2(ax: f64, az: f64, bx: f64, bz: f64) -> f64 {
    (ax - bx) * (ax - bx) + (az - bz) * (az - bz)
}

const WORLD: f64 = 4096.0;
const TAU: f64 = core::f64::consts::TAU;
/// Lowest and highest island tops.
pub const TOP_MIN: f64 = 330.0;
pub const TOP_MAX: f64 = 800.0;
/// Clear air between the lowest point of an island and the ground under it.
const CLEARANCE: f64 = 120.0;

fn name_grammar(a: &Atlas) -> usize {
    a.param(param::NAME_GRAMMAR) as usize
}

pub fn plan(a: &Atlas, p: &mut Plan) {
    let seed = a.seed;
    let density = a.param(param::STRUCTURE_DENSITY);
    let spawn = (a.param(param::SPAWN_X), a.param(param::SPAWN_Z));
    let g = name_grammar(a);
    let mut seq = Seq::new(seed, stream::SKY);
    // Surface settlements, in atlas order.
    let towns: Vec<SiteRec> = (0..p.base_sites).map(|i| a.site(i)).filter(|s| s.category == S::CAT_SETTLEMENT).collect();
    let n_arch = 3 + libm::round(2.0 * density) as usize;
    let n_towns = if n_arch >= 4 { 3 } else { 2 };
    let n_palaces = if n_arch >= 5 { 2 } else { 1 };

    // Settlements to anchor archipelagos near (sky lifts): the spawn town
    // first (islands on the first skyline a new player sees), then the
    // others in a seeded order.
    let mut order: Vec<usize> = (0..towns.len()).collect();
    order.sort_by(|&i, &j| {
        let di = d2(towns[i].x, towns[i].z, spawn.0, spawn.1);
        let dj = d2(towns[j].x, towns[j].z, spawn.0, spawn.1);
        di.partial_cmp(&dj).unwrap().then(i.cmp(&j))
    });
    let first = order.first().copied();
    let mut rest: Vec<usize> = order.iter().skip(1).copied().collect();
    for i in (1..rest.len()).rev() {
        let k = (hash(seed, stream::SKY ^ 0x51, i as i64, 0, 0) % (i as u64 + 1)) as usize;
        rest.swap(i, k);
    }
    let mut anchor_towns: Vec<Option<usize>> = vec![first];
    anchor_towns.extend(rest.into_iter().map(Some));

    let mut archs: Vec<(f64, f64, f64, f64, Option<usize>)> = Vec::new(); // x, z, r, base, town
    let mut tries = 0usize;
    let mut ti = 0usize;
    while archs.len() < n_arch && tries < 400 {
        tries += 1;
        let ar = seq.range(300.0, 430.0);
        // Near a settlement (with a sky lift) for the first few, else free.
        let town = if archs.len() < n_arch - 1 && ti < anchor_towns.len() { anchor_towns[ti] } else { None };
        let (cx, cz) = if let Some(t) = town {
            let s = &towns[t];
            let ang = seq.range(0.0, TAU);
            let d = s.radius + seq.range(260.0, 420.0);
            (s.x + d * libm::cos(ang), s.z + d * libm::sin(ang))
        } else {
            (seq.range(500.0, WORLD - 500.0), seq.range(500.0, WORLD - 500.0))
        };
        if tries % 12 == 0 && town.is_some() {
            ti += 1; // give up on this settlement
        }
        if cx < ar + 120.0 || cz < ar + 120.0 || cx > WORLD - ar - 120.0 || cz > WORLD - ar - 120.0 {
            continue;
        }
        if archs.iter().any(|q| d2(q.0, q.1, cx, cz) < (q.2 + ar + 380.0) * (q.2 + ar + 380.0)) {
            continue;
        }
        // Never right over a settlement (shade, and its sky would be a lid).
        if towns.iter().any(|s| d2(s.x, s.z, cx, cz) < (s.radius + 140.0) * (s.radius + 140.0)) {
            continue;
        }
        let (hi, _) = macro_range(a, cx, cz, ar + 80.0);
        let base = (hi + 330.0).max(seq.range(420.0, 600.0));
        if base > TOP_MAX - 120.0 {
            continue;
        }
        if town.is_some() {
            ti += 1;
        }
        archs.push((cx, cz, ar, base, town));
    }

    let mut town_left = n_towns;
    let mut palace_left = n_palaces;
    for (ai, &(cx, cz, ar, base, town)) in archs.iter().enumerate() {
        let arch_id = stable_id(idl::ARCH, 0, 0, ai as u32);
        let mut aseq = Seq::new(seed ^ arch_id, stream::ISLAND);
        let first_island = p.islands.len() as u16;
        // The anchor island: a town on the first archipelagos, a palace on
        // the last ones, else a big grove.
        let role = if ai < n_towns && town_left > 0 {
            town_left -= 1;
            ik::TOWN
        } else if ai + palace_left >= archs.len() && palace_left > 0 {
            palace_left -= 1;
            ik::PALACE
        } else {
            ik::GROVE
        };
        let r_anchor = match role {
            ik::TOWN => aseq.range(104.0, 128.0),
            ik::PALACE => aseq.range(118.0, 140.0),
            _ => aseq.range(70.0, 96.0),
        };
        let top_anchor = if role == ik::PALACE { base + 70.0 } else { base };
        let anchor_ok = add_island(a, p, ai as u16, cx, cz, r_anchor, top_anchor, role, &mut aseq);
        if !anchor_ok {
            // Ground too high under the anchor: lift it until it clears.
            let (hi, _) = macro_range(a, cx, cz, r_anchor + 50.0);
            let t = (hi + CLEARANCE + r_anchor * 1.2 + 40.0).min(TOP_MAX);
            add_island(a, p, ai as u16, cx, cz, r_anchor, t, role, &mut aseq);
        }
        // Satellites in a loose spiral, stepping up and down for hopping.
        let want = 5 + aseq.below(4);
        let mut placed = 0usize;
        let golden = 2.399_963_229_728_653;
        let a0 = aseq.range(0.0, TAU);
        for t in 0..want * 8 {
            if placed >= want {
                break;
            }
            let ang = a0 + golden * t as f64 + aseq.range(-0.25, 0.25);
            let dist = aseq.range(r_anchor + 70.0, ar);
            let r = aseq.range(18.0, 64.0) * (1.0 - 0.35 * (dist / ar));
            let x = cx + dist * libm::cos(ang);
            let z = cz + dist * libm::sin(ang);
            let top = (base + aseq.range(-120.0, 105.0)).clamp(TOP_MIN, TOP_MAX - 20.0);
            let kind = match aseq.below(20) {
                0..=6 => ik::GROVE,
                7..=11 => ik::MEADOW,
                12..=15 => ik::CRAG,
                _ => ik::RUIN,
            };
            if add_island(a, p, ai as u16, x, z, r, top, kind, &mut aseq) {
                placed += 1;
            }
        }
        let count = p.islands.len() as u16 - first_island;
        let lowest = p.islands[first_island as usize..].iter().map(|i| i.top).fold(f64::MAX, f64::min);
        let cloud_y = lowest - aseq.range(95.0, 140.0);
        p.archs.push(Arch {
            id: arch_id,
            x: cx,
            z: cz,
            r: ar,
            base,
            cloud_y,
            site: NONE16,
            first_island,
            islands: count,
            town: town.map(|t| towns[t].index as u16).unwrap_or(NONE16),
        });
    }

    // Wind: a sky lift at the settlement edge (the fast way up), wind
    // columns rising from the ground under each archipelago, and currents
    // beside the islands that carry you from a low island to a higher one.
    for ai in 0..p.archs.len() {
        let arch = p.archs[ai].clone();
        let mut wseq = Seq::new(seed ^ arch.id, stream::SKY ^ 0x77);
        let isl: Vec<Island> = p.islands[arch.first_island as usize..(arch.first_island + arch.islands) as usize].to_vec();
        let anchor = &isl[0];
        if arch.town != NONE16 {
            let s = a.site(arch.town as usize);
            let (dx, dz) = (anchor.x - s.x, anchor.z - s.z);
            let l = libm::sqrt(dx * dx + dz * dz).max(1.0);
            let off = s.radius * crate::town::layout::LAYOUT_SCALE[(s.size as usize).min(2)] + 14.0;
            let (lx, lz) = (s.x + dx / l * off, s.z + dz / l * off);
            let ground = macro_at(a, lx, lz);
            let to_rim = (l - off - anchor.reach).max(0.0);
            // Glide sinks 2 m per 9 m forward: arrive over the island's top.
            let top = anchor.top + 45.0 + to_rim * (2.0 / 9.0) * 1.15;
            p.updrafts.push(Updraft { x: lx, z: lz, r: 5.5, bottom: ground - 6.0, top, lift: 18.0, kind: uk::LIFT, arch: ai as u16 });
        }
        // Two columns from the ground beside the archipelago.
        let mut cols = 0;
        for t in 0..24 {
            if cols >= 2 {
                break;
            }
            let ang = wseq.range(0.0, TAU);
            let d = wseq.range(arch.r * 0.4, arch.r + 60.0);
            let (x, z) = (arch.x + d * libm::cos(ang), arch.z + d * libm::sin(ang));
            if !dry(a, x, z) || isl.iter().any(|i| d2(i.x, i.z, x, z) < (i.reach + 12.0) * (i.reach + 12.0)) {
                continue;
            }
            if towns.iter().any(|s| d2(s.x, s.z, x, z) < (s.radius + 20.0) * (s.radius + 20.0)) {
                continue;
            }
            // The lowest island near it is where it carries you.
            let near = isl.iter().filter(|i| d2(i.x, i.z, x, z) < 260.0 * 260.0).map(|i| i.top).fold(f64::MAX, f64::min);
            let target = if near == f64::MAX { anchor.top } else { near };
            let ground = macro_at(a, x, z);
            let kind = if biome_at(a, x, z) == crate::atlas::climate::BADLANDS || biome_at(a, x, z) == crate::atlas::climate::HIGHLANDS || t % 2 == 1 {
                uk::GEYSER
            } else {
                uk::COLUMN
            };
            p.updrafts.push(Updraft { x, z, r: 7.0, bottom: ground - 4.0, top: target + 40.0, lift: 10.0, kind, arch: ai as u16 });
            cols += 1;
        }
        // Currents between islands: beside each island, toward the next higher one.
        let mut sorted: Vec<usize> = (0..isl.len()).collect();
        sorted.sort_by(|&i, &j| isl[i].top.partial_cmp(&isl[j].top).unwrap().then(i.cmp(&j)));
        for w in 0..sorted.len().saturating_sub(1) {
            let lo = &isl[sorted[w]];
            // The nearest higher island.
            let mut best: Option<&Island> = None;
            for hi in sorted[w + 1..].iter().map(|&k| &isl[k]) {
                if best.is_none_or(|b| d2(lo.x, lo.z, hi.x, hi.z) < d2(lo.x, lo.z, b.x, b.z)) {
                    best = Some(hi);
                }
            }
            let Some(hi) = best else { continue };
            let (dx, dz) = (hi.x - lo.x, hi.z - lo.z);
            let l = libm::sqrt(dx * dx + dz * dz).max(1.0);
            let off = lo.reach + 9.0;
            let (x, z) = (lo.x + dx / l * off, lo.z + dz / l * off);
            if isl.iter().any(|i| d2(i.x, i.z, x, z) < (i.reach + 7.0) * (i.reach + 7.0)) {
                continue;
            }
            let gap = (l - off - hi.reach).max(0.0);
            let top = hi.top + 30.0 + gap * (2.0 / 9.0) * 1.1;
            p.updrafts.push(Updraft { x, z, r: 6.0, bottom: lo.top - 90.0, top, lift: 10.0, kind: uk::CURRENT, arch: ai as u16 });
        }
    }

    // Sites: archipelago names, sky towns (+ their waypoint), palaces, ruins,
    // sky lifts at the surface settlements.
    for ai in 0..p.archs.len() {
        let arch = p.archs[ai].clone();
        let mut nseq = Seq::new(seed ^ arch.id, stream::NAMES);
        let si = p.sites.len() as u16;
        p.sites.push(NewSite {
            category: S::CAT_POI,
            kind: S::POI_ARCHIPELAGO,
            size: 0,
            layer: LAYER_SKY,
            x: arch.x,
            y: arch.base + 40.0,
            z: arch.z,
            radius: arch.r,
            yaw: 0,
            link_local: NONE16,
            name: names::site_name(g, nseq.pick(&["Skyreach", "Cloudholm", "Isles", "Drift", "Heights"]), &mut nseq),
            biome: biome_at(a, arch.x, arch.z),
            element: 4,
            region: region_of(arch.x, arch.z) as u8,
        });
        p.archs[ai].site = (p.base_sites + si as usize) as u16;
        for k in arch.first_island..arch.first_island + arch.islands {
            let isl = p.islands[k as usize].clone();
            let mut iseq = Seq::new(seed ^ isl.id, stream::NAMES);
            let local = p.sites.len();
            let (cat, kind, size, radius, name) = match isl.kind {
                ik::TOWN => {
                    let size = if isl.r >= 118.0 { S::SIZE_VILLAGE } else { S::SIZE_HAMLET };
                    (S::CAT_SETTLEMENT, 0u8, size, if size == S::SIZE_VILLAGE { 80.0 } else { 45.0 }, names::settlement_name(g, &mut iseq))
                }
                ik::PALACE => (S::CAT_STRUCTURE, S::ST_SKY_PALACE, 2, 64.0, names::site_name(g, iseq.pick(&["Palace", "Sanctum", "Citadel", "Aerie"]), &mut iseq)),
                ik::RUIN => (S::CAT_STRUCTURE, S::ST_SKY_RUIN, 0, (isl.r * 0.6).min(28.0), names::site_name(g, iseq.pick(&["Ruin", "Remnant", "Folly", "Steps"]), &mut iseq)),
                _ => continue,
            };
            p.sites.push(NewSite {
                category: cat,
                kind,
                size,
                layer: LAYER_SKY,
                x: isl.x,
                y: isl.top,
                z: isl.z,
                radius,
                yaw: (hash(seed, stream::NAMES, isl.id as i64, 3, 0) >> 48) as u16,
                link_local: NONE16,
                name,
                biome: if isl.kind == ik::TOWN { crate::atlas::climate::HIGHLANDS } else { isl.biome },
                element: if isl.kind == ik::PALACE { 5 } else { 4 },
                region: region_of(isl.x, isl.z) as u8,
            });
            p.islands[k as usize].site = (p.base_sites + local) as u16;
            if isl.kind == ik::TOWN {
                // The town's waypoint stone (fast travel, respawn), linked like a surface town's.
                p.sites.push(NewSite {
                    category: S::CAT_POI,
                    kind: S::POI_WAYPOINT,
                    size: 1,
                    layer: LAYER_SKY,
                    x: isl.x,
                    y: isl.top,
                    z: isl.z,
                    radius: 3.0,
                    yaw: 0,
                    link_local: local as u16,
                    name: String::new(),
                    biome: crate::atlas::climate::HIGHLANDS,
                    element: 255,
                    region: region_of(isl.x, isl.z) as u8,
                });
            }
        }
    }
    for u in p.updrafts.clone() {
        if u.kind != uk::LIFT {
            continue;
        }
        let arch = &p.archs[u.arch as usize];
        let mut nseq = Seq::new(seed ^ arch.id, stream::NAMES ^ 0x11);
        p.sites.push(NewSite {
            category: S::CAT_POI,
            kind: S::POI_SKY_LIFT,
            size: 0,
            layer: LAYER_SURFACE,
            x: u.x,
            y: u.bottom + 6.0,
            z: u.z,
            radius: 8.0,
            yaw: 0,
            link_local: NONE16,
            name: names::site_name(g, nseq.pick(&["Skylift", "Windstone", "Updraft"]), &mut nseq),
            biome: biome_at(a, u.x, u.z),
            element: 4,
            region: region_of(u.x, u.z) as u8,
        });
    }
}

/// Add an island if it fits (no overlap, clear air under it). Returns false when it doesn't.
#[allow(clippy::too_many_arguments)]
fn add_island(a: &Atlas, p: &mut Plan, arch: u16, x: f64, z: f64, r: f64, top: f64, kind: u8, seq: &mut Seq) -> bool {
    let index = p.islands.len();
    let id = stable_id(idl::ISLAND, arch as i32, 0, index as u32);
    let mut lobes = vec![[0.0, 0.0, r]];
    let extra = if r < 24.0 { seq.below(2) } else { 1 + seq.below(3) };
    let mut reach = r;
    let a0 = seq.range(0.0, TAU);
    for k in 0..extra {
        let ang = a0 + (k as f64) * (TAU / extra as f64) + seq.range(-0.5, 0.5);
        let d = r * seq.range(0.35, 0.6);
        let lr = r * seq.range(0.42, 0.66);
        let (dx, dz) = (d * libm::cos(ang), d * libm::sin(ang));
        reach = reach.max(d + lr);
        lobes.push([dx, dz, lr]);
    }
    reach += 7.0; // boundary warp
    if x < reach + 40.0 || z < reach + 40.0 || x > WORLD - reach - 40.0 || z > WORLD - reach - 40.0 {
        return false;
    }
    if p.islands.iter().any(|o| d2(o.x, o.z, x, z) < (o.reach + reach + 26.0) * (o.reach + reach + 26.0)) {
        return false;
    }
    let thick = r * seq.range(0.75, 1.1) + 14.0;
    let (hi, _) = macro_range(a, x, z, reach + 40.0);
    if top - thick - 25.0 < hi + CLEARANCE {
        return false;
    }
    let amp = match kind {
        ik::TOWN | ik::PALACE => 1.2,
        ik::CRAG => seq.range(7.0, 12.0),
        ik::MEADOW => seq.range(2.0, 4.0),
        _ => seq.range(3.0, 6.0),
    };
    let biome = biome_at(a, x, z);
    p.islands.push(Island {
        id,
        arch,
        x,
        z,
        r,
        reach,
        top,
        thick,
        cliff: seq.range(5.0, 11.0),
        amp,
        lobes,
        kind,
        seed: (hash(a.seed, stream::ISLAND, id as i64, 0, 0) >> 32) as u32,
        site: NONE16,
        biome,
    });
    true
}
