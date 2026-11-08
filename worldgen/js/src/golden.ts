// Golden-table runner shared by every JS host (Node test, Chromium worker).
// The Go/wazero host reimplements the same loop in worldgen/harness/go.
// Table format: worldgen/golden/README.md.
import type { WorldSpec } from '@lodestone/contracts';
import { hex64 } from './format';
import type { AtlasHandle, Worldgen } from './index';
import { checkCaves, type GoldenCaves } from './caveGolden';

export type { GoldenCaves } from './caveGolden';

export interface GoldenChunk {
  cx: number;
  cz: number;
  lod: number;
  /** Why this chunk is in the table (biome, water, site...). */
  tag: string;
  hash: string;
}

export interface GoldenWorld {
  label: string;
  seed: string;
  spec: WorldSpec;
  atlas: { hash: string; bytes: number; gzipBytes: number };
  chunks: GoldenChunk[];
  /** f64 bits of collision_height(x, z) as 16 hex digits. */
  collision: { x: number; z: number; h: string }[];
  /** WP09: cave cells, graph, masks and collision vectors (optional so older tables still load). */
  caves?: GoldenCaves;
}

export interface GoldenFile {
  hashAlgo: 'fnv1a64';
  genVersion: number;
  abiVersion: number;
  worlds: GoldenWorld[];
}

export interface GoldenResult {
  host: string;
  worlds: number;
  chunks: number;
  collisions: number;
  failures: string[];
  atlasMs: number[];
  /** Per LOD-0 chunk build time (ms), including the copy out of wasm memory. */
  chunkMs: number[];
  /** WP09 counters (cells checked, collision vectors) and per cave cell build time (ms). */
  caveCells: number;
  caveQueries: number;
  caveMs: number[];
}

export function f64Bits(v: number): string {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, v, true);
  return hex64(dv.getBigUint64(0, true));
}

export function runGolden(wg: Worldgen, golden: GoldenFile, now: () => number, host: string): GoldenResult {
  const r: GoldenResult = { host, worlds: 0, chunks: 0, collisions: 0, failures: [], atlasMs: [], chunkMs: [], caveCells: 0, caveQueries: 0, caveMs: [] };
  if (wg.genVersion !== golden.genVersion) r.failures.push(`genVersion ${wg.genVersion} != golden ${golden.genVersion}`);
  for (const w of golden.worlds) {
    const t0 = now();
    const atlas = wg.buildAtlas(w.spec);
    r.atlasMs.push(now() - t0);
    try {
      const ah = hex64(atlas.hash);
      if (ah !== w.atlas.hash) r.failures.push(`${w.label}: atlas ${ah} != ${w.atlas.hash}`);
      if (atlas.byteLength !== w.atlas.bytes) r.failures.push(`${w.label}: atlas ${atlas.byteLength} bytes != ${w.atlas.bytes}`);
      for (const c of w.chunks) {
        const t1 = now();
        const bytes = wg.buildChunkBytes(atlas, c.cx, c.cz, c.lod);
        if (c.lod === 0) r.chunkMs.push(now() - t1);
        const h = hex64(wg.hash(bytes));
        if (h !== c.hash) r.failures.push(`${w.label}: chunk (${c.cx},${c.cz},lod${c.lod}) ${h} != ${c.hash}`);
        r.chunks++;
      }
      if (w.caves) checkCaves(wg, atlas as AtlasHandle, w.label, w.caves, now, r);
      for (const p of w.collision) {
        const h = f64Bits(wg.collisionHeight(atlas, p.x, p.z));
        if (h !== p.h) r.failures.push(`${w.label}: collision (${p.x}, ${p.z}) ${h} != ${p.h}`);
        r.collisions++;
      }
    } finally {
      atlas.free();
    }
    r.worlds++;
  }
  return r;
}

export interface TimingStats {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
  min: number;
}

export function stats(ms: number[]): TimingStats {
  const s = [...ms].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / Math.max(1, s.length), p50: q(0.5), p95: q(0.95), max: s[s.length - 1], min: s[0] };
}

/**
 * Detail-chunk budget benchmark (spec 12: <= 8 ms in a worker): build `n`
 * LOD-0 chunks spread over the world after a warm-up, timing each.
 */
export function benchmarkChunks(wg: Worldgen, spec: WorldSpec, n: number, now: () => number): { atlasMs: number; chunks: TimingStats; scatterPerChunk: number } {
  const t0 = now();
  const atlas = wg.buildAtlas(spec);
  const atlasMs = now() - t0;
  try {
    for (let i = 0; i < 8; i++) wg.buildChunkBytes(atlas, 30 + i, 30, 0);
    const ms: number[] = [];
    let scatter = 0;
    for (let i = 0; i < n; i++) {
      // Low-discrepancy walk over the 64 x 64 chunk grid.
      const cx = Math.floor(((i * 0.6180339887) % 1) * 64);
      const cz = Math.floor(((i * 0.7548776662) % 1) * 64);
      const t1 = now();
      const c = wg.buildChunk(atlas, cx, cz, 0);
      ms.push(now() - t1);
      scatter += c.scatter.count;
    }
    return { atlasMs, chunks: stats(ms), scatterPerChunk: scatter / n };
  } finally {
    atlas.free();
  }
}
