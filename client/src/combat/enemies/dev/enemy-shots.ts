// Playtest 2 enemy models: evidence sheets and the crowd benchmark, in the
// enemy gallery (gallery.ts: the real enemy renderer + the world's post
// chain, synthetic snapshot views, headless Chromium on the GPU).
//
//   npx vite-node src/combat/enemies/dev/enemy-shots.ts          (from client/)
//   LODESTONE_ENEMY_ONLY=families,crowd,numbers,bench ...         a subset
//   LODESTONE_ENEMY_URL=http://127.0.0.1:5291 ...                 an already running Vite
//   LODESTONE_ENEMY_GROUPS=slimes,beasts ...                      some family sheets only
//
// Writes docs/evidence/pt2-enemy-models-<group>.jpg (each family idle,
// walking, winding up, striking, hit, dying), -crowd.jpg, -before-after.jpg,
// -numbers.jpg and pt2-enemy-models-bench.json (frame times: the old capsule
// dolls vs the new models, 200 and 2,000 enemies, uncapped).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Page } from 'playwright';
import { repoRoot, waitHttp } from '../../../sim/dev/traversalRun';

const out = path.join(repoRoot, 'docs', 'evidence');
const only = process.env.LODESTONE_ENEMY_ONLY?.split(',');
const want = (k: string) => !only || only.includes(k);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const GROUPS: [file: string, title: string, keys: string[]][] = [
  ['slimes', 'Slimes (squashy jelly, hop squash-and-stretch, splat)', ['slime', 'moss_slime']],
  ['beasts', 'Beasts (quadrupeds: trot cycle, head tracking, bite / charge / pounce)', ['boar', 'wolf', 'ram', 'stalker', 'lurker', 'glintfox', 'gloamhound', 'thornhide_behemoth']],
  ['crawlers', 'Crawlers (six legs, tripod gait, pincers / sting)', ['scuttler', 'cave_crawler', 'void_mite']],
  ['bandits', 'Bandits and the Huntsman (the avatar skeleton, with weapons)', ['cutthroat', 'archer', 'brute', 'hunt_master']],
  ['guardians', 'Guardians and golems', ['sentinel', 'starfall_sentinel', 'mud_golem', 'crystal_golem']],
  ['elementals', 'Elementals, wisps and flyers', ['wisp', 'ember_imp', 'frost_mote', 'spark_wisp', 'shade', 'gale_harpy', 'lumen_moth', 'gloom_bat']],
  ['demons', 'Demons (hunched, horned, glowing eyes; smoke on death)', ['gloamling', 'cinder_fiend', 'rime_wraith', 'storm_ghoul', 'grave_brute', 'gale_reaver', 'umbral_stalker', 'void_maw']],
  ['bosses', 'Bosses (set pieces)', ['warden', 'archon', 'vault_keeper', 'starless_sovereign']],
  ['summons', 'Summoned allies (spectral, element colour)', ['summon:wraith_hound', 'summon:gale_phantom', 'summon:sunlit_sentinel']],
];

const STATES: [label: string, act: string, waitMs: number][] = [
  ['idle', 'idle', 600],
  ['walking', 'walk', 700],
  ['winding up (telegraph 204)', 'windup', 2900],
  ['striking', 'strike', 260],
  ['hit (flash + flinch)', 'hit', 70],
  ['dying', 'dying', 520],
];

interface G {
  __enemies: {
    ready: boolean;
    label(s: string): void;
    show(keys: string[], o?: Record<string, unknown>): void;
    act(s: string): void;
    crowd(n: number, m: string, o?: Record<string, unknown>): void;
    numbers(): void;
    view(v: string): void;
    camera(x: number, y: number, z: number, tx: number, ty: number, tz: number): void;
    stats(): Record<string, number | string>;
    sample(ms: number): Promise<{ dt: number[]; update: number[] }>;
  };
}
const E = () => (window as unknown as G).__enemies;

async function shot(page: Page): Promise<Buffer> {
  return page.screenshot({ type: 'jpeg', quality: 82 });
}

async function sheet(page: Page, file: string, title: string, imgs: { label: string; img: Buffer }[], cols: number, w: number, h: number): Promise<void> {
  const cells = imgs.map((i) => `<figure><img src="data:image/jpeg;base64,${i.img.toString('base64')}" width="${w}" height="${h}"><figcaption>${i.label}</figcaption></figure>`).join('');
  await page.setViewportSize({ width: cols * w, height: Math.ceil(imgs.length / cols) * (h + 22) + 34 });
  await page.setContent(`<html><body style="margin:0;background:#111;color:#ddd;font:14px system-ui"><div style="padding:8px 10px;font-weight:600">${title}</div><div style="display:grid;grid-template-columns:repeat(${cols},${w}px)">${cells}</div><style>figure{margin:0;position:relative}figcaption{height:22px;line-height:22px;padding:0 8px;background:#1c1c1c}img{display:block}</style></body></html>`);
  await page.screenshot({ path: file, fullPage: true, type: 'jpeg', quality: 85 });
  console.log(file);
}

