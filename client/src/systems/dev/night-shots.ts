// WP15 screenshots in headless Chromium (the real client from the Vite dev
// server, real GPU via ANGLE/D3D11 unless LODESTONE_BENCH_GL=swiftshader)
// against the real zone binary at night on the official world:
//
//   npm run night:shots -w client      (needs Go, `npm run build:wasm`, Playwright Chromium)
//
// Shots: the night sky with the clock chip, demons rising and hunting, a
// grass fire at night (lit by its own flames), a pillar, a fire by day, and
// a town defense event's panel. Writes docs/evidence/wp15-*.png and
// wp15-shots.txt.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, type Page } from 'playwright';
import { devTicket } from '../../net/dev/devTicket';
import { buildZone, repoRoot, startZone, waitHttp } from '../../sim/dev/traversalRun';
import { loadWorldgenGround } from '../../sim/worldgenGround';
import { findMeadow } from './meadow';

const SEED = '20261108';
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
interface NightHandle {
  hud(): { night: boolean; hour: number; moon: number; burning: number; defense: unknown };
  state(): { mode?: string; step?: number; hash?: number };
  ignite(x: number, z: number, r?: number): void;
  pillar(x: number, z: number): void;
  setTime(hour: number): void;
  raiseDemons(rank?: number): void;
  defense(): void;
  sunsteel(loadout?: number): void;
}
type W = Window & { __lodestone: Handle; __lodestoneNight?: NightHandle; __lodestoneDrawn?: () => { x: number; z: number; kind: number; healthPct: number; typeId?: number }[] };

function offsetForHour(h: number): number {
  const tod = (Date.now() / 1000) % 3600;
  return Math.round((((h * 150 - tod) % 3600) + 3600) % 3600);
}

async function look(page: Page, x: number, z: number, pitch = -0.12): Promise<void> {
  await page.evaluate(
    ([tx, tz, p]) => {
      const l = (window as unknown as W).__lodestone;
      const me = l.player().pos;
      l.setLook(Math.atan2(-(tx - me.x), -(tz - me.z)), p);
    },
    [x, z, pitch],
  );
}

