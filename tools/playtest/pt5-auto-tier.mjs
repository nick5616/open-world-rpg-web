/* global localStorage */
// Playtest 5 (CR 057): Auto quality in the real client (solo build, real GPU, vsync on like a player's display).
//   A  fresh profile: starts optimistic (High on this GPU), the governor measures ~28 s and settles, the one-time notice shows
//   B  a slow machine (CPU throttled 12x after load): steps down, and the notice names the tier it settled on
//   C  an explicit tier is never touched, even on that slow machine
//   D  a player saved as Auto by the old rules (stored detection = Low, version 1) is re-evaluated and starts above Low
//
//   (in client/) VITE_SOLO=1 npx vite --port 5190
//   LODESTONE_CLIENT_URL=http://localhost:5190 node tools/playtest/pt5-auto-tier.mjs [A,B,C,D]
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire(new URL('../../client/package.json', import.meta.url));
const { chromium } = require('playwright');
const base = process.env.LODESTONE_CLIENT_URL ?? 'http://localhost:5190';
const only = (process.argv[2] ?? 'A,B,C,D').split(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const say = (s) => {
  console.log(s);
  lines.push(s);
};
let fails = 0;
const check = (ok, what) => {
  say(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) fails++;
};

async function session({ storage, throttle, waitMs, shot }) {
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  if (storage) await ctx.addInitScript((s) => localStorage.setItem('lodestone_quality_settings', s), JSON.stringify(storage));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?solo&autoplay=1&nocache=1`);
  await page.waitForSelector('[data-testid="world-loading"]', { timeout: 120000 });
  await page.waitForSelector('[data-testid="world-loading"]', { state: 'detached', timeout: 240000 });
  const start = await page.evaluate(() => {
    const g = window.__lodestone.graphics();
    return { setting: g.setting, tier: g.tier, shaderTier: g.shaderTier, detected: g.detected };
  });
  if (throttle) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  }
  let noticeText = null;
  const t0 = Date.now();
  let shotDone = false;
  while (Date.now() - t0 < waitMs) {
    await sleep(500);
    const t = await page.evaluate(() => document.querySelector('[data-testid="graphics-auto-notice"]')?.textContent ?? null);
    if (t) {
      noticeText = t;
      if (shot && !shotDone) {
        shotDone = true;
        await page.screenshot({ path: shot, type: 'jpeg', quality: 80, clip: { x: 640, y: 0, width: 640, height: 120 } });
      }
    }
  }
  const end = await page.evaluate(() => {
    const g = window.__lodestone.graphics();
    return { setting: g.setting, tier: g.tier, shaderTier: g.shaderTier, detected: g.detected, log: g.autoTierLog };
  });
  await browser.close();
  return { start, end, noticeText, errors };
}

mkdirSync('docs/evidence', { recursive: true });
if (only.includes('A')) {
  say('--- A: fresh profile, no throttle');
  const r = await session({ waitMs: 75000, shot: 'docs/evidence/pt5-graphics-auto-notice.jpg' });
  say(JSON.stringify(r));
  check(r.start.setting === 'auto' && r.start.tier === 'high', `starts at High on this GPU (${r.start.tier}, renderer ${r.start.detected?.renderer?.slice(0, 50)})`);
  check(r.end.log.some((e) => e.kind === 'settled'), 'the governor settled within 75 s of play');
  check(r.end.tier === 'high', `a smooth machine stays on High (${r.end.tier}, p50 ${r.end.log.at(-1)?.p50} ms, p90 ${r.end.log.at(-1)?.p90} ms)`);
  check(r.noticeText === 'Graphics set to High; F10 to change', `one-time notice shown: "${r.noticeText}"`);
  check(r.errors.length === 0, 'no page errors');
}
if (only.includes('B')) {
  say('--- B: Auto on a slow machine (CPU throttled 12x)');
  const r = await session({ waitMs: 100000, throttle: 12 });
  say(JSON.stringify(r));
  check(r.start.tier === 'high', 'started optimistic at High');
  check(r.end.log.some((e) => e.kind === 'down'), 'stepped down');
  const verdict = r.end.log.filter((e) => e.kind === 'settled').at(-1)?.tier;
  check(verdict !== undefined && verdict !== 'high', `the governor settled on ${verdict} (effective tier ${r.end.tier}, shader tier ${r.end.shaderTier})`);
  check(r.end.shaderTier === verdict, 'the shader tier (art, shadows, post) is the verdict');
  check(r.noticeText === `Graphics set to ${verdict[0].toUpperCase()}${verdict.slice(1)}; F10 to change`, `notice names the tier: "${r.noticeText}"`);
  check(r.errors.length === 0, 'no page errors across the live tier steps');
}
if (only.includes('C')) {
  say('--- C: explicit High on the same slow machine');
  const r = await session({ storage: { state: { setting: 'high' }, version: 2 }, waitMs: 60000, throttle: 12 });
  say(JSON.stringify(r));
  check(r.end.setting === 'high' && r.end.tier === 'high' && r.end.shaderTier === 'high', 'an explicit High is never lowered');
  check(r.end.log.length === 0 && r.noticeText === null, 'no governor verdict and no notice for an explicit choice');
}
if (only.includes('D')) {
  say('--- D: saved as Auto by the old rules (stored detection Low)');
  const r = await session({ storage: { state: { setting: 'auto', detected: { renderer: 'x', gpuTier: 'low', tier: 'low', frameMs: 41 } }, version: 1 }, waitMs: 3000 });
  say(JSON.stringify(r));
  check(r.start.setting === 'auto' && r.start.tier !== 'low', `re-evaluated: starts at ${r.start.tier}, not the stored Low`);
}
writeFileSync('docs/evidence/pt5-graphics-auto-tier.txt', lines.join('\n') + '\n');
say(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
