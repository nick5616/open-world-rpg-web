#!/usr/bin/env node
/* global localStorage, requestAnimationFrame */
// Playtest 2 weather evidence (CR 030): every weather state from the real
// client (solo, headless Chromium on the GPU via ANGLE/D3D11), forced with
// the dev handle (__lodestone.setWeather), each where it belongs (snow on the
// official world's cold cells, sand and heat in its arid ones), plus a
// lightning strike in view, a rainbow after rain, the storm and the snow in
// every graphics style, and rain/snow on Low. Writes
// docs/evidence/pt2-weather-<shot>.png and pt2-weather-shots.json (frame
// times per shot, the weather the client reported).
//
//   node client/src/systems/weather/dev/weather-shots.mjs
//   LODESTONE_CLIENT_URL=http://127.0.0.1:5381 node ...   # reuse a running solo Vite
//
// Without LODESTONE_CLIENT_URL it starts its own Vite (VITE_SOLO=1) on
// LODESTONE_SHOTS_PORT (default 5383) and kills it at the end.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..', '..', '..');
const evidence = path.join(root, 'docs', 'evidence');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gpuArgs = process.env.LODESTONE_BENCH_GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];

let base = process.env.LODESTONE_CLIENT_URL;
let vite = null;
const killVite = () => {
  if (!vite) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' });
    else vite.kill();
  } catch {
    /* gone */
  }
  vite = null;
};
if (!base) {
  const port = Number(process.env.LODESTONE_SHOTS_PORT ?? 5383);
  base = `http://127.0.0.1:${port}`;
  vite = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: path.join(root, 'client'),
    env: { ...process.env, VITE_SOLO: '1' },
    shell: process.platform === 'win32',
    stdio: 'ignore',
  });
  process.on('exit', killVite);
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(base)).ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
}

const hour = (h) => h * 150;
const results = [];
// --only a,b: just these shots (names without the pt2-weather- prefix); the JSON keeps the others.
const onlyI = process.argv.indexOf('--only');
const only = onlyI >= 0 ? new Set(process.argv[onlyI + 1].split(',')) : null;

async function session(tier) {
  const browser = await chromium.launch({ headless: true, args: gpuArgs });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript((t) => {
    localStorage.setItem('lodestone_quality_settings', JSON.stringify({ state: { setting: t, overrides: {}, style: 'lodestone', effects: 'auto', detected: null }, version: 1 }));
    localStorage.setItem('lodestone_whatsnew_seen', '9999');
    const w = window;
    w.__shots = { frames: [], rec: false };
    let last = performance.now();
    const tick = (now) => {
      if (w.__shots.rec) w.__shots.frames.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, tier);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || /THREE\.WebGLProgram|Shader Error/.test(m.text())) errors.push(`console: ${m.text().slice(0, 400)}`);
  });
  await page.goto(`${base}/?solo&autoplay=1`);
  await page.waitForSelector('[data-testid="world-loading"]', { timeout: 120000 });
  await page.waitForSelector('[data-testid="world-loading"]', { state: 'detached', timeout: 180000 });
  await page.evaluate(() => window.__lodestone.setFreezeTime(true));
  await page.keyboard.press('F3').catch(() => {});
  return { browser, page, errors };
}

const L = (page, fn, a) => page.evaluate(fn, a);
const look = (page, yaw, pitch) => L(page, ([y, p]) => window.__lodestone.setLook(y, p), [yaw, pitch]);
async function settle(page, ms) {
  for (let i = 0; i < 60; i++) {
    const st = await L(page, () => window.__lodestoneWorld.stats());
    if (st.terrain.queued + st.terrain.inFlight === 0 && st.terrain.missingWanted === 0) break;
    await sleep(250);
  }
  await sleep(ms);
}
const cleanHud = (page) =>
  L(page, () => {
    document.querySelector('[data-testid="debug-hud"]')?.setAttribute('style', 'display:none');
    document.querySelector('[data-testid="lock-hint"]')?.setAttribute('style', 'display:none');
    for (const el of document.querySelectorAll('div')) if (el.childElementCount === 0 && /to look around/.test(el.textContent ?? '')) el.style.display = 'none';
  });

