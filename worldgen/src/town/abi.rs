//! Towns export (WP20; layout in worldgen/README.md "Towns"). Same rules as
//! `crate::abi`: the result lives in the module scratch buffer (copy it out
//! before the next result-returning call), 0 on error with the message in
//! `error_ptr/error_len`. The first call per world builds the towns layer
//! (cached per instance by seed + spec + genVersion).

use crate::abi::{atlas_slice, scratch_result, set_error, set_len};
use crate::atlas::format::Atlas;

/// The world's towns buffer (settlements, buildings, collision boxes,
/// props, NPCs, roads, bridges, signposts, structures, pieces, starmetal
/// veins, names). Result in scratch; 0 on error.
///
/// # Safety
/// `atlas_ptr` must point at a valid atlas buffer.
#[no_mangle]
pub unsafe extern "C" fn towns_build(atlas_ptr: *const u8) -> *const u8 {
    let r = (|| -> Result<Vec<u8>, String> {
        let b = atlas_slice(atlas_ptr)?;
        let a = Atlas::parse(b)?;
        Ok(super::world(&a)?.bytes.clone())
    })();
    match r {
        Ok(bytes) => scratch_result(bytes),
        Err(e) => {
            set_error(&e);
            set_len(0);
            core::ptr::null()
        }
    }
}
