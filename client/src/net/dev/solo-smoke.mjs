#!/usr/bin/env node
// `npm run dev:solo` must keep working with no servers at all (WP06 wired the
// online flow into the same screens). Starts Vite with VITE_SOLO=1 on a
// private port, walks for a second in headless Chromium and checks there is
// no zone session, no page error and the player moved.
//   node client/src/net/dev/solo-smoke.mjs   -> docs/evidence/wp06-solo-smoke.txt
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { env, killTree, root, waitHttp } from '../../../../scripts/lib.mjs';

const PORT = 5192;
const lines = [];
const log = (s) => {
  console.log(s);
  lines.push(s);
};
const vite = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: path.join(root, 'client'), env: env({ VITE_SOLO: '1' }), stdio: 'ignore' });
let ok = false;
let browser;
try {
  if (!(await waitHttp(`http://localhost:${PORT}/`, 60000))) throw new Error('vite did not start');
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/`);
  await page.getByTestId('play').click();
  await page.getByTestId('debug-hud').waitFor({ timeout: 90000 });
  const before = await page.evaluate(() => window.__lodestone.player().pos);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1000);
  await page.keyboard.up('KeyW');
  const after = await page.evaluate(() => window.__lodestone.player().pos);
  const net = await page.evaluate(() => window.__lodestone.netDebug());
  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  log(`solo: title -> play without servers; walked ${moved.toFixed(2)} m in 1 s; zone session: ${net === null ? 'none' : 'PRESENT'}; page errors: ${errors.length}`);
  ok = moved > 2 && net === null && errors.length === 0;
  log(ok ? 'PASS dev:solo still works offline' : `FAIL ${errors.join('; ')}`);
} catch (e) {
  log(`FAIL ${e.message}`);
} finally {
  if (browser) await browser.close();
  killTree(vite);
  fs.writeFileSync(path.join(root, 'docs', 'evidence', 'wp06-solo-smoke.txt'), lines.join('\n') + '\n');
  process.exit(ok ? 0 : 1);
}
