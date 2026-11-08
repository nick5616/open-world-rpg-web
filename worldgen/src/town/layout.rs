//! Settlement layouts (spec 5 "town layout"): a central square around the
//! waypoint stone, streets that continue the roads arriving at the edge
//! (plus extra ones so every town has a few), a ring street in villages and
//! towns, plots along the streets and the square, required buildings first
//! (inn, forge, market stalls, ward garden; the bounty board and a well
//! stand in the square), then houses, farms, workshops and storehouses, and
//! a wall with gates around towns.
//!
//! Siting refinement (WP20): the atlas fixed each settlement's centre and
//! radius; here every plot is checked against the real 1 m terrain (lattice
//! range under the footprint, water), so buildings land only on flat dry
//! ground, and plots that fail move along the street or are dropped.

use super::geom::{dist, push_flat, sub, yaw16, Obb, Terrain};
use super::kit::{self, Ctx};
use super::roads::{ang_diff, Net, ROAD_WIDTH};
use super::{bf, bk, layer, npc, pf, pk, role, stream, Prop, Road, Settlement, Towns};
use crate::atlas::format::{sec, site, Atlas, SITE_REC};
use crate::rng::{stable_id, Seq};

const NONE: u16 = 0xFFFF;
const TAU: f64 = 2.0 * core::f64::consts::PI;

/// A place a building can front onto: a point on a street (or the square's
/// edge) and the direction from there into the plot.
struct Slot {
    x: f64,
    z: f64,
    nx: f64,
    nz: f64,
    street: u16,
    along: f64,
    clear: f64,
}

fn site_biome(a: &Atlas, i: usize) -> u8 {
    a.section(sec::SITES)[8 + i * SITE_REC + 34]
}

