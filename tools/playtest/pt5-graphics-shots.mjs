// Playtest 5 (CR 057) evidence: the same spots at the same time of day on one tier, as
// docs/evidence/pt5-graphics-<label>-<shot>-<tier>.jpg plus frame stats (draw calls,
// triangles, frame time, GPU uncapped) in pt5-graphics-<label>-<tier>.json.
//
//   (in client/) VITE_SOLO=1 npx vite --port 5190
//   LODESTONE_CLIENT_URL=http://localhost:5190 node tools/playtest/pt5-graphics-shots.mjs <low|medium|high> <before|after> [--only forest,house]
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(new URL('../../client/package.json', import.meta.url));
const { chromium } = require('playwright');
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'evidence');
mkdirSync(out, { recursive: true });
const base = process.env.LODESTONE_CLIENT_URL ?? 'http://localhost:5190';
const tier = process.argv[2] ?? 'high';
const label = process.argv[3] ?? 'after';
const oi = process.argv.indexOf('--only');
const only = oi >= 0 ? process.argv[oi + 1].split(',') : null;
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
  localStorage.setItem('lodestone_quality_settings', JSON.stringify({ state: { setting: t }, version: 2 }));
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
await page.goto(`${base}/?solo&autoplay=1&nocache=1&seed=20261108`);
await page.waitForSelector('[data-testid="world-loading"]', { timeout: 120000 });
await page.waitForSelector('[data-testid="world-loading"]', { state: 'detached', timeout: 240000 });
await page.waitForFunction(() => !!window.__lodestoneTowns, null, { timeout: 60000 });
await sleep(800);
const spawn = (await page.evaluate(() => window.__lodestoneWorld.stats())).spawn;
await page.evaluate(() => {
  window.__lodestone.setFreezeTime(true);
  window.__lodestone.setTimeOfDay(0.42 * 3600);
  window.__lodestone.setWeather('clear');
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
    for (const el of document.querySelectorAll('div')) if (el.childElementCount === 0 && /Click to look around/.test(el.textContent ?? '')) el.style.display = 'none';
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
  return { frames: f.length, meanMs: round(f.reduce((a, b) => a + b, 0) / Math.max(1, f.length)), p50: round(pct(f, 50)), p95: round(pct(f, 95)), calls: st.frame.calls, tris: st.frame.triangles, shadowTris: st.frame.shadowTris, scatterTris: st.scatter.tris };
};
const stats = { tier, label, when: new Date().toISOString() };
const shoot = async (name, setup) => {
  if (only && !only.includes(name)) return;
  await page.evaluate(setup);
  await settle();
  await hideHud();
  await page.screenshot({ path: path.join(out, `pt5-graphics-${label}-${name}-${tier}.jpg`), type: 'jpeg', quality: 88 });
  stats[name] = await record(3000);
  console.log(`[${tier}/${label}] ${name}`, JSON.stringify(stats[name]));
};
const tp = (x, z, yaw, pitch) => `(() => { const L = window.__lodestone; L.setFly(false); L.teleport({ x: ${x}, z: ${z} }); L.setLook(${yaw}, ${pitch}); })()`;
const near = (layer, kind, x, z) => page.evaluate(([l, k, a, b]) => window.__lodestoneWorld.scatterNear(l, k, a, b), [layer, kind, x, z]);

const forest = await page.evaluate(() => window.__lodestoneWorld.biomeSpot(1));
await shoot('forest', tp(forest.x, forest.z, Math.PI * 0.8, 0.12));
const tree = (await near(1, -1, forest.x, forest.z)) ?? forest;
await shoot('tree', tp(tree.x + 7, tree.z + 7, Math.atan2(7, 7), 0.25));
await shoot('forest-far', `(() => { const L = window.__lodestone; L.setFly(true); L.teleport({ x: ${forest.x - 60}, y: window.__lodestoneWorld.groundAt(${forest.x - 60}, ${forest.z - 60}) + 28, z: ${forest.z - 60} }); L.setLook(${-Math.PI * 0.75}, -0.12); })()`);
// Town: the largest settlement, a street view and a house close-up from the front.
// A surface timber / cottage / stone town (the biggest settlement is a dwarven hall under the mountain), the house in
// it nearest the town centre with a door on the street side.
const all = await page.evaluate(() => window.__lodestoneTowns.settlements());
const cands = all.filter((s) => s.y > 0 && ['timber', 'cottage', 'log', 'stone'].includes(s.style) && s.buildings >= 8).sort((a, b) => b.buildings - a.buildings);
const town = cands[0] ?? all[0];
const bl = (await page.evaluate((i) => window.__lodestoneTowns.buildings(i), town.index)).filter((b) => b.role === 'house' && b.floors > 0);
bl.sort((a, b) => Math.hypot(a.x - town.x, a.z - town.z) - Math.hypot(b.x - town.x, b.z - town.z));
const h = bl[Math.min(bl.length - 1, Number(process.env.HOUSE_I ?? 4))];
const fl = Math.hypot(h.frontX - h.x, h.frontZ - h.z) || 1;
const fx = (h.frontX - h.x) / fl;
const fz = (h.frontZ - h.z) / fl;
const sx = h.x + fx * (Math.max(h.hx, h.hz) + 6);
const sz = h.z + fz * (Math.max(h.hx, h.hz) + 6);
console.log('house', h.index, h.style, 'town', town.index, town.style, town.name, 'stand', sx.toFixed(1), sz.toFixed(1));
await shoot('house', tp(sx, sz, Math.atan2(-(h.x - sx), -(h.z - sz)), 0.12));
await shoot('town-street', tp(sx + fx * 11 + fz * 5, sz + fz * 11 - fx * 5, Math.atan2(-(h.x - sx - fx * 11 - fz * 5), -(h.z - sz - fz * 11 + fx * 5)), 0.02));
stats.errors = errors;
writeFileSync(path.join(out, `pt5-graphics-${label}-${tier}.json`), JSON.stringify(stats, null, 2) + '\n');
await browser.close();
console.log('errors', errors.length, errors.slice(0, 3));
