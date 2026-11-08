//! Building kits and the shape grammar (spec 5 "buildings from a kit").
//!
//! Each biome has a style; the grammar picks a footprint, floors, roof, door,
//! porch and chimney from that style and the building's role, emits the
//! collision boxes (floor slab, walls split around the door, the block above
//! the ground-floor ceiling, two sloped roof halves, a door ramp, a porch)
//! and fills the interior from the role's furniture set. Renderers assemble
//! meshes from the same record (worldgen/README.md "Towns"); collision and
//! visuals derive from the same numbers, so what you see is what you bump.
//!
//! Building frame: local u along the frontage, local v away from the street;
//! the front wall (with the door) is always the -v wall.

use super::geom::{push_flat, push_ramp, quarter, sub, wall, yaw16, Obb, Terrain};
use super::{bf, bflag, bk, layer, pf, pk, role, roof, Building, Prop, Towns};
use crate::rng::{stable_id, Seq};

/// Styles: one per biome (meadow cottage, forest timber, highland stone,
/// snowpeak log cabin, badlands adobe, wetland stilt house).
pub const STYLE_COTTAGE: u8 = 5;
pub const STYLE_TIMBER: u8 = 0;
pub const STYLE_STONE: u8 = 1;
pub const STYLE_ADOBE: u8 = 2;
pub const STYLE_STILT: u8 = 3;
pub const STYLE_LOG: u8 = 4;
pub const STYLE_NAMES: [&str; 6] = ["timber", "stone", "adobe", "stilt", "log", "cottage"];

/// Biome id (atlas) -> style.
pub fn style_of_biome(b: u8) -> u8 {
    match b {
        0 => STYLE_COTTAGE,
        1 => STYLE_TIMBER,
        2 => STYLE_STONE,
        3 => STYLE_LOG,
        4 => STYLE_ADOBE,
        5 => STYLE_STILT,
        _ => STYLE_TIMBER,
    }
}

/// Footprint (width along the frontage, depth) for a role, before fitting.
pub fn footprint(r: u8, style: u8, seq: &mut Seq) -> (f64, f64) {
    let (w, d) = match r {
        role::INN => (seq.range(11.0, 13.5), seq.range(9.0, 10.5)),
        role::FORGE => (seq.range(7.5, 9.0), seq.range(6.5, 7.5)),
        role::STALL => (3.2, 2.2),
        role::GARDEN => (seq.range(7.0, 10.0), seq.range(6.0, 8.0)),
        role::WORKSHOP => (seq.range(6.0, 8.0), seq.range(6.0, 7.5)),
        role::STOREHOUSE => (seq.range(7.0, 9.5), seq.range(5.0, 6.5)),
        role::FARM => (seq.range(6.5, 8.5), seq.range(5.5, 7.0)),
        _ => (seq.range(5.5, 8.5), seq.range(5.0, 7.5)),
    };
    if style == STYLE_LOG {
        (w * 0.92, d * 0.92)
    } else {
        (w, d)
    }
}

/// Extra depth a role needs behind the building (farm fields).
pub fn field_depth(r: u8) -> f64 {
    if r == role::FARM {
        9.0
    } else {
        0.0
    }
}

pub struct Ctx<'a, 'b> {
    pub ter: &'a Terrain<'b>,
    pub site: usize,
    pub settlement: u16,
    pub prop_n: &'a mut u32,
}

#[allow(clippy::too_many_arguments)]
fn prop(c: &mut Ctx, t: &mut Towns, bi: u16, x: f64, y: f64, z: f64, yaw: f64, kind: u8, variant: u8, flags: u8) {
    t.props.push(Prop {
        id: stable_id(layer::PROP, c.site as i32, 0, *c.prop_n),
        x: x as f32,
        y: y as f32,
        z: z as f32,
        yaw: yaw16(yaw),
        kind,
        variant,
        building: bi,
        settlement: c.settlement,
        flags,
        scale: 64,
        structure: 0xFFFF,
    });
    *c.prop_n += 1;
}