pub fn build_settlements(a: &Atlas, net: &Net, t: &mut Towns) {
    let ter = Terrain::new(a);
    for (si, &site_i) in net.sites.iter().enumerate() {
        let s = a.site(site_i);
        let biome = site_biome(a, site_i);
        let style = kit::style_of_biome(biome);
        let mut seq = Seq::new(a.seed ^ s.seed as u64, stream::LAYOUT);
        let size = s.size.min(2);
        let r = s.radius;
        let square = [9.0, 13.0, 18.0][size as usize];
        let walled = size == site::SIZE_TOWN;
        let target = match size {
            0 => 5 + seq.below(4),
            1 => 12 + seq.below(11),
            _ => 32 + seq.below(21),
        };
        let cy = ter.height(s.x, s.z);
        let su = si as u16;
        let set_first_building = t.buildings.len() as u16;
        let prop_first = t.props.len() as u32;
        let box_first = t.boxes.len() as u32;
        let road_first = t.roads.len() as u16;
        let mut prop_n = 0u32;

        // Streets: one per road entry, topped up to a minimum count by
        // splitting the widest gap between them.
        let mut angles = net.entries[si].clone();
        let min_streets = [2usize, 3, 4][size as usize];
        if angles.is_empty() {
            angles.push(seq.range(0.0, TAU));
        }
        while angles.len() < min_streets {
            angles.sort_by(|x, y| x.partial_cmp(y).unwrap());
            let n = angles.len();
            let mut best = (0.0, 0usize);
            for i in 0..n {
                let a0 = angles[i];
                let a1 = if i + 1 < n { angles[i + 1] } else { angles[0] + TAU };
                if a1 - a0 > best.0 {
                    best = (a1 - a0, i);
                }
            }
            angles.push((angles[best.1] + best.0 * 0.5) % TAU);
        }
        angles.sort_by(|x, y| x.partial_cmp(y).unwrap());
        let street_w = if size == site::SIZE_TOWN { 5.0 } else { 4.0 };
        let mut segs: Vec<(f64, f64, f64, f64, f64)> = Vec::new(); // street segments (ax, az, bx, bz, half width)
        let mut slots: Vec<Slot> = Vec::new();
        for &ang in &angles {
            let (dx, dz) = (libm::cos(ang), libm::sin(ang));
            let (ax, az) = (s.x + dx * square, s.z + dz * square);
            let (bx, bz) = (s.x + dx * r, s.z + dz * r);
            let ri = t.roads.len() as u16;
            let pts = line_points(&ter, ax, az, bx, bz);
            t.roads.push(Road {
                length: r - square,
                points: pts,
                from: su,
                to: su,
                width: street_w,
                class: 1,
                surface: (size >= 1) as u8,
                settlement: su,
            });
            segs.push((ax, az, bx, bz, street_w * 0.5));
            // Frontage slots both sides, every 2 m outward.
            let mut d = 2.0;
            while d < r - square - 4.0 {
                let (px, pz) = (ax + dx * d, az + dz * d);
                for side in [-1.0, 1.0] {
                    slots.push(Slot {
                        x: px,
                        z: pz,
                        nx: -dz * side,
                        nz: dx * side,
                        street: ri,
                        along: d,
                        clear: street_w * 0.5 + 0.8,
                    });
                }
                d += 2.0;
            }
        }
        // Ring street (villages and towns).
        if size >= site::SIZE_VILLAGE {
            let rr = square + (r - square) * 0.5;
            let n = libm::ceil(TAU * rr / 4.0) as usize;
            let ri = t.roads.len() as u16;
            let mut pts = Vec::with_capacity(n + 1);
            for k in 0..=n {
                let ang = k as f64 / n as f64 * TAU;
                let (x, z) = (s.x + rr * libm::cos(ang), s.z + rr * libm::sin(ang));
                pts.push([x, ter.sample(x, z).0, z]);
            }
            for k in 0..n {
                segs.push((pts[k][0], pts[k][2], pts[k + 1][0], pts[k + 1][2], street_w * 0.5));
            }
            for k in 0..n {
                let ang = k as f64 / n as f64 * TAU;
                let (cs, sn) = (libm::cos(ang), libm::sin(ang));
                for side in [-1.0, 1.0] {
                    slots.push(Slot {
                        x: s.x + rr * cs,
                        z: s.z + rr * sn,
                        nx: cs * side,
                        nz: sn * side,
                        street: ri,
                        along: k as f64 * 4.0,
                        clear: street_w * 0.5 + 0.8,
                    });
                }
            }
            t.roads.push(Road {
                length: TAU * rr,
                points: pts,
                from: su,
                to: su,
                width: street_w,
                class: 1,
                surface: 1,
                settlement: su,
            });
        }
        // Square frontage (required buildings prefer it), every ~3 m.
        let mut square_slots = Vec::new();
        let n = libm::ceil(TAU * square / 3.0) as usize;
        for k in 0..n {
            let ang = k as f64 / n as f64 * TAU;
            if angles.iter().any(|&a| ang_diff(a, ang) < (street_w * 0.5 + 4.0) / square) {
                continue;
            }
            let (cs, sn) = (libm::cos(ang), libm::sin(ang));
            square_slots.push(Slot {
                x: s.x + square * cs,
                z: s.z + square * sn,
                nx: cs,
                nz: sn,
                street: NONE,
                along: 0.0,
                clear: 1.5,
            });
        }

        let mut placed: Vec<Obb> = Vec::new();
        let limit = if walled { r - 7.0 } else { r - 3.0 };
        let fits = |o: &Obb, extra_back: f64, placed: &[Obb], tol: f64| -> bool {
            let full = sub(o, 0.0, extra_back * 0.5, o.hx, o.hz + extra_back * 0.5);
            for (x, z) in full.corners() {
                let d = dist(x, z, s.x, s.z);
                if d > limit || d < square + 1.0 {
                    return false;
                }
            }
            if dist(full.cx, full.cz, s.x, s.z) < square + 1.0 {
                return false;
            }
            if placed.iter().any(|p| p.overlaps(&full, 0.8)) {
                return false;
            }
            for &(ax, az, bx, bz, hw) in &segs {
                if !full.seg_clear(ax, az, bx, bz, hw + 0.4) {
                    return false;
                }
            }
            let sp = ter.span(o, 0.6);
            if sp.wet || sp.max - sp.min > tol {
                return false;
            }
            if extra_back > 0.0 {
                let fsp = ter.span(&sub(o, 0.0, o.hz + extra_back * 0.5, o.hx, extra_back * 0.5), 0.0);
                if fsp.wet || fsp.max - fsp.min > tol + 0.6 {
                    return false;
                }
            }
            true
        };

        // Roles in priority order: required first (spec 5), then the rest.
        let mut roles = vec![role::INN, role::FORGE, role::GARDEN];
        let fill_n = target.saturating_sub(roles.len());
        for k in 0..fill_n {
            let u = seq.unit();
            roles.push(if k == 2 && size >= 1 {
                role::WORKSHOP
            } else if u < 0.62 {
                role::HOUSE
            } else if u < 0.8 {
                role::FARM
            } else if u < 0.92 {
                role::WORKSHOP
            } else {
                role::STOREHOUSE
            });
        }
        // A second row of plots behind the first (back lanes), used when
        // the street frontage is full or too steep.
        let back_slots: Vec<Slot> = slots
            .iter()
            .map(|sl| Slot {
                x: sl.x,
                z: sl.z,
                nx: sl.nx,
                nz: sl.nz,
                street: sl.street,
                along: sl.along,
                clear: sl.clear + 10.0,
            })
            .collect();
        let mut ctx = Ctx {
            ter: &ter,
            site: site_i,
            settlement: su,
            prop_n: &mut prop_n,
        };
        let mut local = 0u32;
        let mut cursor = (seq.next_u64() % slots.len().max(1) as u64) as usize;
        // Plot tolerance passes: lattice range under the footprint (m), and
        // whether back-lane plots are allowed. Required buildings get a
        // last, steep pass (their floor then sits on a taller plinth).
        const PASSES: [(f64, bool); 4] = [(2.4, false), (3.4, true), (4.6, true), (7.0, true)];
        let min_count = [4usize, 10, 30][size as usize];
        let mut houses = 0usize;
        let mut extra = 0usize;
        let mut ri = 0usize;
        while ri < roles.len() {
            let rl = roles[ri];
            ri += 1;
            let (w, d) = kit::footprint(rl, style, &mut seq);
            let back = kit::field_depth(rl);
            let required = matches!(rl, role::INN | role::FORGE);
            let mut done = false;
            let n = slots.len();
            for (pass, &(tol, use_back)) in PASSES.iter().enumerate() {
                if pass == 3 && !required {
                    break;
                }
                // Required buildings try the square first, then streets
                // nearest the square; others walk the slot list from a
                // rotating cursor, so houses spread over every street.
                let mut order: Vec<&Slot> = Vec::new();
                if required {
                    order.extend(square_slots.iter());
                    let mut near: Vec<&Slot> = slots.iter().collect();
                    if use_back {
                        near.extend(back_slots.iter());
                    }
                    near.sort_by(|p, q| p.along.partial_cmp(&q.along).unwrap());
                    order.extend(near);
                } else {
                    for k in 0..n {
                        order.push(&slots[(cursor + k * 7) % n]);
                    }
                    order.extend(square_slots.iter());
                    if use_back {
                        for k in 0..n {
                            order.push(&back_slots[(cursor + k * 7) % n]);
                        }
                    }
                }
                for sl in order {
                    let (cx, cz) = (sl.x + sl.nx * (sl.clear + d * 0.5), sl.z + sl.nz * (sl.clear + d * 0.5));
                    let o = Obb {
                        cx,
                        cz,
                        c: sl.nz,
                        s: -sl.nx,
                        hx: w * 0.5,
                        hz: d * 0.5,
                    };
                    if fits(&o, back, &placed, tol) {
                        placed.push(sub(&o, 0.0, back * 0.5, o.hx, o.hz + back * 0.5));
                        kit::build(&mut ctx, t, &o, rl, style, local, &mut seq, (sl.x, sl.z), sl.street, sl.along);
                        local += 1;
                        houses += 1;
                        done = true;
                        break;
                    }
                }
                if done {
                    break;
                }
            }
            if !done && !required {
                cursor = (cursor + 13) % n.max(1);
            }
            cursor = (cursor + 5) % n.max(1);
            // Top up to the spec's minimum for the settlement size with
            // small houses (bounded: a cramped site may stay below it).
            if ri == roles.len() && houses < min_count && extra < 24 {
                roles.push(role::HOUSE);
                extra += 1;
            }
        }

        // Market stalls inside the square, facing its centre, clear of the
        // street mouths; then the bounty board and the well.
        let n_stalls = 1 + size as usize;
        let mut stall_angles: Vec<f64> = Vec::new();
        let base = seq.range(0.0, TAU);
        // Keep the doorways of buildings facing the square clear: no stall,
        // board or well in front of an inn or forge door.
        let doors: Vec<(f64, f64)> = t.buildings[set_first_building as usize..]
            .iter()
            .filter(|b| b.street == NONE && b.floors > 0)
            .map(|b| (libm::atan2(b.front_z - s.z, b.front_x - s.x), (b.door_w * 0.5 + 3.0) / square))
            .collect();
        let mut k = 0;
        while stall_angles.len() < n_stalls + 2 && k < 48 {
            let ang = base + k as f64 * TAU / 48.0;
            k += 1;
            if angles.iter().any(|&a| ang_diff(a, ang) < 0.55)
                || stall_angles.iter().any(|&a| ang_diff(a, ang) < 0.6)
                || doors.iter().any(|&(a, h)| ang_diff(a, ang) < h + 0.12)
            {
                continue;
            }
            stall_angles.push(ang);
        }
        for (i, &ang) in stall_angles.iter().enumerate() {
            let (cs, sn) = (libm::cos(ang), libm::sin(ang));
            let rr = square - 2.6;
            let (x, z) = (s.x + cs * rr, s.z + sn * rr);
            if i < n_stalls {
                // Front (-v) faces the square's centre: v axis points outward.
                let o = Obb {
                    cx: x,
                    cz: z,
                    c: sn,
                    s: -cs,
                    hx: 1.6,
                    hz: 1.1,
                };
                let mut seq2 = Seq::new(a.seed ^ s.seed as u64, stream::LAYOUT + 1 + i as u64);
                kit::build(
                    &mut ctx,
                    t,
                    &o,
                    role::STALL,
                    style,
                    local,
                    &mut seq2,
                    (s.x + cs * (rr - 3.0), s.z + sn * (rr - 3.0)),
                    NONE,
                    0.0,
                );
                local += 1;
            } else if i == n_stalls {
                town_prop(
                    &mut ctx,
                    t,
                    &ter,
                    x,
                    z,
                    ang + core::f64::consts::PI,
                    pk::BOARD,
                    0,
                    pf::INTERACT,
                    Some((0.9, 0.15, 2.2)),
                );
            } else {
                town_prop(&mut ctx, t, &ter, x, z, ang, pk::WELL, 0, 0, Some((0.8, 0.8, 0.9)));
            }
        }
        // Lanterns along the streets (spec 8) every 14 m, alternating sides.
        for &ang in &angles {
            let (dx, dz) = (libm::cos(ang), libm::sin(ang));
            let mut d = square + 4.0;
            let mut side = 1.0;
            while d < r - 2.0 {
                let off = street_w * 0.5 + 0.5;
                let (x, z) = (s.x + dx * d - dz * off * side, s.z + dz * d + dx * off * side);
                if !placed.iter().any(|p| p.contains(x, z, 0.3)) {
                    town_prop(&mut ctx, t, &ter, x, z, ang, pk::LANTERN, 0, pf::LIGHT, None);
                }
                side = -side;
                d += 14.0;
            }
        }
        if walled {
            town_wall(&mut ctx, t, &ter, s.x, s.z, r - 2.0, &angles, street_w, su);
        }

        let building_count = t.buildings.len() as u16 - set_first_building;
        t.settlements.push(Settlement {
            id: s.id,
            site: site_i as u16,
            size,
            style,
            walled,
            x: s.x,
            y: cy,
            z: s.z,
            radius: r,
            square,
            building_first: set_first_building,
            building_count,
            npc_first: 0,
            npc_count: 0,
            prop_first,
            prop_count: t.props.len() as u32 - prop_first,
            box_first,
            box_count: t.boxes.len() as u32 - box_first,
            road_first,
            road_count: t.roads.len() as u16 - road_first,
            region: s.region,
        });
        npc::populate(a, si, t);
    }
}

