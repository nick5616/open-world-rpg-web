// Playtest 2 camps (CR 025) screenshots in headless Chromium: the real
// client from Vite against the real zone binary on the official world
// (seed 20261108, no DB/Redis, a dev ticket, private random ports, the
// world clock at dusk): the placement ghost green and red, the camp menu, a
// finished camp at dusk with its fire burning (first and third person),
// Rested by the fire, and the storage chest.
//
//   cd client && npx vite-node src/ui/camps/dev/camp-shots.ts
//
// One zone, one Vite, one browser, one page. Writes docs/evidence/pt2-camps-*.png
// and pt2-camps-shots.txt. Every process it starts is stopped at the end.

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
const shot = (name: string) => path.join(out, `pt2-camps-${name}.png`);

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

type Piece = { id: number; kind: number; x: number; y: number; z: number; mine: boolean; burning: boolean; label: string };
type W = Window & {
  __lodestone: {
    player(): { pos: { x: number; y: number; z: number } };
    setLook(yaw: number | null, pitch?: number): void;
    setQuality(q: string): void;
    connectZone(r: { ticket: string; zoneEndpoint: string; zoneId: string; worldId: string; name?: string }): void;
    netDebug(): { phase: string } | null;
  };
  __lodestoneMap?: { towers(): unknown[] };
  __lodestoneIntro?: { volume(v?: number): number; skip(): void };
  __lodestoneCamps?: {
    state(): { pieces: Record<string, Piece>; chest: { slots: unknown[] } | null; rested: unknown; mine: { pieces: unknown[] }; actions: boolean };
    ghost(): { active: boolean; kind: number; rot: number; x: number; y: number; z: number; reason: number };
    startPlacing(kind: number, rot?: number, dist?: number): void;
    stopPlacing(): void;
    confirm(): boolean;
    place(kind: number, rot: number, x: number, z: number): void;
    use(id: number): void;
    fuel(id: number, n?: number): void;
    put(piece: number, handle: number, qty?: number): void;
    label(piece: number, text: string): void;
    menu(open?: boolean): void;
    dev(): void;
    kinds(): Record<string, number>;
  };
  __lodestoneInventory?: unknown;
};
const lookAt = (from: { x: number; z: number }, to: { x: number; z: number }) => Math.atan2(-(to.x - from.x), -(to.z - from.z));

/** World clock offset that makes it `hour` o'clock now (one in-game day is 3600 s). */
function offsetFor(hour: number): number {
  const day = 3600;
  const now = Date.now() / 1000;
  return (hour / 24) * day - (now % day);
}

