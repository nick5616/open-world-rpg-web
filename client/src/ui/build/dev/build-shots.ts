// Playtest 3 base building (CR 041) evidence in headless Chromium: the build
// dev page (build-dev.html, buildLab.ts) on its own Vite server (random
// port, killed at the end; no zone, no world): a small house placed through
// the real build rules and drawn by the real renderer, by day and by night,
// and the ghost green and red.
//
//   cd client && npx vite-node src/ui/build/dev/build-shots.ts
//
// LODESTONE_BENCH_GL=swiftshader renders on the CPU. Writes
// docs/evidence/pt3-base-building-*.png.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { chromium, type Browser } from 'playwright';
import { repoRoot } from '../../../sim/dev/traversalRun';

const out = path.join(repoRoot, 'docs', 'evidence');
const software = process.env.LODESTONE_BENCH_GL === 'swiftshader';
const gpuArgs = software ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];

async function randomPort(): Promise<number> {
  for (;;) {
    const p = 20000 + Math.floor(Math.random() * 25000);
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (ok) return p;
  }
}

type Lab = { ready: boolean; shot(o: { time?: string; view?: string; ghost?: string }): { pieces: number; refused: string[] }; tris(): number; calls(): number };

async function main(): Promise<void> {
  fs.mkdirSync(out, { recursive: true });
  const port = await randomPort();
  const viteBin = path.join(path.dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin', 'vite.js');
  const vite = spawn(process.execPath, [viteBin, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: path.join(repoRoot, 'client'), stdio: 'ignore' });
  let browser: Browser | null = null;
  try {
    const url = `http://127.0.0.1:${port}/build-dev.html`;
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(url)).ok) break;
      } catch {
        /* not up yet */
      }
      if (i > 120) throw new Error('vite did not start');
      await new Promise((r) => setTimeout(r, 500));
    }
    browser = await chromium.launch({ headless: true, args: gpuArgs });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => console.log(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && console.log(`console.error: ${m.text()}`));
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => (window as unknown as { __buildLab?: Lab }).__buildLab?.ready, null, { polling: 200, timeout: 120000 });
    const shots: [string, { time: string; view: string; ghost?: string }][] = [
      ['day', { time: 'day', view: 'front' }],
      ['day-corner', { time: 'day', view: 'corner' }],
      ['night', { time: 'night', view: 'front' }],
      ['night-inside', { time: 'night', view: 'inside' }],
      ['ghost', { time: 'day', view: 'close', ghost: 'both' }],
    ];
    for (const [name, o] of shots) {
      const r = await page.evaluate((a) => (window as unknown as { __buildLab: Lab }).__buildLab.shot(a), o);
      if (name === 'day') console.log(`pieces ${r.pieces}, refused by the rules: ${r.refused.length ? r.refused.join('; ') : 'none'}`);
      await page.screenshot({ path: path.join(out, `pt3-base-building-${name}.png`) });
      console.log(`shot pt3-base-building-${name}.png`);
    }
    console.log('render stats (last frame):', JSON.stringify(await page.evaluate(() => ({ tris: (window as unknown as { __buildLab: Lab }).__buildLab.tris(), calls: (window as unknown as { __buildLab: Lab }).__buildLab.calls() }))));
  } finally {
    await browser?.close();
    vite.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
