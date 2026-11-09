package chem

// fmix32 is murmur3's finalizer (the weather hash's mixer).
func fmix32(h uint32) uint32 {
	h ^= h >> 16
	h *= 0x85ebca6b
	h ^= h >> 13
	h *= 0xc2b2ae35
	h ^= h >> 16
	return h
}

// hash4 mixes the world seed with four 32-bit words. All u32 arithmetic, so
// the TS twin (Math.imul, >>> 0) gives the same bits.
func hash4(seed uint64, a, b, c, d uint32) uint32 {
	h := uint32(seed) ^ uint32(seed>>32)*0x9e3779b1
	h = fmix32(h ^ a*0x85ebca6b)
	h = fmix32(h ^ b*0xc2b2ae35)
	h = fmix32(h ^ c*0x27d4eb2f)
	h = fmix32(h ^ d*0x165667b1)
	return h
}
