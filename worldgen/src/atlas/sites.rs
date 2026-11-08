//! Settlement sites, towers, structures and other points of interest, placed
//! by visibility (spec 5). Everything here is data for later packages: WP20
//! builds towns, roads and structure geometry from these sites, WP12 uses the
//! towers, WP09 grows cave systems from the cave mouths.
//!
//! Order of placement (each step sees the ones before it):
//! 1. settlement sites (flat ground, fresh water, shelter, spacing; >= 1 per region)
//! 2. one tower per region, the candidate with the largest viewshed
//! 3. cave mouths and structures, preferring ground just behind a ridge as
//!    seen from the towers, so the reveal happens as you crest it
//! 4. waypoints, landmarks, enemy camps
//! 5. gap filling until almost every walkable node sees a POI within 800 m
//!
//! Sites never move once placed; the table order is placement order, and a
//! site's index in it is what per-character bitsets (towers, waypoints) use.

use super::climate::{distance_from, BADLANDS, FOREST, HIGHLANDS, MEADOW, SNOWPEAK, WETLAND};
use super::format::{idx, site as S, N, NN, RES};
use super::viewshed::{viewshed, Bits};
use super::{region_of, Site, World};
use crate::names;
use crate::rng::{hash, stable_id, unit, weighted_pick, Seq};

const STREAM_SITE: u64 = 0x5349_5445; // "SITE"
const VIS_RADIUS: f64 = 800.0;
const TOWER_RADIUS: f64 = 1500.0;
const TOWER_HEIGHT: f64 = 30.0;
const MAX_SITES_PER_REGION: usize = 44;
/// Gap filling stops once at most this fraction of walkable nodes lacks a
/// visible POI within 800 m (spec 5's rule "as far as budget allows").
const UNCOVERED_TARGET: f64 = 0.02;

struct Cand {
    k: usize,
    x: f64,
    z: f64,
    region: usize,
    vis: Bits,
}

struct Placer<'a> {
    w: &'a World,
    sites: Vec<Site>,
    region_count: Vec<usize>,
}

impl<'a> Placer<'a> {
    fn spacing_ok(&self, x: f64, z: f64, radius: f64, cat: u8, kind: u8, same_min: f64) -> bool {
        for s in &self.sites {
            let d = libm::sqrt((s.x - x) * (s.x - x) + (s.z - z) * (s.z - z));
            if d < (s.radius + radius + 60.0).max(140.0) {
                return false;
            }
            if s.category == cat && s.kind == kind && d < same_min {
                return false;
            }
        }
        true
    }

    fn dist_to_settlement(&self, x: f64, z: f64) -> f64 {
        let mut best = 1e9;
        for s in &self.sites {
            if s.category == S::CAT_SETTLEMENT {
                let d = libm::sqrt((s.x - x) * (s.x - x) + (s.z - z) * (s.z - z)) - s.radius;
                best = f64::min(best, d);
            }
        }
        best
    }

    #[allow(clippy::too_many_arguments)]
    fn push(&mut self, k: usize, cat: u8, kind: u8, size: u8, radius: f64, vis_h: f64, score: f64) -> usize {
        let w = self.w;
        let x = (k % N) as f64 * RES;
        let z = (k / N) as f64 * RES;
        let index = self.sites.len();
        let layer = 0x40 | (cat << 4) | kind;
        let id = stable_id(layer, 0, k as i32, index as u32);
        let region = region_of(x, z);
        self.region_count[region] += 1;
        self.sites.push(Site {
            id,
            category: cat,
            kind,
            region: region as u8,
            size,
            x,
            z,
            y: w.h[k],
            radius,
            score,
            name: super::format::NONE16,
            biome: w.biome[k],
            element: 255,
            vis_h,
            vis_count: 0,
            seed: hash(w.seed, STREAM_SITE, id as i64, 1, 0) as u32,
            yaw: 0,
            link: super::format::NONE16,
            node: k,
        });
        index
    }

    fn full(&self, region: usize) -> bool {
        self.region_count[region] >= MAX_SITES_PER_REGION
    }
}

fn node_xz(k: usize) -> (f64, f64) {
    ((k % N) as f64 * RES, (k / N) as f64 * RES)
}

