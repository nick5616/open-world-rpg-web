//! Vertical world exports (genVersion 3; layouts in worldgen/README.md
//! "Vertical world"). Same rules as `crate::abi`: results in the scratch
//! buffer, 0 on error with the message in `error_ptr/error_len`.
//!
//! The first call for a world builds its plan (every island, chamber,
//! corridor, decoration; tens of ms, once per instance), cached like the caves.

use crate::abi::{atlas_slice, scratch_result, set_error, set_len};
use crate::atlas::format::Atlas;

unsafe fn with_world<T>(atlas_ptr: *const u8, f: impl FnOnce(&Atlas, &super::Cached) -> Result<T, String>) -> Result<T, String> {
    let b = atlas_slice(atlas_ptr)?;
    let a = Atlas::parse(b)?;
    let c = super::world(&a)?;
    f(&a, &c)
}

fn result(r: Result<Vec<u8>, String>) -> *const u8 {
    match r {
        Ok(bytes) => scratch_result(bytes),
        Err(e) => {
            set_error(&e);
            set_len(0);
            core::ptr::null()
        }
    }
}

/// The world's vertical descriptor (`LDVT`): islands, archipelagos,
/// updrafts, chambers, corridors, openings, shafts, columns, decorations,
/// veins and the per-layer domain bitmaps. Result in scratch; 0 on error.
///
/// # Safety
/// `atlas_ptr` must point at a valid atlas buffer.
#[no_mangle]
pub unsafe extern "C" fn vertical_build(atlas_ptr: *const u8) -> *const u8 {
    result(with_world(atlas_ptr, |_, c| Ok(c.desc.clone())))
}

/// One layer tile (`LDLT`): layer 1 sky, 2 Underground, 3 Depths; cx, cz
/// 0..63 multiples of 2^lod; lod 0..6. Result in scratch; 0 on error.
///
/// # Safety
/// `atlas_ptr` must point at a valid atlas buffer.
#[no_mangle]
pub unsafe extern "C" fn layer_tile(atlas_ptr: *const u8, layer: i32, cx: i32, cz: i32, lod: i32) -> *const u8 {
    result(with_world(atlas_ptr, |a, c| super::tile::build(a, &c.plan, layer.clamp(0, 255) as u8, cx, cz, lod.max(0) as u32)))
}

/// Collision value of surface `surf` at (x, z): 0 Underground floor,
/// 1 ceiling, 2 water; 3 Depths floor, 4 ceiling, 5 lava; 6 sky island top,
/// 7 bottom, 8 (unused) water. -1e9 on an invalid atlas, surface or input.
///
/// # Safety
/// `atlas_ptr` must point at a valid atlas buffer.
#[no_mangle]
pub unsafe extern "C" fn layer_height(atlas_ptr: *const u8, surf: i32, x: f64, z: f64) -> f64 {
    if !(0..9).contains(&surf) || !x.is_finite() || !z.is_finite() {
        return -1e9;
    }
    match with_world(atlas_ptr, |a, c| Ok(super::tile::height(a, &c.plan, surf as u32, x, z))) {
        Ok(v) => v,
        Err(e) => {
            set_error(&e);
            -1e9
        }
    }
}
