//! The vertical world (playtest 2, genVersion 3, docs/cr/038-vertical-world.md):
//! sky archipelagos above the land, a vast cavern layer ("the Underground")
//! below the caves, and the Depths under it.
//!
//! Every layer is a pair of heightfields over the same 1 m lattice as the
//! terrain (`crate::ground`), so hosts collide with them exactly like with
//! the terrain: f32 lattice values, the same triangle split, the same f64
//! interpolation (`ground::tri_interp`), identical bits in TS and Go.
//!
//! | Layer | Surface A | Surface B | Air / solid |
//! | --- | --- | --- | --- |
//! | Sky (1) | island top T | island bottom B | solid between B and T where T > B |
//! | Underground (2) | floor F | ceiling C | air between F and C where C > F |
//! | Depths (3) | floor F | ceiling C | air between F and C; the water surface is lava |
//!
//! A third lattice W is the layer's water (lakes, rivers) or lava. Openings
//! cut holes into the layer above (tunnel mouths and cenote shafts into the
//! terrain, Depths gates into the Underground floor) with the same triangle
//! centroid rule as cave mouths (`cave::mask`).
//!
//! The plan (every island, chamber, corridor, opening, column, updraft,
//! decoration and vein) is a pure function of the base atlas: the atlas
//! pass builds it once to append its sites (tunnel entrances, caverns, sky
//! towns, palaces...), hosts rebuild it per thread on first use (cached
//! like the caves). Module table:
//!
//! | Module | What |
//! | --- | --- |
//! | `sky` | Archipelagos, islands, sky towns, palace sites, ruins, wind columns, sky lifts |
//! | `under` | Tunnel entrances, cavern chambers, corridors, rivers, cenotes, camps, Depths gates and halls |
//! | `field` | Lattice values of every surface at a point |
//! | `decor` | Decorations (crystals, flora, falls, vents...), columns and veins, placed on the field |
//! | `desc` | The descriptor buffer (`LDVT`) |
//! | `tile` | Lattice tiles (`LDLT`) |
//! | `abi` | wasm exports `vertical_build`, `layer_tile`, `layer_height` |

pub mod abi;
pub mod decor;
pub mod desc;
pub mod dwarf;
pub mod field;
pub mod sky;
pub mod tile;
pub mod under;

use crate::atlas::format::{sec, site as S, Atlas, SiteRec};
use std::cell::RefCell;
use std::rc::Rc;

pub const LAYER_SURFACE: u8 = 0;
pub const LAYER_SKY: u8 = 1;
pub const LAYER_UNDER: u8 = 2;
pub const LAYER_DEPTHS: u8 = 3;

/// Ceiling value inside an opening (open to the layer above).
pub const OPEN_C: f64 = 10000.0;
/// Water value where a layer has no water.
pub const NO_WATER: f64 = -10000.0;
/// Chunks per world edge (64 m chunks).
pub const CHUNKS: usize = 64;

/// Stable-id layers owned by the vertical world (rng::stable_id). 0x30..0x37.
pub mod idl {
    pub const ISLAND: u8 = 0x30;
    pub const ARCH: u8 = 0x31;
    pub const CHAMBER: u8 = 0x32;
    pub const VEIN: u8 = 0x33;
    pub const DECO: u8 = 0x34;
}

/// Seed streams (rng::hash stream argument).
pub mod stream {
    pub const SKY: u64 = 0x5659_0001;
    pub const ISLAND: u64 = 0x5659_0002;
    pub const UNDER: u64 = 0x5659_0003;
    pub const CHAMBER: u64 = 0x5659_0004;
    pub const CORRIDOR: u64 = 0x5659_0005;
    pub const DECOR: u64 = 0x5659_0006;
    pub const DEPTHS: u64 = 0x5659_0007;
    pub const NAMES: u64 = 0x5659_0008;
    pub const DWARF: u64 = 0x5659_0009;
    pub const DRESS: u64 = 0x5659_000A;
}

