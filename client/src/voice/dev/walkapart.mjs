#!/usr/bin/env node
// WP11 acceptance, second half (spec 15): "two people walking apart hear
// each other fade and pan correctly". Two headless Chromium processes with a
// fake microphone (a steady tone, so loudness changes come only from the
// voice graph) sign in with dev auth, join the same zone, both hold V, and B
// walks a scripted path past A: ahead of A, then off to A's right until
// out of earshot, then back across A's front to A's left. Every 100 ms the
// test records, from A's browser: the speaker's panner position (B's
// interpolated head), its position in A's ears' frame, the inverse-distance
// gain, the low-pass, the analyser level, the left/right RMS of what A's
// AudioContext actually outputs, and whether A is subscribed to B; plus B's
// true position from B's browser and the zone's speaking bit.
//
// Real processes: account, director, zone, social (Go), Vite, LiveKit
// (docker compose, or --livekit), two Chromium instances. Scratch database,
// private ports.
//
//   node client/src/voice/dev/walkapart.mjs [--livekit ws://localhost:7880]
//
// Evidence: docs/evidence/wp11-walkapart.txt, wp11-walkapart.json,
// wp11-walkapart-*.png
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
const LIVEKIT = arg('livekit', 'ws://localhost:7880');
const EVIDENCE = path.join(root, 'docs', 'evidence');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-wp11-'));
const DB = 'lodestone_wp04_wp11voice'; // devdb only manages lodestone_wp04_* scratch databases
const PORT = { account: 18691, director: 18690, zone: 18692, social: 18693, vite: 5196 };
const EXE = process.platform === 'win32' ? '.exe' : '';
const ZONE_ID = 'zone-wp11-voice';
const NAMES = { A: 'Aria', B: 'Bram' };

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

/**
 * The fake microphone: 40 s of a steady 220 Hz voice-like tone (fundamental
 * plus harmonics, constant amplitude), 48 kHz mono 16-bit WAV. Chromium
 * loops it. Steady on purpose: any change in what A hears is the graph.
 */
