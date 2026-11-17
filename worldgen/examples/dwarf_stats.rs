//! Dwarven halls report (CR 043): chambers, passages, settlements laid out in
//! them (buildings, props, NPCs), decoration counts by kind.
//! `cargo run -p worldgen --release --example dwarf_stats -- 20261108 [seed...]`

use worldgen::atlas::format::{site, Atlas};
use worldgen::vertical::{self, ck, dk, rk, LAYER_UNDER};

fn main() {
    let seeds: Vec<u64> = std::env::args().skip(1).filter_map(|s| s.parse().ok()).collect();
    let seeds = if seeds.is_empty() { vec![20261108] } else { seeds };
    for seed in seeds {
        let spec = worldgen::spec::spec_from_seed(seed);
        let bytes = worldgen::atlas::build(&spec, seed).unwrap();
        let a = Atlas::parse(&bytes).unwrap();
        let w = vertical::world(&a).unwrap();
        let p = &w.plan;
        let t = worldgen::town::build(&a).unwrap();
        println!("seed {seed}");
        for (i, c) in p.chambers.iter().enumerate().filter(|(_, c)| c.kind >= ck::DWARF_CAMP) {
            println!("  chamber {i} {:<11} ({:6.0}, {:6.0}) rx {:4.0} floor {:6.1} height {:5.1} site {}", ck::NAMES[c.kind as usize], c.x, c.z, c.rx, c.floor, c.height, c.site);
        }
        println!("  secret passages {}", p.corridors.iter().filter(|r| r.kind == rk::SECRET).count());
        for (si, st) in t.settlements.iter().enumerate() {
            let s = a.site(st.site as usize);
            if s.layer != LAYER_UNDER {
                continue;
            }
            let roles: Vec<usize> = (0..9).map(|r| t.buildings[st.building_first as usize..(st.building_first + st.building_count) as usize].iter().filter(|b| b.role == r).count()).collect();
            println!(
                "  settlement {si} site {} size {} buildings {} (roles {:?}) props {} npcs {} walled {}",
                st.site, st.size, st.building_count, roles, st.prop_count, st.npc_count, st.walled
            );
            let names: Vec<String> = (st.npc_first..st.npc_first + st.npc_count).take(6).map(|n| t.names[t.npcs[n as usize].name as usize].clone()).collect();
            println!("    npcs {}", names.join(", "));
        }
        let mut counts = [0usize; dk::COUNT as usize];
        for d in &p.decos {
            counts[d.kind as usize] += 1;
        }
        let names = ["crystal", "spire", "mushroom", "flora", "stalactite", "stalagmite", "vines", "waterfall", "lavafall", "vent", "obsidian", "embers", "campfire", "tent", "portal", "lift", "palace", "activity", "tree", "rock", "pillar", "skyfall", "cloud", "geyser", "shrine", "gate", "lightshaft", "lantern", "minecart", "rails", "support", "bones", "glowworms", "chest", "tablet", "brazier", "dwarf_door", "dwarf_pillar", "ore_pile", "runes", "statue", "banner", "secret_door", "throne", "forgeglow", "collapse"];
        println!("  decos {} columns {} veins {}: {}", p.decos.len(), p.columns.len(), p.veins.len(), (28..dk::COUNT as usize).map(|k| format!("{} {}", names[k], counts[k])).collect::<Vec<_>>().join(", "));
        println!("  lights flagged: {}", p.decos.iter().filter(|d| d.flags & 1 != 0 && d.layer == LAYER_UNDER).count());
        let _ = site::CAT_POI;
    }
}
