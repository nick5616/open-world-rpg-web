//! Atlas binary layout (documented byte for byte in worldgen/README.md).
//!
//! Little-endian throughout. A 64-byte header, a 16-entry section directory
//! of (offset u32, length u32), then 8-aligned sections. Readers locate
//! sections only through the directory, so later formats can append sections
//! without moving old ones. The chunk pass and collision queries read the
//! atlas straight out of this buffer (no decode step), which is why the hot
//! grids are plain f32/u8 arrays.

use crate::gen::constants::{MACRO_RES_M, WORLD_REGIONS, WORLD_SIZE_M};

pub const MAGIC: [u8; 4] = *b"LDAT";
pub const FORMAT_VERSION: u16 = 1;
pub const HEADER_LEN: usize = 64;
pub const SECTION_COUNT: usize = 16;
pub const DATA_START: usize = HEADER_LEN + SECTION_COUNT * 8;

/// Macro grid nodes per edge: one node every MACRO_RES_M, both edges included.
pub const N: usize = (WORLD_SIZE_M / MACRO_RES_M) as usize + 1;
pub const NN: usize = N * N;
pub const RES: f64 = MACRO_RES_M as f64;
pub const WORLD: f64 = WORLD_SIZE_M as f64;
pub const REGIONS: usize = (WORLD_REGIONS * WORLD_REGIONS) as usize;

pub mod sec {
    pub const SPEC: usize = 0;
    pub const PARAMS: usize = 1;
    pub const HEIGHT: usize = 2;
    pub const WATER: usize = 3;
    pub const FLOW: usize = 4;
    pub const RIVER: usize = 5;
    pub const BIOME: usize = 6;
    pub const TEMP: usize = 7;
    pub const MOIST: usize = 8;
    pub const NODEP: usize = 9;
    pub const REGIONS: usize = 10;
    pub const SITES: usize = 11;
    pub const NAMES: usize = 12;
    pub const COVERAGE: usize = 13;
}

/// PARAMS section: f64 slots.
pub mod param {
    pub const SEA_Y: usize = 0;
    pub const PEAK_H: usize = 1;
    pub const ROUGHNESS: usize = 2;
    pub const PLATEAUS: usize = 3;
    pub const ENEMY_DENSITY: usize = 4;
    pub const DANGER_CURVE: usize = 5;
    pub const FLAMMABILITY: usize = 6;
    pub const CAVE_DENSITY: usize = 7;
    pub const ORE_ABUNDANCE: usize = 8;
    pub const STRUCTURE_DENSITY: usize = 9;
    pub const SETTLEMENT_DENSITY: usize = 10;
    pub const TEMPERATURE_BIAS: usize = 11;
    pub const MOISTURE_BIAS: usize = 12;
    pub const WIND_DIR_DEG: usize = 13;
    pub const STORM_FREQUENCY: usize = 14;
    pub const DEMON_INTENSITY: usize = 15;
    pub const LOOT_THEME_MASK: usize = 16;
    pub const PALETTE: usize = 17;
    pub const NAME_GRAMMAR: usize = 18;
    pub const COVERAGE_800: usize = 19;
    pub const SPAWN_X: usize = 20;
    pub const SPAWN_Z: usize = 21;
    pub const SPAWN_Y: usize = 22;
    pub const LAND_FRACTION_ACTUAL: usize = 23;
    pub const COUNT: usize = 32;
}

pub const REGION_REC: usize = 32;
pub const SITE_REC: usize = 48;
pub const NONE16: u16 = 0xFFFF;

/// Site categories and kinds (byte 8 and 9 of a site record).
pub mod site {
    pub const CAT_POI: u8 = 0;
    pub const CAT_SETTLEMENT: u8 = 1;
    pub const CAT_STRUCTURE: u8 = 2;

    pub const POI_TOWER: u8 = 0;
    pub const POI_CAVE_MOUTH: u8 = 1;
    pub const POI_WAYPOINT: u8 = 2;
    pub const POI_LANDMARK: u8 = 3;
    pub const POI_ENEMY_CAMP: u8 = 4;
    pub const POI_NAMES: [&str; 5] = ["tower", "cave_mouth", "waypoint", "landmark", "enemy_camp"];

    pub const SIZE_HAMLET: u8 = 0;
    pub const SIZE_VILLAGE: u8 = 1;
    pub const SIZE_TOWN: u8 = 2;
    pub const SETTLEMENT_SIZES: [&str; 3] = ["hamlet", "village", "town"];

