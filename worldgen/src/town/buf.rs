//! Towns buffer (`LDTW`, format 1), byte for byte in worldgen/README.md
//! "Towns". Little-endian. A 64-byte header, a 16-entry directory of
//! (u32 offset, u32 count, u32 byte length, u32 record size), then 8-aligned
//! sections. Readers find sections only through the directory.

use super::Towns;
use crate::atlas::format::{put_f32, put_u16, put_u32, put_u64, site, Atlas};

pub const MAGIC: [u8; 4] = *b"LDTW";
pub const FORMAT_VERSION: u16 = 1;
pub const HEADER_LEN: usize = 64;
pub const DIR_ENTRIES: usize = 16;
pub const DATA_START: usize = HEADER_LEN + DIR_ENTRIES * 16;

pub mod sec {
    pub const SETTLEMENTS: usize = 0;
    pub const BUILDINGS: usize = 1;
    pub const BOXES: usize = 2;
    pub const PROPS: usize = 3;
    pub const NPCS: usize = 4;
    pub const ROADS: usize = 5;
    pub const POINTS: usize = 6;
    pub const BRIDGES: usize = 7;
    pub const SIGNS: usize = 8;
    pub const STRUCTURES: usize = 9;
    pub const PIECES: usize = 10;
    pub const VEINS: usize = 11;
    pub const NAMES: usize = 12;
}

pub const REC: [usize; 13] = [64, 96, 40, 32, 40, 24, 12, 48, 32, 56, 40, 32, 0];

struct W {
    b: Vec<u8>,
    dir: [(u32, u32, u32, u32); DIR_ENTRIES],
}

impl W {
    fn section(&mut self, id: usize, count: usize, rec: usize, f: impl FnOnce(&mut [u8])) {
        while !self.b.len().is_multiple_of(8) {
            self.b.push(0);
        }
        let off = self.b.len();
        let len = count * rec;
        self.b.resize(off + len, 0);
        f(&mut self.b[off..off + len]);
        self.dir[id] = (off as u32, count as u32, len as u32, rec as u32);
    }
}

fn nearest_cave_mouth(a: &Atlas, x: f64, z: f64) -> u16 {
    let mut best = (800.0, 0xFFFFu16);
    for i in 0..a.site_count() {
        let s = a.site(i);
        if s.category == site::CAT_POI && s.kind == site::POI_CAVE_MOUTH {
            let d = libm::sqrt((s.x - x) * (s.x - x) + (s.z - z) * (s.z - z));
            if d < best.0 {
                best = (d, i as u16);
            }
        }
    }
    best.1
}

