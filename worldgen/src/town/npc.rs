//! Townsfolk (spec 5 / 8): who lives in each settlement, where they work by
//! day and sleep at night. The zone runs the schedules
//! (server/zone/internal/npc); the generator only fixes the people, their
//! stable ids, homes, work spots and names, so every host agrees on them.

use super::{layer, nrole, pk, role, stream, Npc, Towns};
use crate::atlas::format::Atlas;
use crate::rng::{stable_id, Seq};

const NONE: u16 = 0xFFFF;

const FIRST: [&str; 28] = [
    "Al", "Bre", "Cor", "Dar", "El", "Fen", "Gar", "Hal", "Ise", "Jor", "Kel", "Lio", "Mar", "Nes", "Or", "Pel", "Quil", "Ros", "Sel", "Tam", "Ul", "Ver",
    "Wyn", "Yse", "Bram", "Cael", "Dun", "Eir",
];
const LAST: [&str; 18] = [
    "a", "en", "ric", "wyn", "dra", "mir", "tha", "dor", "ia", "os", "elle", "an", "ik", "ra", "eth", "ow", "ina", "us",
];

fn name(seq: &mut Seq) -> String {
    let mut s = String::from(*seq.pick(&FIRST));
    s.push_str(seq.pick(&LAST));
    s
}

/// Dwarven townsfolk (genVersion 4, Underground settlements).
const D_FIRST: [&str; 14] = ["Bor", "Dag", "Thra", "Hild", "Gund", "Orm", "Brok", "Ysa", "Rag", "Kolm", "Torv", "Nid", "Falk", "Jarn"];
const D_LAST: [&str; 12] = ["a", "in", "un", "ek", "ild", "rim", "dal", "mund", "ra", "vik", "gar", "ur"];

fn dwarf_name(seq: &mut Seq) -> String {
    let mut s = String::from(*seq.pick(&D_FIRST));
    s.push_str(seq.pick(&D_LAST));
    s
}

fn add_name(t: &mut Towns, n: String) -> u16 {
    t.names.push(n);
    (t.names.len() - 1) as u16
}

/// Interior spot of a building in world coordinates (local u, v).
fn spot(t: &Towns, b: usize, u: f64, v: f64) -> (f64, f64) {
    let bd = &t.buildings[b];
    (bd.x + u * bd.c - v * bd.s, bd.z + u * bd.s + v * bd.c)
}