async function main(): Promise<void> {
  fs.mkdirSync(out, { recursive: true });
  const ground = await loadWorldgenGround(fs.readFileSync(path.join(repoRoot, 'worldgen', 'pkg', 'worldgen.wasm')), SEED);
  const atlas = ground.atlas.data;
  const dry = (x: number, z: number) => ground.waterAt(x, z) < ground.heightAt(x, z) - 0.3 && ground.heightAt(x, z) > atlas.seaY + 1;
  const towns = atlas.sites.filter((s) => s.category === 'settlement').sort((a, b) => Math.hypot(a.x - atlas.spawn.x, a.z - atlas.spawn.z) - Math.hypot(b.x - atlas.spawn.x, b.z - atlas.spawn.z));
  // Gentle dry ground 80-120 m outside a town near the spawn: flat over 14 m.
  let camp: { x: number; z: number } | null = null;
  for (const town of towns.slice(0, 4)) {
    for (const r of [90, 120, 70]) {
      for (let k = 0; k < 48 && !camp; k++) {
        const a = (k / 48) * Math.PI * 2;
        const x = town.x + Math.cos(a) * (town.radius + r);
        const z = town.z + Math.sin(a) * (town.radius + r);
        const h0 = ground.heightAt(x, z);
        let flat = true;
        for (let dx = -8; dx <= 8; dx += 2) for (let dz = -8; dz <= 8; dz += 2) if (!dry(x + dx, z + dz) || Math.abs(ground.heightAt(x + dx, z + dz) - h0) > 0.9) flat = false;
        if (flat) camp = { x, z };
      }
      if (camp) break;
    }
    if (camp) {
      note(`camp ground ${camp.x.toFixed(1)}, ${camp.z.toFixed(1)} outside "${town.name}"`);
      break;
    }
  }
  if (!camp) throw new Error('no flat camp ground near the spawn');

  const zoneBin = buildZone();
  const zonePort = await randomPort();
  const zoneId = `zone-camps-${zonePort}`;
  const worldId = `camps-${Date.now()}`;
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
      LODESTONE_ZONE_TIME_OFFSET_S: String(offsetFor(18.75)), // dusk
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
    const page: Page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => note(`  pageerror: ${e.message}`));
    await page.addInitScript((id) => {
      localStorage.setItem('lodestone_tips_enabled', '0');
      localStorage.setItem('lodestone_whatsnew_seen', id);
    }, newest);
    await page.goto(`http://127.0.0.1:${vitePort}/?debug=1`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!(window as unknown as W).__lodestone, null, { polling: 200, timeout: 60000 });
    const ticket = devTicket({ characterId: `pt2-camps-${Date.now()}`, characterName: 'Wren', worldId, zoneId });
    const start = { x: camp.x - 3, z: camp.z + 3 };
    await page.evaluate((r) => (window as unknown as W).__lodestone.connectZone(r), { ticket, zoneEndpoint: `ws://127.0.0.1:${zonePort}/ws?spawn=${start.x.toFixed(2)},${start.z.toFixed(2)}`, zoneId, worldId, name: 'Wren' });
    await page.waitForFunction(() => {
      const w = window as unknown as W;
      return w.__lodestone.netDebug()?.phase === 'playing' && (w.__lodestoneMap?.towers().length ?? 0) > 0 && !!w.__lodestoneCamps?.state().actions;
    }, null, { polling: 250, timeout: 180000 });
    await page.evaluate(() => (window as unknown as W).__lodestone.setQuality('high'));
    await page.evaluate(() => (window as unknown as W).__lodestoneIntro?.volume(0));
    for (let k = 0; k < 8; k++) {
      await page.evaluate(() => (window as unknown as W).__lodestoneIntro?.skip());
      await sleep(200);
    }
    await page.keyboard.press('F3'); // the debug readout off
    await sleep(2500);
    const C = () => page.evaluate(() => (window as unknown as W).__lodestoneCamps!.state());
    const me = () => page.evaluate(() => (window as unknown as W).__lodestone.player().pos);
    const K = await page.evaluate(() => (window as unknown as W).__lodestoneCamps!.kinds());
    await page.evaluate(() => (window as unknown as W).__lodestoneCamps!.dev());
    await sleep(1200);

    // The camp menu.
    await page.evaluate(() => (window as unknown as W).__lodestoneCamps!.menu(true));
    await sleep(900);
    await page.screenshot({ path: shot('menu') });
    note('shot pt2-camps-menu.png: the camp menu (P) with every piece, its kit recipe and the kits in the pack');
    await page.evaluate(() => (window as unknown as W).__lodestoneCamps!.menu(false));

    // 1. The ghost, valid: a campfire on the open ground ahead.
    let at = await me();
    await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.42), lookAt(at, camp));
    await sleep(400);
    await page.evaluate((k) => (window as unknown as W).__lodestoneCamps!.startPlacing(k, undefined, Math.hypot(3, 3)), K.campfire);
    await sleep(900);
    let g = await page.evaluate(() => (window as unknown as W).__lodestoneCamps!.ghost());
    note(`ghost (campfire): (${g.x.toFixed(2)}, ${g.y.toFixed(2)}, ${g.z.toFixed(2)}) rot ${g.rot} reason ${g.reason}`);
    await page.screenshot({ path: shot('ghost-valid') });
    note('shot pt2-camps-ghost-valid.png: the campfire ghost, green, with its footprint and the safe circle demons keep out of');
    const fireAt = { x: g.x, z: g.z };
    const placed = await page.evaluate(() => (window as unknown as W).__lodestoneCamps!.confirm());
    await sleep(1200);
    const fire = Object.values((await C()).pieces).find((p) => p.kind === K.campfire && p.mine);
    note(`placed: ${placed}; campfire ${fire ? `#${fire.id} burning ${fire.burning}` : 'MISSING'}`);
    if (!fire) throw new Error('the campfire was not placed');

    // 2. The ghost, invalid: a workbench into the fire.
    await page.evaluate((k) => (window as unknown as W).__lodestoneCamps!.startPlacing(k, 0, Math.hypot(3, 3)), K.workbench);
    await sleep(900);
    g = await page.evaluate(() => (window as unknown as W).__lodestoneCamps!.ghost());
    note(`ghost (workbench into the fire): reason ${g.reason}`);
    await page.screenshot({ path: shot('ghost-invalid') });
    note('shot pt2-camps-ghost-invalid.png: the workbench ghost red over the campfire ("Something is in the way")');
    await page.evaluate(() => (window as unknown as W).__lodestoneCamps!.stopPlacing());

    // 3. The rest of the camp around the fire (the zone checks every rule).
    const layout: [string, number, number, number][] = [
      ['bedroll', 3.4, 0.6, 2],
      ['chest', -2.6, -1.2, 6],
      ['workbench', -0.4, -3.4, 0],
      ['signpost', 2.8, 3.4, 7],
    ];
    for (const [key, dx, dz, rot] of layout) {
      at = await me();
      await page.evaluate(([k, r, x, z]) => (window as unknown as W).__lodestoneCamps!.place(k, r, x, z), [K[key], rot, fireAt.x + dx, fireAt.z + dz] as const);
      await sleep(700);
    }
    await sleep(800);
    let st = await C();
    const mine = Object.values(st.pieces).filter((p) => p.mine);
    note(`camp: ${mine.map((p) => Object.keys(K).find((k) => K[k] === p.kind)).join(', ')}`);
    const sign = mine.find((p) => p.kind === K.signpost);
    if (sign) await page.evaluate((id) => (window as unknown as W).__lodestoneCamps!.label(id, 'Ember Hollow'), sign.id);
    await page.evaluate((id) => (window as unknown as W).__lodestoneCamps!.fuel(id, 3), fire.id);
    await sleep(1200);

    // 4. The finished camp at dusk: step back and look at it (first person), then third person.
    at = await me();
    const view = { x: fireAt.x + 5.5, z: fireAt.z + 4.5 };
    await page.keyboard.down('KeyW');
    for (let k = 0; k < 60; k++) {
      at = await me();
      if (Math.hypot(view.x - at.x, view.z - at.z) < 1) break;
      await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, 0), lookAt(at, view));
      await sleep(80);
    }
    await page.keyboard.up('KeyW');
    await sleep(500);
    at = await me();
    await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y + 0.12, -0.3), lookAt(at, fireAt));
    await sleep(2000);
    await page.screenshot({ path: shot('dusk') });
    note(`shot pt2-camps-dusk.png: the camp at dusk from (${at.x.toFixed(1)}, ${at.z.toFixed(1)}): the fire burning, its light on the pieces, "Ember Hollow" on the signpost`);
    await page.keyboard.press('KeyT');
    await sleep(1500);
    await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.25), lookAt(at, fireAt));
    await sleep(1200);
    await page.screenshot({ path: shot('dusk-third') });
    note('shot pt2-camps-dusk-third.png: the same in third person');
    await page.keyboard.press('KeyT');
    await sleep(800);

    // 5. Rest in the bedroll by the fire: Rested.
    const bed = mine.find((p) => p.kind === K.bedroll);
    if (bed) {
      await page.keyboard.down('KeyW');
      for (let k = 0; k < 60; k++) {
        at = await me();
        if (Math.hypot(bed.x - 1.4 - at.x, bed.z - at.z) < 0.8) break;
        await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, 0), lookAt(at, { x: bed.x - 1.4, z: bed.z }));
        await sleep(80);
      }
      await page.keyboard.up('KeyW');
      await page.evaluate((id) => (window as unknown as W).__lodestoneCamps!.use(id), bed.id);
      await sleep(1500);
      at = await me();
      await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.3), lookAt(at, fireAt));
      await sleep(800);
      st = await C();
      note(`rested: ${JSON.stringify(st.rested)}`);
      await page.screenshot({ path: shot('rested') });
      note('shot pt2-camps-rested.png: Rested (badge), safe by the fire at night');
    }

    // 6. The storage chest: firewood and a draught stored.
    const chest = mine.find((p) => p.kind === K.chest);
    if (chest) {
      await page.keyboard.down('KeyW');
      for (let k = 0; k < 60; k++) {
        at = await me();
        if (Math.hypot(chest.x - at.x, chest.z - at.z) < 2) break;
        await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, 0), lookAt(at, chest));
        await sleep(80);
      }
      await page.keyboard.up('KeyW');
      await page.evaluate((id) => (window as unknown as W).__lodestoneCamps!.use(id), chest.id);
      await sleep(900);
      for (const sel of ['[data-testid="camp-pack-wood:firewood"]', '[data-testid="camp-pack-potion:health"]', '[data-testid="camp-pack-hide:wolf"]']) {
        await page.click(sel).catch(() => {});
        await sleep(600);
      }
      st = await C();
      note(`chest: ${(st.chest?.slots ?? []).filter(Boolean).length} slots used`);
      await page.screenshot({ path: shot('storage') });
      note('shot pt2-camps-storage.png: the storage chest panel (16 slots, the pack below, share with party)');
    }
  } finally {
    await browser?.close().catch(() => {});
    vite.kill();
    zone.kill();
    const rel = zoneLog.filter((l) => /camp|rested|craft/.test(l)).slice(0, 60);
    fs.writeFileSync(path.join(out, 'pt2-camps-shots.txt'), [...lines, '', 'zone log (camps):', ...rel].join('\n') + '\n');
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    fs.appendFileSync(path.join(out, 'pt2-camps-shots.txt'), `ERROR ${e?.stack ?? e}\n`);
    process.exit(1);
  },
);
