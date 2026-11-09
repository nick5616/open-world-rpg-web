// Playtest feedback "weapons don't look like weapons" (pt/ux): screenshots of
// every first-person weapon and of another player holding one, from the real
// client (Vite dev server, headless Chromium) against a real zone process on
// private ports, weapons equipped through the dev Interact 50 verbs.
//
//   npm run weapons:shots -w client            -> docs/evidence/pt-ux-weapon-*.png
//   npm run weapons:shots -w client -- before  -> docs/evidence/pt-ux-weapon-before-*.png
//
// Needs Go, `npm run build:wasm` and Playwright Chromium. Ports are random in
// 20000-45000 (below the Windows reserved ranges); nothing else is touched.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright';
import { devTicket } from '../../net/dev/devTicket';
import { buildZone, goPATH, repoRoot, waitHttp } from '../../sim/dev/traversalRun';

const SEED = '20261108';
const HINT = { x: 1330, z: 2330 };
const out = path.join(repoRoot, 'docs', 'evidence');
const before = process.argv.includes('before');
const prefix = before ? 'pt-ux-weapon-before-' : 'pt-ux-weapon-';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const software = process.env.LODESTONE_BENCH_GL === 'swiftshader';
const gpuArgs = software ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const usedPorts = new Set<number>();
const pickPort = () => {
  for (;;) {
    const p = 20000 + Math.floor(Math.random() * 25000);
    if (!usedPorts.has(p)) {
      usedPorts.add(p);
      return p;
    }
  }
};

interface Handle {
  player(): { pos: { x: number; y: number; z: number }; yaw: number };
  setLook(yaw: number | null, pitch?: number): void;
  setQuality(q: string): void;
  setFreezeTime(v: boolean): void;
  setTimeOfDay(s: number): void;
  connectZone(r: { ticket: string; zoneEndpoint: string; zoneId: string; worldId: string; name?: string }): void;
  netDebug(): { phase: string } | null;
}
interface CombatHandle {
  runtime: { link: { sendInteract(k: number, id: bigint, a: number, arg: number): void }; swapLoadout(): void };
  hud(): { active: boolean; activeLoadout: number; loadouts: { weapon: string; gem: number; material?: number }[] };
}
type W = Window & { __lodestone: Handle; __lodestoneCombat?: CombatHandle };

