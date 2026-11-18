// Dev tool, not a test: PT5_OUT=<file.json> npx vitest run src/sim/probe dumps the official world's vertical descriptor
// (corridors with their points, openings, chambers, gates) for tools/playtest/pt5-underground.mjs (PT5_VERT), which walks
// the real client along the corridors. Skipped unless PT5_OUT is set.
import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { wasmPath } from '../golden/io';
import { WP10_SEED } from '../golden/wp10';
import { loadWorldgenGround } from '../worldgenGround';
import { verticalGround } from '../golden/vertical';

it.skipIf(!process.env.PT5_OUT)('dump the vertical descriptor', async () => {
  const ground = await loadWorldgenGround(readFileSync(wasmPath), WP10_SEED);
  const { v } = verticalGround(ground);
  const o = {
    corridors: v.corridors.map((r) => ({ layer: r.layer, kind: r.kind, from: r.from, to: r.to, pts: Array.from(r.pts) })),
    openings: v.openings,
    chambers: v.chambers,
    gates: v.gateOpenings,
  };
  writeFileSync(process.env.PT5_OUT!, JSON.stringify(o, (_k, val) => (typeof val === 'bigint' ? val.toString() : val)));
});
