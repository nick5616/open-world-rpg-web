// Playtest 2 mounts (CR 027) screenshots in headless Chromium: the real
// client from Vite against the real zone binary on the official world
// (seed 20261108, no DB/Redis, dev tickets, private random ports, midday):
// the whistle and the steed galloping in, galloping in third person (a spur
// and its burst), the rider seen by another player, first person in the
// saddle, and the steed panel.
//
//   cd client && npx vite-node src/ui/mounts/dev/mount-shots.ts
//
// One zone, one Vite, ONE browser (two pages: the rider and an observer).
// Writes docs/evidence/pt2-mounts-*.png and pt2-mounts-shots.txt. Every
// process it starts is stopped at the end.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { chromium, type Browser, type Page } from 'playwright';
import { devTicket } from '../../../net/dev/devTicket';
import { buildZone, repoRoot, waitHttp } from '../../../sim/dev/traversalRun';
import { loadWorldgenGround } from '../../../sim/worldgenGround';

const SEED = '20261108';
const out = path.join(repoRoot, 'docs', 'evidence');
const lines: string[] = [];
const note = (s: string) => {
  lines.push(s);
  console.log(s);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gpuArgs = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const shot = (name: string) => path.join(out, `pt2-mounts-${name}.png`);

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
type Steed = { owner: number; phase: number; x: number; y: number; z: number; fx: number; fz: number; colour: number; name: string };
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
  __lodestoneMounts?: {
    state(): { mine: { owned: boolean; name: string; colour: number; phase: number } | null; steeds: Record<string, Steed>; selfId: number; notes: string[]; mounted: boolean; gait: number; speed: number; pos: V };
    actions(): { summon(): void; mount(): void; dismount(): void; name(t: string): void; colour(i: number): void; dev(): void } | null;
    panel(open?: boolean): void;
  };
  __lodestoneAvatars?: () => { id: number; x: number; y: number; z: number; steed: string; heading: number }[];
};
const lookAt = (from: { x: number; z: number }, to: { x: number; z: number }) => Math.atan2(-(to.x - from.x), -(to.z - from.z));

function offsetFor(hour: number): number {
  const day = 3600;
  const now = Date.now() / 1000;
  return (hour / 24) * day - (now % day);
}

async function joinPage(browser: Browser, url: string, newest: string, conn: { ticket: string; zoneEndpoint: string; zoneId: string; worldId: string; name: string }): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => note(`  pageerror (${conn.name}): ${e.message}`));
  await page.addInitScript((id) => {
    localStorage.setItem('lodestone_tips_enabled', '0');
    localStorage.setItem('lodestone_whatsnew_seen', id);
  }, newest);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!(window as unknown as W).__lodestone, null, { polling: 200, timeout: 60000 });
  await page.evaluate((r) => (window as unknown as W).__lodestone.connectZone(r), conn);
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return w.__lodestone.netDebug()?.phase === 'playing' && (w.__lodestoneMap?.towers().length ?? 0) > 0 && !!w.__lodestoneMounts?.actions();
  }, null, { polling: 250, timeout: 180000 });
  await page.evaluate(() => (window as unknown as W).__lodestone.setQuality('high'));
  await page.evaluate(() => (window as unknown as W).__lodestoneIntro?.volume(0));
  for (let k = 0; k < 8; k++) {
    await page.evaluate(() => (window as unknown as W).__lodestoneIntro?.skip());
    await sleep(150);
  }
  await page.keyboard.press('F3'); // the debug readout off
  return page;
}