pub fn serialize(a: &Atlas, t: &Towns) -> Vec<u8> {
    let mut w = W {
        b: vec![0u8; DATA_START],
        dir: [(0, 0, 0, 0); DIR_ENTRIES],
    };
    w.section(sec::SETTLEMENTS, t.settlements.len(), REC[0], |b| {
        for (i, s) in t.settlements.iter().enumerate() {
            let o = i * REC[0];
            put_u64(b, o, s.id);
            put_u16(b, o + 8, s.site);
            b[o + 10] = s.size;
            b[o + 11] = s.style;
            b[o + 12] = s.walled as u8;
            b[o + 13] = libm::round(s.wall_r) as u8;
            b[o + 14] = s.region;
            put_f32(b, o + 16, s.x as f32);
            put_f32(b, o + 20, s.y as f32);
            put_f32(b, o + 24, s.z as f32);
            put_f32(b, o + 28, s.radius as f32);
            put_f32(b, o + 32, s.square as f32);
            put_u16(b, o + 36, s.building_first);
            put_u16(b, o + 38, s.building_count);
            put_u16(b, o + 40, s.npc_first);
            put_u16(b, o + 42, s.npc_count);
            put_u32(b, o + 44, s.prop_first);
            put_u32(b, o + 48, s.prop_count);
            put_u32(b, o + 52, s.box_first);
            put_u32(b, o + 56, s.box_count);
            put_u16(b, o + 60, s.road_first);
            put_u16(b, o + 62, s.road_count);
        }
    });
    w.section(sec::BUILDINGS, t.buildings.len(), REC[1], |b| {
        for (i, d) in t.buildings.iter().enumerate() {
            let o = i * REC[1];
            put_u64(b, o, d.id);
            put_u16(b, o + 8, d.settlement);
            b[o + 10] = d.role;
            b[o + 11] = d.style;
            put_f32(b, o + 12, d.x as f32);
            put_f32(b, o + 16, d.z as f32);
            put_f32(b, o + 20, d.floor_y as f32);
            put_f32(b, o + 24, d.base_y as f32);
            put_f32(b, o + 28, d.hx as f32);
            put_f32(b, o + 32, d.hz as f32);
            put_f32(b, o + 36, d.c as f32);
            put_f32(b, o + 40, d.s as f32);
            put_f32(b, o + 44, d.storey as f32);
            put_f32(b, o + 48, d.roof_h as f32);
            b[o + 52] = d.floors;
            b[o + 53] = d.roof;
            b[o + 54] = d.ridge_u as u8;
            b[o + 55] = d.flags;
            put_f32(b, o + 56, d.door_u as f32);
            put_f32(b, o + 60, d.door_w as f32);
            b[o + 64] = d.variant;
            put_u16(b, o + 66, d.box_count);
            put_u32(b, o + 68, d.box_first);
            put_u32(b, o + 72, d.prop_first);
            put_u16(b, o + 76, d.prop_count);
            put_u16(b, o + 78, d.street);
            put_f32(b, o + 80, d.front_x as f32);
            put_f32(b, o + 84, d.front_z as f32);
            put_f32(b, o + 88, d.along as f32);
        }
    });
    w.section(sec::BOXES, t.boxes.len(), REC[2], |b| {
        for (i, x) in t.boxes.iter().enumerate() {
            let o = i * REC[2];
            for (k, v) in [x.cx, x.cz, x.c, x.s, x.hx, x.hz, x.y0, x.y1, x.y2].iter().enumerate() {
                put_f32(b, o + k * 4, *v);
            }
            b[o + 36] = x.kind;
            b[o + 37] = x.flags;
            put_u16(b, o + 38, x.owner);
        }
    });
    w.section(sec::PROPS, t.props.len(), REC[3], |b| {
        for (i, p) in t.props.iter().enumerate() {
            let o = i * REC[3];
            put_u64(b, o, p.id);
            put_f32(b, o + 8, p.x);
            put_f32(b, o + 12, p.y);
            put_f32(b, o + 16, p.z);
            put_u16(b, o + 20, p.yaw);
            b[o + 22] = p.kind;
            b[o + 23] = p.variant;
            put_u16(b, o + 24, p.building);
            put_u16(b, o + 26, p.settlement);
            b[o + 28] = p.flags;
            b[o + 29] = p.scale;
            put_u16(b, o + 30, p.structure);
        }
    });
    w.section(sec::NPCS, t.npcs.len(), REC[4], |b| {
        for (i, n) in t.npcs.iter().enumerate() {
            let o = i * REC[4];
            put_u64(b, o, n.id);
            put_u16(b, o + 8, n.settlement);
            b[o + 10] = n.role;
            b[o + 11] = n.variant;
            put_u16(b, o + 12, n.name);
            put_u16(b, o + 14, n.home);
            put_u16(b, o + 16, n.work);
            put_u16(b, o + 18, n.work_prop);
            put_f32(b, o + 20, n.work_x as f32);
            put_f32(b, o + 24, n.work_z as f32);
            put_f32(b, o + 28, n.home_x as f32);
            put_f32(b, o + 32, n.home_z as f32);
            put_u16(b, o + 36, n.work_yaw);
            b[o + 38] = n.merchant;
        }
    });
    let n_points: usize = t.roads.iter().map(|r| r.points.len()).sum();
    w.section(sec::ROADS, t.roads.len(), REC[5], |b| {
        let mut first = 0u32;
        for (i, r) in t.roads.iter().enumerate() {
            let o = i * REC[5];
            put_u32(b, o, first);
            put_u32(b, o + 4, r.points.len() as u32);
            put_u16(b, o + 8, r.from);
            put_u16(b, o + 10, r.to);
            put_f32(b, o + 12, r.width as f32);
            b[o + 16] = r.class;
            b[o + 17] = r.surface;
            put_u16(b, o + 18, r.settlement);
            put_f32(b, o + 20, r.length as f32);
            first += r.points.len() as u32;
        }
    });
    w.section(sec::POINTS, n_points, REC[6], |b| {
        let mut o = 0;
        for r in &t.roads {
            for p in &r.points {
                put_f32(b, o, p[0] as f32);
                put_f32(b, o + 4, p[1] as f32);
                put_f32(b, o + 8, p[2] as f32);
                o += REC[6];
            }
        }
    });
    w.section(sec::BRIDGES, t.bridges.len(), REC[7], |b| {
        for (i, g) in t.bridges.iter().enumerate() {
            let o = i * REC[7];
            put_u64(b, o, g.id);
            for (k, v) in [g.ax, g.az, g.bx, g.bz, g.deck_y, g.width, g.water_y].iter().enumerate() {
                put_f32(b, o + 8 + k * 4, *v as f32);
            }
            put_u16(b, o + 36, g.road);
            b[o + 38] = g.style;
            put_u32(b, o + 40, g.box_first);
            put_u16(b, o + 44, g.box_count);
        }
    });
    w.section(sec::SIGNS, t.signs.len(), REC[8], |b| {
        for (i, s) in t.signs.iter().enumerate() {
            let o = i * REC[8];
            put_u64(b, o, s.id);
            put_f32(b, o + 8, s.x as f32);
            put_f32(b, o + 12, s.y as f32);
            put_f32(b, o + 16, s.z as f32);
            for k in 0..3 {
                put_u16(b, o + 20 + k * 2, s.arms[k].0);
                put_u16(b, o + 26 + k * 2, s.arms[k].1);
            }
        }
    });
    w.section(sec::STRUCTURES, t.structures.len(), REC[9], |b| {
        for (i, s) in t.structures.iter().enumerate() {
            let o = i * REC[9];
            put_u64(b, o, s.id);
            put_u16(b, o + 8, s.site);
            b[o + 10] = s.kind;
            b[o + 11] = s.tier;
            put_f32(b, o + 12, s.x as f32);
            put_f32(b, o + 16, s.y as f32);
            put_f32(b, o + 20, s.z as f32);
            put_f32(b, o + 24, s.radius as f32);
            put_u32(b, o + 28, s.piece_first);
            put_u16(b, o + 32, s.piece_count);
            put_u16(b, o + 34, s.prop_count);
            put_u32(b, o + 36, s.box_first);
            put_u32(b, o + 40, s.box_count);
            put_u32(b, o + 44, s.prop_first);
            let link = if s.kind == site::ST_MINESHAFT {
                nearest_cave_mouth(a, s.x, s.z)
            } else {
                0xFFFF
            };
            put_u16(b, o + 48, link);
        }
    });
    w.section(sec::PIECES, t.pieces.len(), REC[10], |b| {
        for (i, p) in t.pieces.iter().enumerate() {
            let o = i * REC[10];
            put_u64(b, o, p.id);
            for (k, v) in [p.x, p.y, p.z, p.c, p.s, p.sx, p.sy].iter().enumerate() {
                put_f32(b, o + 8 + k * 4, *v as f32);
            }
            b[o + 36] = p.kind;
            b[o + 37] = p.variant;
            put_u16(b, o + 38, p.structure);
        }
    });
    w.section(sec::VEINS, t.veins.len(), REC[11], |b| {
        for (i, v) in t.veins.iter().enumerate() {
            crate::cave::cell::write_vein(b, i * REC[11], v);
        }
    });
    // Names: u16 byte length + UTF-8 each.
    let mut nb: Vec<u8> = Vec::new();
    for n in &t.names {
        nb.extend_from_slice(&(n.len() as u16).to_le_bytes());
        nb.extend_from_slice(n.as_bytes());
    }
    w.section(sec::NAMES, nb.len(), 1, |b| b.copy_from_slice(&nb));
    w.dir[sec::NAMES].1 = t.names.len() as u32;
    w.dir[sec::NAMES].3 = 0;

    let mut b = w.b;
    while !b.len().is_multiple_of(8) {
        b.push(0);
    }
    let len = b.len() as u32;
    b[0..4].copy_from_slice(&MAGIC);
    put_u16(&mut b, 4, FORMAT_VERSION);
    put_u16(&mut b, 6, a.gen_version);
    put_u32(&mut b, 8, len);
    put_u32(&mut b, 12, HEADER_LEN as u32);
    put_u64(&mut b, 16, a.seed);
    put_u32(&mut b, 24, t.settlements.len() as u32);
    put_u32(&mut b, 28, HEADER_LEN as u32);
    put_u32(&mut b, 32, DIR_ENTRIES as u32);
    for (k, (o, c, l, r)) in w.dir.iter().enumerate() {
        let p = HEADER_LEN + k * 16;
        put_u32(&mut b, p, *o);
        put_u32(&mut b, p + 4, *c);
        put_u32(&mut b, p + 8, *l);
        put_u32(&mut b, p + 12, *r);
    }
    b
}
