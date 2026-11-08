#!/usr/bin/env node
// WP06 acceptance (G2 part, spec 15): two headless browsers sign in with
// dev auth, get tickets from the director, connect to the same zone through
// the "thailand" netsim profile (~160 ms RTT, 3% loss), see each other walk on
// flat ground, and we quantify rubber-banding: the local player's
// reconciliation corrections and the remote player's extrapolation, visible
// jumps and teleports while both walk scripted paths. Runs once per transport:
// WebSocket through the TCP proxy (loss = retransmit stalls) and WebTransport
// through the UDP relay (loss = dropped datagrams).
//
// Real processes: account, director, zone (Go binaries) on a scratch Postgres
// database, the shared Redis, tools/netsim/proxy.mjs, Vite, two Chromium
// instances. Private ports (decision 0006) so a dev stack is left alone.
//
//   node client/src/net/dev/acceptance.mjs [--modes ws,wt] [--profile thailand]
//
// Evidence: docs/evidence/wp06-acceptance.txt, wp06-acceptance-<mode>.json,
// wp06-<mode>-{a,b}.png, wp06-<mode>-walking.png
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
const MODES = arg('modes', 'ws,wt').split(',');
const PROFILE = arg('profile', 'thailand');
const EVIDENCE = path.join(root, 'docs', 'evidence');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-wp06-'));
// devdb (WP04) only creates and drops lodestone_wp04_* scratch databases.
const DB = 'lodestone_wp04_wp06e2e';
const PORT = { account: 18191, director: 18190, zone: 18192, proxyWs: 8095, proxyUdp: 8096, vite: 5191 };
const EXE = process.platform === 'win32' ? '.exe' : '';
const ZONE_ID = 'zone-wp06-e2e';

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