/// Island kinds.
pub mod ik {
    pub const GROVE: u8 = 0;
    pub const MEADOW: u8 = 1;
    pub const CRAG: u8 = 2;
    pub const TOWN: u8 = 3;
    pub const PALACE: u8 = 4;
    pub const RUIN: u8 = 5;
    pub const NAMES: [&str; 6] = ["grove", "meadow", "crag", "town", "palace", "ruin"];
}

/// Chamber kinds.
pub mod ck {
    pub const CRYSTAL: u8 = 0;
    pub const CENOTE: u8 = 1;
    pub const RIVER: u8 = 2;
    pub const FUNGAL: u8 = 3;
    pub const INFERNO: u8 = 4;
    pub const ASHEN: u8 = 5;
    /// genVersion 4 (docs/cr/043-dwarves.md): the dwarven camps, strongholds and lower halls.
    pub const DWARF_CAMP: u8 = 6;
    pub const STRONGHOLD: u8 = 7;
    pub const LOWER_HALLS: u8 = 8;
    pub const NAMES: [&str; 9] = ["crystal", "cenote", "river", "fungal", "inferno", "ashen", "dwarf_camp", "stronghold", "lower_halls"];
}

/// Corridor kinds.
pub mod rk {
    pub const TUNNEL: u8 = 0;
    pub const RIVER: u8 = 1;
    pub const DESCENT: u8 = 2;
    pub const PASSAGE: u8 = 3;
    /// genVersion 4: the side passages to dwarven camps and strongholds.
    pub const SECRET: u8 = 4;
}

/// Opening kinds.
pub mod ok {
    pub const TUNNEL: u8 = 0;
    pub const CENOTE: u8 = 1;
    pub const GATE: u8 = 2;
}

/// Updraft kinds.
pub mod uk {
    pub const COLUMN: u8 = 0;
    pub const LIFT: u8 = 1;
    pub const CURRENT: u8 = 2;
    pub const GEYSER: u8 = 3;
}

/// One sky island: a lobed outline (lobes in world-relative offsets), a
/// gently rolling top and an inverted-mountain underside.
#[derive(Clone, Debug)]
pub struct Island {
    pub id: u64,
    pub arch: u16,
    pub x: f64,
    pub z: f64,
    /// Core radius.
    pub r: f64,
    /// Bounding radius of every lobe (influence = reach + 4 m).
    pub reach: f64,
    pub top: f64,
    /// Underside depth below the top at the core.
    pub thick: f64,
    /// Rim cliff height.
    pub cliff: f64,
    /// Top relief amplitude.
    pub amp: f64,
    /// (dx, dz, r) per lobe, the core first. At most 4.
    pub lobes: Vec<[f64; 3]>,
    pub kind: u8,
    pub seed: u32,
    /// Atlas site on this island (town, palace, ruin) or NONE16.
    pub site: u16,
    pub biome: u8,
}

#[derive(Clone, Debug)]
pub struct Arch {
    pub id: u64,
    pub x: f64,
    pub z: f64,
    pub r: f64,
    pub base: f64,
    pub cloud_y: f64,
    pub site: u16,
    pub first_island: u16,
    pub islands: u16,
    /// The surface settlement whose sky lift serves it (atlas index) or NONE16.
    pub town: u16,
}

/// A vertical wind column (the movement step's UpdraftField).
#[derive(Clone, Copy, Debug)]
pub struct Updraft {
    pub x: f64,
    pub z: f64,
    pub r: f64,
    pub bottom: f64,
    pub top: f64,
    pub lift: f64,
    pub kind: u8,
    pub arch: u16,
}

#[derive(Clone, Debug)]
pub struct Chamber {
    pub layer: u8,
    pub kind: u8,
    pub x: f64,
    pub z: f64,
    pub rx: f64,
    pub rz: f64,
    pub c: f64,
    pub s: f64,
    pub floor: f64,
    pub height: f64,
    /// Lake (or lava) surface, NO_WATER for none.
    pub lake: f64,
    /// Basin radius as a fraction of the ellipse (0 = no basin).
    pub lake_e: f64,
    pub lake_depth: f64,
    pub seed: u32,
    pub tint: u8,
    pub site: u16,
    pub reach: f64,
    pub id: u64,
}

