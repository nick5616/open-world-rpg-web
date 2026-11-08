#!/usr/bin/env node
// WP09 headless evidence: the real client (solo, real GPU via ANGLE/D3D11,
// like WP05's traversal benchmark) walks from in front of a cave mouth down
// to the deepest chamber of a generated system with real key events (W held,
// look scripted through window.__lodestone.setLook), then takes screenshots
// of the mouth, a lit chamber with gems, the deepest chamber and a mined
// vein. Writes docs/evidence/wp09-cave-walk.txt and wp09-*.png.
//
//   node client/src/world/caves/dev/caveWalk.mjs [--system 0] [--software]
//
// Starts its own Vite dev server on LODESTONE_CAVE_PORT (default 5179).
/* global localStorage, requestAnimationFrame -- used inside page scripts */
import { spawn } from 'node:child_process';
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
const SYSTEM = Number(arg('--system', 0));
const software = process.argv.includes('--software');
const port = Number(process.env.LODESTONE_CAVE_PORT ?? 5179);
const base = `http://localhost:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const say = (s) => {
  console.log(s);
  log.push(s);
};

const vite = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--port', String(port), '--strictPort'], {
  cwd: path.join(root, 'client'),
  env: { ...process.env, VITE_SOLO: '1' },
  shell: process.platform === 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
});
vite.stdout.on('data', () => {});
vite.stderr.on('data', () => {});
const cleanup = () => {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F']);
    else vite.kill();
  } catch {}
};
process.on('exit', cleanup);

for (let i = 0; i < 120; i++) {
  try {
    if ((await fetch(base)).ok) break;
  } catch {}
  await sleep(500);
}

const gpuArgs = software ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ headless: true, args: gpuArgs });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
await context.addInitScript(() => {
  localStorage.setItem('lodestone_quality_settings', JSON.stringify({ state: { setting: 'high' }, version: 0 }));
  const w = window;
  w.__cave = { frames: [], rec: false };
  let last = performance.now();
  const tick = (now) => {
    if (w.__cave.rec) w.__cave.frames.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text().slice(0, 300)}`);
});
const t0 = Date.now();
await page.goto(`${base}/?solo&autoplay=1&nocache=1`);
await page.waitForSelector('[data-testid="world-loading"]', { timeout: 120000 });
await page.waitForSelector('[data-testid="world-loading"]', { state: 'detached', timeout: 180000 });
const renderer = await page.evaluate(() => {
  const gl = document.querySelector('canvas')?.getContext('webgl2');
  const e = gl?.getExtension('WEBGL_debug_renderer_info');
  return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
say(`# WP09 cave walk (headless Chromium, ${renderer})`);
say(`date: ${new Date().toISOString()}; playable after ${Date.now() - t0} ms`);
await page.evaluate(() => {
  window.__lodestone.setFreezeTime(true);
  window.__lodestone.setTimeOfDay(3600 * 0.45); // late morning outside
});

const systems = await page.evaluate(() => window.__lodestoneCaves.systems());
const route = await page.evaluate((si) => window.__lodestoneCaves.route(si), SYSTEM);
const sys = systems[SYSTEM];
say(`system ${SYSTEM}: mouth (${sys.mouth.x.toFixed(1)}, ${sys.mouth.y.toFixed(1)}, ${sys.mouth.z.toFixed(1)}), deepest chamber floor ${sys.deepest.y.toFixed(1)} m (${sys.maxDepth.toFixed(0)} m below the mouth), ${sys.chambers} chambers, ${sys.veins} veins; route ${route.points.length} waypoints`);

const player = () => page.evaluate(() => window.__lodestone.player());
const shot = async (name) => {
  await page.screenshot({ path: path.join(evidence, `wp09-${name}.png`) });
  say(`screenshot docs/evidence/wp09-${name}.png`);
};
const look = (yaw, pitch = 0) => page.evaluate(([y, p]) => window.__lodestone.setLook(y, p), [yaw, pitch]);

// 0. Approaching: the arch over the mouth from 25 m out on the hillside.
{
  const o = sys.mouth;
  const yaw = (o.yaw / 65536) * Math.PI * 2;
  const ax = o.x + Math.cos(yaw) * 17, az = o.z + Math.sin(yaw) * 17;
  await page.evaluate(([x, z]) => window.__lodestone.teleport({ x, z }), [ax, az]);
  await sleep(3000);
  const p = await player();
  const dx = o.x - p.pos.x, dz = o.z - p.pos.z, dy = o.y - (p.pos.y + 1.8);
  await look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
  await sleep(3000);
  await shot('mouth-approach');
}

// 1. In front of the mouth, looking in.
await page.evaluate((p) => window.__lodestone.teleport({ x: p.x, z: p.z }), route.start);
await sleep(2500);
{
  const p = await player();
  const w = route.points[1];
  const o = sys.mouth;
  await look(Math.atan2(-(w.x - p.pos.x), -(w.z - p.pos.z)), Math.atan2(o.y - 1 - (p.pos.y + 1.8), Math.hypot(o.x - p.pos.x, o.z - p.pos.z)));
  await sleep(3500);
  await shot('mouth');
}

// 2. Walk it: W held, look at the next waypoint, hop when stuck.
await page.evaluate(() => (window.__cave.rec = true));
await page.keyboard.down('KeyW');
let next = 0;
let lastPos = null;
let stuck = 0;
let done = false;
const samples = [];
const tWalk = Date.now();
while (Date.now() - tWalk < 240000) {
  const p = (await player()).pos;
  let w = route.points[next];
  while (Math.hypot(w.x - p.x, w.z - p.z) < (next === route.points.length - 1 ? 2.5 : 1.6)) {
    if (next === route.points.length - 1) {
      done = true;
      break;
    }
    w = route.points[++next];
  }
  if (done) break;
  await look(Math.atan2(-(w.x - p.x), -(w.z - p.z)), -0.1);
  if (lastPos && Math.hypot(p.x - lastPos.x, p.z - lastPos.z) < 0.05) stuck++;
  else stuck = 0;
  if (stuck > 6) {
    await page.keyboard.press('Space');
    stuck = 0;
  }
  lastPos = p;
  if (samples.length === 0 || Date.now() - samples.at(-1).t > 2000) {
    const info = await page.evaluate(() => window.__lodestoneCaves.info());
    samples.push({ t: Date.now(), x: p.x, y: p.y, z: p.z, waypoint: next, underground: info.underground, meshes: info.stats.meshes, lights: info.stats.lights });
  }
  await sleep(80);
}
await page.keyboard.up('KeyW');
await page.evaluate(() => (window.__cave.rec = false));
const walkS = (Date.now() - tWalk) / 1000;
const end = (await player()).pos;
const frames = await page.evaluate(() => window.__cave.frames);
const fs_ = [...frames].sort((a, b) => a - b);
const q = (p) => fs_[Math.min(fs_.length - 1, Math.floor(p * fs_.length))] ?? 0;
for (const s of samples.filter((_, i) => i % 3 === 0)) say(`  t=${((s.t - tWalk) / 1000).toFixed(0).padStart(3)} s  (${s.x.toFixed(1)}, ${s.y.toFixed(1)}, ${s.z.toFixed(1)})  waypoint ${s.waypoint}/${route.points.length}  underground ${s.underground.toFixed(2)}  cave meshes ${s.meshes}  lights ${s.lights}`);
say(`walk: ${done ? 'REACHED' : 'DID NOT REACH'} the deepest chamber in ${walkS.toFixed(1)} s of real time; end (${end.x.toFixed(2)}, ${end.y.toFixed(2)}, ${end.z.toFixed(2)}), chamber floor ${sys.deepest.y.toFixed(2)}; ${(sys.mouth.y - end.y).toFixed(1)} m below the mouth`);
say(`frames while walking: ${frames.length}, mean ${(frames.reduce((a, b) => a + b, 0) / Math.max(1, frames.length)).toFixed(2)} ms, p50 ${q(0.5).toFixed(2)}, p95 ${q(0.95).toFixed(2)}, p99 ${q(0.99).toFixed(2)} ms`);

// 3. The deepest chamber, looking around.
await look(0.7, -0.15);
await sleep(1500);
await shot('deepest-chamber');

// 4. A lit chamber with gems: the chamber of this system with the most gem veins.
// (the chamber with the most gem veins among the first systems)
let gemSys = SYSTEM;
let best = null;
for (let si = 0; si < Math.min(systems.length, 12); si++) {
  const cs = await page.evaluate((k) => window.__lodestoneCaves.chambers(k), si);
  for (const c of cs) if (!best || c.gems > best.gems) [best, gemSys] = [c, si];
}
const veins = await page.evaluate((si) => window.__lodestoneCaves.veins(si), gemSys);
const gemVeins = veins.filter((v) => v.chamber === best.k && v.kind === 'gem');
const target = gemVeins[0] ?? veins.find((v) => v.chamber === best.k);
say(`gem chamber: system ${gemSys} chamber ${best.k} (depth ${best.depth.toFixed(0)} m, radius ${best.rx.toFixed(1)} m) with ${best.gems} gem veins`);
{
  // Stand across the chamber from the vein, look at it.
  const sx = best.x - (target.x - best.x) * 0.55;
  const sz = best.z - (target.z - best.z) * 0.55;
  await page.evaluate(([x, y, z]) => window.__lodestone.teleport({ x, y, z }), [sx, best.y + 1.2, sz]);
  await sleep(2500);
  const p = (await player()).pos;
  const dx = target.x - p.x, dz = target.z - p.z, dy = target.y - (p.y + 1.8);
  await look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
  await sleep(2000);
  await shot('gem-chamber');
}

// 5. Mine a vein: stand in front of it and swing until it breaks.
{
  const v = target;
  const nl = Math.hypot(v.nx, v.nz) || 1;
  const sx = v.x + (v.nx / nl) * 2.6, sz = v.z + (v.nz / nl) * 2.6;
  await page.evaluate(([x, y, z]) => window.__lodestone.teleport({ x, y, z }), [sx, v.y + 0.5, sz]);
  await sleep(1500);
  const p = (await player()).pos;
  const dx = v.x - p.x, dz = v.z - p.z, dy = v.y - (p.y + 1.8);
  await look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
  await sleep(800);
  await shot('vein-before');
  const tgt = await page.evaluate(() => window.__lodestoneCaves.info().target);
  let swings = 0;
  for (; swings < 20; swings++) {
    await page.keyboard.press('KeyE');
    await sleep(340);
    const info = await page.evaluate(() => window.__lodestoneCaves.info());
    if (info.target !== tgt) break; // broken: no longer targetable
    if (swings === 2) await shot('vein-mining');
  }
  await sleep(250);
  await shot('vein-mined');
  say(`mined: target ${tgt} after ${swings + 1} swings (solo: local rules; online the zone decides, see wp09-mining-respawn.txt)`);
}

const info = await page.evaluate(() => window.__lodestoneCaves.info());
const st = info.stats;
say(`cave cells built in workers: ${st.built} (mean ${(st.buildMs / Math.max(1, st.built)).toFixed(2)} ms, max ${st.maxBuildMs.toFixed(2)} ms; spec budget 12 ms), main-thread sync builds ${st.syncBuilds}, cells kept ${st.cells}, meshes drawn ${st.meshes}, pooled lights lit ${st.lights}`);
say(errors.length ? `page errors (${errors.length}):\n  ${errors.slice(0, 10).join('\n  ')}` : 'page errors: none');
fs.writeFileSync(path.join(evidence, 'wp09-cave-walk.txt'), log.join('\n') + '\n');
await browser.close();
cleanup();
process.exit(done && errors.length === 0 ? 0 : 1);