const children = [];
function start(name, cmd, args, extra, cwd = root) {
  const out = fs.createWriteStream(path.join(TMP, `${name}.log`));
  const child = spawn(cmd, args, { cwd, env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  children.push(child);
  return child;
}

async function signInAndPlay(page, user, charName) {
  // Generous: Vite may still be pre-bundling deps on a cold start.
  await page.getByTestId('auth-dev-username').waitFor({ timeout: 90000 });
  await page.getByTestId('auth-dev-username').fill(user);
  await page.getByTestId('auth-dev-submit').click();
  await page.getByTestId('char-name').waitFor();
  if ((await page.getByTestId(`play-${charName}`).count()) === 0) {
    await page.getByTestId('char-name').fill(charName);
    await page.getByTestId('char-create').click();
  }
  await page.getByTestId(`play-${charName}`).click();
  await page.waitForFunction(() => window.__lodestone?.netDebug?.()?.phase === 'playing', null, { timeout: 30000 });
}

const debug = (page) => page.evaluate(() => window.__lodestone.netDebug());
const player = (page) => page.evaluate(() => window.__lodestone.player());

/** Hold W along yaw for ms (keyboard events, like a player; headless has no pointer lock). */
async function walk(page, yaw, ms) {
  await page.evaluate((y) => window.__lodestone.setLook(y, 0), yaw);
  await page.keyboard.down('KeyW');
  await sleep(ms);
  await page.keyboard.up('KeyW');
}

async function walkBoth(a, b, yawA, yawB, ms) {
  await Promise.all([walk(a, yawA, ms), walk(b, yawB, ms)]);
}

/** Face the other player (drawn position) with a slight downward pitch. */
async function faceOther(page, otherName) {
  return page.evaluate((name) => {
    const d = window.__lodestone.netDebug();
    const me = window.__lodestone.player();
    const o = d.remotes.find((r) => r.name === name);
    if (!o) return null;
    const dx = o.x - me.pos.x;
    const dz = o.z - me.pos.z;
    window.__lodestone.setLook(Math.atan2(-dx, -dz), -0.06);
    return { dist: Math.hypot(dx, dz), lod: d.lod[o.id], mode: o.mode, delayMs: o.delayMs };
  }, otherName);
}

function counters(d) {
  return {
    reconciles: d.prediction.reconciles,
    agreements: d.prediction.agreements,
    logLen: d.prediction.log.length,
    extrapEvents: d.interp.extrapEvents,
    extrapFrames: d.interp.extrapFrames,
    frozenFrames: d.interp.frozenFrames,
    interpFrames: d.interp.interpFrames,
    visibleJumps: d.interp.visibleJumps,
    teleports: d.interp.teleports,
  };
}

function diff(after, before) {
  const o = {};
  for (const k of Object.keys(after)) o[k] = after[k] - before[k];
  return o;
}

function pct(arr, q) {
  if (!arr.length) return 0;
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}

let browsers = [];
const summary = [];
try {
  step(`WP06 acceptance: profile ${PROFILE}, modes ${MODES.join(', ')}`);
  // Other agents/dev stacks run on this machine: a port someone else holds
  // would make the health checks pass against the wrong server.
  for (const [name, port] of Object.entries(PORT)) {
    const busy = await fetch(`http://localhost:${port}/`).then(() => true, () => false);
    if (busy) throw new Error(`port ${port} (${name}) is already in use; free it or edit PORT in this script`);
  }
  const pgUrl = goSync(['run', './server/account/cmd/devdb', 'create', DB]).trim().split('\n').pop();
  step(`scratch database ${DB}`);
  for (const [name, pkg] of [['account', './server/account'], ['director', './server/director'], ['zone', './server/zone']]) goSync(['build', '-o', path.join(TMP, name + EXE), pkg]);
  step('built account, director, zone');
  const svcEnv = { LODESTONE_PG_URL: pgUrl, LODESTONE_ACCOUNT_PORT: String(PORT.account), LODESTONE_DIRECTOR_PORT: String(PORT.director), LODESTONE_DEV_AUTH: '1', LODESTONE_CORS_ORIGIN: '*' };
  start('account', path.join(TMP, 'account' + EXE), [], svcEnv);
  check(await waitHttp(`http://localhost:${PORT.account}/healthz`, 30000), `account healthy on :${PORT.account}`);
  start('director', path.join(TMP, 'director' + EXE), [], svcEnv);
  check(await waitHttp(`http://localhost:${PORT.director}/healthz`, 30000), `director healthy on :${PORT.director}`);
  start('netsim', process.execPath, [path.join(root, 'tools/netsim/proxy.mjs'), '--profile', PROFILE, '--listen', String(PORT.proxyWs), '--target', `ws://127.0.0.1:${PORT.zone}`, '--udp-listen', String(PORT.proxyUdp), '--udp-target', `127.0.0.1:${PORT.zone}`]);
  check(await waitHttp(`http://localhost:${PORT.proxyWs}/config`, 15000), `netsim "${PROFILE}" on ws :${PORT.proxyWs} and udp :${PORT.proxyUdp}`);
  step(`netsim config ${await (await fetch(`http://localhost:${PORT.proxyWs}/config`)).text()}`);
  // The zone announces the PROXY's endpoints, so the director routes both
  // browsers through the impairment.
  start('zone', path.join(TMP, 'zone' + EXE), [], {
    ...svcEnv,
    LODESTONE_ZONE_PORT: String(PORT.zone),
    LODESTONE_ZONE_ID: ZONE_ID,
    LODESTONE_ZONE_WT_ADDR: `:${PORT.zone}`,
    LODESTONE_ZONE_PUBLIC_URL: `ws://localhost:${PORT.proxyWs}/ws`,
    LODESTONE_ZONE_WT_PUBLIC_URL: `https://localhost:${PORT.proxyUdp}/wt`,
  });
  check(await waitHttp(`http://localhost:${PORT.zone}/healthz`, 30000), `zone healthy on :${PORT.zone}`);
  const wtInfo = await (await fetch(`http://localhost:${PORT.zone}/debug/wt`)).json();
  step(`zone wtEndpoint ${wtInfo.wtEndpoint}`);
  start('vite', process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT.vite), '--strictPort'], { VITE_ACCOUNT_URL: `http://localhost:${PORT.account}`, VITE_DIRECTOR_URL: `http://localhost:${PORT.director}`, VITE_SOLO: '0' }, path.join(root, 'client'));
  check(await waitHttp(`http://localhost:${PORT.vite}/`, 60000), `vite on :${PORT.vite}`);
  await sleep(6000); // zone registry heartbeat reaches the director

  const consoleLog = [];
  for (const mode of MODES) {
    step(`--- ${mode === 'wt' ? 'WebTransport (UDP relay)' : 'WebSocket (TCP proxy)'} ---`);
    // Two separate browser processes, as two players on two machines.
    browsers = [await chromium.launch(), await chromium.launch()];
    const pages = [];
    for (const [i, br] of browsers.entries()) {
      const label = i === 0 ? 'A' : 'B';
      const ctx = await br.newContext({ viewport: { width: 960, height: 600 } });
      const page = await ctx.newPage();
      page.on('console', (m) => consoleLog.push(`[${mode} ${label}] ${m.type()}: ${m.text()}`));
      page.on('pageerror', (e) => consoleLog.push(`[${mode} ${label}] pageerror: ${e.message}`));
      await page.goto(`http://localhost:${PORT.vite}/?debug=1&autoplay=1&transport=${mode}`);
      pages.push(page);
    }
    const [a, b] = pages;
    await Promise.all([signInAndPlay(a, 'wp06alice', 'Alyssa'), signInAndPlay(b, 'wp06bruno', 'Bruno')]);
    const [da0, db0] = [await debug(a), await debug(b)];
    check(da0.transport === (mode === 'wt' ? 'webtransport' : 'websocket') && db0.transport === da0.transport, `both connected over ${da0.transport}`, { A: da0.attempts, B: db0.attempts });
    await sleep(3000); // clock sync, jitter window

    // Spread out: A walks north, B south (~14 m apart), then both see each other.
    await walkBoth(a, b, 0, Math.PI, 1500);
    await sleep(1500);
    const pre = { A: counters(await debug(a)), B: counters(await debug(b)) };
    const tWalk = Date.now();
    // Scripted walking: both walk a square at walking speed, out of phase
    // (A clockwise, B counter-clockwise), 4 legs of 2 s each, twice.
    // (Screenshots stall SwiftShader for hundreds of ms, so none are taken
    // inside the measured window.)
    for (let lap = 0; lap < 2; lap++) {
      for (let leg = 0; leg < 4; leg++) {
        await walkBoth(a, b, -leg * (Math.PI / 2), Math.PI + leg * (Math.PI / 2), 2000);
      }
    }
    await sleep(1500);
    const walkMs = Date.now() - tWalk;
    const [da, dbb] = [await debug(a), await debug(b)];
    const post = { A: counters(da), B: counters(dbb) };
    const d = { A: diff(post.A, pre.A), B: diff(post.B, pre.B) };
    const corrA = da.prediction.log.slice(pre.A.logLen).map((x) => x.magnitude);
    const corrB = dbb.prediction.log.slice(pre.B.logLen).map((x) => x.magnitude);

    // Screenshots: each faces the other, nameplate in view.
    const fa = await faceOther(a, 'Bruno');
    const fb = await faceOther(b, 'Alyssa');
    await sleep(600);
    await a.screenshot({ path: path.join(EVIDENCE, `wp06-${mode}-a.png`) });
    await b.screenshot({ path: path.join(EVIDENCE, `wp06-${mode}-b.png`) });
    // Activity flags: B jumps; A should draw B airborne (chip on the
    // nameplate) once its interpolation delay has passed.
    await b.keyboard.down('Space');
    await sleep(80);
    await b.keyboard.up('Space');
    let airborneSeen = false;
    for (let k = 0; k < 20 && !airborneSeen; k++) {
      await sleep(40);
      airborneSeen = await a.evaluate(() => window.__lodestone.netDebug().remotes.some((r) => r.name === 'Bruno' && (r.activity & 128) !== 0));
    }
    if (airborneSeen) await a.screenshot({ path: path.join(EVIDENCE, `wp06-${mode}-activity.png`) });
    const pa = await player(a);
    const pb = await player(b);
    const remB = (await debug(a)).remotes.find((r) => r.name === 'Bruno');
    const remA = (await debug(b)).remotes.find((r) => r.name === 'Alyssa');
    // A walking shot (outside the measured window): B strafes across A's view.
    await b.evaluate(() => window.__lodestone.setLook(window.__lodestone.player().yaw, 0));
    await b.keyboard.down('KeyD');
    await sleep(900);
    await faceOther(a, 'Bruno');
    await a.screenshot({ path: path.join(EVIDENCE, `wp06-${mode}-walking.png`) });
    await b.keyboard.up('KeyD');
    const zoneMetrics = (await (await fetch(`http://localhost:${PORT.zone}/metrics`)).text())
      .split('\n')
      .filter((l) => /^zone_(rate_limited_total|input_frames_dropped_total|input_frames_skipped_total|input_frames_synthesized_total|speed_violations_total|snapshots_shed_total|kicks_total|sessions|client_down_kbps|client_up_kbps|budget_records)/.test(l) && !/ 0$/.test(l));

    const result = {
      mode,
      profile: PROFILE,
      transport: da.transport,
      walkSeconds: walkMs / 1000,
      rttMs: { A: da.rttMs, B: dbb.rttMs },
      bandwidthKbps: { A: da.bandwidth, B: dbb.bandwidth },
      local: {
        A: { reconciles: d.A.reconciles, agreements: d.A.agreements, corrMaxCm: Math.max(0, ...corrA) * 100, corrP95Cm: pct(corrA, 0.95) * 100, over5cm: corrA.filter((m) => m > 0.05).length },
        B: { reconciles: d.B.reconciles, agreements: d.B.agreements, corrMaxCm: Math.max(0, ...corrB) * 100, corrP95Cm: pct(corrB, 0.95) * 100, over5cm: corrB.filter((m) => m > 0.05).length },
      },
      remote: {
        'A sees B': { ...d.A, extrapPctFrames: (100 * d.A.extrapFrames) / Math.max(1, d.A.interpFrames + d.A.extrapFrames + d.A.frozenFrames), maxJumpCm: da.interp.maxJumpM * 100, maxHandbackCm: da.interp.maxHandbackM * 100, linkDelayMs: da.interp.linkDelay, arrival: da.interp.arrival },
        'B sees A': { ...d.B, extrapPctFrames: (100 * d.B.extrapFrames) / Math.max(1, d.B.interpFrames + d.B.extrapFrames + d.B.frozenFrames), maxJumpCm: dbb.interp.maxJumpM * 100, maxHandbackCm: dbb.interp.maxHandbackM * 100, linkDelayMs: dbb.interp.linkDelay, arrival: dbb.interp.arrival },
      },
      screenshots: { A: fa, B: fb },
      drawnVsTrue: {
        'B drawn by A vs B true (m)': remB ? Math.hypot(remB.x - pb.pos.x, remB.z - pb.pos.z) : null,
        'A drawn by B vs A true (m)': remA ? Math.hypot(remA.x - pa.pos.x, remA.z - pa.pos.z) : null,
      },
      stats: { A: da.stats, B: dbb.stats },
      zoneMetrics,
      jumps: { 'A sees B': da.interp.jumps, 'B sees A': dbb.interp.jumps },
      correctionLog: { A: da.prediction.log.slice(pre.A.logLen), B: dbb.prediction.log.slice(pre.B.logLen) },
      correctionsA: corrA,
      correctionsB: corrB,
    };
    fs.writeFileSync(path.join(EVIDENCE, `wp06-acceptance-${mode}.json`), JSON.stringify(result, null, 2) + '\n');
    summary.push(result);

    check(!!remB && !!remA, 'each browser draws the other player (by name)', { 'A->Bruno': fa, 'B->Alyssa': fb });
    check(airborneSeen, "A sees B's airborne activity flag when B jumps (nameplate chip)");
    check(result.local.A.over5cm === 0 && result.local.B.over5cm === 0, 'no local correction over 5 cm while walking', { A: result.local.A, B: result.local.B });
    check(d.A.teleports === 0 && d.B.teleports === 0, 'no remote teleports');
    check(result.remote['A sees B'].maxJumpCm < 30 && result.remote['B sees A'].maxJumpCm < 30, 'no remote discontinuity over 30 cm (each eased over 70 ms)', {
      'A sees B': { jumps: d.A.visibleJumps, maxCm: +result.remote['A sees B'].maxJumpCm.toFixed(1), extrapEvents: d.A.extrapEvents },
      'B sees A': { jumps: d.B.visibleJumps, maxCm: +result.remote['B sees A'].maxJumpCm.toFixed(1), extrapEvents: d.B.extrapEvents },
    });
    check(dbb.bandwidth.upKbps < 24 && da.bandwidth.upKbps < 24, 'uplink within 24 kbps', { A: da.bandwidth, B: dbb.bandwidth });
    step(`rtt A ${da.rttMs.toFixed(0)} ms, B ${dbb.rttMs.toFixed(0)} ms; walked ${(walkMs / 1000).toFixed(1)} s`);
    for (const br of browsers) await br.close();
    browsers = [];
  }
  const errors = consoleLog.filter((l) => /pageerror|error:/.test(l));
  fs.writeFileSync(path.join(EVIDENCE, 'wp06-acceptance-console.txt'), consoleLog.join('\n') + '\n');
  check(errors.filter((l) => /pageerror/.test(l)).length === 0, 'no page errors in either browser', errors.slice(0, 5));
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
  fs.writeFileSync(path.join(EVIDENCE, 'wp06-acceptance.txt'), lines.join('\n') + '\n');
  process.exit(failures.length ? 1 : 0);
}
