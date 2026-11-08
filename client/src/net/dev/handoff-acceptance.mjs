#!/usr/bin/env node
// WP16 acceptance (two headless browsers): two players walk side by side
// across a border between two zone processes and back, under the "thailand"
// netsim profile, and we check that the switch is invisible: zero local
// reconciliation corrections, zero remote teleports, each player continuously
// visible to the other, and the ownership switch actually happening (both
// directions). Optionally (--failover) the zone owning them is then killed
// and the browsers must reconnect on their own to the survivor.
//
// Real processes: account, director (region assigner), two zone binaries in
// cluster mode (primary + pool; the director gives the pool zone x < 2048),
// one netsim proxy per zone (the zones announce the proxies, so every
// connection, standby ones included, is impaired), Vite, two Chromium
// processes. Scratch database, shared Redis, private ports.
//
//   node client/src/net/dev/handoff-acceptance.mjs [--profile thailand] [--failover]
//
// Evidence: docs/evidence/wp16-border-browsers.txt|json, wp16-border-*.png,
// and with --failover wp16-failover-browsers.txt|json.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { env, killTree, root, waitHttp } from '../../../../scripts/lib.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const PROFILE = arg('profile', 'thailand');
const FAILOVER = process.argv.includes('--failover');
const EVIDENCE = path.join(root, 'docs', 'evidence');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-wp16e2e-'));
const DB = 'lodestone_wp04_wp16e2e';
const PORT = { account: 18391, director: 18390, zoneA: 18392, proxyA: 18393, zoneB: 18396, proxyB: 18397, vite: 5193 };
const EXE = process.platform === 'win32' ? '.exe' : '';
const BORDER_X = 2048;
const OUT = FAILOVER ? 'wp16-failover-browsers' : 'wp16-border-browsers';

