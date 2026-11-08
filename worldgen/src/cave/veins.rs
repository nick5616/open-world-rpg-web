//! Ore veins, gems and glowing decorations (spec 7 "Elements and gems",
//! "Ores", "Mining").
//!
//! Veins are clusters on chamber walls. Each has a stable id
//! `stable_id(LAYER_VEIN, mouth site index, chamber index, vein index)`
//! (README "Stable ids"), a material, and hit points; the zone server owns
//! their state (damage, breaks, respawns) and the generator only says what
//! the untouched world holds.
//!
//! What a vein holds follows the region's rocks:
//! - Gem chance scales with (depth / caveMaxDepth) ^ gemRarityCurve, then by
//!   how well the chamber's biome suits the region's dominant gem.
//! - Gem element: the region's dominant element (weight 4), its secondary
//!   (2), the rest (0.4), each times its biome affinity; Dark grows with
//!   depth, Void (amethyst) only in the deepest quarter, Light (sunstone)
//!   mostly where daylight reaches. Opal and Moonstone are rare utility gems.
//! - Ore by depth band: copper (shallow), iron (shallow-mid), silver (mid),
//!   sunsteel (mid-deep and only in veins that touch daylight), voidglass
//!   (deepest band). Starmetal comes from meteor craters (WP20 structures):
//!   `crater_veins` is the hook and returns nothing here.

use super::field::eval;
use super::graph::{band_of, CaveParams, CaveWorld, System, CH_SUNLIT};
use crate::atlas::format::Atlas;
use crate::rng::{stable_id, unit, Seq};

pub const LAYER_VEIN: u8 = 7;

pub const KIND_ORE: u8 = 0;
pub const KIND_GEM: u8 = 1;

pub const ORE_COPPER: u8 = 0;
pub const ORE_IRON: u8 = 1;
pub const ORE_SILVER: u8 = 2;
pub const ORE_SUNSTEEL: u8 = 3;
pub const ORE_STARMETAL: u8 = 4;
pub const ORE_VOIDGLASS: u8 = 5;
pub const ORE_NAMES: [&str; 6] = ["copper", "iron", "silver", "sunsteel", "starmetal", "voidglass"];

/// Gem ids 0..7 follow the element order (fire, ice, lightning, earth, wind,
/// light, dark, void); 8 and 9 are the utility gems.
pub const GEM_NAMES: [&str; 10] = ["ruby", "sapphire", "topaz", "emerald", "aquamarine", "sunstone", "onyx", "amethyst", "opal", "moonstone"];
pub const GEM_OPAL: u8 = 8;
pub const GEM_MOONSTONE: u8 = 9;

pub const VEIN_SUNLIT: u8 = 1;
pub const VEIN_MINED: u8 = 2;

pub const DECO_FUNGUS: u8 = 0;
pub const DECO_CRYSTAL: u8 = 1;
pub const DECO_STALAGMITE: u8 = 2;

/// Element affinity by biome (rows: meadow, forest, highlands, snowpeak,
/// badlands, wetland; columns: fire, ice, lightning, earth, wind, light,
/// dark, void), from the spec 7 "Richest in" column. Same table spirit as
/// the atlas region roll (WP01), kept local so tuning caves never shifts the
/// atlas.
const AFFINITY: [[f64; 8]; 6] = [
    [0.8, 0.6, 0.9, 1.2, 1.0, 1.0, 0.8, 0.7],
    [0.7, 0.7, 0.8, 1.5, 0.9, 0.9, 0.9, 0.8],
    [0.9, 0.9, 1.5, 0.9, 1.3, 1.1, 0.9, 0.9],
    [0.5, 1.6, 1.0, 0.7, 1.3, 1.2, 0.9, 0.9],
    [1.6, 0.4, 1.0, 0.8, 0.9, 1.1, 1.0, 0.9],
    [0.6, 0.8, 1.0, 1.5, 0.8, 0.8, 1.1, 0.9],
];

/// Base hit points by ore id; gems use GEM_HP + depth.
const ORE_HP: [f64; 6] = [60.0, 90.0, 120.0, 160.0, 200.0, 220.0];
const GEM_HP: f64 = 100.0;

#[derive(Clone, Copy, Debug)]
pub struct Vein {
    pub id: u64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    /// Unit normal pointing out of the wall into the air.
    pub n: [f64; 3],
    pub kind: u8,
    pub material: u8,
    pub element: u8,
    pub hp: u16,
    pub size: u8,
    pub flags: u8,
    pub band: u8,
    pub chamber: u16,
    pub system: u16,
}

