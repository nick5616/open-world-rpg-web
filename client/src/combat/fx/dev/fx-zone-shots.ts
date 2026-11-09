// Spell FX end to end (playtest 2): two real clients (Vite dev server,
// headless Chromium on the GPU) on a real zone process with a training camp.
// "Caster" casts the starting spells (Ember Flick projectile, Frost Bite cone
// with its slow status, Magma Dash mobility) through the real runtime;
// "Watcher" stands beside it and sees them through Event 214 (casts), 200
// (damage) and 206 (statuses). Before playtest 2 the watcher saw nothing at
// all and the caster's dash had no visual.
//
//   npx vite-node src/combat/fx/dev/fx-zone-shots.ts      (from client/; needs Go and the worldgen wasm)
//
// Writes docs/evidence/pt2-spell-vfx-zone.png.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright';
import { devTicket } from '../../../net/dev/devTicket';
import { buildZone, repoRoot, startZone, waitHttp, type ZoneProc } from '../../../sim/dev/traversalRun';

const SEED = '20261108';
const HINT = { x: 1330, z: 2330 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Handle {
  player(): { pos: { x: number; y: number; z: number } };
  setLook(yaw: number | null, pitch?: number): void;
  setQuality(q: string): void;
  setFreezeTime(v: boolean): void;
  setTimeOfDay(s: number): void;
  connectZone(r: { ticket: string; zoneEndpoint: string; zoneId: string; worldId: string; name?: string }): void;
  netDebug(): { phase: string } | null;
}
interface CombatHandle {
  runtime: { press(slot: number): void };
  hud(): { active: boolean };
}
interface FxHandle {
  stats(): Record<string, number>;
}
type W = Window & { __lodestone: Handle; __lodestoneCombat?: CombatHandle; __lodestoneFx?: FxHandle };

async function join(browser: Browser, vitePort: number, zone: ZoneProc, name: string, at: { x: number; z: number }): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [${name}] pageerror: ${e.message}`));
  await page.goto(`http://127.0.0.1:${vitePort}/?debug=1&rain=0`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!(window as unknown as W).__lodestone, null, { polling: 200, timeout: 60000 });
  const ticket = devTicket({ characterId: `pt2fx-${name}-${Date.now()}`, characterName: name, worldId: zone.worldId, zoneId: zone.zoneId });
  await page.evaluate((r) => (window as unknown as W).__lodestone.connectZone(r), { ticket, zoneEndpoint: `ws://127.0.0.1:${zone.port}/ws?spawn=${at.x.toFixed(2)},${at.z.toFixed(2)}`, zoneId: zone.zoneId, worldId: zone.worldId, name });
  await page.waitForFunction(() => (window as unknown as W).__lodestone.netDebug()?.phase === 'playing' && (window as unknown as W).__lodestone.player().pos.y > 20 && !!(window as unknown as W).__lodestoneCombat?.hud().active && !!(window as unknown as W).__lodestoneFx, null, { polling: 250, timeout: 120000 });
  await page.evaluate(() => {
    const l = (window as unknown as W).__lodestone;
    l.setQuality('high');
    l.setFreezeTime(true);
    l.setTimeOfDay(0.45 * 3600);
  });
  await page.mouse.move(640, 360);
  await page.keyboard.press('F3'); // hide the debug HUD
  return page;
}

const face = (page: Page, x: number, z: number, pitch = -0.12) =>
  page.evaluate(([tx, tz, p]) => {
    const l = (window as unknown as W).__lodestone;
    const me = l.player().pos;
    l.setLook(Math.atan2(-(tx - me.x), -(tz - me.z)), p);
  }, [x, z, pitch] as const);