#[derive(Clone, Debug)]
pub struct Corridor {
    pub layer: u8,
    pub kind: u8,
    /// (x, floor y, z) per point.
    pub pts: Vec<[f64; 3]>,
    pub hw: f64,
    pub height: f64,
    /// Channel depth of a river (0 = dry).
    pub water: f64,
    pub lava: bool,
    pub from: u16,
    pub to: u16,
}

#[derive(Clone, Copy, Debug)]
pub struct Opening {
    pub x: f64,
    pub z: f64,
    pub r: f64,
    /// Rim height (surface or floor of the layer above).
    pub y: f64,
    /// The layer the hole opens into.
    pub into: u8,
    pub kind: u8,
    pub yaw: u16,
    pub site: u16,
    pub target: u16,
}

#[derive(Clone, Copy, Debug)]
pub struct Shaft {
    pub x: f64,
    pub z: f64,
    pub r: f64,
    pub bottom: f64,
    pub top: f64,
    pub chamber: u16,
}

#[derive(Clone, Copy, Debug)]
pub struct Column {
    pub x: f64,
    pub z: f64,
    pub r: f64,
    pub y0: f64,
    pub y1: f64,
    pub layer: u8,
    pub chamber: u16,
}

/// Decoration kinds (README "Vertical world").
pub mod dk {
    pub const CRYSTAL: u8 = 0;
    pub const SPIRE: u8 = 1;
    pub const MUSHROOM: u8 = 2;
    pub const FLORA: u8 = 3;
    pub const STALACTITE: u8 = 4;
    pub const STALAGMITE: u8 = 5;
    pub const VINES: u8 = 6;
    pub const WATERFALL: u8 = 7;
    pub const LAVAFALL: u8 = 8;
    pub const VENT: u8 = 9;
    pub const OBSIDIAN: u8 = 10;
    pub const EMBERS: u8 = 11;
    pub const CAMPFIRE: u8 = 12;
    pub const TENT: u8 = 13;
    pub const PORTAL: u8 = 14;
    pub const LIFT: u8 = 15;
    pub const PALACE: u8 = 16;
    pub const ACTIVITY: u8 = 17;
    pub const TREE: u8 = 18;
    pub const ROCK: u8 = 19;
    pub const PILLAR: u8 = 20;
    pub const SKYFALL: u8 = 21;
    pub const CLOUD: u8 = 22;
    pub const GEYSER: u8 = 23;
    pub const SHRINE: u8 = 24;
    pub const GATE: u8 = 25;
    pub const LIGHTSHAFT: u8 = 26;
    pub const LANTERN: u8 = 27;
    // genVersion 4 (CR 043): cave dressing and dwarven architecture, appended.
    pub const MINECART: u8 = 28;
    pub const RAILS: u8 = 29;
    pub const SUPPORT: u8 = 30;
    pub const BONES: u8 = 31;
    pub const GLOWWORMS: u8 = 32;
    pub const CHEST: u8 = 33;
    pub const TABLET: u8 = 34;
    pub const BRAZIER: u8 = 35;
    pub const DWARF_DOOR: u8 = 36;
    pub const DWARF_PILLAR: u8 = 37;
    pub const ORE_PILE: u8 = 38;
    pub const RUNES: u8 = 39;
    pub const STATUE: u8 = 40;
    pub const BANNER: u8 = 41;
    pub const SECRET_DOOR: u8 = 42;
    pub const THRONE: u8 = 43;
    pub const FORGEGLOW: u8 = 44;
    pub const COLLAPSE: u8 = 45;
    pub const COUNT: u8 = 46;
}

/// Decoration flags.
pub mod df {
    /// Casts real light (the client's light pool).
    pub const LIGHT: u8 = 1;
    /// Hangs from the ceiling.
    pub const HANG: u8 = 2;
    /// genVersion 4: the player can interact with it (Interact 160+, the descriptor index is the target).
    pub const INTERACT: u8 = 4;
}

