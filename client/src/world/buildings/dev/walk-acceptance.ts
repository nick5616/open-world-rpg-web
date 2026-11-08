// WP20 evidence: walk into three buildings of the spawn settlement with
// client prediction against the zone binary (see walkIntoBuilding.ts).
// From client/: npx vite-node src/world/buildings/dev/walk-acceptance.ts
import fs from 'node:fs';
import path from 'node:path';
import { buildZone, repoRoot, startZone } from '../../../sim/dev/traversalRun';
import { setupWalk, walkIntoBuilding } from './walkIntoBuilding';

const s = await setupWalk();
const zone = await startZone(buildZone(), '20261108');
try {
  const out: string[] = [`# WP20 walk into a building: client prediction (TS town.ts) vs the zone binary (Go server/pkg/towns), official world seed 20261108`, `date ${new Date().toISOString()}`];
  // The inn of the spawn settlement, then two more buildings of other roles/styles in the same town.
  const targets = [s.building, ...s.towns.buildings.filter((b) => b.settlement === s.building.settlement && b.floors > 0 && b.index !== s.building.index).slice(0, 2)];
  let ok = true;
  for (const [k, b] of targets.entries()) {
    const r = await walkIntoBuilding(zone, { ...s, building: b }, `b${k}`);
    out.push('', ...r.lines);
    const pass = r.run.corrections === 0 && r.run.maxDivM < 0.02 && r.insideSamples > 20 && r.maxV <= r.wallLimitV + 1e-3 && r.minInsideY >= r.floorY - 1e-6;
    out.push(pass ? 'PASS' : 'FAIL');
    ok &&= pass;
  }
  out.push('', `zone log (towns):`, ...zone.log.filter((l) => /towns ready|NO TOWNS/.test(l)));
  out.push('', ok ? 'ALL PASS' : 'FAILURES');
  const file = path.join(repoRoot, 'docs', 'evidence', 'wp20-walk-into-building.txt');
  fs.writeFileSync(file, out.join('\n') + '\n');
  console.log(out.join('\n'));
  process.exitCode = ok ? 0 : 1;
} finally {
  zone.proc.kill();
}