/// Height minus the mean of 8 samples on a ring `r` nodes out.
fn prominence(h: &[f64], k: usize, r: i32) -> f64 {
    let (i, j) = ((k % N) as i32, (k / N) as i32);
    let mut sum = 0.0;
    for (dx, dz) in [(r, 0), (-r, 0), (0, r), (0, -r), (r, r), (-r, r), (r, -r), (-r, -r)] {
        let ni = (i + dx).clamp(0, N as i32 - 1) as usize;
        let nj = (j + dz).clamp(0, N as i32 - 1) as usize;
        sum += h[idx(ni, nj)];
    }
    h[k] - sum / 8.0
}

fn mean_slope(slope: &[f64], k: usize, r: i32) -> f64 {
    let (i, j) = ((k % N) as i32, (k / N) as i32);
    let mut sum = 0.0;
    let mut n = 0.0;
    for dz in -r..=r {
        for dx in -r..=r {
            let ni = (i + dx).clamp(0, N as i32 - 1) as usize;
            let nj = (j + dz).clamp(0, N as i32 - 1) as usize;
            sum += slope[idx(ni, nj)];
            n += 1.0;
        }
    }
    sum / n
}

fn rand01(seed: u64, stream: u64, k: usize) -> f64 {
    unit(hash(seed, STREAM_SITE ^ stream, k as i64, 0, 0))
}

/// Sort node indices by score descending, index ascending on ties.
fn sort_desc(v: &mut [(f64, usize)]) {
    v.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
}