/// Build one building on plot `o` (front = -v). Returns its index.
#[allow(clippy::too_many_arguments)]
pub fn build(c: &mut Ctx, t: &mut Towns, o: &Obb, r: u8, style: u8, local: u32, seq: &mut Seq, front: (f64, f64), street: u16, along: f64) -> u16 {
    let bi = t.buildings.len() as u16;
    let yaw = libm::atan2(o.s, o.c);
    let mut flags = 0u8;
    let variant = (seq.next_u64() >> 59) as u8;
    let storey = match style {
        STYLE_STONE => 3.2,
        STYLE_LOG => 2.8,
        _ => 3.0,
    };
    let floors: u8 = match r {
        role::INN => 2,
        role::HOUSE if (style == STYLE_TIMBER || style == STYLE_STONE) && seq.unit() < 0.35 => 2,
        role::STALL | role::GARDEN => 0,
        _ => 1,
    };
    let rk = match (r, style) {
        (role::STALL, _) | (role::GARDEN, _) => roof::NONE,
        (_, STYLE_ADOBE) => roof::FLAT,
        (_, STYLE_STONE) => roof::HIP,
        _ => roof::GABLE,
    };
    let pitch = match style {
        STYLE_TIMBER => 0.62,
        STYLE_COTTAGE | STYLE_STILT => 0.68,
        STYLE_LOG => 0.5,
        _ => 0.45,
    };
    let span = o.hx.min(o.hz) * 2.0;
    let roof_h = if rk == roof::FLAT || rk == roof::NONE { 0.0 } else { span * 0.5 * pitch };
    let ridge_u = o.hx >= o.hz;
    let wt = if style == STYLE_STONE || style == STYLE_ADOBE { 0.5 } else { 0.3 };
    if r == role::FORGE || r == role::STALL {
        flags |= bflag::OPEN_FRONT;
    }
    if style == STYLE_STILT && floors > 0 {
        flags |= bflag::STILTS;
    }
    if floors > 0 && style != STYLE_ADOBE && (r != role::STOREHOUSE) && seq.unit() < 0.8 {
        flags |= bflag::CHIMNEY;
    }
    if r == role::FORGE {
        flags |= bflag::CHIMNEY;
    }
    let porch_p = match style {
        STYLE_LOG => 0.7,
        STYLE_STILT => 1.0,
        STYLE_COTTAGE => 0.3,
        _ => 0.0,
    };
    if floors > 0 && r != role::FORGE && seq.unit() < porch_p {
        flags |= bflag::PORCH;
    }
    if style == STYLE_TIMBER && floors == 2 {
        flags |= bflag::JETTY;
    }
    if r == role::FARM {
        flags |= bflag::FIELD;
    }
    let door_w = match r {
        role::FORGE => (o.hx * 2.0 - 1.4).max(2.0),
        role::INN => 1.8,
        _ => 1.4,
    };
    let door_u = if r == role::FORGE || r == role::INN || o.hx < 3.2 {
        0.0
    } else {
        [0.0, -o.hx * 0.45, o.hx * 0.45][(seq.next_u64() % 3) as usize]
    };
    let porch_d = if flags & bflag::PORCH != 0 { 2.0 } else { 0.0 };

    // Floor on the highest lattice point under the footprint (and porch),
    // so the floor is above the ground everywhere inside it.
    let fp = sub(o, 0.0, -porch_d * 0.5, o.hx, o.hz + porch_d * 0.5);
    let sp = c.ter.span(&fp, 0.0);
    let lift = if flags & bflag::STILTS != 0 { 1.4 } else { 0.25 };
    let floor_y = if floors == 0 { c.ter.height(o.cx, o.cz) } else { sp.max + lift };
    let base_y = sp.min - 0.6;
    let wall_top = floor_y + floors as f64 * storey;
    let box_first = t.boxes.len() as u32;
    let prop_first = t.props.len() as u32;

    if floors > 0 {
        push_flat(&mut t.boxes, o, base_y, floor_y, bk::FLOOR, bf::WALK | bf::SOLID, bi);
        // Walls: back, sides, and the front split around the door.
        let w0 = floor_y - 0.05;
        wall(&mut t.boxes, &sub(o, 0.0, o.hz - wt * 0.5, o.hx, wt * 0.5), w0, wall_top, bk::WALL, bi);
        wall(&mut t.boxes, &sub(o, -o.hx + wt * 0.5, 0.0, wt * 0.5, o.hz), w0, wall_top, bk::WALL, bi);
        wall(&mut t.boxes, &sub(o, o.hx - wt * 0.5, 0.0, wt * 0.5, o.hz), w0, wall_top, bk::WALL, bi);
        let (d0, d1) = (door_u - door_w * 0.5, door_u + door_w * 0.5);
        if d0 > -o.hx + 0.05 {
            let (a, b) = (-o.hx, d0);
            wall(
                &mut t.boxes,
                &sub(o, (a + b) * 0.5, -o.hz + wt * 0.5, (b - a) * 0.5, wt * 0.5),
                w0,
                wall_top,
                bk::WALL,
                bi,
            );
        }
        if d1 < o.hx - 0.05 {
            let (a, b) = (d1, o.hx);
            wall(
                &mut t.boxes,
                &sub(o, (a + b) * 0.5, -o.hz + wt * 0.5, (b - a) * 0.5, wt * 0.5),
                w0,
                wall_top,
                bk::WALL,
                bi,
            );
        }
        let lintel = floor_y + if r == role::FORGE { 2.7 } else { 2.35 };
        wall(
            &mut t.boxes,
            &sub(o, door_u, -o.hz + wt * 0.5, door_w * 0.5, wt * 0.5),
            lintel,
            wall_top,
            bk::WALL,
            bi,
        );
        // Everything above the ground-floor ceiling: a ceiling inside, a
        // walkable flat roof (adobe) or the base of the pitched roof.
        push_flat(
            &mut t.boxes,
            &sub(o, 0.0, 0.0, o.hx - wt, o.hz - wt),
            floor_y + storey,
            wall_top + 0.05,
            bk::UPPER,
            bf::WALK | bf::CEIL,
            bi,
        );
        if roof_h > 0.0 {
            let q = if ridge_u { quarter(o) } else { *o };
            // Slopes along q's u: from the eave at -hx up to the ridge, and down.
            let top = wall_top + roof_h;
            push_ramp(
                &mut t.boxes,
                &sub(&q, -q.hx * 0.5, 0.0, q.hx * 0.5, q.hz),
                wall_top - 0.3,
                wall_top,
                top,
                bk::ROOF,
                bf::WALK,
                bi,
            );
            push_ramp(
                &mut t.boxes,
                &sub(&q, q.hx * 0.5, 0.0, q.hx * 0.5, q.hz),
                wall_top - 0.3,
                top,
                wall_top,
                bk::ROOF,
                bf::WALK,
                bi,
            );
        }
        if porch_d > 0.0 {
            push_flat(
                &mut t.boxes,
                &sub(o, 0.0, -o.hz - porch_d * 0.5, o.hx, porch_d * 0.5),
                base_y,
                floor_y,
                bk::FLOOR,
                bf::WALK,
                bi,
            );
        }
        // Door ramp (or steps) from the ground in front up to the floor.
        let out_v = -o.hz - porch_d;
        let (gx, gz) = o.at(door_u, out_v - 0.6);
        let g_front = c.ter.height(gx, gz);
        let rise = floor_y - g_front;
        if rise > 0.3 {
            let l = (rise * 2.2).max(1.2);
            let (ox, oz) = o.at(door_u, out_v - l);
            let g_out = c.ter.height(ox, oz);
            let (cx, cz) = o.at(door_u, out_v - l * 0.5);
            // A frame whose u axis is the building's +v (pointing inward).
            let ro = Obb {
                cx,
                cz,
                c: -o.s,
                s: o.c,
                hx: l * 0.5,
                hz: door_w * 0.5 + 0.3,
            };
            push_ramp(&mut t.boxes, &ro, g_out.min(g_front) - 0.6, g_out, floor_y, bk::RAMP, bf::WALK, bi);
        }
    }

    // Door prop (stable id: spec 5 names doors).
    if floors > 0 {
        let (dx, dz) = o.at(door_u, -o.hz + wt * 0.5);
        prop(c, t, bi, dx, floor_y, dz, yaw, pk::DOOR, (door_w * 10.0) as u8, 0);
    }
    interior(c, t, bi, o, r, style, wt, floor_y, flags, seq);

    let box_count = (t.boxes.len() as u32 - box_first) as u16;
    let prop_count = (t.props.len() as u32 - prop_first) as u16;
    t.buildings.push(Building {
        id: stable_id(layer::BUILDING, c.site as i32, 0, local),
        settlement: c.settlement,
        role: r,
        style,
        x: o.cx,
        z: o.cz,
        floor_y,
        base_y,
        hx: o.hx,
        hz: o.hz,
        c: o.c,
        s: o.s,
        storey,
        roof_h,
        floors,
        roof: rk,
        ridge_u,
        door_u,
        door_w,
        flags,
        variant,
        box_first,
        box_count,
        prop_first,
        prop_count,
        front_x: front.0,
        front_z: front.1,
        street,
        along,
    });
    bi
}

