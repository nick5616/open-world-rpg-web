#!/usr/bin/env node
// WP19: spec 14 soak scenario 1, "300 bots in one region plus 2,000 awake
// enemies: zone tick p99 within budget, no client over the downlink budget"
// (and, with --profile thailand, its scenario 4 variant).
//
// Real processes: one zone binary serving the official world's terrain
// (worldgen.wasm, seed 20261108) with LODESTONE_ZONE_DEBUG_HORDE placing
// enemy camps over a disc inside one 1024 m region, an optional netsim proxy,
// and tools/bots clustered in the same disc. No Postgres or Redis (the
// scenario is about the tick and the downlink), a fresh world id per run.
// The zone runs with GOMAXPROCS=4: spec 9's budget line is "4 vCPU".
//
//   node tools/bots/scale-soak.mjs --bots 300 --enemies 2000 --duration 3m
//   node tools/bots/scale-soak.mjs --bots 300 --enemies 2000 --duration 3m --profile thailand
//   node tools/bots/scale-soak.mjs ... --zone-bin path/to/zone.exe   (a prebuilt binary, e.g. a baseline)
//
// Every 5 s the runner samples the zone's /debug/tickstats (60 s window
// quantiles) and /debug/combat (enemies spawned, awake), so the evidence has
// a time series, not just the final scrape. Evidence:
// docs/evidence/wp19-s1-<tag>.txt|json (+ bots summary and zone metrics).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env, killTree, root, waitHttp } from '../../scripts/lib.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const BOTS = Number(arg('bots', '300'));
const ENEMIES = Number(arg('enemies', '2000'));
const DURATION = arg('duration', '3m');
const PROFILE = arg('profile', 'clean');
const CENTER = arg('center', '1700,1700'); // region (1,1) spans [1024, 2048) on both axes
const RADIUS = Number(arg('radius', '300'));
const PROCS = arg('procs', '4');
const PORT = Number(arg('port', '18510'));
const ZONE_BIN = arg('zone-bin', '');
const PPROF = process.argv.includes('--pprof');
const TAG = arg('tag', `${BOTS}b-${ENEMIES}e-${PROFILE}`);
// --prefix names the evidence files (<prefix>-s1-<tag>.*); WP19's second
// pass writes wp19b-*.
const PREFIX = arg('prefix', 'wp19');
const RUN = `${Date.now().toString(36)}${process.pid}`;
const EXE = process.platform === 'win32' ? '.exe' : '';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-wp19-'));
const EVIDENCE = path.join(root, 'docs', 'evidence');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lines = [];
function step(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  lines.push(line);
}