function writeToneWav(file) {
  const rate = 48000;
  const n = rate * 40;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    // Harmonics of 220 Hz up to ~4.4 kHz with a gentle 1/sqrt(k) roll-off:
    // HRTF level differences between the ears live mostly above 1.5 kHz,
    // so a bass-only tone would hide the pan.
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

async function signInAndPlay(page, user, charName) {
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

const player = (page) => page.evaluate(() => window.__lodestone.player());
const voice = (page) => page.evaluate(() => window.__lodestone.voiceDebug());

/** Steer with W toward (x, z) until within 0.6 m (yaw 0 faces -Z: yaw = atan2(-dx, -dz)). */
async function walkTo(page, x, z, onTick, timeoutMs = 30000) {
  const t0 = Date.now();
  let down = false;
  try {
    for (;;) {
      const p = await player(page);
      const dx = x - p.pos.x;
      const dz = z - p.pos.z;
      if (Math.hypot(dx, dz) < 0.6 || Date.now() - t0 > timeoutMs) break;
      await page.evaluate((y) => window.__lodestone.setLook(y, 0), Math.atan2(-dx, -dz));
      if (!down) {
        await page.keyboard.down('KeyW');
        down = true;
      }
      if (onTick) await onTick();
      await sleep(40);
    }
  } finally {
    if (down) await page.keyboard.up('KeyW');
  }
}

let browsers = [];
try {
  step(`WP11 walk-apart: LiveKit ${LIVEKIT}`);
  for (const [name, port] of Object.entries(PORT)) {
    const busy = await fetch(`http://localhost:${port}/`).then(() => true, () => false);
    if (busy) throw new Error(`port ${port} (${name}) is already in use`);
  }
  const wav = path.join(TMP, 'tone.wav');
  writeToneWav(wav);
  const pgUrl = goSync(['run', './server/account/cmd/devdb', 'create', DB]).trim().split('\n').pop();
  step(`scratch database ${DB}`);
  for (const [name, pkg] of [['account', './server/account'], ['director', './server/director'], ['zone', './server/zone'], ['social', './server/social']]) goSync(['build', '-o', path.join(TMP, name + EXE), pkg]);
  step('built account, director, zone, social');
  const svcEnv = {
    LODESTONE_PG_URL: pgUrl,
    LODESTONE_ACCOUNT_PORT: String(PORT.account),
    LODESTONE_DIRECTOR_PORT: String(PORT.director),
    LODESTONE_SOCIAL_URL: `ws://localhost:${PORT.social}/ws`,
    LODESTONE_DEV_AUTH: '1',
    LODESTONE_CORS_ORIGIN: '*',
  };
  start('account', path.join(TMP, 'account' + EXE), [], svcEnv);
  check(await waitHttp(`http://localhost:${PORT.account}/healthz`, 30000), `account healthy on :${PORT.account}`);
  start('director', path.join(TMP, 'director' + EXE), [], svcEnv);
  check(await waitHttp(`http://localhost:${PORT.director}/healthz`, 30000), `director healthy on :${PORT.director}`);
  start('social', path.join(TMP, 'social' + EXE), [], { ...svcEnv, LODESTONE_SOCIAL_PORT: String(PORT.social), LODESTONE_LIVEKIT_URL: LIVEKIT });
  check(await waitHttp(`http://localhost:${PORT.social}/healthz`, 30000), `social healthy on :${PORT.social}`);
  start('zone', path.join(TMP, 'zone' + EXE), [], {
    ...svcEnv,
    LODESTONE_ZONE_PORT: String(PORT.zone),
    LODESTONE_ZONE_ID: ZONE_ID,
    LODESTONE_ZONE_WT_ADDR: 'off',
    LODESTONE_ZONE_PUBLIC_URL: `ws://localhost:${PORT.zone}/ws`,
  });
  check(await waitHttp(`http://localhost:${PORT.zone}/healthz`, 30000), `zone healthy on :${PORT.zone}`);
  start('vite', process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT.vite), '--strictPort'], { VITE_ACCOUNT_URL: `http://localhost:${PORT.account}`, VITE_DIRECTOR_URL: `http://localhost:${PORT.director}`, VITE_SOLO: '0' }, path.join(root, 'client'));
  check(await waitHttp(`http://localhost:${PORT.vite}/`, 60000), `vite on :${PORT.vite}`);
  await sleep(6000); // zone registry heartbeat reaches the director

  const consoleLog = [];
  // Real GPU through ANGLE, as WP05/WP12 do: SwiftShader renders the terrain so
  // slowly that the movement sim (8-step backlog cap) falls behind real time.
  const GPU_ARGS = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
  const launchArgs = [...GPU_ARGS, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'];
  browsers = [await chromium.launch({ args: launchArgs }), await chromium.launch({ args: launchArgs })];
  const pages = [];
  for (const [i, br] of browsers.entries()) {
    const label = i === 0 ? 'A' : 'B';
    const ctx = await br.newContext({ viewport: { width: 1100, height: 640 }, permissions: ['microphone'] });
    const page = await ctx.newPage();
    page.on('console', (m) => consoleLog.push(`[${label}] ${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => consoleLog.push(`[${label}] pageerror: ${e.message}`));
    await page.goto(`http://localhost:${PORT.vite}/?debug=1&autoplay=1&transport=ws&voiceRawMic=1`);
    pages.push(page);
  }
  const [a, b] = pages;
  await Promise.all([signInAndPlay(a, 'wp11aria', NAMES.A), signInAndPlay(b, 'wp11bram', NAMES.B)]);
  step('both playing');
  await Promise.all(pages.map((p) => p.waitForFunction(() => window.__lodestone.voiceDebug()?.status === 'connected', null, { timeout: 30000 })));
  const v0 = await voice(a);
  check(v0.mic === 'idle', 'microphone not requested before the first push (spec 10)', { mic: v0.mic, status: v0.status });

  // Both hold V for the whole walk (first push: the mic is requested now).
  for (const p of pages) {
    await p.mouse.click(550, 320); // a user gesture for the AudioContext, like a real click into the game
    await p.keyboard.down('KeyV');
  }
  await Promise.all(pages.map((p) => p.waitForFunction(() => window.__lodestone.voiceDebug()?.transmitting === true, null, { timeout: 20000 })));
  const vA = await voice(a);
  check(vA.mic === 'ready' && vA.transmitting, 'push-to-talk: V publishes the mic on first push and transmits while held', { mic: vA.mic, ctx: vA.contextState });

  // Geometry: A stands still facing north (yaw 0, looking down -Z). B walks
  // to 4 m in front of A, then east (A's right) to 62 m, then west across
  // A's front to 30 m on A's left.
  await a.evaluate(() => window.__lodestone.setLook(0, 0));
  const pa = (await player(a)).pos;
  await walkTo(b, pa.x, pa.z - 4);
  await sleep(2500); // subscriptions settle, interpolation catches up
  const samples = [];
  const t0 = Date.now();
  let lastSample = 0;
  const sample = async (phase) => {
    if (Date.now() - lastSample < 90) return;
    lastSample = Date.now();
    // voiceDebug and netDebug in one evaluate: the same rendered frame.
    const [{ va, na }, pb] = await Promise.all([a.evaluate(() => ({ va: window.__lodestone.voiceDebug(), na: window.__lodestone.netDebug() })), player(b)]);
    const sp = va.speakers.find((s) => s.name === NAMES.B) ?? null;
    const remote = na.remotes.find((r) => r.name === NAMES.B) ?? null;
    const truth = { x: pb.pos.x, y: pb.pos.y + 1.8, z: pb.pos.z };
    const trueDist = Math.hypot(truth.x - va.listener.x, truth.z - va.listener.z);
    const levelEl = await a.evaluate((n) => document.querySelector(`[data-testid="voice-level-${n}"]`)?.dataset.speaking ?? null, NAMES.B);
    samples.push({
      t: Date.now() - t0,
      phase,
      trueDist: +trueDist.toFixed(2),
      subscribed: !!sp,
      mode: sp?.mode ?? null,
      pannerPos: sp?.pos ? { x: +sp.pos.x.toFixed(2), y: +sp.pos.y.toFixed(2), z: +sp.pos.z.toFixed(2) } : null,
      truePos: { x: +truth.x.toFixed(2), y: +truth.y.toFixed(2), z: +truth.z.toFixed(2) },
      // The panner must sit on B's drawn (interpolated) head; the drawn
      // position itself trails B's true one by the interpolation delay.
      pannerVsDrawn: sp?.pos && remote ? +Math.hypot(sp.pos.x - remote.x, sp.pos.z - remote.z).toFixed(2) : null,
      pannerVsTrue: sp?.pos ? +Math.hypot(sp.pos.x - truth.x, sp.pos.z - truth.z).toFixed(2) : null,
      interpDelayMs: remote ? Math.round(remote.delayMs) : null,
      distance: sp?.distance != null ? +sp.distance.toFixed(2) : null,
      rel: sp?.rel ? { right: +sp.rel.right.toFixed(2), forward: +sp.rel.forward.toFixed(2) } : null,
      distanceGain: sp ? +sp.distanceGain.toFixed(4) : null,
      lowpassHz: sp?.lowpassHz ?? null,
      occluded: sp?.occluded ?? null,
      level: sp ? +sp.level.toFixed(3) : null,
      outL: va.output ? +va.output.leftDb.toFixed(1) : null,
      outR: va.output ? +va.output.rightDb.toFixed(1) : null,
      levelDomSpeaking: levelEl,
      zoneSpeakingBit: remote ? (remote.activity & 64) !== 0 : null,
      selfFlag: va.speakingFlag,
    });
  };
  await sample('ahead');
  for (let i = 0; i < 10; i++) {
    await sleep(100);
    await sample('ahead');
  }
  await a.screenshot({ path: path.join(EVIDENCE, 'wp11-walkapart-near.png') });
  await walkTo(b, pa.x + 62, pa.z - 4, () => sample('right'), 20000);
  for (let i = 0; i < 15; i++) {
    await sleep(100);
    await sample('far-right');
  }
  await a.screenshot({ path: path.join(EVIDENCE, 'wp11-walkapart-out-of-earshot.png') });
  let shotLeft = false;
  await walkTo(b, pa.x - 30, pa.z - 4, async () => {
    await sample('left');
    const last = samples[samples.length - 1];
    if (!shotLeft && last.rel && last.rel.right < -12) {
      shotLeft = true;
      await a.screenshot({ path: path.join(EVIDENCE, 'wp11-walkapart-left.png') });
    }
  }, 30000);
  for (let i = 0; i < 10; i++) {
    await sleep(100);
    await sample('far-left');
  }
  // Party radio (spec 10 "Proximity voice" 2): A invites B through chat, B
  // accepts in the party frame, then B walks on to 80 m. Past earshot B
  // stays subscribed (party) and switches to the flat radio branch.
  await a.keyboard.press('Enter');
  await a.getByTestId('chat-input').fill('/invite Bram');
  await a.keyboard.press('Enter');
  await a.keyboard.press('Escape');
  try {
    await b.getByTestId('party-accept').waitFor({ timeout: 10000 });
  } catch (e) {
    await a.screenshot({ path: path.join(TMP, 'party-a.png') });
    await b.screenshot({ path: path.join(TMP, 'party-b.png') });
    throw new Error(`no party invite on B (screenshots in ${TMP}): ${e.message}`);
  }
  await b.getByTestId('party-accept').dispatchEvent('click');
  await a.waitForFunction(() => document.querySelectorAll('[data-testid="party-member"]').length === 2, null, { timeout: 10000 });
  step('A and B are in a party');
  await sleep(2500); // the voice leader refreshes parties every 2 s
  let shotRadio = false;
  await walkTo(b, pa.x - 80, pa.z - 4, async () => {
    await sample('party');
    const last = samples[samples.length - 1];
    if (!shotRadio && last.mode === 'radio' && last.trueDist > 60) {
      shotRadio = true;
      await a.screenshot({ path: path.join(EVIDENCE, 'wp11-walkapart-party-radio.png') });
    }
  }, 20000);
  for (let i = 0; i < 10; i++) {
    await sleep(100);
    await sample('party-far');
  }
  // Settings panel (per-player volume and mute).
  const hit = await a.evaluate(() => {
    const r = document.querySelector('[data-testid="voice-settings-toggle"]').getBoundingClientRect();
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { rect: [r.x, r.y, r.width, r.height], hit: el ? `${el.tagName}.${el.getAttribute('data-testid') ?? ''}` : null };
  });
  step(`settings button hit test ${JSON.stringify(hit)}`);
  await a.getByTestId('voice-settings-toggle').dispatchEvent('click');
  await sleep(300);
  await a.screenshot({ path: path.join(EVIDENCE, 'wp11-walkapart-settings.png') });
  for (const p of pages) await p.keyboard.up('KeyV');
  await sleep(600);
  const vEnd = await voice(a);
  const dbgVoice = await (await fetch(`http://localhost:${PORT.social}/debug/voice`)).json();
  const mine = dbgVoice.worlds.filter((w) => w.stats && w.stats.participants > 0);
  step(`social /debug/voice (worlds with participants): ${JSON.stringify(mine)} applyLatencyMs ${JSON.stringify(dbgVoice.applyLatencyMs)}`);
  const socialMetrics = (await (await fetch(`http://localhost:${PORT.social}/metrics`)).text()).split('\n').filter((l) => l.startsWith('voice_'));
  const zoneMetrics = (await (await fetch(`http://localhost:${PORT.zone}/metrics`)).text()).split('\n').filter((l) => l.startsWith('zone_earshot'));
  step(`social voice metrics: ${socialMetrics.join(' | ')}`);
  step(`zone earshot metrics: ${zoneMetrics.join(' | ')}`);

  // ---- analysis ----
  // Proximity checks use the phases before the party was formed.
  const prox = samples.filter((s) => !s.phase.startsWith('party'));
  const partyFar = samples.filter((s) => s.phase.startsWith('party') && s.trueDist > 56);
  // Real terrain (WP05/WP07): a hill between the two heads muffles B (low-pass,
  // -4 dB). Fade and pan are measured on unoccluded samples; occlusion is
  // counted separately.
  const subAll = prox.filter((s) => s.subscribed && s.mode === 'spatial' && s.distance !== null);
  const sub = subAll.filter((s) => !s.occluded);
  const loud = (s) => Math.max(s.outL, s.outR);
  // Fade: output level vs distance. Expected from the model: 20*log10(gain).
  const near = sub.filter((s) => s.distance >= 3 && s.distance <= 7);
  const far = sub.filter((s) => s.distance >= 30 && s.distance <= 40);
  const avg = (xs, f) => xs.reduce((acc, x) => acc + f(x), 0) / Math.max(1, xs.length);
  const nearDb = avg(near, loud);
  const farDb = avg(far, loud);
  const expectDrop = 20 * Math.log10(avg(near, (s) => s.distanceGain) / Math.max(1e-6, avg(far, (s) => s.distanceGain)));
  // Rank correlation of distance with level (should be strongly negative).
  const rank = (xs) => {
    const idx = xs.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(xs.length);
    idx.forEach(([, i], k) => (r[i] = k));
    return r;
  };
  const spearman = (xs, ys) => {
    const rx = rank(xs);
    const ry = rank(ys);
    const n = xs.length;
    let d2 = 0;
    for (let i = 0; i < n; i++) d2 += (rx[i] - ry[i]) ** 2;
    return 1 - (6 * d2) / (n * (n * n - 1));
  };
  const fadeSamples = sub.filter((s) => s.distance >= 2.5);
  const rho = spearman(fadeSamples.map((s) => s.distance), fadeSamples.map(loud));
  // Pan: right side vs left side, by the speaker's position in A's ears' frame.
  const rightSide = sub.filter((s) => s.rel && s.rel.right > 8 && Math.abs(s.rel.forward) < s.rel.right);
  const leftSide = sub.filter((s) => s.rel && s.rel.right < -8 && Math.abs(s.rel.forward) < -s.rel.right);
  const panRight = avg(rightSide, (s) => s.outR - s.outL);
  const panLeft = avg(leftSide, (s) => s.outL - s.outR);
  // The louder ear follows the side B is on, sample by sample, whenever B is
  // clearly off-centre (|sin azimuth| > 0.5) and audible. (HRTF level
  // differences are not monotonic in azimuth, so this checks the side and
  // the averages above check the size.)
  const sideSamples = sub.filter((s) => s.rel && s.distance > 3 && loud(s) > -70 && Math.abs(s.rel.right / Math.hypot(s.rel.right, s.rel.forward)) > 0.5);
  const sideAgree = sideSamples.filter((s) => Math.sign(s.outR - s.outL) === Math.sign(s.rel.right)).length;
  // Earshot. Past the 48 m leave radius plus 0.5 s of walking (decision
  // interval + reconcile), A must hear nothing: output at silence. The
  // TrackUnsubscribed event itself arrives ~1 s later (LiveKit keeps the
  // transceiver for its downtrack flush), so the subscription check uses
  // 48 m + 1.75 s of walking. Inside 38 m A must always be subscribed.
  const silentFrom = 48 + 4.9 * 0.5;
  const beyondSilent = prox.filter((s) => s.trueDist > silentFrom + 1);
  const silentDb = -70;
  const beyond = prox.filter((s) => s.trueDist > 48 + 4.9 * 1.75);
  const inside = prox.filter((s) => s.trueDist < 38);
  const q = (xs) => {
    const s = [...xs].sort((x, y) => x - y);
    return { p50: s[Math.floor(s.length / 2)] ?? null, p95: s[Math.floor(s.length * 0.95)] ?? null, max: s.length ? s[s.length - 1] : null };
  };
  const pannerVsDrawn = sub.map((s) => s.pannerVsDrawn).filter((x) => x !== null);
  const pannerVsTrue = sub.map((s) => s.pannerVsTrue).filter((x) => x !== null);
  const speakingDom = samples.filter((s) => s.subscribed && s.levelDomSpeaking === '1').length;
  const zoneBit = samples.filter((s) => s.zoneSpeakingBit === true).length;

  const result = {
    livekit: LIVEKIT,
    samples: samples.length,
    fade: { nearDb: +nearDb.toFixed(1), farDb: +farDb.toFixed(1), dropDb: +(nearDb - farDb).toFixed(1), expectedDropDb: +expectDrop.toFixed(1), spearmanDistanceVsLevel: +rho.toFixed(3), nNear: near.length, nFar: far.length },
    pan: { rightSideRminusLdb: +panRight.toFixed(1), leftSideLminusRdb: +panLeft.toFixed(1), nRight: rightSide.length, nLeft: leftSide.length, louderEarOnSpeakersSide: `${sideAgree}/${sideSamples.length}` },
    earshot: {
      silentBeyondM: +(silentFrom + 1).toFixed(1),
      samplesBeyondSilent: beyondSilent.length,
      audibleBeyondSilent: beyondSilent.filter((s) => loud(s) > silentDb).length,
      unsubscribedBeyondM: +(48 + 4.9 * 1.75).toFixed(1),
      samplesBeyond: beyond.length,
      subscribedBeyond: beyond.filter((s) => s.subscribed).length,
      samplesInside38m: inside.length,
      unsubscribedInside38m: inside.filter((s) => !s.subscribed).length,
    },
    pannerVsDrawnHeadM: q(pannerVsDrawn),
    pannerVsTrueHeadM: q(pannerVsTrue),
    speakingIndicator: { domSpeakingSamples: speakingDom, zoneSpeakingBitSamples: zoneBit },
    occlusion: { subscribedSamples: subAll.length, occludedSamples: subAll.length - sub.length },
    partyRadio: {
      samplesBeyond56m: partyFar.length,
      subscribed: partyFar.filter((s) => s.subscribed).length,
      radioMode: partyFar.filter((s) => s.mode === 'radio').length,
      audible: partyFar.filter((s) => loud(s) > silentDb).length,
      meanAbsRminusLdb: +avg(partyFar, (s) => Math.abs(s.outR - s.outL)).toFixed(2),
      meanLevelDb: +avg(partyFar, loud).toFixed(1),
    },
    end: { mic: vEnd.mic, transmitting: vEnd.transmitting, ctx: vEnd.contextState },
    timeline: samples,
  };
  fs.writeFileSync(path.join(EVIDENCE, 'wp11-walkapart.json'), JSON.stringify(result, null, 1) + '\n');
  step(`samples ${samples.length}; fade ${JSON.stringify(result.fade)}; pan ${JSON.stringify(result.pan)}`);
  step(`earshot ${JSON.stringify(result.earshot)}; panner vs drawn ${JSON.stringify(result.pannerVsDrawnHeadM)}, vs true ${JSON.stringify(result.pannerVsTrueHeadM)}; speaking ${JSON.stringify(result.speakingIndicator)}`);
  check(vA.contextState === 'running', "A's AudioContext is running (output meters are live)", { ctx: vA.contextState });
  check(near.length > 3 && far.length > 3 && nearDb - farDb > 12, 'fade: B is >12 dB quieter at 30-40 m than at 3-7 m (inverse distance, ref 2 m)', result.fade);
  check(rho < -0.8, 'fade: output level falls steadily with distance (Spearman < -0.8)', { rho: result.fade.spearmanDistanceVsLevel });
  check(rightSide.length > 3 && panRight > 3, "pan: B on A's right is louder in A's right ear (HRTF)", result.pan);
  check(leftSide.length > 3 && panLeft > 3, "pan: B on A's left is louder in A's left ear", result.pan);
  check(sideSamples.length > 20 && sideAgree >= 0.95 * sideSamples.length, "pan: the louder ear is on B's side in >= 95% of off-centre samples", result.pan);
  check(beyondSilent.length > 3 && result.earshot.audibleBeyondSilent === 0, `earshot: A hears nothing (output < ${silentDb} dB) once B is past 48 m + 0.5 s of walking`, result.earshot);
  check(beyond.length > 3 && result.earshot.subscribedBeyond === 0, "earshot: A's subscription to B is gone past 48 m + 1.75 s of walking (LiveKit's 1 s flush included)", result.earshot);
  check(inside.length > 10 && result.earshot.unsubscribedInside38m <= 6, 'earshot: A hears B whenever B is within 38 m (allowing the re-subscribe moment)', result.earshot);
  check(pannerVsDrawn.length > 10 && result.pannerVsDrawnHeadM.max < 0.5, "the panner sits on B's interpolated head as drawn (within 0.5 m, sampled a frame apart)", result.pannerVsDrawnHeadM);
  check(pannerVsTrue.length > 10 && result.pannerVsTrueHeadM.p95 < 2.5, "...which trails B's true head only by the interpolation delay (p95 < 2.5 m at 4.9 m/s)", result.pannerVsTrueHeadM);
  check(speakingDom > 0, "speaking indicator: A's DOM level bar for B shows data-speaking=1 (analyser, outside React)", result.speakingIndicator);
  check(zoneBit > 0, "speaking bit: A sees B's Activity.speaking from the zone while B holds V", result.speakingIndicator);
  const errors = consoleLog.filter((l) => /pageerror/.test(l));
  fs.writeFileSync(path.join(EVIDENCE, 'wp11-walkapart-console.txt'), consoleLog.join('\n') + '\n');
  const pr = result.partyRadio;
  check(pr.samplesBeyond56m > 5 && pr.subscribed === pr.samplesBeyond56m && pr.radioMode === pr.samplesBeyond56m, 'party radio: past earshot a party member stays subscribed and plays through the radio branch', pr);
  check(pr.audible === pr.samplesBeyond56m && pr.meanAbsRminusLdb < 1.5, 'party radio: audible and flat (no pan, no distance loss)', pr);
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
  fs.writeFileSync(path.join(EVIDENCE, 'wp11-walkapart.txt'), lines.join('\n') + '\n');
  process.exit(failures.length ? 1 : 0);
}
