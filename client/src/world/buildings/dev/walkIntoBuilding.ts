// WP20 acceptance: walk into a building with client prediction against the
// real zone binary. The zone (Go) runs server/pkg/towns on the official
// world; this Node client predicts on worldgen/js town.ts through
// TownGround, on the same terrain + towers (WP10's harness: startZone /
// runTimeline). The walk starts on the street in front of the spawn
// settlement's inn, goes in through the door, presses into the back wall
// (pushed out every step), jumps under the ground-floor ceiling, turns and
// walks out again. Prediction must equal the server to the centimetre with
// no corrections, and the walker must really have been inside and stopped
// by the wall.
//
// Evidence run: `npx vite-node src/world/buildings/dev/walk-acceptance.ts`
// (from client/; writes docs/evidence/wp20-walk-into-building.txt).
// Short test: walkIntoBuilding.integration.test.ts.

import fs from 'node:fs';
import path from 'node:path';
import { parseTowns, TownCollision, townsBytes, BUILDING_ROLES, type Building, type Towns } from '@lodestone/worldgen';
import { loadWorldgenGround } from '../../../sim/worldgenGround';
import { formatRun, repoRoot, runTimeline, zoneGround, type RunResult, type ZoneProc } from '../../../sim/dev/traversalRun';
import type { GroundQuery } from '../../../sim/ground';
import type { MoveState } from '../../../sim/movement';
import { TownGround } from '../townGround';

export interface WalkSetup {
  ground: GroundQuery;
  towns: Towns;
  building: Building;
}

export async function setupWalk(seed = '20261108'): Promise<WalkSetup> {
  const wasm = fs.readFileSync(path.join(repoRoot, 'worldgen', 'pkg', 'worldgen.wasm'));
  const terrain = await loadWorldgenGround(wasm, seed);
  const towns = parseTowns(townsBytes(terrain.wg, terrain.atlas));
  const ground = new TownGround(zoneGround(terrain), new TownCollision(towns.boxes));
  // The spawn settlement (nearest to the atlas spawn) and its inn.
  const sp = terrain.atlas.data.spawn;
  let best = towns.settlements[0];
  for (const s of towns.settlements) if (Math.hypot(s.x - sp.x, s.z - sp.z) < Math.hypot(best.x - sp.x, best.z - sp.z)) best = s;
  const inns = towns.buildings.filter((b) => b.settlement === best.index && BUILDING_ROLES[b.role] === 'inn');
  if (!inns.length) throw new Error('spawn settlement has no inn');
  return { ground, towns, building: inns[0] };
}

const local = (b: Building, u: number, v: number) => ({ x: b.x + u * b.c - v * b.s, z: b.z + u * b.s + v * b.c });
const toLocal = (b: Building, x: number, z: number) => {
  const dx = x - b.x;
  const dz = z - b.z;
  return { u: dx * b.c + dz * b.s, v: dz * b.c - dx * b.s };
};

export interface WalkResult {
  run: RunResult;
  insideSamples: number;
  maxV: number;
  wallLimitV: number;
  jumped: boolean;
  floorY: number;
  minInsideY: number;
  maxInsideY: number;
  lines: string[];
}

export async function walkIntoBuilding(zone: ZoneProc, s: WalkSetup, name = 'inn'): Promise<WalkResult> {
  const b = s.building;
  // Start 6 m in front of the door (porch included), facing it (+v); on a
  // slope (genVersion 2) at least 3 m beyond the foot of the door steps.
  let stairs = 0;
  for (let i = b.boxFirst; i < b.boxFirst + b.boxCount; i++) if (s.towns.boxes.kind[i] === 4) stairs = 2 * s.towns.boxes.f[i * 9 + 4];
  const start = local(b, b.doorU, -b.hz - (b.flags & 1 ? 2 : 0) - Math.max(6, stairs + 3));
  // Facing the building's +v axis, world direction (-s, c). Movement yaw
  // follows the camera convention: forward = (-sin yaw, -cos yaw), so a
  // direction (dx, dz) is yaw atan2(-dx, -dz).
  const inward = Math.atan2(b.s, -b.c);
  const yawDeg = (inward * 180) / Math.PI;
  let insideSamples = 0;
  let maxV = -Infinity;
  let minInsideY = Infinity;
  let maxInsideY = -Infinity;
  let jumped = false;
  const track = (st: MoveState) => {
    const l = toLocal(b, st.pos.x, st.pos.z);
    if (Math.abs(l.u) < b.hx && Math.abs(l.v) < b.hz) {
      insideSamples++;
      maxV = Math.max(maxV, l.v);
      minInsideY = Math.min(minInsideY, st.pos.y);
      maxInsideY = Math.max(maxInsideY, st.pos.y);
      if (st.pos.y > b.floorY + 0.3) jumped = true;
    }
    return false;
  };
  const run = await runTimeline(
    zone,
    s.ground,
    name,
    { x: start.x, z: start.z, yawDeg },
    [
      { dur: 0.4, until: track },
      // Through the door and on to the back wall (pushed out there).
      { dur: 7, held: { forward: true }, until: track },
      // Jump under the ground-floor ceiling, still pressing into the wall.
      { dur: 1.2, held: { forward: true }, press: 'jump', note: 'jump' },
      { dur: 1.0, held: { forward: true }, until: track },
      // Turn round and walk out of the door.
      { dur: 7, held: { forward: true }, yawDeg: yawDeg + 180, until: track },
    ],
    { raining: false, updraft: null },
  );
  const wt = b.style === 1 || b.style === 2 ? 0.5 : 0.3;
  const wallLimitV = b.hz - wt - 0.4; // body centre can't pass the inner face of the back wall
  const lines = [
    `building ${b.id.toString(16)} (${BUILDING_ROLES[b.role]}, style ${b.style}) at (${b.x.toFixed(2)}, ${b.z.toFixed(2)}) floor y ${b.floorY.toFixed(2)}, ${b.floors} floor(s), door ${b.doorW.toFixed(2)} m at u ${b.doorU.toFixed(2)}`,
    `start (${start.x.toFixed(2)}, ${start.z.toFixed(2)}) yaw ${yawDeg.toFixed(1)} deg; ${insideSamples} predicted samples inside the walls; deepest v ${maxV.toFixed(3)} (back wall limit ${wallLimitV.toFixed(3)}); inside y ${minInsideY.toFixed(3)}..${maxInsideY.toFixed(3)}; jumped ${jumped}`,
    formatRun(run),
  ];
  return { run, insideSamples, maxV, wallLimitV, jumped, floorY: b.floorY, minInsideY, maxInsideY, lines };
}