fs.mkdirSync(EVIDENCE, { recursive: true });
const lines = [];
function step(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  lines.push(line);
}
const failures = [];
function check(cond, msg, detail) {
  const d = detail === undefined ? '' : '  ' + JSON.stringify(detail);
  if (!cond) failures.push(msg);
  step(`${cond ? 'PASS' : 'FAIL'} ${msg}${d}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function goSync(args, extra = {}) {
  const r = spawnSync('go', args, { cwd: root, env: env(extra), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`go ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
function runBin(name, args, extra = {}) {
  const r = spawnSync(path.join(TMP, name + EXE), args, { cwd: root, env: env(extra), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${name} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout.trim();
}
const children = [];
function start(name, cmd, args, extra, cwd = root) {
  const out = fs.createWriteStream(path.join(TMP, `${name}.log`));
  const child = spawn(cmd, args, { cwd, env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  children.push(child);
  return child;
}

async function signIn(page, user, charName) {
  await page.getByTestId('auth-dev-username').waitFor({ timeout: 90000 });
  await page.getByTestId('auth-dev-username').fill(user);
  await page.getByTestId('auth-dev-submit').click();
  await page.getByTestId('char-name').waitFor();
  if ((await page.getByTestId(`play-${charName}`).count()) === 0) {
    await page.getByTestId('char-name').fill(charName);
    await page.getByTestId('char-create').click();
  }
  await page.getByTestId(`play-${charName}`).waitFor();
}
async function play(page, charName) {
  await page.getByTestId(`play-${charName}`).click();
  await page.waitForFunction(() => window.__lodestone?.netDebug?.()?.phase === 'playing', null, { timeout: 60000 });
}
const debug = (page) => page.evaluate(() => window.__lodestone.netDebug());
const player = (page) => page.evaluate(() => window.__lodestone.player());

function counters(d) {
  return { reconciles: d.prediction.reconciles, logLen: d.prediction.log.length, teleports: d.interp.teleports, visibleJumps: d.interp.visibleJumps, extrapEvents: d.interp.extrapEvents, transfers: d.transfers.length };
}

/** Both hold W along yaw for ms, sampling visibility of each other every 150 ms. */
async function walkTogether(a, b, yaw, ms, samples) {
  await a.evaluate((y) => window.__lodestone.setLook(y, 0), yaw);
  await b.evaluate((y) => window.__lodestone.setLook(y, 0), yaw);
  await Promise.all([a.keyboard.down('KeyW'), b.keyboard.down('KeyW')]);
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const [s] = await Promise.all([sample(a, b), sleep(150)]);
    samples.push(s);
  }
  await Promise.all([a.keyboard.up('KeyW'), b.keyboard.up('KeyW')]);
}

async function sample(a, b) {
  const one = (page, other) =>
    page.evaluate((name) => {
      const d = window.__lodestone.netDebug();
      const me = window.__lodestone.player();
      const o = d.remotes.find((r) => r.name === name);
      return { zone: d.zoneId, x: me.pos.x, z: me.pos.z, sees: !!o, dist: o ? Math.hypot(o.x - me.pos.x, o.z - me.pos.z) : null, standby: d.standby };
    }, other);
  const [sa, sb] = await Promise.all([one(a, 'Bruno'), one(b, 'Alyssa')]);
  return { t: Date.now(), A: sa, B: sb };
}

let browsers = [];
try {
  step(`WP16 border acceptance: profile ${PROFILE}${FAILOVER ? ', then failover' : ''}`);
  for (const [name, port] of Object.entries(PORT)) {
    if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) throw new Error(`port ${port} (${name}) is already in use`);
  }
  const pgUrl = goSync(['run', './server/account/cmd/devdb', 'create', DB]).trim().split('\n').pop();
  step(`scratch database ${DB}`);
  for (const [name, pkg] of [['account', './server/account'], ['director', './server/director'], ['zone', './server/zone'], ['bots', './tools/bots'], ['seedbots', './tools/bots/cmd/seedbots']]) goSync(['build', '-o', path.join(TMP, name + EXE), pkg]);
  step('built account, director, zone, bots, seedbots');
  const svcEnv = { LODESTONE_PG_URL: pgUrl, LODESTONE_ACCOUNT_PORT: String(PORT.account), LODESTONE_DIRECTOR_PORT: String(PORT.director), LODESTONE_DEV_AUTH: '1', LODESTONE_CORS_ORIGIN: '*', LODESTONE_DIRECTOR_ASSIGN_EVERY: '1s' };
  start('account', path.join(TMP, 'account' + EXE), [], svcEnv);
  check(await waitHttp(`http://127.0.0.1:${PORT.account}/healthz`, 60000), `account healthy on :${PORT.account} (mints the official world)`);
  start('director', path.join(TMP, 'director' + EXE), [], svcEnv);
  check(await waitHttp(`http://127.0.0.1:${PORT.director}/healthz`, 30000), `director healthy on :${PORT.director}`);
  const zones = {};
  for (const [id, port, proxy, role] of [['zone-east', PORT.zoneA, PORT.proxyA, 'primary'], ['zone-west', PORT.zoneB, PORT.proxyB, 'pool']]) {
    start(`netsim-${id}`, process.execPath, [path.join(root, 'tools/netsim/proxy.mjs'), '--profile', PROFILE, '--listen', String(proxy), '--target', `ws://127.0.0.1:${port}`]);
    check(await waitHttp(`http://127.0.0.1:${proxy}/config`, 15000), `netsim "${PROFILE}" in front of ${id} on :${proxy}`);
    zones[id] = { port, child: start(id, path.join(TMP, 'zone' + EXE), [], {
      ...svcEnv,
      LODESTONE_ZONE_PORT: String(port),
      LODESTONE_ZONE_ID: id,
      LODESTONE_ZONE_ROLE: role,
      LODESTONE_ZONE_WT_ADDR: 'off',
      LODESTONE_ZONE_PUBLIC_URL: `ws://127.0.0.1:${proxy}/ws`,
      LODESTONE_ZONE_DEBUG_URL: `http://127.0.0.1:${port}`,
    }) };
    check(await waitHttp(`http://127.0.0.1:${port}/healthz`, 60000), `${id} (${role}) healthy on :${port}`);
  }
  let owners;
  for (let t = 0; t < 40; t++) {
    owners = (await (await fetch(`http://127.0.0.1:${PORT.zoneA}/debug/cluster`)).json()).owners;
    if (owners[1][0] === 'zone-west' && owners[2][0] === 'zone-east') break;
    await sleep(500);
  }
  check(owners[1][0] === 'zone-west' && owners[2][0] === 'zone-east', 'director assigned x < 2048 to zone-west, the rest stays with zone-east (primary)', owners);
  const crossing = JSON.parse(runBin('bots', ['-url', `ws://127.0.0.1:${PORT.zoneA}/ws`, '-terrain', 'on', '-find-border', String(BORDER_X)]));
  step(`walkable crossing of x = ${BORDER_X}: ${JSON.stringify(crossing)}`);
  start('vite', process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT.vite), '--strictPort'], { VITE_ACCOUNT_URL: `http://127.0.0.1:${PORT.account}`, VITE_DIRECTOR_URL: `http://127.0.0.1:${PORT.director}`, VITE_SOLO: '0' }, path.join(root, 'client'));
  check(await waitHttp(`http://127.0.0.1:${PORT.vite}/`, 60000), `vite on :${PORT.vite}`);

  const consoleLog = [];
  browsers = [await chromium.launch(), await chromium.launch()];
  const pages = [];
  for (const [i, br] of browsers.entries()) {
    const ctx = await br.newContext({ viewport: { width: 960, height: 600 } });
    const page = await ctx.newPage();
    const label = i === 0 ? 'A' : 'B';
    page.on('console', (m) => consoleLog.push(`[${label}] ${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => consoleLog.push(`[${label}] pageerror: ${e.message}`));
    await page.goto(`http://127.0.0.1:${PORT.vite}/?debug=1&autoplay=1&transport=ws`);
    pages.push(page);
  }
  const [a, b] = pages;
  await Promise.all([signIn(a, 'wp16alice', 'Alyssa'), signIn(b, 'wp16bruno', 'Bruno')]);
  // Place both 25 m west of the line, 4 m apart, on the walkable crossing.
  const sx = BORDER_X - 25;
  step(runBin('seedbots', ['-move', `Alyssa:${sx},${crossing.z};Bruno:${sx},${crossing.z + 4}`], { LODESTONE_PG_URL: pgUrl }).replace(/\n/g, ' | '));
  await Promise.all([play(a, 'Alyssa'), play(b, 'Bruno')]);
  await sleep(4000); // clock sync, jitter window, first pre-connects
  const [da0, db0] = [await debug(a), await debug(b)];
  check(da0.zoneId === 'zone-west' && db0.zoneId === 'zone-west', 'both start on zone-west (the director routed them by region)', { A: da0.zoneId, B: db0.zoneId });
  check(da0.standby.includes('zone-east') && db0.standby.includes('zone-east'), 'both pre-connected to zone-east (within the 64 m ghost band)', { A: da0.standby, B: db0.standby });
  await a.screenshot({ path: path.join(EVIDENCE, 'wp16-border-start-a.png') });

  const pre = { A: counters(da0), B: counters(db0) };
  const samples = [];
  const t0 = Date.now();
  // East across the line (yaw -pi/2 faces +x), stand, then back west.
  await walkTogether(a, b, -Math.PI / 2, 11000, samples);
  await sleep(1500);
  samples.push(await sample(a, b));
  const mid = [await debug(a), await debug(b)];
  await a.screenshot({ path: path.join(EVIDENCE, 'wp16-border-east-a.png') });
  await walkTogether(a, b, Math.PI / 2, 11000, samples);
  await sleep(1500);
  samples.push(await sample(a, b));
  const walkS = (Date.now() - t0) / 1000;
  const [da, dbb] = [await debug(a), await debug(b)];
  await b.screenshot({ path: path.join(EVIDENCE, 'wp16-border-back-b.png') });
  const post = { A: counters(da), B: counters(dbb) };
  const corr = (d, p) => d.prediction.log.slice(p.logLen).map((x) => x.magnitude);
  const corrA = corr(da, pre.A);
  const corrB = corr(dbb, pre.B);
  const vis = (k) => samples.filter((s) => s[k].sees).length;
  const result = {
    profile: PROFILE,
    crossing,
    walkSeconds: walkS,
    rttMs: { A: da.rttMs, B: dbb.rttMs },
    zones: { start: [da0.zoneId, db0.zoneId], east: [mid[0].zoneId, mid[1].zoneId], end: [da.zoneId, dbb.zoneId] },
    transfers: { A: da.transfers.slice(pre.A.transfers), B: dbb.transfers.slice(pre.B.transfers) },
    corrections: { A: { count: post.A.reconciles - pre.A.reconciles, maxCm: Math.max(0, ...corrA) * 100 }, B: { count: post.B.reconciles - pre.B.reconciles, maxCm: Math.max(0, ...corrB) * 100 } },
    remote: {
      'A sees B': { teleports: post.A.teleports - pre.A.teleports, visibleJumps: post.A.visibleJumps - pre.A.visibleJumps, extrapEvents: post.A.extrapEvents - pre.A.extrapEvents, maxJumpCm: da.interp.maxJumpM * 100, visibleSamples: vis('A'), samples: samples.length },
      'B sees A': { teleports: post.B.teleports - pre.B.teleports, visibleJumps: post.B.visibleJumps - pre.B.visibleJumps, extrapEvents: post.B.extrapEvents - pre.B.extrapEvents, maxJumpCm: dbb.interp.maxJumpM * 100, visibleSamples: vis('B'), samples: samples.length },
    },
    bandwidthKbps: { A: da.bandwidth, B: dbb.bandwidth },
    stats: { A: da.stats, B: dbb.stats },
    jumps: { 'A sees B': da.interp.jumps, 'B sees A': dbb.interp.jumps },
    samples,
  };
  const handoffs = (t) => t.filter((x) => x.kind === 'handoff');
  check(mid[0].zoneId === 'zone-east' && mid[1].zoneId === 'zone-east', 'after walking east both are owned by zone-east', result.zones.east);
  check(da.zoneId === 'zone-west' && dbb.zoneId === 'zone-west', 'after walking back both are owned by zone-west again', result.zones.end);
  check(handoffs(result.transfers.A).length >= 2 && handoffs(result.transfers.B).length >= 2, 'each browser switched zones at least twice (east, then back west)', { A: result.transfers.A, B: result.transfers.B });
  check(new Set([...result.transfers.A, ...result.transfers.B].map((x) => x.entityId)).size === 2, 'entity ids unchanged across every switch');
  check(result.corrections.A.count === 0 && result.corrections.B.count === 0, 'zero local reconciliation corrections across the border (prediction continuous)', result.corrections);
  check(result.remote['A sees B'].teleports === 0 && result.remote['B sees A'].teleports === 0, 'zero remote teleports');
  check(vis('A') === samples.length && vis('B') === samples.length, 'each player saw the other in every sample while crossing (continuous visibility)', { A: `${vis('A')}/${samples.length}`, B: `${vis('B')}/${samples.length}` });
  step(`remote discontinuities (eased): A sees B ${result.remote['A sees B'].visibleJumps} (max ${result.remote['A sees B'].maxJumpCm.toFixed(1)} cm), B sees A ${result.remote['B sees A'].visibleJumps} (max ${result.remote['B sees A'].maxJumpCm.toFixed(1)} cm)`);
  step(`rtt A ${da.rttMs.toFixed(0)} ms, B ${dbb.rttMs.toFixed(0)} ms; walked ${walkS.toFixed(1)} s; handoff gaps ms A ${handoffs(result.transfers.A).map((x) => x.gapMs.toFixed(0)).join(',')} B ${handoffs(result.transfers.B).map((x) => x.gapMs.toFixed(0)).join(',')}`);

  if (FAILOVER) {
    // Kill zone-west (it owns them now): both browsers must come back on
    // zone-east (primary) from their last checkpoint, without a click.
    const before = [await player(a), await player(b)];
    step('HARD KILL zone-west (the pool zone owning both players)');
    killTree(zones['zone-west'].child);
    const tKill = Date.now();
    let back = false;
    for (let t = 0; t < 120 && !back; t++) {
      await sleep(250);
      const [x, y] = [await debug(a), await debug(b)];
      back = x.zoneId === 'zone-east' && y.zoneId === 'zone-east' && x.stats.failovers >= 1 && y.stats.failovers >= 1 && x.phase === 'playing' && y.phase === 'playing';
    }
    const recoverS = (Date.now() - tKill) / 1000;
    await sleep(2500);
    const [fa, fb] = [await debug(a), await debug(b)];
    const after = [await player(a), await player(b)];
    const overlay = await a.getByTestId('net-ended').count() + (await b.getByTestId('net-ended').count());
    result.failover = { recoverS, A: fa.transfers.filter((x) => x.kind === 'failover'), B: fb.transfers.filter((x) => x.kind === 'failover'), rewindM: before.map((p, i) => Math.hypot(after[i].pos.x - p.pos.x, after[i].pos.z - p.pos.z)), seesEachOther: [fa.remotes.some((r) => r.name === 'Bruno'), fb.remotes.some((r) => r.name === 'Alyssa')] };
    check(back, `both browsers reconnected on their own to zone-east after the kill (${recoverS.toFixed(1)} s)`, result.failover);
    check(overlay === 0, 'no "connection lost" overlay was shown');
    check(result.failover.seesEachOther.every(Boolean), 'they see each other again on the survivor');
    // Walk a little on the survivor: prediction healthy again.
    const preF = [counters(fa), counters(fb)];
    await walkTogether(a, b, 0, 3000, []);
    await sleep(1000);
    const [ga, gb] = [await debug(a), await debug(b)];
    check(ga.prediction.reconciles - preF[0].reconciles === 0 && gb.prediction.reconciles - preF[1].reconciles === 0, 'zero corrections walking on the survivor after the failover');
    await a.screenshot({ path: path.join(EVIDENCE, 'wp16-failover-a.png') });
  }
  fs.writeFileSync(path.join(EVIDENCE, `${OUT}.json`), JSON.stringify(result, null, 2) + '\n');
  const errors = consoleLog.filter((l) => /pageerror/.test(l));
  fs.writeFileSync(path.join(EVIDENCE, `${OUT}-console.txt`), consoleLog.join('\n') + '\n');
  check(errors.length === 0, 'no page errors in either browser', errors.slice(0, 5));
} catch (e) {
  failures.push(String(e));
  step(`ERROR ${e.stack ?? e}`);
} finally {
  for (const br of browsers) await br.close().catch(() => {});
  for (const c of children) killTree(c);
  try {
    goSync(['run', './server/account/cmd/devdb', 'drop', DB]);
    step(`dropped ${DB}`);
  } catch (e) {
    step(`could not drop ${DB}: ${e.message}`);
  }
  step(failures.length ? `FAILED: ${failures.join('; ')}` : 'ALL PASS');
  fs.writeFileSync(path.join(EVIDENCE, `${OUT}.txt`), lines.join('\n') + '\n');
  console.log(`logs in ${TMP}`);
  process.exit(failures.length ? 1 : 0);
}
