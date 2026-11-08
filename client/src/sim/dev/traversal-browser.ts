// WP10 headless browser run: the real game client (Vite dev server, headless
// Chromium, real keyboard events) connected straight to the real zone binary
// on the generated official world, with `?ground=worldgen` so the browser
// predicts on worldgen.wasm's surface (WP05's streamed terrain will replace
// the debug visual). For each traversal it logs per-mode prediction vs server
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
import { buildZone, formatRun, freePort, repoRoot, runTimeline, startZone, waitHttp, type ZoneProc } from './traversalRun';

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
  player(): { pos: { x: number; y: number; z: number }; mode: string; stamina: number; exhausted: boolean };
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
  await page.goto(`http://127.0.0.1:${clientPort}/?debug=1&ground=worldgen&rain=0&updraft=${updraftSpec}`, { waitUntil: 'networkidle' });
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
      l.setQuality('medium');
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

const key = async (page: Page, down: string[], ms: number) => {
  for (const k of down) await page.keyboard.down(k);
  await sleep(ms);
  for (const k of [...down].reverse()) await page.keyboard.up(k);
};
// 150 ms: SwiftShader runs the page at ~10 fps and keys are sampled per rendered frame.
const tap = (page: Page, k: string) => key(page, [k], 150);

async function main(): Promise<void> {
  const wasm = path.join(repoRoot, 'worldgen', 'pkg', 'worldgen.wasm');
  const ground = await loadWorldgenGround(fs.readFileSync(wasm), SEED);
  note(`WP10 headless browser run ${new Date().toISOString()}: Chromium (SwiftShader) + Vite dev client with ?ground=worldgen vs the real zone binary on seed ${SEED}`);
  const bin = buildZone();
  const zone = await startZone(bin, SEED, { LODESTONE_ZONE_DEBUG_RAIN: '0', LODESTONE_ZONE_DEBUG_UPDRAFTS: updraftSpec });
  const clientPort = await freePort();
  const vite = await startVite(clientPort);
  const results: Record<string, unknown> = {};
  let worst = 0;
  try {
    // --- climb: walk into the cliff, climb, mantle onto the top.
    note('climb (ledge below the 14.5 m cliff, facing west):');
    let page = await openGame(clientPort, zone, 'climb', { x: 1336.2, z: 2339.35 }, Math.PI / 2, 0.35);
    await page.keyboard.down('KeyW');
    await sleep(2600);
    await shot(page, 'climb-grab');
    await sleep(3000);
    await shot(page, 'climb-mid');
    // Keep climbing until the mantle puts us on the top, then let go and
    // turn around to look back down the cliff.
    await page.waitForFunction(() => {
      const p = (window as unknown as W).__lodestone.player();
      return p.pos.y > 221 && p.mode !== 'climb';
    }, null, { polling: 50, timeout: 15000 });
    await sleep(250);
    await page.keyboard.up('KeyW');
    await shot(page, 'climb-mantled');
    await page.evaluate(() => (window as unknown as W).__lodestone.setLook(-Math.PI / 2, -0.75));
    await sleep(1500);
    await shot(page, 'climb-top-looking-down');
    worst = Math.max(worst, await finish(page, 'climb', results));

    // --- glide off the peak.
    note('glide (the 360 m peak, facing south over the drop):');
    page = await openGame(clientPort, zone, 'glide', { x: 1122, z: 2301 }, Math.PI, -0.45);
    await page.keyboard.down('KeyW');
    await key(page, ['ShiftLeft'], 1400);
    await tap(page, 'Space');
    await sleep(380);
    await tap(page, 'Space');
    await sleep(480);
    await tap(page, 'Space');
    await sleep(2500);
    await shot(page, 'glide');
    await page.keyboard.down('KeyA');
    await sleep(1500);
    await page.keyboard.up('KeyA');
    await tap(page, 'KeyG');
    await sleep(500);
    await tap(page, 'KeyG');
    await sleep(1500);
    await page.keyboard.up('KeyW');
    await shot(page, 'glide-late');
    worst = Math.max(worst, await finish(page, 'glide', results));

    // --- swim the lake out and back.
    note('swim (dry shore south of the lake, facing north):');
    page = await openGame(clientPort, zone, 'swim', { x: 1418, z: 1858 }, Math.PI, -0.15);
    await page.keyboard.down('KeyW');
    await sleep(6500);
    await shot(page, 'swim');
    await page.keyboard.up('KeyW');
    await page.evaluate(() => (window as unknown as W).__lodestone.setLook(0, -0.15));
    await page.keyboard.down('KeyW');
    await sleep(5000);
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