const children = [];
function start(name, cmd, args, extra) {
  const out = fs.createWriteStream(path.join(TMP, `${name}.log`));
  const child = spawn(cmd, args, { cwd: root, env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  children.push(child);
  return child;
}

// --zone-affinity / --bots-affinity (Windows, hex CPU masks): pin the zone to
// 4 logical CPUs (2 physical cores with SMT, what a cloud "4 vCPU" VM is) and
// the bots elsewhere, so the zone is not timed while sharing cores with the
// 300 bots that load it. Other agents' processes can still use those CPUs.
const ZONE_AFFINITY = arg('zone-affinity', '');
const BOTS_AFFINITY = arg('bots-affinity', '');
function pin(child, mask, name) {
  if (!mask || process.platform !== 'win32') return;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).ProcessorAffinity = ${parseInt(mask, 16)}`], { encoding: 'utf8' });
  step(`pinned ${name} (pid ${child.pid}) to CPU mask 0x${mask}${r.status === 0 ? '' : ` FAILED: ${r.stderr}`}`);
}

const getJSON = (url) => fetch(url).then((r) => r.json()).catch(() => null);

let exitCode = 1;
const series = [];
let lastPhases = null; // /debug/tickstats phases (last minute) from the last sample
try {
  step(`WP19 scenario 1 "${TAG}": ${BOTS} bots + ${ENEMIES} enemies in a ${RADIUS} m disc at ${CENTER}, ${DURATION}, netsim ${PROFILE}, zone GOMAXPROCS=${PROCS}`);
  step(`machine: ${os.cpus().length} logical CPUs (${os.cpus()[0].model}), shared with other agents; load avg n/a on Windows`);
  // Unique binary names per run (the machine is shared; never kill what we did not start).
  const zoneBin = ZONE_BIN || path.join(TMP, `wp19-zone-${RUN}${EXE}`);
  const botsBin = path.join(TMP, `wp19-bots-${RUN}${EXE}`);
  for (const [out, pkg] of [...(ZONE_BIN ? [] : [[zoneBin, './server/zone']]), [botsBin, './tools/bots']]) {
    const r = spawnSync('go', ['build', '-o', out, pkg], { cwd: root, env: env(), encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`go build ${pkg}: ${r.stderr}`);
  }
  step(`built ${path.basename(zoneBin)}${ZONE_BIN ? ' (prebuilt)' : ''}, ${path.basename(botsBin)}`);

  const worldId = `wp19-s1-${RUN}`;
  const [cx, cz] = CENTER.split(',').map(Number);
  const zone = start('zone', zoneBin, [], {
    GOMAXPROCS: PROCS,
    LODESTONE_ZONE_PORT: String(PORT),
    LODESTONE_ZONE_ID: `wp19-zone-${RUN}`,
    LODESTONE_WORLD_ID: worldId,
    LODESTONE_WORLD_SEED: '20261108',
    LODESTONE_GEN_VERSION: 'dev',
    LODESTONE_ZONE_NO_DB: '1',
    LODESTONE_ZONE_NO_REDIS: '1',
    LODESTONE_ZONE_EARSHOT: '0',
    LODESTONE_ZONE_WT_ADDR: 'off',
    LODESTONE_ZONE_DEV_SPAWN: '1',
    LODESTONE_ZONE_DEV_COMBAT: '1',
    LODESTONE_ZONE_MAX_PLAYERS: String(BOTS + 50),
    LODESTONE_ZONE_DEBUG_HORDE: `${cx},${cz},${RADIUS},${ENEMIES}`,
    LODESTONE_ZONE_DEBUG_RAIN: '0',
    LODESTONE_ZONE_PPROF: PPROF ? '1' : '0',
  });
  const zoneExit = new Promise((r) => zone.on('exit', (code) => r(code)));
  pin(zone, ZONE_AFFINITY, 'zone');
  if (!(await waitHttp(`http://127.0.0.1:${PORT}/healthz`, 120000))) throw new Error('zone not healthy');
  step(`zone on :${PORT} (world ${worldId})`);

  let url = `ws://127.0.0.1:${PORT}/ws`;
  if (PROFILE !== 'clean') {
    const proxyPort = PORT + 1;
    start('netsim', process.execPath, [path.join(root, 'tools/netsim/proxy.mjs'), '--profile', PROFILE, '--listen', String(proxyPort), '--target', `ws://127.0.0.1:${PORT}`]);
    if (!(await waitHttp(`http://127.0.0.1:${proxyPort}/config`, 15000))) throw new Error('netsim not up');
    url = `ws://127.0.0.1:${proxyPort}/ws`;
    step(`netsim "${PROFILE}" on :${proxyPort}`);
  }

  const out = path.join(TMP, 'bots.json');
  const prom = path.join(TMP, 'zone.prom');
  const bots = start('bots', botsBin, ['-url', url, '-metrics', `http://127.0.0.1:${PORT}/metrics`, '-n', String(BOTS), '-mode', 'clustered', '-center', CENTER, '-radius', String(RADIUS),
    '-duration', DURATION, '-ramp', `${Math.max(10, Math.round(BOTS / 20))}s`, '-warmup', '30s', '-tick-budget', '12', '-json', out, '-metrics-out', prom], {});
  const botsDone = new Promise((r) => bots.on('exit', (code) => r(code)));
  pin(bots, BOTS_AFFINITY, 'bots');
  step('bots started');

  const t0 = Date.now();
  let done = false;
  botsDone.then(() => { done = true; });
  // --pprof: a short mid-run CPU profile (diagnostic only: on Windows Go's
  // profiler once crashed a zone unwinding wazero JIT frames, WP16).
  if (PPROF) {
    (async () => {
      await sleep(90000);
      const buf = Buffer.from(await (await fetch(`http://127.0.0.1:${PORT}/debug/pprof/profile?seconds=10`)).arrayBuffer());
      const prof = path.join(TMP, 'cpu.pprof');
      fs.writeFileSync(prof, buf);
      const top = spawnSync('go', ['tool', 'pprof', '-top', '-cum', '-nodecount=60', zoneBin, prof], { cwd: root, env: env(), encoding: 'utf8' }).stdout;
      fs.writeFileSync(path.join(EVIDENCE, `${PREFIX}-s1-${TAG}-cpu.txt`), `CPU profile, 10 s at t=90 s, zone with ${BOTS} bots + ${ENEMIES} enemies (GOMAXPROCS=${PROCS})\n\n${top}`);
      step(`cpu profile saved (${prof})`);
    })().catch((e) => step(`profile failed: ${e}`));
  }
  while (!done) {
    await sleep(5000);
    // Enemy counts from /metrics (zone_combat_awake/_enemies, every 10 s):
    // /debug/combat would make the zone build its debug snapshot every second.
    const [ts, prom] = await Promise.all([getJSON(`http://127.0.0.1:${PORT}/debug/tickstats`), fetch(`http://127.0.0.1:${PORT}/metrics`).then((r) => r.text()).catch(() => '')]);
    if (!ts) continue;
    const metric = (name) => Number((new RegExp(`^${name} (\\S+)`, 'm').exec(prom) ?? [])[1] ?? 0);
    const awake = metric('zone_combat_awake');
    const w = ts.tick.windowTickMs;
    const row = { s: Math.round((Date.now() - t0) / 1000), players: ts.players, enemies: metric('zone_combat_enemies'), awake, p50: w.p50, p99: w.p99, max: w.max, overruns: ts.tick.overruns };
    series.push(row);
    if (ts.phases && ts.players >= BOTS * 0.98) lastPhases = ts.phases;
    console.log(`  t=${row.s}s players ${row.players} enemies ${row.enemies} awake ${awake} tick p50 ${w.p50?.toFixed(2)} p99 ${w.p99?.toFixed(2)} max ${w.max?.toFixed(1)}`);
  }
  const code = await botsDone;
  step(`bots exited ${code}`);
  const summaryTxt = fs.readFileSync(path.join(TMP, 'bots.log'), 'utf8');
  const sumStart = summaryTxt.indexOf('== bots:');
  lines.push('', '---- bots summary ----', summaryTxt.slice(sumStart >= 0 ? sumStart : 0).trim(), '');

  // Steady state = samples after the bots' warmup with every bot in.
  const steady = series.filter((r) => r.players >= BOTS * 0.98 && r.s >= 60);
  const worst = steady.reduce((m, r) => (r.p99 > (m?.p99 ?? -1) ? r : m), null);
  const minAwake = steady.reduce((m, r) => Math.min(m, r.awake), Infinity);
  lines.push('---- zone tick, 60 s windows sampled every 5 s (steady state: all bots in, t >= 60 s) ----');
  for (const r of series) lines.push(`t=${String(r.s).padStart(4)}s players ${r.players} enemies ${r.enemies} awake ${r.awake} | tick p50 ${r.p50?.toFixed(2)} p99 ${r.p99?.toFixed(2)} max ${r.max?.toFixed(1)} ms`);
  if (worst) step(`steady state: worst 60 s window tick p99 ${worst.p99.toFixed(2)} ms (budget 12), min awake enemies ${minAwake}, samples ${steady.length}`);
  const summary = JSON.parse(fs.readFileSync(out, 'utf8'));
  if (lastPhases) {
    lines.push('', '---- tick phases, last minute before the end (ms) ----', JSON.stringify(lastPhases));
    step(`tick phases mean ${JSON.stringify(lastPhases.meanMs)} slowest tick ${JSON.stringify(lastPhases.slowestTickMs)}`);
  }
  const result = { phases: lastPhases, tag: TAG, bots: BOTS, enemies: ENEMIES, profile: PROFILE, center: CENTER, radius: RADIUS, procs: PROCS, duration: DURATION, series, steadyWorstP99: worst?.p99 ?? null, minAwake, bots_summary: summary };
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE, `${PREFIX}-s1-${TAG}.json`), JSON.stringify(result, null, 1));
  fs.copyFileSync(prom, path.join(EVIDENCE, `${PREFIX}-s1-${TAG}.prom`));
  const tickOK = worst && worst.p99 <= 12;
  const downOK = summary.downKbps?.max <= 160;
  step(`verdict: tick p99 ${tickOK ? 'PASS' : 'FAIL'} (${worst?.p99?.toFixed(2)} ms), downlink max ${downOK ? 'PASS' : 'FAIL'} (${summary.downKbps?.max?.toFixed(1)} kbps, budget 160), awake >= 2000: ${minAwake >= ENEMIES * 0.95 ? 'yes' : 'no'} (${minAwake})`);
  exitCode = tickOK && downOK ? 0 : 3;
  killTree(zone);
  await Promise.race([zoneExit, sleep(5000)]);
} catch (e) {
  step(`ERROR ${e.stack ?? e}`);
} finally {
  for (const c of children.reverse()) killTree(c);
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE, `${PREFIX}-s1-${TAG}.txt`), lines.join('\n') + '\n');
  console.log(`logs in ${TMP}`);
  process.exit(exitCode);
}
