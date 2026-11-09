// Playtest doors evidence: walk through doors of the spawn settlement with
// client prediction against the zone binary (see doorWalk.ts): the inn and
// two houses directly, then the inn again through the netsim proxy with a
// ~190 ms round trip (no loss), where the stamps must cover the lag.
// From client/: npx vite-node src/world/buildings/dev/door-acceptance.ts
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildZone, freePort, repoRoot, startZone, waitHttp } from '../../../sim/dev/traversalRun';
import { doorsToWalk, doorWalkPass, offsetForHour, setupDoorWalk, walkThroughDoor } from './doorWalk';

const s = await setupDoorWalk();
const zone = await startZone(buildZone(), '20261108', { LODESTONE_ZONE_TIME_OFFSET_S: offsetForHour(12) });
const proxyPort = await freePort();
const proxy = spawn(process.execPath, [path.join(repoRoot, 'tools/netsim/proxy.mjs'), '--profile', 'clean', '--latency', '90', '--jitter', '8', '--listen', String(proxyPort), '--target', `ws://127.0.0.1:${zone.port}`], { stdio: 'ignore' });
try {
  await waitHttp(`http://127.0.0.1:${proxyPort}/config`);
  const out: string[] = [
    `# Playtest doors: walk through a closing/opening door, client prediction (TS worldgen/js doors.ts + DoorGround + DoorSync) vs the zone binary (Go server/pkg/towns doors.go, stamped Events 970), official world seed 20261108`,
    `date ${new Date().toISOString()}`,
    `script per door: close it from the street, walk into it (blocked), open it, walk in, turn, close it behind you from inside, push into it (blocked), open it, walk out`,
  ];
  const doors = doorsToWalk(s);
  const runs: { label: string; door: (typeof doors)[number]; z: typeof zone }[] = [
    { label: 'inn (direct)', door: doors[0], z: zone },
    { label: 'house 1 (direct)', door: doors[1], z: zone },
    { label: 'house 2 (direct)', door: doors[2], z: zone },
    { label: 'inn through netsim (90 ms each way + 8 ms jitter, no loss)', door: doors[0], z: { ...zone, port: proxyPort } },
  ];
  let ok = true;
  let corrections = 0;
  let maxDiv = 0;
  for (const [k, r0] of runs.entries()) {
    const r = await walkThroughDoor(r0.z, s, r0.door, `d${k}`);
    const pass = doorWalkPass(r);
    corrections += r.run.corrections;
    maxDiv = Math.max(maxDiv, r.run.maxDivM);
    out.push('', `## ${r0.label}`, ...r.lines, pass ? 'PASS' : 'FAIL');
    ok &&= pass;
  }
  out.push('', `zone log (towns):`, ...zone.log.filter((l) => /towns ready|NO TOWNS/.test(l)));
  out.push('', `total: ${runs.length} walks, corrections ${corrections}, max divergence ${(maxDiv * 100).toFixed(2)} cm`, ok ? 'ALL PASS' : 'FAILURES');
  const file = path.join(repoRoot, 'docs', 'evidence', 'pt-ux-door-walkthrough.txt');
  fs.writeFileSync(file, out.join('\n') + '\n');
  console.log(out.join('\n'));
  process.exitCode = ok ? 0 : 1;
} finally {
  proxy.kill();
  zone.proc.kill();
}