    pub const ST_RUIN: u8 = 0;
    pub const ST_WATCHTOWER: u8 = 1;
    pub const ST_MINESHAFT: u8 = 2;
    pub const ST_SHRINE: u8 = 3;
    pub const ST_BANDIT_CAMP: u8 = 4;
    pub const ST_WIZARD_TOWER: u8 = 5;
    pub const ST_METEOR_CRATER: u8 = 6;
    pub const ST_SUNKEN_TEMPLE: u8 = 7;
    pub const ST_DEMON_LAIR: u8 = 8;
    pub const STRUCTURE_NAMES: [&str; 9] = [
        "ruin", "watchtower", "mineshaft", "shrine", "bandit_camp", "wizard_tower", "meteor_crater", "sunken_temple", "demon_lair",
    ];
}

/// NODEP flags (byte 3 of each node's 4-byte record).
pub mod flag {
    pub const SEA: u8 = 1;
    pub const LAKE: u8 = 2;
    pub const RIVER: u8 = 4;
    pub const SETTLEMENT: u8 = 8;
}

#[inline]
pub fn idx(i: usize, j: usize) -> usize {
    j * N + i
}

/// Builds an atlas buffer section by section.
pub struct Writer {
    buf: Vec<u8>,
    dir: [(u32, u32); SECTION_COUNT],
}

impl Default for Writer {
    fn default() -> Self {
        Self::new()
    }
}

impl Writer {
    pub fn new() -> Self {
        Writer { buf: vec![0u8; DATA_START], dir: [(0, 0); SECTION_COUNT] }
    }

    pub fn section(&mut self, id: usize, data: &[u8]) {
        while self.buf.len() % 8 != 0 {
            self.buf.push(0);
        }
        self.dir[id] = (self.buf.len() as u32, data.len() as u32);
        self.buf.extend_from_slice(data);
    }

    pub fn header_mut(&mut self) -> &mut [u8] {
        &mut self.buf[..HEADER_LEN]
    }

    pub fn finish(mut self) -> Vec<u8> {
        while self.buf.len() % 8 != 0 {
            self.buf.push(0);
        }
        let len = self.buf.len() as u32;
        self.buf[0..4].copy_from_slice(&MAGIC);
        put_u16(&mut self.buf, 4, FORMAT_VERSION);
        put_u32(&mut self.buf, 8, len);
        put_u32(&mut self.buf, 12, HEADER_LEN as u32);
        for (k, (o, l)) in self.dir.iter().enumerate() {
            put_u32(&mut self.buf, HEADER_LEN + k * 8, *o);
            put_u32(&mut self.buf, HEADER_LEN + k * 8 + 4, *l);
        }
        self.buf
    }
}

#[inline]
pub fn put_u16(b: &mut [u8], o: usize, v: u16) {
    b[o..o + 2].copy_from_slice(&v.to_le_bytes());
}
#[inline]
pub fn put_u32(b: &mut [u8], o: usize, v: u32) {
    b[o..o + 4].copy_from_slice(&v.to_le_bytes());
}
#[inline]
pub fn put_u64(b: &mut [u8], o: usize, v: u64) {
    b[o..o + 8].copy_from_slice(&v.to_le_bytes());
}
#[inline]
pub fn put_f32(b: &mut [u8], o: usize, v: f32) {
    debug_assert!(v.is_finite(), "NaN/inf written to an output buffer");
    b[o..o + 4].copy_from_slice(&v.to_le_bytes());
}
#[inline]
pub fn put_f64(b: &mut [u8], o: usize, v: f64) {
    debug_assert!(v.is_finite(), "NaN/inf written to an output buffer");
    b[o..o + 8].copy_from_slice(&v.to_le_bytes());
}
#[inline]
pub fn get_u16(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
#[inline]
pub fn get_u32(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
#[inline]
pub fn get_u64(b: &[u8], o: usize) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[o..o + 8]);
    u64::from_le_bytes(a)
}
#[inline]
pub fn get_f32(b: &[u8], o: usize) -> f32 {
    f32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
#[inline]
pub fn get_f64(b: &[u8], o: usize) -> f64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[o..o + 8]);
    f64::from_le_bytes(a)
}

/// One site record, decoded.
#[derive(Clone, Copy, Debug)]
pub struct SiteRec {
    pub index: usize,
    pub id: u64,
    pub category: u8,
    pub kind: u8,
    pub region: u8,
    pub size: u8,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub radius: f64,
    pub seed: u32,
}

/// Zero-copy view over an atlas buffer.
pub struct Atlas<'a> {
    pub b: &'a [u8],
    off: [usize; SECTION_COUNT],
    len: [usize; SECTION_COUNT],
    pub seed: u64,
    pub gen_version: u16,
    pub sea_y: f64,
}

