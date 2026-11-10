// Evidence screenshots of the spell FX gallery (gallery.html), on the real
// GPU (ANGLE/D3D11), high and low:
//
//   npx vite-node src/combat/fx/dev/fx-shots.ts [high|low ...]     (from client/)
//   LODESTONE_FX_URL=http://127.0.0.1:5291 to reuse a running Vite.
//
// Writes docs/evidence/pt2-spell-vfx-<element>-<tier>.png (projectile,
// impact, area, beam/chain, rune, high-tier spell), -seq-<tier>.png (frame
// sequences of set pieces), -firstperson-<tier>.png (your own casts, with
// the crosshair) and -status-<tier>.png.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Page } from 'playwright';
import { repoRoot, waitHttp } from '../../../sim/dev/traversalRun';

type When = 'flight' | 'impact' | number;
type Panel = [label: string, key: string, when: When];

const ELEMENTS: Record<string, Panel[]> = {
  fire: [['projectile', 'fireball', 'flight'], ['impact', 'fireball', 'impact'], ['area', 'eruption', 'impact'], ['beam', 'cauterize', 900], ['rune', 'rune_magma', 560], ['high tier', 'inferno_domain', 1400]],
  ice: [['projectile', 'glacial_spike', 'flight'], ['impact', 'glacial_lob', 'impact'], ['area', 'frost_nova', 160], ['beam', 'divine_judgement', 90], ['rune', 'rune_glacier', 600], ['high tier', 'absolute_zero', 1500]],
  lightning: [['projectile', 'ball_lightning', 'flight'], ['impact', 'spark_jab', 'impact'], ['area', 'lightning_strike', 'impact'], ['chain', 'chain_lightning', 90], ['area (self)', 'thunderclap', 120], ['high tier', 'act_of_god', 'impact']],
  earth: [['projectile', 'thorn_dart', 'flight'], ['impact', 'geode_bomb', 'impact'], ['area (line)', 'fissure', 260], ['beam', 'the_monolith', 'impact'], ['rune', 'rune_root', 560], ['high tier', 'wildwood_domain', 1600]],
  wind: [['projectile', 'razor_wind', 'flight'], ['impact', 'razor_wind', 'impact'], ['area (cone)', 'gust', 160], ['beam', 'heavens_exhale', 120], ['area (lingering)', 'cyclone', 1200], ['high tier', 'howling_expanse', 1500]],
  light: [['projectile', 'radiant_lance', 'flight'], ['impact', 'glint', 'impact'], ['area', 'sunburst', 150], ['beam', 'god_ray', 110], ['heal', 'halo', 900], ['high tier', 'let_there_be_light', 'impact']],
  dark: [['projectile', 'blood_lance', 'flight'], ['impact', 'hex_bomb', 'impact'], ['area', 'blood_nova', 200], ['beam', 'soul_drain', 900], ['rune', 'rune_soul', 760], ['high tier', 'event_horizon', 1500]],
  void: [['projectile', 'void_bloom', 'flight'], ['impact', 'rift_shot', 'impact'], ['area', 'collapse', 'impact'], ['beam', 'null_gaze', 130], ['area (self)', 'null_field', 420], ['high tier', 'zero_point', 1500]],
};

const SEQUENCES: { key: string; view: string; at: number[] }[] = [
  { key: 'fireball', view: 'observer', at: [150, 380, 520, 900] },
  { key: 'lightning_strike', view: 'observer', at: [300, 640, 760, 1100] },
  { key: 'let_there_be_light', view: 'wide', at: [400, 850, 1050, 1600] },
  { key: 'inferno_domain', view: 'wide', at: [150, 500, 1500, 3200] },
  { key: 'chain_lightning', view: 'observer', at: [40, 100, 180, 300] },
  { key: 'frost_nova', view: 'observer', at: [60, 200, 500, 1000] },
];

const FIRST_PERSON: Panel[] = [
  ['your fireball', 'fireball', 'flight'],
  ['charging (windup)', 'eruption', 300],
  ['your beam', 'cauterize', 600],
  ['your frost nova', 'frost_nova', 140],
  ['your blizzard', 'blizzard', 1400],
  ['your shield (edge tint)', 'ice_wall', 500],
];

const STATUSES = ['burn', 'freeze', 'shock', 'stun', 'slow', 'black_flame', 'pull', 'curse'];

const out = path.join(repoRoot, 'docs', 'evidence');
/** LODESTONE_FX_ONLY=elements,seq,fp,status (comma list) runs a subset. */
const only = process.env.LODESTONE_FX_ONLY?.split(',');
const want = (k: string) => !only || only.includes(k);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface G {
  __gallery: { ready: boolean; cast(k: string): number; local(k: string): number; status(k: string): void; clear(): void; view(v: string): void; label(s: string): void; stats(): Record<string, number>; tier(): { graphics: string; fx: string }; sample(ms: number): Promise<number[]> };
}

async function shoot(page: Page, mode: 'cast' | 'local', key: string, when: When, label: string): Promise<Buffer> {
  await page.evaluate(() => (window as unknown as G).__gallery.clear());
  await sleep(250);
  await page.evaluate((l) => (window as unknown as G).__gallery.label(l), label);
  const flight = await page.evaluate(([m, k]) => (m === 'cast' ? (window as unknown as G).__gallery.cast(k) : (window as unknown as G).__gallery.local(k)), [mode, key] as const);
  const wait = when === 'flight' ? Math.max(60, flight * 0.45) : when === 'impact' ? flight + 90 : when;
  await sleep(wait);
  return page.screenshot();
}

