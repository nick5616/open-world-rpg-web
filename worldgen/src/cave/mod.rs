//! Caves, gems and ore veins (WP09, spec 7). The overworld is a heightfield;
//! the underground is a density volume grown from a graph per cave mouth.
//!
//! | Module | What |
//! | --- | --- |
//! | `graph` | Cave systems: chambers, tunnels, openings, grown from mouth sites |
//! | `field` | Density primitives (flat-floored ellipsoids and capsules), smooth union |
//! | `noise3` | 3D gradient noise for walls |
//! | `veins` | Ore veins, gems and glowing decorations, and what they hold |
//! | `cell` | `cave_build`: sample a 64 x 32 x 64 m cell, surface nets, collision columns |
//! | `mask` | Mouth masks for overworld heightfield triangles |
//! | `graphbuf` | Serialized graph and the cave-system id query |
//! | `abi` | wasm exports |
//!
//! All of it is new output next to WP01's (no existing buffer changed), so
//! every golden chunk hash of genVersion 1 still holds; the cave hashes join
//! the golden table (docs/cr/003-cave-exports.md).

pub mod abi;
pub mod cell;
pub mod field;
pub mod graph;
pub mod graphbuf;
pub mod mask;
pub mod noise3;
pub mod veins;

use crate::atlas::format::{sec, Atlas};
use std::cell::RefCell;
use std::rc::Rc;

/// One world's caves, built on first use and kept per thread (one wasm
/// instance = one thread). Keyed by what defines the atlas (seed + canonical
/// spec + genVersion), never by pointer, so a freed and reused atlas address
/// can't serve another world's caves. Caching changes nothing about output:
/// the world is a pure function of the atlas.
pub struct Cached {
    pub world: CaveWorldRc,
    pub graph: Vec<u8>,
}

pub type CaveWorldRc = Rc<graph::CaveWorld>;

thread_local! {
    static CACHE: RefCell<Option<(u64, Rc<Cached>)>> = const { RefCell::new(None) };
}

fn key(a: &Atlas) -> u64 {
    let mut h = crate::hash_bytes(a.section(sec::SPEC));
    h ^= a.seed.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    h ^ (a.gen_version as u64) << 48
}

/// The caves of the world `a` describes (built once per thread per world).
pub fn world(a: &Atlas) -> Result<Rc<Cached>, String> {
    let k = key(a);
    if let Some(c) = CACHE.with(|c| c.borrow().as_ref().filter(|(ck, _)| *ck == k).map(|(_, v)| v.clone())) {
        return Ok(c);
    }
    let w = graph::build_world(a)?;
    let graph = graphbuf::serialize(&w);
    let c = Rc::new(Cached { world: Rc::new(w), graph });
    CACHE.with(|cell| *cell.borrow_mut() = Some((k, c.clone())));
    Ok(c)
}
