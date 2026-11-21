#!/usr/bin/env node
/* global localStorage, location, requestAnimationFrame */
// CR 043 evidence: the dwarves (cave dressing, a camp, a stronghold hall); same harness as CR 038's. Old header: the vertical world in the real client (solo, one headless
// Chromium on the GPU via ANGLE/D3D11): a tunnel entrance, the first view
// into a crystal cavern with blue water, the Depths, a sky archipelago from
// the ground and from an island, a sky town. Places come from the world's
// own descriptor (window.__lodestoneVerticalWorld), so the script follows the
// generator. Writes docs/evidence/pt3-dwarves-<shot>.jpg and
// pt3-dwarves-shots.json (frame times, layer, tiles per shot).
//
//   node client/src/world/vertical/dev/vertical-shots.mjs [--only a,b] [--tier low] [--out dir]
//   LODESTONE_CLIENT_URL=http://127.0.0.1:5391 node ...   # reuse a running solo Vite

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..', '..', '..');
const argv = process.argv;
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const out = path.resolve(arg('--out', path.join(root, 'docs', 'evidence')));
fs.mkdirSync(out, { recursive: true });
const only = arg('--only', null) ? new Set(arg('--only').split(',')) : null;
const tier = arg('--tier', 'high');
const prefix = arg('--prefix', 'pt3-dwarves-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gpuArgs = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];

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
  const port = Number(process.env.LODESTONE_SHOTS_PORT ?? 5391);
  base = `http://127.0.0.1:${port}`;
  vite = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: path.join(root, 'client'),
    env: { ...process.env, VITE_SOLO: '1' },
    shell: process.platform === 'win32',
    stdio: 'ignore',
  });
  process.on('exit', killVite);
  for (let i = 0; i < 160; i++) {
    try {
      if ((await fetch(base)).ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
}

const results = [];
const L = (page, fn, a) => page.evaluate(fn, a);

async function session() {
  const browser = await chromium.launch({ headless: true, args: gpuArgs });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript((t) => {
    localStorage.setItem('lodestone_quality_settings', JSON.stringify({ state: { setting: t, overrides: {}, style: 'lodestone', effects: 'auto', detected: null }, version: 1 }));
    localStorage.setItem('lodestone_whatsnew_seen', '9999');
    if (location.search.includes('nocols')) globalThis.__vtNoCols = true;
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
    if (m.type() === 'error' || /THREE\.WebGLProgram|Shader Error/.test(m.text())) errors.push(`console: ${m.text().slice(0, 600)}`);
  });
  await page.goto(`${base}/?solo&autoplay=1${process.env.VT_QS ?? ""}`);
  await page.waitForSelector('[data-testid="world-loading"]', { timeout: 120000 });
  await page.waitForSelector('[data-testid="world-loading"]', { state: 'detached', timeout: 240000 });
  await L(page, () => window.__lodestone.setFreezeTime(true));
  await L(page, () => window.__lodestone.setWeather('clear'));
  return { browser, page, errors };
}

async function settle(page, ms) {
  for (let i = 0; i < 80; i++) {
    const st = await L(page, () => ({ t: window.__lodestoneWorld.stats(), v: window.__lodestoneVertical?.stats }));
    const terrainBusy = st.t.terrain.queued + st.t.terrain.inFlight > 0 || st.t.terrain.missingWanted > 0;
    if (!terrainBusy && (!st.v || st.v.pending === 0)) break;
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

/** Yaw (camera convention: forward = (-sin yaw, -cos yaw)) to look from a to b. */
const yawTo = (a, b) => Math.atan2(-(b.x - a.x), -(b.z - a.z));

async function shot(page, errors, name, o) {
  if (only && !only.has(name)) return;
  await L(page, ([v]) => window.__lodestone.setView(v), [o.view ?? 'first']);
  await L(page, (f) => window.__lodestone.setFly(f), !!o.fly);
  await L(page, (p) => window.__lodestone.teleport(p), o.at);
  await L(page, (s) => window.__lodestone.setTimeOfDay(s), (o.hour ?? 13) * 150);
  await settle(page, o.wait ?? 6000);
  await L(page, ([y, p]) => window.__lodestone.setLook(y, p), [o.yaw, o.pitch ?? 0]);
  await sleep(1500);
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
  const file = `${prefix}${name}.jpg`;
  await page.screenshot({ path: path.join(out, file), type: 'jpeg', quality: 82 });
  const info = await L(page, () => {
    const vm = window.__lodestoneVertical;
    const pl = window.__lodestone.player();
    const g = window.__lodestoneVerticalGround;
    const p = pl.pos;
    return { pos: { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) }, mode: pl.mode, floor: g ? +g.floorAt(p.x, p.y, p.z).toFixed(1) : null, layer: vm?.layer, chamber: vm?.chamber, under: window.__lodestoneWorld?.stats?.()?.caves?.underground, stats: vm?.stats };
  });
  const s = [...frames].sort((a, b) => a - b);
  const q = (p) => +(s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0).toFixed(1);
  results.push({ file, ...info, frames: frames.length, p50: q(0.5), p95: q(0.95), errors: errors.length });
  console.log(JSON.stringify({ pos: info.pos, mode: info.mode, floor: info.floor }));
  console.log(`${file}  layer ${info.layer}  tiles ${info.stats?.tiles} tris ${info.stats?.tris}  p50 ${q(0.5)} p95 ${q(0.95)} ms`);
}

try {
  const { browser, page, errors } = await session();
  try {
    const P = await L(page, () => {
      const v = window.__lodestoneVerticalWorld;
      const pts = (c) => {
        const o = [];
        for (let k = 0; k < c.pts.length / 3; k++) o.push({ x: c.pts[k * 3], y: c.pts[k * 3 + 1], z: c.pts[k * 3 + 2] });
        return o;
      };
      // A tunnel with a rail spur: the deco rails nearest the middle of the first tunnel with rails.
      const rails = v.decos.map((d, i) => ({ d, i })).filter((e) => e.d.kind === 29 && e.d.layer === 2);
      const camp = v.chambers.find((c) => c.kind === 6);
      const hold = v.chambers.find((c) => c.kind === 7);
      const lower = v.chambers.find((c) => c.kind === 8);
      const doorOf = (c) => {
        const r = v.corridors.find((k) => k.kind === 4 && k.to === c.index);
        const p = pts(r);
        return { first: p[0], last: p[p.length - 1], p1: p[1], p2: p[Math.min(p.length - 1, 4)] };
      };
      return { rails: rails.slice(0, 40).map((e) => e.d), camp, hold, lower, cd: camp && doorOf(camp), hd: hold && doorOf(hold), ld: lower && { c: lower } };
    });
    console.log(JSON.stringify({ camp: P.camp && { x: P.camp.x, z: P.camp.z, f: P.camp.floor }, hold: P.hold && { x: P.hold.x, z: P.hold.z, f: P.hold.floor }, rails: P.rails.length }));
    // 1. A cave: a rail spur in a tunnel (supports, carts, glowworms), looking down the line.
    if (P.rails.length) {
      const r = P.rails[Math.min(P.rails.length - 1, 3)];
      const yaw = (r.yaw / 65536) * Math.PI * 2;
      const at = { x: r.x - Math.cos(yaw) * 14, y: r.y + 1.5, z: r.z - Math.sin(yaw) * 14 };
      await shot(page, errors, 'cave-rails', { at, yaw: yawTo(at, { x: r.x + Math.cos(yaw) * 20, z: r.z + Math.sin(yaw) * 20 }), pitch: 0.0, wait: 9000 });
    }
    // 2. A dwarven camp: the street from the gate, forges and braziers.
    if (P.camp) {
      const c = P.camp;
      const at = { x: c.x + c.c * c.rx * 0.66, y: c.floor + 7, z: c.z + c.s * c.rx * 0.66 };
      await shot(page, errors, 'camp', { at, yaw: yawTo(at, c), pitch: -0.14, wait: 10000, hour: 12, fly: true });
    }
    // 3. A stronghold: from inside the great door toward the throne terrace.
    if (P.hold) {
      const c = P.hold;
      const d = P.hd.last;
      const at = { x: d.x + (c.x - d.x) * 0.12, y: d.y + 3, z: d.z + (c.z - d.z) * 0.12 };
      await shot(page, errors, 'stronghold', { at, yaw: yawTo(at, c), pitch: 0.04, wait: 12000, hour: 12 });
      const at3 = { x: d.x + (c.x - d.x) * 0.42, y: c.floor + 16, z: d.z + (c.z - d.z) * 0.42 };
      await shot(page, errors, 'stronghold-door', { at: at3, yaw: yawTo(at3, d), pitch: -0.05, wait: 12000, hour: 12, fly: true });
      const at2 = { x: c.x + (d.x - c.x) * 0.55, y: c.floor + 26, z: c.z + (d.z - c.z) * 0.55 };
      await shot(page, errors, 'stronghold-throne', { at: at2, yaw: yawTo(at2, { x: c.x - (d.x - c.x) * 0.7, z: c.z - (d.z - c.z) * 0.7 }), pitch: -0.12, wait: 12000, hour: 12, fly: true });
    }
    if (errors.length) console.log(`errors:\n  ${errors.slice(0, 12).join('\n  ')}`);
    results.push({ tier, errors: errors.slice(0, 20) });
  } finally {
    await browser.close();
  }
  if (!only) fs.writeFileSync(path.join(out, `${prefix}shots.json`), JSON.stringify(results, null, 2) + '\n');
} finally {
  killVite();
}
