// WP10 headless browser run: the real game client (Vite dev server, headless
// Chromium, real keyboard events, WP05's streamed terrain, WP12's towers)
// connected straight to the real zone binary on the generated official world. For each traversal it logs per-mode prediction vs server
// divergence from inside the game loop (window.__lodestone.probe) and takes
// screenshots with the debug HUD and stamina wheel. A Node client climbs next
// to an observing browser player to capture the remote climbing pose.
//
//   npm run traversal:browser -w client      (needs Go, `npm run build:wasm`, Playwright Chromium)
//
// Writes docs/evidence/wp10-browser.{txt,json} and wp10-browser-*.png.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { devTicket } from '../../net/dev/devTicket';
import { UpdraftColumns } from '../updraft';
import { loadWorldgenGround } from '../worldgenGround';
import { buildZone, formatRun, freePort, repoRoot, runTimeline, startZone, waitHttp, zoneGround, type ZoneProc } from './traversalRun';

const SEED = '20261108';
const updraftSpec = '1122,2268,15,385,6';
const out = path.join(repoRoot, 'docs', 'evidence');
const log: string[] = [];
const note = (s: string) => {
  log.push(s);
  console.log(s);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface LodestoneHandle {
  player(): { pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number }; mode: string; stamina: number; exhausted: boolean; seq: number; airJumps: number };
  setLook(yaw: number | null, pitch?: number): void;
  setQuality(q: string): void;
  setFreezeTime(v: boolean): void;
  setTimeOfDay(s: number): void;
  connectZone(r: { ticket: string; zoneEndpoint: string; zoneId: string; worldId: string; name?: string }): void;
  probe(): { snapshots: number; maxDivM: number; perMode: Record<string, { snapshots: number; maxDivM: number; maxY: number | null; minY: number | null }>; transitions: string[] } | null;
  netDebug(): { phase: string; prediction: { reconciles: number; agreements: number; maxError: number }; remotes: { x: number; y: number; z: number; name: string }[] } | null;
}
type W = Window & { __lodestone: LodestoneHandle };

async function startVite(port: number): Promise<ChildProcess> {
  const vite = spawn(process.execPath, [path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: path.join(repoRoot, 'client'),
    stdio: 'ignore',
  });
  await waitHttp(`http://127.0.0.1:${port}/`, 60000);
  return vite;
}

async function openGame(clientPort: number, zone: ZoneProc, name: string, at: { x: number; z: number }, yaw: number, pitch: number): Promise<Page> {
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => note(`  [${name}] pageerror: ${e.message}`));
  await page.goto(`http://127.0.0.1:${clientPort}/?debug=1&rain=0&updraft=${updraftSpec}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!(window as unknown as W).__lodestone, null, { polling: 200, timeout: 30000 });
  const ticket = devTicket({ characterId: `wp10-browser-${name}-${Date.now()}`, characterName: `Browser${name.replace(/[^a-z]/gi, '')}`.slice(0, 16), worldId: zone.worldId, zoneId: zone.zoneId });
  await page.evaluate(
    (r) => (window as unknown as W).__lodestone.connectZone(r),
    { ticket, zoneEndpoint: `ws://127.0.0.1:${zone.port}/ws?spawn=${at.x.toFixed(2)},${at.z.toFixed(2)}`, zoneId: zone.zoneId, worldId: zone.worldId, name: `Browser${name.replace(/[^a-z]/gi, '')}`.slice(0, 16) },
  );
  // Playing, on the generated ground (y well above the flat placeholder's 0).
  await page.waitForFunction(() => (window as unknown as W).__lodestone.netDebug()?.phase === 'playing' && (window as unknown as W).__lodestone.player().pos.y > 50, null, { polling: 250, timeout: 60000 });
  await page.evaluate(
    ([y, p]) => {
      const l = (window as unknown as W).__lodestone;
      l.setQuality('low');
      l.setFreezeTime(true);
      l.setTimeOfDay(0.45 * 3600);
      l.setLook(y, p);
      l.probe();
    },
    [yaw, pitch],
  );
  await sleep(1200);
  return page;
}

async function shot(page: Page, name: string): Promise<void> {
  const p = await page.evaluate(() => (window as unknown as W).__lodestone.player());
  await page.screenshot({ path: path.join(out, `wp10-browser-${name}.png`) });
  note(`  screenshot wp10-browser-${name}.png: mode ${p.mode}, pos (${p.pos.x.toFixed(2)}, ${p.pos.y.toFixed(2)}, ${p.pos.z.toFixed(2)}), stamina ${p.stamina.toFixed(1)}${p.exhausted ? ' EXHAUSTED' : ''}`);
}

