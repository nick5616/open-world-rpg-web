// Smoke test a REAL deployment in headless Chromium: play -> (waking) ->
// local profile -> character -> connected to the zone. Usage:
//   node infra/smoke-live.mjs https://<client-site> [screenshot-dir]
import path from 'node:path';
import { chromium } from 'playwright';

const url = process.argv[2];
const out = process.argv[3];
if (!url) throw new Error('usage: node infra/smoke-live.mjs <client url> [screenshot dir]');
const b = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
const t0 = Date.now();
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
try {
  await page.goto(`${url.replace(/\/$/, '')}/?debug=1`);
  await page.getByTestId('play').click();
  step('clicked play');
  if (await page.getByTestId('waking-world').waitFor({ timeout: 8000 }).then(() => true, () => false)) step('waking the world...');
  await page.getByTestId('account-screen').waitFor({ timeout: 240000 });
  step('account screen');
  await page.getByTestId('auth-local').click();
  await page.getByTestId('char-name').waitFor({ timeout: 30000 });
  const name = `Smoke${Date.now() % 100000}`;
  await page.getByTestId('char-name').fill(name);
  await page.getByTestId('char-create').click();
  await page.getByTestId(`play-${name}`).click();
  await page.waitForFunction(() => window.__lodestone?.netDebug?.()?.phase === 'playing', null, { timeout: 120000 });
  const d = await page.evaluate(() => window.__lodestone.netDebug());
  step(`playing: transport ${d.transport ?? '?'}, rtt ${d.rtt ?? '?'}`);
  await page.waitForTimeout(5000);
  if (out) await page.screenshot({ path: path.join(out, 'live-playing.png') });
  console.log('PASS');
} catch (e) {
  if (out) await page.screenshot({ path: path.join(out, 'live-failure.png') }).catch(() => {});
  console.log('FAIL', e.message, errors.slice(0, 5));
  process.exitCode = 1;
} finally {
  await b.close();
}
