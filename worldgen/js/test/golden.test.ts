// Determinism host 1 of 3: Node. Same table as headless Chromium
// (worldgen/harness/browser) and Go/wazero (worldgen/harness/go).
import fs from 'node:fs';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { BIOMES } from '../src/index';
import { runGolden, stats, type GoldenFile } from '../src/golden';
import { goldenPath, hasWasm, worldgen } from './wasm';

const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8')) as GoldenFile;

describe('golden table shape', () => {
  it('covers >= 200 chunks spanning every biome', () => {
    const chunks = golden.worlds.flatMap((w) => w.chunks);
    expect(chunks.length).toBeGreaterThanOrEqual(200);
    for (const b of BIOMES) expect(chunks.filter((c) => c.tag === `biome:${b}`).length).toBeGreaterThanOrEqual(6);
    for (const w of golden.worlds) expect(w.atlas.gzipBytes).toBeLessThan(2 * 1024 * 1024);
  });
});

describe.skipIf(!hasWasm)('golden hashes (Node host)', () => {
  it('every atlas, chunk and collision height matches', async () => {
    const wg = await worldgen();
    const r = runGolden(wg, golden, () => performance.now(), `node ${process.version}`);
    const s = stats(r.chunkMs);
    console.log(
      `[golden:node] ${r.worlds} worlds, ${r.chunks} chunks, ${r.collisions} collision points, ${r.failures.length} failures; ` +
        `atlas ${r.atlasMs.map((m) => m.toFixed(0)).join('/')} ms; lod0 chunk mean ${s.mean.toFixed(2)} p95 ${s.p95.toFixed(2)} max ${s.max.toFixed(2)} ms`,
    );
    expect(r.failures).toEqual([]);
    expect(r.chunks).toBeGreaterThanOrEqual(200);
  }, 120_000);

  it('atlas stays under the 2 MB gzipped budget', async () => {
    const wg = await worldgen();
    const a = wg.buildAtlas(golden.worlds[0].spec);
    const gz = zlib.gzipSync(a.bytes(), { level: 9 }).length;
    console.log(`[golden:node] atlas ${a.byteLength} B raw, ${gz} B gzipped (budget 2097152)`);
    expect(gz).toBeLessThan(2 * 1024 * 1024);
    a.free();
  });
});
