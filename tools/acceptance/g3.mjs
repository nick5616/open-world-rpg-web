#!/usr/bin/env node
// Gate G3 (spec 15): "Two friends explore a cave together with proximity
// voice, climb and glide, use the map and towers." One end-to-end session on
// the merged main: real account, director, zone and social processes (built
// from this checkout, private random ports, a scratch database, so a fresh
// world id), LiveKit from the shared dev infra, the client from Vite, and two
// headless Chromium processes on the GPU with a fake microphone (a steady
// tone, as WP11's walk-apart test) driven with real key events.
//
//   1. Both sign in (dev auth), touch the spawn waypoint, become friends.
//   2. Proximity voice: both hold V; B walks away from A and back (fade,
//      silence past earshot), then they party up (/invite) and B walks on to
//      80 m (party radio). A's actual audio output is measured.
//   3. Both walk to the nearest tower and climb its wall with the stamina
//      wheel (rest on the ledge), prediction vs server measured per mode.
//   4. The tower top reveals the region; A drops a party pin on the cave
//      mouth (B sees it on map and compass); A fast travels to the waypoint
//      and back to the tower through the map UI.
//   5. Both glide from the top toward the cave mouth; A walks into the cave
//      while B still waits on the surface away from the mouth (interest
//      clipping must keep party members visible), then both walk down to the
//      deepest chamber together, hearing each other; A mines a vein and gets
//      the drop.
//
//   node tools/acceptance/g3.mjs [--livekit ws://127.0.0.1:7880] [--keep-db]
//
// Evidence: docs/evidence/g3-acceptance.txt, g3-acceptance.json, g3-*.png
// (see docs/evidence/g3-README.md).
//
// Weather is pinned dry (zone LODESTONE_ZONE_DEBUG_RAIN=0, client ?rain=0,
// as WP10's runs do): the seeded rain stub (half climb speed, a slip every
// 3 s) makes the Spire's 14.8 m wall to the ledge longer than one stamina
// wheel, so a run that happens to start in a rain window could not climb.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { env, killTree, root, waitHttp } from '../../scripts/lib.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const LIVEKIT = arg('livekit', 'ws://127.0.0.1:7880');
const KEEP_DB = process.argv.includes('--keep-db');
const EVIDENCE = path.join(root, 'docs', 'evidence');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-g3-'));
const RUN = Date.now().toString(36);
const DB = `lodestone_wp04_g3_${RUN}`; // devdb manages lodestone_wp04_* scratch databases only
const EXE = process.platform === 'win32' ? '.exe' : '';
const ZONE_ID = `zone-g3-${RUN}`;
const NAMES = { A: 'Corin', B: 'Della' };
const USERS = { A: `g3corin${RUN}`, B: `g3della${RUN}` };
const GPU_ARGS = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const H = '127.0.0.1';

