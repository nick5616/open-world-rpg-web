//! Pass 1: the atlas, built once per world at mint (spec 5).
//!
//! Stages run in a fixed order over the macro grid (129 x 129 nodes at 32 m):
//! terrain -> hydrology -> climate/biomes -> sites (settlements, towers,
//! structures, POIs, coverage) -> node params -> serialize. Every stage is
//! sequential, single-threaded f64 math with libm, so the output bytes are
//! identical on every host; `hash_bytes(atlas)` is the world's atlasHash.

pub mod climate;
pub mod format;
pub mod hydro;
pub mod sites;
pub mod terrain;
pub mod viewshed;

use crate::gen::constants::{REGION_CHUNKS, WORLD_REGIONS};
use crate::gen::worldspec::{WorldSpec, NAME_GRAMMAR_VALUES, PALETTE_VALUES};
use crate::noise::{clamp01, smoothstep};
use crate::rng::{hash, unit, weighted_pick};
use crate::spec;
use format::*;

pub struct Site {
    pub id: u64,
    pub category: u8,
    pub kind: u8,
    pub region: u8,
    pub size: u8,
    pub x: f64,
    pub z: f64,
    pub y: f64,
    pub radius: f64,
    pub score: f64,
    pub name: u16,
    pub biome: u8,
    pub element: u8,
    pub vis_h: f64,
    pub vis_count: u16,
    pub seed: u32,
    pub yaw: u16,
    pub link: u16,
    pub node: usize,
    /// genVersion 3: 0 surface, 1 sky, 2 Underground, 3 Depths.
    pub layer: u8,
}

#[derive(Clone)]
pub struct Region {
    pub biome: u8,
    pub elem: u8,
    pub elem2: u8,
    pub name: u16,
    pub tower: u16,
    pub danger: f64,
    pub land: f64,
    pub hist: [f64; 6],
    pub settlements: u8,
    pub sites: u8,
}

/// Working state of the atlas pass.
pub struct World {
    pub seed: u64,
    pub spec: WorldSpec,
    pub sea_y: f64,
    pub peak_h: f64,
    pub anchors: Vec<(f64, f64)>,
    pub h: Vec<f64>,
    pub filled: Vec<f64>,
    pub flow: Vec<u8>,
    pub acc: Vec<f64>,
    pub sea: Vec<bool>,
    pub lake: Vec<bool>,
    pub water: Vec<f64>,
    pub river_w: Vec<u8>,
    pub slope: Vec<f64>,
    pub dist_water: Vec<f64>,
    pub dist_fresh: Vec<f64>,
    pub temp: Vec<f64>,
    pub moist: Vec<f64>,
    pub biome: Vec<u8>,
    pub regions: Vec<Region>,
    pub sites: Vec<Site>,
    pub names: Vec<String>,
    pub coverage: Vec<u8>,
    pub coverage_frac: f64,
    pub spawn: (f64, f64, f64),
}

/// Region index (rz * 4 + rx) of a world position.
pub fn region_of(x: f64, z: f64) -> usize {
    let size = (REGION_CHUNKS * crate::gen::constants::CHUNK_SIZE_M) as f64;
    let last = WORLD_REGIONS as i64 - 1;
    let rx = (libm::floor(x / size) as i64).clamp(0, last) as usize;
    let rz = (libm::floor(z / size) as i64).clamp(0, last) as usize;
    rz * WORLD_REGIONS as usize + rx
}

/// Element affinity per biome (spec 7 "richest in" column), rows = element
/// [fire, ice, lightning, earth, wind, light, dark, void], columns = biome.
const ELEMENT_BIOME: [[f64; 6]; 8] = [
    [0.4, 0.3, 0.6, 0.1, 2.0, 0.2],
    [0.2, 0.3, 0.8, 2.0, 0.1, 0.4],
    [0.6, 0.4, 1.6, 0.8, 0.6, 0.8],
    [1.0, 1.8, 0.8, 0.4, 0.6, 1.6],
    [0.9, 0.4, 1.4, 1.0, 0.7, 0.4],
    [0.9, 0.6, 0.9, 1.2, 0.8, 0.4],
    [0.4, 0.8, 0.5, 0.5, 0.7, 1.0],
    [0.15, 0.15, 0.2, 0.25, 0.3, 0.2],
];