pub fn place(w: &mut World) {
    let seed = w.seed;
    let ground: Vec<bool> = (0..NN).map(|k| !w.sea[k] && !w.lake[k] && w.river_w[k] == 0).collect();
    let mut walk = Bits::new();
    for k in 0..NN {
        if ground[k] && w.slope[k] < 35.0 {
            walk.set(k);
        }
    }
    let prom: Vec<f64> = (0..NN).map(|k| prominence(&w.h, k, 5)).collect();

    // Candidate sites for visibility-driven POIs (spec 5): peaks, ridge
    // crests, river bends and valley mouths, plus every third node on land so
    // flat country still gets candidates for gap filling.
    let mut is_cand = vec![false; NN];
    for j in (1..N - 1).step_by(3) {
        for i in (1..N - 1).step_by(3) {
            is_cand[idx(i, j)] = true;
        }
    }
    for k in feature_nodes(w, &prom, &ground) {
        is_cand[k] = true;
    }
    let mut cands: Vec<Cand> = Vec::new();
    for k in 0..NN {
        if !is_cand[k] || !ground[k] {
            continue;
        }
        let (x, z) = node_xz(k);
        cands.push(Cand {
            k,
            x,
            z,
            region: region_of(x, z),
            vis: viewshed(&w.h, x, z, 10.0, VIS_RADIUS),
        });
    }

    let mut p = Placer {
        w,
        sites: Vec::new(),
        region_count: vec![0; super::format::REGIONS],
    };

    // ---- 1. settlements
    let dens = w.spec.settlement_density;
    let total = 16 + libm::round(24.0 * dens) as usize;
    let mut scored: Vec<(f64, usize)> = Vec::new();
    let mut relaxed: Vec<(f64, usize)> = Vec::new();
    for k in 0..NN {
        if !ground[k] {
            continue;
        }
        let alt = w.h[k] - w.sea_y;
        let ms = mean_slope(&w.slope, k, 1);
        let df = w.dist_fresh[k];
        let water = if df < 40.0 { 0.35 } else { libm::exp(-df / 220.0) } + 0.35 * libm::exp(-w.dist_water[k] / 200.0);
        let shelter = (-prominence(&w.h, k, 6) / 35.0).clamp(-0.5, 1.0) * 0.5;
        let biome_bonus = [0.25, 0.15, 0.05, -0.6, -0.1, -0.05][w.biome[k] as usize];
        let s = 1.2 * (1.0 - ms / 9.0) + water + shelter + biome_bonus - alt / 400.0 + 0.15 * rand01(seed, 1, k);
        if ms < 9.0 && w.biome[k] != SNOWPEAK && alt < 260.0 {
            scored.push((s, k));
        } else {
            relaxed.push((s - 2.0, k));
        }
    }
    sort_desc(&mut scored);
    sort_desc(&mut relaxed);
    let settle_space = 380.0;
    let mut settlement_idx: Vec<usize> = Vec::new();
    // Guarantee: every region gets its best site first.
    for r in 0..super::format::REGIONS {
        let pick = scored
            .iter()
            .chain(relaxed.iter())
            .find(|&&(_, k)| {
                let (x, z) = node_xz(k);
                region_of(x, z) == r && p.spacing_ok(x, z, 45.0, S::CAT_SETTLEMENT, 0, settle_space)
            })
            .copied();
        if let Some((s, k)) = pick {
            settlement_idx.push(p.push(k, S::CAT_SETTLEMENT, 0, S::SIZE_HAMLET, 45.0, 12.0, s));
        }
    }
    for &(s, k) in &scored {
        if settlement_idx.len() >= total {
            break;
        }
        let (x, z) = node_xz(k);
        let r = region_of(x, z);
        let in_region = settlement_idx.iter().filter(|&&i| p.sites[i].region as usize == r).count();
        if in_region >= 5 || !p.spacing_ok(x, z, 45.0, S::CAT_SETTLEMENT, 0, settle_space) {
            continue;
        }
        settlement_idx.push(p.push(k, S::CAT_SETTLEMENT, 0, S::SIZE_HAMLET, 45.0, 12.0, s));
    }
    // Sizes by rank: the best few roomy sites become walled towns, then villages.
    let mut ranked: Vec<(f64, usize)> = settlement_idx.iter().map(|&i| (p.sites[i].score, i)).collect();
    sort_desc(&mut ranked);
    let n_towns = 1 + libm::round(2.0 * dens) as usize;
    let n_villages = libm::round(0.35 * ranked.len() as f64) as usize;
    let mut towns: Vec<(f64, f64)> = Vec::new();
    let mut villages = 0;
    for &(_, i) in &ranked {
        let s = &p.sites[i];
        let roomy = mean_slope(&w.slope, s.node, 4) < 7.0;
        let far = towns
            .iter()
            .all(|&(tx, tz)| libm::sqrt((tx - s.x) * (tx - s.x) + (tz - s.z) * (tz - s.z)) > 900.0);
        if towns.len() < n_towns && roomy && far {
            towns.push((s.x, s.z));
            p.sites[i].size = S::SIZE_TOWN;
            p.sites[i].radius = 130.0;
        } else if villages < n_villages {
            villages += 1;
            p.sites[i].size = S::SIZE_VILLAGE;
            p.sites[i].radius = 80.0;
        }
    }

    // Spawn: the best meadow/forest settlement near the middle of the world.
    let mut spawn_best = (f64::NEG_INFINITY, settlement_idx[0]);
    for &i in &settlement_idx {
        let s = &p.sites[i];
        let center = libm::sqrt((s.x - 2048.0) * (s.x - 2048.0) + (s.z - 2048.0) * (s.z - 2048.0));
        let b = if s.biome == MEADOW || s.biome == FOREST { 0.6 } else { 0.0 };
        let v = s.score + b - center / 1500.0;
        if v > spawn_best.0 {
            spawn_best = (v, i);
        }
    }
    let spawn = (p.sites[spawn_best.1].x, p.sites[spawn_best.1].z, p.sites[spawn_best.1].y);

    // ---- regions: biome mix, element, danger
    let mut regions = super::regions(w, spawn);

    // ---- 2. towers
    let mut tower_union = Bits::new();
    for r in 0..super::format::REGIONS {
        let mut rc: Vec<(f64, usize)> = cands
            .iter()
            .enumerate()
            .filter(|(_, c)| c.region == r && w.slope[c.k] < 30.0)
            .filter(|(_, c)| p.spacing_ok(c.x, c.z, 8.0, S::CAT_POI, S::POI_TOWER, 600.0))
            .map(|(ci, c)| (prom[c.k] + 0.1 * (w.h[c.k] - w.sea_y), ci))
            .collect();
        sort_desc(&mut rc);
        rc.truncate(24);
        let mut best: Option<(f64, usize, Bits)> = None;
        for &(_, ci) in &rc {
            let c = &cands[ci];
            let vis = viewshed(&w.h, c.x, c.z, TOWER_HEIGHT, TOWER_RADIUS);
            let score = vis.and_count(&walk) as f64;
            if best.as_ref().is_none_or(|b| score > b.0) {
                best = Some((score, c.k, vis));
            }
        }
        let (score, k, vis) = match best {
            Some(b) => b,
            None => {
                // Tiny region: the highest dry node it has.
                let mut hk = None;
                let per = (N - 1) / 4;
                let (rx, rz) = (r % 4, r / 4);
                for j in rz * per..(rz + 1) * per {
                    for i in rx * per..(rx + 1) * per {
                        let k = idx(i, j);
                        if ground[k] && hk.is_none_or(|h: usize| w.h[k] > w.h[h]) {
                            hk = Some(k);
                        }
                    }
                }
                let Some(k) = hk else { continue };
                let (x, z) = node_xz(k);
                let vis = viewshed(&w.h, x, z, TOWER_HEIGHT, TOWER_RADIUS);
                (vis.and_count(&walk) as f64, k, vis)
            }
        };
        tower_union.or(&vis);
        let ti = p.push(k, S::CAT_POI, S::POI_TOWER, 0, 8.0, TOWER_HEIGHT, score);
        regions[r].tower = ti as u16;
    }

    // "Just behind a ridge": hidden from every tower, but within ~200 m of
    // ground a tower can see.
    let visible_land: Vec<bool> = (0..NN).map(|k| tower_union.get(k) && !w.sea[k]).collect();
    let behind_d = distance_from(&visible_land);
    let behind = |k: usize| -> f64 {
        let d = behind_d[k];
        if (30.0..=200.0).contains(&d) {
            1.0
        } else if d > 200.0 && d < 400.0 {
            0.4
        } else {
            0.0
        }
    };
    let region_nodes = |r: usize| -> Vec<usize> {
        let per = (N - 1) / 4;
        let (rx, rz) = (r % 4, r / 4);
        let mut v = Vec::new();
        for j in rz * per..(rz + 1) * per {
            for i in rx * per..(rx + 1) * per {
                let k = idx(i, j);
                if ground[k] {
                    v.push(k);
                }
            }
        }
        v
    };

    // ---- 3a. cave mouths
    let n_caves = 1 + libm::round(2.0 * w.spec.cave_density) as usize;
    for r in 0..super::format::REGIONS {
        let nodes = region_nodes(r);
        for c in 0..n_caves {
            let mut best: Option<(f64, usize)> = None;
            for &k in &nodes {
                let s = w.slope[k];
                if !(10.0..=45.0).contains(&s) || w.h[k] - w.sea_y < 6.0 {
                    continue;
                }
                let v = 1.0 + 1.2 * behind(k) + 0.4 * rand01(seed, 10 + c as u64, k);
                if best.is_none_or(|b| v > b.0) {
                    let (x, z) = node_xz(k);
                    if p.spacing_ok(x, z, 6.0, S::CAT_POI, S::POI_CAVE_MOUTH, 350.0) {
                        best = Some((v, k));
                    }
                }
            }
            if let Some((v, k)) = best {
                let i = p.push(k, S::CAT_POI, S::POI_CAVE_MOUTH, 0, 6.0, 4.0, v);
                p.sites[i].yaw = downhill_yaw(&w.h, k);
            }
        }
    }

    // ---- 3b. structures
    let n_struct = 2 + libm::round(3.0 * w.spec.structure_density) as usize;
    let mut craters = 0;
    for r in 0..super::format::REGIONS {
        let reg = &regions[r];
        let nodes = region_nodes(r);
        let mut lairs = 0;
        for c in 0..n_struct {
            let u = unit(hash(seed, STREAM_SITE ^ 0x5354, r as i64, c as i64, 0));
            let mut tw = [0.0f64; 9];
            for (t, row) in STRUCT_BIOME.iter().enumerate() {
                tw[t] = (0..6).map(|b| row[b] * reg.hist[b]).sum::<f64>() * element_boost(t as u8, reg.elem, reg.elem2);
            }
            if craters >= 2 {
                tw[S::ST_METEOR_CRATER as usize] = 0.0;
            }
            if lairs >= 1 || reg.danger < 0.35 {
                tw[S::ST_DEMON_LAIR as usize] = 0.0;
            } else {
                tw[S::ST_DEMON_LAIR as usize] *= 0.5 + reg.danger;
            }
            let t = weighted_pick(&tw, u) as u8;
            let (radius, vis_h) = STRUCT_SIZE[t as usize];
            let mut best: Option<(f64, usize)> = None;
            for &k in &nodes {
                let Some(v) = struct_score(t, w, k, &prom, behind(k), &p, rand01(seed, 100 + (r * 16 + c) as u64, k)) else {
                    continue;
                };
                if best.is_none_or(|b| v > b.0) {
                    let (x, z) = node_xz(k);
                    if p.spacing_ok(x, z, radius, S::CAT_STRUCTURE, t, 600.0) {
                        best = Some((v, k));
                    }
                }
            }
            if let Some((v, k)) = best {
                let tier = ((reg.danger * 2.0 + rand01(seed, 7, k) * 0.99) as u8).min(2);
                let i = p.push(k, S::CAT_STRUCTURE, t, tier, radius, vis_h, v);
                p.sites[i].element = if rand01(seed, 8, k) < 0.7 { reg.elem } else { reg.elem2 };
                p.sites[i].yaw = (hash(seed, STREAM_SITE, k as i64, 9, 0) >> 48) as u16;
                if t == S::ST_METEOR_CRATER {
                    craters += 1;
                }
                if t == S::ST_DEMON_LAIR {
                    lairs += 1;
                }
            }
        }
    }

    // ---- 4a. waypoints: one at every settlement (WP20 puts the stone in the
    // square), plus one wilderness waypoint per region.
    for &si in &settlement_idx {
        let k = p.sites[si].node;
        let wi = p.push(k, S::CAT_POI, S::POI_WAYPOINT, 1, 4.0, 5.0, 0.0);
        p.sites[wi].link = si as u16;
    }
    for r in 0..super::format::REGIONS {
        let mut best: Option<(f64, usize)> = None;
        for c in cands.iter().filter(|c| c.region == r) {
            let v = c.vis.and_count(&walk) as f64 * (0.8 + 0.4 * rand01(seed, 20, c.k));
            if best.is_none_or(|b| v > b.0) && p.dist_to_settlement(c.x, c.z) > 450.0 && p.spacing_ok(c.x, c.z, 4.0, S::CAT_POI, S::POI_WAYPOINT, 600.0) {
                best = Some((v, c.k));
            }
        }
        if let Some((v, k)) = best {
            p.push(k, S::CAT_POI, S::POI_WAYPOINT, 0, 4.0, 5.0, v);
        }
    }

    // ---- 4b. landmarks: each region's most prominent peak.
    for r in 0..super::format::REGIONS {
        let mut best: Option<(f64, usize)> = None;
        for &k in &region_nodes(r) {
            if prom[k] > 25.0 && best.is_none_or(|b| prom[k] > b.0) {
                let (x, z) = node_xz(k);
                if p.spacing_ok(x, z, 10.0, S::CAT_POI, S::POI_LANDMARK, 300.0) {
                    best = Some((prom[k], k));
                }
            }
        }
        if let Some((v, k)) = best {
            let variant = landmark_variant(w.biome[k], rand01(seed, 30, k));
            p.push(k, S::CAT_POI, S::POI_LANDMARK, variant, 10.0, 15.0, v);
        }
    }

    // ---- 4c. enemy camps
    let n_camps = libm::round(3.0 * w.spec.enemy_density) as usize;
    for r in 0..super::format::REGIONS {
        let nodes = region_nodes(r);
        for c in 0..n_camps {
            let mut best: Option<(f64, usize)> = None;
            for &k in &nodes {
                if w.slope[k] > 18.0 {
                    continue;
                }
                let (x, z) = node_xz(k);
                let v = regions[r].danger + rand01(seed, 40 + c as u64, k);
                if best.is_none_or(|b| v > b.0) && p.dist_to_settlement(x, z) > 400.0 && p.spacing_ok(x, z, 20.0, S::CAT_POI, S::POI_ENEMY_CAMP, 450.0) {
                    best = Some((v, k));
                }
            }
            if let Some((v, k)) = best {
                let size = ((regions[r].danger * 2.0 + rand01(seed, 41, k)) as u8).min(2);
                p.push(k, S::CAT_POI, S::POI_ENEMY_CAMP, size, 20.0, 6.0, v);
            }
        }
    }

    // ---- 5. coverage: "from any walkable point, at least one POI is visible
    // within roughly 800 m". Lazy greedy (CELF) over the candidates.
    let mut cover = Bits::new();
    let mut site_vis: Vec<Bits> = Vec::new();
    for s in &p.sites {
        let v = viewshed(&w.h, s.x, s.z, s.vis_h, VIS_RADIUS);
        cover.or(&v);
        site_vis.push(v);
    }
    let walk_total = walk.count().max(1);
    let mut heap: std::collections::BinaryHeap<(usize, std::cmp::Reverse<usize>)> = cands
        .iter()
        .enumerate()
        .map(|(ci, c)| (c.vis.gain(&walk, &cover), std::cmp::Reverse(ci)))
        .collect();
    let mut fill_n = 0u64;
    while let Some((g, std::cmp::Reverse(ci))) = heap.pop() {
        let uncovered = walk_total - walk.and_count(&cover);
        if (uncovered as f64) <= UNCOVERED_TARGET * walk_total as f64 || g < 4 {
            break;
        }
        let c = &cands[ci];
        let fresh = c.vis.gain(&walk, &cover);
        if let Some(&(next, _)) = heap.peek() {
            if fresh < next {
                heap.push((fresh, std::cmp::Reverse(ci)));
                continue;
            }
        }
        if p.full(c.region) || !p.spacing_ok(c.x, c.z, 10.0, 255, 255, 0.0) || p.dist_to_settlement(c.x, c.z) < 150.0 {
            continue;
        }
        let u = unit(hash(seed, STREAM_SITE ^ 0x4649, fill_n as i64, 0, 0)); // "FI"
        fill_n += 1;
        let i = if u < 0.25 {
            let tier = ((regions[c.region].danger * 2.0 + u * 2.0) as u8).min(2);
            let i = p.push(c.k, S::CAT_STRUCTURE, S::ST_RUIN, tier, 25.0, 10.0, fresh as f64);
            p.sites[i].element = regions[c.region].elem;
            i
        } else if u < 0.45 {
            let size = ((regions[c.region].danger * 2.0) as u8).min(2);
            p.push(c.k, S::CAT_POI, S::POI_ENEMY_CAMP, size, 20.0, 10.0, fresh as f64)
        } else {
            let variant = landmark_variant(w.biome[c.k], u);
            p.push(c.k, S::CAT_POI, S::POI_LANDMARK, variant, 10.0, 10.0, fresh as f64)
        };
        let v = viewshed(&w.h, p.sites[i].x, p.sites[i].z, p.sites[i].vis_h, VIS_RADIUS);
        cover.or(&v);
        site_vis.push(v);
    }
    let covered = walk.and_count(&cover);

    // Per-node count of visible sites (debug map, WP12 hints).
    let mut coverage = vec![0u8; NN];
    for v in &site_vis {
        for (k, c) in coverage.iter_mut().enumerate() {
            if v.get(k) {
                *c = c.saturating_add(1);
            }
        }
    }
    for (i, v) in site_vis.iter().enumerate() {
        p.sites[i].vis_count = v.and_count(&walk).min(65535) as u16;
    }

    // ---- names
    let g = names::grammar_index(&w.spec.name_grammar).unwrap_or(0);
    let mut name_table: Vec<String> = vec![w.spec.name.clone()];
    for (r, reg) in regions.iter_mut().enumerate() {
        let mut seq = Seq::new(seed, 0x5245_474E ^ r as u64); // "REGN"
        reg.name = name_table.len() as u16;
        name_table.push(names::region_name(g, reg.biome as usize, &mut seq));
    }
    for s in p.sites.iter_mut() {
        let mut seq = Seq::new(seed ^ s.id, 0x4E41_4D45); // "NAME"
        let name = match (s.category, s.kind) {
            (S::CAT_SETTLEMENT, _) => Some(names::settlement_name(g, &mut seq)),
            (S::CAT_POI, S::POI_WAYPOINT) if s.link != super::format::NONE16 => None,
            (S::CAT_POI, k) => Some(names::site_name(g, poi_noun(k, s.size, &mut seq), &mut seq)),
            (_, k) => Some(names::site_name(g, STRUCT_NOUN[k as usize], &mut seq)),
        };
        if let Some(n) = name {
            s.name = name_table.len() as u16;
            name_table.push(n);
        }
    }
    for reg in regions.iter_mut() {
        reg.sites = 0;
        reg.settlements = 0;
    }
    for s in &p.sites {
        let reg = &mut regions[s.region as usize];
        reg.sites = reg.sites.saturating_add(1);
        if s.category == S::CAT_SETTLEMENT {
            reg.settlements += 1;
        }
    }

    let sites = p.sites;
    w.sites = sites;
    w.regions = regions;
    w.names = name_table;
    w.coverage = coverage;
    w.coverage_frac = covered as f64 / walk_total as f64;
    w.spawn = spawn;
}

