// WP10 acceptance (spec 15: "climb a cliff, glide from a tower top, swim a
// lake, all matching between client prediction and server within 10 cm"):
//
//   npm run traversal:accept -w client      (needs Go and `npm run build:wasm`)
//
// Builds and runs the real zone binary on the generated official world
// (seed 20261108, no DB/Redis), connects this package's Node client
// (LocalSim + ZoneSession + prediction on worldgen.wasm terrain) over
// WebSocket and plays scripted timelines in real time on the zone's ground
// (terrain + WP12 towers): climb the 14.5 m cliff and mantle, climb a WP12
// tower (80 degree walls, rest on the ledge) and glide from its top, the same
// cliff in rain (second zone with rain forced), glide off the 360 m peak,
// ride a debug updraft, swim the lake out and back, and swim until drowning.
// Writes per-mode max divergence to docs/evidence/wp10-acceptance.{txt,json} and exits non-zero above 10 cm.

import fs from 'node:fs';
import path from 'node:path';
import { UpdraftColumns, type UpdraftColumn } from '../updraft';
import { loadWorldgenGround } from '../worldgenGround';
import { MoveMode } from '@lodestone/contracts';
import { buildZone, formatRun, goAvailable, repoRoot, runTimeline, startZone, zoneGround, type Beat, type RunResult, type ZoneProc } from './traversalRun';

const SEED = '20261108';
const LIMIT_M = 0.1;
// North of the peak, off the southbound glide path of the plain glide run.
const updraft: UpdraftColumn = { x: 1122, z: 2268, radius: 15, top: 385, lift: 6 };
const updraftSpec = `${updraft.x},${updraft.z},${updraft.radius},${updraft.top},${updraft.lift}`;

const climbSite = { x: 1336.2, z: 2339.35, yawDeg: 90 };
const peak = { x: 1122, z: 2301, yawDeg: 180 };
const peakNorth = { x: 1122, z: 2299, yawDeg: 0 };
const shore = { x: 1418, z: 1858, yawDeg: 180 };

const fwd = { forward: true };
const climb: Beat[] = [
  { dur: 0.3, note: 'stand on the ledge' },
  { dur: 3, held: fwd, note: 'walk into the cliff, grab, climb' },
  { dur: 0.3, held: fwd, press: 'jump', note: 'climb-jump lunge' },
  { dur: 1, held: { forward: true, right: true }, note: 'climb diagonally' },
  { dur: 4.6, held: fwd, note: 'climb to the top, mantle' },
  { dur: 0.7, held: fwd, yawDeg: 170, note: 'walk away from the edge' },
  { dur: 0.5 },
];
const climbRain: Beat[] = [
  { dur: 0.3 },
  { dur: 13, held: fwd, note: 'half speed, slips every 3 s, wheel runs out, slide back' },
  { dur: 1.5 },
];
const glide: Beat[] = [
  { dur: 1.5, held: { forward: true, sprint: true }, note: 'sprint to the drop' },
  { dur: 0.4, held: fwd, press: 'jump', note: 'jump' },
  { dur: 0.5, held: fwd, press: 'jump', note: 'double jump' },
  { dur: 4, held: fwd, press: 'jump', note: 'third press: glider opens; glide south' },
  { dur: 2, held: { forward: true, left: true }, yawDeg: 200, note: 'steer' },
  { dur: 0.5, held: fwd, press: 'glide', note: 'G: close the glider, fall' },
  { dur: 3, held: fwd, press: 'glide', note: 'G: reopen' },
  { dur: 6, held: fwd, press: 'jump', note: 'close and fall to the slope below' },
];
const glideUpdraft: Beat[] = [
  { dur: 1.5, held: { forward: true, sprint: true }, note: 'sprint north off the peak' },
  { dur: 0.4, held: fwd, press: 'jump' },
  { dur: 0.5, held: fwd, press: 'jump' },
  { dur: 0.8, held: fwd, press: 'jump', note: 'glider opens, into the column' },
  { dur: 5, note: 'no input: drift to a stop inside the column and rise' },
  { dur: 4, held: fwd, note: 'leave the column north, sink' },
];
const swim: Beat[] = [
  { dur: 0.3 },
  { dur: 6, held: fwd, note: 'walk into the lake, swim out' },
  { dur: 5, held: fwd, yawDeg: 0, note: 'turn, swim back, walk out' },
  { dur: 2.5, note: 'stand: regen after 1 s' },
];
// WP12 tower at site (1888, 1760): approach from 14 m west, facing east.
const towerSite = { x: 1874, z: 1760, yawDeg: -90 };
function towerIndex(g: ReturnType<typeof zoneGround>): number {
  for (let i = 0; i < g.overlay.length; i++) {
    const t = g.overlay.at(i) as unknown as { cx: number; cz: number };
    if (Math.hypot(t.cx - 1888, t.cz - 1760) < 1) return i;
  }
  throw new Error('no tower at (1888, 1760)');
}
let climbedOnce = false;
function towerTimeline(topY: number): Beat[] {
  return [
    { dur: 0.3 },
    {
      dur: 14,
      held: fwd,
      note: 'walk into the 80 degree lower wall, climb it to the ledge',
      until: (s) => {
        if (s.mode === MoveMode.climb) climbedOnce = true;
        return climbedOnce && s.mode === MoveMode.ground;
      },
    },
    { dur: 3, note: 'rest on the ledge: the wheel refills (1 s delay, 40/s)' },
    { dur: 14, held: fwd, note: 'climb the upper wall, mantle onto the top', until: (s) => s.mode === MoveMode.ground && s.pos.y >= topY - 0.01 },
    { dur: 0.7, held: fwd, note: 'run across the top' },
    { dur: 0.35, held: fwd, press: 'jump', note: 'jump off the far edge' },
    { dur: 0.45, held: fwd, press: 'jump', note: 'double jump' },
    { dur: 5, held: fwd, press: 'jump', note: 'third press: glide from the tower top' },
    { dur: 2, held: { forward: true, left: true }, note: 'steer' },
    { dur: 4, held: fwd, press: 'glide', note: 'G: close the glider, fall, land' },
  ];
}

