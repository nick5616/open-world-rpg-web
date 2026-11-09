#!/usr/bin/env node
// WP16 acceptance: spec 14 soak scenario 2 ("1,000 bots across the world
// with continuous zone crossings: no dropped players, no duplicated items"),
// optionally under the "thailand" netsim profile (scenario 4), with a zone
// killed mid-run (spec 13 failover).
//
// Real processes: a director (region assigner), N zone binaries in cluster
// mode (one primary + pool zones; the director splits the regions), the
// shared Redis, a scratch Postgres database (lodestone_wp04_wp16*, minted
// official world, one character row per bot), one netsim proxy per zone
// with --profile, and the bots (tools/bots -cluster ... -mode cross).
//
//   node tools/bots/handoff-soak.mjs --bots 1000 --zones 3 --duration 10m
//   node tools/bots/handoff-soak.mjs --bots 1000 --zones 3 --duration 6m --profile thailand --kill-after 3m --tag thailand-failover
//   node tools/bots/handoff-soak.mjs ... --bin-dir bin --zone-host 10.128.0.5 --infra-host 10.128.0.6 --zone-cpus "0,1,8,9;2,3,10,11;..."
//     (G5: prebuilt Linux binaries, the zones on a dedicated machine over
//      ssh, each pinned to its own 4 vCPUs; director, Postgres, Redis,
//      netsim and bots stay here. See tools/soak/linux/README.md.)
//
// Evidence: docs/evidence/wp16-soak-<tag>.txt|json (+ zone logs tail).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env, killTree, root, waitHttp } from '../../scripts/lib.mjs';
import { describeHost, remoteCommand, remoteKill } from './remote.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const BOTS = Number(arg('bots', '1000'));
const ZONES = Number(arg('zones', '3'));
const DURATION = arg('duration', '10m');
const PROFILE = arg('profile', 'clean');
const KILL_AFTER = arg('kill-after', ''); // e.g. 3m: hard-kill one pool zone then
// Opt-in: on Windows, Go's CPU profiler can crash a process that runs
// wazero-compiled code (runtime.sigprof unwinding JIT frames: seen once in
// a 1,000-bot run), so a profile run is a diagnostic run, not an acceptance run.
const CPU_PROFILE = process.argv.includes('--cpu-profile');
const TAG = arg('tag', `${BOTS}-${ZONES}z-${PROFILE}${KILL_AFTER ? '-failover' : ''}`);
const BASE_PORT = Number(arg('base-port', '18300'));
const EXE = process.platform === 'win32' ? '.exe' : '';
// WP19: unique binary names per run (the machine is shared; tools that look
// at process names never confuse two runs), an optional prebuilt zone binary
// (e.g. a baseline build) and the evidence file prefix.
const RUN = `${Date.now().toString(36)}${process.pid}`;
const ZONE_BIN = arg('zone-bin', '');
const PREFIX = arg('evidence-prefix', 'wp16-soak');
// G5 (tools/soak/linux/README.md): --bin-dir holds prebuilt director, zone,
// bots, seedbots, mintworld and devdb (no go build / go run); --zone-host
// runs the zones on that machine over ssh (same layout under --remote-dir),
// reaching this machine's Postgres and Redis at --infra-host; --zone-cpus
// "a;b;c;d" pins zone i with taskset -c (Linux) and sets its GOMAXPROCS.
const BIN_DIR = arg('bin-dir', '');
const ZONE_HOST = arg('zone-host', '');
const REMOTE_DIR = arg('remote-dir', root);
const INFRA_HOST = arg('infra-host', '');
const ZONE_CPUS = arg('zone-cpus', '').split(';').filter(Boolean);
const ZONE_ADDR = ZONE_HOST || '127.0.0.1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-wp16-'));
const bin = (name) => (name === 'zone' && ZONE_BIN ? ZONE_BIN : BIN_DIR ? path.join(BIN_DIR, `${name}${EXE}`) : path.join(TMP, `soak-${name}-${RUN}${EXE}`));
const DB = `lodestone_wp04_wp16${arg('db', 'soak')}`;
const EVIDENCE = path.join(root, 'docs', 'evidence');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseDur = (s) => {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(s);
  if (!m) throw new Error(`bad duration ${s}`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60000 }[m[2]];
};

const lines = [];
function step(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  lines.push(line);
}