/// Biome mix, dominant + secondary element (weighted by `elementWeights` and
/// the biome mix, then a seeded draw) and danger by distance from spawn.
pub fn regions(w: &World, spawn: (f64, f64, f64)) -> Vec<Region> {
    let ew = spec::element_weight_array(&w.spec);
    let per = (N - 1) / WORLD_REGIONS as usize;
    let region_m = (REGION_CHUNKS * crate::gen::constants::CHUNK_SIZE_M) as f64;
    // dangerCurve 0 -> slow rise (exponent 1.6), 1 -> danger right outside spawn (0.6).
    let expo = 1.6 + (0.6 - 1.6) * w.spec.danger_curve;
    let mut out = Vec::new();
    for r in 0..REGIONS {
        let (rx, rz) = (r % WORLD_REGIONS as usize, r / WORLD_REGIONS as usize);
        let mut counts = [0.0f64; 6];
        let mut land = 0.0;
        for j in rz * per..(rz + 1) * per {
            for i in rx * per..(rx + 1) * per {
                let k = idx(i, j);
                if !w.sea[k] {
                    counts[w.biome[k] as usize] += 1.0;
                    land += 1.0;
                }
            }
        }
        let hist: [f64; 6] = core::array::from_fn(|b| if land > 0.0 { counts[b] / land } else { 0.0 });
        let mut biome = 0usize;
        for b in 0..6 {
            if hist[b] > hist[biome] {
                biome = b;
            }
        }
        let mut scores = [0.0f64; 8];
        for e in 0..8 {
            scores[e] = (0..6).map(|b| hist[b] * ELEMENT_BIOME[e][b]).sum::<f64>() * ew[e];
        }
        let u1 = unit(hash(w.seed, 0x454C_454D, r as i64, 1, 0)); // "ELEM"
        let elem = weighted_pick(&scores, u1);
        scores[elem] = 0.0;
        let u2 = unit(hash(w.seed, 0x454C_454D, r as i64, 2, 0));
        let mut elem2 = weighted_pick(&scores, u2);
        if elem2 == elem {
            elem2 = (elem + 1) % 8;
        }
        let cx = (rx as f64 + 0.5) * region_m;
        let cz = (rz as f64 + 0.5) * region_m;
        let d = libm::sqrt((cx - spawn.0) * (cx - spawn.0) + (cz - spawn.1) * (cz - spawn.1));
        let danger = clamp01(libm::pow(d / 2900.0, expo));
        out.push(Region {
            biome: biome as u8,
            elem: elem as u8,
            elem2: elem2 as u8,
            name: NONE16,
            tower: NONE16,
            danger,
            land: land / (per * per) as f64,
            hist,
            settlements: 0,
            sites: 0,
        });
    }
    out
}

/// Detail amplitude (m) of the chunk pass per biome, before roughness/slope.
const BIOME_AMP: [f64; 6] = [2.0, 3.0, 6.0, 7.0, 4.5, 0.8];

