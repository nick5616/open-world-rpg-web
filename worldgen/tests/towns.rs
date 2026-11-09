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
    // genVersion 2 foundations: the foundation reaches below the ground
    // everywhere under the building (no gap under a house on a slope).
    for b in t.buildings.iter().filter(|b| b.floors > 0) {
        for (u, v) in [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)] {
            let (lu, lv) = (u * b.hx, v * b.hz);
            let g = ground::collision_height(&a, b.x + lu * b.c - lv * b.s, b.z + lu * b.s + lv * b.c);
            assert!(
                b.base_y <= g,
                "seed {seed}: building {:016x} foundation bottom {} above ground {g}",
                b.id,
                b.base_y
            );
        }
    }

    // genVersion 2 footpaths: every door (the foot of its steps) is on a
    // street or the square, or has a footpath; every footpath ends on the
    // network or on another footpath; no footpath runs through a solid box.
    let near_pl = |pts: &[[f64; 3]], x: f64, z: f64, d: f64| pts.windows(2).any(|w| seg_d(x, z, w[0][0], w[0][2], w[1][0], w[1][2]) <= d);
    for (si, st) in t.settlements.iter().enumerate() {
        let streets: Vec<&town::Road> = t.roads.iter().filter(|r| r.class == 1 && r.settlement as usize == si).collect();
        let on_net = |x: f64, z: f64, pad: f64| {
            ((x - st.x).powi(2) + (z - st.z).powi(2)).sqrt() <= st.square + pad || streets.iter().any(|r| near_pl(&r.points, x, z, r.width * 0.5 + pad))
        };
        let paths: Vec<(usize, &town::Road)> = t
            .roads
            .iter()
            .enumerate()
            .filter(|(_, r)| r.class == town::paths::CLASS_PATH && r.settlement as usize == si)
            .collect();
        for &(_, p) in &paths {
            let end = p.points.last().unwrap();
            let ok = if p.to == 0xFFFF {
                on_net(end[0], end[2], 1.6)
            } else {
                near_pl(&t.roads[p.to as usize].points, end[0], end[2], 1.6)
            };
            assert!(ok, "seed {seed} settlement {si}: footpath ends nowhere ({:.1}, {:.1})", end[0], end[2]);
            let boxes = &t.boxes[st.box_first as usize..(st.box_first + st.box_count) as usize];
            for q in &p.points[1..] {
                for bx in boxes.iter().filter(|b| b.flags & town::bf::SOLID != 0) {
                    let (dx, dz) = (q[0] - bx.cx as f64, q[2] - bx.cz as f64);
                    let (u, v) = (dx * bx.c as f64 + dz * bx.s as f64, dz * bx.c as f64 - dx * bx.s as f64);
                    assert!(
                        u.abs() > bx.hx as f64 - 0.05 || v.abs() > bx.hz as f64 - 0.05,
                        "seed {seed} settlement {si}: footpath (from {} to {}) through a solid box (kind {} owner {}) at ({:.1}, {:.1})",
                        p.from,
                        p.to,
                        bx.kind,
                        bx.owner,
                        q[0],
                        q[2]
                    );
                }
            }
        }
        for bi in st.building_first as usize..(st.building_first + st.building_count) as usize {
            let b = &t.buildings[bi];
            if b.floors == 0 || paths.iter().any(|(_, p)| p.from as usize == bi) {
                continue;
            }
            let ramp = t.boxes[b.box_first as usize..b.box_first as usize + b.box_count as usize]
                .iter()
                .find(|x| x.kind == town::bk::RAMP);
            let (x, z) = match ramp {
                Some(r) => (r.cx as f64 - r.c as f64 * (r.hx as f64 + 0.3), r.cz as f64 - r.s as f64 * (r.hx as f64 + 0.3)),
                None => {
                    let porch = if b.flags & town::bflag::PORCH != 0 { 2.0 } else { 0.0 };
                    let v = -b.hz - porch - 0.7;
                    (b.x + b.door_u * b.c - v * b.s, b.z + b.door_u * b.s + v * b.c)
                }
            };
            // Paths start from a free cell within ~3 m of the door step foot.
            let joined = paths.iter().any(|(_, p)| near_pl(&p.points, x, z, 3.2));
            assert!(
                on_net(x, z, 3.2) || joined,
                "seed {seed} settlement {si}: door of building {bi} ({}) has no way to the street",
                role::NAMES[b.role as usize]
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

fn seg_d(px: f64, pz: f64, ax: f64, az: f64, bx: f64, bz: f64) -> f64 {
    let (dx, dz) = (bx - ax, bz - az);
    let l2 = dx * dx + dz * dz;
    let t = if l2 > 0.0 {
        (((px - ax) * dx + (pz - az) * dz) / l2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    ((px - ax - dx * t).powi(2) + (pz - az - dz * t).powi(2)).sqrt()
}