async function sheet(browser: Browser, file: string, title: string, imgs: { label: string; png: Buffer }[]): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 400 } });
  const cells = imgs.map((i) => `<figure><img src="data:image/png;base64,${i.png.toString('base64')}" width="640" height="360"><figcaption>${i.label}</figcaption></figure>`).join('');
  await page.setContent(`<html><body style="margin:0;background:#111;color:#ddd;font:14px system-ui"><div style="padding:8px 10px;font-weight:600">${title}</div><div style="display:grid;grid-template-columns:repeat(2,640px)">${cells}</div><style>figure{margin:0}figcaption{height:22px;line-height:22px;padding:0 8px;background:#1c1c1c}img{display:block}</style></body></html>`);
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
  console.log(file);
}

async function main() {
  const bin = buildZone();
  const vitePort = 20000 + Math.floor(Math.random() * 25000);
  const viteBin = path.join(path.dirname(createRequire(path.join(repoRoot, 'client', 'package.json')).resolve('vite/package.json')), 'bin', 'vite.js');
  const vite = spawn(process.execPath, [viteBin, '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], { cwd: path.join(repoRoot, 'client'), stdio: 'ignore' });
  let zone: ZoneProc | null = null;
  let browser: Browser | null = null;
  try {
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 90000);
    zone = await startZone(bin, SEED, { LODESTONE_ZONE_DEBUG_CAMP: `${HINT.x},${HINT.z},1,boar`, LODESTONE_ZONE_NO_ATLAS_ENEMIES: '1', LODESTONE_ZONE_NO_DEMONS: '1' });
    let anchor: { x: number; z: number } | null = null;
    for (let i = 0; i < 60 && !anchor; i++) {
      const dbg = (await (await fetch(`http://127.0.0.1:${zone.port}/debug/combat`)).json()) as { groups?: { kind: string; x: number; z: number }[] } | null;
      anchor = dbg?.groups?.find((g) => g.kind === 'test') ?? null;
      if (!anchor) await sleep(250);
    }
    if (!anchor) throw new Error('no training camp');
    browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
    const caster = await join(browser, vitePort, zone, 'Caster', { x: anchor.x + 9, z: anchor.z });
    const watcher = await join(browser, vitePort, zone, 'Watcher', { x: anchor.x + 7, z: anchor.z + 6 });
    await sleep(4000);
    const cp = await caster.evaluate(() => (window as unknown as W).__lodestone.player().pos);
    // The watcher looks at the space between the caster and the camp.
    const aimWatcher = () => face(watcher, (cp.x + anchor!.x) / 2, (cp.z + anchor!.z) / 2, -0.15);
    const shots: { label: string; png: Buffer }[] = [];
    const cast = async (slot: number, label: string, at: number[]) => {
      await face(caster, anchor!.x, anchor!.z, slot === 1 ? -0.2 : -0.08);
      await aimWatcher();
      await sleep(300);
      const before = await watcher.evaluate(() => (window as unknown as W).__lodestoneFx!.stats());
      await caster.evaluate((s) => (window as unknown as W).__lodestoneCombat!.runtime.press(s), slot);
      let t = 0;
      for (const ms of at) {
        await sleep(ms - t);
        t = ms;
        shots.push({ label: `${label}, caster's view +${ms} ms`, png: await caster.screenshot() });
        shots.push({ label: `${label}, watcher's view (another player) +${ms} ms`, png: await watcher.screenshot() });
      }
      const after = await watcher.evaluate(() => (window as unknown as W).__lodestoneFx!.stats());
      console.log(`${label}: watcher remote casts ${before.remoteCasts} -> ${after.remoteCasts}, statuses ${after.statuses}`);
      await sleep(1500);
    };
    await cast(0, 'Ember Flick (projectile)', [90, 260]);
    await cast(1, 'Frost Bite (cone, slow)', [120, 700]);
    await cast(2, 'Magma Dash (mobility)', [140]);
    fs.mkdirSync(path.join(repoRoot, 'docs', 'evidence'), { recursive: true });
    await sheet(browser, path.join(repoRoot, 'docs', 'evidence', 'pt2-spell-vfx-zone.png'), 'Spell VFX in the real client on a real zone: your casts and another player\'s (Event 214), graphics high', shots);
  } finally {
    await browser?.close();
    zone?.proc.kill();
    vite.kill();
  }
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
