#!/usr/bin/env node
/* global localStorage, requestAnimationFrame */
// Playtest 2 graphics evidence: every visual style in five situations, from
// the real client (solo, headless Chromium on the GPU via ANGLE/D3D11):
//
//   day-town      a town square at 11:00
//   dusk-meadow   open grass near the spawn at 19:15
//   night-fire    a town's campfire or brazier at 22:30 (lanterns, warm lights)
//   cave          the cave chamber with the most gem veins
//   rain          the meadow at 14:00 in a shower (wet ground, overcast, streaks)
//   spell         an eruption (spell VFX, playtest 2) in the meadow at 16:30, in third person
//
// on High for each style (lodestone, painterly, grim, retro), plus Low for
// Lodestone and Retro. Writes docs/evidence/pt2-graphics-<style>-<scene>-<tier>.png,
// the Graphics screen itself, and pt2-graphics-shots.json (frame times per shot).
//
//   node client/src/world/style/dev/graphics-shots.mjs
//   LODESTONE_CLIENT_URL=http://127.0.0.1:5381 node client/src/world/style/dev/graphics-shots.mjs   # reuse a running solo Vite
//   ... --only lodestone,retro --scenes day-town,cave   # a subset
//
// Without LODESTONE_CLIENT_URL it starts its own Vite (VITE_SOLO=1) on
// LODESTONE_SHOTS_PORT (default 5382).

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..', '..', '..');
const evidence = path.join(root, 'docs', 'evidence');
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const software = process.env.LODESTONE_BENCH_GL === 'swiftshader';
const gpuArgs = software ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];

const ALL_STYLES = ['lodestone', 'painterly', 'grim', 'retro'];
const ALL_SCENES = ['day-town', 'dusk-meadow', 'night-fire', 'cave', 'rain', 'spell'];
const styles = arg('--only', ALL_STYLES.join(',')).split(',');
const scenes = arg('--scenes', ALL_SCENES.join(',')).split(',');
const lowStyles = arg('--low', 'lodestone,retro').split(',').filter(Boolean);

let base = process.env.LODESTONE_CLIENT_URL;
let vite = null;
if (!base) {
  const port = Number(process.env.LODESTONE_SHOTS_PORT ?? 5382);
  base = `http://127.0.0.1:${port}`;
  vite = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: path.join(root, 'client'),
    env: { ...process.env, VITE_SOLO: '1' },
    shell: process.platform === 'win32',
    stdio: 'ignore',
  });
  process.on('exit', () => {
    try {
      // Synchronous: an async spawn here never runs (the process is exiting) and Vite outlived the script.
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' });
      else vite.kill();
    } catch {
      /* gone */
    }
  });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(base)).ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
}

const results = [];
const hour = (h) => h * 150; // DAY_LENGTH_S = 3600: one game day per real hour

