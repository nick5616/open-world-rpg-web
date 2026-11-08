// Grass blade clumps for one lod-0 chunk, generated in a worker from the
// chunk's grass splat weight. Purely visual (never on the wire, never edited,
// no stable ids), so it uses a local hash rather than worldgen's id scheme;
// it is still deterministic so the same spot always has the same grass.
//
// The scatter records' grass tufts (layer 4) are the sparse, named objects;
// this fills the meadow between them so the wind has something to move.

import { chunkSurfaceHeight, type ChunkData } from '@lodestone/worldgen';

/** 32-bit integer hash (lowbias32 by Chris Wellons). */
export function hash32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}
const h3 = (a: number, b: number, c: number) => hash32(a ^ hash32(b ^ hash32(c + 0x9e3779b9)));
const unit = (h: number) => h / 4294967296;

/** Pack yaw (0..2pi), scale (0..1) and tint (0..1) into one float exactly (24 bits). */
export function packGrass(yaw: number, scale: number, tint: number): number {
  const q = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return q(yaw / (Math.PI * 2)) + 256 * q(scale) + 65536 * q(tint);
}
export function unpackGrass(p: number): [number, number, number] {
  return [((p % 256) / 255) * Math.PI * 2, (Math.floor(p / 256) % 256) / 255, Math.floor(p / 65536) / 255];
}

/**
 * @param density clumps per square meter at full grass weight
 * @returns x, y, z, packed per clump
 */
export function generateGrass(c: ChunkData, density: number): Float32Array {
  if (c.lod !== 0 || density <= 0) return new Float32Array(0);
  const cell = 1 / Math.sqrt(density);
  const n = Math.floor(64 / cell);
  const out: number[] = [];
  const S = c.samples;
  const x0 = c.cx * 64;
  const z0 = c.cz * 64;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const h = h3(c.cx * 4096 + i, c.cz * 4096 + j, 0x6772);
      const x = x0 + (i + unit(h)) * cell;
      const z = z0 + (j + unit(hash32(h))) * cell;
      const si = Math.min(S - 1, Math.round(x - x0));
      const sj = Math.min(S - 1, Math.round(z - z0));
      const s = sj * S + si;
      const grass = c.splatA[s * 4] / 255;
      if (unit(hash32(h ^ 0x51ed)) > grass * grass * 1.2) continue;
      const y = chunkSurfaceHeight(c, Math.min(x, x0 + 63.999), Math.min(z, z0 + 63.999));
      if (c.water[s] > y + 0.05) continue; // no grass under rivers or lakes
      const moisture = c.splatB[s * 4 + 3] / 255;
      const yaw = unit(hash32(h ^ 0x1234)) * Math.PI * 2;
      const scale = 0.55 + 0.45 * unit(hash32(h ^ 0x9876)) * (0.6 + 0.4 * grass);
      out.push(x, y, z, packGrass(yaw, Math.min(1, scale), moisture));
    }
  }
  return new Float32Array(out);
}
