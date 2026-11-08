// WP10 across process boundaries: the real zone binary on the generated
// official world (worldhost terrain, rain forced on so the climb also slips)
// against this package's Node client predicting on worldgen.wasm. A grab, a
// rain climb with slips and a lunge, then a jump off a ledge into a glide
// would be long; this keeps to ~10 s: walk into the cliff, climb in rain,
// lunge, let go. Prediction must match the server within 10 cm in every mode
// (it should be quantization only: < 1 cm) with no corrections. The full
// climb/glide/swim/drown run is `npm run traversal:accept -w client`.
// Skipped without Go or the built wasm (LODESTONE_SKIP_GO=1 forces a skip).
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadWorldgenGround } from './worldgenGround';
import { buildZone, goAvailable, repoRoot, runTimeline, startZone, zoneGround, type ZoneProc } from './dev/traversalRun';
import type { GroundQuery } from './ground';

const wasm = path.join(repoRoot, 'worldgen', 'pkg', 'worldgen.wasm');
const enabled = goAvailable() && fs.existsSync(wasm);

describe.skipIf(!enabled)('traversal against the real zone process on generated terrain', () => {
  let zone: ZoneProc;
  let ground: GroundQuery;

  beforeAll(async () => {
    ground = zoneGround(await loadWorldgenGround(fs.readFileSync(wasm), '20261108'));
    zone = await startZone(buildZone(), '20261108', { LODESTONE_ZONE_DEBUG_RAIN: '1' });
  }, 180000);

  afterAll(() => zone?.proc.kill());

  it('climbs in rain (slips, lunge) with prediction == server to the centimeter', async () => {
    const r = await runTimeline(
      zone,
      ground,
      'itclimb',
      { x: 1336.2, z: 2339.35, yawDeg: 90 },
      [{ dur: 0.3 }, { dur: 5, held: { forward: true } }, { dur: 0.4, held: { forward: true }, press: 'jump' }, { dur: 2.5, held: { forward: true } }, { dur: 1 }],
      { raining: true, updraft: null },
    );
    expect(r.perMode.climb?.snapshots ?? 0).toBeGreaterThan(50);
    expect(r.maxDivM).toBeLessThan(0.1);
    expect(r.corrections).toBe(0);
    console.log(`[wp10-it] ${r.snapshots} snapshots, max divergence ${(r.maxDivM * 100).toFixed(2)} cm, modes ${Object.keys(r.perMode).join('/')}, corrections ${r.corrections}`);
  }, 60000);
});
