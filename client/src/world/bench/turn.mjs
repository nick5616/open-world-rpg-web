#!/usr/bin/env node
/* global requestAnimationFrame, PerformanceObserver, localStorage */
// Turn benchmark (playtest: "turning a large amount does not feel continuous
// and sometimes feels like your gaze teleports"). Headless Chromium on the
// real GPU (ANGLE D3D11) spins the camera the way a player does — a steady
// 360 deg/s pan and then fast 180 deg flicks — driving the view through the
// same per-frame look path (setLook) and records every frame's time, the
// per-frame view-angle step, and main-thread long tasks. A frame that takes
// far longer than the display interval while turning is exactly a visible
// "teleport" of the gaze.
//
//   LODESTONE_CLIENT_URL=http://localhost:5173 node client/src/world/bench/turn.mjs [high|low]

import { chromium } from 'playwright';

const base = process.env.LODESTONE_CLIENT_URL ?? 'http://localhost:5173';
const tier = process.argv[2] ?? 'high';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: tier === 'low' ? { width: 1280, height: 720 } : { width: 1920, height: 1080 } });
await context.addInitScript((t) => {
  localStorage.setItem('lodestone_quality_settings', JSON.stringify({ state: { setting: t }, version: 0 }));
}, tier);
const page = await context.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`${base}/?autoplay=1&nocache=1`);
await page.waitForFunction(() => window.__lodestoneWorld?.stats && window.__lodestone?.player?.(), null, { timeout: 120000 });
await sleep(8000); // let the first ring of chunks settle

const result = await page.evaluate(async () => {
  const L = window.__lodestone;
  const longTasks = [];
  const po = new PerformanceObserver((l) => {
    for (const e of l.getEntries()) longTasks.push({ start: e.startTime, ms: e.duration });
  });
  po.observe({ type: 'longtask', buffered: false });
  const frames = [];
  const run = (durationMs, yawAt) =>
    new Promise((res) => {
      const t0 = performance.now();
      let last = t0;
      const tick = (now) => {
        const t = now - t0;
        L.setLook(yawAt(t), -0.05);
        frames.push({ phase: run.phase, dt: now - last });
        last = now;
        if (t < durationMs) requestAnimationFrame(tick);
        else res();
      };
      requestAnimationFrame(tick);
    });
  run.phase = 'pan';
  await run(6000, (t) => (t / 1000) * Math.PI * 2); // 360 deg/s, 6 turns
  run.phase = 'flick';
  for (let i = 0; i < 8; i++) {
    const from = i * Math.PI;
    await run(150, (t) => from + Math.min(1, t / 150) * Math.PI); // 180 deg in 150 ms
    await new Promise((r) => setTimeout(r, 400));
  }
  po.disconnect();
  if (L.setLook) L.setLook(0, -0.05);
  return { frames, longTasks };
});

const summary = {};
for (const phase of ['pan', 'flick']) {
  const dts = result.frames.filter((f) => f.phase === phase).map((f) => f.dt).slice(1);
  summary[phase] = {
    frames: dts.length,
    p50: +pct(dts, 50).toFixed(1),
    p95: +pct(dts, 95).toFixed(1),
    p99: +pct(dts, 99).toFixed(1),
    max: +Math.max(...dts).toFixed(1),
    over33ms: dts.filter((d) => d > 33.4).length,
    over50ms: dts.filter((d) => d > 50).length,
  };
}
summary.longTasks = result.longTasks.length;
summary.worstLongTaskMs = result.longTasks.length ? Math.max(...result.longTasks.map((l) => l.ms)).toFixed(0) : 0;
console.log(JSON.stringify({ tier, ...summary }, null, 2));
await browser.close();
