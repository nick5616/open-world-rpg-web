//! Vertical world report: archipelagos, islands, sky towns, palaces, updrafts,
//! tunnel entrances, caverns, Depths, timings.
//! `cargo run -p worldgen --release --example vertical_stats -- 20261108 [seed...]`

use std::time::Instant;
use worldgen::atlas::format::{site, Atlas};
use worldgen::vertical::{self, ck, field, ik, tile, LAYER_DEPTHS, LAYER_SKY, LAYER_UNDER};

fn main() {
    let seeds: Vec<u64> = std::env::args().skip(1).filter_map(|s| s.parse().ok()).collect();
    let seeds = if seeds.is_empty() { vec![20261108] } else { seeds };
    for seed in seeds {
        let spec = worldgen::spec::spec_from_seed(seed);
        let t0 = Instant::now();
        let bytes = worldgen::atlas::build(&spec, seed).unwrap();
        let t_atlas = t0.elapsed();
        let a = Atlas::parse(&bytes).unwrap();
        let t1 = Instant::now();
        let w = vertical::world(&a).unwrap();
        let t_plan = t1.elapsed();
        let p = &w.plan;
        println!("seed {seed}: atlas {:.0} ms, hash {:016x}, vertical plan {:.0} ms, descriptor {} bytes", t_atlas.as_secs_f64() * 1e3, worldgen::hash_bytes(&bytes), t_plan.as_secs_f64() * 1e3, w.desc.len());
        println!("  sites: {} base + {} vertical", p.base_sites, a.site_count() - p.base_sites);
        for i in p.base_sites..a.site_count() {
            let s = a.site(i);
            let kind = match s.category {
                site::CAT_POI => site::POI_NAMES[s.kind as usize],
                site::CAT_SETTLEMENT => "settlement",
                _ => site::STRUCTURE_NAMES[s.kind as usize],
            };
            println!("    #{i:<4} layer {} {:<12} ({:7.1}, {:7.1}, {:7.1}) r {:5.1}", s.layer, kind, s.x, s.y, s.z, s.radius);
        }
        println!("  archipelagos {}", p.archs.len());
        for ar in &p.archs {
            println!("    ({:6.0}, {:6.0}) r {:4.0} base {:4.0} clouds {:4.0} islands {} town-lift {}", ar.x, ar.z, ar.r, ar.base, ar.cloud_y, ar.islands, ar.town != 0xFFFF);
        }
        let mut kinds = [0usize; 6];
        for i in &p.islands {
            kinds[i.kind as usize] += 1;
        }
        println!("  islands {}: {}", p.islands.len(), (0..6).map(|k| format!("{} {}", ik::NAMES[k], kinds[k])).collect::<Vec<_>>().join(", "));
        println!("  updrafts {}: lifts {}, columns {}, geysers {}, currents {}", p.updrafts.len(),
            p.updrafts.iter().filter(|u| u.kind == vertical::uk::LIFT).count(),
            p.updrafts.iter().filter(|u| u.kind == vertical::uk::COLUMN).count(),
            p.updrafts.iter().filter(|u| u.kind == vertical::uk::GEYSER).count(),
            p.updrafts.iter().filter(|u| u.kind == vertical::uk::CURRENT).count());
        for c in &p.chambers {
            let l = if c.layer == LAYER_UNDER { "under" } else { "depths" };
            println!("  chamber {l:<6} {:<8} ({:6.0}, {:6.0}) rx {:4.0} rz {:4.0} floor {:6.1} height {:5.1} lake {}", ck::NAMES[c.kind as usize], c.x, c.z, c.rx, c.rz, c.floor, c.height, c.lake > -9999.0);
        }
        for r in &p.corridors {
            let len: f64 = r.pts.windows(2).map(|w| ((w[1][0] - w[0][0]).powi(2) + (w[1][2] - w[0][2]).powi(2)).sqrt()).sum();
            println!("  corridor layer {} kind {} pts {} length {:5.0} m, y {:6.1} -> {:6.1}", r.layer, r.kind, r.pts.len(), len, r.pts[0][1], r.pts.last().unwrap()[1]);
        }
        println!("  openings {}, shafts {}, columns {}, decos {}, veins {}", p.openings.len(), p.shafts.len(), p.columns.len(), p.decos.len(), p.veins.len());
        let mut dom = [0usize; 3];
        for (l, d) in dom.iter_mut().enumerate() {
            for cz in 0..64 {
                for cx in 0..64 {
                    if p.domain(l as u8 + 1, cx, cz) {
                        *d += 1;
                    }
                }
            }
        }
        println!("  domain chunks: sky {}, under {}, depths {}", dom[0], dom[1], dom[2]);
        // Tile timing over every domain chunk of each layer at LOD 0 and 2.
        for (layer, name) in [(LAYER_SKY, "sky"), (LAYER_UNDER, "under"), (LAYER_DEPTHS, "depths")] {
            let mut n = 0;
            let t = Instant::now();
            let mut max = 0.0f64;
            for cz in 0..64 {
                for cx in 0..64 {
                    if !p.domain(layer, cx, cz) || n >= 60 {
                        continue;
                    }
                    let t2 = Instant::now();
                    tile::build(&a, p, layer, cx as i32, cz as i32, 0).unwrap();
                    max = max.max(t2.elapsed().as_secs_f64() * 1e3);
                    n += 1;
                }
            }
            if n > 0 {
                println!("  {name} lod0 tile: mean {:.2} ms, max {:.2} ms over {n}", t.elapsed().as_secs_f64() * 1e3 / n as f64, max);
            }
        }
        // Sample: first chamber centre and its tunnel mouth.
        if let Some(c) = p.chambers.first() {
            let s = field::under_at(p, c.layer, c.x, c.z, &mut |_, _| 0.0);
            println!("  chamber 0 centre: floor {:.1} ceiling {:.1} water {:.1}", s.a, s.b, s.w);
        }
    }
}
