// Playtest 2 dash overhaul evidence (CR 021): two real clients (Vite dev
// server, headless Chromium on the GPU) on a real zone process. "Flyer" plays
// in third person and holds each mobility spell through the real runtime
// (the key held = runtime.holdCast); "Watcher" stands nearby in first person
// and sees it as another player (Event 214, snapshots, Event 230, chemistry).
//
//   npx vite-node src/combat/dev/dash-shots.ts      (from client/; needs Go and the worldgen wasm)
//
// Writes docs/evidence/pt2-dash-*.png and pt2-dash-shots.json (positions,
// speeds, mana and health along each hold, read from the client).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright';
import { COMBAT } from '@lodestone/contracts';
import { devTicket } from '../../net/dev/devTicket';
import { buildZone, repoRoot, startZone, waitHttp, type ZoneProc } from '../../sim/dev/traversalRun';

const SEED = '20261108';
// The lake of the WP10 swim golden (water 128.03; its north shore is near z 1868 at x 1418, the water to the south).
const SHORE = { x: 1418, z: 1852 };
const LAKE = { x: 1418, z: 1950 };
// A training camp of boars north of the shore: the flight dives onto it.
const CAMP = { x: 1418, z: 1812 };
const MOBILITY = COMBAT.spells.filter((s) => s.type === 'mobility').map((s) => s.key);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Handle {
  player(): { pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number }; mode: string; dash: number };
  setLook(yaw: number | null, pitch?: number): void;
  setQuality(q: string): void;
  setFreezeTime(v: boolean): void;
  setTimeOfDay(s: number): void;
  connectZone(r: { ticket: string; zoneEndpoint: string; zoneId: string; worldId: string; name?: string }): void;
  netDebug(): { phase: string } | null;
}
interface CombatHandle {
  runtime: { press(slot: number): void; holdCast(slot: number, on: boolean): void; timeline: { mana: number }; link: { sendInteract(k: number, id: bigint, a: number, arg: number): void } };
  hud(): { active: boolean; known: number[]; loadouts: { spells: (string | null)[] }[]; mana: number };
}
type W = Window & { __lodestone: Handle; __lodestoneCombat?: CombatHandle };

async function join(browser: Browser, vitePort: number, zone: ZoneProc, name: string, at: { x: number; z: number }, view: 'first' | 'third'): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [${name}] pageerror: ${e.message}`));
  await page.goto(`http://127.0.0.1:${vitePort}/?debug=1&rain=0&view=${view}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!(window as unknown as W).__lodestone, null, { polling: 200, timeout: 60000 });
  const ticket = devTicket({ characterId: `pt2dash-${name}-${Date.now()}`, characterName: name, worldId: zone.worldId, zoneId: zone.zoneId });
  await page.evaluate((r) => (window as unknown as W).__lodestone.connectZone(r), { ticket, zoneEndpoint: `ws://127.0.0.1:${zone.port}/ws?spawn=${at.x.toFixed(2)},${at.z.toFixed(2)}`, zoneId: zone.zoneId, worldId: zone.worldId, name });
  await page.waitForFunction(() => (window as unknown as W).__lodestone.netDebug()?.phase === 'playing' && (window as unknown as W).__lodestone.player().pos.y > 20 && !!(window as unknown as W).__lodestoneCombat?.hud().active, null, { polling: 250, timeout: 120000 });
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

/** Puts a known spell in slot 4 of loadout 0 (Interact 50 action 3). */
async function equip(page: Page, key: string): Promise<void> {
  const id = COMBAT.spells.find((s) => s.key === key)!.id;
  await page.evaluate((sid) => (window as unknown as W).__lodestoneCombat!.runtime.link.sendInteract(50, 0n, 3, 0 | (3 << 4) | (sid << 8)), id);
  await page.waitForFunction((k) => (window as unknown as W).__lodestoneCombat!.hud().loadouts[0]?.spells[3] === k, key, { polling: 100, timeout: 10000 });
}

