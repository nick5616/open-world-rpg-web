#!/usr/bin/env node
/* global requestAnimationFrame, localStorage */
// Vegetation evidence + frame-time harness (playtest 3, CR 045): forest,
// meadow, rock and bush close-ups at one quality tier, plus frame time at each
// spot, GPU-uncapped so the numbers are the true frame cost.
//
//   LODESTONE_CLIENT_URL=http://localhost:5178 node client/src/world/bench/vegetation.mjs high before
//
// argv: tier (low|medium|high|ultra) and a label (before|after) that names the
// output: docs/evidence/pt3-veg-<label>-<shot>-<tier>.jpg and
// pt3-veg-<label>-<tier>.json (frame stats, draw calls, triangles).
// Target: a production build (`VITE_SOLO=1 npx vite build`, then `vite preview`).

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '..', '..', '..', '..', 'docs', 'evidence');
mkdirSync(out, { recursive: true });
const base = process.env.LODESTONE_CLIENT_URL ?? 'http://localhost:5178';
const tier = process.argv[2] ?? 'high';
const label = process.argv[3] ?? 'after';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await ctx.addInitScript((t) => {
  localStorage.setItem('lodestone_quality_settings', JSON.stringify({ state: { setting: t }, version: 0 }));
  const w = window;
  w.__bench = { frames: [], recording: false };
  let last = performance.now();
  const tick = (now) => {
    if (w.__bench.recording) w.__bench.frames.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}, tier);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text().slice(0, 300)}`);
});
// VEG_LEVEL=0 draws the original vegetation on the same build (dev ?veg= override): the fair "before".
await page.goto(`${base}/?autoplay=1&nocache=1${process.env.VEG_LEVEL !== undefined ? `&veg=${process.env.VEG_LEVEL}` : ''}`);
await page.waitForSelector('[data-testid="world-loading"]', { timeout: 60000 });
await page.waitForSelector('[data-testid="world-loading"]', { state: 'detached', timeout: 120000 });
await sleep(800);
const spawn = (await page.evaluate(() => window.__lodestoneWorld.stats())).spawn;
await page.evaluate(() => {
  window.__lodestone.setFreezeTime(true);
  window.__lodestone.setTimeOfDay(0.42 * 3600);
  window.__lodestone.setWeather('clear'); // same sky for before and after
});

const settle = async () => {
  for (let i = 0; i < 80; i++) {
    const st = await page.evaluate(() => window.__lodestoneWorld.stats());
    if (st.terrain.queued + st.terrain.inFlight === 0 && st.terrain.missingWanted === 0) break;
    await sleep(250);
  }
  await sleep(2500);
};
const hideHud = () =>
  page.evaluate(() => {
    document.querySelector('[data-testid="debug-hud"]')?.setAttribute('style', 'display:none');
    for (const el of document.querySelectorAll('div')) if (el.childElementCount === 0 && /to look around/.test(el.textContent ?? '')) el.style.display = 'none';
  });
const record = async (ms) => {
  await page.evaluate(() => {
    window.__bench.frames = [];
    window.__bench.recording = true;
  });
  await sleep(ms);
  const f = await page.evaluate(() => {
    window.__bench.recording = false;
    return window.__bench.frames;
  });
  const st = await page.evaluate(() => window.__lodestoneWorld.stats());
  return { frames: f.length, meanMs: round(f.reduce((a, b) => a + b, 0) / Math.max(1, f.length)), p50: round(pct(f, 50)), p95: round(pct(f, 95)), p99: round(pct(f, 99)), calls: st.frame.calls, tris: st.frame.triangles, shadowTris: st.frame.shadowTris, instances: st.scatter.instances, scatterTris: st.scatter.tris, grassClumps: st.scatter.grassClumps };
};

const stats = { tier, label, when: new Date().toISOString() };
// VEG_ONLY=forest,rocks: only those shots (iterating on one look).
const only = process.env.VEG_ONLY?.split(',');
const shoot = async (name, setup) => {
  if (only && !only.includes(name)) return;
  await page.evaluate(setup);
  await settle();
  await hideHud();
  await page.screenshot({ path: join(out, `pt3-veg-${label}-${name}-${tier}.jpg`), type: 'jpeg', quality: 86 });
  stats[name] = await record(4000);
  console.log(`[${tier}/${label}] ${name}`, JSON.stringify(stats[name]));
  if (process.env.VEG_BINS) console.log((await page.evaluate(() => window.__lodestoneWorld.scatterBins())).slice(0, 14).map((b) => `${b.name} x${b.count} = ${b.tris}`).join(String.fromCharCode(10)));
};
const tp = (x, z, yaw, pitch, fly = false) => `(() => { const L = window.__lodestone; L.setFly(${fly}); L.teleport({ x: ${x}, z: ${z} }); L.setLook(${yaw}, ${pitch}); })()`;
const near = (layer, kind, x, z) => page.evaluate(([l, k, a, b]) => window.__lodestoneWorld.scatterNear(l, k, a, b), [layer, kind, x, z]);

const forest = await page.evaluate(() => window.__lodestoneWorld.biomeSpot(1));
await shoot('forest', tp(forest.x, forest.z, Math.PI * 0.8, 0.12));
await shoot('forest-trunks', tp(forest.x + 6, forest.z - 4, Math.PI * 0.3, 0.32));
// Stand a few metres off the nearest tree and look at it (needs the scatter tracker: after the first shots).
const tree = (await near(1, -1, forest.x, forest.z)) ?? forest;
await shoot('forest-stand', tp(tree.x + 9, tree.z + 9, Math.atan2(9, 9), 0.1));
// From the air: mesh LODs, the impostor ring and the horizon (fly, 28 m up, looking over the forest).
await shoot('forest-far', `(() => { const L = window.__lodestone; L.setFly(true); L.teleport({ x: ${forest.x - 60}, y: window.__lodestoneWorld.groundAt(${forest.x - 60}, ${forest.z - 60}) + 28, z: ${forest.z - 60} }); L.setLook(${-Math.PI * 0.75}, -0.12); })()`);
await shoot('meadow', tp(spawn.x + 40, spawn.z + 30, Math.PI * 0.75, -0.04));
// A town street and square: dense grass must stay out of roads, plazas and floors.
const towns = (await page.evaluate(() => window.__lodestoneWorld.sites())).filter((t) => t.category === 'settlement').sort((a, b) => Math.hypot(a.x - spawn.x, a.z - spawn.z) - Math.hypot(b.x - spawn.x, b.z - spawn.z));
if (towns[0]) await shoot('town-street', tp(towns[0].x + 7, towns[0].z + 5, Math.atan2(7, 5), -0.28));
for (const [name, kind] of [
  ['rocks', 0],
  ['rocks-mossy', 3],
]) {
  const r = (await near(2, kind, spawn.x, spawn.z)) ?? (await near(2, -1, spawn.x, spawn.z));
  if (!r) continue;
  // Stand 5 m off, looking at it.
  await shoot(name, tp(r.x + 5, r.z + 5, Math.atan2(5, 5), -0.1));
}
const bush = await near(3, 0, spawn.x, spawn.z);
if (bush) await shoot('bushes', tp(bush.x + 3.5, bush.z + 3.5, Math.atan2(3.5, 3.5), -0.1));
stats.errors = errors;
writeFileSync(join(out, `pt3-veg-${label}-${tier}.json`), JSON.stringify(stats, null, 2) + '\n');
await browser.close();
console.log('errors', errors.length, errors.slice(0, 3));
