//! The structure library (spec 5): templates assembled jigsaw-style from
//! pieces with typed connectors, placed until a size budget is reached,
//! weighted per structure kind. v1 set: ruins, watchtowers, abandoned
//! mineshafts, shrines, bandit camps, wizard towers, meteor craters, sunken
//! temples, demon lairs.
//!
//! Pieces live on a 6 m grid aligned to the site's yaw. Every piece has a
//! connector type on each of its four edges (open: a path continues; closed:
//! a wall). Assembly starts from the kind's anchor piece, then repeatedly
//! takes the oldest open connector, picks a piece from the kind's weighted
//! pool (in any of four rotations) whose facing edge is open and whose cell
//! is dry, flat enough and inside the site, and places it, until the budget
//! (by tier and `structureDensity`) is spent. Fixed companions (the
//! watchtower's ramp, the wizard tower's spire) are placed with the anchor.
//!
//! Collision comes only from solid parts (walls, pillars, towers, rooms,
//! tents, altars); paving is drawn on the terrain.

use super::geom::{dist, push_flat, push_ramp, quarter, sub, wall, yaw16, Obb, Terrain};
use super::{bf, bk, layer, pf, pk, stream, Piece, Prop, Structure, Towns};
use crate::atlas::format::{param, sec, site, Atlas, SITE_REC};
use crate::cave::veins::crater_veins;
use crate::rng::{stable_id, Seq};

pub const CELL: f64 = 6.0;
const NONE: u16 = 0xFFFF;

/// Piece types (byte 36 of a piece record).
pub mod pt {
    pub const PAVE: u8 = 0;
    pub const WALL: u8 = 1;
    pub const CORNER: u8 = 2;
    pub const ROOM: u8 = 3;
    pub const TOWER: u8 = 4;
    pub const RAMP: u8 = 5;
    pub const PILLARS: u8 = 6;
    pub const TENT: u8 = 7;
    pub const PALISADE: u8 = 8;
    pub const CAMPFIRE: u8 = 9;
    pub const SHAFT: u8 = 10;
    pub const ALTAR: u8 = 11;
    pub const CRATER: u8 = 12;
    pub const LAIR: u8 = 13;
    pub const RUBBLE: u8 = 14;
    pub const NAMES: [&str; 15] = [
        "pave", "wall", "corner", "room", "tower", "ramp", "pillars", "tent", "palisade", "campfire", "shaft", "altar", "crater", "lair", "rubble",
    ];
}

/// Open edges per piece type, bits by local direction: 1 front (-v),
/// 2 right (+u), 4 back (+v), 8 left (-u).
fn edges(t: u8) -> u8 {
    match t {
        pt::WALL | pt::PALISADE => 1 | 2 | 8,
        pt::CORNER => 1 | 2,
        pt::ROOM => 1,
        pt::RAMP => 1 | 4,
        _ => 15,
    }
}

struct Kind {
    anchor: u8,
    pool: &'static [(u8, f64)],
    base: usize,
    per_tier: usize,
}

fn kind(k: u8) -> Kind {
    match k {
        site::ST_RUIN => Kind {
            anchor: pt::PAVE,
            pool: &[(pt::WALL, 3.0), (pt::CORNER, 2.0), (pt::PILLARS, 2.0), (pt::PAVE, 2.0), (pt::RUBBLE, 2.0)],
            base: 3,
            per_tier: 2,
        },
        site::ST_WATCHTOWER => Kind {
            anchor: pt::TOWER,
            pool: &[(pt::PALISADE, 2.0), (pt::CAMPFIRE, 1.0), (pt::PAVE, 1.0)],
            base: 3,
            per_tier: 1,
        },
        site::ST_MINESHAFT => Kind {
            anchor: pt::SHAFT,
            pool: &[(pt::RUBBLE, 2.0), (pt::PAVE, 1.0), (pt::ROOM, 1.0), (pt::CAMPFIRE, 0.5)],
            base: 2,
            per_tier: 1,
        },
        site::ST_SHRINE => Kind {
            anchor: pt::ALTAR,
            pool: &[(pt::PILLARS, 3.0), (pt::PAVE, 2.0)],
            base: 2,
            per_tier: 1,
        },
        site::ST_BANDIT_CAMP => Kind {
            anchor: pt::CAMPFIRE,
            pool: &[(pt::TENT, 4.0), (pt::PALISADE, 3.0), (pt::RUBBLE, 1.0)],
            base: 4,
            per_tier: 2,
        },
        site::ST_WIZARD_TOWER => Kind {
            anchor: pt::ROOM,
            pool: &[(pt::WALL, 2.0), (pt::PILLARS, 1.0), (pt::PAVE, 1.0)],
            base: 3,
            per_tier: 1,
        },
        site::ST_METEOR_CRATER => Kind {
            anchor: pt::CRATER,
            pool: &[(pt::RUBBLE, 4.0)],
            base: 4,
            per_tier: 2,
        },
        site::ST_SUNKEN_TEMPLE => Kind {
            anchor: pt::ROOM,
            pool: &[(pt::PILLARS, 3.0), (pt::ROOM, 2.0), (pt::WALL, 2.0), (pt::PAVE, 1.0)],
            base: 4,
            per_tier: 3,
        },
        _ => Kind {
            anchor: pt::LAIR,
            pool: &[(pt::PILLARS, 2.0), (pt::WALL, 2.0), (pt::RUBBLE, 2.0)],
            base: 3,
            per_tier: 2,
        },
    }
}

