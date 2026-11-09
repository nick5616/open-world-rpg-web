// Doors across process boundaries: close, walk into, open, walk through,
// close behind you, push into and open the spawn settlement's inn door with
// client prediction (TS doors.ts through DoorGround + DoorSync) against the
// real zone binary (Go server/pkg/towns doors.go, stamped Events 970) on
// the official world. Prediction must equal the server to the centimetre
// with no corrections; the closed door must stop the walker on both sides.
// The evidence run is dev/door-acceptance.ts. Skipped without Go or the
// built wasm (LODESTONE_SKIP_GO=1 forces a skip).
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildZone, goAvailable, repoRoot, startZone, type ZoneProc } from '../../sim/dev/traversalRun';
import { doorsToWalk, offsetForHour, setupDoorWalk, walkThroughDoor, type DoorWalkSetup } from './dev/doorWalk';

const wasm = path.join(repoRoot, 'worldgen', 'pkg', 'worldgen.wasm');
const enabled = goAvailable() && fs.existsSync(wasm);

describe.skipIf(!enabled)('walking through a closing door against the real zone process', () => {
  let zone: ZoneProc;
  let setup: DoorWalkSetup;

  beforeAll(async () => {
    setup = await setupDoorWalk();
    zone = await startZone(buildZone(), '20261108', { LODESTONE_ZONE_TIME_OFFSET_S: offsetForHour(12) });
  }, 180000);

  afterAll(() => zone?.proc.kill());

  it('blocked while closed on both sides, walks through while open, prediction == server', async () => {
    const r = await walkThroughDoor(zone, setup, doorsToWalk(setup)[0], 'itdoor');
    console.log(`[door-it] ${r.lines[1]}; ${r.lines[2]}; max divergence ${(r.run.maxDivM * 100).toFixed(2)} cm, corrections ${r.run.corrections}`);
    expect(r.events.states).toBe(4);
    expect(r.events.refused).toBe(0);
    expect(r.inside && r.out).toBe(true);
    expect(r.outsideGap).toBeGreaterThanOrEqual(r.limit - 0.01);
    expect(r.insideGap).toBeGreaterThanOrEqual(r.limit - 0.01);
    expect(r.run.maxDivM).toBeLessThan(0.02);
    expect(r.run.corrections).toBe(0);
  }, 90000);
});
