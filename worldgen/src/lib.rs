//! Lodestone worldgen core. WP00 skeleton: only the generated contracts and the
//! content hash exist; WP01 builds the atlas and chunk passes on top.
//!
//! Determinism rules (spec 5): no host-imported math (use `libm`), no threads,
//! no relaxed SIMD, no clocks, no host randomness; randomness is a counter-based
//! hash of (seed, stream, x, y, z).

pub mod gen;

/// 64-bit content hash used for golden tests (FNV-1a 64; WP01 may replace it
/// with a faster hash as long as it pins the choice in the golden table).
pub fn hash_bytes(data: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in data {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv_known_values() {
        assert_eq!(hash_bytes(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(hash_bytes(b"a"), 0xaf63_dc4c_8601_ec8c);
    }

    #[test]
    fn constants_generated() {
        assert_eq!(gen::constants::CHUNK_SIZE_M, 64);
        assert_eq!(gen::constants::REGION_CHUNKS * gen::constants::CHUNK_SIZE_M * gen::constants::WORLD_REGIONS, gen::constants::WORLD_SIZE_M);
    }
}
