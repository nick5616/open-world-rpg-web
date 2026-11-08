//! Towns invariants (WP20) on several worlds: every region has a
//! settlement; every settlement has its required buildings (inn, forge,
//! stall, ward garden), townsfolk (merchant, blacksmith, innkeeper, bounty
//! keeper) and square furniture (bounty board, well, forge, anvil) and a
//! building count in the spec's range; stable ids are unique; every box is
//! finite with positive extents and unit (cos, sin); building floors are
//! above the ground under them; the whole layer generates far inside the
//! 60 s budget.

use std::collections::HashSet;
use std::time::Instant;
use worldgen::atlas::{self, format::Atlas};
use worldgen::town::{self, nrole, pk, role};
use worldgen::{ground, spec};

fn check(seed: u64) {
    let s = spec::spec_from_seed(seed);
    let bytes = atlas::build(&s, seed).unwrap();
    let a = Atlas::parse(&bytes).unwrap();
    let t0 = Instant::now();
    let t = town::build(&a).unwrap();
    let ms = t0.elapsed().as_secs_f64() * 1e3;
    assert!(ms < 60_000.0, "seed {seed}: towns took {ms} ms");

    let regions: HashSet<u8> = t.settlements.iter().map(|s| s.region).collect();
    assert_eq!(regions.len(), 16, "seed {seed}: settlements in {} regions", regions.len());

    let ranges = [(4usize, 8usize), (10, 25), (30, 60)];
    for st in &t.settlements {
        let bs = &t.buildings[st.building_first as usize..(st.building_first + st.building_count) as usize];
        for r in [role::INN, role::FORGE, role::STALL, role::GARDEN] {
            assert!(
                bs.iter().any(|b| b.role == r),
                "seed {seed} settlement {}: no {}",
                st.site,
                role::NAMES[r as usize]
            );
        }
        let n = bs.iter().filter(|b| b.role != role::STALL && b.role != role::GARDEN).count();
        let (lo, hi) = ranges[st.size as usize];
        assert!(n >= lo && n <= hi, "seed {seed} settlement {}: {n} buildings, spec {lo}-{hi}", st.site);
        let npcs = &t.npcs[st.npc_first as usize..(st.npc_first + st.npc_count) as usize];
        for r in [nrole::MERCHANT, nrole::BLACKSMITH, nrole::INNKEEPER, nrole::BOUNTY] {
            assert!(npcs.iter().any(|p| p.role == r), "seed {seed} settlement {}: no npc role {r}", st.site);
        }
        let props = &t.props[st.prop_first as usize..(st.prop_first + st.prop_count) as usize];
        for k in [pk::BOARD, pk::WELL, pk::FORGE, pk::ANVIL] {
            assert!(props.iter().any(|p| p.kind == k), "seed {seed} settlement {}: no prop kind {k}", st.site);
        }
    }

    let mut ids = HashSet::new();
    for id in t
        .buildings
        .iter()
        .map(|b| b.id)
        .chain(t.props.iter().map(|p| p.id))
        .chain(t.npcs.iter().map(|n| n.id))
        .chain(t.pieces.iter().map(|p| p.id))
    {
        assert!(ids.insert(id), "seed {seed}: duplicate stable id {id:016x}");
    }

    for (i, b) in t.boxes.iter().enumerate() {
        for v in [b.cx, b.cz, b.c, b.s, b.hx, b.hz, b.y0, b.y1, b.y2] {
            assert!(v.is_finite(), "seed {seed}: box {i} not finite");
        }
        assert!(b.hx > 0.0 && b.hz > 0.0, "seed {seed}: box {i} empty");
        assert!(((b.c * b.c + b.s * b.s) - 1.0).abs() < 1e-5, "seed {seed}: box {i} axis not unit");
        assert!(b.y0 < b.y1.max(b.y2), "seed {seed}: box {i} upside down");
    }

    // Floors stand above the ground at the building's centre and corners.
    for b in t.buildings.iter().filter(|b| b.floors > 0) {
        for (u, v) in [(0.0, 0.0), (-0.95, -0.95), (0.95, -0.95), (0.95, 0.95), (-0.95, 0.95)] {
            let (lu, lv) = (u * b.hx, v * b.hz);
            let x = b.x + lu * b.c - lv * b.s;
            let z = b.z + lu * b.s + lv * b.c;
            let g = ground::collision_height(&a, x, z);
            assert!(
                b.floor_y as f32 as f64 >= g - 1e-4,
                "seed {seed}: building {:016x} floor {} under ground {g}",
                b.id,
                b.floor_y
            );
        }
    }
    println!(
        "[towns] seed {seed}: {} settlements, {} buildings, {} boxes, {} npcs, {} structures in {ms:.0} ms",
        t.settlements.len(),
        t.buildings.len(),
        t.boxes.len(),
        t.npcs.len(),
        t.structures.len()
    );
}

#[test]
fn towns_invariants() {
    // Debug builds are slow (about 10x): two worlds there, more in release.
    let seeds: &[u64] = if cfg!(debug_assertions) {
        &[20261108, 99]
    } else {
        &[20261108, 7, 1234, 99, 42, 2026]
    };
    for &s in seeds {
        check(s);
    }
}