async function main(): Promise<void> {
  const terrain = await loadWorldgenGround(fs.readFileSync(path.join(repoRoot, 'worldgen', 'pkg', 'worldgen.wasm')), SEED);
  const meadow = findMeadow(terrain, BigInt(SEED));
  note(`meadow (${meadow.x}, ${meadow.z}) ${(meadow.fuel * 100).toFixed(0)}% fuel`);
  const zone = await startZone(buildZone(), SEED, {
    LODESTONE_ZONE_DEV_NIGHT: '1',
    LODESTONE_ZONE_DEV_COMBAT: '1',
    LODESTONE_ZONE_DEBUG_RAIN: '0',
    LODESTONE_ZONE_NO_DEMONS: '1',
    LODESTONE_ZONE_NO_ATLAS_ENEMIES: '1',
    LODESTONE_ZONE_TIME_OFFSET_S: String(offsetForHour(21.5)),
  });
  const vitePort = 5300 + Math.floor(Math.random() * 400);
  const vite = spawn(process.execPath, [path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], { cwd: path.join(repoRoot, 'client'), stdio: 'ignore' });
  const browser = await chromium.launch({ headless: true, args: gpuArgs });
  try {
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 90000);
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => note(`  pageerror: ${e.message}`));
    await page.goto(`http://127.0.0.1:${vitePort}/?debug=1`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!(window as unknown as W).__lodestone, null, { polling: 200, timeout: 60000 });
    // Stand 24 m south-west of the meadow, looking at it.
    const at = { x: meadow.x - 17, z: meadow.z + 17 };
    const ticket = devTicket({ characterId: `wp15-shots-${Date.now()}`, characterName: 'Nightwatch', worldId: zone.worldId, zoneId: zone.zoneId });
    await page.evaluate((r) => (window as unknown as W).__lodestone.connectZone(r), { ticket, zoneEndpoint: `ws://127.0.0.1:${zone.port}/ws?spawn=${at.x.toFixed(2)},${at.z.toFixed(2)}`, zoneId: zone.zoneId, worldId: zone.worldId, name: 'Nightwatch' });
    await page.waitForFunction(() => (window as unknown as W).__lodestone.netDebug()?.phase === 'playing' && (window as unknown as W).__lodestone.player().pos.y > 20 && !!(window as unknown as W).__lodestoneNight, null, { polling: 250, timeout: 180000 });
    await page.evaluate(() => (window as unknown as W).__lodestone.setQuality('high'));
    await page.keyboard.press('F3'); // hide the debug HUD for the shots
    await sleep(6000); // terrain, towns, the first chemistry clock
    const hud = await page.evaluate(() => (window as unknown as W).__lodestoneNight!.hud());
    note(`connected: hour ${hud.hour}, night ${hud.night}, moon ${hud.moon}`);

    // 1. The night sky and the clock chip.
    await look(page, meadow.x + 60, meadow.z - 60, 0.12);
    await sleep(1500);
    await page.screenshot({ path: path.join(out, 'wp15-night.png') });

    // 2. Demons rise and come for us.
    await page.evaluate(() => {
      const n = (window as unknown as W).__lodestoneNight!;
      n.raiseDemons(0);
      n.raiseDemons(1);
    });
    await sleep(3500);
    const d = await page.evaluate(() => {
      const me = (window as unknown as W).__lodestone.player().pos;
      const v = ((window as unknown as W).__lodestoneDrawn?.() ?? []).filter((e) => e.kind === 2 && e.healthPct > 0);
      v.sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z));
      return { n: v.length, first: v[0] ?? null };
    });
    note(`demons drawn: ${d.n}`);
    if (d.first) await look(page, d.first.x, d.first.z, -0.08);
    await sleep(700);
    await page.screenshot({ path: path.join(out, 'wp15-demons.png') });
    await sleep(1500);
    await sleep(3000); // they close in
    if (d.first) {
      const d2 = await page.evaluate(() => {
        const me = (window as unknown as W).__lodestone.player().pos;
        const v = ((window as unknown as W).__lodestoneDrawn?.() ?? []).filter((e) => e.kind === 2 && e.healthPct > 0);
        v.sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z));
        return v[0] ?? null;
      });
      if (d2) await look(page, d2.x, d2.z, -0.15);
      await sleep(400);
      await page.screenshot({ path: path.join(out, 'wp15-demons-close.png') });
    }
    // Sunrise clears them for the fire shots: jump the clock to 05:59, then back to night.
    await page.evaluate(() => (window as unknown as W).__lodestoneNight!.setTime(5.995));
    await sleep(6000);
    await page.screenshot({ path: path.join(out, 'wp15-dawn.png') });
    await page.evaluate(() => (window as unknown as W).__lodestoneNight!.setTime(22));
    await sleep(3000);

    // 3. A grass fire at night.
    await page.evaluate(([x, z]) => (window as unknown as W).__lodestoneNight!.ignite(x, z, 2), [meadow.x, meadow.z]);
    await look(page, meadow.x, meadow.z, -0.18);
    await sleep(14000);
    const st = await page.evaluate(() => ({ hud: (window as unknown as W).__lodestoneNight!.hud(), state: (window as unknown as W).__lodestoneNight!.state() }));
    note(`fire after 14 s: ${st.hud.burning} burning cells (view ${st.state.mode}, step ${st.state.step})`);
    await page.screenshot({ path: path.join(out, 'wp15-fire-night.png') });
    // 4. An earth pillar beside us.
    const me = await page.evaluate(() => (window as unknown as W).__lodestone.player().pos);
    await page.evaluate(([x, z]) => (window as unknown as W).__lodestoneNight!.pillar(x, z), [me.x + 6, me.z - 4]);
    await sleep(2500);
    await look(page, me.x + 6, me.z - 4, 0.05);
    await sleep(500);
    await page.screenshot({ path: path.join(out, 'wp15-pillar.png') });
    // 5. The same fire by day.
    await page.evaluate(() => (window as unknown as W).__lodestoneNight!.setTime(12));
    await look(page, meadow.x, meadow.z, -0.2);
    await sleep(5000);
    await page.screenshot({ path: path.join(out, 'wp15-fire-day.png') });
    note(`shots: wp15-night.png wp15-demons.png wp15-demons-close.png wp15-dawn.png wp15-fire-night.png wp15-pillar.png wp15-fire-day.png (${software ? 'SwiftShader' : 'GPU'})`);
  } finally {
    await browser.close();
    vite.kill();
    zone.proc.kill();
    fs.writeFileSync(path.join(out, 'wp15-shots.txt'), lines.join('\n') + '\n');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
