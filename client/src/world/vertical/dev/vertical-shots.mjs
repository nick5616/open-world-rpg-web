#!/usr/bin/env node
/* global localStorage, location, requestAnimationFrame */
// CR 038 evidence: the vertical world in the real client (solo, one headless
// Chromium on the GPU via ANGLE/D3D11): a tunnel entrance, the first view
// into a crystal cavern with blue water, the Depths, a sky archipelago from
// the ground and from an island, a sky town. Places come from the world's
// own descriptor (window.__lodestoneVerticalWorld), so the script follows the
// generator. Writes docs/evidence/pt2-vertical-<shot>.jpg and
// pt2-vertical-shots.json (frame times, layer, tiles per shot).
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
const prefix = arg('--prefix', 'pt2-vertical-');
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
    for (const el of document.querySelectorAll('div')) if (el.childElementCount === 0 && /Click to look around/.test(el.textContent ?? '')) el.style.display = 'none';
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
    const p = pl.pos;
    const g = window.__lodestoneVerticalGround;
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
      const g = window.__lodestoneVerticalGround;
      const tunnels = v.surfaceOpenings.filter((o) => o.kind === 0);
      const t = tunnels[0];
      const tc = v.corridors.find((c) => c.kind === 0);
      // The balcony: the tunnel's last point before the ledge ramp (the corridor meets its chamber).
      const pts = [];
      for (let k = 0; k < tc.pts.length / 3; k++) pts.push({ x: tc.pts[k * 3], y: tc.pts[k * 3 + 1], z: tc.pts[k * 3 + 2] });
      const ch = v.chambers[tc.to];
      const eOf = (p) => {
        const dx = p.x - ch.x;
        const dz = p.z - ch.z;
        const u = dx * ch.c + dz * ch.s;
        const w = -dx * ch.s + dz * ch.c;
        return Math.hypot(u / ch.rx, w / ch.rz);
      };
      // The balcony: the first point inside the chamber's ellipse (the ledge ramp follows it).
      const bi = pts.findIndex((p) => eOf(p) < 1.0);
      const bal = pts[Math.min(pts.length - 1, Math.max(0, bi + 4))];
      const cenote = v.chambers.find((c) => c.layer === 2 && c.kind === 1) ?? v.chambers[0];
      const crystal = v.chambers.find((c) => c.layer === 2 && c.kind === 0 && c.lake > -9000) ?? v.chambers.find((c) => c.layer === 2 && c.kind === 0) ?? cenote;
      const depth = v.chambers.find((c) => c.layer === 3 && c.lake > -9000) ?? v.chambers.find((c) => c.layer === 3);
      const arch = v.archs[0];
      const town = v.islands.find((i) => i.kind === 3);
      const sat = v.islands.filter((i) => i.arch === 0 && i.kind !== 3).sort((a, b) => b.r - a.r)[0];
      const lift = v.updrafts.find((u) => u.kind === 1);
      const floorAt = (x, y, z) => g.floorAt(x, y, z);
      return { t, bal, ch, cenote, crystal, depth, arch, town, sat, lift, tf: t ? floorAt(t.x, t.y + 2, t.z) : 0, chFloor: floorAt(ch.x, ch.floor + 3, ch.z) };
    });
    console.log(JSON.stringify({ tunnel: P.t && { x: P.t.x, z: P.t.z, y: P.t.y }, bal: P.bal, ch: { x: P.ch.x, z: P.ch.z, floor: P.ch.floor, kind: P.ch.kind } }));
    // 1. Tunnel entrance: 28 m out on the downhill side, looking at the portal.
    if (P.t) {
      const yaw = (P.t.yaw / 65536) * Math.PI * 2; // facing out of the hill (downhill)
      const at = { x: P.t.x + Math.cos(yaw) * 30, z: P.t.z + Math.sin(yaw) * 30 };
      await shot(page, errors, 'tunnel-entrance', { at, yaw: yawTo(at, P.t), pitch: 0.02, hour: 17.2, wait: 7000 });
    }
    // 2. The first view into the cavern from the balcony.
    if (P.bal) {
      const at = { x: P.bal.x, y: P.bal.y + 0.5, z: P.bal.z };
      await shot(page, errors, 'cavern-first-view', { at, yaw: yawTo(at, P.ch), pitch: -0.18, wait: 9000 });
    }
    // 3. A crystal cavern with blue water, hovering over its shore.
    {
      const c = P.crystal;
      const at = { x: c.x + c.c * c.rx * 0.78, y: c.floor + 22, z: c.z + c.s * c.rx * 0.78 };
      await shot(page, errors, 'crystal-cavern', { at, yaw: yawTo(at, c), pitch: -0.16, wait: 9000, fly: true });
    }
    // 4. The cenote: light from the shaft onto the lake.
    {
      const c = P.cenote;
      const at = { x: c.x - c.c * c.rx * 0.72, y: c.floor + 30, z: c.z - c.s * c.rx * 0.72 };
      await shot(page, errors, 'cenote', { at, yaw: yawTo(at, c), pitch: -0.05, wait: 9000, hour: 12, fly: true });
    }
    // 5. The Depths.
    if (P.depth) {
      const c = P.depth;
      const at = { x: c.x + c.c * c.rx * 0.72, y: c.floor + 18, z: c.z + c.s * c.rx * 0.72 };
      await shot(page, errors, 'depths', { at, yaw: yawTo(at, c), pitch: -0.12, wait: 9000, fly: true });
    }
    // 6. The archipelago from the ground: past its sky lift, toward the islands, looking up.
    {
      const a = P.arch;
      let at = { x: a.x + a.r * 1.5, z: a.z };
      if (P.lift) {
        const dx = a.x - P.lift.x;
        const dz = a.z - P.lift.z;
        const l = Math.hypot(dx, dz);
        at = { x: P.lift.x + (dx / l) * 60, z: P.lift.z + (dz / l) * 60 };
      }
      await shot(page, errors, 'sky-from-ground', { at, yaw: yawTo(at, a), pitch: 0.42, hour: 16.5, wait: 9000 });
    }
    // 7. From an island: a satellite's rim, across to the town island and the clouds below.
    if (P.sat) {
      const isl = P.sat;
      const tgt = P.town ?? P.arch;
      const dx = isl.x - tgt.x;
      const dz = isl.z - tgt.z;
      const l = Math.hypot(dx, dz) || 1;
      const at = { x: isl.x + (dx / l) * isl.r * 0.35, y: isl.top + 6, z: isl.z + (dz / l) * isl.r * 0.35 };
      await shot(page, errors, 'sky-from-island', { at, yaw: yawTo(at, tgt), pitch: -0.12, hour: 17.4, wait: 9000 });
    }
    // 8. A sky town.
    if (P.town) {
      const isl = P.town;
      const at = { x: isl.x + isl.r * 0.45, y: isl.top + 3, z: isl.z + isl.r * 0.3 };
      await shot(page, errors, 'sky-town', { at, yaw: yawTo(at, isl), pitch: -0.02, hour: 15, wait: 10000, view: 'first' });
    }
    // CR 044: the sky palace, from far below, from the gate, inside the colonnade, the atrium, the throne hall.
    if (only && [...only].some((n) => n.startsWith('palace'))) {
      const pal = await L(page, () => {
        const v = window.__lodestoneVerticalWorld;
        const d = v.decos.find((x) => x.kind === 16);
        if (!d) return null;
        const q = Math.round(d.yaw / 16384) & 3;
        return { x: d.x, y: d.y, z: d.z, q, floor: d.y + 1.2, size: d.size };
      });
      if (pal) {
        const cs = [1, 0, -1, 0][pal.q];
        const sn = [0, -1, 0, 1][pal.q];
        const W = (lx, lz) => ({ x: pal.x + lx * cs + lz * -sn, z: pal.z + lx * sn + lz * cs });
        const look = (from, to) => yawTo(from, to);
        // From the ground below, 520 m out, looking up at the palace's island.
        {
          // Flying 330 m under the island, 600 m out: its underside, the spires and rings over the rim, the light column.
          const at = { x: pal.x + 430, y: pal.y - 330, z: pal.z + 420 };
          await shot(page, errors, 'palace-from-below', { at, yaw: look(at, pal), pitch: Math.atan2(330 + 45, Math.hypot(at.x - pal.x, at.z - pal.z)), hour: 15.5, wait: 9000, fly: true });
        }
        // Mid distance on the same height, to see the whole palace.
        {
          const a = W(-55, 150);
          const at = { x: a.x, y: pal.y + 20, z: a.z };
          await shot(page, errors, 'palace-exterior', { at, yaw: look(at, pal), pitch: 0.2, hour: 16.5, wait: 9000, fly: true });
        }
        // Across the sky at the palace's height: 700 m (the hull) and 1900 m (the horizon silhouette).
        for (const [name, dx, dz] of [
          ['palace-far', 500, 460],
          ['palace-horizon', 1300, 1250],
        ]) {
          const at = { x: pal.x + dx, y: pal.y + 25, z: pal.z + dz };
          await shot(page, errors, name, { at, yaw: look(at, pal), pitch: 0.02, hour: 16.8, wait: 9000, fly: true });
        }
        // The gate: doors open as you come.
        {
          const a = W(0, 68);
          const at = { x: a.x, y: pal.floor - 1.8, z: a.z };
          await shot(page, errors, 'palace-gate', { at, yaw: look(at, pal), pitch: 0.12, hour: 16, wait: 8000 });
        }
        // Inside: the vestibule's carpet toward the colonnade.
        {
          const a = W(0, 36);
          const at = { x: a.x, y: pal.floor + 0.2, z: a.z };
          const t = W(0, 4);
          await shot(page, errors, 'palace-inside', { at, yaw: look(at, t), pitch: 0.02, hour: 14, wait: 8000 });
        }
        // The atrium: the wind shaft, the upper gallery and the dome above.
        {
          const a = W(0, 2);
          const at = { x: a.x, y: pal.floor + 0.2, z: a.z };
          const t = W(0, -12);
          await shot(page, errors, 'palace-atrium', { at, yaw: look(at, t), pitch: 0.3, hour: 14, wait: 8000 });
        }
        // The upper gallery over the shaft, looking across to the wind ward.
        {
          const a = W(10, -11.5);
          const at = { x: a.x, y: pal.floor + 14.2, z: a.z };
          const t = W(-12, -4.5);
          await shot(page, errors, 'palace-ring', { at, yaw: look(at, t), pitch: -0.05, hour: 14, wait: 8000 });
        }
        // The throne hall, on the upper floor.
        {
          const a = W(0, -17);
          const at = { x: a.x, y: pal.floor + 14.2, z: a.z };
          const t = W(0, -37);
          await shot(page, errors, 'palace-throne', { at, yaw: look(at, t), pitch: 0.05, hour: 14, wait: 8000 });
        }
      }
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