/// Peaks (highest in their 5 x 5 window), ridge crests (a local maximum
/// across one axis, on every other node), and for river bends (flow turns 90
/// degrees or more) and valley mouths (a river leaving steep ground for flat)
/// the driest bank node beside the river, since a POI never sits in water.
fn feature_nodes(w: &World, prom: &[f64], ground: &[bool]) -> Vec<usize> {
    let h = &w.h;
    let mut out = Vec::new();
    let bank = |k: usize| -> Option<usize> {
        let (i, j) = (k % N, k / N);
        let mut best: Option<usize> = None;
        for (dx, dz) in super::hydro::D8 {
            let (ni, nj) = (i as i32 + dx, j as i32 + dz);
            if ni < 0 || nj < 0 || ni >= N as i32 || nj >= N as i32 {
                continue;
            }
            let nk = idx(ni as usize, nj as usize);
            if ground[nk] && best.is_none_or(|b| w.slope[nk] < w.slope[b]) {
                best = Some(nk);
            }
        }
        best
    };
    for j in 2..N - 2 {
        for i in 2..N - 2 {
            let k = idx(i, j);
            if ground[k] {
                let mut top = true;
                for dz in -2i32..=2 {
                    for dx in -2i32..=2 {
                        if (dx != 0 || dz != 0) && h[idx((i as i32 + dx) as usize, (j as i32 + dz) as usize)] > h[k] {
                            top = false;
                        }
                    }
                }
                let ridge = (i + j) % 2 == 0
                    && prom[k] > 10.0
                    && ((h[k] > h[k - 1] && h[k] > h[k + 1]) || (h[k] > h[k - N] && h[k] > h[k + N]));
                if (top && prom[k] > 12.0) || ridge {
                    out.push(k);
                }
                continue;
            }
            if w.river_w[k] == 0 {
                continue;
            }
            let Some(d) = super::hydro::downstream(&w.flow, k) else { continue };
            let out_dir = w.flow[k] as i32;
            // The main upstream neighbor: the river node draining into k with the largest area.
            let mut up: Option<usize> = None;
            for (dx, dz) in super::hydro::D8 {
                let nk = idx((i as i32 + dx) as usize, (j as i32 + dz) as usize);
                if w.river_w[nk] > 0 && super::hydro::downstream(&w.flow, nk) == Some(k) && up.is_none_or(|u| w.acc[nk] > w.acc[u]) {
                    up = Some(nk);
                }
            }
            let bend = up.is_some_and(|u| {
                let turn = (w.flow[u] as i32 - out_dir).rem_euclid(8);
                (2..=6).contains(&turn)
            });
            let mouth = up.is_some_and(|u| mean_slope(&w.slope, u, 2) > 10.0) && mean_slope(&w.slope, d, 1) < 5.0;
            if bend || mouth {
                if let Some(b) = bank(k) {
                    out.push(b);
                }
            }
        }
    }
    out
}