const pct = (a: number[], p: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function main() {
  let vite: ChildProcess | null = null;
  let base = process.env.LODESTONE_ENEMY_URL;
  if (!base) {
    const port = 20000 + Math.floor(Math.random() * 25000);
    const viteBin = path.join(path.dirname(createRequire(path.join(repoRoot, 'client', 'package.json')).resolve('vite/package.json')), 'bin', 'vite.js');
    vite = spawn(process.execPath, [viteBin, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: path.join(repoRoot, 'client'), stdio: 'ignore' });
    base = `http://127.0.0.1:${port}`;
    await waitHttp(`${base}/`, 90000);
  }
  const bench = want('bench');
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', ...(bench ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [])] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => console.log('pageerror', e.message));
    // the evaluate callbacks below call E() in the page: the same accessor, defined there
    await page.addInitScript(() => {
      (window as unknown as { E: () => unknown }).E = () => (window as unknown as G).__enemies;
    });
    page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.log(`[${m.type()}]`, m.text().slice(0, 300)));
    const open = async (q = 'tier=high') => {
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto(`${base}/src/combat/enemies/dev/gallery.html?${q}`);
      await page.waitForFunction(() => (window as unknown as G).__enemies?.ready, null, { timeout: 120000 });
    };
    fs.mkdirSync(out, { recursive: true });

    if (want('families')) {
      await open();
      const groups = process.env.LODESTONE_ENEMY_GROUPS?.split(',');
      for (const [file, title, keys] of GROUPS) {
        if (groups && !groups.includes(file)) continue;
        const imgs: { label: string; img: Buffer }[] = [];
        for (const [label, act, wait] of STATES) {
          await page.evaluate((k) => E().show(k, { names: false }), keys);
          await sleep(250);
          await page.evaluate((a) => E().act(a), act);
          await sleep(wait);
          imgs.push({ label, img: await shot(page) });
        }
        await sheet(page, path.join(out, `pt2-enemy-models-${file}.jpg`), title, imgs, 3, 640, 360);
        await open();
      }
    }

    if (want('numbers')) {
      await open();
      const imgs: { label: string; img: Buffer }[] = [];
      for (const [label, view] of [
        ['third person', 'tp'],
        ['first person', 'fp'],
      ] as const) {
        await page.evaluate(() => E().show(['cutthroat']));
        await page.evaluate((v) => E().view(v), view);
        await page.evaluate(() => E().numbers());
        await sleep(520);
        imgs.push({ label: `${label}: element colours, a crit (pop), resist, weak; stacked`, img: await shot(page) });
      }
      await sheet(page, path.join(out, 'pt2-enemy-models-numbers.jpg'), 'Damage numbers: smaller, element-coloured, crits pop, stacked (taken red, heal green near the camera)', imgs, 2, 640, 360);
    }

    if (want('crowd')) {
      const imgs: { label: string; img: Buffer }[] = [];
      for (const m of ['legacy', 'new'] as const) {
        await open();
        await page.evaluate((mm) => E().crowd(200, mm), m);
        await sleep(2500);
        const st = await page.evaluate(() => E().stats());
        imgs.push({ label: m === 'legacy' ? 'before: capsule + sphere dolls (200)' : `after: models (200; full ${st.full}, mid ${st.mid}, far ${st.far}, ${st.drawCalls} enemy draws)`, img: await shot(page) });
      }
      await sheet(page, path.join(out, 'pt2-enemy-models-before-after.jpg'), 'A synthetic crowd of 200 (every family, wandering, attacking): before / after', imgs, 2, 640, 360);
      await open();
      await page.evaluate(() => E().crowd(200, 'new'));
      await sleep(2500);
      await page.screenshot({ path: path.join(out, 'pt2-enemy-models-crowd.jpg'), type: 'jpeg', quality: 85 });
      console.log(path.join(out, 'pt2-enemy-models-crowd.jpg'));
    }

    if (bench) {
      const result: Record<string, unknown> = { note: 'enemy gallery, 1280x720, high tier (post chain, shadows), uncapped (no vsync); a wandering crowd of every family with telegraphs and hits; frame = requestAnimationFrame delta, update = the enemy layer CPU (ms)', at: new Date().toISOString() };
      for (const n of [200, 2000]) {
        for (const m of ['legacy', 'new'] as const) {
          await open();
          await page.evaluate(([nn, mm]) => E().crowd(nn as number, mm as string, { spread: nn === 2000 ? 260 : 130 }), [n, m] as const);
          await sleep(3000);
          const s = await page.evaluate(() => E().sample(8000));
          const dts = s.dt.slice(5);
          const st = await page.evaluate(() => E().stats());
          result[`${m}-${n}`] = {
            frames: dts.length,
            fps: +(1000 / (dts.reduce((a, b) => a + b, 0) / Math.max(1, dts.length))).toFixed(1),
            p50: +pct(dts, 50).toFixed(2),
            p95: +pct(dts, 95).toFixed(2),
            p99: +pct(dts, 99).toFixed(2),
            max: +Math.max(...dts).toFixed(1),
            updateP50: +pct(s.update, 50).toFixed(3),
            updateP95: +pct(s.update, 95).toFixed(3),
            drawCalls: st.calls,
            triangles: st.triangles,
            ...(m === 'new' ? { full: st.full, mid: st.mid, far: st.far, culled: st.culled, enemyDraws: st.drawCalls, batches: st.batches } : {}),
          };
          console.log(m, n, JSON.stringify(result[`${m}-${n}`]));
        }
      }
      fs.writeFileSync(path.join(out, 'pt2-enemy-models-bench.json'), JSON.stringify(result, null, 2) + '\n');
      console.log(path.join(out, 'pt2-enemy-models-bench.json'));
    }
  } finally {
    await browser.close();
    vite?.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