/// Create the NPCs of settlement `si` (its buildings and props exist).
pub fn populate(a: &Atlas, si: usize, t: &mut Towns) {
    let st = t.settlements[si].clone();
    let mut seq = Seq::new(a.seed ^ st.id, stream::NPC);
    let first = t.npcs.len() as u16;
    let b0 = st.building_first as usize;
    let b1 = b0 + st.building_count as usize;
    let houses: Vec<usize> = (b0..b1).filter(|&b| matches!(t.buildings[b].role, role::HOUSE | role::FARM)).collect();
    let home_of = |k: usize| -> usize {
        if houses.is_empty() {
            NONE as usize
        } else {
            houses[k % houses.len()]
        }
    };
    let mut people: Vec<Npc> = Vec::new();
    let mut k = 0usize;
    let site = st.site as i32;
    // genVersion 4: Underground settlements are the dwarves' (names, and the
    // merchants' stock indices 4 and 5: mining gear, ore broker).
    let dwarf = a.site(st.site as usize).layer == crate::vertical::LAYER_UNDER;
    let push =
        |t: &mut Towns, seq: &mut Seq, people: &mut Vec<Npc>, rl: u8, work: u16, work_prop: u16, wx: f64, wz: f64, wyaw: u16, merchant: u8, home: usize| {
            let nm = add_name(t, if dwarf { dwarf_name(seq) } else { name(seq) });
            let (hx, hz) = if home != NONE as usize {
                let hb = &t.buildings[home];
                let n = people.iter().filter(|p| p.home == home as u16).count() as f64;
                spot(t, home, -hb.hx * 0.35 + n * 0.8, hb.hz * 0.1)
            } else {
                (wx, wz)
            };
            people.push(Npc {
                id: stable_id(layer::NPC, site, rl as i32, people.len() as u32),
                settlement: si as u16,
                role: rl,
                variant: (seq.next_u64() >> 56) as u8,
                name: nm,
                home: if home == NONE as usize { NONE } else { home as u16 },
                work,
                work_prop,
                work_x: wx,
                work_z: wz,
                home_x: hx,
                home_z: hz,
                work_yaw: wyaw,
                merchant,
            });
        };
    for b in b0..b1 {
        let bd = t.buildings[b].clone();
        let yaw_in = super::geom::yaw16(libm::atan2(bd.s, bd.c) + core::f64::consts::FRAC_PI_2);
        let prop_of = |t: &Towns, kind: u8| -> u16 {
            (bd.prop_first..bd.prop_first + bd.prop_count as u32)
                .find(|&p| t.props[p as usize].kind == kind)
                .map(|p| p as u16)
                .unwrap_or(NONE)
        };
        match bd.role {
            role::FORGE => {
                let (x, z) = spot(t, b, 0.2, bd.hz * 0.1 - 0.9);
                let wp = prop_of(t, pk::ANVIL);
                push(t, &mut seq, &mut people, nrole::BLACKSMITH, b as u16, wp, x, z, yaw_in, 255, home_of(k));
                k += 1;
            }
            role::INN => {
                // Behind the counter, which runs along the +u side.
                let (x, z) = spot(t, b, bd.hx - 0.3 - 0.55, bd.hz * 0.15);
                let wp = prop_of(t, pk::COUNTER);
                let yaw = super::geom::yaw16(libm::atan2(-bd.s, -bd.c));
                // The innkeeper lives at the inn.
                push(t, &mut seq, &mut people, nrole::INNKEEPER, b as u16, wp, x, z, yaw, 255, b);
            }
            role::STALL => {
                // Behind the counter (+v side of the stall).
                let (x, z) = spot(t, b, 0.0, 0.3);
                let wp = prop_of(t, pk::STALL);
                let yaw = super::geom::yaw16(libm::atan2(-bd.c, bd.s));
                let merchant = (people.iter().filter(|p| p.role == nrole::MERCHANT).count() % 4) as u8;
                let merchant = if dwarf { 4 + merchant % 2 } else { merchant };
                push(t, &mut seq, &mut people, nrole::MERCHANT, b as u16, wp, x, z, yaw, merchant, home_of(k));
                k += 1;
            }
            role::FARM => {
                let (x, z) = spot(t, b, 0.0, bd.hz + 4.0);
                push(t, &mut seq, &mut people, nrole::FARMER, NONE, NONE, x, z, yaw_in, 255, b);
            }
            _ => {}
        }
    }
    // The bounty keeper stands beside the board.
    let p0 = st.prop_first as usize;
    let p1 = p0 + st.prop_count as usize;
    if let Some(bp) = (p0..p1).find(|&p| t.props[p].kind == pk::BOARD) {
        let pr = t.props[bp];
        let yaw = pr.yaw as f64 / 65536.0 * 2.0 * core::f64::consts::PI;
        let (x, z) = (
            pr.x as f64 + libm::cos(yaw) * 1.4 - libm::sin(yaw) * 1.2,
            pr.z as f64 + libm::sin(yaw) * 1.4 + libm::cos(yaw) * 1.2,
        );
        push(t, &mut seq, &mut people, nrole::BOUNTY, NONE, bp as u16, x, z, pr.yaw, 255, home_of(k));
        k += 1;
    }
    // Villagers: one per house not yet home to someone, capped by size,
    // working around the square or their own doorstep.
    let cap = [3usize, 7, 12][st.size as usize];
    let mut v = 0;
    for &h in &houses {
        if v >= cap {
            break;
        }
        if people.iter().any(|p| p.home == h as u16) {
            continue;
        }
        let bd = t.buildings[h].clone();
        let (x, z) = if v % 2 == 0 {
            let ang = seq.range(0.0, 2.0 * core::f64::consts::PI);
            let r = st.square * seq.range(0.35, 0.8);
            (st.x + r * libm::cos(ang), st.z + r * libm::sin(ang))
        } else {
            (bd.front_x * 0.7 + bd.x * 0.3, bd.front_z * 0.7 + bd.z * 0.3)
        };
        let yaw = super::geom::yaw16(seq.range(0.0, core::f64::consts::TAU));
        push(t, &mut seq, &mut people, nrole::VILLAGER, NONE, NONE, x, z, yaw, 255, h);
        v += 1;
    }
    // Walled towns post two guards inside their first gate.
    if st.walled {
        let (ga, gb) = (st.road_first as usize, st.road_first as usize + 1);
        for (g, ri) in [ga, gb].iter().enumerate() {
            let rd = &t.roads[*ri];
            if rd.class != 1 || rd.points.len() < 3 {
                continue;
            }
            // 5 m inside the gate, 3 m to either side of the street, facing in.
            let e = rd.points[rd.points.len() - 1];
            let (dx, dz) = (e[0] - st.x, e[2] - st.z);
            let l = libm::sqrt(dx * dx + dz * dz).max(1e-6);
            let d = (st.wall_r - 5.0).max(st.square + 4.0);
            let p = [st.x + dx / l * d, st.z + dz / l * d];
            let yaw = super::geom::yaw16(libm::atan2(st.z - p[1], st.x - p[0]));
            let side = if g == 0 { 3.0 } else { -3.0 };
            let (x, z) = (p[0] - dz / l * side, p[1] + dx / l * side);
            push(t, &mut seq, &mut people, nrole::GUARD, NONE, NONE, x, z, yaw, 255, home_of(k));
            k += 1;
        }
    }
    let n = people.len() as u16;
    t.npcs.extend(people);
    t.settlements[si].npc_first = first;
    t.settlements[si].npc_count = n;
}
