//! Cave invariants over real worlds (WP09):
//! - connectivity by construction: from the open air at every mouth, a flood
//!   fill through air samples of the generated cells reaches every chamber;
//! - meshes are closed across cell borders (shared vertices are identical);
//! - edits carve and flag veins; outputs are deterministic.

use std::collections::{HashMap, VecDeque};
use worldgen::atlas::{self, format::Atlas};
use worldgen::cave::{self, cell, graphbuf::GraphView};

fn world(seed: u64) -> Vec<u8> {
    atlas::build(&worldgen::spec::spec_from_seed(seed), seed).unwrap()
}

/// Air samples (2 m lattice, world integer coords / 2) of every cell a system touches.
fn air_grid(a: &Atlas, w: &worldgen::cave::graph::CaveWorld, si: usize) -> HashMap<(i32, i32, i32), bool> {
    let s = &w.systems[si];
    let mut g = HashMap::new();
    let (x0, x1) = ((s.bbox[0] / 64.0).floor() as i32, (s.bbox[3] / 64.0).floor() as i32);
    let (y0, y1) = ((s.bbox[1] / 32.0).floor() as i32, ((s.bbox[4] + 12.0) / 32.0).floor() as i32);
    let (z0, z1) = ((s.bbox[2] / 64.0).floor() as i32, (s.bbox[5] / 64.0).floor() as i32);
    for cy in y0..=y1 {
        for cz in z0..=z1 {
            for cx in x0..=x1 {
                if !cell::valid_cell(cx, cy, cz) {
                    continue;
                }
                let b = cell::build(a, w, cx, cy, cz, &[]).unwrap();
                for j in 0..cell::NY {
                    for k in 0..cell::NX {
                        for i in 0..cell::NX {
                            let d = b[cell::HEADER + (j * cell::NX + k) * cell::NX + i] as i8;
                            g.insert((cx * 32 + i as i32, cy * 16 + j as i32, cz * 32 + k as i32), d < 0);
                        }
                    }
                }
            }
        }
    }
    g
}

#[test]
fn every_chamber_reachable_from_the_sky() {
    for seed in [20261108u64, 7, 1234, 99] {
        let bytes = world(seed);
        let a = Atlas::parse(&bytes).unwrap();
        let c = cave::world(&a).unwrap();
        let w = &c.world;
        assert!(w.systems.len() >= 8, "seed {seed}: only {} systems", w.systems.len());
        let n = if cfg!(debug_assertions) { 3 } else { w.systems.len() };
        for si in 0..n {
            let s = &w.systems[si];
            let g = air_grid(&a, w, si);
            let o = s.openings[0];
            // Start in the open air 3 m above the opening center.
            let start = ((o.x / 2.0).round() as i32, ((o.y + 3.0) / 2.0).round() as i32, (o.z / 2.0).round() as i32);
            assert_eq!(g.get(&start), Some(&true), "seed {seed} sys {si}: no air above the mouth");
            let mut seen = HashMap::new();
            let mut q = VecDeque::from([start]);
            seen.insert(start, ());
            while let Some((x, y, z)) = q.pop_front() {
                for (dx, dy, dz) in [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)] {
                    let n = (x + dx, y + dy, z + dz);
                    // Stay near the system (the surface air is unbounded).
                    if (n.0 * 2) as f64 > s.bbox[3] + 8.0 || ((n.0 * 2) as f64) < s.bbox[0] - 8.0 || ((n.2 * 2) as f64) > s.bbox[5] + 8.0 || ((n.2 * 2) as f64) < s.bbox[2] - 8.0 {
                        continue;
                    }
                    if g.get(&n) == Some(&true) && !seen.contains_key(&n) {
                        seen.insert(n, ());
                        q.push_back(n);
                    }
                }
            }
            for (ci, ch) in s.chambers.iter().enumerate() {
                let p = ((ch.x / 2.0).round() as i32, ((ch.floor + 1.5) / 2.0).round() as i32, (ch.z / 2.0).round() as i32);
                // The nearest air sample to the chamber floor point.
                let found = (-1..=1).any(|dy| seen.contains_key(&(p.0, p.1 + dy, p.2)));
                assert!(found, "seed {seed} sys {si}: chamber {ci} (depth {:.0}) not reachable", ch.depth);
            }
        }
    }
}

