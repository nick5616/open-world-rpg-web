#!/usr/bin/env node
// Playtest 2 hands/arms evidence: contact sheets of the first-person hands on
// every weapon and of the third-person avatar rig in several poses, from the
// rig dev page (rig-dev.html, src/net/dev/rigLab.ts) on its own Vite server
// (random port, killed at the end; no zone, no world).
//
//   node client/scripts/rig-shots.mjs [prefix]   -> docs/evidence/<prefix>-fp.jpg, -fp-close.jpg, -tp.jpg, -tp-actions.jpg
//   RIG_SHOTS_ONLY=fp,fp-close ...               (just those sheets)
//
// LODESTONE_BENCH_GL=swiftshader renders on the CPU (no GPU in the box).

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const client = resolve(here, '..');
const out = resolve(client, '..', 'docs', 'evidence');
mkdirSync(out, { recursive: true });
const prefix = process.argv[2] ?? 'pt2-hands-arms';
const port = 20000 + Math.floor(Math.random() * 20000);
const software = process.env.LODESTONE_BENCH_GL === 'swiftshader';
const gpuArgs = software ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];

const require = (await import('node:module')).createRequire(import.meta.url);
const viteBin = join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
const vite = spawn(process.execPath, [viteBin, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: client, stdio: 'ignore' });
let browser = null;
try {
  const url = `http://127.0.0.1:${port}/rig-dev.html`;
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
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', (e) => console.log(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && console.log(`console.error: ${m.text()}`));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__rigLab?.ready, null, { polling: 200, timeout: 120000 });
  console.log('grip-to-forearm / wrist bend (deg):', JSON.stringify(await page.evaluate(() => window.__rigLab.diag())));
  const only = process.env.RIG_SHOTS_ONLY?.split(',');
  const shot = async (name, cols, rows, items) => {
    if (only && !only.includes(name)) return;
    await page.evaluate(([c, r, it]) => window.__rigLab.sheet(c, r, it), [cols, rows, items]);
    await page.screenshot({ path: join(out, `${prefix}-${name}.jpg`), type: 'jpeg', quality: 78 });
    console.log(`shot ${prefix}-${name}.jpg`);
  };
  if (process.env.RIG_SHOTS_SHEET) {
    // a one-off sheet: RIG_SHOTS_SHEET='{"cols":2,"rows":2,"items":[{"fp":{...}}]}' -> <prefix>-custom.jpg
    const c = JSON.parse(process.env.RIG_SHOTS_SHEET);
    await shot('custom', c.cols, c.rows, c.items);
  }
  const W = ['sword', 'spear', 'bow', 'staff', 'wand'];
  // 16:9 tiles with the middle-40% box and the crosshair (playtest 2 "fix the view")
  await shot('fp-rest', 2, 2, ['sword', 'spear', 'staff', 'wand'].map((weapon) => ({ fp: { weapon, box: true, label: `rest: ${weapon}` } })));
  await shot('fp-swing-wide', 2, 2, [
    { fp: { weapon: 'sword', swing: 0.2, box: true, label: 'forehand: wind-up' } },
    { fp: { weapon: 'sword', swing: 0.4, box: true, label: 'forehand: cut' } },
    { fp: { weapon: 'sword', swing: 0.4, dir: -1, box: true, label: 'backhand: cut' } },
    { fp: { weapon: 'sword', cast: 1, box: true, label: 'sword + off-hand cast' } },
  ]);
  await shot('fp', 3, 2, [
    ...W.map((weapon) => ({ fp: { weapon, draw: weapon === 'bow' ? 0.7 : 0, label: `first person: ${weapon}` } })),
    { fp: { weapon: 'sword', cast: 1, label: 'first person: sword + off-hand cast' } },
  ]);
  await shot('fp-close', 4, 2, [
    ...W.map((weapon) => ({ fp: { weapon, close: 'r', draw: weapon === 'bow' ? 0.7 : 0, label: `right hand: ${weapon}` } })),
    { fp: { weapon: 'spear', close: 'l', label: 'left hand: spear' } },
    { fp: { weapon: 'bow', close: 'l', draw: 0.7, label: 'left hand: bow' } },
    { fp: { weapon: 'sword', close: 'cast', cast: 1, fov: 30, label: 'left hand: cast' } },
  ]);
  await shot('fp-swing', 3, 2, [
    { fp: { weapon: 'sword', swing: 0.15, label: 'sword swing: wind-up' } },
    { fp: { weapon: 'sword', swing: 0.4, label: 'sword swing: cut' } },
    { fp: { weapon: 'sword', swing: 0.6, label: 'sword swing: follow-through' } },
    { fp: { weapon: 'sword', swing: 0.15, dir: -1, label: 'backhand: wind-up' } },
    { fp: { weapon: 'sword', swing: 0.4, dir: -1, label: 'backhand: cut' } },
    { fp: { weapon: 'staff', swing: 0.4, label: 'staff swing' } },
  ]);
  await shot('fp-sword', 2, 1, [
    { fp: { weapon: 'sword', close: 'r', fov: 13, label: 'right hand on the sword' } },
    { fp: { weapon: 'wand', close: 'r', fov: 13, label: 'right hand on the wand' } },
  ]);
  await shot('tp', 4, 2, [
    { tp: { view: 'front', label: 'idle front' } },
    { tp: { view: 'side', label: 'idle right side' } },
    { tp: { view: 'back', label: 'idle back' } },
    { tp: { view: 'left', label: 'idle left side' } },
    { tp: { view: 'threeq', speed: 4.9, label: 'walking' } },
    { tp: { view: 'front', weapon: 'bow', action: 'draw', t: 0.2, label: 'bow draw' } },
    { tp: { view: 'threeq', weapon: '', instrument: 'strum', label: 'lute' } },
    { tp: { view: 'side', riding: true, dist: 4.5, label: 'riding' } },
  ]);
  await shot('tp-close', 4, 2, [
    { tp: { view: 'front', at: [0, 1.45, 0], dist: 1.3, label: 'shoulders front' } },
    { tp: { view: 'threeq', at: [0.3, 1.4, 0], dist: 1.1, label: 'right shoulder' } },
    { tp: { view: 'back', at: [0, 1.45, 0], dist: 1.3, label: 'shoulders back' } },
    { tp: { view: 'front', action: 'cast', t: 0.45, at: [0, 1.45, 0], dist: 1.5, label: 'cast: shoulders' } },
    { tp: { view: 'side', at: [0.38, 0.82, -0.06], dist: 0.62, label: 'right fist on the sword' } },
    { tp: { view: 'front', at: [0.38, 0.82, -0.06], dist: 0.62, label: 'right fist, front' } },
    { tp: { view: 'front', weapon: '', at: [0.38, 0.82, -0.02], dist: 0.62, label: 'empty fist' } },
    { tp: { view: 'threeq', action: 'slash', t: 0.3, at: [0, 1.4, 0], dist: 1.6, label: 'wind-up: shoulder' } },
  ]);
  await shot('tp-actions', 4, 2, [
    { tp: { view: 'front', action: 'slash', t: 0.3, label: 'slash wind-up' } },
    { tp: { view: 'threeq', action: 'slash', t: 0.5, label: 'mid-swing' } },
    { tp: { view: 'back', action: 'slash', t: 0.5, label: 'mid-swing back' } },
    { tp: { view: 'front', action: 'cast', t: 0.45, label: 'cast' } },
    { tp: { view: 'side', action: 'cast', t: 0.45, label: 'cast side' } },
    { tp: { view: 'front', weapon: 'staff', action: 'castBig', t: 0.5, label: 'big cast' } },
    { tp: { view: 'threeq', weapon: 'spear', action: 'thrust', t: 0.4, label: 'spear thrust' } },
    { tp: { view: 'front', weapon: '', instrument: 'drum', label: 'drum' } },
  ]);
} finally {
  await browser?.close().catch(() => {});
  vite.kill();
}
