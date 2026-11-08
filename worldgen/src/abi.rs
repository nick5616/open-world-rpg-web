//! The wasm ABI (spec 5 "Exported wasm API"), documented in worldgen/README.md.
//!
//! Conventions:
//! - Pointers and lengths are i32 (wasm32 linear-memory offsets).
//! - Buffers the host must keep (atlases) live in `alloc`ed memory and are
//!   released with `free(ptr, len)`.
//! - Short-lived results (spec JSON, chunk buffers) live in one module-owned
//!   scratch buffer, valid until the next export call that returns a result.
//!   The host copies what it needs out of linear memory first.
//! - A result pointer of 0 means failure; `error_ptr/error_len` hold UTF-8.
//! - Memory may grow on any call, so hosts must re-acquire views of
//!   `memory.buffer` after every call.
//!
//! The module imports nothing (no WASI, no host math), so wazero and browsers
//! instantiate it with an empty import object.

use crate::atlas::format::{get_u32, Atlas, HEADER_LEN};
use std::alloc::{alloc as raw_alloc, dealloc, Layout};
use std::cell::RefCell;

thread_local! {
    static SCRATCH: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static ERROR: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static LAST_LEN: RefCell<u32> = const { RefCell::new(0) };
}

fn set_error(msg: &str) {
    ERROR.with(|e| {
        let mut e = e.borrow_mut();
        e.clear();
        e.extend_from_slice(msg.as_bytes());
    });
}

fn set_len(n: usize) {
    LAST_LEN.with(|l| *l.borrow_mut() = n as u32);
}

fn scratch_result(data: Vec<u8>) -> *const u8 {
    set_len(data.len());
    SCRATCH.with(|s| {
        let mut s = s.borrow_mut();
        *s = data;
        s.as_ptr()
    })
}

fn layout(len: usize) -> Option<Layout> {
    // 8-byte alignment so hosts can lay Float32Array / BigUint64Array views
    // over any section without copying.
    Layout::from_size_align(len.max(1), 8).ok()
}

/// Allocate `len` bytes (8-aligned) for the host. Returns 0 on failure.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    match layout(len) {
        // SAFETY: layout has non-zero size.
        Some(l) => unsafe { raw_alloc(l) },
        None => core::ptr::null_mut(),
    }
}

/// Release memory from `alloc` or `atlas_build`.
///
/// # Safety
/// `ptr` must come from `alloc(len)` / `atlas_build` with the same `len`.
#[no_mangle]
pub unsafe extern "C" fn free(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    if let Some(l) = layout(len) {
        dealloc(ptr, l);
    }
}

/// Generator major version: output-defining (spec 5, generator maintenance).
#[no_mangle]
pub extern "C" fn gen_version() -> u32 {
    crate::GEN_VERSION as u32
}

/// Version of this ABI (export signatures and buffer layouts).
#[no_mangle]
pub extern "C" fn abi_version() -> u32 {
    crate::ABI_VERSION
}

/// Length of the last result returned by `spec_from_seed`, `atlas_build` or `chunk_build`.
#[no_mangle]
pub extern "C" fn result_len() -> u32 {
    LAST_LEN.with(|l| *l.borrow())
}