async function finish(page: Page, name: string, results: Record<string, unknown>): Promise<number> {
  await sleep(800);
  const probe = await page.evaluate(() => (window as unknown as W).__lodestone.probe());
  const nd = await page.evaluate(() => (window as unknown as W).__lodestone.netDebug());
  results[name] = { probe, prediction: nd?.prediction ? { reconciles: nd.prediction.reconciles, agreements: nd.prediction.agreements, maxError: nd.prediction.maxError } : null };
  const modes = Object.entries(probe?.perMode ?? {})
    .map(([m, s]) => `${m} ${s.snapshots} snaps max ${(s.maxDivM * 100).toFixed(2)} cm (y ${s.minY?.toFixed(1)}..${s.maxY?.toFixed(1)})`)
    .join('; ');
  note(`  ${name}: ${probe?.snapshots} compared snapshots, max divergence ${((probe?.maxDivM ?? 0) * 100).toFixed(2)} cm; ${modes}`);
  note(`  corrections ${nd?.prediction.reconciles} (max ${((nd?.prediction.maxError ?? 0) * 100).toFixed(2)} cm), agreements ${nd?.prediction.agreements}`);
  for (const t of probe?.transitions ?? []) note(`    ${t}`);
  await page.context().browser()?.close();
  return probe?.maxDivM ?? Infinity;
}

type Pred = (arg: number) => boolean;

/**
 * SwiftShader runs the real client at a few fps, and the 60 Hz sim is capped
 * at 8 steps per rendered frame, so game time runs slower than wall time.
 * Everything below therefore waits on the game's own state (steps, modes),
 * never on wall-clock sleeps.
 */
async function until(page: Page, fn: Pred, arg = 0, timeout = 240000): Promise<void> {
  await page.waitForFunction(fn, arg, { polling: 50, timeout });
}
async function steps(page: Page, n: number): Promise<void> {
  const s0 = await page.evaluate(() => (window as unknown as W).__lodestone.player().seq);
  await until(page, (target) => (window as unknown as W).__lodestone.player().seq >= target, s0 + n);
}
/** Hold a key until the game state shows it took effect (keys are sampled per rendered frame). */
async function pressUntil(page: Page, k: string, fn: Pred, arg = 0): Promise<void> {
  await page.keyboard.down(k);
  try {
    await until(page, fn, arg, 60000);
  } finally {
    await page.keyboard.up(k);
  }
}

/** Jump, double jump, then (once falling) the third press opens the glider. */
async function jumpToGlide(page: Page): Promise<void> {
  await pressUntil(page, 'Space', () => (window as unknown as W).__lodestone.player().mode === 'air');
  await steps(page, 12);
  await pressUntil(page, 'Space', () => (window as unknown as W).__lodestone.player().airJumps >= 1);
  await until(page, () => (window as unknown as W).__lodestone.player().vel.y < -1);
  await pressUntil(page, 'Space', () => (window as unknown as W).__lodestone.player().mode === 'glide');
}

