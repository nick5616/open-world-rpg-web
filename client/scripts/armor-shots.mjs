#!/usr/bin/env node
// Playtest 2 visible armor (CR 034) evidence: contact sheets of every armor
// style on the avatar rig (front and back) and of the first-person sleeves,
// from the rig dev page (rig-dev.html, src/net/dev/rigLab.ts) on its own
// Vite server (random port, killed at the end; no zone, no world).
//
//   node client/scripts/armor-shots.mjs [prefix]   -> docs/evidence/<prefix>-gallery.jpg, -gallery-back.jpg, -gallery-side.jpg, -fp-sheet.jpg, -lod.jpg
//   ARMOR_SHOTS_ONLY=gallery ...                    (just those sheets)
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
const prefix = process.argv[2] ?? 'pt2-armor';
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
  const only = process.env.ARMOR_SHOTS_ONLY?.split(',');
  const ap = (pieces) => page.evaluate((p) => window.__rigLab.ap(p), pieces);
  const shot = async (name, cols, rows, items) => {
    if (only && !only.includes(name)) return;
    await page.evaluate(([c, r, it]) => window.__rigLab.sheet(c, r, it), [cols, rows, items]);
    await page.screenshot({ path: join(out, `${prefix}-${name}.jpg`), type: 'jpeg', quality: 72 });
    console.log(`shot ${prefix}-${name}.jpg`);
  };
  // Outfits: every style and material, several rarities (trim colours, relic glow, Bitchin' holo), a gem inlay.
  const sets = [
    ['leather', [{ key: 'armor:leather_cap', rarity: 0, gem: -1 }, { key: 'armor:leather_jerkin', rarity: 1, gem: -1 }, { key: 'armor:leather_leggings', rarity: 0, gem: -1 }]],
    ['cloth + boots', [{ key: 'armor:cloth_hood', rarity: 2, gem: -1 }, { key: 'armor:cloth_robe', rarity: 2, gem: 7 }, { key: 'armor:leather_boots', rarity: 0, gem: -1 }]],
    ['iron', [{ key: 'armor:iron_helm', rarity: 1, gem: -1 }, { key: 'armor:iron_mail', rarity: 1, gem: -1 }, { key: 'armor:iron_greaves', rarity: 1, gem: -1 }]],
    ['iron cuirass', [{ key: 'armor:iron_helm', rarity: 0, gem: -1 }, { key: 'armor:iron_cuirass', rarity: 3, gem: 0 }, { key: 'armor:iron_greaves', rarity: 0, gem: -1 }]],
    ['silver (legendary)', [{ key: 'armor:silver_helm', rarity: 4, gem: -1 }, { key: 'armor:silver_cuirass', rarity: 4, gem: -1 }, { key: 'armor:silver_greaves', rarity: 4, gem: -1 }]],
    ['silver circlet', [{ key: 'armor:silver_circlet', rarity: 3, gem: 1 }, { key: 'armor:cloth_robe', rarity: 3, gem: -1 }, null]],
    ['sunsteel', [{ key: 'armor:sunsteel_helm', rarity: 2, gem: -1 }, { key: 'armor:sunsteel_mail', rarity: 2, gem: -1 }, { key: 'armor:sunsteel_greaves', rarity: 2, gem: -1 }]],
    ['starmetal (mythic)', [{ key: 'armor:starmetal_helm', rarity: 5, gem: 4 }, { key: 'armor:starmetal_cuirass', rarity: 5, gem: -1 }, { key: 'armor:starmetal_greaves', rarity: 5, gem: -1 }]],
    ['voidglass (Bitchin\')', [{ key: 'armor:voidglass_helm', rarity: 7, gem: -1 }, { key: 'armor:voidglass_cuirass', rarity: 7, gem: 7 }, { key: 'armor:voidglass_greaves', rarity: 7, gem: -1 }]],
    ['none', [null, null, null]],
  ];
  const outfits = [];
  for (const [label, pieces] of sets) outfits.push({ label, armor: await ap(pieces) });
  await shot(
    'gallery',
    5,
    2,
    outfits.map((o) => ({ tp: { armor: o.armor, weapon: 'sword', view: 'front', dist: 3.4, label: o.label } })),
  );
  await shot(
    'gallery-back',
    5,
    2,
    outfits.map((o) => ({ tp: { armor: o.armor, weapon: 'sword', view: 'back', dist: 3.4, label: `${o.label} (back)` } })),
  );
  await shot(
    'gallery-side',
    5,
    2,
    outfits.map((o) => ({ tp: { armor: o.armor, weapon: '', view: 'threeq', dist: 3.4, action: 'slash', t: 0.4, label: `${o.label} (swing)` } })),
  );
  await shot('fp-sheet', 3, 2, [
    { fp: { armor: outfits[0].armor, weapon: 'sword', cast: 1, label: 'first person: leather jerkin' } },
    { fp: { armor: outfits[3].armor, weapon: 'sword', cast: 1, label: 'iron cuirass (relic)' } },
    { fp: { armor: outfits[2].armor, weapon: 'spear', label: 'iron mail' } },
    { fp: { armor: outfits[1].armor, weapon: 'staff', cast: 1, label: 'cloth robe' } },
    { fp: { armor: outfits[6].armor, weapon: 'sword', cast: 1, label: 'sunsteel mail' } },
    { fp: { armor: outfits[8].armor, weapon: 'wand', cast: 1, label: "voidglass (Bitchin')" } },
  ]);
  await shot('lod', 3, 1, [
    { tp: { armor: outfits[7].armor, weapon: 'sword', view: 'front', dist: 12, label: 'full rig (< 25 m)' } },
    { tp: { armor: outfits[7].armor, weapon: 'sword', view: 'front', dist: 40, label: 'mid LOD: the silhouette (25-80 m)' } },
    { tp: { armor: outfits[7].armor, weapon: 'sword', view: 'front', dist: 100, label: 'far LOD: the tinted box (> 80 m)' } },
  ]);
} finally {
  await browser?.close();
  vite.kill();
}
