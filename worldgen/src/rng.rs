//! Counter-based randomness (determinism rule 3).
//!
//! Every random decision is a pure function of `(seed, stream, coordinates)`,
//! never a stateful RNG shared between chunks, so chunks can be generated in
//! any order on any host with identical results. `Seq` is a small local
//! sequence used only inside one sequential algorithm (the atlas pass), where
//! the order of draws is itself deterministic.

/// SplitMix64 step (Steele, Lea, Flood 2014). Good avalanche, cheap in wasm.
#[inline]
pub fn splitmix64(z: u64) -> u64 {
    mix64(z.wrapping_add(0x9E37_79B9_7F4A_7C15))
}

/// The SplitMix64 finalizer alone. It is a bijection on u64, which is why
/// stable ids use it: a unique packed (layer, chunk, index) tuple always maps
/// to a unique id, yet ids look random (spec 5 "hash(cx, cz, layer, index)").
#[inline]
pub fn mix64(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Inverse of `mix64`, so tools can decode an id back to its packed tuple.
pub fn unmix64(mut z: u64) -> u64 {
    z ^= (z >> 31) ^ (z >> 62);
    z = z.wrapping_mul(0x3196_42B2_D24D_8EC3);
    z ^= (z >> 27) ^ (z >> 54);
    z = z.wrapping_mul(0x96DE_1B17_3F11_9089);
    z ^= (z >> 30) ^ (z >> 60);
    z
}

/// Hash of (seed, stream, a, b, c). Each input goes through a full SplitMix
/// round so nearby coordinates decorrelate completely.
#[inline]
pub fn hash(seed: u64, stream: u64, a: i64, b: i64, c: i64) -> u64 {
    let mut h = splitmix64(seed ^ stream.wrapping_mul(0xD6E8_FEB8_6659_FD93));
    h = splitmix64(h ^ a as u64);
    h = splitmix64(h ^ b as u64);
    splitmix64(h ^ c as u64)
}

/// Uniform f64 in [0, 1) from the top 53 bits.
#[inline]
pub fn unit(h: u64) -> f64 {
    (h >> 11) as f64 * (1.0 / 9_007_199_254_740_992.0)
}

/// Second independent uniform from the same hash (bits 0..32 re-mixed).
#[inline]
pub fn unit2(h: u64) -> f64 {
    unit(mix64(h ^ 0xA076_1D64_78BD_642F))
}

/// Pack a stable id: layer (8 bits) | a (16) | b (16) | index (24), then mix.
/// Callers guarantee the tuple is unique; the bijection keeps the id unique.
pub fn stable_id(layer: u8, a: i32, b: i32, index: u32) -> u64 {
    debug_assert!(index < (1 << 24));
    let packed = ((layer as u64) << 56) | (((a as u16) as u64) << 40) | (((b as u16) as u64) << 24) | (index as u64 & 0xFF_FFFF);
    mix64(packed)
}

/// Local deterministic sequence for the (sequential) atlas pass.
pub struct Seq {
    state: u64,
}

impl Seq {
    pub fn new(seed: u64, stream: u64) -> Self {
        Seq {
            state: hash(seed, stream, 0, 0, 0),
        }
    }
    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        mix64(self.state)
    }
    pub fn unit(&mut self) -> f64 {
        unit(self.next_u64())
    }
    pub fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.unit()
    }
    /// Integer in [0, n).
    pub fn below(&mut self, n: usize) -> usize {
        debug_assert!(n > 0);
        (((self.next_u64() >> 32) * n as u64) >> 32) as usize
    }
    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
}

/// Pick an index proportionally to non-negative weights with uniform `u`.
/// Returns the last positive index when rounding leaves `u` past the end.
pub fn weighted_pick(weights: &[f64], u: f64) -> usize {
    let total: f64 = weights.iter().sum();
    if total <= 0.0 {
        return 0;
    }
    let mut t = u * total;
    let mut last = 0;
    for (i, &w) in weights.iter().enumerate() {
        if w > 0.0 {
            last = i;
            if t < w {
                return i;
            }
            t -= w;
        }
    }
    last
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mix_is_invertible() {
        for v in [0u64, 1, 42, u64::MAX, 0x1234_5678_9abc_def0] {
            assert_eq!(unmix64(mix64(v)), v);
        }
    }

    #[test]
    fn splitmix_reference() {
        // First output of SplitMix64 seeded with 0 (reference implementation).
        assert_eq!(splitmix64(0), 0xE220_A839_7B1D_CDAF);
    }

    #[test]
    fn stable_ids_unique_in_chunk() {
        let mut ids: Vec<u64> = (0..4096).map(|i| stable_id(1, 3, -7, i)).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 4096);
    }

    #[test]
    fn unit_in_range() {
        let mut s = Seq::new(7, 1);
        for _ in 0..1000 {
            let u = s.unit();
            assert!((0.0..1.0).contains(&u));
        }
    }
}