/// Yaw (u16 fraction of a turn, 0 = +x, increasing toward +z) facing downhill.
fn downhill_yaw(h: &[f64], k: usize) -> u16 {
    let (i, j) = (k % N, k / N);
    let gx = h[idx((i + 1).min(N - 1), j)] - h[idx(i.saturating_sub(1), j)];
    let gz = h[idx(i, (j + 1).min(N - 1))] - h[idx(i, j.saturating_sub(1))];
    let a = libm::atan2(-gz, -gx);
    let turn = a / (2.0 * core::f64::consts::PI);
    let t = if turn < 0.0 { turn + 1.0 } else { turn };
    (t * 65536.0) as u16
}

/// Structure type affinity per biome [meadow, forest, highlands, snowpeak, badlands, wetland].
const STRUCT_BIOME: [[f64; 6]; 9] = [
    [1.0, 1.0, 1.0, 0.6, 1.0, 0.8], // ruin
    [0.8, 0.4, 1.0, 0.3, 0.6, 0.2], // watchtower
    [0.2, 0.3, 1.2, 0.6, 1.2, 0.0], // mineshaft
    [0.5, 0.6, 0.7, 1.0, 0.4, 0.5], // shrine
    [0.8, 1.0, 0.5, 0.2, 0.8, 0.4], // bandit camp
    [0.4, 0.5, 0.5, 0.4, 0.4, 0.5], // wizard tower
    [0.4, 0.1, 0.3, 0.1, 0.6, 0.0], // meteor crater
    [0.0, 0.2, 0.0, 0.0, 0.1, 1.5], // sunken temple
    [0.3, 0.5, 0.4, 0.3, 0.6, 0.6], // demon lair
];
/// (footprint radius m, visible height m) per structure type.
const STRUCT_SIZE: [(f64, f64); 9] = [
    (25.0, 8.0),
    (10.0, 18.0),
    (15.0, 6.0),
    (12.0, 8.0),
    (30.0, 6.0),
    (15.0, 30.0),
    (40.0, 4.0),
    (30.0, 10.0),
    (30.0, 10.0),
];
const STRUCT_NOUN: [&str; 9] = ["Ruins", "Watchtower", "Mine", "Shrine", "Hideout", "Sanctum", "Crater", "Temple", "Lair"];

