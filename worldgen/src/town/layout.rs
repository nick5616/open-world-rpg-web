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
use super::paths;
use super::roads::{ang_diff, Net, ROAD_WIDTH};
use super::{bf, bk, layer, npc, pf, pk, role, stream, Prop, Road, Settlement, Towns};
use crate::atlas::format::{sec, site, Atlas, SITE_REC};
use crate::rng::{stable_id, Seq};

const NONE: u16 = 0xFFFF;
const TAU: f64 = 2.0 * core::f64::consts::PI;

/// genVersion 2 layout scale (playtest 1 "too spread out, even in the
/// towns"); genVersion 1 had squares 9 / 13 / 18 m, streets 4 / 4 / 5 m,
/// lots 0.8 m off the street, 1.6 m between lots, back lane 10 m behind, a
/// ring street at most 28 m out and the whole atlas radius.
const SQUARE: [f64; 3] = [7.0, 9.0, 12.0];
/// Layout radius / atlas radius per size (hamlet, village, town).
pub const LAYOUT_SCALE: [f64; 3] = [0.8, 0.7, 0.85];
const STREET_W: [f64; 3] = [3.0, 3.4, 4.6];
/// Lot front to street edge (m).
const FRONT_GAP: f64 = 0.5;
/// Pad added to both lots in the overlap test: alleys are 2 x PLOT_PAD wide.
const PLOT_PAD: f64 = 0.6;
/// Back-lane lots start this far behind the street edge.
const BACK_ROW: f64 = 7.5;
const RING_MAX: f64 = 18.0;

/// Room a lot keeps in front of its door wall on this ground: a porch (2 m)
/// where the style has porches or the door is high above the ground, and the
/// door ramp or steps (kit::stair_len), measured from the lowest ground along
/// the front edge (the door's place along it is not known yet). On a street
/// the steps may run over the lot's front gap and a quarter of the street;
/// a back-lane lot faces the back of another lot instead, so it keeps the
/// whole flight plus room for the footpath to pass.
fn front_need(ter: &Terrain, o: &Obb, rl: u8, style: u8, street_w: f64, back_lane: bool) -> f64 {
    if matches!(rl, role::STALL | role::GARDEN) {
        return 0.0;
    }
    // Estimated floor: the highest of the corners and the centre (the kit
    // uses the whole lattice under the lot; this is only a reservation).
    let mut top = ter.height(o.cx, o.cz);
    for (x, z) in o.corners() {
        top = top.max(ter.height(x, z));
    }
    let lift = if style == kit::STYLE_STILT { 1.4 } else { 0.35 };
    let floor = top + lift;
    let mut g = f64::INFINITY;
    for u in [-0.45, 0.0, 0.45] {
        let (x, z) = o.at(u * o.hx, -o.hz - 0.6);
        g = g.min(ter.height(x, z));
    }
    let rise = floor - g;
    let porch = kit::has_porches(style) || rise > kit::PORCH_RISE;
    let mut need = if porch && rl != role::FORGE { 2.0 } else { 0.0 };
    let allowance = if back_lane { -1.6 } else { FRONT_GAP + 0.25 * street_w };
    if rise > 0.3 {
        need += (kit::stair_len(rise) - allowance).max(0.0);
    } else if back_lane {
        need += 1.6;
    }
    need.min(10.0)
}

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
    for (si, &site_i) in net.sites.iter().enumerate() {
        let s = a.site(site_i);
        // Lattice memo over the atlas footprint plus room for steps, walls
        // and gate towers (genVersion 2: every lot is measured on the ground).
        let ter = Terrain::around(a, s.x, s.z, s.radius + 16.0);
        settle(a, site_i, si, net.entries[si].clone(), ter, t);
    }
}

/// genVersion 3 (docs/cr/038-vertical-world.md): sky towns, laid out exactly
/// like a surface settlement but on their island's top (no roads reach
/// them), after everything else so every surface array keeps its indices.
/// Their square holds an activity spot (prop ACTIVITY) for sky activities.
pub fn build_sky_settlements(a: &Atlas, t: &mut Towns) {
    let Ok(v) = crate::vertical::world(a) else { return };
    for site_i in 0..a.site_count() {
        let s = a.site(site_i);
        if s.category != site::CAT_SETTLEMENT || s.layer != crate::vertical::LAYER_SKY {
            continue;
        }
        let Some(isl) = v.plan.islands.iter().position(|i| i.site as usize == site_i) else { continue };
        let ter = Terrain::sky(a, v.clone(), isl);
        let si = t.settlements.len();
        settle(a, site_i, si, Vec::new(), ter, t);
    }
}

