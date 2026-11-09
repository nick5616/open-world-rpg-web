// Playtest 2 evidence ("Need third person mode"; "animations in the third
// person of other people doing things in the game"): screenshots from the
// real client (Vite dev server, headless Chromium on the GPU) against a real
// zone process on private ports, two browsers:
//   A "Mover" plays in third person (its own body, the sword in hand) and
//   then walks, sprints, jumps, attacks, casts, draws a bow, thrusts a spear
//   and dodges; B "Watcher" stands a few metres away in first person and
//   photographs A's avatar mid-action (it waits until its own avatar
//   animator reports the action, so each shot shows the motion B saw).
//
//   npx vite-node client/src/net/dev/third-person-shots.ts   -> docs/evidence/pt2-third-person-*.png + -shots.json
//
// Needs Go, worldgen/pkg/worldgen.wasm and Playwright Chromium. Ports are
// random in 20000-45000; nothing else is touched.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright';
import { devTicket } from './devTicket';
import { buildZone, goPATH, repoRoot, waitHttp } from '../../sim/dev/traversalRun';

const SEED = '20261108';
const AT = { x: 1440, z: 2223 }; // the flat meadow the weapon shots use
const out = path.join(repoRoot, 'docs', 'evidence');
const prefix = 'pt2-third-person-';
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
  setView(mode: 'first' | 'third', shoulder?: 1 | -1, distance?: number): void;
  viewState(): { third: boolean; boom: number; hideBody: boolean; aimYaw: number; aimPitch: number };
  connectZone(r: { ticket: string; zoneEndpoint: string; zoneId: string; worldId: string; name?: string }): void;
  netDebug(): { phase: string } | null;
}
interface CombatHandle {
  runtime: { link: { sendInteract(k: number, id: bigint, a: number, arg: number): void }; swapLoadout(): void; press(what: string | number): void };
  hud(): { active: boolean; activeLoadout: number; loadouts: { weapon: string; gem: number; material?: number }[] };
}
interface AvatarInfo {
  id: number;
  action: string | null;
  animLevel: number;
  lod: number;
  weapon: string | null;
  x: number;
  y: number;
  z: number;
  glow: number;
  bowDraw: number;
}
type W = Window & { __lodestone: Handle; __lodestoneCombat?: CombatHandle; __lodestoneAvatars?: () => AvatarInfo[] };

