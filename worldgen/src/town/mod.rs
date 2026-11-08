//! Towns, roads and structures (WP20, spec 5 "the modded Minecraft layer").
//!
//! A pure function of the atlas, like the caves: `towns_build(atlas)` returns
//! one "towns" buffer (`LDTW`, layout in worldgen/README.md "Towns") with
//! every settlement layout, building, collision box, prop, NPC, road, bridge,
//! signpost and jigsaw structure of the world. It is new output next to the
//! atlas and the chunks (no existing buffer changes), so genVersion stays 1
//! and every golden hash of WP01/WP09 still holds (docs/cr/007-towns.md).
//!
//! | Module | What |
//! | --- | --- |
//! | `geom` | Oriented boxes, the terrain sampler (exact f32 lattice + water) |
//! | `roads` | Least-cost roads between settlements on the macro grid, bridges, signposts |
//! | `layout` | Settlement layouts: square, streets, plots, required buildings, walls |
//! | `kit` | Per-biome building styles and the shape grammar: footprint, floors, roof, collision boxes, interiors |
//! | `jigsaw` | The structure library: typed-connector pieces assembled to a size budget |
//! | `npc` | Townsfolk: roles, homes, work spots, names |
//! | `buf` | Serialization of the towns buffer |
//! | `abi` | wasm export `towns_build` |
//!
//! Collision is a list of oriented boxes (`Box3`), each with a top that may
//! slope along its local u axis (ramps, roof halves). Hosts query them with
//! the same f64 code in TS and Go (worldgen/js/src/town.ts,
//! server/pkg/towns): a box is a floor where its top is within a step of the
//! feet, a wall otherwise. All trig happens here, in wasm with libm; boxes
//! carry their cos/sin as f32 so hosts never call host math.

pub mod abi;
pub mod buf;
pub mod geom;
pub mod jigsaw;
pub mod kit;
pub mod layout;
pub mod npc;
pub mod roads;

use crate::atlas::format::{sec, Atlas};
use std::cell::RefCell;
use std::rc::Rc;

/// Stable-id layers (rng::stable_id) owned by the towns layer. Layers 1..7
/// are chunk records and cave veins, 0x40.. are sites; 0x20..0x27 are free.
pub mod layer {
    pub const BUILDING: u8 = 0x20;
    pub const PROP: u8 = 0x21;
    pub const NPC: u8 = 0x22;
    pub const PIECE: u8 = 0x23;
    pub const BRIDGE: u8 = 0x24;
    pub const SIGN: u8 = 0x25;
}

/// Seed streams for the towns pass (rng::hash stream argument).
pub mod stream {
    pub const ROADS: u64 = 0x7701;
    pub const LAYOUT: u64 = 0x7702;
    pub const KIT: u64 = 0x7703;
    pub const NPC: u64 = 0x7704;
    pub const JIGSAW: u64 = 0x7705;
    pub const NAMES: u64 = 0x7706;
}

/// Box kinds (byte 36 of a box record). The owner table depends on the kind.
pub mod bk {
    pub const FLOOR: u8 = 0;
    pub const WALL: u8 = 1;
    pub const UPPER: u8 = 2;
    pub const ROOF: u8 = 3;
    pub const RAMP: u8 = 4;
    pub const FURNITURE: u8 = 5;
    pub const FENCE: u8 = 6;
    pub const TOWN_WALL: u8 = 7;
    pub const GATE: u8 = 8;
    pub const DECK: u8 = 9;
    pub const BRIDGE_RAMP: u8 = 10;
    pub const PIECE: u8 = 11;
    pub const TOWN_PROP: u8 = 12;
    pub const RAILING: u8 = 13;
}

/// Box flags (byte 37).
pub mod bf {
    pub const WALK: u8 = 1;
    pub const SOLID: u8 = 2;
    pub const CEIL: u8 = 4;
}

/// One collision box: an oriented box in xz, solid from `y0` up to a top
/// that runs linearly from `y1` at local u = -hx to `y2` at u = +hx.
#[derive(Clone, Copy, Debug)]
pub struct Box3 {
    pub cx: f32,
    pub cz: f32,
    pub c: f32,
    pub s: f32,
    pub hx: f32,
    pub hz: f32,
    pub y0: f32,
    pub y1: f32,
    pub y2: f32,
    pub kind: u8,
    pub flags: u8,
    pub owner: u16,
}

