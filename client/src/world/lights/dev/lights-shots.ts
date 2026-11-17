// CR 042 evidence: torches and familiar lights in the real client (Vite + headless
// Chromium on the GPU) on a private zone process, three players in the dark of an
// Underground tunnel (the world's own descriptor says where):
//   Viewer  first person, lights a torch (key 8) in the off hand
//   Frost   casts Rime Light (a spinning icicle) 7 m ahead
//   Ember   casts Hearth Mote (a hovering ember) 9 m ahead
// Shots: the tunnel dark (before), the torch alone, the torch and both familiars,
// and one contact sheet of all eight familiars (the Viewer, in third person, casts
// each school's light in turn). Also reports the pooled light intensities, frame
// time and the three.js light count before and after (it must not change).
//
//   npx vite-node src/world/lights/dev/lights-shots.ts      (from client/; needs Go and the worldgen wasm)
//
// Writes docs/evidence/pt3-lights-*.jpg and pt3-lights-run.json.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright';
import { COMBAT } from '@lodestone/contracts';
import { devTicket } from '../../../net/dev/devTicket';
import { buildZone, repoRoot, startZone, waitHttp, type ZoneProc } from '../../../sim/dev/traversalRun';

const SEED = '20261108';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAMILIARS = COMBAT.spells.filter((s) => s.familiar);
const spellId = (key: string) => FAMILIARS.find((s) => s.key === key)!.id;

interface Handle {
  player(): { pos: { x: number; y: number; z: number } };
  setLook(yaw: number | null, pitch?: number): void;
  setQuality(q: string): void;
  setView(v: 'first' | 'third'): void;
  connectZone(r: { ticket: string; zoneEndpoint: string; zoneId: string; worldId: string; name?: string }): void;
  netDebug(): { phase: string } | null;
}
type W = Window & {
  __lodestone: Handle;
  __lodestoneCombat?: { runtime: { press(w: number | string): void }; interact(kind: number, action: number, arg: number): void; hud(): { active: boolean } };
  __lodestoneDev?: { run(line: string): unknown };
  __lodestoneVerticalWorld?: { corridors: { kind: number; pts: number[] }[] };
  __lodestoneVertical?: { stats: { pending: number } };
  __lodestoneLights?: () => { slots: { key: string; intensity: number }[]; lights: number };
};

async function join(browser: Browser, vitePort: number, zone: ZoneProc, name: string, at: { x: number; z: number }, view: 'first' | 'third'): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [${name}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || /THREE\.WebGLProgram|Shader Error/.test(m.text())) console.log(`  [${name}] console: ${m.text().slice(0, 300)}`);
  });
  await page.goto(`http://127.0.0.1:${vitePort}/?debug=1&rain=0&view=${view}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!(window as unknown as W).__lodestone, null, { polling: 200, timeout: 60000 });
  const ticket = devTicket({ characterId: `pt3lt-${name}-${Date.now()}`, characterName: name, worldId: zone.worldId, zoneId: zone.zoneId });
  await page.evaluate((r) => (window as unknown as W).__lodestone.connectZone(r), { ticket, zoneEndpoint: `ws://127.0.0.1:${zone.port}/ws?spawn=${at.x.toFixed(2)},${at.z.toFixed(2)}`, zoneId: zone.zoneId, worldId: zone.worldId, name });
  await page.waitForFunction(() => (window as unknown as W).__lodestone.netDebug()?.phase === 'playing' && (window as unknown as W).__lodestone.player().pos.y > 20 && !!(window as unknown as W).__lodestoneCombat?.hud().active && !!(window as unknown as W).__lodestoneDev, null, { polling: 250, timeout: 120000 });
  await page.getByText("Let's go").click({ timeout: 15000 }).catch(() => undefined); // the first-run card
  await page.evaluate(() => (window as unknown as W).__lodestone.setQuality('high'));
  await page.mouse.move(640, 360);
  await page.keyboard.press('F3');
  await page.addStyleTag({ content: '[data-testid="lock-hint"]{display:none!important}' });
  return page;
}

const dev = async (p: Page, line: string) => {
  await p.evaluate((l) => (window as unknown as W).__lodestoneDev!.run(l), line);
  await sleep(300);
};
const yawTo = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.atan2(-(b.x - a.x), -(b.z - a.z));