/// A furniture piece in building-local coordinates; solid ones get a box.
#[allow(clippy::too_many_arguments)]
fn furn(c: &mut Ctx, t: &mut Towns, bi: u16, o: &Obb, u: f64, v: f64, rot: f64, kind: u8, variant: u8, y: f64, solid: Option<(f64, f64, f64)>, flags: u8) {
    let (x, z) = o.at(u, v);
    let yaw = libm::atan2(o.s, o.c) + rot;
    prop(c, t, bi, x, y, z, yaw, kind, variant, flags);
    if let Some((hu, hv, h)) = solid {
        let quarter_turns = libm::round(rot / core::f64::consts::FRAC_PI_2) as i64;
        let (hu, hv) = if quarter_turns % 2 != 0 { (hv, hu) } else { (hu, hv) };
        // Furniture you could step onto (beds, chests: top within a step)
        // is walkable; anything taller is solid only. A walkable top higher
        // than a step is a hard edge the climb grab can latch onto from the
        // air, where the last-ulp sin/cos difference between V8 and Go
        // (WP02/WP10 caveat) can flip the grab: client and zone then
        // disagree by centimetres. Solid-only furniture just pushes you away.
        let flags = if h <= crate::gen::constants::MAX_STEP_UP_M {
            bf::WALK | bf::SOLID
        } else {
            bf::SOLID
        };
        push_flat(&mut t.boxes, &sub(o, u, v, hu, hv), y - 0.1, y + h, bk::FURNITURE, flags, bi);
    }
}

