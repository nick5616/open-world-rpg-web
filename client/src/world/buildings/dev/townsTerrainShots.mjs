#!/usr/bin/env node
// Playtest 1 "towns on natural terrain and density" evidence: the real client
// (solo, official seed 20261108, real GPU via ANGLE/D3D11 like townBench.mjs)
// photographs the same sloped village from above and from street level, its
// footpaths from overhead, and a wide landscape view, so a run on the old
// generator and one on the new give before/after pairs with the same cameras.
//
//   node client/src/world/buildings/dev/townsTerrainShots.mjs --tag before
//   node client/src/world/buildings/dev/townsTerrainShots.mjs --tag after --at 1234,2345
//   ... --dev                       # vite dev server instead of a production build
//
// Without --at it picks the non-walled settlement whose macro slope is the
// largest (it prints its centre: pass the same --at to the other run, so both
// runs frame the same town). Writes docs/evidence/pt-towns-<tag>-*.png and
// pt-towns-<tag>-shots.txt. Servers bind 127.0.0.1 on a random free port.
/* global localStorage */
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
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const DEV = process.argv.includes('--dev');
const TAG = arg('tag', 'after');
const AT = arg('at', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const say = (s) => {
  console.log(s);
  log.push(s);
};

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
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-pt-towns-'));
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

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
await context.addInitScript(() => {
  localStorage.setItem('lodestone_quality_settings', JSON.stringify({ state: { setting: 'high' }, version: 0 }));
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
await page.addStyleTag({ content: '[data-pt-hidden]{display:none!important}' });
await T(() => {
  for (const el of document.querySelectorAll('div')) if (el.childElementCount === 0 && el.textContent?.startsWith('Click to look around')) (el.parentElement?.childElementCount === 1 ? el.parentElement : el).setAttribute('data-pt-hidden', '');
  window.__lodestone.setFreezeTime(true);
  window.__lodestone.setTimeOfDay(3600 * 0.42);
});
const genVersion = await T(() => window.__lodestoneWorld?.runtime?.genVersion ?? window.__lodestoneWorld?.genVersion ?? null);
say(`# Playtest 1 towns/terrain shots, tag ${TAG}, seed 20261108, genVersion ${genVersion ?? '?'} (${DEV ? 'vite dev' : 'production build'}), ${new Date().toISOString()}`);

const ground = (x, z) => T(([a, b]) => window.__lodestoneWorld.groundAt(a, b), [x, z]);
const look = (yaw, pitch = 0) => T(([y, p]) => window.__lodestone.setLook(y, p), [yaw, pitch]);
const lookAt = async (from, to) => {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  await look(Math.atan2(-dx, -dz), Math.atan2(to.y - from.y, Math.hypot(dx, dz)));
};
const waitIdle = async (ms = 25000) => {
  const s = Date.now();
  while (Date.now() - s < ms) {
    if (await T(() => window.__lodestoneTowns.idle())) break;
    await sleep(250);
  }
};
const camAt = async (p, q, settle = 4500) => {
  await T((v) => window.__lodestone.setFly(v), true);
  await T((t) => window.__lodestone.teleport(t), { x: p.x, y: p.y - 1.7, z: p.z });
  await sleep(600);
  await lookAt(p, q);
  await sleep(800);
  await waitIdle();
  await sleep(settle);
};
const walkAt = async (p, q, settle = 4000) => {
  await T((v) => window.__lodestone.setFly(v), false);
  await T((t) => window.__lodestone.teleport(t), { x: p.x, z: p.z });
  await sleep(1500);
  const pl = await T(() => window.__lodestone.player());
  await lookAt({ x: pl.pos.x, y: pl.pos.y + 1.7, z: pl.pos.z }, q);
  await waitIdle();
  await sleep(settle);
};
const shot = async (name) => {
  const f = `pt-towns-${TAG}-${name}.png`;
  await page.screenshot({ path: path.join(evidence, f) });
  say(`screenshot docs/evidence/${f}`);
};

const settlements = await T(() => window.__lodestoneTowns.settlements());
let town;
if (AT) {
  const [ax, az] = AT.split(',').map(Number);
  town = [...settlements].sort((a, b) => Math.hypot(a.x - ax, a.z - az) - Math.hypot(b.x - ax, b.z - az))[0];
} else {
  // The non-walled settlement (>= 8 buildings) whose building lots are the steepest:
  // mean ground range under each building's four corners.
  let best = -1;
  for (const s of settlements.filter((x) => !x.walled && x.buildings >= 8)) {
    const bs = await T((i) => window.__lodestoneTowns.buildings(i), s.index);
    let sum = 0;
    for (const b of bs) {
      const g = [];
      for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) g.push(await ground(b.x + u * b.hx * b.c - v * b.hz * b.s, b.z + u * b.hx * b.s + v * b.hz * b.c));
      sum += Math.max(...g) - Math.min(...g);
    }
    const mean = sum / Math.max(1, bs.length);
    if (mean > best) {
      best = mean;
      town = s;
    }
  }
  say(`steepest non-walled settlement: mean lot relief ${best.toFixed(2)} m`);
}
say(`town #${town.index} "${town.name}" (${town.size}, ${town.style}, walled ${town.walled}), ${town.buildings} buildings, radius ${town.radius} m at --at ${town.x.toFixed(0)},${town.z.toFixed(0)}`);
const C = { x: town.x, y: town.y, z: town.z };
const R = Math.max(40, town.radius);
const buildings = await T((i) => window.__lodestoneTowns.buildings(i), town.index);
const flags = buildings.reduce((m, b) => ((m[b.flags & 0xc4] = (m[b.flags & 0xc4] ?? 0) + 1), m), {});
say(`buildings by foundation flag bits (4 stilts, 64 stepped, 128 posts): ${JSON.stringify(flags)}`);

// 1. Above at an angle (same camera both runs: relative to the town centre).
await camAt({ x: C.x - R * 0.85, y: C.y + R * 0.75, z: C.z + R * 0.85 }, { x: C.x, y: C.y - 4, z: C.z });
await shot('town-above');
// 2. Top-down-ish: streets and footpaths.
await camAt({ x: C.x + 1, y: C.y + R * 1.7, z: C.z + R * 0.45 }, C);
await shot('paths-above');
// 3. Street level: from 55% out on the longest street, looking back at the houses toward the square.
const streets = await T((i) => window.__lodestoneTowns.streets(i), town.index);
const st = [...streets].sort((a, b) => b.points.length - a.points.length)[0];
if (st) {
  const n = st.points.length / 3;
  const k = Math.floor(n * 0.55);
  const p = { x: st.points[k * 3], z: st.points[k * 3 + 2] };
  await walkAt(p, { x: C.x, y: C.y + 2, z: C.z });
  await shot('street');
}
// 4. A building on the steepest lot, from the downhill side at eye level.
let steep = null;
let sr = -1;
for (const b of buildings.filter((x) => x.floors > 0)) {
  const g = [];
  for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) g.push(await ground(b.x + u * b.hx * b.c - v * b.hz * b.s, b.z + u * b.hx * b.s + v * b.hz * b.c));
  const r = Math.max(...g) - Math.min(...g);
  if (r > sr) {
    sr = r;
    steep = { b, g };
  }
}
if (steep) {
  const { b, g } = steep;
  const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  const lowI = g.indexOf(Math.min(...g));
  const [u, v] = corners[lowI];
  const out = { x: b.x + u * (b.hx + 7) * b.c - v * (b.hz + 7) * b.s, z: b.z + u * (b.hx + 7) * b.s + v * (b.hz + 7) * b.c };
  say(`steepest lot: building #${b.index} (${b.role}), ground range ${sr.toFixed(2)} m under its corners, floor ${b.floorY.toFixed(2)}`);
  await walkAt(out, { x: b.x, y: b.floorY + 0.5, z: b.z });
  await shot('foundation');
  // Its door from the front.
  const door = { x: b.x + b.doorU * b.c + b.hz * b.s, z: b.z + b.doorU * b.s - b.hz * b.c };
  const front = { x: b.x + b.doorU * b.c + (b.hz + 6) * b.s, z: b.z + b.doorU * b.s - (b.hz + 6) * b.c };
  await walkAt(front, { x: door.x, y: b.floorY + 1.0, z: door.z });
  await shot('door-steps');
}
// 5. Landscape: from 120 m above the spawn settlement (where every new character
// starts), looking out over ~1 km of country in the direction with the most
// settlements and structures within 1.2 km.
const spawnAt = await T(() => window.__lodestoneWorld.stats().spawn);
const home = [...settlements].sort((a, b) => Math.hypot(a.x - spawnAt.x, a.z - spawnAt.z) - Math.hypot(b.x - spawnAt.x, b.z - spawnAt.z))[0];
const H = { x: home.x, y: home.y, z: home.z };
say(`spawn settlement #${home.index} "${home.name}" (${home.size}) at ${H.x.toFixed(0)},${H.z.toFixed(0)}`);
const things = [...settlements, ...(await T(() => window.__lodestoneTowns.structures()))];
let ang = 0;
let most = -1;
for (let k = 0; k < 16; k++) {
  const a = (k / 16) * Math.PI * 2;
  const n = things.filter((t) => {
    const d = Math.hypot(t.x - H.x, t.z - H.z);
    let da = Math.abs(Math.atan2(t.z - H.z, t.x - H.x) - a) % (Math.PI * 2);
    if (da > Math.PI) da = Math.PI * 2 - da;
    return d > 60 && d < 1200 && da < 0.45;
  }).length;
  if (n > most) {
    most = n;
    ang = a;
  }
}
say(`landscape: looking ${((ang * 180) / Math.PI).toFixed(0)} deg (x toward z), ${most} settlements/structures within 1.2 km in that 50 deg sector`);
await camAt({ x: H.x, y: H.y + 120, z: H.z }, { x: H.x + Math.cos(ang) * 700, y: H.y - 30, z: H.z + Math.sin(ang) * 700 }, 8000);
await shot('landscape');
await T(() => window.__lodestone.setFly(false));
say(errors.length ? `errors (${errors.length}):\n  ${errors.slice(0, 20).join('\n  ')}` : 'no page errors');
fs.writeFileSync(path.join(evidence, `pt-towns-${TAG}-shots.txt`), log.join('\n') + '\n');
await browser.close();
cleanup();
process.exit(0);
