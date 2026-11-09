//! POI spacing report (playtest 1 "less spread out"): how far a walker on
//! dry land is from the nearest thing to see, and how close settlements are.
//!
//!   cargo run -p worldgen --release --example poi_density -- 20261108 7 1234
//!
//! "Something to see" = any atlas site; the second line counts only things
//! built in the world (no waypoint stones; genVersion 1 drew no landmarks
//! or enemy camps, genVersion 2 builds both as structures) (settlement, structure, tower, cave
//! mouth, waypoint, landmark, enemy camp). Distances are to the site's edge
//! (centre distance minus its footprint radius, at least 0), sampled on a
//! 16 m grid over dry land (no sea, lake or river node nearby). Also prints
//! sites per km^2 of land, nearest-neighbour spacing between sites and
//! between settlements, and the share of land within 150 / 250 / 400 m.

use worldgen::atlas::format::{flag, idx, site, Atlas, N, RES};
use worldgen::{atlas, spec};

fn pct(v: &[f64], p: f64) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    let i = ((v.len() - 1) as f64 * p).round() as usize;
    v[i]
}

fn main() {
    let seeds: Vec<u64> = std::env::args().skip(1).filter_map(|s| s.parse().ok()).collect();
    let seeds = if seeds.is_empty() { vec![20261108] } else { seeds };
    for seed in seeds {
        let s = spec::spec_from_seed(seed);
        let bytes = atlas::build(&s, seed).expect("atlas");
        let a = Atlas::parse(&bytes).unwrap();
        let sites: Vec<_> = (0..a.site_count()).map(|i| a.site(i)).collect();
        let dry = |x: f64, z: f64| -> bool {
            let i = ((x / RES).round() as usize).min(N - 1);
            let j = ((z / RES).round() as usize).min(N - 1);
            a.nodep(idx(i, j))[3] & (flag::SEA | flag::LAKE | flag::RIVER) == 0
        };
        let mut d_all = Vec::new();
        let mut d_minor = Vec::new();
        let mut x = 8.0;
        while x < 4096.0 {
            let mut z = 8.0;
            while z < 4096.0 {
                if dry(x, z) {
                    let mut best = f64::MAX;
                    let mut best_minor = f64::MAX;
                    for st in &sites {
                        let d = (((st.x - x).powi(2) + (st.z - z).powi(2)).sqrt() - st.radius).max(0.0);
                        best = best.min(d);
                        // Built things only: no waypoint stones, and in
                        // genVersion 1 landmarks and enemy camps were map
                        // markers with nothing drawn in the world.
                        let waypoint = st.category == site::CAT_POI && st.kind == site::POI_WAYPOINT;
                        let unbuilt_v1 = st.category == site::CAT_POI && (st.kind == site::POI_LANDMARK || st.kind == site::POI_ENEMY_CAMP);
                        if !waypoint && (worldgen::GEN_VERSION >= 2 || !unbuilt_v1) {
                            best_minor = best_minor.min(d);
                        }
                    }
                    d_all.push(best);
                    d_minor.push(best_minor);
                }
                z += 16.0;
            }
            x += 16.0;
        }
        d_all.sort_by(f64::total_cmp);
        d_minor.sort_by(f64::total_cmp);
        let land_km2 = d_all.len() as f64 * 16.0 * 16.0 / 1e6;
        let within = |v: &[f64], m: f64| 100.0 * v.iter().filter(|&&d| d <= m).count() as f64 / v.len().max(1) as f64;
        let mut by_kind = std::collections::BTreeMap::new();
        for st in &sites {
            let name = match st.category {
                site::CAT_POI => site::POI_NAMES[st.kind as usize].to_string(),
                site::CAT_SETTLEMENT => format!("settlement:{}", site::SETTLEMENT_SIZES[st.size as usize]),
                _ => site::STRUCTURE_NAMES[st.kind as usize].to_string(),
            };
            *by_kind.entry(name).or_insert(0) += 1;
        }
        let nn = |pred: &dyn Fn(&worldgen::atlas::format::SiteRec) -> bool| -> Vec<f64> {
            let pick: Vec<_> = sites.iter().filter(|s| pred(s)).collect();
            let mut v: Vec<f64> = pick
                .iter()
                .enumerate()
                .map(|(i, p)| {
                    pick.iter()
                        .enumerate()
                        .filter(|(j, _)| *j != i)
                        .map(|(_, q)| ((p.x - q.x).powi(2) + (p.z - q.z).powi(2)).sqrt())
                        .fold(f64::MAX, f64::min)
                })
                .collect();
            v.sort_by(f64::total_cmp);
            v
        };
        let nn_all = nn(&|s| !(s.category == site::CAT_POI && s.kind == site::POI_WAYPOINT && s.size == 1));
        let nn_set = nn(&|s| s.category == site::CAT_SETTLEMENT);
        println!("seed {seed} \"{}\" genVersion {}", s.name, worldgen::GEN_VERSION);
        println!(
            "  sites {} on {:.2} km2 of dry land: {:.1} sites/km2",
            sites.len(),
            land_km2,
            sites.len() as f64 / land_km2
        );
        println!("  by kind: {}", by_kind.iter().map(|(k, v)| format!("{k} {v}")).collect::<Vec<_>>().join(", "));
        println!(
            "  walker -> nearest site edge (m): p50 {:.0}, p75 {:.0}, p90 {:.0}, p99 {:.0}, max {:.0}; within 150 m {:.1}%, 250 m {:.1}%, 400 m {:.1}%",
            pct(&d_all, 0.5),
            pct(&d_all, 0.75),
            pct(&d_all, 0.9),
            pct(&d_all, 0.99),
            d_all.last().copied().unwrap_or(0.0),
            within(&d_all, 150.0),
            within(&d_all, 250.0),
            within(&d_all, 400.0)
        );
        println!(
            "  walker -> nearest BUILT thing (no waypoint stones; gv1 drew no landmarks/enemy camps) (m): p50 {:.0}, p75 {:.0}, p90 {:.0}, p99 {:.0}, max {:.0}; within 150 m {:.1}%, 250 m {:.1}%",
            pct(&d_minor, 0.5),
            pct(&d_minor, 0.75),
            pct(&d_minor, 0.9),
            pct(&d_minor, 0.99),
            d_minor.last().copied().unwrap_or(0.0),
            within(&d_minor, 150.0),
            within(&d_minor, 250.0)
        );
        println!(
            "  site nearest-neighbour spacing (m, settlement waypoints excluded): p10 {:.0}, p50 {:.0}, p90 {:.0}",
            pct(&nn_all, 0.1),
            pct(&nn_all, 0.5),
            pct(&nn_all, 0.9)
        );
        println!(
            "  settlements {}: nearest-neighbour spacing p10 {:.0}, p50 {:.0}, p90 {:.0}, max {:.0}",
            nn_set.len(),
            pct(&nn_set, 0.1),
            pct(&nn_set, 0.5),
            pct(&nn_set, 0.9),
            nn_set.last().copied().unwrap_or(0.0)
        );
        println!("  coverage (800 m rule): {:.2}%", 100.0 * a.param(worldgen::atlas::format::param::COVERAGE_800));
    }
}