#[derive(Clone, Copy, Debug)]
pub struct Deco {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub kind: u8,
    /// Element tint (0..7) for fungi and crystals.
    pub variant: u8,
    pub scale: u8,
    pub yaw: u8,
    pub system: u16,
}

/// Starmetal hook (spec 7: meteor craters, WP20 structures). WP20 places the
/// crater geometry; it should emit veins with material ORE_STARMETAL through
/// this function so ids, hit points and the record format stay in one place.
pub fn crater_veins(_a: &Atlas, _crater_site_index: usize) -> Vec<Vein> {
    Vec::new()
}

fn noise_scale_at(sys: &System, x: f64, z: f64) -> f64 {
    sys.openings.iter().map(|o| o.noise_scale(x, z)).fold(1.0, f64::min)
}

/// Field of one system at p (what cave_build sees, minus surface terms and
/// edits, which never apply where veins sit: deep inside chambers).
pub fn sys_field(sys: &System, seed: u32, p: [f64; 3]) -> f64 {
    eval(&sys.elems, seed, p, noise_scale_at(sys, p[0], p[2]))
}

/// March from `from` along unit `dir` until the field turns solid. Returns
/// the last air point, or None if it stays air (opening) or starts in rock.
fn wall_hit(sys: &System, seed: u32, from: [f64; 3], dir: [f64; 3], max: f64) -> Option<[f64; 3]> {
    if sys_field(sys, seed, from) >= 0.0 {
        return None;
    }
    let mut t = 0.0;
    let mut last = from;
    while t < max {
        t += 0.25;
        let p = [from[0] + dir[0] * t, from[1] + dir[1] * t, from[2] + dir[2] * t];
        if sys_field(sys, seed, p) >= 0.0 {
            return Some(last);
        }
        last = p;
    }
    None
}

/// Outward normal (into air) from the field gradient at p.
fn normal_at(sys: &System, seed: u32, p: [f64; 3]) -> [f64; 3] {
    let e = 0.35;
    let gx = sys_field(sys, seed, [p[0] + e, p[1], p[2]]) - sys_field(sys, seed, [p[0] - e, p[1], p[2]]);
    let gy = sys_field(sys, seed, [p[0], p[1] + e, p[2]]) - sys_field(sys, seed, [p[0], p[1] - e, p[2]]);
    let gz = sys_field(sys, seed, [p[0], p[1], p[2] + e]) - sys_field(sys, seed, [p[0], p[1], p[2] - e]);
    let l = libm::sqrt(gx * gx + gy * gy + gz * gz);
    if l > 1e-9 {
        [-gx / l, -gy / l, -gz / l]
    } else {
        [0.0, 1.0, 0.0]
    }
}

fn pick(weights: &[f64], u: f64) -> u8 {
    crate::rng::weighted_pick(weights, u) as u8
}

/// Roll what one vein holds.
#[allow(clippy::too_many_arguments)]
fn roll(p: &CaveParams, sys: &System, biome: u8, depth: f64, sunlit: bool, near_peak: bool, u1: f64, u2: f64) -> (u8, u8, u8) {
    let depth_frac = (depth / p.cave_max_depth).clamp(0.0, 1.0);
    let band = band_of(depth);
    let aff = &AFFINITY[(biome as usize).min(5)];
    let gem_chance = ((0.06 + 0.6 * libm::pow(depth_frac, p.gem_rarity_curve)) * aff[sys.elem as usize & 7]).clamp(0.02, 0.75);
    if u1 < gem_chance {
        let mut w = [0.0f64; 10];
        for e in 0..8 {
            let base = if e == sys.elem as usize {
                4.0
            } else if e == sys.elem2 as usize {
                2.0
            } else {
                0.4
            };
            let mut gate = 1.0;
            if e == 6 {
                gate = 0.2 + 2.0 * depth_frac; // onyx: deep caves
            }
            if e == 7 {
                // amethyst: deepest quarter only, and the rarest even there
                gate = if depth_frac < 0.75 { 0.0 } else { 0.3 };
            }
            if e == 5 {
                gate = if sunlit { 3.0 } else { 0.15 }; // sunstone: sunlit sinkholes and peaks
            }
            w[e] = base * aff[e] * gate;
        }
        w[GEM_OPAL as usize] = 0.35;
        w[GEM_MOONSTONE as usize] = 0.35;
        let g = pick(&w, u2);
        let element = if g < 8 { g } else { sys.elem };
        return (KIND_GEM, g, element);
    }
    let sun = sunlit && (band >= 1 || near_peak);
    let w: [f64; 6] = match band {
        0 => [60.0, 40.0, 0.0, if sun { 18.0 } else { 0.0 }, 0.0, 0.0],
        1 => [15.0, 45.0, 35.0, if sun { 25.0 } else { 0.0 }, 0.0, 0.0],
        _ => [
            0.0,
            25.0,
            35.0,
            if sun { 25.0 } else { 0.0 },
            0.0,
            if depth >= 200.0 || depth_frac >= 0.8 { 20.0 } else { 0.0 },
        ],
    };
    (KIND_ORE, pick(&w, u2), sys.elem)
}