async function main(): Promise<void> {
  fs.mkdirSync(out, { recursive: true });
  const ground = await loadWorldgenGround(fs.readFileSync(path.join(repoRoot, 'worldgen', 'pkg', 'worldgen.wasm')), SEED);
  const atlas = ground.atlas.data;
  const dry = (x: number, z: number) => ground.waterAt(x, z) < ground.heightAt(x, z) - 0.3 && ground.heightAt(x, z) > atlas.seaY + 1;
  const towns = atlas.sites.filter((s) => s.category === 'settlement').sort((a, b) => Math.hypot(a.x - atlas.spawn.x, a.z - atlas.spawn.z) - Math.hypot(b.x - atlas.spawn.x, b.z - atlas.spawn.z));
  // Open, gentle, dry ground outside a town with 90 m to gallop east (dir +x).
  let start: { x: number; z: number } | null = null;
  for (const town of towns.slice(0, 6)) {
    for (const r of [80, 110, 60, 140]) {
      for (let k = 0; k < 48 && !start; k++) {
        const a = (k / 48) * Math.PI * 2;
        const x = town.x + Math.cos(a) * (town.radius + r);
        const z = town.z + Math.sin(a) * (town.radius + r);
        let ok = true;
        let prev = ground.heightAt(x - 30, z);
        for (let d = -30; d <= 90 && ok; d += 2) {
          for (const dz of [-14, -6, 0, 6]) if (!dry(x + d, z + dz)) ok = false;
          const h = ground.heightAt(x + d, z);
          if (Math.abs(h - prev) > 0.8) ok = false; // under ~22 degrees every 2 m
          prev = h;
        }
        if (ok) start = { x, z };
      }
      if (start) break;
    }
    if (start) {
      note(`riding ground from ${start.x.toFixed(1)}, ${start.z.toFixed(1)} east, outside "${town.name}"`);
      break;
    }
  }
  if (!start) throw new Error('no open riding ground near the spawn');

  const zoneBin = buildZone();
  const zonePort = await randomPort();
  const zoneId = `zone-mounts-${zonePort}`;
  const worldId = `mounts-${Date.now()}`;
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
      LODESTONE_ZONE_NO_DEMONS: '1',
      LODESTONE_ZONE_NO_WILD_PACKS: '1',
      LODESTONE_ZONE_NO_WORLD_EVENTS: '1',
      LODESTONE_ZONE_TIME_OFFSET_S: String(offsetFor(15.5)), // a sunny afternoon
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const keep = (b: Buffer) => {
    for (const l of b.toString().split('\n')) if (l.trim()) zoneLog.push(l);
  };
  zone.stdout?.on('data', keep);
  zone.stderr?.on('data', keep);
  const vitePort = await randomPort();
  const vite = spawn(process.execPath, [path.join(path.dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin', 'vite.js'), '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], { cwd: path.join(repoRoot, 'client'), stdio: 'ignore' });
  let browser: Browser | null = null;
  const newest = (JSON.parse(fs.readFileSync(path.join(repoRoot, 'client', 'src', 'ui', 'whatsnew', 'changelog.json'), 'utf8')) as { id: string }[])[0]?.id ?? '';
  try {
    await waitHttp(`http://127.0.0.1:${zonePort}/healthz`, 120000);
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 90000);
    browser = await chromium.launch({ headless: true, args: gpuArgs });
    const url = `http://127.0.0.1:${vitePort}/?debug=1`;
    const ep = (x: number, z: number) => `ws://127.0.0.1:${zonePort}/ws?spawn=${x.toFixed(2)},${z.toFixed(2)}`;
    const rider = await joinPage(browser, url, newest, { ticket: devTicket({ characterId: `pt2-mounts-a-${Date.now()}`, characterName: 'Ash', worldId, zoneId }), zoneEndpoint: ep(start.x, start.z), zoneId, worldId, name: 'Ash' });
    const obsAt = { x: start.x + 74, z: start.z + 13 };
    const obs = await joinPage(browser, url, newest, { ticket: devTicket({ characterId: `pt2-mounts-b-${Date.now()}`, characterName: 'Birch', worldId, zoneId }), zoneEndpoint: ep(obsAt.x, obsAt.z), zoneId, worldId, name: 'Birch' });
    await sleep(2500);
    const M = (p: Page) => p.evaluate(() => (window as unknown as W).__lodestoneMounts!.state());
    const me = () => rider.evaluate(() => (window as unknown as W).__lodestone.player().pos);
    const EAST = -Math.PI / 2;

    // A whistle (dev grant), then whistle facing east: the steed comes from behind.
    await rider.evaluate(() => (window as unknown as W).__lodestoneMounts!.actions()!.dev());
    await sleep(1200);
    await rider.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.15), EAST);
    await sleep(400);
    await rider.keyboard.press('KeyT'); // third person
    await sleep(800);
    await rider.keyboard.press('Digit5');
    await sleep(250);
    let st = await M(rider);
    const mine = st.steeds[String(st.selfId)];
    note(`whistle: ${JSON.stringify(st.mine)}; steed ${mine ? `arriving from (${mine.fx.toFixed(1)}, ${mine.fz.toFixed(1)}) to (${mine.x.toFixed(1)}, ${mine.z.toFixed(1)})` : 'MISSING'}`);
    if (!mine) throw new Error('no steed answered the whistle');
    // Turn around to watch it come (the camera behind you looks at it).
    let at = await me();
    await rider.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.12), lookAt(at, { x: mine.fx, z: mine.fz }));
    await sleep(1400);
    await rider.screenshot({ path: shot('summon') });
    note('shot pt2-mounts-summon.png: the spirit steed galloping in after the whistle (key 5), third person');
    await sleep(2200);

    // Walk beside it, E: in the saddle.
    st = await M(rider);
    const s2 = st.steeds[String(st.selfId)];
    await rider.keyboard.down('KeyW');
    for (let k = 0; k < 60; k++) {
      at = await me();
      if (Math.hypot(s2.x - at.x, s2.z - at.z) < 1.6) break;
      await rider.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, 0), lookAt(at, s2));
      await sleep(70);
    }
    await rider.keyboard.up('KeyW');
    await sleep(300);
    await rider.keyboard.press('KeyE');
    await sleep(900);
    st = await M(rider);
    note(`mounted: ${st.mounted} (gait ${st.gait})`);
    if (!st.mounted) throw new Error('E did not mount');
    await rider.evaluate(() => {
      const a = (window as unknown as W).__lodestoneMounts!.actions()!;
      a.name('Misty');
      a.colour(1);
    });

    // Gallop east: W, a spur (gallop), another (the burst).
    await rider.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.18), EAST);
    await rider.keyboard.down('KeyW');
    await sleep(1300);
    await rider.keyboard.down('ShiftLeft');
    await sleep(160);
    await rider.keyboard.up('ShiftLeft');
    await sleep(1500);
    await rider.keyboard.down('ShiftLeft');
    await sleep(160);
    await rider.keyboard.up('ShiftLeft');
    await sleep(2800); // the region banner fades
    await rider.keyboard.down('ShiftLeft');
    await sleep(160);
    await rider.keyboard.up('ShiftLeft');
    await sleep(250);
    // Look off to the side for a moment: the steed in three-quarter view (it turns toward the look slowly at a gallop).
    await rider.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.2), EAST - 0.75);
    await sleep(90);
    st = await M(rider);
    note(`galloping: speed ${st.speed.toFixed(2)} m/s, gait ${['trot', 'walk', 'gallop'][st.gait]}, at (${st.pos.x.toFixed(1)}, ${st.pos.z.toFixed(1)})`);
    await rider.screenshot({ path: shot('gallop-third') });
    note('shot pt2-mounts-gallop-third.png: galloping in third person on a spur\'s burst (boom pulled back, FOV kick, spur pips under the crosshair)');
    await rider.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.18), EAST);

    // The observer (13 m south of the line) watches Ash go by.
    for (let k = 0; k < 40; k++) {
      const av = (await obs.evaluate(() => (window as unknown as W).__lodestoneAvatars?.() ?? [])).find((a) => a.steed);
      if (av) {
        const ob = await obs.evaluate(() => (window as unknown as W).__lodestone.player().pos);
        await obs.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.08), lookAt(ob, { x: av.x + 3, z: av.z }));
        if (av.x > obsAt.x - 6) {
          await sleep(60);
          await obs.screenshot({ path: shot('observer') });
          note(`shot pt2-mounts-observer.png: Birch's view of Ash riding past (remote avatar: steed gait ${av.steed}, heading ${av.heading.toFixed(2)}, at (${av.x.toFixed(1)}, ${av.z.toFixed(1)}))`);
          break;
        }
      }
      await sleep(80);
    }
    // First person in the saddle, still galloping.
    await rider.keyboard.press('KeyT');
    await rider.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.3), EAST);
    await sleep(700);
    await rider.screenshot({ path: shot('first') });
    st = await M(rider);
    note(`shot pt2-mounts-first.png: first person in the saddle at ${st.speed.toFixed(1)} m/s (the eye rides 0.95 m higher; the steed's neck and head below, the gallop's FOV kick)`);
    await rider.keyboard.up('KeyW');
    await sleep(2200);
    at = await me();

    // The steed panel (name and colour changed above).
    await rider.evaluate(() => (window as unknown as W).__lodestoneMounts!.panel(true));
    await sleep(700);
    await rider.screenshot({ path: shot('panel') });
    st = await M(rider);
    note(`shot pt2-mounts-panel.png: the steed panel: ${JSON.stringify(st.mine)}`);
    await rider.evaluate(() => (window as unknown as W).__lodestoneMounts!.panel(false));

    // E: off; the steed stands beside.
    await rider.keyboard.press('KeyE');
    await sleep(900);
    st = await M(rider);
    note(`after E: mounted ${st.mounted}; steed phase ${st.steeds[String(st.selfId)]?.phase}; notes ${JSON.stringify(st.notes)}`);
  } finally {
    await browser?.close().catch(() => {});
    vite.kill();
    zone.kill();
    const rel = zoneLog.filter((l) => /steed|mount|violation|error/i.test(l)).slice(0, 40);
    fs.writeFileSync(path.join(out, 'pt2-mounts-shots.txt'), [...lines, '', 'zone log (mounts):', ...rel].join('\n') + '\n');
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    fs.appendFileSync(path.join(out, 'pt2-mounts-shots.txt'), `ERROR ${e?.stack ?? e}\n`);
    process.exit(1);
  },
);
