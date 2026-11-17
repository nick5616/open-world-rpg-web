// Playtest 4 (CR 052) evidence in headless Chromium: the real client from Vite
// against the real zone binary on the official world (seed 20261108, no
// DB/Redis, dev tickets, private random ports), on the GPU.
//
//   cd client && npx vite-node src/world/guide/dev/diegetic-shots.ts [--hour=10] [--only=hud,wisp,sign,horizon,pillar]
//
//   hud      the same moment with the Immersive HUD on and off, side by side (docs/evidence/pt4-diegetic-hud.jpg)
//   wisp     the wisp leading down a road toward a pin (pt4-diegetic-wisp.jpg)
//   sign     an exit signpost up close (pt4-diegetic-signpost.jpg)
//   horizon  the horizon from the starting town toward the nearest camp (pt4-diegetic-horizon.jpg)
//   pillar   at dusk (--hour=19.6): the horizon toward the nearest tower (pt4-diegetic-pillar.jpg)
// Writes docs/evidence/pt4-diegetic-*.jpg and prints notes.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn as spawnProc, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright';
import { parseTowns, townsBytes } from '@lodestone/worldgen';
import { placeSignposts } from '../../signposts/placement';
import { devTicket } from '../../../net/dev/devTicket';
import { buildZone, repoRoot, waitHttp } from '../../../sim/dev/traversalRun';
import { loadWorldgenGround } from '../../../sim/worldgenGround';

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const HOUR = Number(arg('hour') ?? 10);
const ONLY = arg('only')?.split(',');
const SEED = '20261108';
const out = path.join(repoRoot, 'docs', 'evidence');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gpuArgs = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const want = (k: string) => !ONLY || ONLY.includes(k);
const note = (s: string) => console.log(s);

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

type W = Window & {
  __lodestone: {
    player(): { pos: { x: number; y: number; z: number } };
    setLook(yaw: number | null, pitch?: number): void;
    setQuality(q: string): void;
    teleport(t: { x: number; z: number }): void;
    connectZone(r: { ticket: string; zoneEndpoint: string; zoneId: string; worldId: string; name?: string }): void;
    netDebug(): { phase: string } | null;
  };
  __lodestoneMap?: { towers(): unknown[]; setPin(x: number, z: number, party?: boolean, color?: number): void };
  __lodestoneDiegetic?: { posts(): { id: string; kind: string; x: number; z: number; y: number; boards: string[]; view?: { x: number; z: number; yaw: number } }[]; wisp(): unknown };
  __lodestoneTowns?: { settlements(): unknown[] };
  __lodestoneIntro?: { volume(v?: number): number; skip(): void };
};
const lookAt = (from: { x: number; z: number }, to: { x: number; z: number }) => Math.atan2(-(to.x - from.x), -(to.z - from.z));

function hourOffset(h: number): number {
  const day = 3600;
  const now = Date.now() / 1000;
  return (h / 24) * day - (now % day);
}