/// Per-node parameters the chunk pass blends: detail amplitude, terrace and
/// ridge weights, and flags. Walled-town footprints are flattened here so
/// WP20 gets buildable ground without re-shaping terrain; since genVersion 2
/// hamlets and villages keep the natural ground.
fn node_params(w: &World) -> Vec<u8> {
    let mut out = vec![0u8; NN * 4];
    let rough = 0.6 + 0.8 * w.spec.roughness;
    for k in 0..NN {
        let (x, z) = ((k % N) as f64 * RES, (k / N) as f64 * RES);
        let b = w.biome[k] as usize;
        let slope = w.slope[k];
        let mut amp = BIOME_AMP[b] * rough * (1.0 + slope / 30.0);
        let mut terrace = match b as u8 {
            climate::BADLANDS => 0.35 + 0.65 * w.spec.plateaus,
            climate::HIGHLANDS => 0.3 * w.spec.plateaus,
            _ => 0.0,
        };
        let mut ridge = match b as u8 {
            climate::HIGHLANDS => 0.5,
            climate::SNOWPEAK => 0.8,
            _ => 0.0,
        } * (0.4 + 0.6 * smoothstep(5.0, 25.0, slope));
        let mut flags = 0u8;
        if w.sea[k] {
            flags |= flag::SEA;
        }
        if w.lake[k] {
            flags |= flag::LAKE;
            amp *= 0.3;
        }
        if w.river_w[k] > 0 {
            flags |= flag::RIVER;
        }
        for s in &w.sites {
            if s.category == site::CAT_SETTLEMENT && s.layer == 0 {
                let d = libm::sqrt((s.x - x) * (s.x - x) + (s.z - z) * (s.z - z));
                if d <= s.radius + RES {
                    flags |= flag::SETTLEMENT;
                    if s.size == site::SIZE_TOWN {
                        // Walled towns keep their levelled courts.
                        amp *= 0.25;
                        terrace = 0.0;
                        ridge = 0.0;
                    } else {
                        // genVersion 2 (playtest 1): hamlets and villages sit
                        // on the natural, uneven ground and their buildings
                        // stand on foundations (town/kit.rs). Only mesa steps
                        // and ridges are softened so lots stay buildable.
                        terrace *= 0.3;
                        ridge *= 0.5;
                    }
                }
            }
        }
        out[k * 4] = libm::round(amp.min(25.5) * 10.0) as u8;
        out[k * 4 + 1] = libm::round(clamp01(terrace) * 255.0) as u8;
        out[k * 4 + 2] = libm::round(clamp01(ridge) * 255.0) as u8;
        out[k * 4 + 3] = flags;
    }
    out
}

pub fn build(spec: &WorldSpec, seed: u64) -> Result<Vec<u8>, String> {
    spec::validate(spec)?;
    if spec.seed.parse::<u64>().ok() != Some(seed) {
        return Err(format!("spec.seed {} does not match seed argument {seed}", spec.seed));
    }
    // seaLevel 0..1 -> absolute sea height 4..44 m; the vertical range above
    // it is shared by mountains (peak 140..700 m above sea by mountainHeight).
    let sea_y = (4.0 + 40.0 * spec.sea_level) as f32 as f64;
    let peak_h = 140.0 + 560.0 * spec.mountain_height;
    let mut w = World {
        seed,
        spec: spec.clone(),
        sea_y,
        peak_h,
        anchors: Vec::new(),
        h: Vec::new(),
        filled: Vec::new(),
        flow: Vec::new(),
        acc: Vec::new(),
        sea: Vec::new(),
        lake: Vec::new(),
        water: Vec::new(),
        river_w: Vec::new(),
        slope: Vec::new(),
        dist_water: Vec::new(),
        dist_fresh: Vec::new(),
        temp: Vec::new(),
        moist: Vec::new(),
        biome: Vec::new(),
        regions: Vec::new(),
        sites: Vec::new(),
        names: Vec::new(),
        coverage: Vec::new(),
        coverage_frac: 0.0,
        spawn: (0.0, 0.0, 0.0),
    };
    terrain::generate(&mut w);
    hydro::run(&mut w);
    climate::run(&mut w);
    sites::place(&mut w);
    // genVersion 3: the vertical world's sites go after every base site, so
    // each base site keeps its index and id (renewal rule). The plan reads
    // only base content, so the atlas it is built from here and the final
    // atlas give the same plan.
    let pre = serialize(&w);
    let a = Atlas::parse(&pre)?;
    let plan = crate::vertical::plan_sites(&a)?;
    let base = w.sites.len();
    for (k, ns) in plan.sites.iter().enumerate() {
        let index = base + k;
        let lay = 0x40 | (ns.category << 4) | ns.kind;
        let id = crate::rng::stable_id(lay, 1 + ns.layer as i32, k as i32, index as u32);
        let name = if ns.name.is_empty() {
            NONE16
        } else {
            w.names.push(ns.name.clone());
            (w.names.len() - 1) as u16
        };
        w.sites.push(Site {
            id,
            category: ns.category,
            kind: ns.kind,
            region: ns.region,
            size: ns.size,
            x: ns.x,
            z: ns.z,
            y: ns.y,
            radius: ns.radius,
            score: 0.0,
            name,
            biome: ns.biome,
            element: ns.element,
            vis_h: 0.0,
            vis_count: 0,
            seed: crate::rng::hash(seed, 0x5659_0010, id as i64, 1, 0) as u32,
            yaw: ns.yaw,
            link: if ns.link_local == NONE16 { NONE16 } else { (base + ns.link_local as usize) as u16 },
            node: 0,
            layer: ns.layer,
        });
    }
    Ok(serialize(&w))
}