fn element_boost(t: u8, e1: u8, e2: u8) -> f64 {
    // Element ids: fire 0, ice 1, lightning 2, earth 3, wind 4, light 5, dark 6, void 7.
    let has = |e: u8| e1 == e || e2 == e;
    match t {
        S::ST_WIZARD_TOWER if has(7) || has(2) || has(5) => 1.8,
        S::ST_SHRINE if has(5) || has(4) => 1.8,
        S::ST_DEMON_LAIR if has(6) || has(7) => 2.0,
        S::ST_MINESHAFT if has(3) || has(0) => 1.6,
        S::ST_METEOR_CRATER if has(7) => 2.0,
        _ => 1.0,
    }
}

fn struct_score(t: u8, w: &World, k: usize, prom: &[f64], behind: f64, p: &Placer, r: f64) -> Option<f64> {
    let slope = w.slope[k];
    let (x, z) = node_xz(k);
    let b = w.biome[k];
    let ds = || p.dist_to_settlement(x, z);
    let v = match t {
        S::ST_RUIN => {
            if slope > 25.0 {
                return None;
            }
            0.8 * behind + 0.4 + 0.4 * r
        }
        S::ST_WATCHTOWER => {
            if slope > 25.0 {
                return None;
            }
            (prom[k] / 40.0).clamp(0.0, 1.5) + 0.4 * r
        }
        S::ST_MINESHAFT => {
            if !(14.0..=42.0).contains(&slope) {
                return None;
            }
            1.0 + 0.5 * behind + if b == HIGHLANDS || b == BADLANDS { 0.4 } else { 0.0 } + 0.3 * r
        }
        S::ST_SHRINE => (prom[k] / 50.0).clamp(0.0, 1.5) + 0.3 * ((w.h[k] - w.sea_y) / 300.0).min(1.0) + 0.4 * r,
        S::ST_BANDIT_CAMP => {
            let d = ds();
            if slope > 15.0 || !(250.0..=1100.0).contains(&d) {
                return None;
            }
            1.0 + if b == FOREST { 0.4 } else { 0.0 } + 0.5 * r
        }
        S::ST_WIZARD_TOWER => {
            if slope > 25.0 {
                return None;
            }
            (prom[k] / 40.0).clamp(0.0, 1.5) + if ds() > 600.0 { 0.5 } else { 0.0 } + 0.4 * r
        }
        S::ST_METEOR_CRATER => {
            if slope > 8.0 || ds() < 500.0 {
                return None;
            }
            1.0 + 0.5 * r
        }
        S::ST_SUNKEN_TEMPLE => {
            if slope > 15.0 || !(w.dist_fresh[k] < 130.0 || b == WETLAND) {
                return None;
            }
            1.0 + if b == WETLAND { 0.5 } else { 0.0 } + 0.4 * r
        }
        _ => {
            // Demon lair: hidden hollows far from towns.
            if slope > 30.0 || ds() < 700.0 {
                return None;
            }
            1.0 + behind + (-prom[k] / 30.0).clamp(0.0, 0.8) + 0.4 * r
        }
    };
    Some(v)
}

