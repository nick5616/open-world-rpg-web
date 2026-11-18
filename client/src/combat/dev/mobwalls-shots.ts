// Playtest 5 (CR 056) line of sight for monsters, headless: the real client from Vite against
// the real zone binary on the official world (no DB/Redis, dev tickets, dev console, private
// random ports, midday). A small house of the spawn town:
//
//  1. Behind the wall: you stand at the front of the house looking at it; `/spawn wolf 3` and
//     `/spawn archer 2` appear 10 m ahead of you, in the back garden (the whole house between). They must not notice you: none leaves its spot in 8 s (before this
//     change a wolf noticed you through the wall and came round the corner).
//  2. In view: you step out to where the back garden is in line of sight (along the side
//     wall); they notice, the wolves come, the archers close in to shoot.
//
// The drawn positions of the monsters are read every 100 ms.
//
//   cd client && npx vite-node src/combat/dev/mobwalls-shots.ts
//
// Writes docs/evidence/pt5-mob-walls-*.jpg and pt5-mob-walls-shots.txt. Every process it starts is
// stopped at the end.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { chromium, type Browser, type Page } from 'playwright';
import { parseTowns, TownDoors, townsBytes, type Building } from '@lodestone/worldgen';
import { devTicket } from '../../net/dev/devTicket';
import { buildZone, repoRoot, waitHttp } from '../../sim/dev/traversalRun';
import { loadWorldgenGround } from '../../sim/worldgenGround';

const SEED = '20261108';
const out = path.join(repoRoot, 'docs', 'evidence');
const lines: string[] = [];
const note = (s: string) => {
  lines.push(s);
  console.log(s);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gpuArgs = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const shot = (name: string) => path.join(out, `pt5-mob-walls-${name}.png`);

/** A file searched for upward from the repo root (a worktree shares the main checkout's wasm build). */
function findUp(rel: string): string {
  for (let dir = repoRoot; ; dir = path.dirname(dir)) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) return p;
    if (path.dirname(dir) === dir) throw new Error(`${rel} not found (npm run build:wasm)`);
  }
}

async function randomPort(): Promise<number> {
  for (;;) {
    const p = 20000 + Math.floor(Math.random() * 25000);
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (ok) return p;
  }
}

type V = { x: number; y: number; z: number };
type W = Window & {
  __lodestone: {
    player(): { pos: V };
    setLook(yaw: number | null, pitch?: number): void;
    setQuality(q: string): void;
    connectZone(r: { ticket: string; zoneEndpoint: string; zoneId: string; worldId: string; name?: string }): void;
    netDebug(): { phase: string } | null;
  };
  __lodestoneMap?: { towers(): unknown[] };
  __lodestoneIntro?: { volume(v?: number): number; skip(): void };
  __lodestoneDev?: { run(line: string): unknown; open(o: boolean): void };
  __lodestoneDrawn?: () => { id: number; kind: number; x: number; z: number; healthPct: number }[];
};
const lookAt = (from: { x: number; z: number }, to: { x: number; z: number }) => Math.atan2(-(to.x - from.x), -(to.z - from.z));

function offsetFor(hour: number): number {
  const day = 3600;
  const now = Date.now() / 1000;
  return (hour / 24) * day - (now % day);
}

/** World point at the building's local (u along the frontage, v inward from the door wall). */
const local = (b: Building, u: number, v: number) => ({ x: b.x + u * b.c - v * b.s, z: b.z + u * b.s + v * b.c });
const toLocal = (b: Building, p: { x: number; z: number }) => {
  const dx = p.x - b.x;
  const dz = p.z - b.z;
  return { u: dx * b.c + dz * b.s, v: dz * b.c - dx * b.s };
};

