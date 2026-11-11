#!/usr/bin/env node
/* global navigator, localStorage */
// Playtest 2 voice settings: the Voice panel in the real client, two players
// on a private stack with LiveKit (one Chromium, two contexts, fake
// microphones), so the meter, the players list and the WebRTC stats are live.
//
//   node tools/playtest/stack.mjs                 (social uses LiveKit at ws://localhost:7880: `npm run infra:up`)
//   LODESTONE_CLIENT_URL=<url> node tools/playtest/voice-settings-shots.mjs [outDir]
//
// Screenshots: docs/evidence/pt2-voice-settings-*.jpg; checks: <outDir>/report.json
// and docs/evidence/pt2-voice-settings.txt.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, sleep } from './lib.mjs';

const require = createRequire(new URL('../../client/package.json', import.meta.url));
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EVIDENCE = path.join(ROOT, 'docs/evidence');
const OUT = process.argv[2] ?? path.join(ROOT, 'tmp/voice-settings');
mkdirSync(OUT, { recursive: true });

const log = [];
const checks = [];
const note = (m) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`;
  console.log(line);
  log.push(line);
};
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail });
  note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};

async function newCharacter(page, name) {
  await page.goto(BASE + '/');
  await page.getByTestId('play').click({ timeout: 5000 }).catch(() => {});
  await page.getByTestId('account-screen').waitFor({ timeout: 120000 });
  await page.getByTestId('auth-local').click();
  await page.getByTestId('char-name').waitFor({ timeout: 30000 });
  await page.getByTestId('char-name').fill(name);
  await page.getByTestId('char-create').click();
  await page.getByTestId(`play-${name}`).click();
  await page.waitForFunction(() => window.__lodestone?.netDebug?.()?.phase === 'playing', null, { timeout: 120000 });
}

const voice = (p) => p.evaluate(() => window.__lodestone.voiceDebug?.() ?? null);
const shot = async (p, name) => {
  const f = path.join(EVIDENCE, `pt2-voice-settings-${name}.jpg`);
  await p.screenshot({ path: f, type: 'jpeg', quality: 72 });
  note(`shot ${path.relative(ROOT, f)}`);
};
const text = (p, id) => p.getByTestId(id).innerText().catch(() => '');
const dismissCards = async (p) => {
  // A first-time welcome / What's new card or a tip may sit over the HUD.
  for (const id of ['whatsnew-close', 'tip-close']) await p.getByTestId(id).click({ timeout: 500 }).catch(() => {});
};

/**
 * The fake microphone: a steady voice-like tone (220 Hz and harmonics, as in
 * voice/dev/walkapart.mjs) at about -21 dBFS RMS, so level changes come from
 * the settings, not from Chromium's default once-a-second beep.
 */
function writeToneWav(file) {
  const rate = 48000;
  const n = rate * 20;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let s = 0;
    for (let k = 1; k <= 20; k++) s += Math.sin(2 * Math.PI * 220 * k * t + k) / Math.sqrt(k);
    data.writeInt16LE(Math.round(s * 0.05 * 32767), i * 2);
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
  writeFileSync(file, Buffer.concat([h, data]));
}
const WAV = path.join(OUT, 'tone.wav');
writeToneWav(WAV);

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}`],
});
let exitCode = 0;
try {
  const mk = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.grantPermissions(['microphone', 'clipboard-read', 'clipboard-write'], { origin: BASE });
    // A returning player: no welcome / What's new card over the panel.
    const newest = JSON.parse(readFileSync(path.join(ROOT, 'client/src/ui/whatsnew/changelog.json'), 'utf8'))[0].id;
    await ctx.addInitScript((id) => localStorage.setItem('lodestone_whatsnew_seen', id), newest);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => note(`pageerror: ${e.message}`));
    return page;
  };
  const a = await mk();
  const b = await mk();
  const tag = Date.now().toString(36).slice(-4);
  const nameA = `Vox${tag}a`;
  const nameB = `Vox${tag}b`;
  await newCharacter(a, nameA);
  note(`A in world as ${nameA}`);
  await newCharacter(b, nameB);
  note(`B in world as ${nameB}`);
  for (const p of [a, b]) await p.waitForFunction(() => window.__lodestone.voiceDebug?.()?.status === 'connected', null, { timeout: 60000 });
  check('both connected to LiveKit', true);
  // Both talk (hold V): B so A hears a speaker, A so A has publisher stats.
  await b.keyboard.down('KeyV');
  await a.keyboard.down('KeyV');
  const heard = await a.waitForFunction(() => (window.__lodestone.voiceDebug?.()?.speakers ?? []).length > 0, null, { timeout: 60000 }).then(
    () => true,
    () => false,
  );
  if (!heard) {
    const dbg = async (p) => {
      const v = await voice(p);
      const pos = await p.evaluate(() => window.__lodestone.player().pos);
      return { status: v?.status, mic: v?.mic, transmitting: v?.transmitting, speakers: v?.speakers?.length, pos };
    };
    note(`not heard: A ${JSON.stringify(await dbg(a))} B ${JSON.stringify(await dbg(b))}`);
  }
  await a.waitForFunction(() => window.__lodestone.voiceDebug?.()?.transmitting === true, null, { timeout: 15000 }).catch(() => {});
  // ...and drawn (spatial, with a distance) once B's avatar streams in.
  await a.waitForFunction(() => (window.__lodestone.voiceDebug?.()?.speakers ?? []).some((s) => s.mode === 'spatial' && s.distance !== null), null, { timeout: 20000 }).catch(() => {});
  const vA = await voice(a);
  check('A hears B (subscribed in earshot)', vA.speakers.some((s) => s.name === nameB), vA.speakers.map((s) => `${s.name} ${s.mode} ${s.distance?.toFixed(1)} m`).join(', '));
  check('A transmits while V is held', vA.transmitting && vA.mic === 'ready');
  await dismissCards(a);
  if (await a.getByTestId('debug-hud').count()) await a.keyboard.press('F3'); // the dev readout off for the pictures

  // --- Microphone tab
  await a.getByTestId('voice-settings-toggle').dispatchEvent('click');
  await a.getByTestId('voice-settings').waitFor();
  check('panel is on the panel stack', (await a.evaluate(() => window.__lodestonePanels.open())).includes('voice'));
  await a.getByTestId('voice-tab-mic').click();
  await sleep(800);
  const inputs = await a.evaluate(() => [...document.querySelectorAll('[data-testid="voice-input-device"] option')].map((o) => ({ v: o.value, t: o.textContent })));
  check('microphones listed with names', inputs.length > 0 && inputs.every((o) => o.t), inputs.map((o) => o.t).join(' | '));
  await shot(a, 'mic');

  // Open mic: the threshold line on the live meter.
  await a.getByTestId('voice-mode-vad').check();
  await a.getByTestId('voice-vad-threshold').fill('-48');
  await sleep(1500);
  const meter = await a.evaluate(() => {
    const m = document.querySelector('[data-testid="voice-meter"]');
    return { live: m?.dataset.live, rms: Number(m?.dataset.rms), line: !!document.querySelector('[data-testid="voice-threshold-line"]'), gate: document.querySelector('[data-testid="voice-gate"]')?.textContent };
  });
  check('live meter reads the microphone (post-boost)', meter.live === '1' && Number.isFinite(meter.rms), `rms ${meter.rms} dBFS, gate ${meter.gate}`);
  check('threshold line shown in open-mic mode', meter.line);
  const stored = await a.evaluate(() => JSON.parse(localStorage.getItem('lodestone.voice.v1')));
  check('open mic + threshold saved', stored.talkMode === 'vad' && stored.vadThresholdDb === -48);
  await a.getByTestId('voice-meter').scrollIntoViewIfNeeded();
  await shot(a, 'meter');

  // Input boost applies live (the meter rises ~12 dB).
  const rmsAt = async () => {
    const xs = [];
    for (let i = 0; i < 12; i++) {
      xs.push(await a.evaluate(() => window.__lodestone.voiceDebug().selfDb));
      await sleep(120);
    }
    return Math.max(...xs.filter((x) => x !== null));
  };
  const before = await rmsAt();
  await a.getByTestId('voice-input-gain').fill('12');
  await sleep(400);
  const after = await rmsAt();
  check('input boost +12 dB raises the level live', after - before > 6, `${before.toFixed(1)} -> ${after.toFixed(1)} dBFS`);
  await a.getByTestId('voice-input-gain').fill('0');

  // Browser processing toggle re-acquires the track.
  await a.getByTestId('voice-ns').uncheck();
  await sleep(1200);
  let nsOff = null;
  for (let i = 0; i < 10; i++) {
    nsOff = await a.evaluate(() => window.__lodestone.voiceDiagnostics?.());
    if (nsOff?.mic?.settings?.noiseSuppression === false) break;
    await sleep(500);
  }
  check('noise suppression off re-acquires the microphone', nsOff?.mic?.settings?.noiseSuppression === false, `${JSON.stringify(nsOff?.mic?.settings ?? 'n/a')} errors ${JSON.stringify(nsOff?.errors ?? [])}`);
  check('the microphone still sends after the restart', (await rmsAt()) > -60);
  await a.getByTestId('voice-ns').check();

  // Another microphone: the published track restarts on it, and the choice is saved by id and name.
  const other = inputs.find((o) => o.v !== 'default' && !/default/i.test(o.t));
  if (other) {
    await a.getByTestId('voice-input-device').selectOption(other.v);
    let label = '';
    for (let i = 0; i < 10 && label !== other.t; i++) {
      await sleep(500);
      label = (await a.evaluate(() => window.__lodestone.voiceDiagnostics()))?.mic?.deviceLabel;
    }
    const saved = await a.evaluate(() => JSON.parse(localStorage.getItem('lodestone.voice.v1')).inputDevice);
    check('switching microphone restarts the track on it (and saves id + name)', label === other.t && saved?.label === other.t, `${label}; saved ${JSON.stringify(saved)}`);
    await a.getByTestId('voice-input-device').selectOption('default');
    await sleep(800);
  }

  // Back to push to talk; rebind: E is refused, 8 is taken, then reset.
  await a.getByTestId('voice-mode-ptt').check();
  await a.getByTestId('voice-key-ptt-change').click();
  await a.keyboard.press('KeyE');
  const err = await text(a, 'voice-key-ptt-error');
  check('rebinding to E is refused (talk, trade, doors...)', /already does/.test(err), err);
  await a.keyboard.press('Digit8');
  await sleep(200);
  check('rebinding to 8 works', (await text(a, 'voice-key-ptt')) === '8');
  await a.getByTestId('voice-ptt-toggle').click();
  await shot(a, 'keybind');
  // B is unaffected; A's talk key is now 8 (toggle): tap once = talk.
  await a.keyboard.up('KeyV');
  await a.keyboard.press('Digit8');
  await sleep(500);
  check('toggle mode: one tap of 8 starts talking', (await voice(a)).transmitting);
  await a.keyboard.press('Digit8');
  await sleep(500);
  check('toggle mode: the next tap stops', !(await voice(a)).transmitting);
  await a.getByTestId('voice-ptt-hold').click();
  await a.evaluate(() => document.querySelector('[data-testid="voice-key-ptt"]')?.parentElement?.querySelectorAll('button')[1]?.click()); // Reset (V)
  await sleep(200);
  check('reset to V', (await text(a, 'voice-key-ptt')) === 'V');
  await a.keyboard.down('KeyV');

  // --- Test tab
  await a.getByTestId('voice-tab-test').click();
  await a.getByTestId('voice-test-start').click();
  await a.waitForFunction(() => document.querySelector('[data-testid="voice-test-meter"]')?.dataset.live === '1', null, { timeout: 10000 });
  await a.getByTestId('voice-loopback').check();
  await a.getByTestId('voice-loopback-delay').fill('500');
  await a.getByTestId('voice-record').click();
  await sleep(1500);
  await shot(a, 'test');
  await a.waitForFunction(() => ['playing', 'recorded'].includes(document.querySelector('[data-testid="voice-record-phase"]')?.dataset.phase), null, { timeout: 15000 });
  check('record 5 s and play back', true, await text(a, 'voice-record-phase'));
  await a.getByTestId('voice-test-stop').click();

  // --- Players tab
  await a.getByTestId('voice-tab-players').click();
  await a.getByTestId(`voice-peer-${nameB}`).waitFor({ timeout: 10000 });
  await a.getByTestId(`voice-peer-volume-${nameB}`).fill('50');
  await sleep(500);
  const vol = (await voice(a)).speakers.find((s) => s.name === nameB);
  check("B's volume 50 % applies to the mixer", vol && Math.abs(vol.volume - 0.5) < 0.08, `gain ${vol?.volume?.toFixed(2)}`);
  const peers = await a.evaluate(() => JSON.parse(localStorage.getItem('lodestone.voice.v1')).peers);
  check('saved by character id', Object.values(peers).some((p) => p.name === nameB && p.volume === 0.5), JSON.stringify(peers));
  await shot(a, 'players');

  // --- Diagnostics tab
  await a.getByTestId('voice-tab-diag').click();
  await sleep(3500); // two stats readings for bitrate
  const diag = {};
  for (const k of ['room-state', 'server', 'codec', 'bitrate', 'packet-loss', 'jitter', 'round-trip', 'path', 'may-talk-token-', 'mic-permission', 'sample-rate', 'reconnects']) diag[k] = await text(a, `diag-${k}`);
  note(`diagnostics: ${JSON.stringify(diag)}`);
  check('room state connected', diag['room-state'] === 'connected');
  check('codec opus', /^opus/.test(diag.codec), diag.codec);
  check('bitrate measured', /kbps/.test(diag.bitrate), diag.bitrate);
  check('round trip measured', /ms/.test(diag['round-trip']), diag['round-trip']);
  check('token grant and permission shown', diag['may-talk-token-'] === 'yes' && diag['mic-permission'] === 'granted');
  const row = await text(a, `diag-speaker-${nameB}`);
  check('speaker row with level and stats', row.includes(nameB) && /kbps/.test(row), row.replace(/\s+/g, ' '));
  await shot(a, 'diagnostics');
  await a.getByTestId('voice-diagnostics').evaluate((el) => el.parentElement.scrollTo(0, 99999));
  await sleep(200);
  await shot(a, 'diagnostics-2');
  await a.getByTestId('voice-diag-copy').click();
  await sleep(300);
  const clip = await a.evaluate(() => navigator.clipboard.readText());
  let parsed = null;
  try {
    parsed = JSON.parse(clip);
  } catch {
    /* checked below */
  }
  check('Copy diagnostics: JSON on the clipboard, no token', parsed && parsed.publisher?.codec === 'opus' && !/eyJ[A-Za-z0-9_-]{20,}\./.test(clip), `${clip.length} chars`);
  writeFileSync(path.join(OUT, 'diagnostics.json'), clip);
  const rc0 = parsed?.room?.reconnects ?? 0;
  await a.getByTestId('voice-diag-reconnect').click();
  await a.waitForFunction(() => window.__lodestone.voiceDebug()?.status === 'connected', null, { timeout: 30000 });
  await sleep(2500);
  const rc = await text(a, 'diag-reconnects');
  check('Reconnect voice reconnects and counts it', Number(rc) > rc0, `reconnects ${rc0} -> ${rc}`);
  await a.waitForFunction(() => (window.__lodestone.voiceDebug()?.speakers ?? []).length > 0, null, { timeout: 20000 }).catch(() => {});
  check('hears B again after the reconnect', (await voice(a)).speakers.length > 0);

  // --- Mute key, Esc, Esc menu, Sound panel
  await a.keyboard.up('KeyV');
  await a.getByTestId('voice-settings-close').click();
  await a.mouse.click(640, 400);
  await a.keyboard.press('Digit0');
  await sleep(500);
  const m = await voice(a);
  check('0 mutes the microphone', m.micMuted && !m.transmitting);
  await a.keyboard.down('KeyV');
  await sleep(500);
  check('V does not transmit while muted', !(await voice(a)).transmitting, await text(a, 'voice-ptt'));
  await shot(a, 'muted-hud');
  await a.keyboard.up('KeyV');
  await a.keyboard.press('Digit0');
  await sleep(300);
  check('0 unmutes', !(await voice(a)).micMuted);

  await a.keyboard.press('Escape');
  await a.getByTestId('esc-menu').waitFor({ timeout: 5000 });
  await a.getByTestId('menu-entry-voice').click();
  await a.getByTestId('voice-settings').waitFor({ timeout: 5000 });
  check('Esc menu > Voice opens the panel', true);
  await a.keyboard.press('Escape');
  await sleep(300);
  check('Esc closes the panel (top of the stack)', (await a.getByTestId('voice-settings').count()) === 0);
  await a.getByTestId('sound-toggle').click();
  await a.getByTestId('sound-voice-settings').click();
  check('Sound panel > Voice settings opens the panel', (await a.getByTestId('voice-settings').count()) === 1);
  await a.keyboard.press('Escape');
  await b.keyboard.up('KeyV');
} catch (e) {
  exitCode = 1;
  note(`ERROR ${e.stack ?? e}`);
} finally {
  const failed = checks.filter((c) => !c.ok);
  const summary = `${checks.length - failed.length}/${checks.length} checks pass`;
  note(summary);
  writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ checks, log }, null, 2));
  writeFileSync(path.join(EVIDENCE, 'pt2-voice-settings.txt'), [`Playtest 2 voice settings: two players (fake microphones) on a private stack with LiveKit, ${new Date().toISOString()}`, summary, '', ...checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? `: ${c.detail}` : ''}`), ''].join('\n'));
  await browser.close();
  process.exit(exitCode || (failed.length ? 1 : 0));
}
