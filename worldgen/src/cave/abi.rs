//! Cave exports (WP09; layouts in worldgen/README.md "Caves"). Same rules as
//! `crate::abi`: results in the module scratch buffer (copy them out before
//! the next result-returning call), 0 on error with the message in
//! `error_ptr/error_len`, memory may grow on any call.
//!
//! The first cave call for a world builds every cave system of it (tens of
//! ms, once per instance); later calls reuse that (see `cave::world`).

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

/// The world's cave graph buffer (systems, chambers, tunnels, openings,
/// veins). Result in scratch; 0 on error.
///
/// # Safety
/// `atlas_ptr` must point at a valid atlas buffer.
#[no_mangle]
pub unsafe extern "C" fn cave_graph(atlas_ptr: *const u8) -> *const u8 {
    result(with_world(atlas_ptr, |_, c| Ok(c.graph.clone())))
}

/// One cave volume cell (spec 5 `cave_build`): density, surface-nets mesh,
/// collision columns, veins and decorations. Result in scratch; 0 on error.
///
/// # Safety
/// `atlas_ptr` must point at a valid atlas buffer.
#[no_mangle]
pub unsafe extern "C" fn cave_build(atlas_ptr: *const u8, cx: i32, cy: i32, cz: i32) -> *const u8 {
    result(with_world(atlas_ptr, |a, c| super::cell::build(a, &c.world, cx, cy, cz, &[])))
}

/// `cave_build` with world edits applied: `edits_len` bytes of 32-byte
/// records (u64 vein id, f32 x, y, z, radius, 8 reserved bytes). Carve
/// spheres open the density; listed veins come back flagged mined.
///
/// # Safety
/// `atlas_ptr` must be a valid atlas; `edits_ptr..+edits_len` readable.
#[no_mangle]
pub unsafe extern "C" fn cave_build_edited(atlas_ptr: *const u8, cx: i32, cy: i32, cz: i32, edits_ptr: *const u8, edits_len: usize) -> *const u8 {
    let edits = if edits_len == 0 || edits_ptr.is_null() {
        Vec::new()
    } else {
        super::cell::parse_edits(core::slice::from_raw_parts(edits_ptr, edits_len))
    };
    result(with_world(atlas_ptr, |a, c| super::cell::build(a, &c.world, cx, cy, cz, &edits)))
}

/// Mouth mask of overworld chunk (cx, cz): 24-byte header + 64 x 64 x 2
/// triangle bits. Result in scratch; 0 on error.
///
/// # Safety
/// `atlas_ptr` must point at a valid atlas buffer.
#[no_mangle]
pub unsafe extern "C" fn cave_mask(atlas_ptr: *const u8, cx: i32, cz: i32) -> *const u8 {
    result(with_world(atlas_ptr, |_, c| Ok(super::mask::build(&c.world, cx, cz))))
}

/// Cave-system index containing (x, y, z), or -1 (none), or -2 on error.
///
/// # Safety
/// `atlas_ptr` must point at a valid atlas buffer.
#[no_mangle]
pub unsafe extern "C" fn cave_system_at(atlas_ptr: *const u8, x: f64, y: f64, z: f64) -> i32 {
    if !(x.is_finite() && y.is_finite() && z.is_finite()) {
        set_error("non-finite coordinate");
        return -2;
    }
    match with_world(atlas_ptr, |_, c| Ok(super::graphbuf::GraphView { b: &c.graph }.system_at(x, y, z))) {
        Ok(v) => v,
        Err(e) => {
            set_error(&e);
            -2
        }
    }
}