pub fn place_all(a: &Atlas, p: &CaveParams, w: &mut CaveWorld) {
    let seed = w.noise_seed;
    for sys in w.systems.iter_mut() {
        let mut seq = Seq::new(a.seed, 0x5645_494E ^ ((sys.site_index as u64) << 20)); // "VEIN"
        let near_peak = sys.mouth_y - p.sea_y > 0.55 * p.peak_h;
        let mut veins = Vec::new();
        let mut decos = Vec::new();
        for (ci, c) in sys.chambers.iter().enumerate() {
            let depth_frac = (c.depth / p.cave_max_depth).clamp(0.0, 1.0);
            let count = libm::round((1.0 + 3.0 * p.ore_abundance) * (0.6 + 0.8 * seq.unit()) * (1.0 + 0.5 * depth_frac)) as usize;
            let sunlit = c.flags & CH_SUNLIT != 0;
            let biome = {
                let i = (libm::round(c.x / crate::atlas::format::RES) as usize).min(crate::atlas::format::N - 1);
                let j = (libm::round(c.z / crate::atlas::format::RES) as usize).min(crate::atlas::format::N - 1);
                a.biome(crate::atlas::format::idx(i, j))
            };
            let from = [c.x, c.floor + 1.3, c.z];
            let mut vi = 0u32;
            for _ in 0..count {
                let az = seq.unit() * core::f64::consts::TAU;
                let el = -0.12 + 0.55 * seq.unit();
                let (u1, u2, us) = (seq.unit(), seq.unit(), seq.unit());
                let dir = [libm::cos(el) * libm::cos(az), libm::sin(el), libm::cos(el) * libm::sin(az)];
                let Some(hit) = wall_hit(sys, seed, from, dir, c.rx + 5.0) else { continue };
                if hit[1] < c.floor + 0.25 {
                    continue;
                }
                let n = normal_at(sys, seed, hit);
                let depth = sys.mouth_y - hit[1];
                let (kind, material, element) = roll(p, sys, biome, depth, sunlit, near_peak, u1, u2);
                let size = 3 + (us * 5.0) as u8;
                let base = if kind == KIND_GEM { GEM_HP + 60.0 * depth_frac } else { ORE_HP[material as usize] };
                let hp = libm::round(base * (0.8 + 0.1 * size as f64)) as u16;
                veins.push(Vein {
                    id: stable_id(LAYER_VEIN, sys.site_index as i32, ci as i32, vi),
                    x: hit[0] as f32 as f64,
                    y: hit[1] as f32 as f64,
                    z: hit[2] as f32 as f64,
                    n,
                    kind,
                    material,
                    element,
                    hp,
                    size,
                    flags: if sunlit { VEIN_SUNLIT } else { 0 },
                    band: band_of(depth),
                    chamber: ci as u16,
                    system: sys.index,
                });
                vi += 1;
            }
            // Glowing fungi and crystal shards on the floor: the light you see
            // by underground (spec 7 "Light and sound underground").
            let nd = 2 + (4.0 * seq.unit() + 3.0 * depth_frac) as usize;
            for k in 0..nd {
                let r = c.rx * 0.75 * libm::sqrt(seq.unit());
                let ang = seq.unit() * core::f64::consts::TAU;
                let x = c.x + libm::cos(ang) * r;
                let z = c.z + libm::sin(ang) * r;
                let top = [x, c.y, z];
                let Some(hit) = wall_hit(sys, seed, top, [0.0, -1.0, 0.0], c.ry + 4.0) else { continue };
                let roll_kind = unit(seq.next_u64());
                let kind = if roll_kind < 0.6 {
                    DECO_FUNGUS
                } else if roll_kind < 0.8 {
                    DECO_CRYSTAL
                } else {
                    DECO_STALAGMITE
                };
                let variant = if seq.unit() < 0.7 { sys.elem } else { sys.elem2 };
                decos.push(Deco {
                    x: x as f32 as f64,
                    y: (hit[1] - 0.05) as f32 as f64,
                    z: z as f32 as f64,
                    kind,
                    variant,
                    scale: (80.0 + 175.0 * seq.unit()) as u8,
                    yaw: (seq.unit() * 256.0) as u8 ^ (k as u8),
                    system: sys.index,
                });
            }
        }
        sys.veins = veins;
        sys.decos = decos;
    }
}
