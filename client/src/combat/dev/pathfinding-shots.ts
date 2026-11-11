// Playtest 2 enemy pathfinding, headless: the real client from Vite against
// the real zone binary on the official world (seed 20261108, no DB/Redis,
// dev tickets, LODESTONE_ZONE_DEV=1 for the dev console, private random
// ports, midday). A small house of the spawn town:
//
//  1. Run round it: from behind the house, `/spawn wolf 3`, then run round
//     a corner to its front door with the wolves after you.
//  2. Round it, not through it: `/despawn`, back behind the house, `/spawn
//     wolf 3`, and `/tp` to the front door: the wolves are on the far side
//     of the house and must path round a corner to get at you (they used to
//     stand at the back wall). Third person from the door, looking along
//     the side wall, as they come round.
//
// Every 100 ms the wolves' drawn positions are put in the house's frame:
// none may ever be inside its walls, and they must reach the front.
//
//   cd client && npx vite-node src/combat/dev/pathfinding-shots.ts
//
// One zone, one Vite, ONE browser. Writes docs/evidence/pt2-pathfinding-*.png
// and pt2-pathfinding-shots.txt. Every process it starts is stopped at the end.

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
const shot = (name: string) => path.join(out, `pt2-pathfinding-${name}.png`);

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
  const front = local(b, 0, -b.hz - 3.5);
  const frontSide = local(b, b.hx + 3.5, -b.hz - 4); // off the front corner, looking along the side wall

  const zoneBin = buildZone();
  const zonePort = await randomPort();
  const zoneId = `zone-path-${zonePort}`;
  const worldId = `path-${Date.now()}`;
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
    const conn = { ticket: devTicket({ characterId: `pt2-path-${Date.now()}`, characterName: 'Ash', worldId, zoneId }), zoneEndpoint: `ws://127.0.0.1:${zonePort}/ws?spawn=${back.x.toFixed(2)},${back.z.toFixed(2)}`, zoneId, worldId, name: 'Ash' };
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
    const me = () => page.evaluate(() => (window as unknown as W).__lodestone.player().pos);
    const wolves = () => page.evaluate(() => ((window as unknown as W).__lodestoneDrawn?.() ?? []).filter((v) => v.kind === 2 && v.healthPct > 0));
    await dev('/god on');
    await dev('/stamina on');

    // Watch the wolves in the house's frame.
    let inWalls = 0;
    let samples = 0;
    const seen = new Set<number>();
    const fronted = new Set<number>();
    const sided = new Set<number>(); // beside a side wall (between its back and front corners)
    const watch = async () => {
      for (const e of await wolves()) {
        const l = toLocal(b, e);
        samples++;
        seen.add(e.id);
        if (Math.abs(l.u) < b.hx - 0.25 && Math.abs(l.v) < b.hz - 0.25) inWalls++;
        if (l.v < -b.hz) fronted.add(e.id);
        if (Math.abs(l.u) > b.hx + 0.3 && Math.abs(l.v) < b.hz) sided.add(e.id);
      }
    };
    const walkTo = async (to: { x: number; z: number }, maxMs: number) => {
      await page.keyboard.down('KeyW');
      const t0 = Date.now();
      try {
        for (;;) {
          const at = await me();
          if (Math.hypot(to.x - at.x, to.z - at.z) < 1.2 || Date.now() - t0 > maxMs) break;
          await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.1), lookAt(at, to));
          await watch();
          await sleep(70);
        }
      } finally {
        await page.keyboard.up('KeyW');
      }
    };

    // 1. Run round the house with the wolves after you.
    await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.05), lookAt(back, local(b, 0, b.hz + 20)));
    await sleep(500);
    await dev('/spawn wolf 3');
    await sleep(1200);
    await page.keyboard.press('KeyT'); // third person
    await walkTo(local(b, b.hx + 3, b.hz + 3), 6000);
    await walkTo(local(b, b.hx + 3, -b.hz - 3), 6000);
    await walkTo(front, 4000);
    const runSided = sided.size;
    for (let k = 0; k < 20; k++) {
      await watch();
      await sleep(100);
    }
    await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.25), lookAt(front, local(b, b.hx + 4, -b.hz - 2)));
    await sleep(500);
    await page.screenshot({ path: shot('run') });
    note(`1. ran round the house from the back to its door with 3 wolves after me: ${seen.size} wolves seen, ${runSided} came along its side wall after me; shot pt2-pathfinding-run.png`);

    // 2. Wolves on the far side, you off the front corner: they must path round.
    await dev('/despawn');
    await dev(`/tp ${back.x.toFixed(1)} ${back.z.toFixed(1)}`);
    await sleep(1500);
    await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.05), lookAt(back, local(b, 0, b.hz + 20)));
    await sleep(400);
    seen.clear();
    fronted.clear();
    sided.clear();
    await dev('/spawn wolf 3');
    await sleep(900); // they notice you (600 ms alert)
    await dev(`/tp ${frontSide.x.toFixed(1)} ${frontSide.z.toFixed(1)}`);
    await sleep(300);
    // From off the front corner, look along the side wall toward the back corner they come round.
    await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.2), lookAt(frontSide, local(b, b.hx + 1.5, b.hz + 4)));
    let rounding = false;
    let arrived = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 12000 && !arrived) {
      await watch();
      const ws = await wolves();
      const at = await me();
      if (!rounding && ws.some((e) => {
        const l = toLocal(b, e);
        return l.u > b.hx + 0.3 && l.v < b.hz - 1;
      })) {
        rounding = true;
        await page.screenshot({ path: shot('round-corner') });
        note(`2. shot pt2-pathfinding-round-corner.png after ${((Date.now() - t0) / 1000).toFixed(1)} s: a wolf round the back corner, coming along the side wall toward me off the front corner`);
      }
      if (ws.filter((e) => Math.hypot(e.x - at.x, e.z - at.z) < 4).length >= 2) {
        arrived = true;
        await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.3), lookAt(at, ws[0]));
        await sleep(300);
        await page.screenshot({ path: shot('arrived') });
        note(`   shot pt2-pathfinding-arrived.png after ${((Date.now() - t0) / 1000).toFixed(1)} s: the wolves round the house, at me`);
      }
      await sleep(100);
    }
    note(`   wolves seen ${seen.size}, along the side wall ${sided.size}, came round to the front ${fronted.size}; rounding the corner seen: ${rounding}; at me: ${arrived}`);
    note(`wolf samples ${samples}, inside the house's walls: ${inWalls}`);
    pass = inWalls === 0 && sided.size >= 2 && rounding && arrived;
    note(pass ? 'PASS: the wolves went round the house, never through it' : 'FAIL');
    await dev('/despawn');
  } finally {
    await browser?.close().catch(() => {});
    vite.kill();
    zone.kill();
    const rel = zoneLog.filter((l) => /dev command|violation|error|panic/i.test(l)).slice(0, 30);
    fs.writeFileSync(path.join(out, 'pt2-pathfinding-shots.txt'), [...lines, '', 'zone log (dev commands, errors):', ...rel].join('\n') + '\n');
  }
  if (!pass) throw new Error('pathfinding headless check failed');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    fs.appendFileSync(path.join(out, 'pt2-pathfinding-shots.txt'), `ERROR ${e?.stack ?? e}\n`);
    process.exit(1);
  },
);
