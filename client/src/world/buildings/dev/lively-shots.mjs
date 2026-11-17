#!/usr/bin/env node
// Playtest 4 CR 050 evidence: the real client (solo, official seed 20261108,
// real GPU like townBench.mjs) in the largest town: a working blacksmith, two
// neighbours chatting with speech bubbles, an NPC turning to look at you, the
// town animals; plus draw calls / frame time over the NPC square (run it on
// main and on this branch for before/after numbers).
//
//   node client/src/world/buildings/dev/lively-shots.mjs [--dev] [--prefix pt4-lively] [--only smith,chat,look,animals,bench]
//
// Writes docs/evidence/<prefix>-<name>.jpg (+ <prefix>-bench.json for `bench`).
/* global requestAnimationFrame */
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
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const DEV = process.argv.includes('--dev');
const PREFIX = arg('--prefix', 'pt4-lively');
const ONLY = arg('--only', '') ? new Set(arg('--only', '').split(',')) : null;
const want = (n) => !ONLY || ONLY.has(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => console.log(s);

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
if (DEV) server = spawn(npx, ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: clientDir, env: { ...process.env, VITE_SOLO: '1' }, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
else {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-lively-'));
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

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await context.addInitScript(() => {
  window.__fr = { frames: [], rec: false };
  let last = performance.now();
  const tick = (now) => {
    if (window.__fr.rec) window.__fr.frames.push(now - last);
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
await page.goto(`${base}/?solo&autoplay=1&nocache=1&seed=20261108`);
await page.waitForSelector('[data-testid="world-loading"]', { timeout: 180000 });
await page.waitForSelector('[data-testid="world-loading"]', { state: 'detached', timeout: 240000 });
await page.waitForFunction(() => !!window.__lodestoneTowns, null, { timeout: 60000 });
const T = (fn, a) => page.evaluate(fn, a);
await page.keyboard.press('F3');
await T(() => {
  window.__lodestone.setFreezeTime(true);
  window.__lodestone.setWeather('clear');
  window.__lodestone.setTimeOfDay(3600 * 0.45);
});
const largest = arg('--town', null) !== null ? +arg('--town', 0) : await T(() => window.__lodestoneTowns.largestTown());
const allTowns = await T(() => window.__lodestoneTowns.settlements());
if (process.argv.includes('--list')) say(JSON.stringify(allTowns.map((t) => [t.index, t.name, t.size, t.npcs, Math.round(t.y)])));
const town = allTowns[largest];
const npcs = await T((i) => window.__lodestoneTowns.npcs(i), largest);
const look = (yaw, pitch = 0) => T(([y, p]) => window.__lodestone.setLook(y, p), [yaw, pitch]);
const player = () => T(() => window.__lodestone.player());
const ground = (x, z) => T(([a, b]) => window.__lodestoneWorld.groundAt(a, b), [x, z]);
const waitIdle = async () => {
  for (let i = 0; i < 80; i++) {
    if (await T(() => window.__lodestoneTowns.idle())) break;
    await sleep(250);
  }
};
/** Stand at p (walking), face q. */
const standAt = async (p, q, settle = 2500) => {
  await T((v) => window.__lodestone.setFly(v), true);
  const gy = await ground(p.x, p.z);
  await T((t) => window.__lodestone.teleport(t), { x: p.x, y: gy + 0.25, z: p.z });
  await sleep(1200);
  const pl = await player();
  const dx = q.x - pl.pos.x;
  const dz = q.z - pl.pos.z;
  await look(Math.atan2(-dx, -dz), Math.atan2(q.y - (pl.pos.y + 1.7), Math.hypot(dx, dz)));
  await waitIdle();
  await sleep(settle);
};
const shot = async (name) => {
  fs.mkdirSync(evidence, { recursive: true });
  const f = path.join(evidence, `${PREFIX}-${name}.jpg`);
  await page.screenshot({ path: f, type: 'jpeg', quality: 78 });
  say(`screenshot ${path.relative(root, f)}`);
};
const measure = async () => {
  await T(() => {
    window.__fr.frames = [];
    window.__fr.rec = true;
  });
  await sleep(2500);
  return T(() => {
    window.__fr.rec = false;
    const f = window.__fr.frames.slice().sort((a, b) => a - b);
    const st = window.__lodestoneTowns.stats();
    const mean = f.reduce((a, b) => a + b, 0) / Math.max(1, f.length);
    return { calls: st.frame.calls, shadowCalls: st.frame.shadowCalls, triangles: st.frame.triangles, frameMsMean: Math.round(mean * 100) / 100, frameMsP95: Math.round((f[Math.floor(f.length * 0.95)] ?? 0) * 100) / 100, frames: f.length };
  });
};
const C = { x: town.x, z: town.z };
const around = (n, d, ang) => ({ x: n.x - Math.cos(n.yaw + ang) * d, z: n.z - Math.sin(n.yaw + ang) * d });

if (want('smith')) {
  const s = npcs.find((n) => n.role === 'blacksmith');
  if (s) {
    const gy = await ground(s.x, s.z);
    // From the side of the anvil so the arm swing reads.
    await standAt(around(s, 3.2, Math.PI / 2), { x: s.x, y: gy + 1.2, z: s.z }, 3000);
    for (let k = 0; k < 6; k++) {
      await sleep(700);
      const l = await T(() => window.__lodestoneTowns.lively());
      if (l.sparks > 0) break;
    }
    await shot('smith');
  } else say('no blacksmith in the largest town');
}
if (want('look')) {
  const v = npcs.find((n) => n.role === 'villager' || n.role === 'farmer') ?? npcs[0];
  const gy = await ground(v.x, v.z);
  // Stand 3.5 m off its shoulder: the head turns to follow, the body stays.
  await standAt(around(v, 3.5, 1.2), { x: v.x, y: gy + 1.5, z: v.z }, 3500);
  await shot('look');
}
if (want('chat')) {
  // Two NPCs closest together; wait for the minute slot in which they talk.
  let pair = null;
  let bd = 1e9;
  for (const a of npcs)
    for (const b of npcs) {
      if (a.index >= b.index) continue;
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d > 0.8 && d < bd && a.role !== 'blacksmith' && b.role !== 'blacksmith') {
        bd = d;
        pair = [a, b];
      }
    }
  if (pair) {
    const mid = { x: (pair[0].x + pair[1].x) / 2, z: (pair[0].z + pair[1].z) / 2 };
    const gy = await ground(mid.x, mid.z);
    const dir = Math.atan2(mid.z - C.z, mid.x - C.x);
    await standAt({ x: mid.x - Math.cos(dir) * 6, z: mid.z - Math.sin(dir) * 6 }, { x: mid.x, y: gy + 2, z: mid.z }, 1500);
    say(`pair ${pair[0].name} + ${pair[1].name} at ${bd.toFixed(1)} m`);
    let got = false;
    for (let i = 0; i < 90 && !got; i++) {
      await sleep(1000);
      const l = await T(() => window.__lodestoneTowns.lively());
      got = l.chats > 0 && l.bubbles > 0;
    }
    say(`chat live: ${got}`);
    await sleep(600);
    await shot('chat');
  }
}
if (want('animals')) {
  // Chickens pecking by a farm (and whatever dog or cat is about).
  const f = npcs.find((n) => n.role === 'farmer') ?? npcs[0];
  const gy = await ground(f.x, f.z);
  await standAt({ x: f.x + 4.5, z: f.z + 3 }, { x: f.x, y: gy + 0.4, z: f.z }, 3500);
  say(`animals: ${JSON.stringify(await T(() => window.__lodestoneTowns.animals()))}`);
  await shot('animals');
}
let bench = null;
if (want('bench')) {
  const best = npcs.reduce((a, n) => {
    const c = npcs.filter((b) => Math.hypot(n.x - b.x, n.z - b.z) < 9).length;
    return c > a.c ? { n, c } : a;
  }, { n: npcs[0], c: -1 }).n;
  const gy = await ground(best.x, best.z);
  const dir = Math.atan2(best.z - C.z, best.x - C.x);
  await standAt({ x: best.x - Math.cos(dir) * 6.5, z: best.z - Math.sin(dir) * 6.5 }, { x: best.x, y: gy + 1.2, z: best.z }, 3500);
  bench = await measure();
  say(`NPC square: ${bench.calls} draw calls (${bench.shadowCalls} in shadow passes), frame ${bench.frameMsMean} ms mean / ${bench.frameMsP95} p95 over ${bench.frames} frames`);
  fs.writeFileSync(path.join(evidence, `${PREFIX}-bench.json`), JSON.stringify({ date: new Date().toISOString(), seed: '20261108', town: town.index, view: bench }, null, 2));
}
if (errors.length) say(`errors:\n${errors.slice(0, 8).join('\n')}`);
await browser.close();
cleanup();
process.exit(0);