/// Grid direction d (0 -j, 1 +i, 2 +j, 3 -i) as a cell offset.
const GDIR: [(i32, i32); 4] = [(0, -1), (1, 0), (0, 1), (-1, 0)];

struct Placed {
    i: i32,
    j: i32,
    t: u8,
    r: u8,
}

struct Builder<'a, 'b> {
    ter: &'a Terrain<'b>,
    site: usize,
    si: u16,
    x: f64,
    z: f64,
    c: f64,
    s: f64,
    kind: u8,
    tier: u8,
    seq: Seq,
    prop_n: u32,
    piece_n: u32,
}

impl Builder<'_, '_> {
    fn cell_center(&self, i: i32, j: i32) -> (f64, f64) {
        let (u, v) = (i as f64 * CELL, j as f64 * CELL);
        (self.x + u * self.c - v * self.s, self.z + u * self.s + v * self.c)
    }

    /// The cell's rectangle with the piece's rotation (local frame of the piece).
    fn cell_obb(&self, i: i32, j: i32, r: u8) -> Obb {
        let (cx, cz) = self.cell_center(i, j);
        // Rotate the grid frame by r quarter turns.
        let (c, s) = match r & 3 {
            0 => (self.c, self.s),
            1 => (-self.s, self.c),
            2 => (-self.c, -self.s),
            _ => (self.s, -self.c),
        };
        Obb {
            cx,
            cz,
            c,
            s,
            hx: CELL * 0.5,
            hz: CELL * 0.5,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn prop(&mut self, t: &mut Towns, x: f64, z: f64, y: f64, yaw: f64, kind: u8, variant: u8, flags: u8) {
        t.props.push(Prop {
            id: stable_id(layer::PROP, self.site as i32, 1, self.prop_n),
            x: x as f32,
            y: y as f32,
            z: z as f32,
            yaw: yaw16(yaw),
            kind,
            variant,
            building: NONE,
            settlement: NONE,
            flags,
            scale: 64,
            structure: self.si,
        });
        self.prop_n += 1;
    }

    fn piece(&mut self, t: &mut Towns, o: &Obb, y: f64, sy: f64, ty: u8, variant: u8) {
        t.pieces.push(Piece {
            id: stable_id(layer::PIECE, self.site as i32, 0, self.piece_n),
            x: o.cx,
            y,
            z: o.cz,
            c: o.c,
            s: o.s,
            sx: CELL,
            sy,
            kind: ty,
            variant,
            structure: self.si,
        });
        self.piece_n += 1;
    }

    fn fits(&self, i: i32, j: i32, radius: f64) -> bool {
        let o = self.cell_obb(i, j, 0);
        if dist(o.cx, o.cz, self.x, self.z) > radius + CELL * 0.5 {
            return false;
        }
        let sp = self.ter.span(&o, 0.0);
        !sp.wet && sp.max - sp.min < 3.5
    }

    /// Emit geometry for one placed piece. `extra` is the height used by
    /// towers (and by a ramp leading up to one).
    fn emit(&mut self, t: &mut Towns, p: &Placed, extra: f64) {
        let o = self.cell_obb(p.i, p.j, p.r);
        let sp = self.ter.span(&o, 0.0);
        let (lo, hi) = (sp.min - 1.0, sp.max);
        let si = self.si;
        let v = (self.seq.next_u64() & 7) as u8;
        let yaw = libm::atan2(o.s, o.c);
        let h = 3.0 * self.seq.range(0.4, 1.4);
        match p.t {
            pt::PAVE => self.piece(t, &o, hi, 0.0, p.t, v),
            pt::WALL | pt::PALISADE => {
                let (th, wh) = if p.t == pt::WALL { (0.8, h) } else { (0.4, 2.6) };
                wall(
                    &mut t.boxes,
                    &sub(&o, 0.0, CELL * 0.5 - th * 0.5, CELL * 0.5, th * 0.5),
                    lo,
                    hi + wh,
                    bk::PIECE,
                    si,
                );
                t.boxes.last_mut().unwrap().flags |= bf::WALK;
                self.piece(t, &o, hi, wh, p.t, v);
            }
            pt::CORNER => {
                let th = 0.8;
                wall(
                    &mut t.boxes,
                    &sub(&o, 0.0, CELL * 0.5 - th * 0.5, CELL * 0.5, th * 0.5),
                    lo,
                    hi + h,
                    bk::PIECE,
                    si,
                );
                wall(
                    &mut t.boxes,
                    &sub(&o, -CELL * 0.5 + th * 0.5, -th * 0.5, th * 0.5, CELL * 0.5 - th * 0.5),
                    lo,
                    hi + h * 0.7,
                    bk::PIECE,
                    si,
                );
                self.piece(t, &o, hi, h, p.t, v);
            }
            pt::ROOM => {
                // A small enclosed room: floor, walls with a front door, a roof.
                let (hx, wt, wh) = (2.8, 0.6, 3.6);
                let fy = hi + 0.2;
                let r = sub(&o, 0.0, 0.0, hx, hx);
                push_flat(&mut t.boxes, &r, lo, fy, bk::PIECE, bf::WALK | bf::SOLID, si);
                wall(&mut t.boxes, &sub(&r, 0.0, hx - wt * 0.5, hx, wt * 0.5), fy, fy + wh, bk::PIECE, si);
                wall(&mut t.boxes, &sub(&r, -hx + wt * 0.5, 0.0, wt * 0.5, hx), fy, fy + wh, bk::PIECE, si);
                wall(&mut t.boxes, &sub(&r, hx - wt * 0.5, 0.0, wt * 0.5, hx), fy, fy + wh, bk::PIECE, si);
                let dw = 0.9;
                wall(
                    &mut t.boxes,
                    &sub(&r, (-hx - dw) * 0.5, -hx + wt * 0.5, (hx - dw) * 0.5, wt * 0.5),
                    fy,
                    fy + wh,
                    bk::PIECE,
                    si,
                );
                wall(
                    &mut t.boxes,
                    &sub(&r, (hx + dw) * 0.5, -hx + wt * 0.5, (hx - dw) * 0.5, wt * 0.5),
                    fy,
                    fy + wh,
                    bk::PIECE,
                    si,
                );
                wall(&mut t.boxes, &sub(&r, 0.0, -hx + wt * 0.5, dw, wt * 0.5), fy + 2.4, fy + wh, bk::PIECE, si);
                push_flat(
                    &mut t.boxes,
                    &sub(&r, 0.0, 0.0, hx - wt, hx - wt),
                    fy + wh - 0.3,
                    fy + wh + 0.2,
                    bk::PIECE,
                    bf::WALK | bf::CEIL,
                    si,
                );
                let (fx, fz) = o.at(0.0, -hx - 0.6);
                let g = self.ter.height(fx, fz);
                if fy - g > 0.3 {
                    let l = ((fy - g) * 2.2).max(1.2);
                    let (cx, cz) = o.at(0.0, -hx - l * 0.5);
                    let (ox, oz) = o.at(0.0, -hx - l);
                    let go = self.ter.height(ox, oz);
                    let ro = Obb {
                        cx,
                        cz,
                        c: -o.s,
                        s: o.c,
                        hx: l * 0.5,
                        hz: 1.0,
                    };
                    push_ramp(&mut t.boxes, &ro, go.min(g) - 0.6, go, fy, bk::PIECE, bf::WALK, si);
                }
                self.piece(t, &o, fy, wh, p.t, v);
                // Contents by kind: loot, books, crystals, an altar.
                let (cx, cz) = o.at(1.6, 1.6);
                self.prop(t, cx, cz, fy, yaw + core::f64::consts::PI, pk::CHEST, self.tier, pf::INTERACT);
                let (bx, bz) = o.at(-1.9, 0.8);
                let k = match self.kind {
                    site::ST_WIZARD_TOWER => pk::BOOKSHELF,
                    site::ST_SUNKEN_TEMPLE => pk::STATUE,
                    _ => pk::CRATE,
                };
                self.prop(t, bx, bz, fy, yaw, k, v, 0);
                let (tx, tz) = o.at(1.9, -1.2);
                self.prop(t, tx, tz, fy + 1.6, yaw, pk::TORCH, 0, pf::LIGHT);
            }
            pt::TOWER => {
                let th = if extra > 0.0 { extra } else { 5.0 };
                push_flat(&mut t.boxes, &sub(&o, 0.0, 0.0, 2.0, 2.0), lo, hi + th, bk::PIECE, bf::WALK | bf::SOLID, si);
                self.piece(t, &o, hi, th, p.t, v);
                let (bx, bz) = o.at(0.0, 0.0);
                self.prop(
                    t,
                    bx,
                    bz,
                    hi + th,
                    yaw,
                    if self.kind == site::ST_WIZARD_TOWER { pk::CRYSTAL } else { pk::BRAZIER },
                    0,
                    pf::LIGHT,
                );
            }
            pt::RAMP => {
                // From the ground at the front edge up to the tower top at the
                // back edge (the tower is the back neighbour).
                let (fx, fz) = o.at(0.0, -CELL * 0.5);
                let g = self.ter.height(fx, fz);
                let ro = quarter(&sub(&o, 0.0, 0.5, 0.8, 3.5)); // v from the front edge (-3) to the tower's face (+4)
                push_ramp(&mut t.boxes, &ro, lo, g, extra, bk::PIECE, bf::WALK, si);
                self.piece(t, &o, g, extra - g, p.t, v);
            }
            pt::PILLARS => {
                for (u, w) in [(-1.8, -1.8), (1.8, -1.8), (-1.8, 1.8), (1.8, 1.8)] {
                    let ph = 3.0 * self.seq.range(0.5, 2.0);
                    wall(&mut t.boxes, &sub(&o, u, w, 0.4, 0.4), lo, hi + ph, bk::PIECE, si);
                }
                self.piece(t, &o, hi, 0.0, p.t, v);
            }
            pt::TENT => {
                wall(&mut t.boxes, &sub(&o, 0.0, 0.5, 1.6, 1.3), lo, hi + 2.2, bk::PIECE, si);
                self.piece(t, &o, hi, 2.2, p.t, v);
                let (cx, cz) = o.at(1.9, -1.6);
                self.prop(t, cx, cz, self.ter.height(cx, cz), yaw, pk::CHEST, self.tier, pf::INTERACT);
            }
            pt::CAMPFIRE => {
                let (cx, cz) = o.at(0.0, 0.0);
                self.prop(t, cx, cz, self.ter.height(cx, cz), yaw, pk::CAMPFIRE, 0, pf::LIGHT);
                for k in 0..3 {
                    let a = yaw + k as f64 * 2.1;
                    let (bx, bz) = (cx + libm::cos(a) * 1.8, cz + libm::sin(a) * 1.8);
                    self.prop(t, bx, bz, self.ter.height(bx, bz), a + core::f64::consts::FRAC_PI_2, pk::BENCH, 1, 0);
                }
                self.piece(t, &o, hi, 0.0, p.t, v);
            }
            pt::SHAFT => {
                // Head frame over the old shaft; the railing keeps you out,
                // the winch (interactable) takes you down (zone: the nearest cave).
                for (u, w) in [(-1.4, -1.4), (1.4, -1.4), (-1.4, 1.4), (1.4, 1.4)] {
                    wall(&mut t.boxes, &sub(&o, u, w, 0.15, 0.15), lo, hi + 4.0, bk::PIECE, si);
                }
                for (u, w, a, b) in [(0.0, -1.4, 1.4, 0.06), (0.0, 1.4, 1.4, 0.06), (1.4, 0.0, 0.06, 1.4)] {
                    wall(&mut t.boxes, &sub(&o, u, w, a, b), lo, hi + 1.0, bk::PIECE, si);
                }
                self.piece(t, &o, hi, 4.0, p.t, v);
                let (cx, cz) = o.at(-2.2, 0.0);
                self.prop(t, cx, cz, self.ter.height(cx, cz), yaw, pk::WORKBENCH, 9, pf::INTERACT);
            }
            pt::ALTAR => {
                wall(&mut t.boxes, &sub(&o, 0.0, 0.0, 1.0, 0.6), lo, hi + 1.1, bk::PIECE, si);
                t.boxes.last_mut().unwrap().flags |= bf::WALK;
                self.piece(t, &o, hi, 1.1, p.t, v);
                let (cx, cz) = o.at(0.0, 1.4);
                self.prop(t, cx, cz, hi, yaw, pk::STATUE, v, pf::INTERACT);
                for u in [-2.2, 2.2] {
                    let (bx, bz) = o.at(u, -1.0);
                    self.prop(t, bx, bz, self.ter.height(bx, bz), yaw, pk::BRAZIER, 0, pf::LIGHT);
                }
            }
            pt::CRATER => {
                // The meteorite itself (solid) with starmetal clusters around it;
                // the clusters are mineable veins (towns buffer VEINS section).
                wall(&mut t.boxes, &sub(&o, 0.0, 0.0, 1.3, 1.1), lo, hi + 2.4, bk::PIECE, si);
                self.piece(t, &o, hi, 2.4, p.t, v);
                for vn in crater_veins(self.ter.a, self.site) {
                    self.prop(t, vn.x, vn.z, vn.y, 0.0, pk::STARMETAL, vn.size, pf::INTERACT | pf::LIGHT);
                    t.veins.push(vn);
                }
            }
            pt::LAIR => {
                for k in 0..6 {
                    let a = yaw + k as f64 * core::f64::consts::PI / 3.0;
                    let (sx, sz) = (o.cx + libm::cos(a) * 2.6, o.cz + libm::sin(a) * 2.6);
                    let so = Obb::new(sx, sz, a, 0.3, 0.3);
                    let ssp = self.ter.span(&so, 0.0);
                    wall(&mut t.boxes, &so, ssp.min - 1.0, ssp.max + 2.5 + k as f64 * 0.3, bk::PIECE, si);
                }
                self.piece(t, &o, hi, 0.0, p.t, v);
                let (cx, cz) = o.at(1.2, -1.0);
                self.prop(t, cx, cz, self.ter.height(cx, cz), yaw, pk::BONES, v, 0);
            }
            _ => {
                // Rubble: knee-high blocks you can step onto.
                for k in 0..3 {
                    let (u, w) = (self.seq.range(-2.0, 2.0), self.seq.range(-2.0, 2.0));
                    let ro = sub(&o, u, w, self.seq.range(0.3, 0.8), self.seq.range(0.3, 0.7));
                    let rsp = self.ter.span(&ro, 0.0);
                    push_flat(&mut t.boxes, &ro, rsp.min - 0.5, rsp.max + 0.45, bk::PIECE, bf::WALK | bf::SOLID, si);
                    let _ = k;
                }
                self.piece(t, &o, hi, 0.5, p.t, v);
                let (cx, cz) = o.at(0.5, 0.5);
                self.prop(t, cx, cz, self.ter.height(cx, cz), yaw, pk::RUBBLE, v, 0);
            }
        }
    }
}

pub fn build_structures(a: &Atlas, t: &mut Towns) {
    let ter = Terrain::new(a);
    let density = a.param(param::STRUCTURE_DENSITY);
    let sites = a.section(sec::SITES);
    for i in 0..a.site_count() {
        let s = a.site(i);
        if s.category != site::CAT_STRUCTURE {
            continue;
        }
        let rec = 8 + i * SITE_REC;
        let yaw_u16 = u16::from_le_bytes([sites[rec + 44], sites[rec + 45]]);
        let yaw = yaw_u16 as f64 / 65536.0 * 2.0 * core::f64::consts::PI;
        let k = kind(s.kind);
        let tier = s.size.min(2);
        let budget = libm::round((k.base + k.per_tier * tier as usize) as f64 * (0.7 + 0.6 * density)) as usize;
        let si = t.structures.len() as u16;
        let piece_first = t.pieces.len() as u32;
        let prop_first = t.props.len() as u32;
        let box_first = t.boxes.len() as u32;
        let mut b = Builder {
            ter: &ter,
            site: i,
            si,
            x: s.x,
            z: s.z,
            c: libm::cos(yaw),
            s: libm::sin(yaw),
            kind: s.kind,
            tier,
            seq: Seq::new(a.seed ^ s.seed as u64, stream::JIGSAW),
            prop_n: 0,
            piece_n: 0,
        };
        let radius = s.radius.max(12.0);
        let mut placed: Vec<Placed> = vec![Placed { i: 0, j: 0, t: k.anchor, r: 0 }];
        // Fixed companions.
        let tower_h = match s.kind {
            site::ST_WATCHTOWER => 4.6,
            site::ST_WIZARD_TOWER => 14.0 + 4.0 * tier as f64,
            _ => 0.0,
        };
        if s.kind == site::ST_WATCHTOWER {
            placed.push(Placed {
                i: 0,
                j: -1,
                t: pt::RAMP,
                r: 0,
            });
        } else if s.kind == site::ST_WIZARD_TOWER {
            placed.push(Placed {
                i: 0,
                j: 1,
                t: pt::TOWER,
                r: 0,
            });
        }
        // Breadth-first over open connectors.
        let mut open: Vec<(usize, u8)> = Vec::new();
        for pi in 0..placed.len() {
            for d in 0..4u8 {
                open.push((pi, d));
            }
        }
        let mut q = 0;
        while q < open.len() && placed.len() < budget {
            let (pi, gd) = open[q];
            q += 1;
            let (src_t, src_r, si_, sj) = (placed[pi].t, placed[pi].r, placed[pi].i, placed[pi].j);
            let local = (gd + 4 - src_r) & 3;
            if edges(src_t) & (1 << local) == 0 {
                continue;
            }
            let (ni, nj) = (si_ + GDIR[gd as usize].0, sj + GDIR[gd as usize].1);
            if placed.iter().any(|p| p.i == ni && p.j == nj) || !b.fits(ni, nj, radius) {
                continue;
            }
            let back = (gd + 2) & 3;
            let mut cands: Vec<(u8, u8, f64)> = Vec::new();
            for &(ty, w) in k.pool {
                for r in 0..4u8 {
                    if edges(ty) & (1 << ((back + 4 - r) & 3)) != 0 {
                        cands.push((ty, r, w));
                    }
                }
            }
            if cands.is_empty() {
                continue;
            }
            let weights: Vec<f64> = cands.iter().map(|c| c.2).collect();
            let pick = cands[crate::rng::weighted_pick(&weights, b.seq.unit())];
            placed.push(Placed {
                i: ni,
                j: nj,
                t: pick.0,
                r: pick.1,
            });
            let np = placed.len() - 1;
            for d in 0..4u8 {
                open.push((np, d));
            }
        }
        // Emit: towers before ramps (the ramp climbs to the tower's top).
        let tower_top = if tower_h > 0.0 {
            let tp = placed.iter().position(|p| p.t == pt::TOWER).unwrap_or(0);
            let o = b.cell_obb(placed[tp].i, placed[tp].j, placed[tp].r);
            ter.span(&o, 0.0).max + tower_h
        } else {
            0.0
        };
        let mut extent = 0.0f64;
        for p in &placed {
            let extra = match p.t {
                pt::TOWER => tower_h,
                pt::RAMP => tower_top,
                _ => 0.0,
            };
            b.emit(t, p, extra);
            let (cx, cz) = b.cell_center(p.i, p.j);
            extent = extent.max(dist(cx, cz, s.x, s.z) + CELL * 0.75);
        }
        let y = ter.height(s.x, s.z);
        t.structures.push(Structure {
            id: s.id,
            site: i as u16,
            kind: s.kind,
            tier,
            x: s.x,
            y,
            z: s.z,
            radius: extent,
            piece_first,
            piece_count: (t.pieces.len() as u32 - piece_first) as u16,
            prop_first,
            prop_count: (t.props.len() as u32 - prop_first) as u16,
            box_first,
            box_count: t.boxes.len() as u32 - box_first,
        });
    }
}
