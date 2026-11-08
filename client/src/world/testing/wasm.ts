// Test helper: the real worldgen.wasm in Node (tests that need it skip with a
// warning when it isn't built, like worldgen/js/test/wasm.ts, unless
// LODESTONE_REQUIRE_WASM=1).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadWorldgen, type AtlasHandle, type Worldgen } from '@lodestone/worldgen';

export const wasmPath = fileURLToPath(new URL('../../../../worldgen/pkg/worldgen.wasm', import.meta.url));
export const hasWasm = fs.existsSync(wasmPath);
if (!hasWasm && process.env.LODESTONE_REQUIRE_WASM === '1') throw new Error(`missing ${wasmPath}: run npm run build:wasm`);
if (!hasWasm) console.warn(`[world tests] ${wasmPath} not built; wasm tests skipped (npm run build:wasm)`);

let cached: Promise<{ wg: Worldgen; atlas: AtlasHandle }> | null = null;

/** The default solo world (seed 20261108), built once per test file. */
export function testWorld(): Promise<{ wg: Worldgen; atlas: AtlasHandle }> {
  cached ??= (async () => {
    const wg = await loadWorldgen(fs.readFileSync(wasmPath));
    const atlas = wg.buildAtlas(wg.specFromSeed(20261108n));
    return { wg, atlas };
  })();
  return cached;
}

/** Deterministic pseudo-random sequence for sample points. */
export function rand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
