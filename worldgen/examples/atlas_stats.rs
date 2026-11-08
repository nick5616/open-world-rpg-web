//! Native sanity report for an atlas: `cargo run -p worldgen --release --example atlas_stats -- 42`.
//! Prints biome mix, site counts, the 800 m coverage and native timings. The
//! authoritative timings are the wasm ones from the browser harness.

use std::time::Instant;
use worldgen::atlas::format::{param, site, Atlas, NN};
use worldgen::{atlas, chunk, spec};

fn main() {
    let seed: u64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(42);
    let s = spec::spec_from_seed(seed);
    println!("seed {seed}: {} (grammar {}, palette {})", s.name, s.name_grammar, s.palette);
    let t = Instant::now();
    let bytes = atlas::build(&s, seed).expect("atlas");
    println!("atlas: {} bytes in {:.1} ms, hash {:016x}", bytes.len(), t.elapsed().as_secs_f64() * 1e3, worldgen::hash_bytes(&bytes));
    let a = Atlas::parse(&bytes).unwrap();
    let mut biomes = [0usize; 6];
    let mut land = 0;
    let mut rivers = 0;
    let mut lakes = 0;
    for k in 0..NN {
        let p = a.nodep(k);
        if p[3] & 1 == 0 {
            land += 1;
            biomes[a.biome(k) as usize] += 1;
        }
        if a.river(k) > 0 {
            rivers += 1;
        }
        if p[3] & 2 != 0 {
            lakes += 1;
        }
    }
    println!("land nodes {land} ({:.1}%), river nodes {rivers}, lake nodes {lakes}", 100.0 * land as f64 / NN as f64);
    for (b, n) in spec::BIOME_NAMES.iter().zip(biomes) {
        println!("  {b:10} {:5.1}%", 100.0 * n as f64 / land as f64);
    }
    let mut counts = std::collections::BTreeMap::new();
    for i in 0..a.site_count() {
        let st = a.site(i);
        let name = match st.category {
            site::CAT_POI => site::POI_NAMES[st.kind as usize].to_string(),
            site::CAT_SETTLEMENT => format!("settlement:{}", site::SETTLEMENT_SIZES[st.size as usize]),
            _ => site::STRUCTURE_NAMES[st.kind as usize].to_string(),
        };
        *counts.entry(name).or_insert(0) += 1;
    }
    println!("sites: {}", a.site_count());
    for (k, v) in counts {
        println!("  {k:22} {v}");
    }
    println!("coverage (walkable nodes seeing a POI within 800 m): {:.1}%", 100.0 * a.param(param::COVERAGE_800));
    println!("spawn: ({:.0}, {:.0})", a.param(param::SPAWN_X), a.param(param::SPAWN_Z));
    let t = Instant::now();
    let mut n = 0;
    let mut recs = 0usize;
    for cz in (0..64).step_by(4) {
        for cx in (0..64).step_by(4) {
            let c = chunk::build(&a, cx, cz, 0).unwrap();
            recs += u16::from_le_bytes([c[56], c[57]]) as usize;
            n += 1;
        }
    }
    let dt = t.elapsed().as_secs_f64() * 1e3 / n as f64;
    println!("native chunk lod0: {dt:.2} ms avg over {n} chunks, {:.0} scatter/chunk", recs as f64 / n as f64);
}