#[derive(Clone, Copy, Debug)]
pub struct Deco {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    /// Size in meters (height, length, radius: per kind).
    pub size: f64,
    pub kind: u8,
    /// Element / palette tint (0 fire, 1 ice, ... 7 void; 8 turquoise, 9 white).
    pub tint: u8,
    pub layer: u8,
    pub flags: u8,
    pub yaw: u16,
    /// Kind-specific: a site index, an island, a chamber, a fall length in dm.
    pub aux: u16,
}

/// A new atlas site from the vertical plan (appended after the base sites).
#[derive(Clone, Debug)]
pub struct NewSite {
    pub category: u8,
    pub kind: u8,
    pub size: u8,
    pub layer: u8,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub radius: f64,
    pub yaw: u16,
    /// Index into `Plan::sites` of the linked site, or NONE16.
    pub link_local: u16,
    pub name: String,
    pub biome: u8,
    pub element: u8,
    pub region: u8,
}

/// The whole vertical world of an atlas.
#[derive(Default)]
pub struct Plan {
    pub seed: u64,
    /// Number of base sites (the vertical sites' atlas indices start here).
    pub base_sites: usize,
    pub archs: Vec<Arch>,
    pub islands: Vec<Island>,
    pub updrafts: Vec<Updraft>,
    pub chambers: Vec<Chamber>,
    pub corridors: Vec<Corridor>,
    pub openings: Vec<Opening>,
    pub shafts: Vec<Shaft>,
    pub columns: Vec<Column>,
    pub decos: Vec<Deco>,
    pub veins: Vec<crate::cave::veins::Vein>,
    pub sites: Vec<NewSite>,
    /// Per layer (sky, under, depths): per 64 m chunk the feature refs whose
    /// influence overlaps it. Sky refs are island indices; under/depths refs
    /// are `CHAMBER_REF | i` or corridor indices.
    pub grid: [Vec<Vec<u32>>; 3],
}

/// Feature ref flag: a chamber (else a corridor).
pub const CHAMBER_REF: u32 = 1 << 31;

impl Plan {
    /// Feature refs of layer (1..3) at chunk (cx, cz); empty outside the world.
    #[inline]
    pub fn refs(&self, layer: u8, cx: i64, cz: i64) -> &[u32] {
        if !(1..=3).contains(&layer) || cx < 0 || cz < 0 || cx >= CHUNKS as i64 || cz >= CHUNKS as i64 {
            return &[];
        }
        &self.grid[(layer - 1) as usize][cz as usize * CHUNKS + cx as usize]
    }

    /// Is chunk (cx, cz) in the layer's domain (some feature influences it)?
    pub fn domain(&self, layer: u8, cx: i64, cz: i64) -> bool {
        !self.refs(layer, cx, cz).is_empty()
    }