const me = (p: Page) => p.evaluate(() => (window as unknown as W).__lodestone.player());
const look = (p: Page, yaw: number, pitch = 0) => p.evaluate(([y, pi]) => (window as unknown as W).__lodestone.setLook(y, pi), [yaw, pitch] as const);
const yawTo = (from: { x: number; z: number }, to: { x: number; z: number }) => Math.atan2(-(to.x - from.x), -(to.z - from.z));

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
  const record: Record<string, unknown> = {};
  const out = path.join(repoRoot, 'docs', 'evidence');
  fs.mkdirSync(out, { recursive: true });
  try {
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 90000);
    zone = await startZone(bin, SEED, { LODESTONE_ZONE_DEBUG_SPELLS: MOBILITY.join(','), LODESTONE_ZONE_DEBUG_CAMP: `${CAMP.x},${CAMP.z},1,boar boar boar`, LODESTONE_ZONE_NO_ATLAS_ENEMIES: '1', LODESTONE_ZONE_NO_DEMONS: '1' });
    browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
    const flyer = await join(browser, vitePort, zone, 'Flyer', SHORE, 'third');
    const watcher = await join(browser, vitePort, zone, 'Watcher', { x: SHORE.x + 40, z: SHORE.z - 18 }, 'first');
    await sleep(7000); // the area banner fades
    console.log('flyer at', JSON.stringify(await me(flyer)).slice(0, 200));
    const shots: Record<string, { label: string; png: Buffer }[]> = {};
    const snap = async (group: string, label: string, aimWatcher = true) => {
      if (aimWatcher) {
        const f = (await me(flyer)).pos;
        const w = (await me(watcher)).pos;
        await look(watcher, yawTo(w, f), Math.atan2(f.y + 1 - (w.y + 1.6), Math.hypot(f.x - w.x, f.z - w.z)));
      }
      (shots[group] ??= []).push({ label: `${label}: the dasher (third person)`, png: await flyer.screenshot() });
      (shots[group] ??= []).push({ label: `${label}: another player watching`, png: await watcher.screenshot() });
    };
    // Held: press the slot, keep it held, sample the client along the way.
    const hold = async (key: string, plan: { ms: number; yaw?: number; pitch?: number; shot?: string }[], group: string) => {
      await equip(flyer, key);
      const m0 = await flyer.evaluate(() => (window as unknown as W).__lodestoneCombat!.runtime.timeline.mana);
      const samples: unknown[] = [];
      const p0 = (await me(flyer)).pos;
      await flyer.evaluate(() => {
        const rt = (window as unknown as W).__lodestoneCombat!.runtime;
        rt.holdCast(3, true);
        rt.press(3);
      });
      let t = 0;
      for (const step of plan) {
        if (step.yaw !== undefined || step.pitch !== undefined) await look(flyer, step.yaw ?? 0, step.pitch ?? 0);
        await sleep(step.ms - t);
        t = step.ms;
        const p = await me(flyer);
        const mana = await flyer.evaluate(() => (window as unknown as W).__lodestoneCombat!.runtime.timeline.mana);
        samples.push({ ms: t, pos: p.pos, speed: Math.hypot(p.vel.x, p.vel.y, p.vel.z), mode: p.mode, dash: p.dash, mana });
        if (step.shot) await snap(group, `${COMBAT.names[key]} held ${(t / 1000).toFixed(1)} s, ${step.shot}`);
      }
      await flyer.evaluate(() => (window as unknown as W).__lodestoneCombat!.runtime.holdCast(3, false));
      const m1 = await flyer.evaluate(() => (window as unknown as W).__lodestoneCombat!.runtime.timeline.mana);
      const p1 = (await me(flyer)).pos;
      await sleep(900);
      record[key] = { samples, manaBefore: m0, manaAfter: m1, travelled: Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z) };
      console.log(key, JSON.stringify(record[key]).slice(0, 300));
      await sleep(2200); // mana back up a little, cooldown over
    };
    const toLake = yawTo(SHORE, LAKE);
    const aimAt = async (to: { x: number; z: number }, pitch = 0) => look(flyer, yawTo((await me(flyer)).pos, to), pitch);
    // 1. Glacier step from the shore out over the lake and back: the skate and the frozen path.
    await look(flyer, toLake, 0);
    await hold('glacier_step', [{ ms: 900, shot: 'skating over the lake' }, { ms: 1700, yaw: toLake + 1.6, shot: 'turning on the water: the frozen path behind' }], 'glacier');
    // 2. Magma dash: up like a rocket, level flight toward the camp, then a dive onto it (the slam).
    await aimAt(CAMP, 1.3);
    await hold('magma_dash', [{ ms: 600, shot: 'straight up (looking up)' }, { ms: 700, pitch: 0.02 }, { ms: 1300, shot: 'level flight toward the camp' }, { ms: 1500, pitch: -1.3 }, { ms: 2600, shot: 'dive: the landing slam on the camp' }], 'magma');
    // 3. Every other element, back and forth along the open shore east of the
    // start (the town is to the west), past the watcher standing on it.
    let east = true;
    for (const [key, ms] of [['static_step', 900], ['root_launch', 800], ['updraft', 1100], ['sunstep', 900], ['skip', 800], ['phase_slip', 800]] as [string, number][]) {
      await aimAt({ x: east ? SHORE.x + 90 : SHORE.x - 10, z: SHORE.z - 4 });
      east = !east;
      await hold(key, [{ ms }, { ms: ms + 1, shot: 'held' }], 'elements');
    }
    await sheet(browser, path.join(out, 'pt2-dash-magma.png'), 'Magma Dash held (CR 021): jet flight where you look, then a dive into the ground; left the dasher in third person, right another player', shots.magma ?? []);
    await sheet(browser, path.join(out, 'pt2-dash-glacier.png'), 'Glacier Step held over a lake: the skate (water is ground while held) and the frozen path (chem freeze)', shots.glacier ?? []);
    await sheet(browser, path.join(out, 'pt2-dash-elements.png'), 'Held dashes per element: Static Step blinks, Root Launch rock spikes, Updraft glide, Sunstep light trail, Skip phase, Phase Slip blood', shots.elements ?? []);
    fs.writeFileSync(path.join(out, 'pt2-dash-shots.json'), JSON.stringify(record, null, 1) + '\n');
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