/** Places: the meadow by the spawn, and the middle of a cold and an arid weather cell (dry land nearby). */
async function places(page) {
  return L(page, () => {
    const W = window.__lodestoneWorld;
    const spawn = W.stats().spawn ?? window.__lodestone.player().pos;
    const cl = window.__lodestone.weather().climate ?? [];
    const cellOf = (c) => {
      const idx = cl.map((v, i) => (v === c ? i : -1)).filter((i) => i >= 0);
      let best = null;
      for (const i of idx) {
        const cx = (i % 8) * 512 + 256;
        const cz = Math.floor(i / 8) * 512 + 256;
        const d = Math.hypot(cx - spawn.x, cz - spawn.z);
        if (!best || d < best.d) best = { x: cx, z: cz, d };
      }
      return best;
    };
    return { meadow: { x: spawn.x + 40, z: spawn.z + 30 }, cold: cellOf(3), arid: cellOf(4) };
  });
}

async function shot(page, errors, name, opts) {
  if (only && !only.has(name)) return;
  const { at, hourOf = 13, weather = 'clear', yaw = 2.4, pitch = -0.02, wait = 9000, style = 'lodestone', strike = false, rainbow = null, view = 'first' } = opts;
  await L(page, ([s, v]) => {
    window.__lodestone.setStyle(s);
    window.__lodestone.setView(v);
  }, [style, view]);
  await L(page, ([x, z]) => window.__lodestone.teleport({ x, z }), [at.x, at.z]);
  await L(page, (s) => window.__lodestone.setTimeOfDay(s), hour(hourOf));
  await L(page, ([w, r]) => {
    window.__lodestone.setWeather(w);
    window.__lodestone.setRainbow(r);
  }, [weather, rainbow]);
  await settle(page, wait);
  await look(page, yaw, pitch);
  await sleep(400);
  await cleanHud(page);
  await L(page, () => {
    window.__shots.frames = [];
    window.__shots.rec = true;
  });
  await sleep(1200);
  const frames = await L(page, () => {
    window.__shots.rec = false;
    return window.__shots.frames;
  });
  if (strike) {
    // A bolt ~140 m ahead (where the camera looks), caught just after the stroke.
    await L(page, (y) => {
      const p = window.__lodestone.player().pos;
      const x = p.x - Math.sin(y) * 140;
      const z = p.z - Math.cos(y) * 140;
      window.__lodestone.weatherStrike(x, z, window.__lodestoneWorld.groundAt?.(x, z) ?? p.y);
    }, yaw);
    await sleep(200); // the restrike: the bolt bright, the flash fading
  }
  const file = `pt2-weather-${name}.png`;
  await page.screenshot({ path: path.join(evidence, file) });
  const w = await L(page, () => window.__lodestone.weather());
  const s = [...frames].sort((a, b) => a - b);
  const q = (p) => +(s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0).toFixed(1);
  const mix = Object.fromEntries(Object.entries(w.mix).map(([k, v]) => [k, +v.toFixed(2)]));
  results.push({ file, weather, style, hour: hourOf, state: w.state, hud: { line: w.hud.line, state: w.hud.state }, mix, wet: +w.wet.toFixed(2), snowCover: +w.snowCover.toFixed(2), rainbow: +w.rainbow.toFixed(2), frames: frames.length, p50: q(0.5), p95: q(0.95), errors: errors.length });
  console.log(`${file}  ${w.state}  p50 ${q(0.5)} p95 ${q(0.95)} ms`);
}

