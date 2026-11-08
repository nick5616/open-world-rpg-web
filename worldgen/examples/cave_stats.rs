//! Native sanity report for the cave pass (WP09):
//!   cargo run -p worldgen --release --example cave_stats -- 20261108
//! Prints every system (chambers, depth, openings, veins) and times
//! cave_build over every cell a system touches.

use std::time::Instant;
use worldgen::atlas::{self, format::Atlas};
use worldgen::cave::{self, cell, veins};

fn main() {
    let seed: u64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(20261108);
    let spec = worldgen::spec::spec_from_seed(seed);
    let bytes = atlas::build(&spec, seed).unwrap();
    let a = Atlas::parse(&bytes).unwrap();
    let t0 = Instant::now();
    let c = cave::world(&a).unwrap();
    let w = &c.world;
    println!(
        "seed {seed} ({}): caveDensity {:.2} caveMaxDepth {} gemRarityCurve {} oreAbundance {:.2}; {} systems in {:.1} ms, graph {} B",
        spec.name,
        spec.cave_density,
        spec.cave_max_depth,
        spec.gem_rarity_curve,
        spec.ore_abundance,
        w.systems.len(),
        t0.elapsed().as_secs_f64() * 1e3,
        c.graph.len()
    );
    let mut mats = [0usize; 16];
    let mut cells = Vec::new();
    for s in &w.systems {
        let sinks = s.openings.iter().filter(|o| o.kind == 1).count();
        println!(
            "  sys {:2} site {:3} mouth ({:.0}, {:.0}, {:.0}) chambers {:2} tunnels {:2} deepest {:.0} m openings {} (sinkholes {}) veins {:2} decos {:2} r_mask {:.1}",
            s.index,
            s.site_index,
            s.mouth_x,
            s.mouth_y,
            s.mouth_z,
            s.chambers.len(),
            s.tunnels.len(),
            s.max_depth,
            s.openings.len(),
            sinks,
            s.veins.len(),
            s.decos.len(),
            s.openings[0].r_mask
        );
        for v in &s.veins {
            mats[(v.kind as usize) * 8 + (v.material as usize).min(7)] += 1;
        }
        let (x0, x1) = ((s.bbox[0] / 64.0).floor() as i32, (s.bbox[3] / 64.0).floor() as i32);
        let (y0, y1) = ((s.bbox[1] / 32.0).floor() as i32, (s.bbox[4] / 32.0).floor() as i32);
        let (z0, z1) = ((s.bbox[2] / 64.0).floor() as i32, (s.bbox[5] / 64.0).floor() as i32);
        for cy in y0..=y1 {
            for cz in z0..=z1 {
                for cx in x0..=x1 {
                    if cell::valid_cell(cx, cy, cz) {
                        cells.push((cx, cy, cz));
                    }
                }
            }
        }
    }
    println!("  ores: {:?}", (0..6).map(|i| format!("{}={}", veins::ORE_NAMES[i], mats[i])).collect::<Vec<_>>());
    println!("  gems: {:?}", (0..8).map(|i| format!("{}={}", veins::GEM_NAMES[i], mats[8 + i])).collect::<Vec<_>>());
    cells.sort();
    cells.dedup();
    let mut ms = Vec::new();
    let (mut tris, mut nonempty, mut maxv) = (0usize, 0usize, 0usize);
    for &(cx, cy, cz) in &cells {
        let t = Instant::now();
        let b = cell::build(&a, w, cx, cy, cz, &[]).unwrap();
        ms.push(t.elapsed().as_secs_f64() * 1e3);
        let nt = u32::from_le_bytes([b[32], b[33], b[34], b[35]]) as usize;
        let nv = u32::from_le_bytes([b[28], b[29], b[30], b[31]]) as usize;
        if nt > 0 {
            nonempty += 1;
        }
        tris += nt;
        maxv = maxv.max(nv);
    }
    ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mean = ms.iter().sum::<f64>() / ms.len().max(1) as f64;
    println!(
        "  cells {} (with mesh {}), tris {} (max verts {}), native ms mean {:.2} p95 {:.2} max {:.2}",
        cells.len(),
        nonempty,
        tris,
        maxv,
        mean,
        ms[(ms.len() as f64 * 0.95) as usize % ms.len().max(1)],
        ms.last().copied().unwrap_or(0.0)
    );
}