fn serialize(w: &World) -> Vec<u8> {
    let mut wr = Writer::new();
    wr.section(sec::SPEC, &spec::to_json(&w.spec));

    let mut params = vec![0u8; param::COUNT * 8];
    let s = &w.spec;
    let mut p = |slot: usize, v: f64| put_f64(&mut params, slot * 8, v);
    p(param::SEA_Y, w.sea_y);
    p(param::PEAK_H, w.peak_h);
    p(param::ROUGHNESS, s.roughness);
    p(param::PLATEAUS, s.plateaus);
    p(param::ENEMY_DENSITY, s.enemy_density);
    p(param::DANGER_CURVE, s.danger_curve);
    p(param::FLAMMABILITY, s.flammability);
    p(param::CAVE_DENSITY, s.cave_density);
    p(param::ORE_ABUNDANCE, s.ore_abundance);
    p(param::STRUCTURE_DENSITY, s.structure_density);
    p(param::SETTLEMENT_DENSITY, s.settlement_density);
    p(param::TEMPERATURE_BIAS, s.temperature_bias);
    p(param::MOISTURE_BIAS, s.moisture_bias);
    p(param::WIND_DIR_DEG, s.wind_direction as f64);
    p(param::STORM_FREQUENCY, s.storm_frequency);
    p(param::DEMON_INTENSITY, s.demon_intensity);
    p(param::LOOT_THEME_MASK, spec::loot_theme_mask(s) as f64);
    p(param::PALETTE, PALETTE_VALUES.iter().position(|v| *v == s.palette).unwrap_or(0) as f64);
    p(
        param::NAME_GRAMMAR,
        NAME_GRAMMAR_VALUES.iter().position(|v| *v == s.name_grammar).unwrap_or(0) as f64,
    );
    p(param::COVERAGE_800, w.coverage_frac);
    p(param::SPAWN_X, w.spawn.0);
    p(param::SPAWN_Z, w.spawn.1);
    p(param::SPAWN_Y, w.spawn.2);
    p(param::LAND_FRACTION_ACTUAL, w.sea.iter().filter(|&&x| !x).count() as f64 / NN as f64);
    wr.section(sec::PARAMS, &params);

    let mut hb = vec![0u8; NN * 4];
    let mut wb = vec![0u8; NN * 4];
    let (mut min_h, mut max_h) = (f32::MAX, f32::MIN);
    for k in 0..NN {
        let hv = w.h[k] as f32;
        min_h = min_h.min(hv);
        max_h = max_h.max(hv);
        put_f32(&mut hb, k * 4, hv);
        put_f32(&mut wb, k * 4, w.water[k] as f32);
    }
    wr.section(sec::HEIGHT, &hb);
    wr.section(sec::WATER, &wb);
    wr.section(sec::FLOW, &w.flow);
    wr.section(sec::RIVER, &w.river_w);
    wr.section(sec::BIOME, &w.biome);
    let q = |v: &[f64]| -> Vec<u8> { v.iter().map(|&x| libm::round(clamp01(x) * 255.0) as u8).collect() };
    wr.section(sec::TEMP, &q(&w.temp));
    wr.section(sec::MOIST, &q(&w.moist));
    wr.section(sec::NODEP, &node_params(w));

    let mut rb = vec![0u8; REGIONS * REGION_REC];
    for (r, reg) in w.regions.iter().enumerate() {
        let o = r * REGION_REC;
        rb[o] = r as u8;
        rb[o + 1] = reg.biome;
        rb[o + 2] = reg.elem;
        rb[o + 3] = reg.elem2;
        put_u16(&mut rb, o + 4, reg.name);
        put_u16(&mut rb, o + 6, reg.tower);
        put_f32(&mut rb, o + 8, reg.danger as f32);
        put_f32(&mut rb, o + 12, reg.land as f32);
        for b in 0..6 {
            rb[o + 16 + b] = libm::round(reg.hist[b] * 255.0) as u8;
        }
        rb[o + 22] = reg.settlements;
        rb[o + 23] = reg.sites;
    }
    wr.section(sec::REGIONS, &rb);

    let mut sb = vec![0u8; 8 + w.sites.len() * SITE_REC];
    put_u32(&mut sb, 0, w.sites.len() as u32);
    put_u32(&mut sb, 4, SITE_REC as u32);
    for (i, st) in w.sites.iter().enumerate() {
        let o = 8 + i * SITE_REC;
        put_u64(&mut sb, o, st.id);
        sb[o + 8] = st.category;
        sb[o + 9] = st.kind;
        sb[o + 10] = st.region;
        sb[o + 11] = st.size;
        put_f32(&mut sb, o + 12, st.x as f32);
        put_f32(&mut sb, o + 16, st.y as f32);
        put_f32(&mut sb, o + 20, st.z as f32);
        put_f32(&mut sb, o + 24, st.radius as f32);
        put_f32(&mut sb, o + 28, st.score as f32);
        put_u16(&mut sb, o + 32, st.name);
        sb[o + 34] = st.biome;
        sb[o + 35] = st.element;
        sb[o + 36] = libm::round(st.vis_h.min(255.0)) as u8;
        put_u16(&mut sb, o + 38, st.vis_count);
        put_u32(&mut sb, o + 40, st.seed);
        put_u16(&mut sb, o + 44, st.yaw);
        put_u16(&mut sb, o + 46, st.link);
        sb[o + 37] = st.layer;
    }
    wr.section(sec::SITES, &sb);

    let mut nb = Vec::new();
    nb.extend_from_slice(&(w.names.len() as u32).to_le_bytes());
    for n in &w.names {
        let bytes = n.as_bytes();
        let len = bytes.len().min(u16::MAX as usize);
        nb.extend_from_slice(&(len as u16).to_le_bytes());
        nb.extend_from_slice(&bytes[..len]);
    }
    wr.section(sec::NAMES, &nb);
    wr.section(sec::COVERAGE, &w.coverage);

    let gen_version = crate::GEN_VERSION;
    let site_count = w.sites.len() as u32;
    let name_count = w.names.len() as u32;
    let hdr = wr.header_mut();
    put_u16(hdr, 6, gen_version);
    put_u64(hdr, 16, w.seed);
    put_u16(hdr, 24, (N - 1) as u16 * RES as u16);
    put_u16(hdr, 26, RES as u16);
    put_u16(hdr, 28, N as u16);
    hdr[30] = WORLD_REGIONS as u8;
    hdr[31] = REGION_CHUNKS as u8;
    put_f32(hdr, 32, w.sea_y as f32);
    put_f32(hdr, 36, w.spawn.0 as f32);
    put_f32(hdr, 40, w.spawn.1 as f32);
    put_f32(hdr, 44, min_h);
    put_f32(hdr, 48, max_h);
    put_u32(hdr, 52, site_count);
    put_u32(hdr, 56, name_count);
    wr.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::spec_from_seed;

    #[test]
    fn atlas_invariants() {
        let seed = 42;
        let s = spec_from_seed(seed);
        let a = build(&s, seed).unwrap();
        let v = Atlas::parse(&a).unwrap();
        assert_eq!(v.seed, seed);
        // Every region has a tower and a settlement.
        let mut tower = [false; REGIONS];
        let mut town = [false; REGIONS];
        let mut ids = Vec::new();
        for i in 0..v.site_count() {
            let st = v.site(i);
            ids.push(st.id);
            if st.category == site::CAT_POI && st.kind == site::POI_TOWER {
                tower[st.region as usize] = true;
            }
            if st.category == site::CAT_SETTLEMENT {
                town[st.region as usize] = true;
            }
        }
        assert!(tower.iter().all(|&t| t), "tower per region");
        assert!(town.iter().all(|&t| t), "settlement per region");
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), v.site_count(), "site ids unique");
        assert!(a.len() < 2 * 1024 * 1024);
        // Same input, same bytes.
        assert_eq!(a, build(&s, seed).unwrap());
    }

    #[test]
    fn seed_mismatch_rejected() {
        let s = spec_from_seed(5);
        assert!(build(&s, 6).is_err());
    }
}