try {
  const { browser, page, errors } = await session('high');
  try {
    const P = await places(page);
    console.log(`places: cold ${JSON.stringify(P.cold)} arid ${JSON.stringify(P.arid)}`);
    const m = P.meadow;
    const cold = P.cold ? { x: P.cold.x + 26, z: P.cold.z - 18 } : m;
    const arid = P.arid ?? m;
    await shot(page, errors, 'clear', { at: m, weather: 'clear' });
    await shot(page, errors, 'cloudy', { at: m, weather: 'cloudy' });
    await shot(page, errors, 'windy', { at: m, weather: 'windy' });
    await shot(page, errors, 'fog', { at: m, weather: 'fog', hourOf: 9 });
    await shot(page, errors, 'drizzle', { at: m, weather: 'drizzle' });
    await shot(page, errors, 'rain', { at: m, weather: 'rain', wait: 14000, pitch: -0.12 });
    await shot(page, errors, 'thunderstorm', { at: m, weather: 'thunderstorm', hourOf: 17, strike: true });
    await shot(page, errors, 'thunderstorm-night', { at: m, weather: 'thunderstorm', hourOf: 22, strike: true });
    await shot(page, errors, 'rainbow', { at: m, weather: 'clear', hourOf: 8.2, rainbow: 1, yaw: 1.57, pitch: 0.12, wait: 6000 });
    await shot(page, errors, 'snow', { at: cold, weather: 'snow', wait: 30000, pitch: -0.15, yaw: 0.6 });
    await shot(page, errors, 'snowstorm', { at: cold, weather: 'snowstorm', wait: 10000 });
    await shot(page, errors, 'heat-haze', { at: arid, weather: 'heat_haze', hourOf: 14 });
    await shot(page, errors, 'sandstorm', { at: arid, weather: 'sandstorm' });
    for (const style of ['painterly', 'grim', 'retro']) {
      await shot(page, errors, `thunderstorm-${style}`, { at: m, weather: 'thunderstorm', hourOf: 17, strike: true, style, wait: 4000 });
      await shot(page, errors, `snow-${style}`, { at: cold, weather: 'snow', style, wait: 6000, pitch: -0.15 });
    }
    // The HUD pill with a forecast: seeded weather (no override), whatever it is now.
    // Shift the solo weather clock until the front here is about to change, so the pill shows a forecast line.
    if (!only || only.has('seeded-hud')) {
      await L(page, ([x, z]) => window.__lodestone.teleport({ x, z }), [m.x, m.z]);
      await L(page, () => window.__lodestone.setWeather(null));
      for (let k = 0; k < 240; k++) {
        await L(page, (s) => window.__lodestone.setWorldOffset(s), k * 90);
        await sleep(350);
        if ((await L(page, () => window.__lodestone.weather().hud.line)) !== '') break;
      }
    }
    await shot(page, errors, 'seeded-hud', { at: m, weather: null, wait: 2000 });
    if (errors.length) console.log(`errors:\n  ${errors.slice(0, 12).join('\n  ')}`);
    results.push({ tier: 'high', errors: errors.slice(0, 20) });
  } finally {
    await browser.close();
  }
  const low = only && ![...only].some((n) => n.endsWith('-low')) ? null : await session('low');
  if (low) {
    try {
      const P = await places(low.page);
      await shot(low.page, low.errors, 'rain-low', { at: P.meadow, weather: 'rain', wait: 12000 });
      await shot(low.page, low.errors, 'snowstorm-low', { at: P.cold ?? P.meadow, weather: 'snowstorm', wait: 15000 });
      await shot(low.page, low.errors, 'thunderstorm-low', { at: P.meadow, weather: 'thunderstorm', hourOf: 17, strike: true, wait: 6000 });
      results.push({ tier: 'low', errors: low.errors.slice(0, 20) });
    } finally {
      await low.browser.close();
    }
  }
} finally {
  if (only) {
    try {
      const now = new Set(results.map((r) => r.file).filter(Boolean));
      const old = JSON.parse(fs.readFileSync(path.join(evidence, 'pt2-weather-shots.json'), 'utf8')).results.filter((r) => r.file && !now.has(r.file));
      results.unshift(...old);
    } catch {
      /* first run */
    }
  }
  fs.writeFileSync(path.join(evidence, 'pt2-weather-shots.json'), JSON.stringify({ date: new Date().toISOString(), base, results }, null, 2) + '\n');
  killVite();
}
process.exit(0);