const drown: Beat[] = [
  { dur: 0.3 },
  { dur: 19, held: fwd, note: 'swim for the deep middle until the wheel is empty, drown, respawn at the shore' },
  { dur: 1.5 },
];

async function main(): Promise<void> {
  if (!goAvailable()) throw new Error('Go not found (PATH or ~/sdk/go/bin)');
  const wasm = path.join(repoRoot, 'worldgen', 'pkg', 'worldgen.wasm');
  if (!fs.existsSync(wasm)) throw new Error('build the wasm first: npm run build:wasm');
  // Terrain + WP12 towers: exactly the zone's ground.
  const ground = zoneGround(await loadWorldgenGround(fs.readFileSync(wasm), SEED));
  const tw = ground.overlay.at(towerIndex(ground)) as unknown as { topY: number };
  const towerBeats = towerTimeline(tw.topY);
  console.log('building zone...');
  const bin = buildZone();
  const zones: ZoneProc[] = [];
  const results: RunResult[] = [];
  try {
    const dry = await startZone(bin, SEED, { LODESTONE_ZONE_DEBUG_RAIN: '0', LODESTONE_ZONE_DEBUG_UPDRAFTS: updraftSpec });
    zones.push(dry);
    const wet = await startZone(bin, SEED, { LODESTONE_ZONE_DEBUG_RAIN: '1' });
    zones.push(wet);
    const dryEnv = { raining: false, updraft: new UpdraftColumns([updraft]) };
    const wetEnv = { raining: true, updraft: null };
    const plan: [string, ZoneProc, typeof climbSite, Beat[], typeof dryEnv | typeof wetEnv][] = [
      ['climb', dry, climbSite, climb, dryEnv],
      ['tower', dry, towerSite, towerBeats, dryEnv],
      ['climb-rain', wet, climbSite, climbRain, wetEnv],
      ['glide', dry, peak, glide, dryEnv],
      ['glide-updraft', dry, peakNorth, glideUpdraft, dryEnv],
      ['swim', dry, shore, swim, dryEnv],
      ['swim-drown', dry, shore, drown, dryEnv],
    ];
    for (const [name, z, at, beats, env] of plan) {
      console.log(`running ${name}...`);
      const r = await runTimeline(z, ground, name, at, beats, env);
      console.log(formatRun(r));
      results.push(r);
    }
  } finally {
    for (const z of zones) z.proc.kill();
  }

  const perMode: Record<string, number> = {};
  for (const r of results) for (const [m, s] of Object.entries(r.perMode)) perMode[m] = Math.max(perMode[m] ?? 0, s.maxDivM);
  const worst = Math.max(...results.map((r) => r.maxDivM));
  const pass = worst <= LIMIT_M;
  const head = [
    `WP10 traversal acceptance: real zone binary (Go, worldhost terrain) vs Node client prediction (TS step, worldgen.wasm terrain)`,
    `world: seed ${SEED} (official world, spec_from_seed), zone dev spawn per run, WebSocket, localhost`,
    `date: ${new Date().toISOString()}  node ${process.version}  ${process.platform}`,
    `divergence = |server SelfState position at ackInputSeq - client prediction for that seq| (server position is cm-quantized, so ~0.9 cm worst case is quantization)`,
    ``,
    `per-mode max divergence over all runs: ${Object.entries(perMode)
      .map(([m, d]) => `${m} ${(d * 100).toFixed(2)} cm`)
      .join(', ')}`,
    `overall max ${(worst * 100).toFixed(2)} cm vs limit ${LIMIT_M * 100} cm: ${pass ? 'PASS' : 'FAIL'}`,
    ``,
  ];
  const body = results.map(formatRun).join('\n\n');
  const samples = results.map((r) => `-- ${r.name} samples (every 15th snapshot)\n${r.samples.join('\n')}`).join('\n\n');
  const out = path.join(repoRoot, 'docs', 'evidence');
  fs.writeFileSync(path.join(out, 'wp10-acceptance.txt'), [...head, body, '', samples, ''].join('\n'));
  fs.writeFileSync(path.join(out, 'wp10-acceptance.json'), JSON.stringify({ seed: SEED, limitM: LIMIT_M, pass, perModeMaxM: perMode, results }, null, 2) + '\n');
  console.log(head.join('\n'));
  if (!pass) process.exit(1);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