async function main(): Promise<void> {
  fs.mkdirSync(out, { recursive: true });
  const ground = await loadWorldgenGround(fs.readFileSync(path.join(repoRoot, 'worldgen', 'pkg', 'worldgen.wasm')), SEED);
  const atlas = ground.atlas.data;
  const towns = parseTowns(townsBytes(ground.wg, ground.atlas));
  const spawn = atlas.spawn;
  const hub = towns.settlements.map((s) => ({ s, name: atlas.sites[s.site]?.name ?? '', d: Math.hypot(s.x - spawn.x, s.z - spawn.z) })).sort((a, b) => a.d - b.d)[0];
  note(`start town "${hub.name}" (${hub.s.x.toFixed(0)}, ${hub.s.z.toFixed(0)}) r ${hub.s.radius.toFixed(0)}; spawn (${spawn.x.toFixed(0)}, ${spawn.z.toFixed(0)}); hour ${HOUR}`);
  // Roads leaving the start town (exit posts), and for the wisp the longest road of 450-1100 m with an end within 3 km (its far end is the pin).
  const longRoads = towns.roads
    .filter((r) => r.cls === 0 && r.length >= 450 && r.length <= 1100 && Math.min(Math.hypot(r.points[0] - spawn.x, r.points[2] - spawn.z), Math.hypot(r.points[r.points.length - 3] - spawn.x, r.points[r.points.length - 1] - spawn.z)) < 3000)
    .sort((a, b) => Math.hypot(a.points[0] - spawn.x, a.points[2] - spawn.z) - Math.hypot(b.points[0] - spawn.x, b.points[2] - spawn.z));
  const road = longRoads[0];
  const near = true;
  const rp: { x: number; z: number }[] = [];
  if (road) for (let i = 0; i < road.points.length / 3; i++) rp.push({ x: road.points[i * 3], z: road.points[i * 3 + 2] });
  if (road && !near) rp.reverse();
  const along = (d: number) => {
    let acc = 0;
    for (let i = 1; i < rp.length; i++) {
      const L = Math.hypot(rp[i].x - rp[i - 1].x, rp[i].z - rp[i - 1].z);
      if (acc + L >= d) {
        const f = (d - acc) / L;
        return { x: rp[i - 1].x + (rp[i].x - rp[i - 1].x) * f, z: rp[i - 1].z + (rp[i].z - rp[i - 1].z) * f, a: rp[Math.min(rp.length - 1, i + 3)] };
      }
      acc += L;
    }
    return { x: rp[rp.length - 1].x, z: rp[rp.length - 1].z, a: rp[rp.length - 1] };
  };
  const far = rp.length ? rp[rp.length - 1] : { x: spawn.x + 600, z: spawn.z };
  note(`road ${road?.index} from town: ${road?.length.toFixed(0)} m, ends at (${far.x.toFixed(0)}, ${far.z.toFixed(0)})`);
  const sites = atlas.sites;
  const nearest = (pred: (s: (typeof sites)[number]) => boolean) =>
    sites.filter(pred).sort((a, b) => Math.hypot(a.x - spawn.x, a.z - spawn.z) - Math.hypot(b.x - spawn.x, b.z - spawn.z))[0];
  const camp = nearest((s) => (s.kind === 'bandit_camp' || s.kind === 'enemy_camp') && !s.layer && Math.hypot(s.x - spawn.x, s.z - spawn.z) < 2600);
  const tower = nearest((s) => s.kind === 'tower');
  note(`nearest camp: ${camp ? `${camp.kind} ${Math.hypot(camp.x - spawn.x, camp.z - spawn.z).toFixed(0)} m` : 'none within 2.6 km'}; nearest tower: ${tower ? `${Math.hypot(tower.x - spawn.x, tower.z - spawn.z).toFixed(0)} m` : 'none'}`);

  const zoneBin = buildZone();
  const zonePort = await randomPort();
  const zoneId = `zone-pt4d-${zonePort}`;
  const worldId = `pt4d-${Date.now()}`;
  const zone: ChildProcess = spawnProc(zoneBin, [], {
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
      LODESTONE_ZONE_NO_DEMONS: '1',
      LODESTONE_ZONE_NO_ATLAS_ENEMIES: '1',
      LODESTONE_ZONE_TIME_OFFSET_S: String(hourOffset(HOUR)),
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const vitePort = await randomPort();
  const vite = spawnProc(process.execPath, [path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], { cwd: path.join(repoRoot, 'client'), stdio: 'ignore' });
  let browser: Browser | null = null;
  let n = 0;
  let cardSeen = false;
  try {
    await waitHttp(`http://127.0.0.1:${zonePort}/healthz`, 120000);
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 90000);
    browser = await chromium.launch({ headless: true, args: gpuArgs });

    async function join(at: { x: number; z: number }, label: string, immersive = true): Promise<Page> {
      const page = await browser!.newPage({ viewport: { width: 1280, height: 720 } });
      page.on('pageerror', (e) => note(`  [${label}] pageerror: ${e.message}`));
      await page.addInitScript((v) => {
        try {
          localStorage.setItem('lodestone_hud', JSON.stringify({ state: { immersive: v }, version: 1 }));
        } catch {
          /* ignore */
        }
      }, immersive);
      await page.goto(`http://127.0.0.1:${vitePort}/?debug=1`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => !!(window as unknown as W).__lodestone, null, { polling: 200, timeout: 60000 });
      const name = `${label}${++n}`;
      const ticket = devTicket({ characterId: `pt4d-${Date.now()}-${n}`, characterName: name, worldId, zoneId });
      await page.evaluate((r) => (window as unknown as W).__lodestone.connectZone(r), { ticket, zoneEndpoint: `ws://127.0.0.1:${zonePort}/ws?spawn=${at.x.toFixed(2)},${at.z.toFixed(2)}`, zoneId, worldId, name });
      await page.waitForFunction(() => {
        const w = window as unknown as W;
        return w.__lodestone.netDebug()?.phase === 'playing' && (w.__lodestoneMap?.towers().length ?? 0) > 0 && !!w.__lodestoneTowns && w.__lodestoneTowns.settlements().length > 0 && !!w.__lodestoneDiegetic;
      }, null, { polling: 250, timeout: 180000 });
      await page.evaluate(() => (window as unknown as W).__lodestone.setQuality('high'));
      await page.keyboard.press('F3'); // hide the debug HUD
      for (let k = 0; k < (cardSeen ? 3 : 40); k++) {
        // the welcome / What's new card: Got it
        const b = page.getByText('Got it', { exact: true });
        if (await b.count()) {
          await b.first().click().catch(() => {});
          cardSeen = true;
          break;
        }
        await sleep(500);
      }
      await page.evaluate(() => (window as unknown as W).__lodestoneIntro?.volume(0));
      await sleep(1500);
      return page;
    }
    const skipIntros = async (p: Page) => {
      for (let k = 0; k < 6; k++) {
        await p.evaluate(() => (window as unknown as W).__lodestoneIntro?.skip());
        await sleep(150);
      }
    };
    const jpg = async (p: Page, name: string) => {
      for (let k = 0; k < 4; k++) {
        const b = p.getByText('Got it', { exact: true });
        if (await b.count()) {
          await b.first().click().catch(() => {});
          await sleep(1200);
          break;
        }
        await sleep(500);
      }
      const f = path.join(out, `pt4-diegetic-${name}.jpg`);
      await p.screenshot({ path: f, type: 'jpeg', quality: 72 });
      note(`shot ${path.relative(repoRoot, f)} (${(fs.statSync(f).size / 1024).toFixed(0)} KB)`);
    };
    const settle = async (p: Page, ms = 3500) => {
      for (let k = 0; k < 12; k++) {
        const b = p.getByText('Got it', { exact: true });
        if (await b.count()) {
          await b.first().click().catch(() => {});
          break;
        }
        await sleep(500);
      }
      await skipIntros(p);
      await sleep(ms);
    };

    if (want('hud')) {
      const a = await join(spawn, 'Quiet', true);
      const b = await join(spawn, 'Full', false);
      for (const p of [a, b]) {
        await settle(p, 1000);
        await p.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.04), lookAt(spawn, camp ?? { x: spawn.x + 100, z: spawn.z }));
      }
      await sleep(13000); // past the tracker's 9 s after the first step news
      const ba = await a.screenshot({ type: 'png' });
      const bb = await b.screenshot({ type: 'png' });
      const page = await browser.newPage({ viewport: { width: 1920, height: 540 } });
      await page.setContent(`<body style="margin:0;background:#000;display:flex"><img id=a style="width:960px;height:540px" src="data:image/png;base64,${ba.toString('base64')}"><img id=b style="width:960px;height:540px" src="data:image/png;base64,${bb.toString('base64')}"></body>`);
      await sleep(400);
      await jpg(page, 'hud');
      await page.close();
      await a.close();
      await b.close();
    }

    if (want('wisp') && road) {
      const p0 = along(560);
      const ahead = along(520);
      const page = await join({ x: p0.x, z: p0.z }, 'Wisp');
      await settle(page, 1500);
      await page.evaluate(([x, z]) => (window as unknown as W).__lodestoneMap!.setPin(x, z), [far.x, far.z] as const);
      await sleep(800);
      await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.12), lookAt(p0, ahead));
      await page.keyboard.press('Period');
      await sleep(3500);
      const st = await page.evaluate(() => (window as unknown as W).__lodestoneDiegetic!.wisp());
      note(`wisp: ${JSON.stringify(st)}`);
      // look at the wisp (the route may bend away from the road's own direction)
      const head = await page.evaluate(() => (window as unknown as { __lodestoneDiegetic: { head(): { x: number; y: number; z: number } } }).__lodestoneDiegetic.head());
      const me = await page.evaluate(() => (window as unknown as W).__lodestone.player().pos);
      note(`wisp head ${JSON.stringify(head)} player ${JSON.stringify(me)}`);
      const pitch = Math.atan2(head.y - (me.y + 1.6), Math.hypot(head.x - me.x, head.z - me.z));
      await page.evaluate(([y, pt]) => (window as unknown as W).__lodestone.setLook(y, pt), [lookAt(me, head), pitch] as const);
      await sleep(900);
      await jpg(page, 'wisp');
      await page.close();
    }

    if (want('sign')) {
      const posts = placeSignposts({
        settlements: towns.settlements.map((s) => ({ index: s.index, site: s.site, x: s.x, z: s.z, radius: s.radius })),
        roads: towns.roads.map((r) => ({ index: r.index, from: r.from, to: r.to, cls: r.cls, width: r.width, points: r.points })),
        forks: towns.signs.map((s) => ({ id: s.id.toString(), x: s.x, y: s.y, z: s.z, arms: s.arms })),
        sites: atlas.sites.map((s) => ({ index: s.index, category: s.category, kind: s.kind, name: s.name, x: s.x, z: s.z, layer: s.layer })),
      });
      note(`signposts: ${posts.length} (${posts.filter((p) => p.kind === 'fork').length} forks, ${posts.filter((p) => p.kind === 'exit').length} exits)`);
      const exit = posts.filter((p) => p.kind === 'exit' && p.boards.length >= 3).sort((a, b) => Math.hypot(a.x - spawn.x, a.z - spawn.z) - Math.hypot(b.x - spawn.x, b.z - spawn.z))[0];
      if (exit?.roadDir) {
        note(`exit post ${exit.id} at (${exit.x.toFixed(1)}, ${exit.z.toFixed(1)}): ${exit.boards.map((b) => `${b.name} ${b.dist.toFixed(0)} m`).join(' | ')}`);
        const t = exit.roadDir;
        const c = { x: exit.x + t.z * 0.78, z: exit.z - t.x * 0.78 };
        const me = { x: c.x - t.x * 3.2, z: c.z - t.z * 3.2 };
        const page = await join(me, 'Sign');
        await settle(page, 1500);
        await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, 0.2), lookAt(me, c));
        await sleep(1500);
        await jpg(page, 'signpost');
        await page.close();
      }
    }


    if (want('horizon') && camp) {
      const page = await join(spawn, 'Horizon');
      await settle(page, 2500);
      await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, 0.04), lookAt(spawn, camp));
      await sleep(2500);
      note(`landmarks near: ${JSON.stringify(await page.evaluate(() => (window as unknown as { __lodestoneDiegetic: { landmarks(): unknown } }).__lodestoneDiegetic.landmarks()))}`);
      await jpg(page, 'horizon');
      await page.close();
    }

    if (want('pillar') && tower) {
      const page = await join(spawn, 'Pillar');
      await settle(page, 2500);
      await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, 0.06), lookAt(spawn, tower));
      await sleep(2500);
      await jpg(page, 'pillar');
      await page.close();
    }
  } finally {
    await browser?.close().catch(() => {});
    zone.kill();
    vite.kill();
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
