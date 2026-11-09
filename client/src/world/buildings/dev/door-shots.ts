// Playtest doors screenshots in headless Chromium: the real client (Vite dev
// server, real GPU via ANGLE/D3D11 unless LODESTONE_BENCH_GL=swiftshader)
// connected with a dev ticket to the real zone binary on the official world
// at noon. Stands on the street in front of the spawn settlement's inn,
// looks at its door, presses E to close it ("[E] Open door" prompt), then E
// to open it again ("[E] Close door").
//
//   npx vite-node src/world/buildings/dev/door-shots.ts     (from client/; needs Go, the built wasm, Playwright Chromium)
//
// Writes docs/evidence/pt-ux-door-closed.png, pt-ux-door-open.png and
// pt-ux-door-shots.txt.

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium, type Page } from 'playwright';
import { devTicket } from '../../../net/dev/devTicket';
import { buildZone, repoRoot, startZone, waitHttp } from '../../../sim/dev/traversalRun';
import { doorsToWalk, offsetForHour, setupDoorWalk } from './doorWalk';

const out = path.join(repoRoot, 'docs', 'evidence');
const lines: string[] = [];
const note = (s: string) => {
  lines.push(s);
  console.log(s);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const software = process.env.LODESTONE_BENCH_GL === 'swiftshader';
const gpuArgs = software ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];

interface Handle {
  player(): { pos: { x: number; y: number; z: number } };
  setLook(yaw: number | null, pitch?: number): void;
  setQuality(q: string): void;
  connectZone(r: { ticket: string; zoneEndpoint: string; zoneId: string; worldId: string; name?: string }): void;
  netDebug(): { phase: string } | null;
}
interface TownsHandle {
  stats(): { ready: boolean };
  idle(): boolean;
  target(): { kind: string; role: number } | null;
  doorStats(): { states: number; refused: number; active: number; leaves: number; online: boolean } | null;
  doors(si: number): { index: number; open: boolean; visual: number }[];
}
type W = Window & { __lodestone: Handle; __lodestoneTowns?: TownsHandle };

async function freePort(): Promise<number> {
  for (;;) {
    const p = 20000 + Math.floor(Math.random() * 25000);
    const ok = await new Promise<boolean>((res) => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.listen(p, '127.0.0.1', () => s.close(() => res(true)));
    });
    if (ok) return p;
  }
}

const prompt = (page: Page) => page.evaluate(() => document.querySelector('[data-testid=town-prompt]')?.textContent ?? '');

async function main(): Promise<void> {
  const s = await setupDoorWalk();
  const door = doorsToWalk(s)[0];
  const b = s.towns.buildings[door.building];
  const vx = -b.s;
  const vz = b.c;
  const at = { x: door.x - 3.2 * vx + 0.6 * b.c, z: door.z - 3.2 * vz + 0.6 * b.s };
  note(`door ${door.index} (prop ${door.prop}) of the spawn settlement's inn at (${door.x.toFixed(2)}, ${door.y.toFixed(2)}, ${door.z.toFixed(2)}); standing at (${at.x.toFixed(2)}, ${at.z.toFixed(2)})`);
  const zone = await startZone(buildZone(), '20261108', { LODESTONE_ZONE_TIME_OFFSET_S: offsetForHour(12), LODESTONE_ZONE_NO_DEMONS: '1' });
  const vitePort = await freePort();
  const vite = spawn(process.execPath, [path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], { cwd: path.join(repoRoot, 'client'), stdio: 'ignore' });
  const browser = await chromium.launch({ headless: true, args: gpuArgs });
  try {
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 90000);
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => note(`  pageerror: ${e.message}`));
    await page.goto(`http://127.0.0.1:${vitePort}/?debug=1`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!(window as unknown as W).__lodestone, null, { polling: 200, timeout: 60000 });
    const ticket = devTicket({ characterId: `door-shots-${Date.now()}`, characterName: 'Doorkeeper', worldId: zone.worldId, zoneId: zone.zoneId });
    await page.evaluate((r) => (window as unknown as W).__lodestone.connectZone(r), { ticket, zoneEndpoint: `ws://127.0.0.1:${zone.port}/ws?spawn=${at.x.toFixed(2)},${at.z.toFixed(2)}`, zoneId: zone.zoneId, worldId: zone.worldId, name: 'Doorkeeper' });
    await page.waitForFunction(() => (window as unknown as W).__lodestone.netDebug()?.phase === 'playing' && (window as unknown as W).__lodestone.player().pos.y > 20, null, { polling: 250, timeout: 180000 });
    await page.evaluate(() => (window as unknown as W).__lodestone.setQuality('high'));
    await page.waitForFunction(() => !!(window as unknown as W).__lodestoneTowns?.stats().ready && (window as unknown as W).__lodestoneTowns!.idle(), null, { polling: 500, timeout: 180000 });
    await page.keyboard.press('F3'); // hide the debug HUD
    await sleep(4000);
    const me = await page.evaluate(() => (window as unknown as W).__lodestone.player().pos);
    const eye = me.y + 1.6;
    const yaw = Math.atan2(-(door.x - me.x), -(door.z - me.z));
    const pitch = Math.atan2(door.y + 1.25 - eye, Math.hypot(door.x - me.x, door.z - me.z));
    await page.evaluate(([y, p]) => (window as unknown as W).__lodestone.setLook(y, p), [yaw, pitch]);
    await sleep(1500);
    note(`target ${JSON.stringify(await page.evaluate(() => (window as unknown as W).__lodestoneTowns!.target()))}, prompt "${await prompt(page)}"`);

    // E: close the door (Interact 34 action 2), wait for the zone's 970 and the swing.
    await page.keyboard.press('KeyE');
    await page.waitForFunction((si) => { const ds = (window as unknown as W).__lodestoneTowns!.doors(si); return ds.some((x) => !x.open && x.visual === 0); }, door.settlement, { polling: 100, timeout: 10000 });
    await sleep(800);
    const p1 = await prompt(page);
    const st1 = await page.evaluate(() => (window as unknown as W).__lodestoneTowns!.doorStats());
    note(`closed: prompt "${p1}", door stats ${JSON.stringify(st1)}`);
    await page.screenshot({ path: path.join(out, 'pt-ux-door-closed.png') });

    // E: open it again.
    await page.keyboard.press('KeyE');
    await page.waitForFunction((si) => { const ds = (window as unknown as W).__lodestoneTowns!.doors(si); return ds.every((x) => x.open && x.visual === 1); }, door.settlement, { polling: 100, timeout: 10000 });
    await sleep(800);
    const p2 = await prompt(page);
    const st2 = await page.evaluate(() => (window as unknown as W).__lodestoneTowns!.doorStats());
    note(`open: prompt "${p2}", door stats ${JSON.stringify(st2)}`);
    await page.screenshot({ path: path.join(out, 'pt-ux-door-open.png') });
    const ok = p1 === '[E] Open door' && p2 === '[E] Close door' && (st2?.states ?? 0) >= 2 && (st2?.refused ?? 1) === 0;
    note(ok ? 'PASS' : 'FAIL');
    fs.writeFileSync(path.join(out, 'pt-ux-door-shots.txt'), [`# Playtest doors screenshots (real client + zone binary, official world, noon)`, `date ${new Date().toISOString()}`, ...lines].join('\n') + '\n');
    process.exitCode = ok ? 0 : 1;
  } finally {
    await browser.close();
    vite.kill();
    zone.proc.kill();
  }
}

await main();
