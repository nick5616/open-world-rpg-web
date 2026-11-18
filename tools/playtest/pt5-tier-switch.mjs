// Playtest 5 (CR 057): switch the graphics tier live (low -> medium -> high -> low ...) in a
// solo build and fail on any page error or console error. Regression check for the
// "Cannot read properties of undefined (reading 'toArray')" crash.
//
//   VITE_SOLO=1 npx vite --port 5190   (in client/)
//   LODESTONE_CLIENT_URL=http://localhost:5190 node tools/playtest/pt5-tier-switch.mjs [low,medium,high,low,ultra,medium]
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../client/package.json', import.meta.url));
const { chromium } = require('playwright');
const base = process.env.LODESTONE_CLIENT_URL ?? 'http://localhost:5190';
const seq = (process.argv[2] ?? 'low,medium,high,low,high,medium,low').split(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ headless: true, args: [`--use-angle=${process.env.LODESTONE_ANGLE ?? 'd3d11'}`, '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await ctx.addInitScript((t) => localStorage.setItem('lodestone_quality_settings', JSON.stringify({ state: { setting: t }, version: 2 })), seq[0]);
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message + '\n' + (e.stack ?? '').split('\n').slice(0, 8).join('\n')));
page.on('console', (m) => {
  if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 400));
});
await page.goto(base + '/?autoplay=1&nocache=1');
await page.waitForSelector('[data-testid="world-loading"]', { timeout: 60000 }).catch(() => {});
await page.waitForSelector('[data-testid="world-loading"]', { state: 'detached', timeout: 120000 });
await sleep(3000);
if (process.env.LODESTONE_NIGHT) await page.evaluate(() => window.__lodestone.setTimeOfDay(0));
console.log('loaded; errors so far', errs.length);
for (const t of seq.slice(1)) {
  await page.evaluate((q) => window.__lodestone.setQuality(q), t);
  await sleep(4000);
  const g = await page.evaluate(() => {
    const x = window.__lodestone.graphics();
    return { tier: x.tier, shaderTier: x.shaderTier };
  });
  console.log('after', t, 'errors', errs.length, JSON.stringify(g));
}
console.log(errs.slice(0, 3).join('\n---\n'));
await browser.close();
process.exit(errs.length ? 1 : 0);