#[test]
fn meshes_share_border_vertices() {
    let bytes = world(20261108);
    let a = Atlas::parse(&bytes).unwrap();
    let c = cave::world(&a).unwrap();
    let w = &c.world;
    let ch = w.systems[0].chambers[w.systems[0].deepest as usize];
    let (cx, cy, cz) = ((ch.x / 64.0).floor() as i32, (ch.y / 32.0).floor() as i32, (ch.z / 64.0).floor() as i32);
    let verts = |cx: i32, cy: i32, cz: i32| -> Vec<[u32; 3]> {
        let b = cell::build(&a, w, cx, cy, cz, &[]).unwrap();
        let nv = u32::from_le_bytes(b[28..32].try_into().unwrap()) as usize;
        let po = u32::from_le_bytes(b[40..44].try_into().unwrap()) as usize;
        (0..nv)
            .map(|n| {
                let f = |k: usize| u32::from_le_bytes(b[po + n * 12 + k * 4..po + n * 12 + k * 4 + 4].try_into().unwrap());
                [f(0), f(1), f(2)]
            })
            .collect()
    };
    let here = verts(cx, cy, cz);
    assert!(!here.is_empty(), "deepest chamber cell has a mesh");
    // A vertex this cell made from a padding cube (x below its origin) must
    // also exist, bit for bit, in the neighbor that owns that cube.
    let ox = cx as f32 * 64.0;
    let left = verts(cx - 1, cy, cz);
    let lset: std::collections::HashSet<[u32; 3]> = left.into_iter().collect();
    for v in &here {
        if f32::from_bits(v[0]) < ox - 0.001 {
            assert!(lset.contains(v), "padding vertex missing in neighbor");
        }
    }
}

#[test]
fn edits_carve_and_flag() {
    let bytes = world(20261108);
    let a = Atlas::parse(&bytes).unwrap();
    let c = cave::world(&a).unwrap();
    let w = &c.world;
    let v = w.systems[1].veins[0];
    let (cx, cy, cz) = ((v.x / 64.0).floor() as i32, (v.y / 32.0).floor() as i32, (v.z / 64.0).floor() as i32);
    let plain = cell::build(&a, w, cx, cy, cz, &[]).unwrap();
    let e = cell::Edit { vein_id: v.id, x: v.x, y: v.y, z: v.z, r: 1.5 };
    let edited = cell::build(&a, w, cx, cy, cz, &[e]).unwrap();
    assert_ne!(worldgen::hash_bytes(&plain), worldgen::hash_bytes(&edited));
    let vo = u32::from_le_bytes(edited[60..64].try_into().unwrap()) as usize;
    let nvein = u16::from_le_bytes(edited[64..66].try_into().unwrap()) as usize;
    let mined = (0..nvein).any(|k| {
        let o = vo + k * cell::VEIN_REC;
        u64::from_le_bytes(edited[o..o + 8].try_into().unwrap()) == v.id && edited[o + 29] & 2 != 0
    });
    assert!(mined, "edited vein flagged mined");
    // Deterministic.
    assert_eq!(edited, cell::build(&a, w, cx, cy, cz, &[e]).unwrap());
}

#[test]
fn system_query_finds_chambers() {
    let bytes = world(7);
    let a = Atlas::parse(&bytes).unwrap();
    let c = cave::world(&a).unwrap();
    let gv = GraphView { b: &c.graph };
    for s in &c.world.systems {
        for ch in &s.chambers {
            assert_eq!(gv.system_at(ch.x, ch.floor + 1.0, ch.z), s.index as i32);
        }
        assert_eq!(gv.system_at(s.mouth_x, s.mouth_y + 60.0, s.mouth_z), -1);
    }
}