fn line_points(ter: &Terrain, ax: f64, az: f64, bx: f64, bz: f64) -> Vec<[f64; 3]> {
    let l = dist(ax, az, bx, bz);
    let n = (libm::ceil(l / 4.0) as usize).max(1);
    (0..=n)
        .map(|k| {
            let f = k as f64 / n as f64;
            let (x, z) = (ax + (bx - ax) * f, az + (bz - az) * f);
            [x, ter.sample(x, z).0, z]
        })
        .collect()
}

/// An outdoor prop owned by the settlement, with an optional solid box
/// (half u, half v, height).
#[allow(clippy::too_many_arguments)]
fn town_prop(c: &mut Ctx, t: &mut Towns, ter: &Terrain, x: f64, z: f64, yaw: f64, kind: u8, variant: u8, flags: u8, solid: Option<(f64, f64, f64)>) {
    let y = ter.height(x, z);
    t.props.push(Prop {
        id: stable_id(layer::PROP, c.site as i32, 0, *c.prop_n),
        x: x as f32,
        y: y as f32,
        z: z as f32,
        yaw: yaw16(yaw),
        kind,
        variant,
        building: NONE,
        settlement: c.settlement,
        flags,
        scale: 64,
        structure: NONE,
    });
    *c.prop_n += 1;
    if let Some((hu, hv, h)) = solid {
        let o = Obb::new(x, z, yaw, hu, hv);
        let sp = ter.span(&o, 0.0);
        // Solid only (no walkable top): see kit::furn on hard edges.
        push_flat(&mut t.boxes, &o, sp.min - 0.5, sp.max + h, bk::TOWN_PROP, bf::SOLID, c.settlement);
    }
}

