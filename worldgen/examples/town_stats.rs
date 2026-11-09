//! Native report for the towns layer (WP20):
//! `cargo run -p worldgen --release --example town_stats -- 20261108`.
//! Settlements per region and size, buildings per settlement against the
//! spec's ranges, roads, bridges, signposts, structures, NPCs, buffer size
//! and timings. The authoritative timings are the wasm ones (golden run).

use std::time::Instant;
use worldgen::atlas::format::{site, Atlas};
use worldgen::town::{self, role};
use worldgen::{atlas, spec};

fn main() {
    let seeds: Vec<u64> = std::env::args().skip(1).filter_map(|s| s.parse().ok()).collect();
    let seeds = if seeds.is_empty() { vec![20261108] } else { seeds };
    for seed in seeds {
        let s = spec::spec_from_seed(seed);
        let bytes = atlas::build(&s, seed).expect("atlas");
        let a = Atlas::parse(&bytes).unwrap();
        let t0 = Instant::now();
        let t = town::build(&a).expect("towns");
        let build_ms = t0.elapsed().as_secs_f64() * 1e3;
        let buf = town::buf::serialize(&a, &t);
        println!(
            "seed {seed} \"{}\": towns built in {build_ms:.1} ms native, buffer {} bytes, hash {:016x}",
            s.name,
            buf.len(),
            worldgen::hash_bytes(&buf)
        );
        let mut per_region = [0usize; 16];
        for st in &t.settlements {
            per_region[st.region as usize] += 1;
        }
        println!(
            "  settlements {} per region {:?} (min {})",
            t.settlements.len(),
            per_region,
            per_region.iter().min().unwrap()
        );
        let ranges = [(4, 8), (10, 25), (30, 60)];
        let mut off = 0;
        for st in &t.settlements {
            let b0 = st.building_first as usize;
            let bs = &t.buildings[b0..b0 + st.building_count as usize];
            let houses = bs.iter().filter(|b| b.role != role::STALL && b.role != role::GARDEN).count();
            let (lo, hi) = ranges[st.size as usize];
            let ok = houses >= lo && houses <= hi;
            if !ok {
                off += 1;
            }
            let roles: Vec<&str> = [role::INN, role::FORGE, role::STALL, role::GARDEN]
                .iter()
                .filter(|r| !bs.iter().any(|b| b.role == **r))
                .map(|r| role::NAMES[*r as usize])
                .collect();
            println!(
                "  {:>3} {:7} r={:>3.0} style={} buildings {:>2} (spec {lo}-{hi}{}) npcs {:>2} props {:>3} boxes {:>4} missing {:?}",
                st.site,
                site::SETTLEMENT_SIZES[st.size as usize],
                st.radius,
                town::kit::STYLE_NAMES[st.style as usize],
                houses,
                if ok { "" } else { " OUT" },
                st.npc_count,
                st.prop_count,
                st.box_count,
                roles
            );
        }
        let roads: Vec<_> = t.roads.iter().filter(|r| r.class == 0).collect();
        // Compactness (playtest 1 "too spread out, even in the towns"), per
        // size: mean distance of a building from the centre, mean gap to the
        // nearest other building (outline to outline, approximated by the
        // centre distance minus both half diagonals), farthest building.
        for size in 0..3u8 {
            let (mut n, mut dsum, mut gsum, mut far) = (0usize, 0.0, 0.0, 0.0f64);
            for st in t.settlements.iter().filter(|s| s.size == size) {
                let bs = &t.buildings[st.building_first as usize..(st.building_first + st.building_count) as usize];
                for (i, b) in bs.iter().enumerate() {
                    let d = ((b.x - st.x).powi(2) + (b.z - st.z).powi(2)).sqrt();
                    let rb = (b.hx * b.hx + b.hz * b.hz).sqrt();
                    let gap = bs
                        .iter()
                        .enumerate()
                        .filter(|(j, _)| *j != i)
                        .map(|(_, o)| ((o.x - b.x).powi(2) + (o.z - b.z).powi(2)).sqrt() - rb - (o.hx * o.hx + o.hz * o.hz).sqrt())
                        .fold(f64::MAX, f64::min);
                    n += 1;
                    dsum += d;
                    gsum += gap.max(0.0);
                    far = far.max(d);
                }
            }
            if n > 0 {
                println!(
                    "  {}: {n} buildings, mean distance from the centre {:.1} m, mean gap to the nearest building {:.1} m, farthest {:.0} m",
                    ["hamlets", "villages", "towns"][size as usize],
                    dsum / n as f64,
                    gsum / n as f64,
                    far
                );
            }
        }
        let paths: Vec<_> = t.roads.iter().filter(|r| r.class == worldgen::town::paths::CLASS_PATH).collect();
        println!(
            "  footpaths {} ({:.2} km), from doors {}, joining another path {}",
            paths.len(),
            paths.iter().map(|r| r.length).sum::<f64>() / 1000.0,
            paths.iter().filter(|r| r.from != 0xFFFF).count(),
            paths.iter().filter(|r| r.to != 0xFFFF).count()
        );
        let mut found = [0usize; 4];
        for b in &t.buildings {
            if b.floors > 0 {
                found[match (b.flags & 4 != 0, b.flags & 64 != 0, b.flags & 128 != 0) {
                    (true, _, _) => 3,
                    (_, true, _) => 1,
                    (_, _, true) => 2,
                    _ => 0,
                }] += 1;
            }
        }
        println!(
            "  foundations: plinth {}, stepped {}, posts {}, stilts {}",
            found[0], found[1], found[2], found[3]
        );
        println!(
            "  roads {} ({:.1} km), streets {}, bridges {}, signposts {}, settlements outside spec range {off}",
            roads.len(),
            roads.iter().map(|r| r.length).sum::<f64>() / 1000.0,
            t.roads.len() - roads.len() - paths.len(),
            t.bridges.len(),
            t.signs.len()
        );
        let mut kinds = [0usize; 11]; // 9 atlas structure kinds, landmark, enemy camp
        for s in &t.structures {
            kinds[s.kind as usize] += 1;
        }
        println!(
            "  structures {} {:?}, pieces {}, buildings {}, boxes {}, props {}, npcs {}, veins {}",
            t.structures.len(),
            kinds,
            t.pieces.len(),
            t.buildings.len(),
            t.boxes.len(),
            t.props.len(),
            t.npcs.len(),
            t.veins.len()
        );
    }
}