async function sheet(page: Page, file: string, title: string, imgs: { label: string; png: Buffer }[], cols: number, w: number, h: number): Promise<void> {
  const cells = imgs.map((i) => `<figure><img src="data:image/png;base64,${i.png.toString('base64')}" width="${w}" height="${h}"><figcaption>${i.label}</figcaption></figure>`).join('');
  await page.setViewportSize({ width: cols * w, height: Math.ceil(imgs.length / cols) * (h + 22) + 34 });
  await page.setContent(`<html><body style="margin:0;background:#111;color:#ddd;font:14px system-ui"><div style="padding:8px 10px;font-weight:600">${title}</div><div style="display:grid;grid-template-columns:repeat(${cols},${w}px)">${cells}</div><style>figure{margin:0;position:relative}figcaption{height:22px;line-height:22px;padding:0 8px;background:#1c1c1c}img{display:block}</style></body></html>`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(file);
}

async function main() {
  const tiers = process.argv.slice(2).length ? process.argv.slice(2) : ['high', 'low'];
  let vite: ChildProcess | null = null;
  let base = process.env.LODESTONE_FX_URL;
  if (!base) {
    const port = 20000 + Math.floor(Math.random() * 25000);
    const viteBin = path.join(path.dirname(createRequire(path.join(repoRoot, 'client', 'package.json')).resolve('vite/package.json')), 'bin', 'vite.js');
    vite = spawn(process.execPath, [viteBin, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: path.join(repoRoot, 'client'), stdio: 'ignore' });
    base = `http://127.0.0.1:${port}`;
    await waitHttp(`${base}/`, 90000);
  }
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
  try {
    for (const tier of tiers) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      page.on('pageerror', (e) => console.log(`pageerror: ${e.message}`));
      page.on('console', (m) => m.type() === 'error' && console.log(`console: ${m.text()}`));
      const open = async () => {
        await page.setViewportSize({ width: 1280, height: 720 });
        await page.goto(`${base}/src/combat/fx/dev/gallery.html?tier=${tier}`, { waitUntil: 'networkidle' });
        await page.waitForFunction(() => (window as unknown as G).__gallery?.ready === true, null, { timeout: 90000 });
        await sleep(600);
      };
      const comp = await browser.newPage();
      await open();
      const t = await page.evaluate(() => (window as unknown as G).__gallery.tier());
      const tag = `graphics ${t.graphics}, FX ${t.fx}`;
      for (const [el, panels] of Object.entries(want('elements') ? ELEMENTS : {})) {
        const imgs: { label: string; png: Buffer }[] = [];
        for (const [label, key, when] of panels) imgs.push({ label: `${label}: ${key}`, png: await shoot(page, 'cast', key, when, `${el} / ${label}: ${key}`) });
        await sheet(comp, path.join(out, `pt2-spell-vfx-${el}-${tier}.png`), `Spell VFX, ${el} (${tag})`, imgs, 3, 640, 360);
      }
      // Frame sequences of set pieces.
      const seq: { label: string; png: Buffer }[] = [];
      for (const s of want('seq') ? SEQUENCES : []) {
        await page.evaluate(() => (window as unknown as G).__gallery.clear());
        await page.evaluate((v) => (window as unknown as G).__gallery.view(v), s.view);
        await sleep(250);
        const t0 = Date.now();
        await page.evaluate((k) => (window as unknown as G).__gallery.cast(k), s.key);
        for (const at of s.at) {
          await sleep(Math.max(0, at - (Date.now() - t0)));
          seq.push({ label: `${s.key} +${Date.now() - t0} ms`, png: await page.screenshot() });
        }
      }
      if (seq.length) await sheet(comp, path.join(out, `pt2-spell-vfx-seq-${tier}.png`), `Spell VFX, frame sequences (${tag})`, seq, 4, 480, 270);
      // First person: your own casts, the crosshair stays readable.
      const fp: { label: string; png: Buffer }[] = [];
      for (const [label, key, when] of want('fp') ? FIRST_PERSON : []) fp.push({ label, png: await shoot(page, 'local', key, when, '') });
      if (fp.length) await sheet(comp, path.join(out, `pt2-spell-vfx-firstperson-${tier}.png`), `Spell VFX, first person (${tag})`, fp, 3, 640, 360);
      // Statuses on a dummy.
      await page.evaluate(() => (window as unknown as G).__gallery.view('close'));
      const st: { label: string; png: Buffer }[] = [];
      for (const s of want('status') ? STATUSES : []) {
        await page.evaluate(() => (window as unknown as G).__gallery.clear());
        await page.evaluate((k) => (window as unknown as G).__gallery.status(k), s);
        await sleep(700);
        st.push({ label: s, png: await page.screenshot() });
      }
      if (st.length) await sheet(comp, path.join(out, `pt2-spell-vfx-status-${tier}.png`), `Spell VFX, statuses on an enemy (${tag})`, st, 4, 480, 270);
      await comp.close();
      await page.close();
    }
  } finally {
    await browser.close();
    vite?.kill();
  }
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