/// Town wall (walled towns, spec 5): a polygon of solid segments with a gap
/// and two gate towers where each street leaves.
#[allow(clippy::too_many_arguments)]
fn town_wall(c: &mut Ctx, t: &mut Towns, ter: &Terrain, x: f64, z: f64, rw: f64, streets: &[f64], street_w: f64, su: u16) {
    let n = 32;
    let gate_half = (street_w * 0.5 + 2.2) / rw;
    for k in 0..n {
        let a0 = k as f64 / n as f64 * TAU;
        let a1 = (k + 1) as f64 / n as f64 * TAU;
        let (p0, p1) = (
            (x + rw * libm::cos(a0), z + rw * libm::sin(a0)),
            (x + rw * libm::cos(a1), z + rw * libm::sin(a1)),
        );
        // Trim the segment around gates: sample its parametric range.
        let mut lo = 0.0;
        let mut hi = 1.0;
        let mut skip = false;
        for &g in streets {
            let d0 = signed_diff(a0, g);
            let d1 = signed_diff(a1, g);
            if d0.abs() < gate_half && d1.abs() < gate_half {
                skip = true;
            } else if d0.abs() < gate_half {
                lo = ((gate_half - d0.abs()) / (a1 - a0)).clamp(0.0, 1.0);
            } else if d1.abs() < gate_half {
                hi = 1.0 - ((gate_half - d1.abs()) / (a1 - a0)).clamp(0.0, 1.0);
            } else if d0 < 0.0 && d1 > 0.0 {
                // The gate sits strictly inside this segment.
                let m = (-d0) / (a1 - a0);
                let gw = gate_half / (a1 - a0);
                seg_box(t, ter, p0, p1, 0.0, (m - gw).max(0.0), su);
                lo = (m + gw).min(1.0);
            }
        }
        if !skip && hi - lo > 0.05 {
            seg_box(t, ter, p0, p1, lo, hi, su);
        }
    }
    // Gate towers.
    for &g in streets {
        for side in [-1.0, 1.0] {
            let ang = g + side * (gate_half + 1.6 / rw);
            let (tx, tz) = (x + rw * libm::cos(ang), z + rw * libm::sin(ang));
            let o = Obb::new(tx, tz, ang, 1.6, 1.6);
            let sp = ter.span(&o, 0.0);
            push_flat(&mut t.boxes, &o, sp.min - 1.0, sp.max + 7.0, bk::GATE, bf::SOLID | bf::WALK, su);
            let y = sp.max + 7.0;
            t.props.push(Prop {
                id: stable_id(layer::PROP, c.site as i32, 0, *c.prop_n),
                x: tx as f32,
                y: y as f32,
                z: tz as f32,
                yaw: yaw16(ang),
                kind: pk::BRAZIER,
                variant: 0,
                building: NONE,
                settlement: su,
                flags: pf::LIGHT,
                scale: 64,
                structure: NONE,
            });
            *c.prop_n += 1;
        }
    }
}

fn signed_diff(a: f64, b: f64) -> f64 {
    let mut d = (a - b) % TAU;
    if d > core::f64::consts::PI {
        d -= TAU;
    }
    if d < -core::f64::consts::PI {
        d += TAU;
    }
    d
}

fn seg_box(t: &mut Towns, ter: &Terrain, p0: (f64, f64), p1: (f64, f64), lo: f64, hi: f64, su: u16) {
    let (ax, az) = (p0.0 + (p1.0 - p0.0) * lo, p0.1 + (p1.1 - p0.1) * lo);
    let (bx, bz) = (p0.0 + (p1.0 - p0.0) * hi, p0.1 + (p1.1 - p0.1) * hi);
    let l = dist(ax, az, bx, bz);
    if l < 0.5 {
        return;
    }
    let yaw = libm::atan2(bz - az, bx - ax);
    let o = Obb::new((ax + bx) * 0.5, (az + bz) * 0.5, yaw, l * 0.5 + 0.4, 0.8);
    let sp = ter.span(&o, 0.0);
    push_flat(&mut t.boxes, &o, sp.min - 1.0, sp.max + 4.5, bk::TOWN_WALL, bf::SOLID | bf::WALK, su);
    let _ = ROAD_WIDTH;
}