async function sheet(browser: Browser, file: string, title: string, imgs: { label: string; png: Buffer }[], cols = 4): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 400 } });
  const w = Math.floor(1280 / cols);
  const h = Math.round((w * 9) / 16);
  const cells = imgs.map((i) => `<figure><img src="data:image/jpeg;base64,${i.png.toString('base64')}" width="${w}" height="${h}"><figcaption>${i.label}</figcaption></figure>`).join('');
  await page.setContent(`<html><body style="margin:0;background:#111;color:#ddd;font:14px system-ui"><div style="padding:8px 10px;font-weight:600">${title}</div><div style="display:grid;grid-template-columns:repeat(${cols},${w}px)">${cells}</div><style>figure{margin:0}figcaption{height:22px;line-height:22px;padding:0 8px;background:#1c1c1c;overflow:hidden;white-space:nowrap}img{display:block}</style></body></html>`);
  await page.screenshot({ path: file, fullPage: true, type: 'jpeg', quality: 86 });
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
  const out = path.join(repoRoot, 'docs', 'evidence');
  const report: Record<string, unknown> = {};
  try {
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 90000);
    zone = await startZone(bin, SEED, { LODESTONE_ZONE_DEV: '1', LODESTONE_ZONE_DEBUG_SPELLS: FAMILIARS.map((s) => s.key).join(','), LODESTONE_ZONE_NO_ATLAS_ENEMIES: '1', LODESTONE_ZONE_NO_DEMONS: '1' });
    browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
    const home = { x: 1330, z: 2330 };
    const viewer = await join(browser, vitePort, zone, 'Viewer', home, 'first');
    const frost = await join(browser, vitePort, zone, 'Frost', { x: home.x + 4, z: home.z }, 'first');
    const ember = await join(browser, vitePort, zone, 'Ember', { x: home.x + 8, z: home.z }, 'first');
    const all = [viewer, frost, ember];
    await sleep(3000);
    for (const p of all) {
      await p.getByText("Let's go").click({ timeout: 20000 }).catch(() => undefined); // the first-run card (it shows a moment after the join)
      await dev(p, '/god on');
      await dev(p, '/mana on');
    }
    // The tunnel: a point 35% of the way down the first tunnel corridor, and its direction.
    const tun = await viewer.evaluate(() => {
      const v = (window as unknown as W).__lodestoneVerticalWorld!;
      const c = v.corridors.find((k) => k.kind === 0)!;
      const n = c.pts.length / 3;
      const k = Math.floor(n * 0.35);
      const P = (i: number) => ({ x: c.pts[i * 3], y: c.pts[i * 3 + 1], z: c.pts[i * 3 + 2] });
      return { a: P(k), b: P(Math.min(n - 1, k + 1)), c: P(Math.min(n - 1, k + 6)) };
    });
    const dir = (() => {
      const dx = tun.c.x - tun.a.x;
      const dz = tun.c.z - tun.a.z;
      const l = Math.hypot(dx, dz) || 1;
      return { x: dx / l, z: dz / l };
    })();
    const at = (m: number) => ({ x: tun.a.x + dir.x * m, z: tun.a.z + dir.z * m, y: tun.a.y + 0.6 });
    console.log('tunnel point', JSON.stringify(tun.a), 'dir', JSON.stringify(dir));
    await dev(viewer, `/tp ${at(0).x.toFixed(2)} ${at(0).z.toFixed(2)} ${at(0).y.toFixed(2)}`);
    await dev(frost, `/tp ${at(7).x.toFixed(2)} ${at(7).z.toFixed(2)} ${at(7).y.toFixed(2)}`);
    await dev(ember, `/tp ${at(9.5).x.toFixed(2)} ${at(9.5).z.toFixed(2)} ${at(9.5).y.toFixed(2)}`);
    await sleep(9000); // the tunnel's tiles and cave cells stream in
    await viewer.evaluate(([y]) => (window as unknown as W).__lodestone.setLook(y, 0.0), [yawTo(at(0), at(8))]);
    await frost.evaluate(([y]) => (window as unknown as W).__lodestone.setLook(y, 0.0), [yawTo(at(7), at(0))]);
    await ember.evaluate(([y]) => (window as unknown as W).__lodestone.setLook(y, 0.0), [yawTo(at(9.5), at(0))]);
    // Equip the lights (slot 4 = index 3) on the casters.
    const equip = (p: Page, id: number) => p.evaluate((i) => (window as unknown as W).__lodestoneCombat!.interact(50, 3, 0 | (3 << 4) | (i << 8)), id);
    await equip(frost, spellId('rime_light'));
    await equip(ember, spellId('hearth_mote'));
    await sleep(1200);
    const stats = (p: Page) => p.evaluate(() => (window as unknown as W).__lodestoneLights?.() ?? null);
    const shot = async (p: Page, name: string, label: string) => {
      const png = await p.screenshot({ type: 'jpeg', quality: 88 });
      fs.writeFileSync(path.join(out, `pt3-lights-${name}.jpg`), png);
      console.log(`pt3-lights-${name}.jpg ${label}`);
      return png;
    };

    report.before = await stats(viewer);
    await shot(viewer, 'cave-dark', 'the tunnel before any light');

    await viewer.keyboard.press('Digit8');
    await sleep(2200);
    report.torch = await stats(viewer);
    await shot(viewer, 'cave-torch', 'a torch in the off hand');

    await frost.evaluate(() => (window as unknown as W).__lodestoneCombat!.runtime.press(3));
    await sleep(500);
    await ember.evaluate(() => (window as unknown as W).__lodestoneCombat!.runtime.press(3));
    await sleep(3500);
    report.all = await stats(viewer);
    await shot(viewer, 'cave-torch-two-familiars', 'a torch and two familiar lights (Frost and Ember seen from the Viewer)');
    // What the casters themselves see (their familiar over their own shoulder, first person).
    await shot(frost, 'cave-frost-own-view', 'Frost, first person, own icicle');

    // Frame time with all lights up.
    const frames = await viewer.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const f: number[] = [];
          let last = performance.now();
          const tick = (n: number) => {
            f.push(n - last);
            last = n;
            if (f.length < 180) requestAnimationFrame(tick);
            else resolve(f);
          };
          requestAnimationFrame(tick);
        }),
    );
    const sorted = [...frames].sort((a, b) => a - b);
    report.frameMs = { p50: +sorted[Math.floor(sorted.length * 0.5)].toFixed(1), p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1) };

    // Third person, the Viewer's own familiars one after another: the contact sheet.
    await dev(frost, '/god on');
    await viewer.evaluate(() => (window as unknown as W).__lodestone.setView('third'));
    await viewer.keyboard.press('Digit8'); // torch off
    await sleep(500);
    const imgs: { label: string; png: Buffer }[] = [];
    for (const sp of FAMILIARS) {
      await equip(viewer, sp.id);
      await sleep(600);
      await viewer.evaluate(() => (window as unknown as W).__lodestoneCombat!.runtime.press(3));
      await sleep(2600);
      const png = await viewer.screenshot({ type: 'jpeg', quality: 86, clip: { x: 340, y: 250, width: 600, height: 400 } });
      imgs.push({ label: `${sp.name} (${sp.tree}, ${sp.familiar!.kind})`, png: png as Buffer });
      await sleep(1400); // past the cooldown
      await viewer.evaluate(() => (window as unknown as W).__lodestoneCombat!.runtime.press(3)); // dismiss
      await sleep(1500);
    }
    const w = 320;
    const h = Math.round((w * 400) / 600);
    const page = await browser.newPage({ viewport: { width: 1280, height: 200 } });
    const cells = imgs.map((i) => `<figure><img src="data:image/jpeg;base64,${i.png.toString('base64')}" width="${w}" height="${h}"><figcaption>${i.label}</figcaption></figure>`).join('');
    await page.setContent(`<html><body style="margin:0;background:#111;color:#ddd;font:13px system-ui"><div style="padding:8px 10px;font-weight:600">Familiar lights, one per school (CR 042), third person in a dark tunnel</div><div style="display:grid;grid-template-columns:repeat(4,${w}px)">${cells}</div><style>figure{margin:0}figcaption{height:22px;line-height:22px;padding:0 8px;background:#1c1c1c;overflow:hidden;white-space:nowrap}img{display:block}</style></body></html>`);
    await page.screenshot({ path: path.join(out, 'pt3-lights-familiars.jpg'), fullPage: true, type: 'jpeg', quality: 86 });
    await page.close();
    void sheet;
    fs.writeFileSync(path.join(out, 'pt3-lights-run.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    try {
      await browser?.close();
    } catch {
      /* gone */
    }
    zone?.proc.kill();
    vite.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