/// A prop: furniture, town dressing, interaction points, structure loot.
#[derive(Clone, Copy, Debug)]
pub struct Prop {
    pub id: u64,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub yaw: u16,
    pub kind: u8,
    pub variant: u8,
    pub building: u16,
    pub settlement: u16,
    pub flags: u8,
    pub scale: u8,
    pub structure: u16,
}

/// Prop kinds (byte 22 of a prop record; table in worldgen/README.md).
pub mod pk {
    pub const DOOR: u8 = 0;
    pub const BED: u8 = 1;
    pub const TABLE: u8 = 2;
    pub const BENCH: u8 = 3;
    pub const HEARTH: u8 = 4;
    pub const CHEST: u8 = 5;
    pub const BARREL: u8 = 6;
    pub const CRATE: u8 = 7;
    pub const SHELF: u8 = 8;
    pub const COUNTER: u8 = 9;
    pub const FORGE: u8 = 10;
    pub const ANVIL: u8 = 11;
    pub const QUENCH: u8 = 12;
    pub const WORKBENCH: u8 = 13;
    pub const STALL: u8 = 14;
    pub const BOARD: u8 = 15;
    pub const WELL: u8 = 16;
    pub const LANTERN: u8 = 17;
    pub const WARD_BED: u8 = 18;
    pub const CROPS: u8 = 19;
    pub const RUG: u8 = 20;
    pub const BOOKSHELF: u8 = 21;
    pub const CAMPFIRE: u8 = 22;
    pub const TENT: u8 = 23;
    pub const STARMETAL: u8 = 24;
    pub const STATUE: u8 = 25;
    pub const CRYSTAL: u8 = 26;
    pub const BRAZIER: u8 = 27;
    pub const BONES: u8 = 28;
    pub const RUBBLE: u8 = 29;
    pub const TORCH: u8 = 30;
    pub const COUNT: u8 = 31;
}

/// Prop flags (byte 28).
pub mod pf {
    pub const INTERACT: u8 = 1;
    pub const LIGHT: u8 = 2;
}

/// Building roles (byte 10 of a building record).
pub mod role {
    pub const HOUSE: u8 = 0;
    pub const INN: u8 = 1;
    pub const FORGE: u8 = 2;
    pub const STALL: u8 = 3;
    pub const GARDEN: u8 = 4;
    pub const FARM: u8 = 5;
    pub const WORKSHOP: u8 = 6;
    pub const STOREHOUSE: u8 = 7;
    pub const GATEHOUSE: u8 = 8;
    pub const NAMES: [&str; 9] = ["house", "inn", "forge", "stall", "garden", "farm", "workshop", "storehouse", "gatehouse"];
}

#[derive(Clone, Debug)]
pub struct Building {
    pub id: u64,
    pub settlement: u16,
    pub role: u8,
    pub style: u8,
    pub x: f64,
    pub z: f64,
    pub floor_y: f64,
    pub base_y: f64,
    pub hx: f64,
    pub hz: f64,
    pub c: f64,
    pub s: f64,
    pub storey: f64,
    pub roof_h: f64,
    pub floors: u8,
    pub roof: u8,
    pub ridge_u: bool,
    pub door_u: f64,
    pub door_w: f64,
    pub flags: u8,
    pub variant: u8,
    pub box_first: u32,
    pub box_count: u16,
    pub prop_first: u32,
    pub prop_count: u16,
    pub front_x: f64,
    pub front_z: f64,
    pub street: u16,
    pub along: f64,
}

/// Building flags (byte 64).
pub mod bflag {
    pub const PORCH: u8 = 1;
    pub const CHIMNEY: u8 = 2;
    pub const STILTS: u8 = 4;
    pub const OPEN_FRONT: u8 = 8;
    pub const FIELD: u8 = 16;
    pub const JETTY: u8 = 32;
}

/// Roof kinds (byte 53).
pub mod roof {
    pub const GABLE: u8 = 0;
    pub const HIP: u8 = 1;
    pub const FLAT: u8 = 2;
    pub const NONE: u8 = 3;
}

#[derive(Clone, Debug)]
pub struct Settlement {
    pub id: u64,
    pub site: u16,
    pub size: u8,
    pub style: u8,
    pub walled: bool,
    /// Town wall radius (m, 0 = no wall).
    pub wall_r: f64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub radius: f64,
    pub square: f64,
    pub building_first: u16,
    pub building_count: u16,
    pub npc_first: u16,
    pub npc_count: u16,
    pub prop_first: u32,
    pub prop_count: u32,
    pub box_first: u32,
    pub box_count: u32,
    pub road_first: u16,
    pub road_count: u16,
    pub region: u8,
}