#[no_mangle]
pub extern "C" fn error_ptr() -> *const u8 {
    ERROR.with(|e| e.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn error_len() -> u32 {
    ERROR.with(|e| e.borrow().len() as u32)
}

/// WorldSpec JSON (UTF-8) for a seed, in scratch. Not on the hot path.
#[no_mangle]
pub extern "C" fn spec_from_seed(seed_lo: u32, seed_hi: u32) -> *const u8 {
    let seed = (seed_hi as u64) << 32 | seed_lo as u64;
    scratch_result(crate::spec::to_json(&crate::spec::spec_from_seed(seed)))
}

/// Build the atlas from WorldSpec JSON. Returns an `alloc`ed buffer (free it
/// with `free(ptr, result_len())`); its length is also at header offset 8.
///
/// # Safety
/// `spec_ptr..spec_ptr+spec_len` must be readable linear memory.
#[no_mangle]
pub unsafe extern "C" fn atlas_build(spec_ptr: *const u8, spec_len: usize, seed_lo: u32, seed_hi: u32) -> *mut u8 {
    let json = core::slice::from_raw_parts(spec_ptr, spec_len);
    let seed = (seed_hi as u64) << 32 | seed_lo as u64;
    let result = crate::spec::parse(json).and_then(|s| crate::atlas::build(&s, seed));
    match result {
        Ok(bytes) => {
            let p = alloc(bytes.len());
            if p.is_null() {
                set_error("out of memory");
                return core::ptr::null_mut();
            }
            core::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
            set_len(bytes.len());
            p
        }
        Err(e) => {
            set_error(&e);
            set_len(0);
            core::ptr::null_mut()
        }
    }
}

/// View the atlas at `ptr`, trusting the length in its header.
unsafe fn atlas_slice<'a>(ptr: *const u8) -> Result<&'a [u8], String> {
    if ptr.is_null() {
        return Err("null atlas pointer".into());
    }
    let head = core::slice::from_raw_parts(ptr, HEADER_LEN);
    if head[0..4] != crate::atlas::format::MAGIC {
        return Err("not an atlas (bad magic)".into());
    }
    let len = get_u32(head, 8) as usize;
    Ok(core::slice::from_raw_parts(ptr, len))
}

/// Check an atlas the host loaded from a cache. Returns 1 if valid, else 0
/// with the reason in `error_ptr`.
///
/// # Safety
/// `ptr` must point at a buffer at least as long as its header claims.
#[no_mangle]
pub unsafe extern "C" fn atlas_check(ptr: *const u8) -> u32 {
    match atlas_slice(ptr).and_then(|b| Atlas::parse(b).map(|_| ())) {
        Ok(()) => 1,
        Err(e) => {
            set_error(&e);
            0
        }
    }
}

/// Build one chunk (layout in README). Result in scratch; 0 on error.
///
/// # Safety
/// `atlas_ptr` must point at a valid atlas buffer.
#[no_mangle]
pub unsafe extern "C" fn chunk_build(atlas_ptr: *const u8, cx: i32, cz: i32, lod: u32) -> *const u8 {
    let r = atlas_slice(atlas_ptr).and_then(|b| {
        let a = Atlas::parse(b)?;
        crate::chunk::build(&a, cx, cz, lod)
    });
    match r {
        Ok(bytes) => scratch_result(bytes),
        Err(e) => {
            set_error(&e);
            set_len(0);
            core::ptr::null()
        }
    }
}

/// Ground height at (x, z). Returns -1e9 if the atlas is invalid (never NaN).
///
/// # Safety
/// `atlas_ptr` must point at a valid atlas buffer.
#[no_mangle]
pub unsafe extern "C" fn collision_height(atlas_ptr: *const u8, x: f64, z: f64) -> f64 {
    match atlas_slice(atlas_ptr).and_then(Atlas::parse) {
        Ok(a) if x.is_finite() && z.is_finite() => crate::ground::collision_height(&a, x, z),
        Ok(_) => {
            set_error("non-finite coordinate");
            -1e9
        }
        Err(e) => {
            set_error(&e);
            -1e9
        }
    }
}

/// Surface normal at (x, z) written as 3 f64 (nx, ny, nz) at `out_ptr`;
/// returns the slope in degrees, or -1 on error.
///
/// # Safety
/// `atlas_ptr` must be a valid atlas; `out_ptr` must have 24 writable bytes.
#[no_mangle]
pub unsafe extern "C" fn ground_normal(atlas_ptr: *const u8, x: f64, z: f64, out_ptr: *mut u8) -> f64 {
    match atlas_slice(atlas_ptr).and_then(Atlas::parse) {
        Ok(a) if x.is_finite() && z.is_finite() => {
            let (n, slope) = crate::ground::ground_normal(&a, x, z);
            let out = core::slice::from_raw_parts_mut(out_ptr, 24);
            for (i, v) in n.iter().enumerate() {
                out[i * 8..i * 8 + 8].copy_from_slice(&v.to_le_bytes());
            }
            slope
        }
        Ok(_) => -1.0,
        Err(e) => {
            set_error(&e);
            -1.0
        }
    }
}

/// Ray against the surface. Returns hit distance along the normalized
/// direction, or -1 for no hit within min(max_dist, 1024 m).
///
/// # Safety
/// `atlas_ptr` must point at a valid atlas buffer.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn raycast(atlas_ptr: *const u8, ox: f64, oy: f64, oz: f64, dx: f64, dy: f64, dz: f64, max_dist: f64) -> f64 {
    match atlas_slice(atlas_ptr).and_then(Atlas::parse) {
        Ok(a) => crate::ground::raycast(&a, ox, oy, oz, dx, dy, dz, max_dist),
        Err(e) => {
            set_error(&e);
            -1.0
        }
    }
}

/// 64-bit content hash (FNV-1a 64) of any buffer in linear memory.
///
/// # Safety
/// `ptr..ptr+len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn hash_buffer(ptr: *const u8, len: usize) -> u64 {
    if len == 0 {
        return crate::hash_bytes(&[]);
    }
    crate::hash_bytes(core::slice::from_raw_parts(ptr, len))
}
