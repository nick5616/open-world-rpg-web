// Playtest 1 (pt/ux) screenshots in headless Chromium: the real client from
// Vite against the real zone binary on the official world (seed 20261108,
// no DB/Redis, dev tickets, private random ports), on the GPU.
//
//   cd client && npx vite-node src/ui/quests/dev/pt-ux-shots.ts            # after (this branch)
//   cd client && npx vite-node src/ui/quests/dev/pt-ux-shots.ts --before   # main's client (extracted to ../.before/client)
//
// After: quest tracker / offer with location preview / map + compass
// markers / in-world beam / bounty notice with "Show on map" / journal /
// spell wheel selection / billboard health bars front + behind / the HUD
// bottom at 1280x720, 1920x1080 and 800x700. Before: the HUD bottom at the
// same sizes and the health bar from behind with main's client.
// Writes docs/evidence/pt-ux-*.png and pt-ux-shots[-before].txt.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright';
import { devTicket } from '../../../net/dev/devTicket';
import { buildZone, repoRoot, waitHttp } from '../../../sim/dev/traversalRun';
import { loadWorldgenGround } from '../../../sim/worldgenGround';

const BEFORE = process.argv.includes('--before');
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',');
const SEED = '20261108';
const out = path.join(repoRoot, 'docs', 'evidence');
const lines: string[] = [];
const note = (s: string) => {
  lines.push(s);
  console.log(s);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gpuArgs = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const shot = (name: string) => path.join(out, `pt-ux-${name}.png`);
const want = (k: string) => !ONLY || ONLY.includes(k);
const SIZES = [
  [1280, 720],
  [1920, 1080],
  [800, 700],
] as const;

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

interface Npc {
  index: number;
  name: string;
  role: string;
  x: number;
  z: number;
  yaw: number;
}
type W = Window & {
  __lodestone: {
    player(): { pos: { x: number; y: number; z: number } };
    setLook(yaw: number | null, pitch?: number): void;
    setQuality(q: string): void;
    connectZone(r: { ticket: string; zoneEndpoint: string; zoneId: string; worldId: string; name?: string }): void;
    netDebug(): { phase: string } | null;
  };
  __lodestoneMap?: { towers(): unknown[]; state(): { stats: { events: number } }; open(v?: boolean): void };
  __lodestoneTowns?: { settlements(): { index: number; name: string; x: number; z: number; radius: number }[]; npcs(si: number): Npc[]; props(si: number, kind: number): { id: string; x: number; y: number; z: number; yaw: number }[]; visibleNpcs(): { name: string; entityId: number | null; x: number; z: number }[]; closePanel(): void; panel(): unknown };
  __lodestoneQuests?: { state(): { log: { tracked: number; quests: { id: number; title: string; text: string; markers: { x: number; z: number; r?: number; label: string }[] }[] }; offer: unknown }; send(kind: number, id: string | number, action: number, arg?: number): void; journal(v?: boolean): void };
  __lodestoneCombat?: { runtime: { select(i: number): void; cycleSelection(d: 1 | -1): number; useSelected(): void } };
  __lodestoneDrawn?: () => { id: number; kind: number; x: number; y: number; z: number; yaw: number; name: string }[];
  __lodestoneIntro?: { volume(v?: number): number; skip(): void };
};
const lookAt = (from: { x: number; z: number }, to: { x: number; z: number }) => Math.atan2(-(to.x - from.x), -(to.z - from.z));

async function main(): Promise<void> {
  fs.mkdirSync(out, { recursive: true });
  const ground = await loadWorldgenGround(fs.readFileSync(path.join(repoRoot, 'worldgen', 'pkg', 'worldgen.wasm')), SEED);
  const atlas = ground.atlas.data;
  const dry = (x: number, z: number) => ground.waterAt(x, z) < ground.heightAt(x, z) - 0.3 && ground.heightAt(x, z) > atlas.seaY + 1;
  const town = atlas.sites.filter((s) => s.category === 'settlement').sort((a, b) => Math.hypot(a.x - atlas.spawn.x, a.z - atlas.spawn.z) - Math.hypot(b.x - atlas.spawn.x, b.z - atlas.spawn.z))[0];
  // A gentle dry spot 70 m outside the town for a debug camp (health bars).
  let camp = { x: town.x + town.radius + 70, z: town.z };
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    const x = town.x + Math.cos(a) * (town.radius + 70);
    const z = town.z + Math.sin(a) * (town.radius + 70);
    let flat = true;
    for (const [dx, dz] of [[-20, 0], [20, 0], [0, -20], [0, 20], [0, 0]]) {
      if (!dry(x + dx, z + dz) || Math.abs(ground.heightAt(x + dx, z + dz) - ground.heightAt(x, z)) > 3) flat = false;
    }
    if (flat) {
      camp = { x, z };
      break;
    }
  }
  note(`${BEFORE ? 'BEFORE (main client)' : 'AFTER (pt/ux)'}: town "${town.name}" (${town.x.toFixed(0)}, ${town.z.toFixed(0)}) r ${town.radius.toFixed(0)}; camp (${camp.x.toFixed(0)}, ${camp.z.toFixed(0)})`);

  const zoneBin = buildZone();
  const zonePort = await randomPort();
  const zoneId = `zone-ptux-${zonePort}`;
  const worldId = `ptux-${Date.now()}`;
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
      LODESTONE_ZONE_NO_ATLAS_ENEMIES: '1',
      LODESTONE_ZONE_TIME_OFFSET_S: String(noonOffset()),
      LODESTONE_ZONE_DEBUG_CAMP: `${camp.x.toFixed(1)},${camp.z.toFixed(1)},1,lurker lurker,shielded`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const keep = (b: Buffer) => {
    for (const l of b.toString().split('\n')) if (l.trim()) zoneLog.push(l);
  };
  zone.stdout?.on('data', keep);
  zone.stderr?.on('data', keep);
  const clientDir = BEFORE ? path.join(repoRoot, '.before', 'client') : path.join(repoRoot, 'client');
  const vitePort = await randomPort();
  const vite = spawn(process.execPath, [path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], { cwd: clientDir, stdio: 'ignore' });
  let browser: Browser | null = null;
  let n = 0;
  const pre = BEFORE ? 'before' : 'after';
  try {
    await waitHttp(`http://127.0.0.1:${zonePort}/healthz`, 120000);
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 90000);
    note(`zone :${zonePort}, vite :${vitePort} (${path.relative(repoRoot, clientDir)})`);
    browser = await chromium.launch({ headless: true, args: gpuArgs });

    async function join(at: { x: number; z: number }, label: string, viewport: { width: number; height: number } = { width: 1280, height: 720 }): Promise<Page> {
      const page = await browser!.newPage({ viewport, deviceScaleFactor: label.startsWith('View') ? 2 : 1 });
      page.on('pageerror', (e) => note(`  [${label}] pageerror: ${e.message}`));
      await page.goto(`http://127.0.0.1:${vitePort}/?debug=1`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => !!(window as unknown as W).__lodestone, null, { polling: 200, timeout: 60000 });
      const name = `${label}${++n}`;
      const ticket = devTicket({ characterId: `pt-ux-${pre}-${Date.now()}-${n}`, characterName: name, worldId, zoneId });
      await page.evaluate((r) => (window as unknown as W).__lodestone.connectZone(r), { ticket, zoneEndpoint: `ws://127.0.0.1:${zonePort}/ws?spawn=${at.x.toFixed(2)},${at.z.toFixed(2)}`, zoneId, worldId, name });
      await page.waitForFunction(() => {
        const w = window as unknown as W;
        return w.__lodestone.netDebug()?.phase === 'playing' && (w.__lodestoneMap?.towers().length ?? 0) > 0 && !!w.__lodestoneTowns && w.__lodestoneTowns.settlements().length > 0;
      }, null, { polling: 250, timeout: 180000 });
      await page.evaluate(() => (window as unknown as W).__lodestone.setQuality('high'));
      await page.keyboard.press('F3'); // hide the debug HUD
      await page.evaluate(() => (window as unknown as W).__lodestoneIntro?.volume(0));
      await sleep(1500);
      return page;
    }
    const towns = (p: Page) => p.evaluate(() => (window as unknown as W).__lodestoneTowns!);
    void towns;
    const si = async (p: Page) => p.evaluate((nm) => (window as unknown as W).__lodestoneTowns!.settlements().find((s) => s.name === nm)!.index, town.name);
    const npcsOf = async (p: Page) => p.evaluate((i) => (window as unknown as W).__lodestoneTowns!.npcs(i), await si(p));
    const entityOf = async (p: Page, name: string) => {
      for (let k = 0; k < 40; k++) {
        const id = await p.evaluate((nm) => (window as unknown as W).__lodestoneTowns!.visibleNpcs().find((v) => v.name === nm)?.entityId ?? null, name);
        if (id) return id;
        await sleep(250);
      }
      throw new Error(`no entity for ${name}`);
    };
    const quests = (p: Page) => p.evaluate(() => (window as unknown as W).__lodestoneQuests!.state());
    const send = (p: Page, kind: number, id: string | number, action: number, arg = 0) => p.evaluate(([k, i, a, g]) => (window as unknown as W).__lodestoneQuests!.send(k as number, i as string, a as number, g as number), [kind, String(id), action, arg] as const);
    /** Walk (W held, steering every 100 ms) to `to`; true when within 1.5 m. */
    const walkTo = async (p: Page, to: { x: number; z: number }, ms: number) => {
      const t0 = Date.now();
      await p.keyboard.down('KeyW');
      try {
        while (Date.now() - t0 < ms) {
          const at = await p.evaluate(() => (window as unknown as W).__lodestone.player().pos);
          if (Math.hypot(to.x - at.x, to.z - at.z) < 1.5) return true;
          await p.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, 0), lookAt(at, to));
          await sleep(100);
        }
        return false;
      } finally {
        await p.keyboard.up('KeyW');
      }
    };
    /** Zoom the open map n wheel notches around a world point. */
    const zoomMapAt = async (p: Page, x: number, z: number, notches: number) => {
      for (let k = 0; k < notches; k++) {
        const s = await p.evaluate(([wx, wz]) => (window as unknown as { __lodestoneMap: { mapScreenPos(x: number, z: number): { x: number; y: number } | null } }).__lodestoneMap.mapScreenPos(wx, wz), [x, z] as const);
        if (!s) return;
        await p.mouse.move(s.x, s.y);
        await p.mouse.wheel(0, -120);
        await sleep(120);
      }
      await sleep(500);
    };
    const skipIntros = async (p: Page) => {
      for (let k = 0; k < 6; k++) {
        await p.evaluate(() => (window as unknown as W).__lodestoneIntro?.skip());
        await sleep(150);
      }
    };

    // ---- the HUD bottom at three sizes (before and after) ----
    // In front of the blacksmith (the after-client shows the starter quest tracker).
    const probe = await join({ x: town.x, z: town.z }, 'Probe');
    const smith = (await npcsOf(probe)).find((x) => x.role === 'blacksmith')!;
    const board = (await probe.evaluate((i) => (window as unknown as W).__lodestoneTowns!.props(i, 15), await si(probe)))[0];
    const blds = await probe.evaluate((i) => (window as unknown as { __lodestoneTowns: { buildings(si: number): { x: number; z: number; frontX: number; frontZ: number }[] } }).__lodestoneTowns.buildings(i), await si(probe));
    await probe.close();
    const smithSpot = { x: smith.x - 2.0 * Math.cos(smith.yaw), z: smith.z - 2.0 * Math.sin(smith.yaw) };
    const boardSpot = { x: board.x + 3.5 * Math.cos(board.yaw), z: board.z + 3.5 * Math.sin(board.yaw) };
    note(`blacksmith ${smith.name} at (${smith.x.toFixed(1)}, ${smith.z.toFixed(1)}); board ${board.id} at (${board.x.toFixed(1)}, ${board.z.toFixed(1)})`);

    if (want('hud')) {
      const page = await join(boardSpot, 'Hud');
      await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.02), lookAt(boardSpot, town) + 0.6);
      await skipIntros(page);
      for (const [w, h] of SIZES) {
        await page.setViewportSize({ width: w, height: h });
        await sleep(1200);
        await page.screenshot({ path: shot(`hud-${pre}-${w}x${h}`) });
        note(`shot pt-ux-hud-${pre}-${w}x${h}.png`);
      }
      await page.close();
    }

    if (want('bars')) {
      // Two players at the camp: Front draws the enemies onto itself (closest),
      // Behind stands on the far side, so it sees their backs.
      // Calm version: one idle camp (lurkers: 14 m aggro) seen from four sides
      // at 17 m, so nothing moves and the enemies keep one yaw; at least one
      // view is from behind. Crisp crops (2x device pixels).
      const scout = await join({ x: camp.x - 40, z: camp.z }, 'Scout');
      await sleep(1500);
      const found = await scout.evaluate(() => (window as unknown as W).__lodestoneDrawn!().filter((v) => v.kind === 2));
      await scout.close();
      const target = found.find((e) => e.name) ?? found[0];
      note(`calm camp: ${found.map((e) => `${e.name || '#' + e.id} (${e.x.toFixed(1)}, ${e.z.toFixed(1)}) yaw ${e.yaw.toFixed(2)}`).join(', ')}`);
      if (target) {
        for (const [side, dx, dz] of [['west', -1, 0], ['east', 1, 0], ['north', 0, -1], ['south', 0, 1]] as const) {
          const at = { x: target.x + dx * 17, z: target.z + dz * 17 };
          const page = await join(at, `View${side}`, { width: 1280, height: 720 });
          await skipIntros(page);
          const me = await page.evaluate(() => (window as unknown as W).__lodestone.player().pos);
          await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.06), lookAt(me, target));
          await sleep(700);
          const now = await page.evaluate((id) => (window as unknown as W).__lodestoneDrawn!().find((v) => v.id === id) ?? null, target.id);
          const fx = now ? -Math.sin(now.yaw) : 0;
          const fz = now ? -Math.cos(now.yaw) : 0;
          const facing = now ? (fx * (me.x - now.x) + fz * (me.z - now.z)) / Math.hypot(me.x - now.x, me.z - now.z) : NaN;
          await page.screenshot({ path: shot(`healthbars-${pre}-${side}`), clip: { x: 400, y: 160, width: 480, height: 270 } });
          note(`shot pt-ux-healthbars-${pre}-${side}.png: ${target.name || '#' + target.id} from the ${side} at ${Math.hypot(me.x - target.x, me.z - target.z).toFixed(1)} m, facing the viewer ${facing.toFixed(2)} (negative = its back)`);
          await page.close();
        }
      }
    }

    if (want('bars-live')) {
      // The zone places the camp on walkable ground near the requested spot:
      // the first player finds it, the second is dropped 5 m past it.
      const front = await join({ x: camp.x - 6, z: camp.z }, 'Front');
      await skipIntros(front);
      const seen = await front.evaluate(() => (window as unknown as W).__lodestoneDrawn!().filter((v) => v.kind === 2));
      const c0 = seen.length ? { x: seen.reduce((a, e) => a + e.x, 0) / seen.length, z: seen.reduce((a, e) => a + e.z, 0) / seen.length } : camp;
      const behind = await join({ x: c0.x + 5, z: c0.z }, 'Behind');
      await skipIntros(front);
      await skipIntros(behind);
      await sleep(500);
      const enemies = await behind.evaluate(() => (window as unknown as W).__lodestoneDrawn!().filter((v) => v.kind === 2));
      note(`camp: ${enemies.length} enemies drawn: ${enemies.map((e) => `${e.name || '#' + e.id} (${e.x.toFixed(0)}, ${e.z.toFixed(0)}) yaw ${e.yaw.toFixed(2)}`).join(', ')}`);
      if (enemies.length) {
        const c = { x: enemies.reduce((a, e) => a + e.x, 0) / enemies.length, z: enemies.reduce((a, e) => a + e.z, 0) / enemies.length };
        const bp = await behind.evaluate(() => (window as unknown as W).__lodestone.player().pos);
        const fp = await front.evaluate(() => (window as unknown as W).__lodestone.player().pos);
        await behind.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.08), lookAt(bp, c));
        await front.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.08), lookAt(fp, c));
        await sleep(400);
        const e2 = await behind.evaluate(() => (window as unknown as W).__lodestoneDrawn!().filter((v) => v.kind === 2));
        // Facing: the enemy's forward (camera convention: (-sin yaw, -cos yaw)) against the direction to the viewer.
        for (const e of e2) {
          const fx = -Math.sin(e.yaw);
          const fz = -Math.cos(e.yaw);
          const dot = (fx * (bp.x - e.x) + fz * (bp.z - e.z)) / Math.hypot(bp.x - e.x, bp.z - e.z);
          note(`  ${e.name || '#' + e.id}: facing the Behind player ${dot.toFixed(2)} (negative = its back is to them)`);
        }
        // The same enemies from opposite sides (180 degrees apart).
        const clip = { x: 320, y: 140, width: 640, height: 360 };
        await behind.screenshot({ path: shot(`healthbars-${pre}-east`) });
        await behind.screenshot({ path: shot(`healthbars-${pre}-east-crop`), clip });
        note(`shot pt-ux-healthbars-${pre}-east.png (+ -crop; looking west at the camp)`);
        await front.screenshot({ path: shot(`healthbars-${pre}-west`) });
        await front.screenshot({ path: shot(`healthbars-${pre}-west-crop`), clip });
        note(`shot pt-ux-healthbars-${pre}-west.png (+ -crop; looking east at the camp)`);
      }
      await front.close();
      await behind.close();
    }

    if (BEFORE) return;

    // ---- quests: the starter quest, an offer with its location preview, markers ----
    if (want('quests')) {
      const page = await join(smithSpot, 'Questor');
      await page.waitForFunction(() => ((window as unknown as W).__lodestoneQuests?.state().log.quests.length ?? 0) > 0, null, { polling: 200, timeout: 20000 });
      let q = await quests(page);
      note(`quest log at login: ${q.log.quests.map((x) => `"${x.title}": ${x.text}`).join('; ')}`);
      await skipIntros(page);
      await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.05), lookAt(smithSpot, smith));
      await sleep(600);
      await page.screenshot({ path: shot('quest-tracker') });
      note('shot pt-ux-quest-tracker.png');
      // Drop the starter quest, then the blacksmith offers it with a preview.
      await send(page, 60, 0x57415244, 2);
      await sleep(500);
      const smithEnt = await entityOf(page, smith.name);
      await send(page, 30, smithEnt, 1);
      await page.waitForFunction(() => !!(window as unknown as W).__lodestoneQuests!.state().offer, null, { polling: 100, timeout: 8000 });
      await page.evaluate(() => (window as unknown as W).__lodestoneTowns!.closePanel());
      await sleep(500);
      await page.screenshot({ path: shot('quest-offer') });
      note('shot pt-ux-quest-offer.png (offer: steps with distance/direction, minimap)');
      await page.click('[data-testid="quest-offer-map"]');
      await sleep(1200);
      await page.screenshot({ path: shot('quest-offer-map') });
      note('shot pt-ux-quest-offer-map.png (the full map framed on the preview)');
      await page.keyboard.press('KeyM');
      await sleep(300);
      await page.click('[data-testid="quest-offer-accept"]');
      await page.waitForFunction(() => ((window as unknown as W).__lodestoneQuests?.state().log.quests.length ?? 0) > 0, null, { polling: 100, timeout: 8000 });
      // Talk again: step 1 completes; the ore seam and the cave mouth are marked.
      await send(page, 30, smithEnt, 1);
      await page.waitForFunction(() => (window as unknown as W).__lodestoneQuests!.state().log.quests[0]?.markers.some((m) => (m.r ?? 0) > 0), null, { polling: 100, timeout: 8000 });
      await page.evaluate(() => (window as unknown as W).__lodestoneTowns!.closePanel());
      q = await quests(page);
      const ward = q.log.quests[0];
      note(`after talking: "${ward.text}", markers ${JSON.stringify(ward.markers)}`);
      await sleep(400);
      await page.screenshot({ path: shot('quest-step') });
      note('shot pt-ux-quest-step.png (the smith\'s line, step note, tracker)');
      await page.evaluate(() => (window as unknown as W).__lodestoneMap!.open(true));
      await sleep(800);
      await zoomMapAt(page, (ward.markers[0].x + smith.x) / 2, (ward.markers[0].z + smith.z) / 2, 6);
      await page.screenshot({ path: shot('quest-map') });
      note('shot pt-ux-quest-map.png (quest markers on the map, zoomed in)');
      await page.evaluate(() => (window as unknown as W).__lodestoneMap!.open(false));
      // Out of the forge into the street, then face the seam: compass marker + in-world beam.
      const forge = blds.slice().sort((a, b) => Math.hypot(a.x - smith.x, a.z - smith.z) - Math.hypot(b.x - smith.x, b.z - smith.z))[0];
      const fl = Math.hypot(forge.frontX - forge.x, forge.frontZ - forge.z) || 1;
      const door = { x: forge.frontX, z: forge.frontZ };
      const street = { x: forge.frontX + ((forge.frontX - forge.x) / fl) * 5, z: forge.frontZ + ((forge.frontZ - forge.z) / fl) * 5 };
      note(`walk out: door (${door.x.toFixed(1)}, ${door.z.toFixed(1)}) -> ${await walkTo(page, door, 8000)}, street -> ${await walkTo(page, street, 6000)}, square -> ${await walkTo(page, { x: town.x, z: town.z }, 12000)}`);
      const me = await page.evaluate(() => (window as unknown as W).__lodestone.player().pos);
      await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, 0.12), lookAt(me, ward.markers[0]) + 0.25);
      await sleep(1500);
      await page.screenshot({ path: shot('quest-compass') });
      note('shot pt-ux-quest-compass.png (compass diamond + distance, beam over the seam)');

      // ---- spell wheel ----
      await page.evaluate(() => (window as unknown as W).__lodestone.setLook(1.2, 0.02));
      const canvas = await page.$('canvas');
      const box = await canvas!.boundingBox();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.mouse.wheel(0, 120);
      await sleep(150);
      await page.mouse.wheel(0, 120);
      await sleep(400);
      const sel = await page.evaluate(() => (document.querySelector('[data-selected="true"]') as HTMLElement | null)?.dataset.testid ?? null);
      note(`spell wheel: two notches down -> ${sel}`);
      await page.screenshot({ path: shot('spell-wheel') });
      note('shot pt-ux-spell-wheel.png (the selected slot raised with an RMB badge)');
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, { button: 'right' });
      await sleep(220);
      await page.screenshot({ path: shot('spell-wheel-cast') });
      note('shot pt-ux-spell-wheel-cast.png (right click casts the selected spell)');
      await page.close();
    }

    if (want('bounty')) {
      const spot = { x: board.x + 2.4 * Math.cos(board.yaw), z: board.z + 2.4 * Math.sin(board.yaw) };
      const page = await join(spot, 'Hunter');
      await skipIntros(page);
      await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.1), lookAt(spot, board));
      // E on the board, as a player would (the panel remembers which board accepts go to).
      await sleep(600);
      const tgt = await page.evaluate(() => (window as unknown as { __lodestoneTowns: { target(): { kind: string } | null } }).__lodestoneTowns.target());
      note(`board target: ${JSON.stringify(tgt)}`);
      if (tgt?.kind === 'board') await page.keyboard.press('KeyE');
      else await send(page, 31, board.id, 1);
      await page.waitForSelector('[data-testid="bounty-where"]', { timeout: 8000 });
      await sleep(400);
      await page.screenshot({ path: shot('bounty-offer') });
      note('shot pt-ux-bounty-offer.png (each notice: where it takes you + Show on map)');
      const btn = await page.$('[data-testid="town-panel"] button[data-act="preview"]');
      await btn!.click();
      await sleep(1200);
      await page.screenshot({ path: shot('bounty-preview-map') });
      note('shot pt-ux-bounty-preview-map.png (the job\'s area on the map before accepting)');
      await page.keyboard.press('KeyM');
      for (let k = 0; k < 2; k++) {
        await page.click(`[data-testid="town-panel"] button[data-act="accept"]`); // re-queried: the panel re-renders after each accept
        await sleep(400);
      }
      await page.evaluate(() => (window as unknown as W).__lodestoneTowns!.closePanel());
      await page.evaluate(() => (window as unknown as W).__lodestoneQuests!.journal(true));
      await sleep(600);
      await page.screenshot({ path: shot('quest-journal') });
      note('shot pt-ux-quest-journal.png (J)');
      await page.evaluate(() => (window as unknown as W).__lodestoneQuests!.journal(false));
      await page.evaluate(() => (window as unknown as W).__lodestoneMap!.open(true));
      await sleep(800);
      await zoomMapAt(page, town.x, town.z, 4);
      await page.screenshot({ path: shot('quest-map-bounties') });
      note('shot pt-ux-quest-map-bounties.png (accepted bounties and the tracked quest on the map)');
      await page.close();
    }
  } finally {
    await browser?.close().catch(() => {});
    vite.kill();
    zone.kill();
    const quest = zoneLog.filter((l) => /quest|ward places|bounty/.test(l)).slice(0, 40);
    fs.writeFileSync(path.join(out, `pt-ux-shots${BEFORE ? '-before' : ''}.txt`), [...lines, '', 'zone log (quests):', ...quest].join('\n') + '\n');
  }
}

/** World clock offset that makes it about 10:00 (daylight, shops open). */
function noonOffset(): number {
  const day = 3600;
  const now = Date.now() / 1000;
  return (10 / 24) * day - (now % day);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    fs.writeFileSync(path.join(out, `pt-ux-shots${BEFORE ? '-before' : ''}.txt`), [...lines, `ERROR ${e?.stack ?? e}`].join('\n') + '\n');
    process.exit(1);
  },
);