async function main(): Promise<void> {
  const wasm = path.join(repoRoot, 'worldgen', 'pkg', 'worldgen.wasm');
  const ground = zoneGround(await loadWorldgenGround(fs.readFileSync(wasm), SEED));
  note(`WP10 headless browser run ${new Date().toISOString()}: Chromium (SwiftShader) + Vite dev client (WP05 terrain, WP12 towers) vs the real zone binary on seed ${SEED}`);
  note('(SwiftShader renders the real client at a few fps, so the run is paced by game steps, not wall time.)');
  const bin = buildZone();
  const zone = await startZone(bin, SEED, { LODESTONE_ZONE_DEBUG_RAIN: '0', LODESTONE_ZONE_DEBUG_UPDRAFTS: updraftSpec, LODESTONE_ZONE_EXIT_AFTER: '30m' });
  const clientPort = await freePort();
  const vite = await startVite(clientPort);
  const results: Record<string, unknown> = {};
  let worst = 0;
  try {
    // --- climb: walk into the cliff, climb, mantle onto the top.
    note('climb (ledge below the 14.5 m cliff, facing west):');
    let page = await openGame(clientPort, zone, 'climb', { x: 1336.2, z: 2339.35 }, Math.PI / 2, 0.35);
    await page.keyboard.down('KeyW');
    await until(page, () => (window as unknown as W).__lodestone.player().mode === 'climb');
    await steps(page, 120);
    await shot(page, 'climb-grab');
    await steps(page, 180);
    await shot(page, 'climb-mid');
    await until(page, () => {
      const p = (window as unknown as W).__lodestone.player();
      return p.pos.y > 221 && p.mode !== 'climb';
    });
    await steps(page, 15);
    await page.keyboard.up('KeyW');
    await shot(page, 'climb-mantled');
    await page.evaluate(() => (window as unknown as W).__lodestone.setLook(-Math.PI / 2, -0.75));
    await steps(page, 30);
    await shot(page, 'climb-top-looking-down');
    worst = Math.max(worst, await finish(page, 'climb', results));

    // --- WP12 tower: climb with a rest on the ledge, glide from the top.
    note('tower (14 m west of the tower at (1888, 1760), facing east):');
    page = await openGame(clientPort, zone, 'tower', { x: 1874, z: 1760 }, -Math.PI / 2, 0.45);
    const topY = ground.heightAt(1888, 1760);
    await page.keyboard.down('KeyW');
    await until(page, () => (window as unknown as W).__lodestone.player().mode === 'climb');
    await steps(page, 150);
    await shot(page, 'tower-climb');
    await until(page, (top) => {
      const p = (window as unknown as W).__lodestone.player();
      return p.mode !== 'climb' && p.pos.y > top - 15;
    }, topY);
    await page.keyboard.up('KeyW');
    await until(page, () => (window as unknown as W).__lodestone.player().stamina >= 99.9);
    await shot(page, 'tower-ledge-rested');
    await page.keyboard.down('KeyW');
    await until(page, (top) => {
      const p = (window as unknown as W).__lodestone.player();
      return p.mode !== 'climb' && p.pos.y >= top - 0.01;
    }, topY);
    await shot(page, 'tower-top');
    await steps(page, 20);
    await jumpToGlide(page);
    await page.evaluate(() => (window as unknown as W).__lodestone.setLook(-Math.PI / 2, -0.4));
    await steps(page, 150);
    await shot(page, 'tower-glide');
    await page.keyboard.up('KeyW');
    worst = Math.max(worst, await finish(page, 'tower', results));

    // --- glide off the peak.
    note('glide (the 360 m peak, facing south over the drop):');
    page = await openGame(clientPort, zone, 'glide', { x: 1122, z: 2301 }, Math.PI, -0.45);
    await page.keyboard.down('KeyW');
    await page.keyboard.down('ShiftLeft');
    await steps(page, 80);
    await page.keyboard.up('ShiftLeft');
    await jumpToGlide(page);
    await steps(page, 150);
    await shot(page, 'glide');
    await page.keyboard.down('KeyA');
    await steps(page, 90);
    await page.keyboard.up('KeyA');
    await pressUntil(page, 'KeyG', () => (window as unknown as W).__lodestone.player().mode === 'air');
    await steps(page, 30);
    await pressUntil(page, 'KeyG', () => (window as unknown as W).__lodestone.player().mode === 'glide');
    await steps(page, 90);
    await page.keyboard.up('KeyW');
    await shot(page, 'glide-late');
    worst = Math.max(worst, await finish(page, 'glide', results));

    // --- swim the lake out and back.
    note('swim (dry shore south of the lake, facing north):');
    page = await openGame(clientPort, zone, 'swim', { x: 1418, z: 1858 }, Math.PI, -0.15);
    await page.keyboard.down('KeyW');
    await until(page, () => (window as unknown as W).__lodestone.player().mode === 'swim');
    await steps(page, 120);
    await shot(page, 'swim');
    await page.keyboard.up('KeyW');
    await page.evaluate(() => (window as unknown as W).__lodestone.setLook(0, -0.15));
    await page.keyboard.down('KeyW');
    await until(page, () => (window as unknown as W).__lodestone.player().mode !== 'swim');
    await steps(page, 30);
    await page.keyboard.up('KeyW');
    await shot(page, 'swim-ashore');
    worst = Math.max(worst, await finish(page, 'swim', results));

    // --- remote climbing pose: a Node client climbs while the browser watches.
    note('observer (browser stands on the ledge, a Node client climbs beside it):');
    page = await openGame(clientPort, zone, 'observer', { x: 1340.5, z: 2336.5 }, Math.PI / 2 - 0.35, 0.25);
    const bot = runTimeline(zone, ground, 'climber', { x: 1336.2, z: 2339.35, yawDeg: 90 }, [{ dur: 0.3 }, { dur: 5.5, held: { forward: true } }, { dur: 3 }], { raining: false, updraft: new UpdraftColumns([]) });
    for (let i = 0; i < 9; i++) {
      // Keep looking at the climber (remote view from the snapshots).
      await page.evaluate(() => {
        const l = (window as unknown as W).__lodestone;
        const r = l.netDebug()?.remotes?.[0];
        const me = l.player().pos;
        if (r) l.setLook(Math.atan2(-(r.x - me.x), -(r.z - me.z)), Math.atan2(r.y + 1 - (me.y + 1.8), Math.hypot(r.x - me.x, r.z - me.z)));
      });
      await sleep(500);
    }
    await shot(page, 'remote-climbing');
    const r = await bot;
    note(formatRun(r));
    worst = Math.max(worst, r.maxDivM, await finish(page, 'observer', results));
  } finally {
    vite.kill();
    zone.proc.kill();
  }
  note(`overall max divergence ${(worst * 100).toFixed(2)} cm vs 10 cm: ${worst <= 0.1 ? 'PASS' : 'FAIL'}`);
  fs.writeFileSync(path.join(out, 'wp10-browser.txt'), log.join('\n') + '\n');
  fs.writeFileSync(path.join(out, 'wp10-browser.json'), JSON.stringify({ seed: SEED, worstM: worst, results }, null, 2) + '\n');
  if (worst > 0.1) process.exit(1);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
