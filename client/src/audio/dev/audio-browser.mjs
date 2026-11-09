#!/usr/bin/env node
// Headless-Chromium acceptance for the audio system (solo build, no servers):
//   1. no AudioContext exists before the Play click; the first one is made
//      inside that user gesture and runs;
//   2. no audio file is requested before the first playable frame (spec 12);
//   3. the music follows the world: day -> night (world clock) -> cave,
//      each audible on the master analyser;
//   4. SFX play for real movement (walking, jumping) and for triggers /
//      zone events (swing, spell, level-up, Bitchin' loot, dusk);
//   5. the settings panel (K) persists volumes and mute silences the master;
//   6. audio QoL: the 10 Hz environment pass runs, town fires get capped
//      positional loop voices, rain indoors is quiet, muffled and drums on
//      the roof, a burst of identical hits is limited, thunder and a hidden
//      tab fade work.
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
        window.__ctxLog.push({ t: performance.now(), activation: window.navigator.userActivation?.isActive ?? null });
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
  // Walk with W (the solo spawn is in a town: turn whenever a wall stops us)
  // until 6 m are covered or 40 s pass; count the path actually walked.
  await page.keyboard.down('KeyW');
  let walked = 0;
  let yaw = 0;
  let last = await page.evaluate(() => window.__lodestone.player().pos);
  for (let t0 = Date.now(); walked < 6 && Date.now() - t0 < 40000; ) {
    await page.waitForTimeout(2000);
    const p = await page.evaluate(() => window.__lodestone.player().pos);
    const d = Math.hypot(p.x - last.x, p.z - last.z);
    walked += d;
    last = p;
    if (d < 0.4) {
      yaw += Math.PI / 2;
      await page.evaluate((y) => window.__lodestone.setLook(y, 0), yaw);
    }
  }
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

  // Audio QoL: environment pass, positional fire loops, rain under a roof,
  // voice limiting, thunder, hidden-tab fade.
  const env0 = await page.evaluate(() => window.__lodestoneAudio.env());
  check('environment pass runs (shelter, surface, cave leak)', !!env0 && typeof env0.roof === 'number' && typeof env0.surface === 'string' && env0.leak === 1, JSON.stringify(env0 && { roof: env0.roof, indoors: env0.indoors, surface: env0.surface, leak: env0.leak, probe: env0.probe }));
  // Into the biggest house of the town (solo spawns in one), in the rain.
  const house = await page.evaluate(() => {
    const T = window.__lodestoneTowns;
    const si = T.largestTown();
    const s = T.settlements()[si];
    const bs = T.buildings(si).filter((b) => b.floors > 0 && !(b.flags & 8) && (b.role === 'house' || b.role === 'inn'));
    bs.sort((a, b) => b.hx * b.hz - a.hx * a.hz);
    const b = bs[0];
    return b ? { si, dx: b.x - s.x, dz: b.z - s.z, y: b.floorY + 0.05, role: b.role, out: Math.max(s.radius, 30) + 35 } : null;
  });
  await page.evaluate(() => window.__lodestoneAudio.forceRain(true));
  if (house) {
    // Outside the town first, then inside.
    await page.evaluate((h) => window.__lodestoneTowns.teleportTo(h.si, { dx: 0, dz: h.out }), house);
    await page.waitForTimeout(6000);
    const out = await page.evaluate(() => window.__lodestoneAudio.env());
    await page.evaluate((h) => window.__lodestoneTowns.teleportTo(h.si, { dx: h.dx, dz: h.dz, y: h.y }), house);
    // The shelter crossfade glides per environment pass (10 Hz in the game;
    // SwiftShader draws a frame or two a second here): wait for it to settle.
    let inn = null;
    for (let t0 = Date.now(); Date.now() - t0 < 30000; ) {
      await page.waitForTimeout(1000);
      inn = await page.evaluate(() => window.__lodestoneAudio.env());
      if (inn.indoors > 0.97 && inn.roofRain > 0.2) break;
    }
    log(`rain outside: ${JSON.stringify({ roof: out.roof, indoors: out.indoors, rain: out.rain, weatherGain: out.weatherGain, weatherLowpassHz: out.weatherLowpassHz, roofRain: out.roofRain })}`);
    log(`rain inside a ${house.role}: ${JSON.stringify({ roof: inn.roof, indoors: inn.indoors, rain: inn.rain, weatherGain: inn.weatherGain, weatherLowpassHz: inn.weatherLowpassHz, roofRain: inn.roofRain, reverb: inn.reverb, busLowpassHz: inn.busLowpassHz, surface: inn.surface })}`);
    check('rain builds up outdoors', out.rain > 0.2 && out.weatherGain > 0.9, `rain ${out.rain}, weather gain ${out.weatherGain}`);
    check('indoors the rain is quiet and muffled, the roof drums, the room rings a little', inn.indoors > 0.9 && inn.weatherGain < 0.35 && inn.weatherLowpassHz < 1500 && inn.roofRain > 0.2 && inn.reverb > 0.2 && inn.busLowpassHz < 15000, `indoors ${inn.indoors}, gain ${inn.weatherGain}, lowpass ${inn.weatherLowpassHz} Hz, roof rain ${inn.roofRain}, reverb ${inn.reverb}`);
    check('footsteps on planks indoors', inn.surface === 'wood', `surface ${inn.surface}`);
  } else check('a house to walk into', false, 'no closed house in the largest town');
  await page.evaluate(() => window.__lodestoneAudio.forceRain(null));
  // Night in town: the hearths, braziers and torches nearby get loop voices (capped).
  let loops = null;
  for (let t0 = Date.now(); Date.now() - t0 < 20000; ) {
    loops = await page.evaluate(() => window.__lodestoneAudio.state());
    if (loops.loopVoices > 0) break;
    await page.waitForTimeout(500);
  }
  check('town fires play as positional loops, capped', loops.loopVoices >= 1 && loops.loopVoices <= 8, `${loops.loopVoices} voices: ${JSON.stringify(loops.env.loops.slice(0, 8))}; ${loops.env.probe.fires} fire emitters indexed`);
  // Eight identical hits in one frame (an area hit) are not eight stacked sounds.
  const lim = await page.evaluate(() => {
    const a = window.__lodestoneAudio;
    const p = window.__lodestone.player().pos;
    const before = a.state().suppressed;
    for (let i = 0; i < 8; i++) a.play('hit', { x: p.x + i, y: p.y + 1, z: p.z });
    for (let i = 0; i < 3; i++) a.play('hit_crit', { x: p.x + 2, y: p.y + 1, z: p.z });
    return a.state().suppressed - before;
  });
  check('a burst of identical hits is limited (stacks and duplicates dropped)', lim >= 5 + 2, `${lim} suppressed of 11`);
  await page.evaluate(() => window.__lodestoneAudio.thunder(900));
  // A hidden tab fades music, ambience and effects.
  await page.evaluate(() => window.__lodestoneAudio.force({ underground: 0, inTown: false, hour: 10 }));
  await page.waitForTimeout(1500);
  const shown = await page.evaluate(() => window.__lodestoneAudio.level());
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new window.Event('visibilitychange'));
  });
  await page.waitForTimeout(2000);
  const hiddenLevel = await page.evaluate(() => window.__lodestoneAudio.level());
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new window.Event('visibilitychange'));
    window.__lodestoneAudio.force(null);
  });
  check('a hidden tab fades the game out', shown > -60 && hiddenLevel < shown - 30, `shown ${shown.toFixed(1)} dBFS, hidden ${hiddenLevel.toFixed(1)} dBFS`);

  // Settings panel (K): sliders persist; mute silences the master.
  const focus = await page.evaluate(() => {
    const el = document.activeElement;
    const what = el ? `${el.tagName}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''}` : 'none';
    if (el && el !== document.body) el.blur();
    return what;
  });
  const panelBefore = await page.getByTestId('sound-settings').count();
  await page.keyboard.press('KeyK');
  await page.waitForTimeout(1000);
  const panelAfter = await page.getByTestId('sound-settings').count();
  check('K toggles the sound settings panel', panelAfter !== panelBefore, `focus ${focus}, panel ${panelBefore} -> ${panelAfter}`);
  if (!panelAfter) await page.keyboard.press('KeyK');
  // SwiftShader runs this page at well under 1 fps, so drive the controls
  // through the DOM (Playwright's actionability checks wait on frames).
  await page.getByTestId('sound-settings').waitFor({ state: 'attached', timeout: 60000 });
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid=sound-music]');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, '30');
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(root, 'docs', 'evidence', 'audio-settings.png'), timeout: 120000 });
  const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem('lodestone.audio.v1') ?? 'null'));
  check('music volume persisted', stored?.volumes?.music === 0.3, JSON.stringify(stored?.volumes));
  const loud = await page.evaluate(() => window.__lodestoneAudio.level());
  await page.evaluate(() => document.querySelector('[data-testid=sound-mute]').click());
  await page.waitForTimeout(600);
  const quiet = await page.evaluate(() => window.__lodestoneAudio.level());
  check('mute silences everything', quiet < -90 && loud > -60, `before ${loud.toFixed(1)} dBFS, muted ${quiet.toFixed(1)} dBFS`);
  await page.evaluate(() => document.querySelector('[data-testid=sound-mute]').click());
  await page.reload();
  const kept = await page.evaluate(() => JSON.parse(window.localStorage.getItem('lodestone.audio.v1') ?? 'null'));
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