impl<'a> Atlas<'a> {
    pub fn parse(b: &'a [u8]) -> Result<Atlas<'a>, String> {
        if b.len() < DATA_START || b[0..4] != MAGIC {
            return Err("not an atlas (bad magic)".into());
        }
        let ver = get_u16(b, 4);
        if ver != FORMAT_VERSION {
            return Err(format!("atlas format {ver}, this build reads {FORMAT_VERSION}"));
        }
        let total = get_u32(b, 8) as usize;
        if total > b.len() {
            return Err(format!("atlas truncated: header says {total} bytes, have {}", b.len()));
        }
        let b = &b[..total];
        let mut off = [0usize; SECTION_COUNT];
        let mut len = [0usize; SECTION_COUNT];
        for k in 0..SECTION_COUNT {
            off[k] = get_u32(b, HEADER_LEN + k * 8) as usize;
            len[k] = get_u32(b, HEADER_LEN + k * 8 + 4) as usize;
            if off[k] + len[k] > total {
                return Err(format!("atlas section {k} out of bounds"));
            }
        }
        if get_u16(b, 28) as usize != N {
            return Err("atlas grid size mismatch".into());
        }
        for (s, per) in [(sec::HEIGHT, 4), (sec::WATER, 4), (sec::RIVER, 1), (sec::BIOME, 1), (sec::NODEP, 4), (sec::TEMP, 1), (sec::MOIST, 1)] {
            if len[s] != NN * per {
                return Err(format!("atlas section {s} has wrong size"));
            }
        }
        if len[sec::PARAMS] != param::COUNT * 8 {
            return Err("atlas params wrong size".into());
        }
        let a = Atlas { b, off, len, seed: get_u64(b, 16), gen_version: get_u16(b, 6), sea_y: get_f32(b, 32) as f64 };
        Ok(a)
    }

    #[inline]
    pub fn section(&self, s: usize) -> &'a [u8] {
        &self.b[self.off[s]..self.off[s] + self.len[s]]
    }
    #[inline]
    pub fn height(&self, k: usize) -> f64 {
        get_f32(self.b, self.off[sec::HEIGHT] + k * 4) as f64
    }
    #[inline]
    pub fn water(&self, k: usize) -> f64 {
        get_f32(self.b, self.off[sec::WATER] + k * 4) as f64
    }
    #[inline]
    pub fn river(&self, k: usize) -> u8 {
        self.b[self.off[sec::RIVER] + k]
    }
    #[inline]
    pub fn flow(&self, k: usize) -> u8 {
        self.b[self.off[sec::FLOW] + k]
    }
    #[inline]
    pub fn biome(&self, k: usize) -> u8 {
        self.b[self.off[sec::BIOME] + k]
    }
    #[inline]
    pub fn temp(&self, k: usize) -> f64 {
        self.b[self.off[sec::TEMP] + k] as f64 / 255.0
    }
    #[inline]
    pub fn moist(&self, k: usize) -> f64 {
        self.b[self.off[sec::MOIST] + k] as f64 / 255.0
    }
    /// Node params: [detail amp (0.1 m units), terrace (/255), ridge (/255), flags].
    #[inline]
    pub fn nodep(&self, k: usize) -> [u8; 4] {
        let o = self.off[sec::NODEP] + k * 4;
        [self.b[o], self.b[o + 1], self.b[o + 2], self.b[o + 3]]
    }
    #[inline]
    pub fn param(&self, slot: usize) -> f64 {
        get_f64(self.b, self.off[sec::PARAMS] + slot * 8)
    }
    pub fn region_danger(&self, r: usize) -> f64 {
        get_f32(self.b, self.off[sec::REGIONS] + r * REGION_REC + 8) as f64
    }
    pub fn site_count(&self) -> usize {
        if self.len[sec::SITES] < 8 {
            0
        } else {
            get_u32(self.b, self.off[sec::SITES]) as usize
        }
    }
    pub fn site(&self, i: usize) -> SiteRec {
        let o = self.off[sec::SITES] + 8 + i * SITE_REC;
        let b = self.b;
        SiteRec {
            index: i,
            id: get_u64(b, o),
            category: b[o + 8],
            kind: b[o + 9],
            region: b[o + 10],
            size: b[o + 11],
            x: get_f32(b, o + 12) as f64,
            y: get_f32(b, o + 16) as f64,
            z: get_f32(b, o + 20) as f64,
            radius: get_f32(b, o + 24) as f64,
            seed: get_u32(b, o + 40),
        }
    }
}