#[derive(Clone, Debug)]
pub struct Npc {
    pub id: u64,
    pub settlement: u16,
    pub role: u8,
    pub variant: u8,
    pub name: u16,
    pub home: u16,
    pub work: u16,
    pub work_prop: u16,
    pub work_x: f64,
    pub work_z: f64,
    pub home_x: f64,
    pub home_z: f64,
    pub work_yaw: u16,
    pub merchant: u8,
}

/// NPC roles (byte 10 of an NPC record).
pub mod nrole {
    pub const VILLAGER: u8 = 0;
    pub const MERCHANT: u8 = 1;
    pub const BLACKSMITH: u8 = 2;
    pub const INNKEEPER: u8 = 3;
    pub const BOUNTY: u8 = 4;
    pub const FARMER: u8 = 5;
    pub const GUARD: u8 = 6;
}

#[derive(Clone, Debug)]
pub struct Road {
    pub points: Vec<[f64; 3]>,
    pub from: u16,
    pub to: u16,
    pub width: f64,
    pub class: u8,
    pub surface: u8,
    pub settlement: u16,
    pub length: f64,
}

#[derive(Clone, Debug)]
pub struct Bridge {
    pub id: u64,
    pub ax: f64,
    pub az: f64,
    pub bx: f64,
    pub bz: f64,
    pub deck_y: f64,
    pub width: f64,
    pub water_y: f64,
    pub road: u16,
    pub style: u8,
    pub box_first: u32,
    pub box_count: u16,
}

#[derive(Clone, Debug)]
pub struct Sign {
    pub id: u64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub arms: [(u16, u16); 3],
}

#[derive(Clone, Debug)]
pub struct Structure {
    pub id: u64,
    pub site: u16,
    pub kind: u8,
    pub tier: u8,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub radius: f64,
    pub piece_first: u32,
    pub piece_count: u16,
    pub prop_first: u32,
    pub prop_count: u16,
    pub box_first: u32,
    pub box_count: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct Piece {
    pub id: u64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub c: f64,
    pub s: f64,
    pub sx: f64,
    pub sy: f64,
    pub kind: u8,
    pub variant: u8,
    pub structure: u16,
}

/// Everything the towns pass produces for one world.
#[derive(Default)]
pub struct Towns {
    pub settlements: Vec<Settlement>,
    pub buildings: Vec<Building>,
    pub boxes: Vec<Box3>,
    pub props: Vec<Prop>,
    pub npcs: Vec<Npc>,
    pub roads: Vec<Road>,
    pub bridges: Vec<Bridge>,
    pub signs: Vec<Sign>,
    pub structures: Vec<Structure>,
    pub pieces: Vec<Piece>,
    pub veins: Vec<crate::cave::veins::Vein>,
    pub names: Vec<String>,
}

/// Build the whole towns layer of a world (pure function of the atlas).
pub fn build(a: &Atlas) -> Result<Towns, String> {
    let mut t = Towns::default();
    let net = roads::plan(a);
    layout::build_settlements(a, &net, &mut t);
    roads::finish(a, net, &mut t);
    jigsaw::build_structures(a, &mut t);
    Ok(t)
}

/// One world's towns, built on first use and kept per thread (one wasm
/// instance = one thread), keyed like the caves by what defines the atlas.
pub struct Cached {
    pub bytes: Vec<u8>,
}

thread_local! {
    static CACHE: RefCell<Option<(u64, Rc<Cached>)>> = const { RefCell::new(None) };
}

fn key(a: &Atlas) -> u64 {
    let mut h = crate::hash_bytes(a.section(sec::SPEC));
    h ^= a.seed.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    h ^ (a.gen_version as u64) << 48
}

/// The serialized towns buffer of the world `a` describes.
pub fn world(a: &Atlas) -> Result<Rc<Cached>, String> {
    let k = key(a);
    if let Some(c) = CACHE.with(|c| c.borrow().as_ref().filter(|(ck, _)| *ck == k).map(|(_, v)| v.clone())) {
        return Ok(c);
    }
    let t = build(a)?;
    let c = Rc::new(Cached { bytes: buf::serialize(a, &t) });
    CACHE.with(|cell| *cell.borrow_mut() = Some((k, c.clone())));
    Ok(c)
}
