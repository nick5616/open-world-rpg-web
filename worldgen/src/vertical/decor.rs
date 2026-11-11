//! Decorations, columns and veins of the vertical world, placed on the
//! field (so a crystal stands on the floor the player walks and a
//! stalactite hangs from the real ceiling). Rendering only, except columns
//! (hosts collide with them) and veins (the zone mines them).

use super::field::{island_sd, sky_at, under_at};
use super::tile::TerrainSampler;
use super::under::ellipse_pt;
use super::*;
use crate::cave::veins::{Vein, KIND_GEM, KIND_ORE, ORE_IRON, ORE_SILVER, ORE_STARMETAL, ORE_VOIDGLASS};
use crate::rng::{stable_id, Seq};

const TAU: f64 = core::f64::consts::TAU;

fn yaw16(seq: &mut Seq) -> u16 {
    (seq.unit() * 65536.0) as u16
}

pub fn place(a: &Atlas, p: &mut Plan) {
    let seed = a.seed;
    let mut decos: Vec<Deco> = Vec::new();
    let mut columns: Vec<Column> = Vec::new();
    let mut veins: Vec<Vein> = Vec::new();
    let mut ts = TerrainSampler::new(a, 0.0, 0.0, 4096.0, 4096.0);

    // ---- chambers (Underground and Depths)
    for ci in 0..p.chambers.len() {
        let ch = p.chambers[ci].clone();
        let mut seq = Seq::new(seed ^ ch.id, stream::DECOR);
        let layer = ch.layer;
        let deep = layer == LAYER_DEPTHS;
        let mut at = |p: &Plan, x: f64, z: f64| under_at(p, layer, x, z, &mut |x, z| ts.at(x, z));
        let area = ch.rx * ch.rz / 10000.0; // hectares-ish
        // Columns: great pillars from floor to roof, off the lake.
        let n_col = if deep { 2 + seq.below(3) } else { 2 + (ch.rx / 45.0) as usize };
        for _ in 0..n_col * 4 {
            if columns.iter().filter(|c| c.chamber == ci as u16).count() >= n_col {
                break;
            }
            let e = seq.range(0.22, 0.7);
            if ch.lake_e > 0.0 && e < ch.lake_e + 0.1 {
                continue;
            }
            let (x, z) = ellipse_pt(&ch, e, seq.range(0.0, TAU));
            let r = seq.range(3.5, if deep { 7.0 } else { 9.0 });
            if columns.iter().any(|c| (c.x - x) * (c.x - x) + (c.z - z) * (c.z - z) < (c.r + r + 14.0) * (c.r + r + 14.0)) {
                continue;
            }
            let v = at(p, x, z);
            if v.b - v.a < 25.0 || v.b > 5000.0 {
                continue;
            }
            columns.push(Column { x, z, r, y0: v.a, y1: v.b, layer, chamber: ci as u16 });
        }
        // Crystals: clusters along the walls and spires on the floor; every
        // fourth big one casts real light (the client's light pool).
        let tint = ch.tint;
        let n_cry = match (deep, ch.kind) {
            (true, _) => (8.0 + 10.0 * area) as usize,
            (_, ck::CRYSTAL) => (70.0 + 40.0 * area) as usize,
            _ => (34.0 + 22.0 * area) as usize,
        }
        .min(180);
        for k in 0..n_cry {
            let e = seq.range(0.55, 0.97);
            let (x, z) = ellipse_pt(&ch, e, seq.range(0.0, TAU));
            let v = at(p, x, z);
            if v.b < v.a + 2.0 || v.w > v.a {
                continue;
            }
            let big = k % 4 == 0;
            let kind = if big && !deep { dk::SPIRE } else if deep { dk::OBSIDIAN } else { dk::CRYSTAL };
            let size = if big { seq.range(6.0, 15.0) } else { seq.range(1.8, 5.5) };
            let t = if deep { 0 } else if seq.unit() < 0.2 { [1u8, 7, 8][seq.below(3)] } else { tint };
            decos.push(Deco { x, y: v.a, z, size, kind, tint: t, layer, flags: if big && (k / 4) % 2 == 0 { df::LIGHT } else { 0 }, yaw: yaw16(&mut seq), aux: ci as u16 });
        }
        // Ceiling: stalactites and hanging crystals.
        let n_hang = ((30.0 + 25.0 * area) as usize).min(110);
        for k in 0..n_hang {
            let e = seq.range(0.05, 0.85);
            let (x, z) = ellipse_pt(&ch, e, seq.range(0.0, TAU));
            let v = at(p, x, z);
            if v.b < v.a + 12.0 || v.b > 5000.0 {
                continue;
            }
            let kind = if !deep && k % 6 == 0 { dk::CRYSTAL } else { dk::STALACTITE };
            decos.push(Deco { x, y: v.b, z, size: seq.range(3.0, 14.0), kind, tint, layer, flags: df::HANG, yaw: yaw16(&mut seq), aux: ci as u16 });
        }
        // Floor: stalagmites; glowing flora on dry ground (fungal halls are full of it).
        let n_mite = ((12.0 + 10.0 * area) as usize).min(60);
        for _ in 0..n_mite {
            let (x, z) = ellipse_pt(&ch, seq.range(0.2, 0.85), seq.range(0.0, TAU));
            let v = at(p, x, z);
            if v.w > v.a - 0.2 || v.b < v.a + 8.0 {
                continue;
            }
            decos.push(Deco { x, y: v.a, z, size: seq.range(2.0, 9.0), kind: if deep { dk::OBSIDIAN } else { dk::STALAGMITE }, tint, layer, flags: 0, yaw: yaw16(&mut seq), aux: ci as u16 });
        }
        if !deep {
            let n_flora = match ch.kind {
                ck::FUNGAL => (70.0 + 40.0 * area) as usize,
                ck::CENOTE | ck::RIVER => (25.0 + 15.0 * area) as usize,
                _ => (10.0 + 8.0 * area) as usize,
            }
            .min(180);
            for k in 0..n_flora {
                let (x, z) = ellipse_pt(&ch, seq.range(0.1, 0.9), seq.range(0.0, TAU));
                let v = at(p, x, z);
                if v.w > v.a - 0.2 || v.b < v.a + 4.0 {
                    continue;
                }
                let mush = ch.kind == ck::FUNGAL && k % 3 != 0 || k % 4 == 0;
                let size = if mush { seq.range(1.0, if ch.kind == ck::FUNGAL { 9.0 } else { 3.5 }) } else { seq.range(0.6, 2.2) };
                decos.push(Deco {
                    x,
                    y: v.a,
                    z,
                    size,
                    kind: if mush { dk::MUSHROOM } else { dk::FLORA },
                    tint: [3u8, 8, 7, 1][seq.below(4)],
                    layer,
                    flags: if mush && size > 6.0 && k % 3 == 1 { df::LIGHT } else { 0 },
                    yaw: yaw16(&mut seq),
                    aux: ci as u16,
                });
            }
        } else {
            // The Depths: sulphur vents, drifting embers, a demon shrine.
            for k in 0..(4 + (6.0 * area) as usize).min(16) {
                let (x, z) = ellipse_pt(&ch, seq.range(0.1, 0.8), seq.range(0.0, TAU));
                let v = at(p, x, z);
                if v.w > v.a - 0.2 {
                    continue;
                }
                decos.push(Deco { x, y: v.a, z, size: seq.range(1.5, 4.0), kind: if k % 3 == 2 { dk::EMBERS } else { dk::VENT }, tint: 0, layer, flags: if k % 4 == 0 { df::LIGHT } else { 0 }, yaw: yaw16(&mut seq), aux: ci as u16 });
            }
            let (x, z) = ellipse_pt(&ch, 0.35, seq.range(0.0, TAU));
            let v = at(p, x, z);
            if v.w < v.a {
                decos.push(Deco { x, y: v.a, z, size: 6.0, kind: dk::SHRINE, tint: 6, layer, flags: df::LIGHT, yaw: yaw16(&mut seq), aux: ci as u16 });
            }
        }
        // Veins worth mining near the walls.
        let n_v = if deep { 4 + seq.below(5) } else { 5 + seq.below(6) };
        for vi in 0..n_v {
            let th = seq.range(0.0, TAU);
            let e = seq.range(0.8, 0.9);
            let (x, z) = ellipse_pt(&ch, e, th);
            let v = at(p, x, z);
            if v.b < v.a + 3.0 || v.w > v.a {
                continue;
            }
            let (cx2, cz2) = ellipse_pt(&ch, e - 0.08, th);
            let (nx, nz) = (cx2 - x, cz2 - z);
            let nl = libm::sqrt(nx * nx + nz * nz).max(1e-9);
            let gem = seq.unit() < if deep { 0.55 } else { 0.6 };
            let (kind, material, element, hp) = if gem {
                let m = if deep { [0u8, 6, 7, 0][seq.below(4)] } else { [1u8, 4, 7, 8, 9, 2][seq.below(6)] };
                (KIND_GEM, m, if m < 8 { m } else { 255 }, 130 + if deep { 60 } else { 20 })
            } else {
                let m = if deep { [ORE_VOIDGLASS, ORE_STARMETAL, ORE_VOIDGLASS][seq.below(3)] } else { [ORE_SILVER, ORE_IRON, ORE_SILVER, ORE_VOIDGLASS][seq.below(4)] };
                (KIND_ORE, m, 255, if deep { 240 } else { 150 })
            };
            veins.push(Vein {
                id: stable_id(idl::VEIN, layer as i32, ci as i32, vi as u32),
                x,
                y: v.a + 0.6,
                z,
                n: [nx / nl * 0.8, 0.6, nz / nl * 0.8],
                kind,
                material,
                element,
                hp,
                size: 3 + seq.below(5) as u8,
                flags: 0,
                band: if deep { 4 } else { 3 },
                chamber: ci as u16,
                system: 0xFFFF,
            });
        }
    }

    // ---- corridors: waterfalls / lava falls where rivers drop.
    for ri in 0..p.corridors.len() {
        let r = p.corridors[ri].clone();
        if r.water <= 0.0 {
            continue;
        }
        for k in 0..r.pts.len().saturating_sub(1) {
            let (a0, b0) = (r.pts[k], r.pts[k + 1]);
            let drop = a0[1] - b0[1];
            if drop > 3.0 {
                decos.push(Deco { x: b0[0], y: a0[1], z: b0[2], size: drop + 1.5, kind: if r.lava { dk::LAVAFALL } else { dk::WATERFALL }, tint: if r.lava { 0 } else { 8 }, layer: r.layer, flags: if r.lava { df::LIGHT } else { 0 }, yaw: 0, aux: ri as u16 });
            }
        }
    }

    // ---- openings: portal arches at tunnel mouths, gates, cenote light.
    for oi in 0..p.openings.len() {
        let o = p.openings[oi];
        let yaw = o.yaw as f64 / 65536.0 * TAU;
        match o.kind {
            ok::TUNNEL => {
                // The arch stands on the far (uphill) rim, facing out.
                let (x, z) = (o.x - libm::cos(yaw) * o.r * 0.95, o.z - libm::sin(yaw) * o.r * 0.95);
                let y = ts.at(libm::round(x), libm::round(z));
                decos.push(Deco { x, y, z, size: 14.0, kind: dk::PORTAL, tint: 8, layer: LAYER_SURFACE, flags: df::LIGHT, yaw: o.yaw, aux: o.site });
            }
            ok::GATE => {
                decos.push(Deco { x: o.x, y: o.y, z: o.z, size: o.r, kind: dk::GATE, tint: 0, layer: LAYER_UNDER, flags: df::LIGHT, yaw: o.yaw, aux: o.site });
            }
            _ => {}
        }
    }
    for si in 0..p.shafts.len() {
        let sh = p.shafts[si];
        let ch = &p.chambers[sh.chamber as usize];
        let mut seq = Seq::new(seed ^ (si as u64 + 1), stream::DECOR ^ 0x5A);
        let lake = if ch.lake != NO_WATER { ch.lake } else { ch.floor };
        let top = ts.at(libm::round(sh.x), libm::round(sh.z));
        decos.push(Deco { x: sh.x, y: lake, z: sh.z, size: top - lake, kind: dk::LIGHTSHAFT, tint: 9, layer: LAYER_UNDER, flags: df::LIGHT, yaw: 0, aux: si as u16 });
        // Rain of water from the rim, vines down the shaft walls.
        let th = seq.range(0.0, TAU);
        decos.push(Deco { x: sh.x + libm::cos(th) * sh.r * 0.9, y: top - 1.0, z: sh.z + libm::sin(th) * sh.r * 0.9, size: top - lake, kind: dk::WATERFALL, tint: 8, layer: LAYER_UNDER, flags: 0, yaw: 0, aux: 0xFFFF });
        for k in 0..12 {
            let th = TAU * k as f64 / 12.0 + seq.range(-0.2, 0.2);
            decos.push(Deco { x: sh.x + libm::cos(th) * sh.r, y: top - seq.range(1.0, 6.0), z: sh.z + libm::sin(th) * sh.r, size: seq.range(8.0, 30.0), kind: dk::VINES, tint: 3, layer: LAYER_UNDER, flags: df::HANG, yaw: (th / TAU * 65536.0) as u16, aux: si as u16 });
        }
    }

    // ---- camps (the underground waypoints): fire, tents, lanterns.
    for si in 0..p.sites.len() {
        let s = p.sites[si].clone();
        if !(s.category == crate::atlas::format::site::CAT_POI && s.kind == crate::atlas::format::site::POI_WAYPOINT && (s.layer == LAYER_UNDER || s.layer == LAYER_DEPTHS)) {
            continue;
        }
        let layer = s.layer;
        let mut seq = Seq::new(seed ^ (si as u64 * 31 + 7), stream::DECOR ^ 0xCA);
        let mut put = |p: &Plan, dx: f64, dz: f64, kind: u8, size: f64, flags: u8, seq: &mut Seq, decos: &mut Vec<Deco>| {
            let (x, z) = (s.x + dx, s.z + dz);
            let v = under_at(p, layer, x, z, &mut |x, z| ts.at(x, z));
            decos.push(Deco { x, y: v.a, z, size, kind, tint: 0, layer, flags, yaw: yaw16(seq), aux: (p.base_sites + si) as u16 });
        };
        put(p, 3.5, 0.0, dk::CAMPFIRE, 1.0, df::LIGHT, &mut seq, &mut decos);
        put(p, -2.0, 5.5, dk::TENT, 3.0, 0, &mut seq, &mut decos);
        put(p, 7.5, 4.0, dk::TENT, 3.0, 0, &mut seq, &mut decos);
        put(p, -3.0, -4.0, dk::LANTERN, 2.2, df::LIGHT, &mut seq, &mut decos);
    }

    // ---- sky: trees, rocks and ruins on islands, waterfalls off the rims,
    // the palace, clouds under every archipelago, lift crystals and geysers.
    for ii in 0..p.islands.len() {
        let isl = p.islands[ii].clone();
        let mut seq = Seq::new(seed ^ isl.id, stream::DECOR ^ 0x51);
        let (n_tree, n_rock) = match isl.kind {
            ik::GROVE => ((isl.r * 0.9) as usize, 4),
            ik::MEADOW => ((isl.r * 0.18) as usize, 3),
            ik::CRAG => (2, (isl.r * 0.3) as usize),
            ik::RUIN => (3, 4),
            ik::TOWN => (8, 2),
            _ => (6, 3),
        };
        for k in 0..(n_tree + n_rock) {
            let ang = seq.range(0.0, TAU);
            let d = isl.r * libm::sqrt(seq.unit()) * 0.92;
            let (x, z) = (isl.x + d * libm::cos(ang), isl.z + d * libm::sin(ang));
            let sd = island_sd(&isl, x, z);
            if sd < 3.0 {
                continue;
            }
            // Keep the middle of towns and palaces clear.
            if (isl.kind == ik::TOWN || isl.kind == ik::PALACE) && d < isl.r * 0.7 {
                continue;
            }
            let v = sky_at(p, x, z);
            let tree = k < n_tree;
            decos.push(Deco { x, y: v.a, z, size: if tree { seq.range(6.0, 13.0) } else { seq.range(1.5, 5.0) }, kind: if tree { dk::TREE } else { dk::ROCK }, tint: isl.biome, layer: LAYER_SKY, flags: 0, yaw: yaw16(&mut seq), aux: ii as u16 });
        }
        if isl.kind == ik::RUIN {
            for k in 0..(6 + seq.below(7)) {
                let ang = TAU * k as f64 / 9.0 + seq.range(-0.2, 0.2);
                let d = isl.r * seq.range(0.2, 0.55);
                let (x, z) = (isl.x + d * libm::cos(ang), isl.z + d * libm::sin(ang));
                let v = sky_at(p, x, z);
                decos.push(Deco { x, y: v.a, z, size: seq.range(4.0, 11.0), kind: dk::PILLAR, tint: 9, layer: LAYER_SKY, flags: 0, yaw: yaw16(&mut seq), aux: ii as u16 });
            }
        }
        if isl.kind == ik::PALACE {
            let v = sky_at(p, isl.x, isl.z);
            decos.push(Deco { x: isl.x, y: v.a, z: isl.z, size: (isl.r * 0.55).min(72.0), kind: dk::PALACE, tint: 5, layer: LAYER_SKY, flags: df::LIGHT, yaw: yaw16(&mut seq), aux: isl.site });
        }
        // Waterfalls pouring off the rim into the clouds.
        if matches!(isl.kind, ik::GROVE | ik::MEADOW | ik::TOWN | ik::PALACE) && isl.r > 26.0 {
            let falls = 1 + (isl.r > 70.0) as usize + (isl.kind == ik::PALACE) as usize;
            let cloud = p.archs[isl.arch as usize].cloud_y;
            for _ in 0..falls {
                let ang = seq.range(0.0, TAU);
                // Walk out from the core to the rim.
                let mut d = isl.r * 0.5;
                while d < isl.reach + 6.0 && island_sd(&isl, isl.x + d * libm::cos(ang), isl.z + d * libm::sin(ang)) > 1.5 {
                    d += 1.0;
                }
                let (x, z) = (isl.x + (d - 1.0) * libm::cos(ang), isl.z + (d - 1.0) * libm::sin(ang));
                let v = sky_at(p, x, z);
                decos.push(Deco { x, y: v.a, z, size: (v.a - cloud + 40.0).max(60.0), kind: dk::SKYFALL, tint: 8, layer: LAYER_SKY, flags: 0, yaw: ((ang / TAU).rem_euclid(1.0) * 65536.0) as u16, aux: ii as u16 });
            }
        }
    }
    for ai in 0..p.archs.len() {
        let ar = p.archs[ai].clone();
        let mut seq = Seq::new(seed ^ ar.id, stream::DECOR ^ 0xC1);
        for _ in 0..(14 + seq.below(8)) {
            let ang = seq.range(0.0, TAU);
            let d = ar.r * libm::sqrt(seq.unit()) * 1.05;
            decos.push(Deco { x: ar.x + d * libm::cos(ang), y: ar.cloud_y + seq.range(-14.0, 14.0), z: ar.z + d * libm::sin(ang), size: seq.range(60.0, 150.0), kind: dk::CLOUD, tint: 9, layer: LAYER_SKY, flags: 0, yaw: yaw16(&mut seq), aux: ai as u16 });
        }
    }
    for ui in 0..p.updrafts.len() {
        let u = p.updrafts[ui];
        let kind = match u.kind {
            uk::LIFT => dk::LIFT,
            uk::GEYSER => dk::GEYSER,
            _ => continue,
        };
        let y = ts.at(libm::round(u.x), libm::round(u.z));
        decos.push(Deco { x: u.x, y, z: u.z, size: u.r, kind, tint: 4, layer: LAYER_SURFACE, flags: if kind == dk::LIFT { df::LIGHT } else { 0 }, yaw: 0, aux: ui as u16 });
    }

    p.decos = decos;
    p.columns = columns;
    p.veins = veins;
}
