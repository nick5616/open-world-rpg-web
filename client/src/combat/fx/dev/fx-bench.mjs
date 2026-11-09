#!/usr/bin/env node
/* global requestAnimationFrame, PerformanceObserver, localStorage, window */
// Spell FX cast-spam benchmark (playtest 2). Headless Chromium on the real
// GPU (ANGLE D3D11) in the real generated world (solo, debug build: the FX
// layer is mounted for the bench), then:
//   idle   6 s standing still (the FX layer mounted but quiet)
//   spam   10 virtual casters on a 12 m ring around you, each casting a random
//          spell (every type, every element) about once a second, 12 s
// recording every frame time, main-thread long tasks and the engine's peak
// counts (particles, pooled effects, lights).
//
//   LODESTONE_CLIENT_URL=http://127.0.0.1:5291 node client/src/combat/fx/dev/fx-bench.mjs [high|low] [casters]

import { chromium } from 'playwright';

const base = process.env.LODESTONE_CLIENT_URL ?? 'http://localhost:5173';
const tier = process.argv[2] ?? 'high';
const casters = Number(process.argv[3] ?? 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

// LODESTONE_BENCH_UNCAPPED=1: no vsync / frame cap, so frame times show the real cost (headroom).
const uncapped = process.env.LODESTONE_BENCH_UNCAPPED === '1' ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [];
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', ...uncapped] });
const context = await browser.newContext({ viewport: tier === 'low' ? { width: 1280, height: 720 } : { width: 1920, height: 1080 } });
await context.addInitScript((t) => {
  localStorage.setItem('lodestone_quality_settings', JSON.stringify({ state: { setting: t }, version: 0 }));
}, tier);
const page = await context.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
// LODESTONE_BENCH_QUERY: extra URL parameters (`debug=1` on a production build).
await page.goto(`${base}/?autoplay=1&nocache=1${process.env.LODESTONE_BENCH_QUERY ? `&${process.env.LODESTONE_BENCH_QUERY}` : ""}`);
// (`nofx` in the query: no FX layer, idle only: the A/B baseline)
await page.waitForFunction(() => window.__lodestoneWorld?.stats?.()?.warmup && window.__lodestone?.player?.(), null, { timeout: 120000 });
await sleep(10000); // let the first ring of chunks (and the towns / caves near spawn) settle

// LODESTONE_FX_KEYS=a,b: spam only these spells (isolating one look's cost).
const keys = process.env.LODESTONE_FX_KEYS ? process.env.LODESTONE_FX_KEYS.split(',') : undefined;
const result = await page.evaluate(async ([n, keys, pre]) => {
  const L = window.__lodestone;
  const F = window.__lodestoneFx;
  L.setLook(0.3, -0.12);
  const longTasks = [];
  const po = new PerformanceObserver((l) => {
    for (const e of l.getEntries()) longTasks.push({ phase: phaseNow, ms: e.duration });
  });
  let phaseNow = 'idle';
  po.observe({ type: 'longtask', buffered: false });
  const frames = [];
  const peak = {};
  let stop = false;
  let last = performance.now();
  const tick = (now) => {
    frames.push({ phase: phaseNow, dt: now - last, t: now });
    last = now;
    if (phaseNow === 'spam') {
      const s = F.stats();
      for (const [k, v] of Object.entries(s)) if (typeof v === 'number') peak[k] = Math.max(peak[k] ?? 0, v);
    }
    if (!stop) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  await new Promise((r) => setTimeout(r, 6000));
  if (!F) {
    stop = true;
    po.disconnect();
    return { frames, longTasks, peak, casts: 0, fx: null };
  }
  // Programs linked during the spam (each one is a compile hitch): should be none (warm-up).
  const progs = () => (window.__r3f?.gl?.info?.programs ?? []).map((p) => `${p.name} | ${String(p.cacheKey).replace(/,/g, ' ').slice(0, 90)}`);
  const before = { size: progs().length };
  // LODESTONE_FX_PRESPAM=1: an unmeasured spam first (isolates first-draw costs from steady state).
  if (pre) {
    phaseNow = 'pre';
    await F.spam(n, 8000, { keys });
    await new Promise((r) => setTimeout(r, 2000));
  }
  phaseNow = 'spam';
  const { casts, log } = await F.spam(n, 12000, { keys });
  const newPrograms = progs().slice(before.size);
  newPrograms.push(`(programs: ${before.size} before, ${progs().length} after)`);
  phaseNow = 'after';
  await new Promise((r) => setTimeout(r, 1500));
  stop = true;
  po.disconnect();
  // the casts just before each slow frame (what to look at)
  const firstAt = new Map();
  for (const c of log) if (!firstAt.has(c.key)) firstAt.set(c.key, c.t);
  // the casts just before each slow frame (* = that spell's first cast this session)
  const slow = frames.filter((f) => f.phase === 'spam' && f.dt > 25).map((f) => ({ dt: Math.round(f.dt), casts: log.filter((c) => c.t <= f.t && c.t > f.t - f.dt - 20).map((c) => (firstAt.get(c.key) === c.t ? '*' : '') + c.key) }));
  return { frames, longTasks, peak, casts, slow, newPrograms, fx: F.tier() };
}, [casters, keys, process.env.LODESTONE_FX_PRESPAM === '1']);

const summary = { tier, casters, fx: result.fx, casts: result.casts };
for (const phase of result.fx ? ['idle', 'spam'] : ['idle']) {
  const dts = result.frames.filter((f) => f.phase === phase).map((f) => f.dt).slice(1);
  const lt = result.longTasks.filter((l) => l.phase === phase);
  summary[phase] = {
    frames: dts.length,
    fps: +(1000 / (dts.reduce((a, b) => a + b, 0) / Math.max(1, dts.length))).toFixed(1),
    p50: +pct(dts, 50).toFixed(1),
    p95: +pct(dts, 95).toFixed(1),
    p99: +pct(dts, 99).toFixed(1),
    max: +Math.max(...dts).toFixed(1),
    over33ms: dts.filter((d) => d > 33.4).length,
    longTasks: lt.length,
    worstLongTaskMs: lt.length ? Math.round(Math.max(...lt.map((l) => l.ms))) : 0,
  };
}
summary.peak = result.peak;
summary.slowFrames = result.slow;
summary.newPrograms = result.newPrograms;
console.log(JSON.stringify(summary, null, 2));
await browser.close();
