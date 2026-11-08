// Golden file (de)serialization, shared by the generator and the regression test.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GoldenFile } from './scenarios';
import type { Wp10Golden } from './wp10';
import type { Wp13Golden } from './wp13';

const here = dirname(fileURLToPath(import.meta.url));

export function goldenPath(name: string): string {
  return join(here, `movement_${name}.json`);
}

/**
 * One frame/state row per line so diffs stay readable. JSON.stringify of a
 * double is its shortest round-trip form, which Go's strconv.ParseFloat (and
 * encoding/json) reads back bit-exactly.
 */
export function serializeGolden(g: GoldenFile | Wp10Golden | Wp13Golden): string {
  const { frames, states, ...head } = g;
  return [
    '{',
    ...Object.entries(head).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`),
    '  "frames": [',
    frames.map((f) => `    ${JSON.stringify(f)}`).join(',\n'),
    '  ],',
    '  "states": [',
    states.map((s) => `    ${JSON.stringify(s)}`).join(',\n'),
    '  ]',
    '}',
    '',
  ].join('\n');
}

/** worldgen.wasm as built by `npm run build:wasm` (the WP10 goldens run on it). */
export const wasmPath = join(here, '..', '..', '..', '..', 'worldgen', 'pkg', 'worldgen.wasm');
