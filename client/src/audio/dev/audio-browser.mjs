#!/usr/bin/env node
// Headless-Chromium acceptance for the audio system (solo build, no servers):
//   1. no AudioContext exists before the Play click; the first one is made
//      inside that user gesture and runs;
//   2. no audio file is requested before the first playable frame (spec 12);
//   3. the music follows the world: day -> night (world clock) -> cave,
//      each audible on the master analyser;
//   4. SFX play for real movement (walking, jumping) and for triggers /
//      zone events (swing, spell, level-up, Bitchin' loot, dusk);
//   5. the settings panel (K) persists volumes and mute silences the master.
//   node client/src/audio/dev/audio-browser.mjs  -> docs/evidence/audio-headless.txt (+ audio-settings.png)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { env, killTree, root, waitHttp } from '../../../../scripts/lib.mjs';

const freePort = () =>
  new Promise((res) => {
    const s = net.createServer().listen(0, () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });

const PORT = await freePort();
const lines = [];
const log = (s) => {
  console.log(s);
  lines.push(s);
};
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};

// node_modules may live above a worktree checkout: walk up for vite.
let viteBin = '';
for (let d = root; !viteBin; d = path.dirname(d)) {
  const c = path.join(d, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(c)) viteBin = c;
  else if (path.dirname(d) === d) throw new Error('vite not found');
}
// A production build (solo flags, so the debug handles exist) served by
// `vite preview`: the shape players get (hashed /assets/ audio), and far
// lighter than the dev server in a headless SwiftShader page.
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-audio-'));
const built = spawnSync(process.execPath, [viteBin, 'build', '--outDir', outDir, '--emptyOutDir'], { cwd: path.join(root, 'client'), env: env({ VITE_SOLO: '1' }), stdio: 'ignore' });
if (built.status !== 0) throw new Error('vite build failed');
const vite = spawn(process.execPath, [viteBin, 'preview', '--outDir', outDir, '--port', String(PORT), '--strictPort'], { cwd: path.join(root, 'client'), env: env({ VITE_SOLO: '1' }), stdio: 'ignore' });
let browser;
try {
  if (!(await waitHttp(`http://localhost:${PORT}/`, 60000))) throw new Error('vite preview did not start');
  browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 650 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Record every AudioContext construction and whether a user gesture was active.
  await page.addInitScript(() => {
    const Orig = window.AudioContext;
    window.__ctxLog = [];
    window.AudioContext = class extends Orig {
      constructor(...a) {
        super(...a);
        window.__ctxLog.push({ t: performance.now(), activation: navigator.userActivation?.isActive ?? null });
      }
    };
  });
  const audioRequests = [];
  page.on('request', (r) => {
    if (/\.(ogg|m4a)(\?|$)/.test(r.url())) audioRequests.push(Date.now());
  });
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForTimeout(500);
  const before = await page.evaluate(() => window.__ctxLog.length);
  check('no AudioContext before the Play gesture', before === 0, `${before} created`);
  await page.getByTestId('play').click();
  await page.getByTestId('debug-hud').waitFor({ timeout: 120000 });
  await page.waitForFunction(() => window.__lodestoneAudio && window.__lodestoneAudio.state().ctxState, null, { timeout: 60000 });
  const ctxLog = await page.evaluate(() => window.__ctxLog);
  const st0 = await page.evaluate(() => window.__lodestoneAudio.state());
  check('one AudioContext, created inside the Play click, running', ctxLog.length === 1 && ctxLog[0].activation === true && st0.ctxState === 'running', `created ${ctxLog.length}, activation ${ctxLog[0]?.activation}, state ${st0.ctxState}`);

  // Spec 12: no audio before the first playable frame (requests seen by the
  // browser, wall clock; resource timing is no use in dev, whose buffer fills with modules).
  await page.waitForFunction(() => window.__lodestoneAudio.state().preloaded, null, { timeout: 240000 }).catch(() => {});
  const fpEpoch = await page.evaluate(() => performance.timeOrigin + window.__lodestoneWorld.stats().firstPlayableMs);
  const firstAudio = audioRequests.length ? Math.min(...audioRequests) : null;
  check('no audio requested before the first playable frame', firstAudio !== null && firstAudio > fpEpoch, `first audio request ${firstAudio === null ? 'none' : `${((firstAudio - fpEpoch) / 1000).toFixed(2)} s after the first playable frame`}, ${audioRequests.length} files so far`);

  const waitMusic = async (re, label, director = null) => {
    const t0 = Date.now();
    let s;
    const ok = () => re.test(s.music.track ?? '') && s.levelDb > -60 && (!director || s.director === director);
    while (Date.now() - t0 < 30000) {
      s = await page.evaluate(() => window.__lodestoneAudio.state());
      if (ok()) break;
      await page.waitForTimeout(400);
    }
    check(`music: ${label}`, ok(), `director ${s.director}, track ${s.music.track}, master ${s.levelDb} dBFS`);
    return s;
  };

  await page.evaluate(() => {
    window.__lodestone.setFreezeTime(true);
    window.__lodestone.setTimeOfDay(10 * 150); // 10:00
    window.__lodestoneAudio.force({ inTown: false }); // solo spawns in a town; the town voicing is its own check below
  });
  await waitMusic(/future_land_[12]/, 'day plays future land', 'day');
  await page.evaluate(() => window.__lodestone.setTimeOfDay(22 * 150)); // 22:00
  await waitMusic(/music\/night/, 'night (world clock 22:00) plays the night theme');
  await page.evaluate(() => window.__lodestoneAudio.force({ inTown: true }));
  await waitMusic(/music\/night/, 'night in town is still the night theme');
  await page.evaluate(() => window.__lodestoneAudio.force({ underground: 1 }));
  await waitMusic(/void_realm/, 'cave (underground) plays void realm');
  await page.evaluate(() => window.__lodestoneAudio.force({ underground: 0, combat: true }));
  await waitMusic(/music\/combat/, 'a fight plays the combat loop');
  await page.evaluate(() => window.__lodestoneAudio.force({ timed: { key: 'test', secondsLeft: 15, urgent: false, intro: true } }));
  await page.waitForFunction(() => window.__lodestoneAudio.state().music.timedPhase !== null, null, { timeout: 30000 }).catch(() => {});
  const tc = await waitMusic(/time_crunch/, 'a timed event plays time crunch');
  check('timed event starts with the intro', tc.music.timedPhase === 'intro', `phase ${tc.music.timedPhase}`);
  await page.evaluate(() => window.__lodestoneAudio.force({ timed: { key: 'test', secondsLeft: 4, urgent: false, intro: true } }));
  await page.waitForTimeout(800);
  const fin = await page.evaluate(() => window.__lodestoneAudio.state());
  check('5 seconds left switches to the final layer', fin.music.timedPhase === 'final', `phase ${fin.music.timedPhase}`);
  await page.evaluate(() => window.__lodestoneAudio.force(null));

  // SFX: real movement first (footsteps, jump/land), then triggers and zone events.
  // The stings decode in the background after the instant set; headless
  // SwiftShader starves the main thread, so make sure the ones under test are in.
  await page.evaluate(() => window.__lodestoneAudio.preload(['level_up_small', 'loot_bitchin', 'dusk', 'loot_rare', 'step_soft', 'step_hard']));
  const p0 = await page.evaluate(() => window.__lodestone.player().pos);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(6000);
  const p1 = await page.evaluate(() => window.__lodestone.player().pos);
  const walked = Math.hypot(p1.x - p0.x, p1.z - p0.z);
  const stepsWalking = await page.evaluate(() => {
    const p = window.__lodestoneAudio.state().played;
    return (p.step_soft ?? 0) + (p.step_hard ?? 0);
  });
  // One step per 1.7 m stride (2.3 m sprinting); headless SwiftShader walks slowly.
  check('footsteps from walking, one per stride', walked > 2 && stepsWalking >= Math.floor(walked / 2.3) - 1 && stepsWalking >= 1, `walked ${walked.toFixed(1)} m, ${stepsWalking} steps`);
  await page.keyboard.press('Space');
  await page.waitForTimeout(1200);
  await page.keyboard.up('KeyW');
  await page.evaluate(() => {
    const a = window.__lodestoneAudio;
    a.trigger('attack', { weapon: 'sword', kind: 'light' });
    a.trigger('cast', { element: 'fire', kind: 'projectile' });
    a.trigger('impact', { element: 'ice' });
    a.trigger('level_up', { level: 7 });
    a.trigger('loot', { rarity: 7 });
    a.zoneEvent(501); // dusk
    a.zoneEvent(401, { json: [{ b: 'ore:iron', q: 1, r: 2 }] });
  });
  await page.waitForTimeout(3000);
  const s2 = await page.evaluate(() => window.__lodestoneAudio.state());
  const played = s2.played;
  check('jump from Space', (played.jump ?? 0) >= 1, `jump ${played.jump ?? 0}, land ${played.land ?? 0}`);
  for (const cue of ['swing_sword', 'cast_fire', 'impact_ice', 'level_up_small', 'loot_bitchin', 'dusk', 'loot_rare']) check(`sfx ${cue}`, (played[cue] ?? 0) >= 1);
  log(`played: ${JSON.stringify(played)}; decoded SFX ${s2.decodedMB} MB; voices stolen ${s2.stolen}, culled ${s2.culled}`);

  // Settings panel (K): sliders persist; mute silences the master.
  await page.keyboard.press('KeyK');
  await page.getByTestId('sound-settings').waitFor({ timeout: 5000 });
  await page.getByTestId('sound-music').fill('30');
  await page.screenshot({ path: path.join(root, 'docs', 'evidence', 'audio-settings.png') });
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('lodestone.audio.v1') ?? 'null'));
  check('music volume persisted', stored?.volumes?.music === 0.3, JSON.stringify(stored?.volumes));
  const loud = await page.evaluate(() => window.__lodestoneAudio.level());
  await page.evaluate(() => document.querySelector('[data-testid=sound-mute]').click());
  await page.waitForTimeout(600);
  const quiet = await page.evaluate(() => window.__lodestoneAudio.level());
  check('mute silences everything', quiet < -90 && loud > -60, `before ${loud.toFixed(1)} dBFS, muted ${quiet.toFixed(1)} dBFS`);
  await page.evaluate(() => document.querySelector('[data-testid=sound-mute]').click());
  await page.reload();
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('lodestone.audio.v1') ?? 'null'));
  check('settings survive a reload', kept?.volumes?.music === 0.3 && kept.muted === false);
  check('no page errors', errors.length === 0, errors.slice(0, 3).join('; '));
} catch (e) {
  log(`FAIL ${e.message}`);
  checks.push(false);
} finally {
  if (browser) await browser.close();
  killTree(vite);
  try {
    fs.rmSync(outDir, { recursive: true, force: true });
  } catch {
    /* preview still closing (Windows locks); it is in the temp dir */
  }
  const ok = checks.length > 0 && checks.every(Boolean);
  log(`${ok ? 'PASS' : 'FAIL'}: ${checks.filter(Boolean).length}/${checks.length} checks`);
  fs.writeFileSync(path.join(root, 'docs', 'evidence', 'audio-headless.txt'), lines.join('\n') + '\n');
  process.exit(ok ? 0 : 1);
}