fs.mkdirSync(EVIDENCE, { recursive: true });
const lines = [];
function step(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  lines.push(line);
}
const failures = [];
const verdicts = {}; // G3 item -> [pass, ...]
let item = 'setup';
function check(cond, msg, detail) {
  const d = detail === undefined ? '' : '  ' + JSON.stringify(detail);
  if (!cond) failures.push(`[${item}] ${msg}`);
  (verdicts[item] ??= []).push(!!cond);
  step(`${cond ? 'PASS' : 'FAIL'} ${msg}${d}`);
  return cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = [];
async function shot(page, name) {
  const file = `g3-${String(shots.length + 1).padStart(2, '0')}-${name}.png`;
  shots.push(file); // reserve the number before awaiting (two pages shoot at once)
  await page.screenshot({ path: path.join(EVIDENCE, file) });
  step(`  screenshot ${file}`);
}
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

function goSync(args, extra = {}) {
  const r = spawnSync('go', args, { cwd: root, env: env(extra), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`go ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
// Unique binary names: other agents on this machine stop their own zones by
// image name, which once took this run's zone down mid-walk.
const bin = (name) => path.join(TMP, `g3${RUN}-${name}${EXE}`);
const children = [];
let stopping = false;
let dead = null; // a service that exited mid-run
function start(name, cmd, args, extra, cwd = root) {
  const out = fs.createWriteStream(path.join(TMP, `${name}.log`));
  const child = spawn(cmd, args, { cwd, env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  children.push(child);
  child.on('exit', (code, sig) => {
    if (!stopping) {
      dead = `${name} exited (${code ?? sig}) during the run`;
      step(`ERROR service ${name} exited (${code ?? sig}) during the run; see ${path.join(TMP, name + '.log')}`);
    }
  });
  return child;
}
/** A free TCP port in 20000-45000 (below Windows' reserved dynamic range). */
async function freePort(taken) {
  for (;;) {
    const p = 20000 + Math.floor(Math.random() * 25000);
    if (taken.has(p)) continue;
    const ok = await new Promise((res) => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.listen(p, H, () => s.close(() => res(true)));
    });
    if (ok) {
      taken.add(p);
      return p;
    }
  }
}

/** Fake microphone: 40 s of a steady 220 Hz harmonic tone (WP11's walk-apart signal). */
function writeToneWav(file) {
  const rate = 48000;
  const n = rate * 40;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let s = 0;
    for (let k = 1; k <= 20; k++) s += Math.sin(2 * Math.PI * 220 * k * t + k) / Math.sqrt(k);
    data.writeInt16LE(Math.round(s * 0.09 * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

// ---------------------------------------------------------------- page helpers
const pl = (page) => page.evaluate(() => window.__lodestone.player());
const mapState = (page) => page.evaluate(() => window.__lodestoneMap.state());
const voice = (page) => page.evaluate(() => window.__lodestone.voiceDebug());
const look = (page, yaw, pitch = 0) => page.evaluate(([y, p]) => window.__lodestone.setLook(y, p), [yaw, pitch]);
const yawTo = (from, x, z) => Math.atan2(-(x - from.x), -(z - from.z));
const sees = (page, name) => page.evaluate((n) => (window.__lodestone.netDebug()?.remotes ?? []).some((r) => r.name === n), name);
const netd = (page) => page.evaluate(() => {
  const d = window.__lodestone.netDebug();
  return { reconciles: d.prediction.reconciles, agreements: d.prediction.agreements, maxError: d.prediction.maxError, teleports: d.interp.teleports, visibleJumps: d.interp.visibleJumps, maxJumpM: d.interp.maxJumpM, log: d.prediction.log.slice(-20) };
});
async function until(page, fn, a = 0, timeout = 240000) {
  await page.waitForFunction(fn, a, { polling: 50, timeout });
}
async function steps(page, n) {
  const s0 = (await pl(page)).seq;
  await until(page, (t) => window.__lodestone.player().seq >= t, s0 + n);
}
async function pressUntil(page, k, fn, a = 0, timeout = 60000) {
  await page.keyboard.down(k);
  try {
    await until(page, fn, a, timeout);
  } finally {
    await page.keyboard.up(k);
  }
}

async function signInAndPlay(page, user, charName) {
  await page.getByTestId('auth-dev-username').waitFor({ timeout: 180000 });
  await page.getByTestId('auth-dev-username').fill(user);
  await page.getByTestId('auth-dev-submit').click();
  await page.getByTestId('char-name').waitFor();
  if ((await page.getByTestId(`play-${charName}`).count()) === 0) {
    await page.getByTestId('char-name').fill(charName);
    await page.getByTestId('char-create').click();
  }
  await page.getByTestId(`play-${charName}`).click();
  await page.waitForFunction(() => window.__lodestone?.netDebug?.()?.phase === 'playing', null, { timeout: 90000 });
  await page.waitForFunction(() => window.__lodestoneMap?.towers().length > 0 && window.__lodestoneMap.state().online && window.__lodestoneMap.state().stats.events > 0 && !!window.__lodestoneCaves, null, { timeout: 240000 });
}

async function openChat(page) {
  // Enter opens the chat (a click can land on the 3D canvas after the
  // AudioContext gesture click; WP11 opened it with Enter too).
  if ((await page.getByTestId('chat-input').count()) === 0) await page.keyboard.press('Enter');
  await page.getByTestId('chat-input').waitFor();
}
async function say(page, text) {
  await openChat(page);
  await page.getByTestId('chat-input').fill(text);
  await page.getByTestId('chat-input').press('Enter');
  await page.getByTestId('chat-input').press('Escape').catch(() => {});
}

/**
 * Walk toward (x, z) like a player: face it, hold W (+ Shift), re-aim every
 * 150 ms, hop when stuck. Ends within stopAt m, when done() says so, or on
 * timeout. onTick runs every loop (voice sampling).
 */
async function walkTo(page, x, z, { stopAt = 1, timeoutMs = 300000, done = null, sprint = false, label = '', onTick = null } = {}) {
  const t0 = Date.now();
  let p = (await pl(page)).pos;
  let lastLog = 0;
  let last = null;
  let stuck = 0;
  await page.keyboard.down('KeyW');
  if (sprint) await page.keyboard.down('ShiftLeft');
  try {
    for (;;) {
      if (dead) throw new Error(dead);
      p = (await pl(page)).pos;
      const d = Math.hypot(x - p.x, z - p.z);
      if (d <= stopAt || (done && (await done(p, d)))) return { ok: true, p, d, ms: Date.now() - t0 };
      if (Date.now() - t0 > timeoutMs) return { ok: false, p, d, ms: Date.now() - t0 };
      await look(page, yawTo(p, x, z), 0);
      if (last && Math.hypot(p.x - last.x, p.z - last.z) < 0.03) stuck++;
      else stuck = 0;
      if (stuck > 12) {
        await page.keyboard.press('Space');
        stuck = 0;
      }
      last = p;
      if (label && Date.now() - lastLog > 15000) {
        lastLog = Date.now();
        step(`  ${label}: ${d.toFixed(0)} m to go, at (${p.x.toFixed(0)}, ${p.y.toFixed(1)}, ${p.z.toFixed(0)})`);
      }
      if (onTick) await onTick();
      await sleep(onTick ? 40 : 150);
    }
  } finally {
    await page.keyboard.up('KeyW');
    if (sprint) await page.keyboard.up('ShiftLeft');
  }
}

async function openMap(page) {
  if (!(await mapState(page)).mapOpen) await page.keyboard.press('KeyM');
  await page.getByTestId('map-canvas').waitFor();
  await sleep(500);
}
async function closeMap(page) {
  if ((await mapState(page)).mapOpen) await page.keyboard.press('Escape');
  await sleep(250);
}
async function mapClick(page, x, z, opts = {}) {
  const pos = await page.evaluate(([x, z]) => window.__lodestoneMap.mapScreenPos(x, z), [x, z]);
  if (!pos) throw new Error('map is not open');
  if (opts.shift) await page.keyboard.down('ShiftLeft');
  await page.mouse.click(pos.x, pos.y, { button: opts.button ?? 'left' });
  if (opts.shift) await page.keyboard.up('ShiftLeft');
}
async function fastTravelUI(page, site) {
  await openMap(page);
  await mapClick(page, site.x, site.z);
  await page.getByTestId('map-travel').waitFor({ timeout: 8000 });
  await page.getByTestId('map-travel').dispatchEvent('click');
  await sleep(300);
  await closeMap(page);
}

// ---------------------------------------------------------------- earshot tap
// The zone's earshot sets (WP11, Redis voice:{worldId}) read through the
// shared Redis container's redis-cli (read-only SUBSCRIBE). Keeps a timeline
// of "is X in Y's set" for the two players of this private world.
const earshot = { proc: null, sets: new Map(), timeline: [], msgs: 0 };
function tapEarshot(worldId) {
  const p = spawn('docker', ['exec', '-i', 'lodestone-redis-1', 'redis-cli', 'SUBSCRIBE', `voice:${worldId}`], { stdio: ['pipe', 'pipe', 'pipe'] });
  earshot.proc = p;
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!l.startsWith('{')) continue;
      try {
        const m = JSON.parse(l);
        earshot.msgs++;
        for (const [k, v] of Object.entries(m.sets ?? {})) earshot.sets.set(k, v);
        for (const g of m.gone ?? []) earshot.sets.delete(g);
        earshot.timeline.push({ t: Date.now(), sets: Object.fromEntries(earshot.sets) });
      } catch {}
    }
  });
  p.on('error', () => {});
}
/** At wall time t, is speaker in listener's earshot set (null: unknown)? */
function inEarshotAt(t, listener, speaker) {
  let last = null;
  for (const e of earshot.timeline) {
    if (e.t > t) break;
    last = e;
  }
  if (!last || !last.sets[listener]) return null;
  return last.sets[listener].includes(speaker);
}

// ---------------------------------------------------------------- voice samples
const loud = (s) => Math.max(s.outL ?? -120, s.outR ?? -120);
const SILENT_DB = -70;
async function voiceSample(listener, speaker, speakerName, phase, extra = {}) {
  const [{ va, na }, ps] = await Promise.all([listener.evaluate(() => ({ va: window.__lodestone.voiceDebug(), na: window.__lodestone.netDebug() })), pl(speaker)]);
  if (!va) return null;
  const sp = va.speakers.find((s) => s.name === speakerName) ?? null;
  const remote = na.remotes.find((r) => r.name === speakerName) ?? null;
  const truth = { x: ps.pos.x, y: ps.pos.y + 1.8, z: ps.pos.z };
  return {
    t: Date.now(),
    phase,
    trueDist: r2(Math.hypot(truth.x - va.listener.x, truth.y - va.listener.y, truth.z - va.listener.z)),
    trueDistH: r2(Math.hypot(truth.x - va.listener.x, truth.z - va.listener.z)),
    listenerY: r2(va.listener.y),
    speakerY: r2(truth.y),
    subscribed: !!sp,
    speakerId: sp?.id ?? null,
    mode: sp?.mode ?? null,
    distance: sp?.distance != null ? r2(sp.distance) : null,
    rel: sp?.rel ? { right: r2(sp.rel.right), forward: r2(sp.rel.forward) } : null,
    distanceGain: sp ? +sp.distanceGain.toFixed(4) : null,
    occluded: sp?.occluded ?? null,
    lowpassHz: sp?.lowpassHz ?? null,
    level: sp ? +sp.level.toFixed(3) : null,
    outL: va.output ? +va.output.leftDb.toFixed(1) : null,
    outR: va.output ? +va.output.rightDb.toFixed(1) : null,
    drawn: !!remote,
    zoneSpeakingBit: remote ? (remote.activity & 64) !== 0 : null,
    ...extra,
  };
}
const avg = (xs, f) => xs.reduce((a, x) => a + f(x), 0) / Math.max(1, xs.length);
function spearman(xs, ys) {
  const rank = (v) => {
    const idx = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(v.length);
    idx.forEach(([, i], k) => (r[i] = k));
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const n = xs.length;
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (rx[i] - ry[i]) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}
function perMode(probe) {
  return Object.fromEntries(Object.entries(probe?.perMode ?? {}).map(([m, s]) => [m, { snapshots: s.snapshots, maxCm: r2(s.maxDivM * 100) }]));
}

// ---------------------------------------------------------------- traversal
/** Jump, double jump, then (falling) the third press opens the glider (WP10). */
async function jumpToGlide(page) {
  await pressUntil(page, 'Space', () => window.__lodestone.player().mode === 'air');
  await steps(page, 12);
  await pressUntil(page, 'Space', () => window.__lodestone.player().airJumps >= 1);
  await until(page, () => window.__lodestone.player().vel.y < -1);
  await pressUntil(page, 'Space', () => window.__lodestone.player().mode === 'glide');
}

/**
 * Climb the tower wall facing its axis: hold W into the wall (climb), rest
 * on the ledge until the wheel is full, climb on and mantle onto the top.
 * Waits on game state, not wall time (low headless fps).
 */
async function climbTower(page, label, tower) {
  const log = [];
  const t0 = Date.now();
  let minStamina = 100;
  const aim = async () => {
    const p = (await pl(page)).pos;
    await look(page, yawTo(p, tower.x, tower.z), 0.45);
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    await aim();
    await until(page, () => window.__lodestone.player().stamina >= 99.9 && !window.__lodestone.player().exhausted, 0, 120000);
    await page.keyboard.down('KeyW');
    try {
      await until(page, () => window.__lodestone.player().mode === 'climb', 0, 60000);
      log.push(`${label}: climbing (attempt ${attempt}) at y ${(await pl(page)).pos.y.toFixed(2)}`);
      // Up to the ledge (or the top), or fell back off.
      await until(page, ([ledgeY]) => {
        const p = window.__lodestone.player();
        return (p.mode !== 'climb' && p.mode !== 'air' && p.pos.y > ledgeY - 1.5) || (p.mode !== 'climb' && p.pos.y < ledgeY - 8 && p.mode !== 'air');
      }, [tower.topY - 13], 300000);
    } finally {
      await page.keyboard.up('KeyW');
    }
    let p = await pl(page);
    minStamina = Math.min(minStamina, p.stamina);
    if (p.pos.y < tower.topY - 14.5) {
      log.push(`${label}: fell back to y ${p.pos.y.toFixed(2)} (stamina ${p.stamina.toFixed(1)}), retrying`);
      continue;
    }
    if (p.pos.y < tower.topY - 0.5) {
      log.push(`${label}: on the ledge at y ${p.pos.y.toFixed(2)}, stamina ${p.stamina.toFixed(1)}; resting`);
      await until(page, () => window.__lodestone.player().stamina >= 99.9, 0, 120000);
      if (label === NAMES.A) await shot(page, 'climb-ledge-rested-A');
      await aim();
      await page.keyboard.down('KeyW');
      try {
        await until(page, (top) => {
          const q = window.__lodestone.player();
          return q.mode !== 'climb' && q.mode !== 'air' && q.pos.y >= top - 0.05;
        }, tower.topY, 300000);
        await steps(page, 6);
      } finally {
        await page.keyboard.up('KeyW');
      }
      p = await pl(page);
      minStamina = Math.min(minStamina, p.stamina);
    }
    log.push(`${label}: on top at (${p.pos.x.toFixed(2)}, ${p.pos.y.toFixed(2)}, ${p.pos.z.toFixed(2)}), stamina ${p.stamina.toFixed(1)}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    return { ok: true, log, minStamina, top: p.pos };
  }
  return { ok: false, log, minStamina };
}

// ================================================================ main
let browsers = [];
const result = { run: RUN, livekit: LIVEKIT };
try {
  step(`G3 acceptance (spec 15): two friends, proximity voice, climb + glide, map + towers, a cave together. Run ${RUN}, LiveKit ${LIVEKIT}`);
  const taken = new Set();
  const PORT = { account: await freePort(taken), director: await freePort(taken), zone: await freePort(taken), social: await freePort(taken), vite: await freePort(taken) };
  step(`private ports ${JSON.stringify(PORT)}; logs in ${TMP}`);
  const wav = path.join(TMP, 'tone.wav');
  writeToneWav(wav);
  const pgUrl = goSync(['run', './server/account/cmd/devdb', 'create', DB]).trim().split('\n').pop();
  step(`scratch database ${DB} (all migrations)`);
  for (const [name, pkg] of [['account', './server/account'], ['director', './server/director'], ['zone', './server/zone'], ['social', './server/social']]) goSync(['build', '-o', bin(name), pkg]);
  step('built account, director, zone, social from this checkout');
  const svcEnv = {
    LODESTONE_PG_URL: pgUrl,
    LODESTONE_ACCOUNT_PORT: String(PORT.account),
    LODESTONE_DIRECTOR_PORT: String(PORT.director),
    LODESTONE_SOCIAL_PORT: String(PORT.social),
    LODESTONE_SOCIAL_URL: `ws://${H}:${PORT.social}/ws`,
    LODESTONE_DEV_AUTH: '1',
    LODESTONE_CORS_ORIGIN: '*',
  };
  start('account', bin('account'), [], svcEnv);
  check(await waitHttp(`http://${H}:${PORT.account}/healthz`, 90000), `account healthy on :${PORT.account} (mints the official world into the scratch DB)`);
  start('social', bin('social'), [], { ...svcEnv, LODESTONE_LIVEKIT_URL: LIVEKIT });
  check(await waitHttp(`http://${H}:${PORT.social}/healthz`, 30000), `social healthy on :${PORT.social} (voice via ${LIVEKIT})`);
  start('director', bin('director'), [], svcEnv);
  check(await waitHttp(`http://${H}:${PORT.director}/healthz`, 30000), `director healthy on :${PORT.director}`);
  start('zone', bin('zone'), [], { ...svcEnv, LODESTONE_ZONE_PORT: String(PORT.zone), LODESTONE_ZONE_ID: ZONE_ID, LODESTONE_ZONE_WT_ADDR: 'off', LODESTONE_ZONE_PUBLIC_URL: `ws://${H}:${PORT.zone}/ws`, LODESTONE_ZONE_DEBUG_RAIN: '0' });
  check(await waitHttp(`http://${H}:${PORT.zone}/healthz`, 90000), `zone healthy on :${PORT.zone}`);
  const zoneInfo = await (await fetch(`http://${H}:${PORT.zone}/debug/zone`)).json();
  result.world = { worldId: zoneInfo.worldId, seed: zoneInfo.seed, genVersion: zoneInfo.genVersion, atlasHash: zoneInfo.atlasHash };
  step(`zone serves world ${zoneInfo.worldId} (fresh for this run) seed ${zoneInfo.seed} genVersion ${zoneInfo.genVersion}`);
  tapEarshot(zoneInfo.worldId);
  start('vite', process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT.vite), '--strictPort', '--host', H], { VITE_ACCOUNT_URL: `http://${H}:${PORT.account}`, VITE_DIRECTOR_URL: `http://${H}:${PORT.director}`, VITE_SOLO: '0' }, path.join(root, 'client'));
  check(await waitHttp(`http://${H}:${PORT.vite}/`, 90000), `vite on :${PORT.vite}`);
  await sleep(6000); // the zone registry heartbeat reaches the director

  const consoleLog = [];
  const launchArgs = [...GPU_ARGS, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'];
  browsers = [await chromium.launch({ args: launchArgs }), await chromium.launch({ args: launchArgs })];
  const pages = [];
  for (const [i, br] of browsers.entries()) {
    const label = i === 0 ? 'A' : 'B';
    const ctx = await br.newContext({ viewport: { width: 1280, height: 720 }, permissions: ['microphone'] });
    const page = await ctx.newPage();
    page.on('console', (m) => consoleLog.push(`[${label}] ${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => consoleLog.push(`[${label}] pageerror: ${e.message}`));
    await page.goto(`http://${H}:${PORT.vite}/?debug=1&autoplay=1&transport=ws&voiceRawMic=1&rain=0`);
    pages.push(page);
  }
  const [a, b] = pages;

  // ======================================================== 1. sign in, friends, party (party formed in 2)
  item = '1 sign-in, friends, party';
  await Promise.all([signInAndPlay(a, USERS.A, NAMES.A), signInAndPlay(b, USERS.B, NAMES.B)]);
  for (const p of pages) {
    await p.evaluate(() => {
      const l = window.__lodestone;
      l.setQuality('medium');
      l.setFreezeTime(true);
      l.setTimeOfDay(0.42 * 3600);
      l.probe(); // install the per-mode divergence probe (WP10)
    });
  }
  const [pa0, pb0] = [await pl(a), await pl(b)];
  check(true, `both playing (dev auth -> director ticket -> zone): ${NAMES.A} at (${pa0.pos.x.toFixed(1)}, ${pa0.pos.y.toFixed(1)}, ${pa0.pos.z.toFixed(1)}), ${NAMES.B} at (${pb0.pos.x.toFixed(1)}, ${pb0.pos.y.toFixed(1)}, ${pb0.pos.z.toFixed(1)})`);
  await shot(a, 'signed-in-A');
  // Spawn waypoint: both touch it (fast travel needs one).
  const waypoints = await a.evaluate(() => window.__lodestoneMap.sites('waypoint'));
  const wp = waypoints.map((s) => ({ ...s, d: Math.hypot(s.x - pa0.pos.x, s.z - pa0.pos.z) })).sort((p, q) => p.d - q.d)[0];
  await Promise.all([a, b].map((p) => walkTo(p, wp.x, wp.z, { stopAt: 0.8, timeoutMs: 90000, done: async () => (await mapState(p)).waypointsUnlocked > 0 })));
  await Promise.all([a, b].map((p) => p.waitForFunction(() => window.__lodestoneMap.state().waypointsUnlocked > 0, null, { timeout: 8000 }).catch(() => {})));
  const [wa, wb] = [await mapState(a), await mapState(b)];
  check(wa.waypointsUnlocked >= 1 && wb.waypointsUnlocked >= 1, `both touched the spawn waypoint #${wp.index} (${wp.d.toFixed(1)} m away): activated, respawn point set`, { a: wa.lastWaypoint, b: wb.lastWaypoint });
  // Friends: A sends a request from the friends panel, B accepts.
  await a.getByTestId('friends-toggle').click();
  await a.getByTestId('friend-add').fill(NAMES.B);
  await a.getByTestId('friend-add').press('Enter');
  await b.getByTestId('friends-toggle').click();
  await b.getByTestId('friend-incoming').getByText('Accept').click({ timeout: 15000 });
  await a.getByTestId('friend-row').filter({ hasText: NAMES.B }).getByTestId('friend-status').filter({ hasText: 'online' }).waitFor({ timeout: 15000 });
  const fa = await a.getByTestId('friend-row').filter({ hasText: NAMES.B }).innerText();
  const fb = await b.getByTestId('friend-row').filter({ hasText: NAMES.A }).innerText().catch(() => '');
  check(/online/.test(fa) && fb.includes(NAMES.A), `friend request -> accept: each lists the other, online with region`, { a: fa.replace(/\s+/g, ' '), b: fb.replace(/\s+/g, ' ') });
  await shot(a, 'friends-A');
  await a.getByTestId('friends-toggle').click();
  await b.getByTestId('friends-toggle').click();

  // ======================================================== 2. proximity voice
  item = '2 proximity voice';
  await Promise.all(pages.map((p) => p.waitForFunction(() => window.__lodestone.voiceDebug()?.status === 'connected', null, { timeout: 60000 })));
  const v0 = await voice(a);
  check(v0.mic === 'idle', 'voice connected to LiveKit; microphone not requested before the first push', { mic: v0.mic, status: v0.status });
  for (const p of pages) {
    await p.mouse.click(640, 360); // a user gesture for the AudioContext
    await p.keyboard.down('KeyV'); // push-to-talk, held for the rest of the session
  }
  await Promise.all(pages.map((p) => p.waitForFunction(() => window.__lodestone.voiceDebug()?.transmitting === true, null, { timeout: 30000 })));
  const vA = await voice(a);
  check(vA.mic === 'ready' && vA.transmitting && vA.contextState === 'running', 'push-to-talk: V publishes the mic and transmits while held; AudioContext running', { mic: vA.mic, ctx: vA.contextState });
  const samples = [];
  let lastS = 0;
  const vs = async (phase, force = false) => {
    if (!force && Date.now() - lastS < 120) return;
    lastS = Date.now();
    const s = await voiceSample(a, b, NAMES.B, phase);
    if (s) samples.push(s);
  };
  // Geometry: A faces north; B to 4 m ahead, then east (A's right) to 62 m
  // (out of earshot), back to 8 m on A's left; party; then west to 80 m.
  await look(a, 0, 0);
  const A0 = (await pl(a)).pos;
  await walkTo(b, A0.x, A0.z - 4, { stopAt: 0.6, timeoutMs: 60000 });
  await sleep(2500);
  for (let i = 0; i < 12; i++) {
    await vs('near', true);
    await sleep(100);
  }
  await shot(a, 'voice-near-A');
  await walkTo(b, A0.x + 62, A0.z - 4, { stopAt: 0.8, timeoutMs: 90000, onTick: () => vs('walk-out') });
  for (let i = 0; i < 15; i++) {
    await vs('far', true);
    await sleep(100);
  }
  await shot(a, 'voice-out-of-earshot-A');
  await walkTo(b, A0.x - 8, A0.z - 4, { stopAt: 0.8, timeoutMs: 90000, onTick: () => vs('walk-back') });
  // Party: /invite in chat, accepted in the party frame.
  await say(a, `/invite ${NAMES.B}`);
  await b.getByTestId('party-accept').waitFor({ timeout: 20000 });
  await b.getByTestId('party-accept').dispatchEvent('click');
  await a.waitForFunction(() => document.querySelectorAll('[data-testid="party-member"]').length === 2, null, { timeout: 20000 });
  await Promise.all([a, b].map((p) => p.waitForFunction(() => window.__lodestoneMap.state().partyId !== 0, null, { timeout: 20000 })));
  const [ma, mb] = [await mapState(a), await mapState(b)];
  item = '1 sign-in, friends, party';
  check(ma.partyId === mb.partyId && ma.partyId !== 0, `party via /invite + party frame; the zone's party ring has both in party ${ma.partyId}`, { a: ma.partyId, b: mb.partyId });
  await shot(a, 'party-A');
  item = '2 proximity voice';
  await sleep(2500); // the voice leader refreshes parties every 2 s
  let radioShot = false;
  await walkTo(b, A0.x - 80, A0.z - 4, {
    stopAt: 0.8,
    timeoutMs: 90000,
    onTick: async () => {
      await vs('party');
      const s = samples[samples.length - 1];
      if (!radioShot && s?.mode === 'radio' && s.trueDistH > 60) {
        radioShot = true;
        await shot(a, 'voice-party-radio-A');
      }
    },
  });
  for (let i = 0; i < 12; i++) {
    await vs('party-far', true);
    await sleep(100);
  }
  // Analysis (WP11's criteria, real terrain: occluded samples counted apart).
  const prox = samples.filter((s) => !s.phase.startsWith('party'));
  const subAll = prox.filter((s) => s.subscribed && s.mode === 'spatial' && s.distance !== null);
  const sub = subAll.filter((s) => !s.occluded);
  const near = sub.filter((s) => s.distance >= 3 && s.distance <= 7);
  const far = sub.filter((s) => s.distance >= 30 && s.distance <= 40);
  const nearDb = avg(near, loud);
  const farDb = avg(far, loud);
  const expectDrop = 20 * Math.log10(avg(near, (s) => s.distanceGain) / Math.max(1e-6, avg(far, (s) => s.distanceGain)));
  const fadeS = sub.filter((s) => s.distance >= 2.5);
  const rho = fadeS.length > 3 ? spearman(fadeS.map((s) => s.distance), fadeS.map(loud)) : 0;
  const silentFrom = 48 + 4.9 * 0.5 + 1;
  const beyond = prox.filter((s) => s.trueDistH > silentFrom);
  const inside = prox.filter((s) => s.trueDistH < 38);
  const partyFar = samples.filter((s) => s.phase.startsWith('party') && s.trueDistH > 56);
  result.voiceSurface = {
    samples: samples.length,
    fade: { nearDb: r2(nearDb), farDb: r2(farDb), dropDb: r2(nearDb - farDb), expectedDropDb: r2(expectDrop), spearman: r2(rho), nNear: near.length, nFar: far.length },
    occlusion: { spatialSamples: subAll.length, occluded: subAll.length - sub.length },
    earshot: { silentBeyondM: r2(silentFrom), samplesBeyond: beyond.length, audibleBeyond: beyond.filter((s) => loud(s) > SILENT_DB).length, samplesInside38m: inside.length, unsubscribedInside38m: inside.filter((s) => !s.subscribed).length },
    partyRadio: { samplesBeyond56m: partyFar.length, subscribed: partyFar.filter((s) => s.subscribed).length, radio: partyFar.filter((s) => s.mode === 'radio').length, audible: partyFar.filter((s) => loud(s) > SILENT_DB).length, meanAbsRminusLdb: r2(avg(partyFar, (s) => Math.abs(s.outR - s.outL))), meanLevelDb: r2(avg(partyFar, loud)) },
    speaking: { zoneSpeakingBitSamples: samples.filter((s) => s.zoneSpeakingBit === true).length },
  };
  const vsum = result.voiceSurface;
  step(`voice (surface): ${JSON.stringify(vsum)}`);
  check(near.length > 3 && far.length > 3 && nearDb - farDb > 12, `they hear each other close and it fades: ${r2(nearDb)} dB at 3-7 m, ${r2(farDb)} dB at 30-40 m (drop ${r2(nearDb - farDb)} dB, model ${r2(expectDrop)} dB)`, vsum.fade);
  check(rho < -0.8, `level falls steadily with distance (Spearman ${r2(rho)} < -0.8)`);
  check(inside.length > 10 && vsum.earshot.unsubscribedInside38m <= 6, 'within 38 m A is subscribed to B (allowing the re-subscribe moment)', vsum.earshot);
  check(beyond.length > 3 && vsum.earshot.audibleBeyond === 0, `out of earshot (not partied yet): silent past ${r2(silentFrom)} m`, vsum.earshot);
  check(partyFar.length > 5 && vsum.partyRadio.subscribed === partyFar.length && vsum.partyRadio.radio === partyFar.length && vsum.partyRadio.audible === partyFar.length && vsum.partyRadio.meanAbsRminusLdb < 1.5, 'party radio: past earshot the party member stays subscribed, audible and flat (radio branch)', vsum.partyRadio);
  check(vsum.speaking.zoneSpeakingBitSamples > 0, "A sees B's speaking bit from the zone while B holds V", vsum.speaking);

  // ======================================================== 3. climb the tower, 4a. reveal
  item = '3 climb + glide';
  const towers = await a.evaluate(() => window.__lodestoneMap.towers());
  const Ap = (await pl(a)).pos;
  const tower = towers.map((t) => ({ ...t, d: Math.hypot(t.x - Ap.x, t.z - Ap.z) })).sort((p, q) => p.d - q.d)[0];
  const sys = await a.evaluate(() => window.__lodestoneCaves.systems());
  const cave = sys.map((s) => ({ ...s, d: Math.hypot(s.mouth.x - tower.x, s.mouth.z - tower.z) })).sort((p, q) => p.d - q.d)[0];
  const route = await a.evaluate((si) => window.__lodestoneCaves.route(si), cave.index);
  result.tower = tower;
  result.cave = { index: cave.index, mouth: cave.mouth, deepest: cave.deepest, maxDepth: cave.maxDepth, chambers: cave.chambers, veins: cave.veins, routePoints: route.points.length, distFromTower: r2(cave.d) };
  step(`nearest tower #${tower.site} "${tower.name}" (region ${tower.region}) ${tower.d.toFixed(0)} m away, top y ${tower.topY.toFixed(2)}, maxR ${tower.maxR.toFixed(1)}; cave system ${cave.index} mouth (${cave.mouth.x.toFixed(0)}, ${cave.mouth.y.toFixed(0)}, ${cave.mouth.z.toFixed(0)}) ${cave.d.toFixed(0)} m from the tower, deepest chamber ${cave.maxDepth.toFixed(0)} m down`);
  // Staging on the west face (WP10 climbed it from 14 m west; the uphill side
  // fits one stamina wheel to the ledge). B a few metres along the wall.
  const stage = (ang, r) => ({ x: tower.x - Math.cos(ang) * r, z: tower.z + Math.sin(ang) * r });
  const stA = stage(0.0, tower.maxR + 1.5);
  const stB = stage(0.22, tower.maxR + 1.5);
  const viaA = stage(0.0, tower.maxR + 30);
  const viaB = stage(0.22, tower.maxR + 30);
  const [toA, toB] = await Promise.all([
    walkTo(a, viaA.x, viaA.z, { stopAt: 2, sprint: true, label: `${NAMES.A} to the tower`, timeoutMs: 420000 }),
    walkTo(b, viaB.x, viaB.z, { stopAt: 2, sprint: true, label: `${NAMES.B} to the tower`, timeoutMs: 420000 }),
  ]);
  check(toA.ok && toB.ok, `both walked to the tower (${(toA.ms / 1000).toFixed(0)} s, ${(toB.ms / 1000).toFixed(0)} s)`);
  await Promise.all([walkTo(a, stA.x, stA.z, { stopAt: 0.6, timeoutMs: 120000 }), walkTo(b, stB.x, stB.z, { stopAt: 0.6, timeoutMs: 120000 })]);
  {
    const p = (await pl(b)).pos;
    await look(b, yawTo(p, tower.x, tower.z) + 0.5, 0.35);
    await sleep(1200);
    await shot(b, 'tower-base-B');
  }
  for (const p of pages) await p.evaluate(() => window.__lodestone.probeReset());
  const climbNet0 = [await netd(a), await netd(b)];
  const climbs = await Promise.all([climbTower(a, NAMES.A, tower), climbTower(b, NAMES.B, tower)]);
  for (const c of climbs) for (const l of c.log) step(`  ${l}`);
  const climbProbe = [await a.evaluate(() => window.__lodestone.probe()), await b.evaluate(() => window.__lodestone.probe())];
  const climbNet1 = [await netd(a), await netd(b)];
  result.climb = [0, 1].map((i) => ({ ok: climbs[i].ok, minStamina: r2(climbs[i].minStamina), top: climbs[i].top, maxCm: r2(climbProbe[i].maxDivM * 100), snapshots: climbProbe[i].snapshots, perMode: perMode(climbProbe[i]), transitions: climbProbe[i].transitions, corrections: climbNet1[i].reconciles - climbNet0[i].reconciles }));
  step(`climb: ${JSON.stringify(result.climb.map((c) => ({ ok: c.ok, minStamina: c.minStamina, maxCm: c.maxCm, perMode: c.perMode, corrections: c.corrections })))}`);
  check(climbs[0].ok && climbs[1].ok, `both climbed the wall to the top with the stamina wheel (lowest stamina ${r2(climbs[0].minStamina)} / ${r2(climbs[1].minStamina)}, rested on the ledge)`);
  check(result.climb.every((c) => (c.perMode.climb?.snapshots ?? 0) > 50), 'the zone simulated them climbing (climb-mode snapshots on both)', result.climb.map((c) => c.perMode.climb));
  check(result.climb.every((c) => c.maxCm <= 10 && c.corrections === 0), `climb: prediction vs server within 10 cm (max ${result.climb.map((c) => c.maxCm).join(' / ')} cm), 0 corrections`, result.climb.map((c) => ({ maxCm: c.maxCm, corrections: c.corrections })));
  await look(a, 2.4, -0.15);
  await sleep(1200);
  await shot(a, 'tower-top-A');

  item = '4 map + towers';
  await Promise.all([a, b].map((p) => p.waitForFunction((r) => (window.__lodestoneMap.state().revealed & (1 << r)) !== 0, tower.region, { timeout: 15000 }).catch(() => {})));
  const [ta, tb] = [await mapState(a), await mapState(b)];
  check((ta.revealed & (1 << tower.region)) !== 0 && (tb.revealed & (1 << tower.region)) !== 0 && ta.towersUnlocked >= 1 && tb.towersUnlocked >= 1, `the tower top reveals region ${tower.region} and unlocks the tower for both`, { a: { revealed: ta.revealed, towers: ta.towersUnlocked, xp: ta.xp }, b: { revealed: tb.revealed, towers: tb.towersUnlocked, xp: tb.xp } });
  check(ta.toasts.some((t) => t.kind === 'tower') || ta.stats.towers > 0, 'tower toast shown', ta.toasts);

  // Party members on map and compass; a party pin on the cave mouth.
  const compA = await a.evaluate(() => window.__lodestoneMap.compass());
  check(compA.some((m) => m.kind === 'party' && m.label === NAMES.B), `${NAMES.B} is on ${NAMES.A}'s compass as a party member`, compA.filter((m) => m.kind === 'party').map((m) => ({ label: m.label, dist: Math.round(m.dist) })));
  await openMap(a);
  await mapClick(a, cave.mouth.x, cave.mouth.z, { button: 'right', shift: true });
  await b.waitForFunction((n) => window.__lodestoneMap.state().pins.some((p) => p.party && p.owner === n), NAMES.A, { timeout: 15000 }).catch(() => {});
  await sleep(600);
  await shot(a, 'map-revealed-pin-A');
  await closeMap(a);
  const bPin = (await mapState(b)).pins.find((p) => p.party && p.owner === NAMES.A);
  check(!!bPin && Math.hypot(bPin.x - cave.mouth.x, bPin.z - cave.mouth.z) < 15, `${NAMES.A}'s party pin on the cave mouth shows on ${NAMES.B}'s map`, { bPin, mouth: { x: cave.mouth.x, z: cave.mouth.z } });
  {
    const p = (await pl(b)).pos;
    await look(b, yawTo(p, cave.mouth.x, cave.mouth.z) + 0.2, 0.0);
    await sleep(800);
  }
  const compB = await b.evaluate(() => window.__lodestoneMap.compass());
  check(compB.some((m) => m.kind === 'pin' && m.label === NAMES.A) && compB.some((m) => m.kind === 'party' && m.label === NAMES.A), `${NAMES.B}'s compass shows ${NAMES.A} and the pin`, compB.map((m) => ({ kind: m.kind, label: m.label, dist: Math.round(m.dist) })));
  await shot(b, 'compass-pin-B');
  await openMap(b);
  await sleep(500);
  await shot(b, 'map-party-B');
  await closeMap(b);

  // Fast travel A: waypoint, then back to the tower (map UI).
  const tp0 = (await mapState(a)).stats.teleports;
  const bTele0 = (await netd(b)).teleports;
  await a.evaluate(() => window.__lodestone.probeReset());
  const ftNet0 = await netd(a);
  await fastTravelUI(a, wp);
  await a.waitForFunction(([x, z]) => { const p = window.__lodestoneMap.player(); return Math.hypot(p.x - x, p.z - z) < 6; }, [wp.x, wp.z], { timeout: 20000 }).catch(() => {});
  const atWp = (await pl(a)).pos;
  check(Math.hypot(atWp.x - wp.x, atWp.z - wp.z) < 6, `fast travel to the waypoint: ${Math.hypot(atWp.x - wp.x, atWp.z - wp.z).toFixed(1)} m from the stone (${tower.d.toFixed(0)} m from the tower)`);
  await shot(a, 'fast-travel-waypoint-A');
  await sleep(2600); // past the 2 s cooldown
  await fastTravelUI(a, { x: tower.x, z: tower.z });
  await a.waitForFunction(([x, z, y]) => { const p = window.__lodestoneMap.player(); return Math.hypot(p.x - x, p.z - z) < 1.5 && p.y > y - 0.7; }, [tower.x, tower.z, tower.topY], { timeout: 20000 }).catch(() => {});
  const back = (await pl(a)).pos;
  const tp1 = (await mapState(a)).stats.teleports;
  check(Math.hypot(back.x - tower.x, back.z - tower.z) < 1.5 && back.y > tower.topY - 0.7 && tp1 >= tp0 + 2, `fast travel back to the unlocked tower: on its top (y ${back.y.toFixed(2)} vs ${tower.topY.toFixed(2)}), ${tp1 - tp0} teleport Events`);
  await b.waitForFunction((n) => (window.__lodestone.netDebug()?.remotes ?? []).some((r) => r.name === n), NAMES.A, { timeout: 10000 }).catch(() => {});
  const bTele1 = (await netd(b)).teleports;
  await sleep(3000);
  {
    const pr = await a.evaluate(() => window.__lodestone.probe());
    const n1 = await netd(a);
    result.fastTravelPrediction = { corrections: n1.reconciles - ftNet0.reconciles, maxErrorCm: r2(n1.maxError * 100), mismatches: pr.mismatches.slice(0, 12), log: n1.log.slice(-8) };
    step(`fast travel (2 hops + 3 s standing): ${result.fastTravelPrediction.corrections} corrections (the 2 teleports arrive as corrections); first mismatches ${JSON.stringify(pr.mismatches.slice(0, 6))}`);
    const after = pr.mismatches.filter((m) => m.divCm < 100);
    item = '3 climb + glide';
    check(result.fastTravelPrediction.corrections <= 4 && after.length === 0, `after the fast-travel teleports prediction settles at once: ${result.fastTravelPrediction.corrections} corrections for 2 hops, ${after.length} disagreeing snapshots in the 3 s after`, { corrections: result.fastTravelPrediction.corrections, after: after.slice(0, 4) });
    item = '4 map + towers';
  }
  check(await sees(b, NAMES.A), `${NAMES.B} (on the top) sees ${NAMES.A} arrive back; ${bTele1 - bTele0} remote teleports seen (the 2 hops)`);

  // ======================================================== 3b. glide toward the cave mouth
  item = '3 climb + glide';
  for (const p of pages) await p.evaluate(() => window.__lodestone.probeReset());
  const glideNet0 = [await netd(a), await netd(b)];
  const glideOne = async (page, label, side) => {
    const target = { x: cave.mouth.x + side * 12, z: cave.mouth.z };
    let p = (await pl(page)).pos;
    await look(page, yawTo(p, target.x, target.z), -0.25);
    await page.keyboard.down('KeyW');
    let shotTaken = false;
    let maxGlideDist = 0;
    const g0 = { ...p };
    try {
      await jumpToGlide(page);
      const t0 = Date.now();
      for (;;) {
        const q = await pl(page);
        if (q.mode !== 'glide' && q.mode !== 'air') break;
        if (Date.now() - t0 > 300000) break;
        maxGlideDist = Math.hypot(q.pos.x - g0.x, q.pos.z - g0.z);
        if (Math.hypot(q.pos.x - target.x, q.pos.z - target.z) > 8) await look(page, yawTo(q.pos, target.x, target.z), -0.25);
        if (!shotTaken && q.mode === 'glide' && q.pos.y < g0.y - 6) {
          shotTaken = true;
          await shot(page, `glide-${label}`);
        }
        await sleep(200);
      }
    } finally {
      await page.keyboard.up('KeyW');
    }
    p = (await pl(page)).pos;
    return { from: g0, landed: p, horizontal: r2(Math.hypot(p.x - g0.x, p.z - g0.z)), drop: r2(g0.y - p.y), toMouth: r2(Math.hypot(p.x - cave.mouth.x, p.z - cave.mouth.z)), maxGlideDist: r2(maxGlideDist) };
  };
  const glides = await Promise.all([glideOne(a, 'A', -1), glideOne(b, 'B', 1)]);
  const glideProbe = [await a.evaluate(() => window.__lodestone.probe()), await b.evaluate(() => window.__lodestone.probe())];
  const glideNet1 = [await netd(a), await netd(b)];
  result.glide = [0, 1].map((i) => ({ ...glides[i], maxCm: r2(glideProbe[i].maxDivM * 100), perMode: perMode(glideProbe[i]), transitions: glideProbe[i].transitions, mismatches: glideProbe[i].mismatches, corrections: glideNet1[i].reconciles - glideNet0[i].reconciles }));
  for (const [i, g] of result.glide.entries()) if (g.mismatches.length) step(`  glide mismatches ${i ? NAMES.B : NAMES.A}: ${JSON.stringify(g.mismatches.slice(0, 8))}`);
  step(`glide: ${JSON.stringify(result.glide.map((g) => ({ horizontal: g.horizontal, drop: g.drop, toMouth: g.toMouth, maxCm: g.maxCm, perMode: g.perMode, corrections: g.corrections })))}`);
  check(result.glide.every((g) => (g.perMode.glide?.snapshots ?? 0) > 30 && g.horizontal > 60), `both glided from the top toward the cave (${result.glide.map((g) => `${g.horizontal} m out, ${g.drop} m down`).join('; ')})`);
  check(result.glide.every((g) => g.maxCm <= 10 && g.corrections === 0), `glide: prediction vs server within 10 cm (max ${result.glide.map((g) => g.maxCm).join(' / ')} cm), 0 corrections`, result.glide.map((g) => ({ maxCm: g.maxCm, corrections: g.corrections, perMode: g.perMode })));

  // ======================================================== 5. the cave together
  item = '5 cave together';
  for (const p of pages) await p.evaluate(() => window.__lodestone.probeReset());
  const caveNet0 = [await netd(a), await netd(b)];
  const out = { x: route.start.x - cave.mouth.x, z: route.start.z - cave.mouth.z };
  const ol = Math.hypot(out.x, out.z) || 1;
  const waitB = { x: cave.mouth.x + (out.x / ol) * 64, z: cave.mouth.z + (out.z / ol) * 64 };
  const toMouth = await Promise.all([
    walkTo(a, route.start.x, route.start.z, { stopAt: 1.2, timeoutMs: 300000, label: `${NAMES.A} to the mouth` }),
    walkTo(b, waitB.x, waitB.z, { stopAt: 1.5, timeoutMs: 300000, label: `${NAMES.B} to a spot 64 m out` }),
  ]);
  step(`  at the mouth: ${NAMES.A} ${toMouth[0].ok ? 'arrived' : 'timed out'} (${(toMouth[0].ms / 1000).toFixed(0)} s), ${NAMES.B} ${toMouth[1].ok ? 'arrived' : 'timed out'} at (${toMouth[1].p.x.toFixed(1)}, ${toMouth[1].p.z.toFixed(1)}) (${(toMouth[1].ms / 1000).toFixed(0)} s)`);
  {
    const p = (await pl(a)).pos;
    await look(a, yawTo(p, route.points[1].x, route.points[1].z), -0.1);
    await sleep(1500);
    await shot(a, 'cave-mouth-A');
  }
  const caveSamples = [];
  const caveSample = async (phase) => {
    const [pA, pB, aSeesB, bSeesA, ciA, ciB] = await Promise.all([pl(a), pl(b), sees(a, NAMES.B), sees(b, NAMES.A), a.evaluate(() => window.__lodestoneCaves.info()), b.evaluate(() => window.__lodestoneCaves.info())]);
    const vsmp = await voiceSample(a, b, NAMES.B, phase);
    const s = {
      ...vsmp,
      phase,
      a: { x: r2(pA.pos.x), y: r2(pA.pos.y), z: r2(pA.pos.z), mode: pA.mode, underground: r2(ciA.underground) },
      b: { x: r2(pB.pos.x), y: r2(pB.pos.y), z: r2(pB.pos.z), mode: pB.mode, underground: r2(ciB.underground) },
      depthA: r2(cave.mouth.y - pA.pos.y),
      depthB: r2(cave.mouth.y - pB.pos.y),
      dist: r2(Math.hypot(pA.pos.x - pB.pos.x, pA.pos.y - pB.pos.y, pA.pos.z - pB.pos.z)),
      bToMouth: r2(Math.hypot(pB.pos.x - cave.mouth.x, pB.pos.z - cave.mouth.z)),
      aSeesB,
      bSeesA,
    };
    caveSamples.push(s);
    return s;
  };
  // 5a. A walks in alone while B waits on the surface, away from the mouth.
  let ai = 0;
  const advance = (p, idx) => {
    let i = idx;
    while (i < route.points.length && Math.hypot(route.points[i].x - p.x, route.points[i].z - p.z) < (i === route.points.length - 1 ? 2.5 : 1.6)) i++;
    return i;
  };
  {
    await a.keyboard.down('KeyW');
    const t0 = Date.now();
    let stuck = 0;
    let last = null;
    for (;;) {
      const p = (await pl(a)).pos;
      ai = advance(p, ai);
      const info = await a.evaluate(() => window.__lodestoneCaves.info());
      if ((info.underground > 0.95 && cave.mouth.y - p.y > 12) || ai >= route.points.length - 1 || Date.now() - t0 > 240000) break;
      const w = route.points[ai];
      await look(a, yawTo(p, w.x, w.z), -0.1);
      if (last && Math.hypot(p.x - last.x, p.z - last.z) < 0.03) stuck++;
      else stuck = 0;
      if (stuck > 12) {
        await a.keyboard.press('Space');
        stuck = 0;
      }
      last = p;
      await sleep(100);
    }
    await a.keyboard.up('KeyW');
  }
  await sleep(1500);
  for (let i = 0; i < 10; i++) {
    await caveSample('a-in-b-out');
    await sleep(300);
  }
  const split = caveSamples.filter((s) => s.phase === 'a-in-b-out');
  const s0 = split[split.length - 1];
  check(split.every((s) => s.aSeesB && s.bSeesA), `${NAMES.A} ${s0.depthA} m down inside system ${cave.index}, ${NAMES.B} on the surface ${s0.bToMouth} m from the mouth (outside the 48 m mouth band): they still see each other (party exempt from interest clipping) in ${split.filter((s) => s.aSeesB && s.bSeesA).length}/${split.length} samples`, { aUnderground: s0.a.underground, dist: s0.dist });
  {
    const pB = (await pl(b)).pos;
    const pA = (await pl(a)).pos;
    await look(b, yawTo(pB, pA.x, pA.z), Math.atan2(pA.y - pB.y, Math.hypot(pA.x - pB.x, pA.z - pB.z)));
    await sleep(1000);
    await shot(b, 'cave-split-B-sees-A-below');
  }
  // 5b. B walks to the mouth and follows; A leads and waits for B.
  const rb = await walkTo(b, route.start.x, route.start.z, { stopAt: 1.2, timeoutMs: 300000, label: `${NAMES.B} to the mouth`, onTick: async () => { if (Date.now() - lastS > 400) { lastS = Date.now(); await caveSample('b-to-mouth'); } } });
  check(rb.ok, `${NAMES.B} reached the mouth`);
  let bi = 0;
  const walkers = [
    { page: a, name: NAMES.A, idx: ai, down: false, last: null, stuck: 0, done: false },
    { page: b, name: NAMES.B, idx: 0, down: false, last: null, stuck: 0, done: false },
  ];
  const setW = async (w, on) => {
    if (on && !w.down) await w.page.keyboard.down('KeyW');
    if (!on && w.down) await w.page.keyboard.up('KeyW');
    w.down = on;
  };
  const tCave = Date.now();
  let lastSample = 0;
  let midShot = false;
  try {
    for (;;) {
      const [pA, pB] = await Promise.all([pl(a), pl(b)]);
      const P = [pA.pos, pB.pos];
      const dAB = Math.hypot(P[0].x - P[1].x, P[0].y - P[1].y, P[0].z - P[1].z);
      for (const [k, w] of walkers.entries()) {
        const p = P[k];
        w.idx = advance(p, w.idx);
        if (w.idx >= route.points.length) {
          w.done = true;
          await setW(w, false);
          continue;
        }
        // A leads but waits when B falls behind; B stops when it catches up.
        const wait = k === 0 ? dAB > 14 && !walkers[1].done : dAB < 3.5 && !walkers[0].done;
        const pt = route.points[w.idx];
        await w.page.evaluate(([y]) => window.__lodestone.setLook(y, -0.1), [yawTo(p, pt.x, pt.z)]);
        await setW(w, !wait);
        if (!wait && w.last && Math.hypot(p.x - w.last.x, p.z - w.last.z) < 0.03) w.stuck++;
        else w.stuck = 0;
        if (w.stuck > 12) {
          await w.page.keyboard.press('Space');
          w.stuck = 0;
        }
        w.last = p;
      }
      if (Date.now() - lastSample > 350) {
        lastSample = Date.now();
        const s = await caveSample('together');
        if (!midShot && s.depthA > 60 && s.depthB > 50 && s.aSeesB) {
          midShot = true;
          await setW(walkers[0], false);
          const q = (await pl(a)).pos;
          const r = (await pl(b)).pos;
          await look(a, yawTo(q, r.x, r.z), Math.atan2(r.y - q.y, Math.hypot(r.x - q.x, r.z - q.z)));
          await sleep(700);
          await shot(a, 'cave-tunnel-A-sees-B');
        }
      }
      if ((walkers[0].done && walkers[1].done) || (walkers[0].done && dAB < 6) || Date.now() - tCave > 900000) break;
      await sleep(60);
    }
  } finally {
    for (const w of walkers) await setW(w, false);
  }
  bi = walkers[1].idx;
  const [endA, endB] = [(await pl(a)).pos, (await pl(b)).pos];
  check(walkers[0].done, `both walked down from the mouth to the deepest chamber of system ${cave.index}: ${NAMES.A} ${(cave.mouth.y - endA.y).toFixed(1)} m below the mouth, ${NAMES.B} ${(cave.mouth.y - endB.y).toFixed(1)} m (waypoint ${bi}/${route.points.length}), ${((Date.now() - tCave) / 1000).toFixed(0)} s`);
  for (let i = 0; i < 8; i++) {
    await caveSample('deepest');
    await sleep(250);
  }
  {
    // Step back a few metres along the route so the shot shows Corin, not his boots.
    const back = route.points[Math.max(0, route.points.length - 3)];
    await walkTo(b, back.x, back.z, { timeoutMs: 20000, done: async (p) => Math.hypot(p.x - endA.x, p.z - endA.z) > 6 });
    const q = (await pl(b)).pos;
    const r = (await pl(a)).pos;
    await look(b, yawTo(q, r.x, r.z), Math.atan2(r.y + 1 - (q.y + 1.8), Math.hypot(r.x - q.x, r.z - q.z)));
    await sleep(900);
    await shot(b, 'cave-deepest-B-sees-A');
  }
  const tog = caveSamples.filter((s) => s.phase === 'together' || s.phase === 'deepest');
  const under = tog.filter((s) => s.depthA > 8 && s.depthB > 8);
  const visBoth = under.filter((s) => s.aSeesB && s.bSeesA).length;
  check(under.length > 10 && visBoth === under.length, `underground together they keep seeing each other: ${visBoth}/${under.length} samples (max distance ${Math.max(...under.map((s) => s.dist))} m)`);
  // Voice underground.
  const close = under.filter((s) => s.dist <= 25);
  const heard = close.filter((s) => s.subscribed && loud(s) > SILENT_DB);
  const occl = close.filter((s) => s.occluded);
  result.voiceCave = {
    samplesUnderground: under.length,
    within25m: close.length,
    subscribed: close.filter((s) => s.subscribed).length,
    spatial: close.filter((s) => s.mode === 'spatial').length,
    audible: heard.length,
    occluded: occl.length,
    meanLevelDb: r2(avg(close, loud)),
    meanDistance: r2(avg(close, (s) => s.dist)),
  };
  step(`voice (cave): ${JSON.stringify(result.voiceCave)}`);
  check(close.length > 10 && heard.length >= 0.95 * close.length, `in the cave they keep hearing each other: A hears B (output > ${SILENT_DB} dB) in ${heard.length}/${close.length} samples within 25 m (mean ${result.voiceCave.meanLevelDb} dB at ${result.voiceCave.meanDistance} m)`, result.voiceCave);
  check(close.length > 10 && occl.length <= 0.5 * close.length, `underground the rock overhead does not muffle them: occluded (low-pass) in ${occl.length}/${close.length} samples within 25 m (only where the tunnel bends between them)`, { occluded: occl.length, n: close.length });
  check(close.filter((s) => s.mode === 'spatial').length >= 0.95 * close.length, 'underground the voice stays spatial (positioned on the drawn partner, not the radio)', { spatial: result.voiceCave.spatial, n: close.length });
  // Earshot from the zone (WP11 sets with WP09's cave system): same system, 30 m rule.
  const idB = close.find((s) => s.speakerId)?.speakerId;
  const lastSet = earshot.timeline.at(-1)?.sets ?? {};
  const idA = Object.keys(lastSet).find((k) => k !== idB);
  const eS = close.map((s) => inEarshotAt(s.t, idA, idB)).filter((x) => x !== null);
  result.earshotCave = { messages: earshot.msgs, samples: eS.length, inEarshot: eS.filter(Boolean).length };
  check(eS.length > 5 && eS.filter(Boolean).length >= 0.9 * eS.length, `the zone's earshot sets (Redis voice:{worldId}) have ${NAMES.B} in ${NAMES.A}'s set underground: ${eS.filter(Boolean).length}/${eS.length}`, result.earshotCave);

  const caveProbe = [await a.evaluate(() => window.__lodestone.probe()), await b.evaluate(() => window.__lodestone.probe())];
  const caveNet1 = [await netd(a), await netd(b)];
  result.cavePrediction = [0, 1].map((i) => ({ maxCm: r2(caveProbe[i].maxDivM * 100), perMode: perMode(caveProbe[i]), corrections: caveNet1[i].reconciles - caveNet0[i].reconciles, remoteTeleports: caveNet1[i].teleports - caveNet0[i].teleports, mismatches: caveProbe[i].mismatches, log: caveNet1[i].log }));
  for (const [i, c] of result.cavePrediction.entries()) if (c.mismatches.length) step(`  cave mismatches ${i ? NAMES.B : NAMES.A}: ${JSON.stringify(c.mismatches.slice(0, 12))}`);
  step(`cave prediction: ${JSON.stringify(result.cavePrediction.map((c) => ({ maxCm: c.maxCm, perMode: c.perMode, corrections: c.corrections, remoteTeleports: c.remoteTeleports })))}`);
  check(result.cavePrediction.every((c) => c.maxCm <= 10 && c.corrections === 0), `walking from the glide landing to the deepest chamber: prediction vs server within 10 cm (max ${result.cavePrediction.map((c) => c.maxCm).join(' / ')} cm), 0 corrections`, result.cavePrediction.map((c) => ({ maxCm: c.maxCm, corrections: c.corrections })));
  check(result.cavePrediction.every((c) => c.remoteTeleports === 0), 'no remote teleports while walking the cave together', result.cavePrediction.map((c) => c.remoteTeleports));
  for (const p of pages) await p.evaluate(() => window.__lodestone.probeReset());
  const mineNet0 = await netd(a);
  // 5c. A mines a vein in the deepest chamber.
  const veins = await a.evaluate((si) => window.__lodestoneCaves.veins(si), cave.index);
  const pA = (await pl(a)).pos;
  const cand = veins
    .map((v) => {
      const nl = Math.hypot(v.nx, v.nz) || 1;
      const st = { x: v.x + (v.nx / nl) * 2.4, z: v.z + (v.nz / nl) * 2.4 };
      return { ...v, st, d: Math.hypot(st.x - pA.x, st.z - pA.z), dy: v.y - pA.y };
    })
    .filter((v) => v.dy > -1 && v.dy < 4)
    .sort((p, q) => p.d - q.d);
  let mined = null;
  for (const v of cand.slice(0, 4)) {
    const w = await walkTo(a, v.st.x, v.st.z, { stopAt: 0.5, timeoutMs: 60000 });
    const p = (await pl(a)).pos;
    await look(a, yawTo(p, v.x, v.z), Math.atan2(v.y - (p.y + 1.8), Math.hypot(v.x - p.x, v.z - p.z)));
    await sleep(600);
    const tgt = await a.evaluate(() => window.__lodestoneCaves.info().target);
    step(`  vein ${v.id} (${v.kind} ${v.material}, ${v.d.toFixed(1)} m away): walked ${w.ok ? 'there' : 'partway'}; target ${tgt}`);
    if (!tgt) continue;
    await shot(a, 'vein-before-A');
    const toasts = new Set();
    let swings = 0;
    for (; swings < 30; swings++) {
      await a.keyboard.press('KeyE');
      await sleep(330);
      const txt = await a.evaluate(() => document.body.innerText);
      for (const m of txt.match(/Vein broken|\+\d+ [^\n·]+/g) ?? []) toasts.add(m.trim());
      const t = await a.evaluate(() => window.__lodestoneCaves.info().target);
      if (t !== tgt) break;
    }
    // Pickups fly to the miner (owner-only, auto-pickup); wait for the grant toast.
    for (let i = 0; i < 25 && ![...toasts].some((x) => x.startsWith('+')); i++) {
      await sleep(200);
      const txt = await a.evaluate(() => document.body.innerText);
      for (const m of txt.match(/Vein broken|\+\d+ [^\n·]+/g) ?? []) toasts.add(m.trim());
    }
    await shot(a, 'vein-mined-A');
    mined = { vein: v.id, kind: v.kind, material: v.material, target: tgt, swings: swings + 1, toasts: [...toasts] };
    break;
  }
  result.mining = mined;
  const zoneLog = fs.readFileSync(path.join(TMP, 'zone.log'), 'utf8').split('\n');
  const mineLines = zoneLog.filter((l) => /vein|drop|grant|pickup/i.test(l)).slice(-12);
  result.mining = { ...mined, zoneLog: mineLines };
  step(`mining: ${JSON.stringify(mined)}`);
  for (const l of mineLines) step(`  zone: ${l.slice(0, 300)}`);
  check(!!mined && mined.toasts.some((t) => /Vein broken/.test(t)), `${NAMES.A} mined a vein (${mined?.material ?? '?'} ${mined?.kind ?? ''}, ${mined?.swings ?? 0} swings): "Vein broken"`);
  check(!!mined && mined.toasts.some((t) => t.startsWith('+')) && mineLines.some((l) => /grant/i.test(l)), `...and got the drop: ${mined?.toasts.filter((t) => t.startsWith('+')).join(', ')} (zone granted it)`);
  {
    const pr = await a.evaluate(() => window.__lodestone.probe());
    const n1 = await netd(a);
    result.miningPrediction = { maxCm: r2(pr.maxDivM * 100), corrections: n1.reconciles - mineNet0.reconciles, mismatches: pr.mismatches.slice(0, 6) };
    step(`mining prediction (${NAMES.A}, the carve reshapes the floor around the vein; the client learns of it one round trip after the zone): ${JSON.stringify(result.miningPrediction)}`);
  }

  result.caveSamples = caveSamples;
  result.voiceSamples = samples;
  item = 'general';
  const errors = consoleLog.filter((l) => /pageerror/.test(l));
  fs.writeFileSync(path.join(EVIDENCE, 'g3-acceptance-console.txt'), consoleLog.join('\n') + '\n');
  check(errors.length === 0, 'no page errors in either browser', errors.slice(0, 5));
} catch (e) {
  failures.push(String(e));
  step(`ERROR ${e.stack ?? e}`);
  for (const [i, br] of browsers.entries()) {
    try {
      const pg = br.contexts()[0]?.pages()[0];
      if (pg) await pg.screenshot({ path: path.join(TMP, `error-${i}.png`) });
    } catch {}
  }
} finally {
  stopping = true;
  for (const br of browsers) await br.close().catch(() => {});
  for (const c of children) killTree(c);
  if (earshot.proc) killTree(earshot.proc);
  await sleep(500);
  if (!KEEP_DB) {
    try {
      goSync(['run', './server/account/cmd/devdb', 'drop', DB]);
      step(`dropped ${DB}`);
    } catch (e) {
      step(`could not drop ${DB}: ${e.message}`);
    }
  }
  const summary = Object.entries(verdicts).map(([k, v]) => `${k}: ${v.every(Boolean) ? 'PASS' : 'FAIL'} (${v.filter(Boolean).length}/${v.length})`);
  step('summary: ' + summary.join(' | '));
  step(failures.length ? `FAILED: ${failures.join('; ')}` : 'ALL PASS');
  result.verdicts = verdicts;
  result.screenshots = shots;
  fs.writeFileSync(path.join(EVIDENCE, 'g3-acceptance.txt'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(EVIDENCE, 'g3-acceptance.json'), JSON.stringify(result, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1) + '\n');
  process.exit(failures.length ? 1 : 0);
}