/// genVersion 4 (docs/cr/043-dwarves.md): the dwarves' camps and strongholds,
/// laid out like a surface settlement on their chamber's floor (dwarven
/// style, no roads), after the sky towns so every earlier array keeps its
/// indices.
pub fn build_under_settlements(a: &Atlas, t: &mut Towns) {
    let Ok(v) = crate::vertical::world(a) else { return };
    for site_i in 0..a.site_count() {
        let s = a.site(site_i);
        if s.category != site::CAT_SETTLEMENT || s.layer != crate::vertical::LAYER_UNDER {
            continue;
        }
        if !v.plan.chambers.iter().any(|c| c.site as usize == site_i) {
            continue;
        }
        let ter = Terrain::under(a, v.clone());
        let si = t.settlements.len();
        settle(a, site_i, si, Vec::new(), ter, t);
    }
}

/// Lay out one settlement (site `site_i`, settlement index `si`, road
/// entries `angles`) on `ter`.
fn settle(a: &Atlas, site_i: usize, si: usize, angles_in: Vec<f64>, ter: Terrain, t: &mut Towns) {
    {
        let s = a.site(site_i);
        let biome = site_biome(a, site_i);
        let style = if ter.is_under() { kit::STYLE_DWARF } else { kit::style_of_biome(biome) };
        let mut seq = Seq::new(a.seed ^ s.seed as u64, stream::LAYOUT);
        let size = s.size.min(2);
        let walled = size == site::SIZE_TOWN;
        // genVersion 2 (playtest 1 "too spread out, even in the towns"): the
        // layout uses a tighter radius than the atlas footprint, a smaller
        // square, narrower streets and lots close to the street, so houses
        // cluster (atlas radius 45 / 80 / 130 -> 36 / 56 / 110 m).
        let r = s.radius * LAYOUT_SCALE[size as usize];
        let square = SQUARE[size as usize];
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
        let mut wall_r = 0.0;

        // Streets: one per road entry, topped up to a minimum count by
        // splitting the widest gap between them.
        let mut angles = angles_in;
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
        let street_w = STREET_W[size as usize];
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
                        clear: street_w * 0.5 + FRONT_GAP,
                    });
                }
                d += 2.0;
            }
        }
        // Ring street (villages and towns).
        if size >= site::SIZE_VILLAGE {
            // Close enough to the square that the core reads as a town, not
            // a ring of houses at the edge (towns: 46 m, villages: 41 m).
            let rr = square + ((r - square) * 0.5).min(RING_MAX);
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
                        clear: street_w * 0.5 + FRONT_GAP,
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
        // Top-up houses (below the spec's minimum) may use the whole atlas
        // footprint when the tighter layout radius is full.
        let limit_wide = if walled { s.radius - 7.0 } else { s.radius - 3.0 };
        // Cheap tests first (footprint ring, other lots, streets), then the
        // terrain under the lot.
        let clear_of = |o: &Obb, extra_back: f64, extra_front: f64, placed: &[Obb], lim: f64| -> bool {
            let full = sub(o, 0.0, (extra_back - extra_front) * 0.5, o.hx, o.hz + (extra_back + extra_front) * 0.5);
            for (x, z) in full.corners() {
                let d = dist(x, z, s.x, s.z);
                if d > lim || d < square + 1.0 {
                    return false;
                }
            }
            if dist(full.cx, full.cz, s.x, s.z) < square + 1.0 {
                return false;
            }
            if placed.iter().any(|p| p.overlaps(&full, PLOT_PAD)) {
                return false;
            }
            for &(ax, az, bx, bz, hw) in &segs {
                if !full.seg_clear(ax, az, bx, bz, hw + 0.4) {
                    return false;
                }
            }
            true
        };
        let ground_ok = |o: &Obb, extra_back: f64, tol: f64| -> bool {
            let sp = ter.span(o, 0.6);
            // Stilt houses (wetland) may stand in shallow water (genVersion 2:
            // the ground under a wetland hamlet is no longer levelled).
            let wet = sp.wet && !(style == kit::STYLE_STILT && sp.max_water - sp.min < kit::STILT_WADE);
            if wet || sp.max - sp.min > tol {
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
                if ter.is_under() { role::WORKSHOP } else { role::FARM }
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
                clear: sl.clear + BACK_ROW,
            })
            .collect();
        let mut ctx = Ctx {
            ter: &ter,
            site: site_i,
            settlement: su,
            prop_n: &mut prop_n,
        };
        let mut local = 0u32;
        // Houses fill the plots nearest the square first (6 m distance bands,
        // streets interleaved within a band by a hash of the slot), so towns
        // grow a dense core with fields and open ground toward the edge.
        let band = |sl: &Slot| (dist(sl.x, sl.z, s.x, s.z) / 6.0) as i64;
        let mut by_dist: Vec<usize> = (0..slots.len()).collect();
        by_dist.sort_by_key(|&i| (band(&slots[i]), crate::rng::mix64(i as u64 ^ s.seed as u64)));
        // Plot tolerance passes: lattice range under the footprint (m),
        // whether back-lane plots are allowed, which roles may use the pass
        // (0 all, 1 inn and forge, 2 inn, forge and ward garden), whether
        // the whole atlas footprint may be used, and whether the lot keeps
        // its front room for a porch and steps. Required buildings get
        // steep passes (their floor then sits on a taller foundation), then
        // the wider footprint, then steps that may run into the street.
        const PASSES: [(f64, bool, u8, bool, bool); 6] = [
            (2.4, false, 0, false, true),
            (3.4, true, 0, false, true),
            (4.6, true, 0, false, true),
            (7.0, true, 1, false, true),
            (7.0, true, 2, true, true),
            (9.0, false, 2, true, false),
        ];
        let min_count = [4usize, 10, 30][size as usize];
        let mut houses = 0usize;
        let mut extra = 0usize;
        let mut ri = 0usize;
        let planned = roles.len();
        while ri < roles.len() {
            let rl = roles[ri];
            ri += 1;
            let (w0, d0) = kit::footprint(rl, style, &mut seq);
            let back = kit::field_depth(rl);
            let required = matches!(rl, role::INN | role::FORGE);
            // Essential: the inn, forge and ward garden, and the top-up houses
            // that bring a settlement to the spec's minimum.
            let essential = required || rl == role::GARDEN || ri > planned;
            let mut done = false;
            // A required building that found no lot tries once more at 75 %
            // of its footprint (every settlement has an inn, a forge and a
            // ward garden).
            for attempt in 0..2 {
                if done || (attempt == 1 && !essential) {
                    break;
                }
                let k = if attempt == 0 { 1.0 } else { 0.75 };
                let (w, d) = (w0 * k, d0 * k);
                for &(tol, use_back, who, wide, keep_front) in PASSES.iter() {
                    if (who == 1 && !required) || (who == 2 && !essential) {
                        break;
                    }
                    let lim = if wide || ri > planned { limit_wide } else { limit };
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
                        order.extend(by_dist.iter().map(|&i| &slots[i]));
                        order.extend(square_slots.iter());
                        if use_back {
                            order.extend(by_dist.iter().map(|&i| &back_slots[i]));
                        }
                    }
                    for sl in order {
                        // The lot sits back from the street by what its front
                        // needs on this ground: a porch and the door steps
                        // (genVersion 2: towns on natural terrain), re-measured
                        // once at the shifted spot.
                        let plot = |front: f64| -> Obb {
                            let k = sl.clear + front + d * 0.5;
                            Obb {
                                cx: sl.x + sl.nx * k,
                                cz: sl.z + sl.nz * k,
                                c: sl.nz,
                                s: -sl.nx,
                                hx: w * 0.5,
                                hz: d * 0.5,
                            }
                        };
                        let o0 = plot(0.0);
                        if !clear_of(&o0, back, 0.0, &placed, lim) {
                            continue;
                        }
                        let room = if keep_front { 1.0 } else { 0.0 };
                        let lane = sl.clear > street_w * 0.5 + FRONT_GAP + 1.0 && sl.street != NONE;
                        let mut front = room * front_need(&ter, &o0, rl, style, street_w, lane);
                        let mut o = plot(front);
                        let again = room * front_need(&ter, &o, rl, style, street_w, lane);
                        if again > front + 0.3 {
                            front = again;
                            o = plot(front);
                        }
                        if clear_of(&o, back, front, &placed, lim) && ground_ok(&o, back, tol) {
                            placed.push(sub(&o, 0.0, (back - front) * 0.5, o.hx, o.hz + (back + front) * 0.5));
                            kit::build(&mut ctx, t, &o, rl, style, local, &mut seq, (sl.x, sl.z), sl.street, sl.along);
                            local += 1;
                            // The spec's counts leave out stalls and ward gardens.
                            houses += (rl != role::GARDEN) as usize;
                            done = true;
                            break;
                        }
                    }
                    if done {
                        break;
                    }
                }
            }
            // Top up to the spec's minimum for the settlement size with
            // small houses (bounded: a cramped site may stay below it).
            if ri == roles.len() && houses < min_count && extra < 40 {
                roles.push(role::HOUSE);
                extra += 1;
            }
        }

        // Square furniture, in priority order: the bounty board (its keeper
        // depends on it), the market stalls, the well. Each takes the first
        // free angle on a ring inside the square that is clear of the street
        // mouths, of the doorways of buildings facing the square, and of the
        // others; constraints relax in passes so small squares still fit the
        // required pieces. A well that finds no room stands nearer the middle.
        let n_stalls = 1 + size as usize;
        let base = seq.range(0.0, TAU);
        let doors: Vec<(f64, f64)> = t.buildings[set_first_building as usize..]
            .iter()
            .filter(|b| b.street == NONE && b.floors > 0)
            .map(|b| (libm::atan2(b.front_z - s.z, b.front_x - s.x), (b.door_w * 0.5 + 3.0) / square))
            .collect();
        let rr = square - 2.6;
        let mut taken: Vec<f64> = Vec::new();
        let mut items: Vec<u8> = vec![pk::BOARD];
        items.extend(std::iter::repeat_n(pk::STALL, n_stalls));
        items.push(if ter.is_under() { pk::BRAZIER } else { pk::WELL });
        if ter.is_under() {
            items.extend([pk::MINECART, pk::MINECART, pk::ORE_PILE]);
        }
        if ter.is_sky() {
            items.push(pk::ACTIVITY);
        }
        const SQUARE_PASSES: [(f64, f64, f64); 3] = [(0.55, 1.0, 0.6), (0.4, 0.5, 0.45), (0.28, 0.0, 0.34)];
        for (i, &item) in items.iter().enumerate() {
            let mut found = None;
            'passes: for &(street_gap, door_k, spacing) in &SQUARE_PASSES {
                for k in 0..48 {
                    let ang = base + k as f64 * TAU / 48.0;
                    if angles.iter().any(|&a| ang_diff(a, ang) < street_gap)
                        || taken.iter().any(|&a| ang_diff(a, ang) < spacing)
                        || doors.iter().any(|&(a, h)| ang_diff(a, ang) < (h + 0.12) * door_k)
                    {
                        continue;
                    }
                    found = Some(ang);
                    break 'passes;
                }
            }
            let (ang, r_at) = match (found, item) {
                (Some(a), _) => (a, rr),
                // The well: halfway out, midway between the first two streets.
                (None, pk::WELL) => {
                    let a0 = angles[0];
                    let a1 = if angles.len() > 1 { angles[1] } else { a0 + TAU };
                    ((a0 + a1) * 0.5, (square * 0.45).max(3.2))
                }
                (None, _) => continue,
            };
            taken.push(ang);
            let (cs, sn) = (libm::cos(ang), libm::sin(ang));
            let (x, z) = (s.x + cs * r_at, s.z + sn * r_at);
            match item {
                pk::STALL => {
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
                    let front = (s.x + cs * (r_at - 3.0), s.z + sn * (r_at - 3.0));
                    kit::build(&mut ctx, t, &o, role::STALL, style, local, &mut seq2, front, NONE, 0.0);
                    local += 1;
                }
                pk::BOARD => {
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
                }
                pk::ACTIVITY => town_prop(&mut ctx, t, &ter, x, z, ang + core::f64::consts::PI, pk::ACTIVITY, 0, pf::INTERACT, None),
                pk::BRAZIER => town_prop(&mut ctx, t, &ter, x, z, ang, pk::BRAZIER, 0, pf::LIGHT, Some((0.7, 0.7, 1.0))),
                pk::MINECART => town_prop(&mut ctx, t, &ter, x, z, ang, pk::MINECART, 0, 0, Some((1.0, 0.6, 0.9))),
                pk::ORE_PILE => town_prop(&mut ctx, t, &ter, x, z, ang, pk::ORE_PILE, 0, 0, Some((0.8, 0.8, 0.8))),
                _ => town_prop(&mut ctx, t, &ter, x, z, ang, pk::WELL, 0, 0, Some((0.8, 0.8, 0.9))),
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
            // The wall hugs what was built (14 m beyond the farthest plot
            // corner, fields included) rather than the whole atlas footprint,
            // so a town reads as walled and the outskirts stay open; streets
            // run on past the gates to meet the roads at the footprint edge.
            let extent = placed.iter().flat_map(|o| o.corners()).map(|(x, z)| dist(x, z, s.x, s.z)).fold(0.0, f64::max);
            let rw = (extent + 14.0).clamp(square + 30.0, r - 2.0);
            town_wall(&mut ctx, t, &ter, s.x, s.z, rw, &angles, street_w, su);
            wall_r = rw;
        }

        // Footpaths from every door, gate and stand to the streets and the
        // square (genVersion 2, playtest 1 "paths to get everywhere").
        paths::build(
            a,
            t,
            &paths::Town {
                settlement: su,
                x: s.x,
                z: s.z,
                r: r + 4.0,
                square,
                wade: if style == kit::STYLE_STILT { kit::STILT_WADE } else { 0.4 },
                building_first: set_first_building as usize,
                box_first: box_first as usize,
                prop_first: prop_first as usize,
                streets: &segs,
            },
        );
        let building_count = t.buildings.len() as u16 - set_first_building;
        t.settlements.push(Settlement {
            id: s.id,
            site: site_i as u16,
            size,
            style,
            walled,
            wall_r,
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
