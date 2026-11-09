// Playtest 1 "towns on natural terrain" evidence: WP20's walk-into-a-building
// check and pt/ux's door walk-through, on SLOPED lots of hamlets and
// villages (genVersion 2): buildings on timber posts, on stepped plinths,
// with porches and the tallest door steps. Client prediction (TS town.ts,
// doors.ts) against the zone binary (Go server/pkg/towns), official world.
// From client/: npx vite-node src/world/buildings/dev/sloped-acceptance.ts
// Writes docs/evidence/pt-towns-sloped-walk.txt.
import fs from 'node:fs';
import path from 'node:path';
import { BUILDING_FLAG, BUILDING_ROLES, type Building, type Towns } from '@lodestone/worldgen';
import { buildZone, repoRoot, startZone } from '../../../sim/dev/traversalRun';
import { setupWalk, walkIntoBuilding } from './walkIntoBuilding';
import { doorWalkPass, offsetForHour, setupDoorWalk, walkThroughDoor } from './doorWalk';

const walk = await setupWalk();
const dw = await setupDoorWalk();
const t: Towns = walk.towns;

/** Ground range under a building's corners (m). */
function relief(b: Building): number {
  const g: number[] = [];
  for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) g.push(walk.ground.heightAt(b.x + u * b.hx * b.c - v * b.hz * b.s, b.z + u * b.hx * b.s + v * b.hz * b.c));
  return Math.max(...g) - Math.min(...g);
}
/** Rise of its door ramp/steps (0 without). */
function stepRise(b: Building): number {
  for (let i = b.boxFirst; i < b.boxFirst + b.boxCount; i++) if (t.boxes.kind[i] === 4) return Math.abs(t.boxes.f[i * 9 + 8] - t.boxes.f[i * 9 + 7]);
  return 0;
}
const open = (b: Building) => (b.flags & BUILDING_FLAG.openFront) === 0;
const cands = t.buildings.filter((b) => b.floors > 0 && open(b) && !t.settlements[b.settlement].walled && dw.doors.byBuilding.has(b.index));
const pick: { why: string; b: Building }[] = [];
const take = (why: string, list: Building[], n: number) => {
  for (const b of list) {
    if (pick.length && pick.some((p) => p.b.index === b.index)) continue;
    pick.push({ why, b });
    if (--n === 0) break;
  }
};
take('timber posts (steepest lots)', cands.filter((b) => b.flags & BUILDING_FLAG.posts).sort((a, b) => relief(b) - relief(a)), 2);
take('stepped plinth with a porch', cands.filter((b) => b.flags & BUILDING_FLAG.stepped && b.flags & BUILDING_FLAG.porch).sort((a, b) => relief(b) - relief(a)), 2);
take('tallest door steps', [...cands].sort((a, b) => stepRise(b) - stepRise(a)), 2);

const zone = await startZone(buildZone(), '20261108', { LODESTONE_ZONE_TIME_OFFSET_S: offsetForHour(12) });
try {
  const out: string[] = [
    `# Playtest 1 sloped lots: walk into buildings and through their doors, client prediction (TS town.ts + doors.ts) vs the zone binary (Go server/pkg/towns), official world seed 20261108, genVersion 2`,
    `date ${new Date().toISOString()}`,
    `walk-in: from 3+ m beyond the foot of the door steps, up them (and over the porch), through the door to the back wall, jump under the ceiling, turn, out again (WP20 script). door: close from outside, walk into it, open, walk in, close behind, push, open, walk out (pt/ux script).`,
  ];
  let ok = true;
  let corrections = 0;
  let maxDiv = 0;
  let walks = 0;
  for (const [k, { why, b }] of pick.entries()) {
    const st = t.settlements[b.settlement];
    out.push('', `## ${why}: building ${b.index} (${BUILDING_ROLES[b.role]}, flags ${b.flags}) in settlement ${st.index} (size ${st.size}), ground range under it ${relief(b).toFixed(2)} m, door steps rise ${stepRise(b).toFixed(2)} m, floor ${b.floorY.toFixed(2)}, foundation bottom ${b.baseY.toFixed(2)}`);
    const r = await walkIntoBuilding(zone, { ...walk, building: b }, `s${k}`);
    const pass = r.run.corrections === 0 && r.run.maxDivM < 0.02 && r.insideSamples > 20 && r.maxV <= r.wallLimitV + 1e-3 && r.minInsideY >= r.floorY - 1e-6;
    out.push('walk-in:', ...r.lines, pass ? 'PASS' : 'FAIL');
    const d = dw.doors.doors[dw.doors.byBuilding.get(b.index)!];
    const dr = await walkThroughDoor(zone, dw, d, `sd${k}`);
    const dpass = doorWalkPass(dr);
    out.push('door:', ...dr.lines, dpass ? 'PASS' : 'FAIL');
    corrections += r.run.corrections + dr.run.corrections;
    maxDiv = Math.max(maxDiv, r.run.maxDivM, dr.run.maxDivM);
    walks += 2;
    ok &&= pass && dpass;
  }
  out.push('', `zone log (towns):`, ...zone.log.filter((l) => /towns ready|NO TOWNS|terrain ready/.test(l)));
  out.push('', `total: ${pick.length} sloped buildings, ${walks} walks, corrections ${corrections}, max divergence ${(maxDiv * 100).toFixed(2)} cm`, ok ? 'ALL PASS' : 'FAILURES');
  fs.writeFileSync(path.join(repoRoot, 'docs', 'evidence', 'pt-towns-sloped-walk.txt'), out.join('\n') + '\n');
  console.log(out.join('\n'));
  process.exitCode = ok ? 0 : 1;
} finally {
  zone.proc.kill();
}