async function main(): Promise<void> {
  fs.mkdirSync(out, { recursive: true });
  const terrain = await loadWorldgenGround(fs.readFileSync(findUp(path.join('worldgen', 'pkg', 'worldgen.wasm'))), SEED);
  const towns = parseTowns(townsBytes(terrain.wg, terrain.atlas));
  const doors = new TownDoors(towns);
  const sp = terrain.atlas.data.spawn;
  let si = towns.settlements[0];
  for (const s of towns.settlements) if (Math.hypot(s.x - sp.x, s.z - sp.z) < Math.hypot(si.x - sp.x, si.z - sp.z)) si = s;
  // A small house with a door and open ground all round it (no other building within 2 m of the run).
  const inside = (o: Building, p: { x: number; z: number }, m: number) => {
    const l = toLocal(o, p);
    return Math.abs(l.u) < o.hx + m && Math.abs(l.v) < o.hz + m;
  };
  let house: Building | null = null;
  for (const d of doors.doors) {
    if (d.settlement !== si.index) continue;
    const b = towns.buildings[d.building];
    if (b.hx > 6.5 || b.hz > 5.5) continue;
    const ring = [
      [0, b.hz + 6],
      [0, b.hz + 17],
      [b.hx + 3, b.hz + 3],
      [b.hx + 3, 0],
      [b.hx + 3, -b.hz - 3],
      [-b.hx - 3, b.hz + 3],
      [-b.hx - 3, -b.hz - 3],
      [0, -b.hz - 3.5],
      [b.hx + 6, -b.hz - 6],
    ].map(([u, v]) => local(b, u, v));
    const clear = ring.every((p) => towns.buildings.every((o) => o.index === b.index || !inside(o, p, 2)) && terrain.waterAt(p.x, p.z) < terrain.heightAt(p.x, p.z) - 0.3);
    const flat = ring.every((p) => Math.abs(terrain.heightAt(p.x, p.z) - terrain.heightAt(b.x, b.z)) < 2.5);
    if (clear && flat) {
      house = b;
      break;
    }
  }
  if (!house) throw new Error('no small house with open ground all round it in the spawn town');
  const b = house;
  const townName = terrain.atlas.data.sites.find((s) => s.index === si.site)?.name ?? `settlement ${si.index}`;
  note(`house ${b.index} of "${townName}" at (${b.x.toFixed(1)}, ${b.z.toFixed(1)}): ${(2 * b.hx).toFixed(1)} x ${(2 * b.hz).toFixed(1)} m, door on its -v wall`);
  const back = local(b, 0, b.hz + 6);

  const zoneBin = buildZone();
  const zonePort = await randomPort();
  const zoneId = `zone-walls-${zonePort}`;
  const worldId = `walls-${Date.now()}`;
  const zoneLog: string[] = [];
  const zone: ChildProcess = spawn(zoneBin, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      LODESTONE_ZONE_PORT: String(zonePort),
      LODESTONE_ZONE_WT_ADDR: 'off',
      LODESTONE_ZONE_NO_DB: '1',
      LODESTONE_ZONE_NO_REDIS: '1',
      LODESTONE_ZONE_ID: zoneId,
      LODESTONE_WORLD_ID: worldId,
      LODESTONE_WORLD_SEED: SEED,
      LODESTONE_GEN_VERSION: 'dev',
      LODESTONE_ZONE_REQUIRE_TERRAIN: '1',
      LODESTONE_ZONE_DEV_SPAWN: '1',
      LODESTONE_ZONE_DEV: '1',
      LODESTONE_ZONE_NO_DEMONS: '1',
      LODESTONE_ZONE_NO_WILD_PACKS: '1',
      LODESTONE_ZONE_NO_WORLD_EVENTS: '1',
      LODESTONE_ZONE_TIME_OFFSET_S: String(offsetFor(12.5)),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const keep = (buf: Buffer) => {
    for (const l of buf.toString().split('\n')) if (l.trim()) zoneLog.push(l);
  };
  zone.stdout?.on('data', keep);
  zone.stderr?.on('data', keep);
  const vitePort = await randomPort();
  const vite = spawn(process.execPath, [path.join(path.dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin', 'vite.js'), '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], { cwd: path.join(repoRoot, 'client'), stdio: 'ignore' });
  let browser: Browser | null = null;
  const newest = (JSON.parse(fs.readFileSync(path.join(repoRoot, 'client', 'src', 'ui', 'whatsnew', 'changelog.json'), 'utf8')) as { id: string }[])[0]?.id ?? '';
  let pass = true;
  try {
    await waitHttp(`http://127.0.0.1:${zonePort}/healthz`, 120000);
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 90000);
    browser = await chromium.launch({ headless: true, args: gpuArgs });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page: Page = await ctx.newPage();
    page.on('pageerror', (e) => note(`  pageerror: ${e.message}`));
    await page.addInitScript((id) => {
      localStorage.setItem('lodestone_tips_enabled', '0');
      localStorage.setItem('lodestone_whatsnew_seen', id);
    }, newest);
    await page.goto(`http://127.0.0.1:${vitePort}/?debug=1`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!(window as unknown as W).__lodestone, null, { polling: 200, timeout: 60000 });
    const conn = { ticket: devTicket({ characterId: `pt5-walls-${Date.now()}`, characterName: 'Ash', worldId, zoneId }), zoneEndpoint: `ws://127.0.0.1:${zonePort}/ws?spawn=${back.x.toFixed(2)},${back.z.toFixed(2)}`, zoneId, worldId, name: 'Ash' };
    await page.evaluate((r) => (window as unknown as W).__lodestone.connectZone(r), conn);
    await page.waitForFunction(() => {
      const w = window as unknown as W;
      return w.__lodestone.netDebug()?.phase === 'playing' && (w.__lodestoneMap?.towers().length ?? 0) > 0 && !!w.__lodestoneDev;
    }, null, { polling: 250, timeout: 180000 });
    await page.evaluate(() => (window as unknown as W).__lodestone.setQuality('high'));
    await page.evaluate(() => (window as unknown as W).__lodestoneIntro?.volume(0));
    for (let k = 0; k < 8; k++) {
      await page.evaluate(() => (window as unknown as W).__lodestoneIntro?.skip());
      await sleep(150);
    }
    await page.keyboard.press('F3'); // the debug readout off
    const dev = async (line: string) => {
      await page.evaluate((l) => (window as unknown as W).__lodestoneDev!.run(l), line);
      await sleep(350);
    };
    const drawn = () => page.evaluate(() => ((window as unknown as W).__lodestoneDrawn?.() ?? []).filter((v) => v.kind === 2 && v.healthPct > 0));
    await dev('/god on');
    await dev('/stamina on');
    await page.keyboard.press('KeyT'); // third person

    // 1. Behind the wall: you stand at the front of the house looking at it; `/spawn` puts the
    // monsters 10 m ahead of you, in the garden behind the house.
    const front = local(b, 0, -b.hz - 1.5);
    await dev(`/tp ${front.x.toFixed(1)} ${front.z.toFixed(1)}`);
    await sleep(1500);
    await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.05), lookAt(front, local(b, 0, b.hz + 25)));
    await sleep(400);
    await dev('/spawn wolf 3');
    await dev('/spawn archer 2');
    await sleep(600);
    const start = new Map<number, { x: number; z: number }>();
    for (const e of await drawn()) start.set(e.id, { x: e.x, z: e.z });
    await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.25), lookAt(front, local(b, 0, b.hz + 4)));
    const dist = (a: { x: number; z: number }, c: { x: number; z: number }) => Math.hypot(a.x - c.x, a.z - c.z);
    let maxMoved = 0;
    let minToMe = 1e9;
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      const me = await page.evaluate(() => (window as unknown as W).__lodestone.player().pos);
      for (const e of await drawn()) {
        const s0 = start.get(e.id);
        if (s0) maxMoved = Math.max(maxMoved, dist(e, s0));
        minToMe = Math.min(minToMe, dist(e, me));
      }
      await sleep(100);
    }
    await page.screenshot({ path: shot('behind-wall') });
    note(`1. ${start.size} monsters spawned on the far side of the house; after 8 s the one that moved most went ${maxMoved.toFixed(1)} m, the nearest was ${minToMe.toFixed(1)} m from me; shot pt5-mob-walls-behind-wall.png`);
    const ignored = start.size >= 3 && maxMoved < 3;
    note(ignored ? 'PASS: they did not notice me through the wall' : 'FAIL: they noticed me through the wall');

    // 2. Step into view: along the side wall the garden is in line of sight.
    const view = local(b, b.hx + 6, b.hz + 2);
    await dev(`/tp ${view.x.toFixed(1)} ${view.z.toFixed(1)}`);
    await sleep(300);
    await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.15), lookAt(view, back));
    let noticed = false;
    const t1 = Date.now();
    while (Date.now() - t1 < 9000 && !noticed) {
      for (const e of await drawn()) {
        const s0 = start.get(e.id);
        if (s0 && dist(e, s0) > 3) noticed = true;
      }
      await sleep(100);
    }
    await page.screenshot({ path: shot('in-view') });
    note(`2. stepped out where the garden is in view: noticed = ${noticed} after ${((Date.now() - t1) / 1000).toFixed(1)} s; shot pt5-mob-walls-in-view.png`);
    pass = ignored && noticed;
    note(pass ? 'PASS: line of sight decides' : 'FAIL');
    await dev('/despawn');
  } finally {
    await browser?.close().catch(() => {});
    vite.kill();
    zone.kill();
    const rel = zoneLog.filter((l) => /dev command|violation|error|panic/i.test(l)).slice(0, 30);
    fs.writeFileSync(path.join(out, 'pt5-mob-walls-shots.txt'), [...lines, '', 'zone log (dev commands, errors):', ...rel].join('\n') + '\n');
  }
  if (!pass) throw new Error('mob walls headless check failed');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    fs.appendFileSync(path.join(out, 'pt5-mob-walls-shots.txt'), `ERROR ${e?.stack ?? e}\n`);
    process.exit(1);
  },
);
