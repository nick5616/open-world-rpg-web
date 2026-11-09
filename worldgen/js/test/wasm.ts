// Shared test helper: load worldgen/pkg/worldgen.wasm if it was built.
// `npm test` runs before CI builds the wasm, so tests skip without it unless
// LODESTONE_REQUIRE_WASM=1 (set by `npm run test:golden`, which builds first).
// LODESTONE_GOLDEN_WASM + LODESTONE_GOLDEN_FILE check an archived generator
// against its own table instead (spec 5: old genVersions stay loadable;
// worldgen/archive/README.md).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadWorldgen, type Worldgen } from '../src/index';

export const wasmPath = process.env.LODESTONE_GOLDEN_WASM || fileURLToPath(new URL('../../pkg/worldgen.wasm', import.meta.url));
export const goldenPath = process.env.LODESTONE_GOLDEN_FILE || fileURLToPath(new URL('../../golden/golden.json', import.meta.url));
export const hasWasm = fs.existsSync(wasmPath);
if (!hasWasm && process.env.LODESTONE_REQUIRE_WASM === '1') throw new Error(`missing ${wasmPath}: run npm run build:wasm`);
if (!hasWasm) console.warn(`[worldgen] ${wasmPath} not built; wasm tests skipped (npm run build:wasm)`);

export async function worldgen(): Promise<Worldgen> {
  return loadWorldgen(fs.readFileSync(wasmPath));
}