function go(args, extra = {}, input) {
  const r = spawnSync('go', args, { cwd: root, env: env(extra), encoding: 'utf8', input, maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`go ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

const children = [];
function start(name, cmd, args, extra) {
  const out = fs.createWriteStream(path.join(TMP, `${name}.log`));
  const child = spawn(cmd, args, { cwd: root, env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  child.name = name;
  children.push(child);
  return child;
}

let exitCode = 1;
const zones = [];
// devdb from --bin-dir (same arguments as `go run ./server/account/cmd/devdb`).
function devdb(cmd) {
  const r = spawnSync(bin('devdb'), [cmd, DB], { cwd: root, env: env(), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`devdb ${cmd} ${DB} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
try {
  step(`WP16 soak "${TAG}": ${BOTS} bots, ${ZONES} zones, ${DURATION}, netsim ${PROFILE}${KILL_AFTER ? `, kill a pool zone after ${KILL_AFTER}` : ''}`);
  const ports = { director: BASE_PORT };
  for (const [name, p] of Object.entries(ports)) {
    if (await fetch(`http://127.0.0.1:${p}/`).then(() => true, () => false)) throw new Error(`port ${p} (${name}) busy`);
  }
  if (ZONE_HOST) step(`zone machine ${ZONE_HOST}: ${describeHost(ZONE_HOST)}; this machine: ${os.cpus().length} vCPUs (${os.cpus()[0].model}), load avg ${os.loadavg().map((l) => l.toFixed(2)).join(' ')}`);
  const pgUrl = (BIN_DIR ? devdb('create') : go(['run', './server/account/cmd/devdb', 'create', DB])).trim().split('\n').pop();
  step(`scratch database ${DB}`);
  for (const [name, pkg] of [['director', './server/director'], ['zone', './server/zone'], ['bots', './tools/bots'], ['seedbots', './tools/bots/cmd/seedbots'], ['mintworld', './server/pkg/cmd/mintworld']]) {
    if ((name === 'zone' && ZONE_BIN) || BIN_DIR) continue;
    go(['build', '-o', bin(name), pkg]);
  }
  step(`${BIN_DIR ? `prebuilt (${BIN_DIR})` : 'built'} director, zone, bots, seedbots, mintworld`);
  const dbEnv = { LODESTONE_PG_URL: pgUrl };
  // Remote zones reach this machine's Postgres and Redis by its address.
  const zoneDbEnv = { ...dbEnv };
  if (INFRA_HOST) {
    const u = new URL(pgUrl);
    u.hostname = INFRA_HOST;
    zoneDbEnv.LODESTONE_PG_URL = u.toString();
    zoneDbEnv.LODESTONE_REDIS_ADDR = `${INFRA_HOST}:${(process.env.LODESTONE_REDIS_ADDR ?? '127.0.0.1:56379').split(':').pop()}`;
  }
  step(spawnSync(bin('mintworld'), ['-official'], { cwd: root, env: env(dbEnv), encoding: 'utf8' }).stdout.trim().split('\n').pop());
  const chars = spawnSync(bin('bots'), ['-print-characters', '-n', String(BOTS)], { cwd: root, env: env(), encoding: 'utf8', maxBuffer: 64 << 20 }).stdout;
  const seeded = spawnSync(bin('seedbots'), [], { cwd: root, env: env(dbEnv), input: chars, encoding: 'utf8' }).stdout.trim();
  step(seeded);
  // WP19b: our director owns this world's region assignment from the start.
  // On shared infra a long-running dev director scans the same Redis and,
  // if it takes the world's lease first, assigns with ITS code (no load
  // moves): start ours before the zones, dedicated to this world.
  const worldID = (/world ([0-9a-f-]{36})/.exec(seeded) ?? [])[1];
  if (!worldID) throw new Error(`no world id in seedbots output: ${seeded}`);
  start('director', bin('director'), [], { ...dbEnv, LODESTONE_DIRECTOR_PORT: String(ports.director), LODESTONE_DIRECTOR_ASSIGN_EVERY: '1s', LODESTONE_DIRECTOR_ONLY_WORLD: worldID });
  if (!(await waitHttp(`http://127.0.0.1:${ports.director}/healthz`, 30000))) throw new Error('director not healthy');
  step(`director (assigner, world ${worldID}) on :${ports.director}`);

  for (let i = 0; i < ZONES; i++) {
    const id = i === 0 ? 'zone-primary' : `zone-pool-${i}`;
    const port = BASE_PORT + 10 + i * 2;
    const proxyPort = port + 1;
    const z = { id, port, proxyPort, debug: `http://${ZONE_ADDR}:${port}` };
    let publicWs = `ws://${ZONE_ADDR}:${port}/ws`;
    if (PROFILE !== 'clean') {
      start(`netsim-${id}`, process.execPath, [path.join(root, 'tools/netsim/proxy.mjs'), '--profile', PROFILE, '--listen', String(proxyPort), '--target', `ws://${ZONE_ADDR}:${port}`]);
      if (!(await waitHttp(`http://127.0.0.1:${proxyPort}/config`, 15000))) throw new Error(`netsim for ${id} not up`);
      publicWs = `ws://127.0.0.1:${proxyPort}/ws`;
    }
    const zoneEnv = {
      ...zoneDbEnv,
      LODESTONE_ZONE_PORT: String(port),
      LODESTONE_ZONE_ID: id,
      LODESTONE_ZONE_ROLE: i === 0 ? 'primary' : 'pool',
      LODESTONE_ZONE_PUBLIC_URL: publicWs,
      LODESTONE_ZONE_WT_ADDR: 'off', // bots speak WebSocket
      LODESTONE_ZONE_DEV_SPAWN: '1',
      LODESTONE_ZONE_MAX_PLAYERS: '1200',
      LODESTONE_ZONE_EARSHOT: '0',
      LODESTONE_ZONE_DEBUG_URL: z.debug,
      LODESTONE_ZONE_PPROF: CPU_PROFILE ? '1' : '0', // --cpu-profile: a mid-run profile of the busiest zone
    };
    if (ZONE_CPUS[i]) zoneEnv.GOMAXPROCS = String(ZONE_CPUS[i].split(',').length);
    if (ZONE_HOST) {
      z.remoteName = `lodestone-soak-${id}-${RUN}`;
      z.child = start(id, ...remoteCommand(ZONE_HOST, REMOTE_DIR, bin('zone'), z.remoteName, zoneEnv, ZONE_CPUS[i]), {});
    } else if (ZONE_CPUS[i] && process.platform === 'linux') {
      z.child = start(id, 'taskset', ['-c', ZONE_CPUS[i], bin('zone')], zoneEnv);
    } else {
      z.child = start(id, bin('zone'), [], zoneEnv);
    }
    if (!(await waitHttp(`${z.debug}/healthz`, 60000))) throw new Error(`${id} not healthy`);
    zones.push(z);
    step(`${id} on ${ZONE_HOST}:${port}${ZONE_CPUS[i] ? ` (CPUs ${ZONE_CPUS[i]})` : ''}${PROFILE !== 'clean' ? ` behind netsim "${PROFILE}" :${proxyPort}` : ''}`);
  }
  // Wait for the director's split to reach every zone.
  let owners;
  for (let t = 0; t < 60; t++) {
    const d = await (await fetch(`${zones[0].debug}/debug/cluster`)).json();
    owners = d.owners;
    const ids = new Set(owners.flat());
    if (ids.size === ZONES && !ids.has('')) break;
    await sleep(500);
  }
  step(`region owners (x-major rows): ${JSON.stringify(owners)}`);

  const seeds = zones.map((z) => z.debug).join(',');
  const out = path.join(TMP, 'bots.json');
  const bots = start('bots', bin('bots'), ['-url', `ws://${ZONE_ADDR}:${zones[0].port}/ws`, '-cluster', seeds, '-mode', 'cross', '-n', String(BOTS), '-duration', DURATION, '-ramp', `${Math.max(4, Math.round(BOTS / 40))}s`, '-warmup', '20s', '-json', out], {});
  const botsDone = new Promise((r) => bots.on('exit', (code) => r(code)));
  step(`bots started (${BOTS}, cross mode)`);

  // Mid-run CPU profile of the busiest zone (where does the tick go?).
  const profileAt = Math.min(parseDur(DURATION) / 2, KILL_AFTER ? parseDur(KILL_AFTER) - 30000 : Infinity);
  const profiling = (async () => {
    if (!CPU_PROFILE) return;
    await sleep(Math.max(30000, profileAt));
    let best = null;
    for (const z of zones) {
      const d = await (await fetch(`${z.debug}/debug/cluster`)).json().catch(() => null);
      if (d && (!best || d.view.characters.length > best.n)) best = { z, n: d.view.characters.length };
    }
    if (!best) return;
    const prof = path.join(TMP, 'cpu.pprof');
    const buf = Buffer.from(await (await fetch(`${best.z.debug}/debug/pprof/profile?seconds=20`)).arrayBuffer());
    fs.writeFileSync(prof, buf);
    const top = spawnSync('go', ['tool', 'pprof', '-top', '-nodecount=40', bin('zone'), prof], { cwd: root, env: env(), encoding: 'utf8' }).stdout;
    fs.writeFileSync(path.join(EVIDENCE, `${PREFIX}-${TAG}-cpu-${best.z.id}.txt`), `CPU profile, 20 s, ${best.z.id} with ${best.n} players

${top}`);
    step(`cpu profile of ${best.z.id} (${best.n} players) saved`);
  })().catch((e) => step(`profile failed: ${e}`));

  if (KILL_AFTER) {
    await sleep(parseDur(KILL_AFTER));
    const victim = zones[zones.length - 1];
    const before = await fetch(`${victim.debug}/debug/cluster`).then((r) => r.json()).catch(() => null);
    step(`HARD KILL ${victim.id} (owned ${before?.view?.characters?.length ?? '?'} players): simulating a reclaimed spot VM`);
    // A hard kill: SIGKILL, no graceful shutdown (killTree is taskkill /F on
    // Windows but SIGTERM elsewhere, which would flush the write-behind queue).
    if (victim.remoteName) remoteKill(ZONE_HOST, victim.remoteName, 'KILL');
    else if (process.platform === 'win32') killTree(victim.child);
    else victim.child.kill('SIGKILL');
    victim.killedAt = Date.now();
    for (let t = 0; t < 40; t++) {
      await sleep(500);
      const d = await fetch(`${zones[0].debug}/debug/cluster`).then((r) => r.json()).catch(() => null);
      if (d && !d.owners.flat().includes(victim.id)) {
        step(`failover: ${victim.id}'s regions owned by others after ${((Date.now() - victim.killedAt) / 1000).toFixed(1)} s: ${JSON.stringify(d.owners)}`);
        break;
      }
    }
  }
  const code = await botsDone;
  await profiling;
  step(`bots exited ${code}`);
  const summaryTxt = fs.readFileSync(path.join(TMP, 'bots.log'), 'utf8');
  const sumStart = summaryTxt.indexOf('== bots:');
  lines.push('', '---- bots summary ----', summaryTxt.slice(sumStart >= 0 ? sumStart : 0).trim());
  for (const z of zones) {
    const log = fs.readFileSync(path.join(TMP, `${z.id}.log`), 'utf8').split('\n');
    const counts = { handoffOut: 0, handoffIn: 0, released: 0, lost: 0, errors: 0 };
    for (const l of log) {
      if (l.includes('"handoff out"')) counts.handoffOut++;
      if (l.includes('"handoff in"')) counts.handoffIn++;
      if (l.includes('released to another zone')) counts.released++;
      if (l.includes('handoff state missing')) counts.lost++;
      if (l.includes('"level":"ERROR"')) counts.errors++;
    }
    lines.push(`zone log ${z.id}: ${JSON.stringify(counts)}`);
  }
  // WP19b: the director's load moves (zoneregistry.Rebalance), in order.
  const dlog = fs.readFileSync(path.join(TMP, 'director.log'), 'utf8').split('\n').filter((l) => l.includes('region moved for load'));
  lines.push(`director load moves: ${dlog.length}`);
  for (const l of dlog) {
    try {
      const j = JSON.parse(l);
      lines.push(`  ${j.time} ${j.move}`);
    } catch {
      lines.push(`  ${l.slice(0, 200)}`);
    }
  }
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.copyFileSync(out, path.join(EVIDENCE, `${PREFIX}-${TAG}.json`));
  exitCode = code === 0 ? 0 : 1;
  step(exitCode === 0 ? 'SOAK PASS' : 'SOAK FAIL');
} catch (e) {
  step(`ERROR ${e.stack ?? e}`);
} finally {
  for (const z of zones) if (z.remoteName) remoteKill(ZONE_HOST, z.remoteName, 'KILL');
  for (const c of children.reverse()) killTree(c);
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE, `${PREFIX}-${TAG}.txt`), lines.join('\n') + '\n');
  try {
    if (BIN_DIR) devdb('drop');
    else go(['run', './server/account/cmd/devdb', 'drop', DB]);
  } catch {}
  console.log(`logs in ${TMP}`);
  process.exit(exitCode);
}