async function startZone(bin: string) {
  const port = pickPort();
  const worldId = `pt2-${Date.now()}-${port}`;
  const zoneId = `zone-pt2-${port}`;
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

async function join(browser: Browser, vitePort: number, zone: Zone, name: string, at: { x: number; z: number }, view: 'first' | 'third'): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [${name}] pageerror: ${e.message}`));
  await page.goto(`http://127.0.0.1:${vitePort}/?debug=1&rain=0&view=${view}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!(window as unknown as W).__lodestone, null, { polling: 200, timeout: 60000 });
  const ticket = devTicket({ characterId: `pt2-${name}-${Date.now()}`, characterName: name, worldId: zone.worldId, zoneId: zone.zoneId });
  await page.evaluate((r) => (window as unknown as W).__lodestone.connectZone(r), { ticket, zoneEndpoint: `ws://127.0.0.1:${zone.port}/ws?spawn=${at.x.toFixed(2)},${at.z.toFixed(2)}`, zoneId: zone.zoneId, worldId: zone.worldId, name });
  await page.waitForFunction(() => (window as unknown as W).__lodestone.netDebug()?.phase === 'playing' && (window as unknown as W).__lodestone.player().pos.y > 20 && !!(window as unknown as W).__lodestoneCombat?.hud().active, null, { polling: 250, timeout: 120000 });
  await page.evaluate(() => {
    const l = (window as unknown as W).__lodestone;
    l.setQuality('high');
    l.setFreezeTime(true);
    l.setTimeOfDay(0.42 * 3600);
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
  await sleep(900);
}

const pos = (p: Page) => p.evaluate(() => (window as unknown as W).__lodestone.player().pos);
const look = (p: Page, yaw: number, pitch = -0.05) => p.evaluate(([y, pi]) => (window as unknown as W).__lodestone.setLook(y, pi), [yaw, pitch] as const);
const yawTo = (from: { x: number; z: number }, to: { x: number; z: number }) => Math.atan2(-(to.x - from.x), -(to.z - from.z));

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const bin = buildZone();
  const vitePort = pickPort();
  const vite = spawn(process.execPath, [path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], { cwd: path.join(repoRoot, 'client'), stdio: 'ignore' });
  let zone: Zone | null = null;
  let browser: Browser | null = null;
  const record: Record<string, unknown> = {};
  try {
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 90000);
    zone = await startZone(bin);
    // two pages render at once: no background throttling (A must keep sending input)
    browser = await chromium.launch({ headless: true, args: [...gpuArgs, '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
    const a = await join(browser, vitePort, zone, 'Mover', AT, 'third');
    await equip(a, 'sword', 0, 3);
    const posA0 = await pos(a);
    const b = await join(browser, vitePort, zone, 'Watcher', { x: posA0.x + 4, z: posA0.z + 2 }, 'first');
    await equip(b, 'wand', 4, 0);

    // B walks to about 4.5 m from A and looks at A's middle.
    const faceA = () =>
      b.evaluate(() => {
        const av = (window as unknown as W).__lodestoneAvatars?.() ?? [];
        const other = av[0];
        if (!other) return null;
        const l = (window as unknown as W).__lodestone;
        const p = l.player().pos;
        const d = Math.hypot(other.x - p.x, other.z - p.z);
        l.setLook(Math.atan2(-(other.x - p.x), -(other.z - p.z)), Math.atan2(other.y + 0.95 - (p.y + 1.8), d));
        return { d, ...other };
      });
    const approach = async (want: number) => {
      for (let i = 0; i < 60; i++) {
        const r = await faceA();
        if (r && Math.abs(r.d - want) < 0.6) return r;
        if (r) {
          const key = r.d > want ? 'KeyW' : 'KeyS';
          await b.keyboard.down(key);
          await sleep(Math.min(350, Math.abs(r.d - want) * 160));
          await b.keyboard.up(key);
        }
        await sleep(200);
      }
      return faceA();
    };
    await approach(4.6);
    const turnA = async (offset: number) => {
      const pa = await pos(a);
      const pb = await pos(b);
      await look(a, yawTo(pa, pb) + offset, -0.05);
      await sleep(500);
      await faceA();
    };

    // 1. A's own third-person view: the body, the sunsteel sword with a fire gem, B ahead.
    await turnA(0.35);
    await a.bringToFront();
    await sleep(1200);
    record.self = await a.evaluate(() => (window as unknown as W).__lodestone.viewState());
    await a.screenshot({ path: path.join(out, `${prefix}self.png`) });
    console.log('shot self', JSON.stringify(record.self));
    // and A's own swing, in third person
    await a.evaluate(() => (window as unknown as W).__lodestoneCombat!.runtime.press('attack'));
    await sleep(110);
    await a.screenshot({ path: path.join(out, `${prefix}self-attack.png`) });
    console.log('shot self-attack');
    await sleep(600);

    // 2. B watches A: each action, photographed while B's animator reports it.
    const shoot = async (name: string, want: string | null, delayMs: number, act: () => Promise<void>, timeoutMs = 3000) => {
      await b.bringToFront();
      await faceA();
      await act();
      const t0 = Date.now();
      let info: AvatarInfo | null = null;
      while (Date.now() - t0 < timeoutMs) {
        info = (await faceA()) as AvatarInfo | null;
        if (!want || info?.action === want) break;
        await sleep(15);
      }
      await sleep(delayMs);
      const after = await b.evaluate(() => (window as unknown as W).__lodestoneAvatars?.()[0] ?? null);
      await b.screenshot({ path: path.join(out, `${prefix}${name}.png`) });
      record[name] = { saw: info?.action ?? null, at: after };
      console.log(`shot ${name}: B saw ${info?.action ?? 'nothing'} (${after ? `lod ${after.lod}, glow ${after.glow.toFixed(2)}, draw ${after.bowDraw.toFixed(2)}` : 'no avatar'})`);
    };
    const press = (what: string | number) => () => a.evaluate((w) => (window as unknown as W).__lodestoneCombat!.runtime.press(w), what);

    await turnA(0.8);
    await shoot('remote-attack', 'slash', 120, press('attack'));
    await sleep(700);
    await shoot('remote-cast', 'cast', 150, press(0)); // ember flick (fire)
    await sleep(900);
    await shoot('remote-cast-area', 'castBig', 240, press(1)); // frost bite
    await sleep(1000);
    await shoot('remote-dodge', 'dodge', 110, press('dodge'));
    await sleep(800);
    // walking and sprinting across B's view (A's right side toward B)
    await approach(5.5);
    await turnA(Math.PI / 2);
    await shoot('remote-walk', null, 700, async () => {
      await a.keyboard.down('KeyW');
    });
    await a.keyboard.down('ShiftLeft');
    await shoot('remote-sprint', null, 600, async () => {});
    await a.keyboard.up('ShiftLeft');
    await a.keyboard.up('KeyW');
    await sleep(800);
    // bow draw, spear thrust
    await approach(4.6);
    await equip(a, 'bow', 2, 0);
    await turnA(0.9);
    await shoot('remote-bow-draw', 'draw', 700, press('alt'));
    await press('altRelease')();
    await sleep(900);
    await equip(a, 'spear', 1, 0);
    await turnA(0.9);
    await shoot('remote-spear', 'thrust', 130, press('attack'));
    await sleep(800);
    await equip(a, 'sword', 0, 3);
    await turnA(0.9);
    await shoot('remote-parry', 'parry', 120, press('alt'));
    await press('altRelease')();
    await sleep(600);

    // 3. Both in third person: B's own body in front, A beyond it.
    await b.evaluate(() => (window as unknown as W).__lodestone.setView('third'));
    await approach(6);
    await sleep(800);
    await shoot('both', 'slash', 140, press('attack'));
    fs.writeFileSync(path.join(out, `${prefix}shots.json`), JSON.stringify(record, null, 2) + '\n');
    console.log(`wrote ${prefix}shots.json`);
  } catch (e) {
    console.log(zone?.log.slice(-30).join('\n'));
    throw e;
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