async function session(tier) {
  const browser = await chromium.launch({ headless: true, args: gpuArgs });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript((t) => {
    localStorage.setItem('lodestone_quality_settings', JSON.stringify({ state: { setting: t, overrides: {}, style: 'lodestone', effects: 'auto', detected: null }, version: 1 }));
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
  await page.evaluate(() => {
    window.__lodestone.setFreezeTime(true);
    document.querySelector('[data-testid="debug-hud"]')?.setAttribute('style', 'display:none');
  });
  await page.keyboard.press('F3').catch(() => {});
  return { browser, page, errors };
}

const L = (page, fn, a) => page.evaluate(fn, a);
const look = (page, yaw, pitch) => L(page, ([y, p]) => window.__lodestone.setLook(y, p), [yaw, pitch]);
const lookAt = async (page, x, y, z) => {
  const p = (await L(page, () => window.__lodestone.player())).pos;
  const dx = x - p.x, dz = z - p.z, dy = y - (p.y + 1.7);
  await look(page, Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
};
async function settle(page, ms = 1500) {
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
    for (const el of document.querySelectorAll('div')) if (el.childElementCount === 0 && /Click to look around/.test(el.textContent ?? '')) el.style.display = 'none';
  });

/** Scene placement, computed once per session (deterministic world). */
async function places(page) {
  return L(page, () => {
    const W = window.__lodestoneWorld;
    const T = window.__lodestoneTowns;
    const C = window.__lodestoneCaves;
    const spawn = W.stats().spawn ?? window.__lodestone.player().pos;
    const towns = T ? T.settlements().filter((s) => s.buildings >= 6).sort((a, b) => Math.hypot(a.x - spawn.x, a.z - spawn.z) - Math.hypot(b.x - spawn.x, b.z - spawn.z)) : [];
    const town = towns[0] ?? null;
    let fire = null;
    if (town) {
      // Campfire, torch, lantern, brazier: the first kind standing on the ground (not up on a wall).
      for (const kind of [22, 30, 17, 27]) {
        const ps = T.props(town.index, kind).filter((p) => Math.abs(p.y - (W.groundAt(p.x, p.z) ?? p.y)) < 1.5);
        if (ps.length) {
          fire = ps.sort((a, b) => Math.hypot(a.x - town.x, a.z - town.z) - Math.hypot(b.x - town.x, b.z - town.z))[0];
          break;
        }
      }
    }
    let cave = null;
    if (C) {
      const sys = C.systems();
      let best = null;
      for (let si = 0; si < Math.min(sys.length, 12); si++) for (const c of C.chambers(si)) if (!best || c.gems > best.c.gems) best = { si, c };
      if (best) {
        const v = C.veins(best.si).filter((x) => x.chamber === best.c.k);
        const t = v.find((x) => x.kind === 'gem') ?? v[0] ?? null;
        cave = { chamber: best.c, vein: t };
      }
    }
    return { spawn, town, fire, cave, meadow: { x: spawn.x + 40, z: spawn.z + 30 } };
  });
}

async function placeScene(page, scene, P) {
  await L(page, () => {
    window.__lodestone.setRain(false);
    window.__lodestone.setView('first');
  });
  if (scene === 'day-town' && P.town) {
    const t = P.town;
    await L(page, ([x, z]) => window.__lodestone.teleport({ x, z }), [t.x + 26, t.z + 18]);
    await L(page, (s) => window.__lodestone.setTimeOfDay(s), hour(11));
    await settle(page, 2500);
    await lookAt(page, t.x, t.y + 4, t.z);
  } else if (scene === 'dusk-meadow' || scene === 'rain') {
    await L(page, ([x, z]) => window.__lodestone.teleport({ x, z }), [P.meadow.x, P.meadow.z]);
    await L(page, (s) => window.__lodestone.setTimeOfDay(s), hour(scene === 'rain' ? 14 : 17.6));
    if (scene === 'rain') await L(page, () => window.__lodestone.setRain(true));
    await settle(page, scene === 'rain' ? 9000 : 2500); // the shower eases in over a few seconds
    await look(page, scene === 'rain' ? 2.4 : 1.25, -0.04); // dusk: three-quarters toward the setting sun (west)
  } else if (scene === 'spell') {
    await L(page, ([x, z]) => window.__lodestone.teleport({ x, z }), [P.meadow.x, P.meadow.z]);
    await L(page, (s) => window.__lodestone.setTimeOfDay(s), hour(16.5));
    await L(page, () => window.__lodestone.setView('third'));
    await settle(page, 2500);
    await look(page, 2.4, -0.12);
  } else if (scene === 'night-fire' && P.town) {
    const f = P.fire ?? { x: P.town.x, y: P.town.y, z: P.town.z };
    await L(page, ([x, z]) => window.__lodestone.teleport({ x, z }), [f.x + 6, f.z + 5]);
    await L(page, (s) => window.__lodestone.setTimeOfDay(s), hour(22.5));
    await settle(page, 2500);
    await lookAt(page, f.x, f.y + 0.6, f.z);
  } else if (scene === 'cave' && P.cave) {
    const { chamber: c, vein: v } = P.cave;
    const tx = v ? v.x : c.x + 3, tz = v ? v.z : c.z, ty = v ? v.y : c.y + 1;
    await L(page, ([x, y, z]) => window.__lodestone.teleport({ x, y, z }), [c.x - (tx - c.x) * 0.55, c.y + 1.2, c.z - (tz - c.z) * 0.55]);
    await L(page, (s) => window.__lodestone.setTimeOfDay(s), hour(11));
    await sleep(3000);
    await lookAt(page, tx, ty, tz);
    await sleep(5000); // let the area-name toast fade
  } else {
    return false;
  }
  return true;
}

async function shoot(page, errors, tier, style, scene) {
  await L(page, (s) => window.__lodestone.setStyle(s), style);
  await sleep(style === 'retro' ? 2500 : 1200); // Retro rebuilds the post chain (warm-up)
  await cleanHud(page);
  await L(page, () => {
    window.__shots.frames = [];
    window.__shots.rec = true;
  });
  await sleep(1500);
  const frames = await L(page, () => {
    window.__shots.rec = false;
    return window.__shots.frames;
  });
  if (scene === 'spell') {
    // The FX layer runs in debug solo builds (combat/fx/debug.ts): an eruption 9 m ahead, caught mid-burst.
    // Aimed down so the burst lands ~9 m ahead, mid-frame.
    await L(page, () => window.__lodestoneFx?.cast('eruption', { ahead: 6, pitch: -0.5 }));
    await sleep(1150); // the sigil, then the burst
  }
  const file = `pt2-graphics-${style}-${scene}-${tier}.png`;
  await page.screenshot({ path: path.join(evidence, file) });
  const s = [...frames].sort((a, b) => a - b);
  const q = (p) => +(s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0).toFixed(1);
  const g = await L(page, () => window.__lodestone.graphics());
  results.push({ file, tier, style, scene, frames: frames.length, p50: q(0.5), p95: q(0.95), max: +(s.at(-1) ?? 0).toFixed(1), dpr: g.retro ? 'retro' : g.controls.dprCap, errors: errors.length });
  console.log(`${file}  p50 ${q(0.5)} p95 ${q(0.95)} ms`);
}

for (const tier of ['high', 'low']) {
  const want = tier === 'high' ? styles : styles.filter((s) => lowStyles.includes(s));
  if (!want.length) continue;
  const { browser, page, errors } = await session(tier);
  try {
    const renderer = await L(page, () => {
      const gl = document.querySelector('canvas')?.getContext('webgl2');
      const e = gl?.getExtension('WEBGL_debug_renderer_info');
      return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown';
    });
    console.log(`[${tier}] ${renderer}`);
    const P = await places(page);
    console.log(`[${tier}] town ${P.town?.name ?? 'none'} fire ${P.fire ? 'yes' : 'no'} cave ${P.cave ? 'yes' : 'no'}`);
    for (const scene of scenes) {
      if (!(await placeScene(page, scene, P))) {
        console.log(`[${tier}] skip ${scene} (no place)`);
        continue;
      }
      for (const style of want) await shoot(page, errors, tier, style, scene);
    }
    if (tier === 'high') {
      // The Graphics screen itself, over the day town.
      await placeScene(page, 'day-town', P);
      await L(page, () => window.__lodestone.setStyle('lodestone'));
      await page.keyboard.press('F10');
      await sleep(800);
      await page.screenshot({ path: path.join(evidence, 'pt2-graphics-panel.png') });
      await page.keyboard.press('F10');
    }
    if (errors.length) console.log(`[${tier}] errors:\n  ${errors.slice(0, 12).join('\n  ')}`);
    results.push({ tier, renderer, errors: errors.slice(0, 20) });
  } finally {
    await browser.close();
  }
}

if (!process.argv.includes('--no-json')) {
  // A subset run (--only/--scenes) replaces its own shots and keeps the rest.
  const file = path.join(evidence, 'pt2-graphics-shots.json');
  let kept = [];
  try {
    const shot = new Set(results.map((r) => r.file).filter(Boolean));
    kept = JSON.parse(fs.readFileSync(file, 'utf8')).results.filter((r) => r.file && !shot.has(r.file));
  } catch {
    /* first run */
  }
  fs.writeFileSync(file, JSON.stringify({ date: new Date().toISOString(), base, results: [...kept, ...results] }, null, 2) + '\n');
}
process.exit(0);