    fn index(&mut self) {
        for g in self.grid.iter_mut() {
            *g = vec![Vec::new(); CHUNKS * CHUNKS];
        }
        let add = |grid: &mut Vec<Vec<u32>>, x0: f64, z0: f64, x1: f64, z1: f64, r: u32| {
            let c0 = (libm::floor(x0 / 64.0) as i64).clamp(0, CHUNKS as i64 - 1);
            let c1 = (libm::floor(x1 / 64.0) as i64).clamp(0, CHUNKS as i64 - 1);
            let d0 = (libm::floor(z0 / 64.0) as i64).clamp(0, CHUNKS as i64 - 1);
            let d1 = (libm::floor(z1 / 64.0) as i64).clamp(0, CHUNKS as i64 - 1);
            for cz in d0..=d1 {
                for cx in c0..=c1 {
                    grid[cz as usize * CHUNKS + cx as usize].push(r);
                }
            }
        };
        for (i, isl) in self.islands.iter().enumerate() {
            let m = isl.reach + 6.0;
            add(&mut self.grid[0], isl.x - m, isl.z - m, isl.x + m, isl.z + m, i as u32);
        }
        for (i, c) in self.chambers.iter().enumerate() {
            let m = c.reach + 2.0;
            let g = &mut self.grid[(c.layer - 1) as usize];
            add(g, c.x - m, c.z - m, c.x + m, c.z + m, CHAMBER_REF | i as u32);
        }
        for (i, r) in self.corridors.iter().enumerate() {
            let m = field::corridor_reach(r) + 2.0;
            let (mut x0, mut z0, mut x1, mut z1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
            for p in &r.pts {
                x0 = x0.min(p[0]);
                z0 = z0.min(p[2]);
                x1 = x1.max(p[0]);
                z1 = z1.max(p[2]);
            }
            let g = &mut self.grid[(r.layer - 1) as usize];
            add(g, x0 - m, z0 - m, x1 + m, z1 + m, i as u32);
        }
    }
}

/// Site layer byte (37) of a site record: 0 surface, 1 sky, 2 underground, 3 depths.
#[inline]
pub fn site_layer(a: &Atlas, i: usize) -> u8 {
    a.section(sec::SITES)[8 + i * crate::atlas::format::SITE_REC + 37]
}

/// A base site: on the surface and of a kind that existed before genVersion 3.
/// Everything that predates the vertical world (chunk anchors, node params,
/// roads, the cave graph, story and content picks) reads only these.
pub fn is_base(a: &Atlas, s: &SiteRec) -> bool {
    if site_layer(a, s.index) != LAYER_SURFACE {
        return false;
    }
    match s.category {
        S::CAT_POI => s.kind <= S::POI_ENEMY_CAMP,
        S::CAT_STRUCTURE => s.kind <= S::ST_DEMON_LAIR,
        _ => true,
    }
}

/// Count of base sites (the vertical sites are appended after them).
pub fn base_site_count(a: &Atlas) -> usize {
    let n = a.site_count();
    let mut k = n;
    while k > 0 && !is_base(a, &a.site(k - 1)) {
        k -= 1;
    }
    k
}

/// The sites part of the plan only (the atlas pass appends them).
pub fn plan_sites(a: &Atlas) -> Result<Plan, String> {
    let caves = crate::cave::graph::build_world(a)?;
    let mut p = Plan {
        seed: a.seed,
        base_sites: base_site_count(a),
        ..Default::default()
    };
    sky::plan(a, &mut p);
    under::plan(a, &caves, &mut p);
    Ok(p)
}

/// Build the plan of an atlas (base content only: works on the atlas before
/// and after the vertical sites are appended, with identical results).
pub fn build(a: &Atlas) -> Result<Plan, String> {
    let caves = crate::cave::world(a)?;
    let mut p = Plan {
        seed: a.seed,
        base_sites: base_site_count(a),
        ..Default::default()
    };
    sky::plan(a, &mut p);
    under::plan(a, &caves.world, &mut p);
    p.index();
    decor::place(a, &mut p);
    Ok(p)
}

pub struct Cached {
    pub plan: Plan,
    pub desc: Vec<u8>,
}

thread_local! {
    static CACHE: RefCell<Option<(u64, Rc<Cached>)>> = const { RefCell::new(None) };
}

fn key(a: &Atlas) -> u64 {
    let mut h = crate::hash_bytes(a.section(sec::SPEC));
    h ^= a.seed.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    h ^ (a.gen_version as u64) << 48 ^ 0x5654
}

/// The vertical world of the atlas `a` (built once per thread per world).
pub fn world(a: &Atlas) -> Result<Rc<Cached>, String> {
    let k = key(a);
    if let Some(c) = CACHE.with(|c| c.borrow().as_ref().filter(|(ck, _)| *ck == k).map(|(_, v)| v.clone())) {
        return Ok(c);
    }
    let plan = build(a)?;
    let desc = desc::serialize(a, &plan);
    let c = Rc::new(Cached { plan, desc });
    CACHE.with(|cell| *cell.borrow_mut() = Some((k, c.clone())));
    Ok(c)
}