async function startZone(bin: string) {
  const port = pickPort();
  const worldId = `ptux-${Date.now()}-${port}`;
  const zoneId = `zone-ptux-${port}`;
  const log: string[] = [];
  const proc = spawn(bin, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: goPATH,
      LODESTONE_ZONE_PORT: String(port),
      LODESTONE_ZONE_WT_ADDR: 'off',
      LODESTONE_ZONE_NO_DB: '1',
      LODESTONE_ZONE_NO_REDIS: '1',
      LODESTONE_ZONE_ID: zoneId,
      LODESTONE_WORLD_ID: worldId,
      LODESTONE_WORLD_SEED: SEED,
      LODESTONE_GEN_VERSION: 'dev',
      LODESTONE_ZONE_REQUIRE_TERRAIN: '1',
      LODESTONE_ZONE_DEV_SPAWN: '1',
      LODESTONE_ZONE_NO_ATLAS_ENEMIES: '1',
      LODESTONE_ZONE_NO_DEMONS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const keep = (b: Buffer) => {
    for (const l of b.toString().split('\n')) if (l.trim()) log.push(l);
    if (log.length > 400) log.splice(0, log.length - 400);
  };
  proc.stdout?.on('data', keep);
  proc.stderr?.on('data', keep);
  await waitHttp(`http://127.0.0.1:${port}/healthz`, 60000);
  return { proc, port, worldId, zoneId, log };
}

type Zone = Awaited<ReturnType<typeof startZone>>;

async function join(browser: Browser, vitePort: number, zone: Zone, name: string, at: { x: number; z: number }): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [${name}] pageerror: ${e.message}`));
  await page.goto(`http://127.0.0.1:${vitePort}/?debug=1&rain=0`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!(window as unknown as W).__lodestone, null, { polling: 200, timeout: 60000 });
  const ticket = devTicket({ characterId: `ptux-${name}-${Date.now()}`, characterName: name, worldId: zone.worldId, zoneId: zone.zoneId });
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

const WEAPON_ID: Record<string, number> = { sword: 1, spear: 2, bow: 3, staff: 4, wand: 5 };

/** Dev Interact 50: weapon, gem element (-1 none), combat material id (0 ordinary, 3 sunsteel) on loadout 0. */
async function equip(page: Page, weapon: string, gem: number, material: number): Promise<void> {
  await page.evaluate(
    ([w, g, m]) => {
      const rt = (window as unknown as W).__lodestoneCombat!.runtime;
      if ((window as unknown as W).__lodestoneCombat!.hud().activeLoadout !== 0) rt.swapLoadout();
      rt.link.sendInteract(50, 0n, 2, 0 | (w << 8));
      rt.link.sendInteract(50, 0n, 5, 0 | ((g + 1) << 8));
      rt.link.sendInteract(50, 0n, 6, 0 | (m << 8));
    },
    [WEAPON_ID[weapon], gem, material] as const,
  );
  await page.waitForFunction((w) => (window as unknown as W).__lodestoneCombat!.hud().loadouts[0]?.weapon === w, weapon, { polling: 100, timeout: 10000 });
  await sleep(700);
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const bin = buildZone();
  const vitePort = pickPort();
  const vite = spawn(process.execPath, [path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], { cwd: path.join(repoRoot, 'client'), stdio: 'ignore' });
  let zone: Zone | null = null;
  let browser: Browser | null = null;
  try {
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 90000);
    zone = await startZone(bin);
    // two pages render at once: no background throttling (A must keep sending input)
    browser = await chromium.launch({ headless: true, args: [...gpuArgs, '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
    let a = await join(browser, vitePort, zone, 'Wielder', HINT);
    const yaw = Number(process.env.WEAPON_SHOTS_YAW ?? 5.5);
    await a.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.06), yaw);
    await sleep(2500);
    if (process.argv.includes('survey')) {
      // Pick a backdrop: the sword at eight headings.
      await equip(a, 'sword', 0, 0);
      for (let k = 0; k < 8; k++) {
        await a.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.06), (k * Math.PI) / 4);
        await sleep(1500);
        await a.screenshot({ path: path.join(process.env.WEAPON_SHOTS_SURVEY_DIR ?? out, `survey-${k}.png`) });
      }
      return;
    }

    // First-person shots (gem element: 0 fire, 1 ice, 2 lightning, 3 earth, 4 wind, 5 light, 6 dark, 7 void).
    const shots: { name: string; weapon: string; gem: number; material: number; draw?: boolean; night?: boolean }[] = [
      { name: 'sword', weapon: 'sword', gem: -1, material: 0 },
      { name: 'spear', weapon: 'spear', gem: 1, material: 0 },
      { name: 'bow', weapon: 'bow', gem: 2, material: 0, draw: true },
      { name: 'staff', weapon: 'staff', gem: 0, material: 0 },
      { name: 'wand', weapon: 'wand', gem: 7, material: 0 },
      { name: 'sunsteel', weapon: 'sword', gem: 1, material: 3 },
      { name: 'sunsteel-night', weapon: 'sword', gem: 1, material: 3, night: true },
    ];
    const only = process.env.WEAPON_SHOTS_ONLY?.split(',');
    for (const s of shots) {
      if (only && !only.includes(s.name)) continue;
      if (before && s.night) continue;
      await equip(a, s.weapon, s.gem, s.material);
      if (s.night) {
        await a.evaluate(() => (window as unknown as W).__lodestone.setTimeOfDay(0.93 * 3600));
        await sleep(1500);
      }
      if (s.draw) {
        await a.mouse.down({ button: 'right' });
        await sleep(1300);
      }
      await a.screenshot({ path: path.join(out, `${prefix}${s.name}.png`) });
      if (s.draw) {
        await a.mouse.up({ button: 'right' });
        await sleep(600);
      }
      if (s.night) await a.evaluate(() => (window as unknown as W).__lodestone.setTimeOfDay(0.45 * 3600));
      console.log(`shot ${prefix}${s.name}.png`);
    }

    // Another player holding a weapon, seen from a second browser, on the
    // flatter meadow below (the first-person spot is a steep hillside).
    const [rx, rz] = (process.env.WEAPON_SHOTS_REMOTE_AT ?? '1440,2223').split(',').map(Number);
    await a.close();
    a = await join(browser, vitePort, zone, 'Wielder', { x: rx, z: rz });
    await equip(a, process.env.WEAPON_SHOTS_REMOTE ?? 'sword', 5, 3);
    const posA = await a.evaluate(() => (window as unknown as W).__lodestone.player().pos);
    // B spawns a few metres away, then walks up and looks at A as drawn.
    const b = await join(browser, vitePort, zone, 'Watcher', { x: posA.x + 3, z: posA.z + 1 });
    await equip(b, 'wand', 4, 0); // a small weapon of B's own, out of the way
    // B walks up to A (dev spawns snap to walkable ground, maybe a few metres off).
    const faceA = () =>
      b.evaluate(() => {
        const views = (window as unknown as { __lodestoneDrawn?: () => { kind: number; x: number; y: number; z: number; typeId?: number; yaw: number }[] }).__lodestoneDrawn?.() ?? [];
        const other = views.find((v) => v.kind === 1);
        if (!other) return null;
        const l = (window as unknown as W).__lodestone;
        const p = l.player().pos;
        const d = Math.hypot(other.x - p.x, other.z - p.z);
        l.setLook(Math.atan2(-(other.x - p.x), -(other.z - p.z)), Math.atan2(other.y + 1.0 - (p.y + 1.6), d));
        return { d, typeId: other.typeId ?? 0, yaw: other.yaw };
      });
    let r: { d: number; typeId: number; yaw: number } | null = null;
    for (let i = 0; i < 60; i++) {
      r = await faceA();
      if (r && r.d <= 3.0) break;
      if (r) {
        await b.keyboard.down('KeyW');
        await sleep(Math.min(400, (r.d - 2.7) * 150));
        await b.keyboard.up('KeyW');
      }
      await sleep(250);
    }
    console.log(`remote: ${r ? `${r.d.toFixed(1)} m away, typeId ${r.typeId}` : 'not seen'}`);
    // A turns its right side (where the sword is) mostly toward B: the
    // avatar's right is (cos yaw, -sin yaw) for a character facing -Z at yaw 0.
    const posB = await b.evaluate(() => (window as unknown as W).__lodestone.player().pos);
    const posA2 = await a.evaluate(() => (window as unknown as W).__lodestone.player().pos);
    const yawA = Math.atan2(-(posB.z - posA2.z), posB.x - posA2.x) + Number(process.env.WEAPON_SHOTS_TURN ?? -0.5);
    await a.bringToFront();
    await a.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.05), yawA);
    console.log(`A turns to yaw ${yawA.toFixed(2)} (B at ${(posB.x - posA2.x).toFixed(1)}, ${(posB.z - posA2.z).toFixed(1)})`);
    await sleep(1200);
    await b.bringToFront();
    console.log(`watcher sees A at yaw ${(await faceA())?.yaw.toFixed(2)}`);
    await sleep(1500);
    // (a string: vite-node would rewrite a dynamic import inside a function)
    const built = (await b.evaluate("import('/src/combat/weapons/models.ts').then((m) => m.cachedWeaponKeys())")) as string[];
    console.log(`watcher built weapon looks: ${built.join(', ')}`);
    await b.screenshot({ path: path.join(out, `${prefix}remote.png`) });
    console.log(`shot ${prefix}remote.png`);
  } finally {
    await browser?.close().catch(() => {});
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
