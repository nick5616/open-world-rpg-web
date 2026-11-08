#!/usr/bin/env node
// WP20 headless evidence: the real client (solo, official seed 20261108, real
// GPU via ANGLE/D3D11 like WP05's traversal benchmark) flies to the largest
// town, frames the whole town from above and walks its street, records
// renderer.info draw calls / triangles / frame time per view (with the towns
// layer shown and hidden, same camera), and takes the WP20 screenshots:
// overview, street, interior, NPCs, forge (prompt + panel), road and bridge,
// signpost, structures of several kinds, other biome styles and a night view.
//
//   node client/src/world/buildings/dev/townBench.mjs            # production build + vite preview
//   node client/src/world/buildings/dev/townBench.mjs --dev      # vite dev server (faster to iterate)
//   ... --only overview,street   # just those views (no json/txt written)
//
// Writes docs/evidence/wp20-drawcalls.json, wp20-drawcalls.txt, wp20-*.png.
// Servers bind 127.0.0.1 on a random free port and are killed on exit.
/* global localStorage, requestAnimationFrame */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..', '..', '..');
const clientDir = path.join(root, 'client');
const evidence = path.join(root, 'docs', 'evidence');
const DEV = process.argv.includes('--dev');
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg >= 0 ? new Set(process.argv[onlyArg + 1].split(',')) : null;
const want = (name) => !ONLY || ONLY.has(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const say = (s) => {
  console.log(s);
  log.push(s);
};

/** A free port in 20000-40000 (clear of the project's fixed ports and the Hyper-V reserved ranges). */
async function freePort() {
  for (let i = 0; i < 50; i++) {
    const p = 20000 + Math.floor(Math.random() * 20000);
    const ok = await new Promise((res) => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.listen(p, '127.0.0.1', () => s.close(() => res(true)));
    });
    if (ok) return p;
  }
  throw new Error('no free port');
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
let server;
if (DEV) {
  server = spawn(npx, ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: clientDir, env: { ...process.env, VITE_SOLO: '1' }, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
} else {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-wp20-'));
  say(`building the client (VITE_SOLO=1) into ${outDir}`);
  const b = spawnSync(npx, ['vite', 'build', '--outDir', outDir, '--emptyOutDir'], { cwd: clientDir, env: { ...process.env, VITE_SOLO: '1' }, shell: process.platform === 'win32', stdio: 'inherit' });
  if (b.status !== 0) throw new Error('vite build failed');
  server = spawn(npx, ['vite', 'preview', '--outDir', outDir, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: clientDir, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
}
server.stdout.on('data', () => {});
server.stderr.on('data', () => {});
const cleanup = () => {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F']);
    else server.kill();
  } catch {}
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(1));
for (let i = 0; i < 240; i++) {
  try {
    if ((await fetch(base)).ok) break;
  } catch {}
  await sleep(500);
}

const gpuArgs = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit'];
const browser = await chromium.launch({ headless: true, args: gpuArgs });
const viewport = { width: 1600, height: 900 };
const context = await browser.newContext({ viewport });
await context.addInitScript(() => {
  localStorage.setItem('lodestone_quality_settings', JSON.stringify({ state: { setting: 'high' }, version: 0 }));
  const w = window;
  w.__wp20 = { frames: [], rec: false };
  let last = performance.now();
  const tick = (now) => {
    if (w.__wp20.rec) w.__wp20.frames.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' || (m.type() === 'warning' && m.text().includes('[towns]'))) errors.push(`console.${m.type()}: ${m.text().slice(0, 300)}`);
});
const t0 = Date.now();
await page.goto(`${base}/?solo&autoplay=1&nocache=1&seed=20261108`);
await page.waitForSelector('[data-testid="world-loading"]', { timeout: 180000 });
await page.waitForSelector('[data-testid="world-loading"]', { state: 'detached', timeout: 240000 });
await page.waitForFunction(() => !!window.__lodestoneTowns, null, { timeout: 60000 });
const renderer = await page.evaluate(() => {
  const gl = document.querySelector('canvas')?.getContext('webgl2');
  const e = gl?.getExtension('WEBGL_debug_renderer_info');
  return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
say(`# WP20 towns bench (headless Chromium, ${renderer}, ${viewport.width}x${viewport.height}, high tier, uncapped, ${DEV ? 'vite dev' : 'production build'})`);
say(`date: ${new Date().toISOString()}; playable after ${Date.now() - t0} ms`);

const T = (fn, arg) => page.evaluate(fn, arg);
// Clean screenshots: hide the debug HUD (F3) and the controls hint.
await page.keyboard.press('F3');
await page.addStyleTag({ content: '[data-wp20-hidden]{display:none!important}' });
await T(() => {
  for (const el of document.querySelectorAll('div')) if (el.childElementCount === 0 && el.textContent?.startsWith('Click to look around')) (el.parentElement?.childElementCount === 1 ? el.parentElement : el).setAttribute('data-wp20-hidden', '');
});
await T(() => {
  window.__lodestone.setFreezeTime(true);
  window.__lodestone.setTimeOfDay(3600 * 0.45);
});
const settlements = await T(() => window.__lodestoneTowns.settlements());
const largest = await T(() => window.__lodestoneTowns.largestTown());
const town = settlements[largest];
say(`largest town: #${largest} "${town.name}" (${town.size}, ${town.style}, walled ${town.walled}), ${town.buildings} buildings, ${town.npcs} NPCs, radius ${town.radius} m at (${town.x.toFixed(0)}, ${town.z.toFixed(0)})`);

const look = (yaw, pitch = 0) => T(([y, p]) => window.__lodestone.setLook(y, p), [yaw, pitch]);
const lookAt = async (from, to) => {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const dy = to.y - from.y;
  await look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
};
const player = () => T(() => window.__lodestone.player());
const waitIdle = async (ms = 20000) => {
  const s = Date.now();
  while (Date.now() - s < ms) {
    if (await T(() => window.__lodestoneTowns.idle())) break;
    await sleep(250);
  }
};
/** Fly the camera (eye) to p, look at q, wait for streaming. */
const camAt = async (p, q, settle = 4000) => {
  await T((v) => window.__lodestone.setFly(v), p.fly !== false);
  await T((t) => window.__lodestone.teleport(t), { x: p.x, y: p.y - 1.7, z: p.z });
  await sleep(600);
  await lookAt(p, q);
  await sleep(800);
  await waitIdle();
  await sleep(settle);
};
const walkAt = async (p, q, settle = 3500) => {
  await T((v) => window.__lodestone.setFly(v), false);
  await T((t) => window.__lodestone.teleport(t), p.y !== undefined ? { x: p.x, y: p.y, z: p.z } : { x: p.x, z: p.z });
  await sleep(1200);
  const pl = await player();
  await lookAt({ x: pl.pos.x, y: pl.pos.y + 1.7, z: pl.pos.z }, q);
  await waitIdle();
  await sleep(settle);
};
/** Draw calls / triangles / frame times over ~2 s at the current pose. */
const measure = async () => {
  await T(() => {
    window.__wp20.frames = [];
    window.__wp20.rec = true;
  });
  await sleep(2000);
  return T(() => {
    window.__wp20.rec = false;
    const f = window.__wp20.frames.slice().sort((a, b) => a - b);
    const st = window.__lodestoneTowns.stats();
    const mean = f.reduce((a, b) => a + b, 0) / Math.max(1, f.length);
    return { calls: st.frame.calls, triangles: st.frame.triangles, shadowCalls: st.frame.shadowCalls, frameMsMean: Math.round(mean * 100) / 100, frameMsP95: Math.round((f[Math.floor(f.length * 0.95)] ?? 0) * 100) / 100, frames: f.length, townTris: st.townTris, settlementsLoaded: st.settlements, structuresLoaded: st.structures, roadCells: st.cells, lights: st.lights };
  });
};
const shot = async (name) => {
  await page.screenshot({ path: path.join(evidence, `wp20-${name}.png`) });
  say(`screenshot docs/evidence/wp20-${name}.png`);
};
const views = [];
const record = async (name, compare = false) => {
  const on = await measure();
  let off = null;
  if (compare) {
    await T(() => window.__lodestoneTowns.setVisible(false));
    await sleep(500);
    off = await measure();
    await T(() => window.__lodestoneTowns.setVisible(true));
    await sleep(400);
  }
  views.push({ name, withTowns: on, withoutTowns: off });
  say(`${name}: ${on.calls} draw calls (${on.shadowCalls} in shadow passes), ${(on.triangles / 1e3).toFixed(0)}k tris, frame ${on.frameMsMean} ms mean / ${on.frameMsP95} p95${off ? `; without the towns layer: ${off.calls} calls, ${(off.triangles / 1e3).toFixed(0)}k tris, ${off.frameMsMean} ms` : ''}`);
};
const ground = (x, z) => T(([a, b]) => window.__lodestoneWorld.groundAt(a, b), [x, z]);
const C = { x: town.x, y: town.y, z: town.z };

// 1. The whole town from above at an angle.
if (want('overview')) {
  const R = town.radius;
  const eye = { x: C.x - R * 1.05, y: C.y + R * 0.95, z: C.z + R * 1.05 };
  await camAt(eye, { x: C.x, y: C.y - 5, z: C.z }, 5000);
  await record('overview (whole town, from above at an angle)', true);
  await shot('town-overview');
  const top = { x: C.x + 1, y: C.y + R * 2.1, z: C.z + R * 0.6 };
  await camAt(top, C, 3000);
  await record('top-down (whole town and walls)', true);
  await shot('town-top');
}

// 2. Street level: on a street 60% of the way out, looking back to the square.
const streets = await T((i) => window.__lodestoneTowns.streets(i), largest);
if (want('street')) {
  const st = streets.find((s) => s.points.length >= 6) ?? streets[0];
  const n = st.points.length / 3;
  const k = Math.floor(n * 0.62);
  const p = { x: st.points[k * 3], z: st.points[k * 3 + 2] };
  await walkAt(p, { x: C.x, y: C.y + 3, z: C.z });
  await record('street level (looking along a street to the square)', true);
  await shot('street');
}

const buildings = await T((i) => window.__lodestoneTowns.buildings(i), largest);
// 3. Interior: in the inn, back wall, looking at the door.
if (want('interior')) {
  const b = buildings.find((x) => x.role === 'inn') ?? buildings.find((x) => x.floors > 0);
  const at = (u, v) => ({ x: b.x + u * b.c - v * b.s, z: b.z + u * b.s + v * b.c });
  const p = at(b.doorU * 0.4 - b.hx * 0.15, b.hz * 0.55);
  const door = at(b.doorU, -b.hz);
  await walkAt({ ...p, y: b.floorY + 0.05 }, { x: door.x, y: b.floorY + 1.0, z: door.z });
  await record('interior (inn, looking at the door)');
  await shot('interior');
  // A house too.
  const h = buildings.find((x) => x.role === 'house' && x.floors === 1) ?? b;
  const at2 = (u, v) => ({ x: h.x + u * h.c - v * h.s, z: h.z + u * h.s + v * h.c });
  await walkAt({ ...at2(h.doorU, -h.hz + 0.9), y: h.floorY + 0.05 }, { ...at2(0, h.hz), y: h.floorY + 0.9 });
  await shot('interior-house');
}

// 4. NPCs: the square's merchants and bounty keeper.
const npcs = await T((i) => window.__lodestoneTowns.npcs(i), largest);
if (want('npcs')) {
  let best = npcs[0];
  let bn = -1;
  for (const a of npcs) {
    const n = npcs.filter((b) => Math.hypot(a.x - b.x, a.z - b.z) < 9).length;
    if (n > bn) {
      bn = n;
      best = a;
    }
  }
  const dir = Math.atan2(best.z - C.z, best.x - C.x);
  const p = { x: best.x - Math.cos(dir) * 6.5, z: best.z - Math.sin(dir) * 6.5 };
  const gy = await ground(best.x, best.z);
  await walkAt(p, { x: best.x, y: gy + 1.2, z: best.z });
  await record('NPCs in the square');
  await shot('npcs');
  // Close to one: the talk prompt and the offline panel.
  const one = npcs.find((n) => n.role === 'merchant') ?? best;
  const dir2 = Math.atan2(one.z - C.z, one.x - C.x);
  const gy2 = await ground(one.x, one.z);
  await walkAt({ x: one.x - Math.cos(dir2) * 2.4, z: one.z - Math.sin(dir2) * 2.4 }, { x: one.x, y: gy2 + 1.3, z: one.z });
  say(`target near ${one.name}: ${JSON.stringify(await T(() => window.__lodestoneTowns.target()))}`);
  await shot('npc-talk-prompt');
  await page.keyboard.press('KeyE');
  await sleep(600);
  say(`after E: panel ${JSON.stringify(await T(() => window.__lodestoneTowns.panel()))}`);
  await shot('npc-talk-panel');
  await page.keyboard.press('Escape');
}

// 5. The forge: prompt in front of it, then the station panel.
if (want('forge')) {
  const f = buildings.find((x) => x.role === 'forge');
  const forge = (await T(([i, k]) => window.__lodestoneTowns.props(i, k), [largest, 10]))[0];
  if (f && forge) {
    const dx = f.frontX - forge.x;
    const dz = f.frontZ - forge.z;
    const L = Math.hypot(dx, dz) || 1;
    await walkAt({ x: forge.x + (dx / L) * 2.6, y: f.floorY + 0.05, z: forge.z + (dz / L) * 2.6 }, { x: forge.x, y: forge.y + 0.9, z: forge.z });
    say(`forge target: ${JSON.stringify(await T(() => window.__lodestoneTowns.target()))}`);
    await shot('forge');
    await page.keyboard.press('KeyE');
    await sleep(600);
    await shot('forge-panel');
    await page.keyboard.press('Escape');
    // From the street: the open front.
    await walkAt({ x: f.frontX - (dx / L) * 4, z: f.frontZ - (dz / L) * 4 }, { x: forge.x, y: forge.y + 1.5, z: forge.z });
    await shot('forge-street');
  }
}

// 6. Road and bridge.
if (want('bridge')) {
  const bridges = await T(() => window.__lodestoneTowns.bridges());
  const br = bridges.sort((a, b) => Math.hypot(b.bx - b.ax, b.bz - b.az) - Math.hypot(a.bx - a.ax, a.bz - a.az))[0];
  if (br) {
    const mx = (br.ax + br.bx) / 2;
    const mz = (br.az + br.bz) / 2;
    const L = Math.hypot(br.bx - br.ax, br.bz - br.az);
    const nx = -(br.bz - br.az) / L;
    const nz = (br.bx - br.ax) / L;
    // Above the water, off to the side and up the river a little: nothing but water between.
    const d = Math.max(12, L * 0.7);
    await camAt({ x: mx + nx * d, y: br.deckY + 6, z: mz + nz * d }, { x: mx, y: br.deckY - 0.5, z: mz });
    await record('road and bridge');
    await shot('road-bridge');
  }
}

// 7. Signpost.
if (want('signpost')) {
  const signs = await T(() => window.__lodestoneTowns.signs());
  const sg = signs[0];
  if (sg) {
    await walkAt({ x: sg.x + 3.2, z: sg.z + 2.2 }, { x: sg.x, y: sg.y + 2.1, z: sg.z });
    say(`signpost target: ${JSON.stringify(await T(() => window.__lodestoneTowns.target()))}`);
    await shot('signpost');
  }
}

// 8. Structures.
if (want('structures')) {
  const structures = await T(() => window.__lodestoneTowns.structures());
  for (const kind of ['ruin', 'watchtower', 'bandit_camp', 'wizard_tower', 'shrine', 'mineshaft', 'meteor_crater', 'demon_lair', 'sunken_temple']) {
    const cands = structures.filter((s) => s.kind === kind).sort((a, b) => b.pieces - a.pieces);
    const s = cands[0];
    if (!s) continue;
    const r = Math.max(10, s.radius);
    const tall = kind === 'wizard_tower' ? 12 : 0;
    await camAt({ x: s.x + r * 1.0, y: s.y + r * 0.55 + 4 + tall * 0.6, z: s.z + r * 0.9 }, { x: s.x, y: s.y + 1.5 + tall * 0.5, z: s.z }, 2500);
    await shot(`structures-${kind.replace('_', '-')}`);
  }
}

// 9. Other biome styles (one settlement each).
if (want('styles')) {
  for (const style of ['timber', 'stilt', 'stone', 'log', 'adobe']) {
    const s = settlements.filter((x) => x.style === style).sort((a, b) => b.buildings - a.buildings)[0];
    if (!s) continue;
    const R = s.radius;
    await camAt({ x: s.x - R * 0.7, y: s.y + R * 0.5 + 6, z: s.z + R * 0.75 }, { x: s.x, y: s.y, z: s.z }, 3500);
    await shot(`styles-${style}`);
  }
}

// 10. Night: lit windows, lanterns, the light pool.
if (want('night')) {
  await T(() => window.__lodestone.setTimeOfDay(3600 * 0.93));
  const R = town.radius;
  await camAt({ x: C.x - R * 0.55, y: C.y + R * 0.35, z: C.z + R * 0.6 }, { x: C.x, y: C.y, z: C.z }, 4000);
  await record('night overview');
  await shot('town-night');
  const st = streets.find((s) => s.points.length >= 6) ?? streets[0];
  const k = Math.floor((st.points.length / 3) * 0.55);
  await walkAt({ x: st.points[k * 3], z: st.points[k * 3 + 2] }, { x: C.x, y: C.y + 3, z: C.z });
  await shot('street-night');
  await T(() => window.__lodestone.setTimeOfDay(3600 * 0.45));
}

if (ONLY?.has('probe')) {
  const R = town.radius;
  await camAt({ x: C.x - R * 1.05, y: C.y + R * 0.95, z: C.z + R * 1.05 }, { x: C.x, y: C.y - 5, z: C.z }, 3000);
  const ms = await T(() => window.__lodestoneTowns.meshes());
  const byKind = {};
  for (const m of ms) {
    const k = m.name.split(' ')[0];
    byKind[k] = byKind[k] ?? { n: 0, tris: 0 };
    byKind[k].n++;
    byKind[k].tris += m.tris;
  }
  say(`probe: ${ms.length} meshes ${JSON.stringify(byKind)}`);
  say(`probe stats: ${JSON.stringify(await T(() => window.__lodestoneTowns.stats()))}`);
}
const stats = await T(() => window.__lodestoneTowns.stats());
say(`towns layer: worker ready after ${Math.round(stats.readyMs)} ms (towns_build ${Math.round(stats.worker.towns)} ms incl. wasm, textures ${Math.round(stats.worker.textures)} ms, roads ${Math.round(stats.worker.roads)} ms, all in the worker); max settlement/structure build ${stats.maxBuildMs.toFixed(1)} ms (worker); max main-thread upload step ${stats.maxUploadMs.toFixed(2)} ms; ${stats.hiddenScatter} scatter objects hidden`);
say(errors.length ? `errors (${errors.length}):\n  ${errors.slice(0, 20).join('\n  ')}` : 'no page errors');
if (!ONLY) {
  fs.writeFileSync(path.join(evidence, 'wp20-drawcalls.json'), JSON.stringify({ date: new Date().toISOString(), renderer, viewport, tier: 'high', build: DEV ? 'dev' : 'production', seed: '20261108', town: { index: largest, ...town }, budgetDrawCalls: 400, views, towns: stats, errors }, null, 2));
  fs.writeFileSync(path.join(evidence, 'wp20-drawcalls.txt'), log.join('\n') + '\n');
  say('wrote docs/evidence/wp20-drawcalls.json and .txt');
}
await browser.close();
cleanup();
process.exit(0);