/// Landmark variant (site size byte): 0 standing stones, 1 great tree,
/// 2 stone arch, 3 monolith, 4 giant bones, 5 crystal outcrop, 6 statue,
/// 7 hot spring.
fn landmark_variant(biome: u8, u: f64) -> u8 {
    let opts: &[u8] = match biome {
        MEADOW => &[0, 1, 6, 3],
        FOREST => &[1, 0, 6, 5],
        HIGHLANDS => &[2, 3, 0, 5],
        SNOWPEAK => &[3, 5, 7, 6],
        BADLANDS => &[4, 2, 3, 5],
        _ => &[1, 7, 6, 0],
    };
    opts[((u * opts.len() as f64) as usize).min(opts.len() - 1)]
}

const LANDMARK_NOUN: [&str; 8] = ["Stones", "Elder Tree", "Arch", "Monolith", "Bones", "Crystals", "Colossus", "Springs"];

fn poi_noun(kind: u8, size: u8, seq: &mut Seq) -> &'static str {
    match kind {
        S::POI_TOWER => "Spire",
        S::POI_CAVE_MOUTH => seq.pick(&["Hollow", "Grotto", "Deep", "Maw", "Cavern"]),
        S::POI_WAYPOINT => "Waystone",
        S::POI_LANDMARK => LANDMARK_NOUN[(size as usize).min(7)],
        _ => seq.pick(&["Camp", "Warren", "Den", "Roost"]),
    }
}