#[allow(clippy::too_many_arguments)]
fn interior(c: &mut Ctx, t: &mut Towns, bi: u16, o: &Obb, r: u8, style: u8, wt: f64, y: f64, flags: u8, seq: &mut Seq) {
    let iu = o.hx - wt;
    let iv = o.hz - wt;
    let half_pi = core::f64::consts::FRAC_PI_2;
    let pi = core::f64::consts::PI;
    let hearth = flags & bflag::CHIMNEY != 0;
    let var = (seq.next_u64() & 3) as u8;
    match r {
        role::HOUSE | role::FARM => {
            if hearth {
                furn(c, t, bi, o, iu * 0.35, iv - 0.45, pi, pk::HEARTH, style, y, Some((0.75, 0.4, 1.1)), pf::LIGHT);
            }
            furn(c, t, bi, o, -iu + 0.55, iv - 1.05, half_pi, pk::BED, var, y, Some((0.5, 1.0, 0.5)), 0);
            furn(c, t, bi, o, iu * 0.25, -iv * 0.15, 0.0, pk::TABLE, var, y, Some((0.7, 0.45, 0.78)), 0);
            furn(c, t, bi, o, iu * 0.25, -iv * 0.15 - 0.8, 0.0, pk::BENCH, var, y, None, 0);
            furn(c, t, bi, o, iu - 0.45, iv - 0.45, pi, pk::CHEST, var, y, Some((0.45, 0.3, 0.55)), pf::INTERACT);
            furn(c, t, bi, o, iu - 0.4, -iv + 0.5, 0.0, pk::BARREL, var, y, Some((0.3, 0.3, 0.9)), 0);
            furn(c, t, bi, o, -iu * 0.2, iv * 0.2, 0.0, pk::RUG, var, y, None, 0);
            if iv > 2.6 {
                furn(c, t, bi, o, -iu + 0.25, -iv * 0.3, half_pi, pk::SHELF, var, y, Some((0.2, 0.6, 1.8)), 0);
            }
        }
        role::INN => {
            furn(
                c,
                t,
                bi,
                o,
                iu - 1.3,
                iv * 0.15,
                half_pi,
                pk::COUNTER,
                var,
                y,
                Some((0.35, 1.6, 1.05)),
                pf::INTERACT,
            );
            furn(c, t, bi, o, iu - 0.35, iv * 0.15, 0.0, pk::BARREL, 0, y, Some((0.3, 0.3, 0.9)), 0);
            furn(c, t, bi, o, iu - 0.35, iv * 0.15 + 1.0, 0.0, pk::SHELF, 1, y, Some((0.2, 0.6, 1.8)), 0);
            furn(c, t, bi, o, 0.0, iv - 0.5, pi, pk::HEARTH, style, y, Some((0.9, 0.45, 1.2)), pf::LIGHT);
            // Tables off the door lane (u = 0), so the way from the door to the hearth stays open.
            for (k, (u, v)) in [(-iu * 0.6, -iv * 0.4), (-iu * 0.6, iv * 0.4), (iu * 0.35, iv * 0.55)].iter().enumerate() {
                furn(c, t, bi, o, *u, *v, 0.0, pk::TABLE, k as u8, y, Some((0.75, 0.45, 0.78)), 0);
                furn(c, t, bi, o, *u, *v - 0.8, 0.0, pk::BENCH, 0, y, None, 0);
                furn(c, t, bi, o, *u, *v + 0.8, pi, pk::BENCH, 0, y, None, 0);
            }
        }
        role::FORGE => {
            furn(
                c,
                t,
                bi,
                o,
                -iu + 0.9,
                iv - 0.8,
                pi,
                pk::FORGE,
                style,
                y,
                Some((0.85, 0.75, 1.0)),
                pf::INTERACT | pf::LIGHT,
            );
            furn(c, t, bi, o, 0.2, iv * 0.1, 0.0, pk::ANVIL, 0, y, Some((0.4, 0.22, 0.8)), pf::INTERACT);
            furn(c, t, bi, o, iu - 0.5, iv - 0.5, 0.0, pk::QUENCH, 0, y, Some((0.4, 0.4, 0.7)), 0);
            furn(c, t, bi, o, iu - 0.3, -iv * 0.1, -half_pi, pk::WORKBENCH, 0, y, Some((0.3, 0.8, 0.9)), 0);
            furn(c, t, bi, o, 0.6, iv - 0.25, pi, pk::SHELF, 2, y, None, 0);
        }
        role::WORKSHOP => {
            furn(c, t, bi, o, 0.0, iv - 0.5, pi, pk::WORKBENCH, var, y, Some((0.9, 0.35, 0.9)), 0);
            furn(c, t, bi, o, -iu + 0.5, 0.0, half_pi, pk::WORKBENCH, var, y, Some((0.8, 0.3, 0.9)), 0);
            furn(c, t, bi, o, iu - 0.5, iv - 0.5, 0.0, pk::CRATE, 0, y, Some((0.4, 0.4, 0.8)), 0);
            furn(c, t, bi, o, iu - 0.5, iv - 1.4, 0.0, pk::BARREL, 0, y, Some((0.3, 0.3, 0.9)), 0);
        }
        role::STOREHOUSE => {
            let mut k = 0;
            let mut u = -iu + 0.6;
            while u < iu - 0.5 && k < 8 {
                let kind = if k % 2 == 0 { pk::CRATE } else { pk::BARREL };
                furn(c, t, bi, o, u, iv - 0.55, 0.0, kind, k as u8, y, Some((0.42, 0.42, 0.85)), 0);
                u += 1.2;
                k += 1;
            }
        }
        role::STALL => {
            furn(
                c,
                t,
                bi,
                o,
                0.0,
                -o.hz + 0.45,
                0.0,
                pk::STALL,
                var,
                y,
                Some((o.hx - 0.1, 0.3, 1.0)),
                pf::INTERACT,
            );
            furn(c, t, bi, o, -o.hx + 0.5, o.hz - 0.5, 0.0, pk::CRATE, 0, y, None, 0);
        }
        role::GARDEN => {
            // Ward garden (spec 8): beds of the flower demons cannot pass,
            // inside a low fence with a gate on the street side.
            let fh = y + 0.9;
            let ft = 0.08;
            let g0 = y - 0.5;
            push_flat(&mut t.boxes, &sub(o, 0.0, o.hz - ft, o.hx, ft), g0, fh, bk::FENCE, bf::SOLID, bi);
            push_flat(&mut t.boxes, &sub(o, -o.hx + ft, 0.0, ft, o.hz), g0, fh, bk::FENCE, bf::SOLID, bi);
            push_flat(&mut t.boxes, &sub(o, o.hx - ft, 0.0, ft, o.hz), g0, fh, bk::FENCE, bf::SOLID, bi);
            let gate = 1.2;
            push_flat(
                &mut t.boxes,
                &sub(o, (-o.hx - gate) * 0.5, -o.hz + ft, (o.hx - gate) * 0.5, ft),
                g0,
                fh,
                bk::FENCE,
                bf::SOLID,
                bi,
            );
            push_flat(
                &mut t.boxes,
                &sub(o, (o.hx + gate) * 0.5, -o.hz + ft, (o.hx - gate) * 0.5, ft),
                g0,
                fh,
                bk::FENCE,
                bf::SOLID,
                bi,
            );
            let mut v = -o.hz + 1.6;
            let mut k = 0u8;
            while v < o.hz - 0.8 {
                let (x, z) = o.at(0.0, v);
                let gy = c.ter.height(x, z);
                prop(c, t, bi, x, gy, z, libm::atan2(o.s, o.c), pk::WARD_BED, k, 0);
                v += 1.6;
                k = k.wrapping_add(1);
            }
        }
        _ => {}
    }
    if r == role::FARM {
        // The field behind the farmhouse.
        let fd = field_depth(r);
        let (x, z) = o.at(0.0, o.hz + 0.8 + fd * 0.5);
        let gy = c.ter.height(x, z);
        let p = t.props.len();
        prop(c, t, bi, x, gy, z, libm::atan2(o.s, o.c), pk::CROPS, style, 0);
        // Scale = field width in metres (renderer: width x depth = scale x fd).
        t.props[p].scale = ((o.hx * 2.0) as u8).max(4);
    }
}
