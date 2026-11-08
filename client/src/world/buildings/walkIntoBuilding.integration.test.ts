// WP20 across process boundaries: walk into the spawn settlement's inn with
// client prediction (TS town collision through TownGround) against the real
// zone binary (Go server/pkg/towns) on the official world. Prediction must
// equal the server to the centimetre with no corrections, the walker must
// get inside and stop at the walls. The 3-building evidence run is
// dev/walk-acceptance.ts. Skipped without Go or the built wasm
// (LODESTONE_SKIP_GO=1 forces a skip).
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildZone, goAvailable, repoRoot, startZone, type ZoneProc } from '../../sim/dev/traversalRun';
import { setupWalk, walkIntoBuilding, type WalkSetup } from './dev/walkIntoBuilding';

const wasm = path.join(repoRoot, 'worldgen', 'pkg', 'worldgen.wasm');
const enabled = goAvailable() && fs.existsSync(wasm);

describe.skipIf(!enabled)('walking into a building against the real zone process', () => {
  let zone: ZoneProc;
  let setup: WalkSetup;

  beforeAll(async () => {
    setup = await setupWalk();
    zone = await startZone(buildZone(), '20261108');
  }, 180000);

  afterAll(() => zone?.proc.kill());

  it('enters the inn, stops at its walls, prediction == server', async () => {
    const r = await walkIntoBuilding(zone, setup, 'itinn');
    console.log(`[wp20-it] ${r.lines[1]}; max divergence ${(r.run.maxDivM * 100).toFixed(2)} cm, corrections ${r.run.corrections}`);
    expect(r.insideSamples).toBeGreaterThan(20);
    expect(r.maxV).toBeLessThanOrEqual(r.wallLimitV + 1e-3);
    expect(r.minInsideY).toBeGreaterThanOrEqual(r.floorY - 1e-6);
    expect(r.run.maxDivM).toBeLessThan(0.02);
    expect(r.run.corrections).toBe(0);
  }, 90000);
});
