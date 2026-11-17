//! The dwarves (CR 043, genVersion 4) on several worlds: every world has a
//! stronghold with its lower halls and camps; each dwarven chamber has air
//! at its centre and a continuous walkable secret passage from the network
//! (floor, air above it, every sample connected within walking slope);
//! every settlement in one has dwarven style, townsfolk and a waypoint site;
//! the genVersion 3 vertical content keeps its indices (chambers and
//! corridors of kinds before 6 come first, sites keep their order).

use worldgen::atlas::{self, format::{site, Atlas}};
use worldgen::town::{self, kit};
use worldgen::vertical::{self, ck, field, rk, LAYER_UNDER};
use worldgen::spec;

fn check(seed: u64) {
    let s = spec::spec_from_seed(seed);
    let bytes = atlas::build(&s, seed).unwrap();
    let a = Atlas::parse(&bytes).unwrap();
    let w = vertical::world(&a).unwrap();
    let p = &w.plan;
    let dw: Vec<usize> = (0..p.chambers.len()).filter(|&i| p.chambers[i].kind >= ck::DWARF_CAMP).collect();
    // Dwarven chambers come after every other (genVersion 3 indices stay).
    let first = dw.first().copied().unwrap_or(p.chambers.len());
    assert!(dw.iter().all(|&i| i >= first) && dw.len() == p.chambers.len() - first, "seed {seed}: dwarven chambers are appended");
    let holds = dw.iter().filter(|&&i| p.chambers[i].kind == ck::STRONGHOLD).count();
    let lowers = dw.iter().filter(|&&i| p.chambers[i].kind == ck::LOWER_HALLS).count();
    let camps = dw.iter().filter(|&&i| p.chambers[i].kind == ck::DWARF_CAMP).count();
    if p.chambers.iter().filter(|c| c.layer == LAYER_UNDER).count() >= 6 {
        assert!(holds >= 1, "seed {seed}: no stronghold");
        assert_eq!(holds, lowers, "seed {seed}: a stronghold has lower halls");
        assert!(camps >= 2, "seed {seed}: {camps} camps");
    }
    for &i in &dw {
        let c = &p.chambers[i];
        let v = field::under_at(p, LAYER_UNDER, c.x, c.z, &mut |_, _| 1.0e6);
        assert!(v.b - v.a >= 14.0 && v.b < 5000.0, "seed {seed}: chamber {i} centre air {} .. {}", v.a, v.b);
        assert!(c.site != 0xFFFF, "seed {seed}: chamber {i} has no site");
        // Its passage walks end to end.
        let r = p.corridors.iter().find(|r| r.kind == rk::SECRET && r.to as usize == i).expect("passage");
        let mut prev: Option<f64> = None;
        for k in 0..r.pts.len() - 1 {
            for t in 0..14 {
                let f = t as f64 / 14.0;
                let (x, z) = (r.pts[k][0] + (r.pts[k + 1][0] - r.pts[k][0]) * f, r.pts[k][2] + (r.pts[k + 1][2] - r.pts[k][2]) * f);
                let v = field::under_at(p, LAYER_UNDER, x, z, &mut |_, _| 1.0e6);
                assert!(v.b - v.a >= 3.5, "seed {seed}: passage into {i} pinched at ({x:.0}, {z:.0}): {}", v.b - v.a);
                if let Some(pa) = prev {
                    assert!((v.a - pa).abs() < 2.4, "seed {seed}: passage into {i} steps {} at ({x:.0}, {z:.0})", v.a - pa);
                }
                prev = Some(v.a);
            }
        }
    }
    // The towns: dwarven style, townsfolk, a waypoint site linked to the hall.
    let t = town::build(&a).unwrap();
    for st in &t.settlements {
        let site_rec = a.site(st.site as usize);
        if site_rec.layer != LAYER_UNDER {
            continue;
        }
        let bs = &t.buildings[st.building_first as usize..(st.building_first + st.building_count) as usize];
        assert!(bs.iter().all(|b| b.style == kit::STYLE_DWARF || b.role == town::role::STALL), "seed {seed}: dwarven style");
        assert!(st.npc_count >= 3, "seed {seed}: settlement {} has {} people", st.site, st.npc_count);
        let waypoint = (0..a.site_count()).any(|i| {
            let o = a.site(i);
            o.category == site::CAT_POI && o.kind == site::POI_WAYPOINT && o.layer == LAYER_UNDER && (o.x - site_rec.x).abs() < 0.01 && (o.z - site_rec.z).abs() < 0.01
        });
        assert!(waypoint, "seed {seed}: settlement {} has no waypoint", st.site);
        // Under the roof: every building floor has air over it.
        for b in bs.iter().filter(|b| b.floors > 0) {
            let v = field::under_at(p, LAYER_UNDER, b.x, b.z, &mut |_, _| 1.0e6);
            assert!(v.b - b.floor_y > b.storey * b.floors as f64 + b.roof_h + 3.0, "seed {seed}: building {:016x} under the ceiling ({} over {})", b.id, v.b, b.floor_y);
        }
    }
}

#[test]
fn dwarves_on_several_worlds() {
    for seed in [20261108u64, 7, 1234, 99] {
        check(seed);
    }
}
