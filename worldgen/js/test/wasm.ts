// Shared test helper: load worldgen/pkg/worldgen.wasm if it was built.
// `npm test` runs before CI builds the wasm, so tests skip without it unless
// LODESTONE_REQUIRE_WASM=1 (set by `npm run test:golden`, which builds first).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadWorldgen, type Worldgen } from '../src/index';

export const wasmPath = fileURLToPath(new URL('../../pkg/worldgen.wasm', import.meta.url));
export const goldenPath = fileURLToPath(new URL('../../golden/golden.json', import.meta.url));
export const hasWasm = fs.existsSync(wasmPath);
if (!hasWasm && process.env.LODESTONE_REQUIRE_WASM === '1') throw new Error(`missing ${wasmPath}: run npm run build:wasm`);
if (!hasWasm) console.warn(`[worldgen] ${wasmPath} not built; wasm tests skipped (npm run build:wasm)`);

export async function worldgen(): Promise<Worldgen> {
  return loadWorldgen(fs.readFileSync(wasmPath));
}
