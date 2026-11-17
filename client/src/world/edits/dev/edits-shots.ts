// CR 040 evidence in headless Chromium: the real client (Vite dev server, real
// GPU via ANGLE/D3D11 unless LODESTONE_BENCH_GL=swiftshader) connected with a
// dev ticket to the real zone binary on the official world. Stands in the
// densest stand of trees near the spawn, fells them with real Interact 42
// swings (the zone decides, everyone gets the removal), then digs a pit with
// real Interact 43 swings (TerrainEdits message 73, tiles rebuilt), walks
// into it (prediction against the zone), and fills part of it back.
//
//   npx vite-node src/world/edits/dev/edits-shots.ts     (from client/; needs Go, the built wasm, Playwright Chromium)
//
// Writes docs/evidence/pt3-world-edits-clearing.png, -pit.png, -pit-filled.png
// and pt3-world-edits-shots.txt.

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { loadWorldgen } from '@lodestone/worldgen';
import { devTicket } from '../../../net/dev/devTicket';
import { buildZone, repoRoot, startZone, waitHttp } from '../../../sim/dev/traversalRun';

const out = path.join(repoRoot, 'docs', 'evidence');
const lines: string[] = [];
const note = (s: string) => {
  lines.push(s);
  console.log(s);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const software = process.env.LODESTONE_BENCH_GL === 'swiftshader';
const gpuArgs = software ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];

interface Obj {
  id: string;
  layer: number;
  kind: number;
  x: number;
  y: number;
  z: number;
}
interface Handle {
  player(): { pos: { x: number; y: number; z: number } };
  setLook(yaw: number | null, pitch?: number): void;
  setQuality(q: string): void;
  setView(mode: 'first' | 'third', shoulder?: 1 | -1, distance?: number): void;
  setTimeOfDay(s: number): void;
  connectZone(r: { ticket: string; zoneEndpoint: string; zoneId: string; worldId: string; name?: string }): void;
  netDebug(): { phase: string } | null;
  probe(): unknown;
}
interface EditsHandle {
  objects(x: number, z: number, r: number): Obj[];
  harvest(id: string): boolean;
  digAt(x: number, z: number, op?: 'dig' | 'fill'): void;
  setMode(m: string): void;
  overlay: { vertices(): number; any: boolean; delta(x: number, z: number): number };
}
interface WorldHandle {
  groundAt(x: number, z: number): number;
}
type W = Window & { __lodestone: Handle; __lodestoneEdits: EditsHandle; __lodestoneWorld: WorldHandle };

async function freePort(): Promise<number> {
  for (;;) {
    const p = 20000 + Math.floor(Math.random() * 25000);
    const ok = await new Promise<boolean>((res) => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.listen(p, '127.0.0.1', () => s.close(() => res(true)));
    });
    if (ok) return p;
  }
}

/** Inverse of worldgen's SplitMix64 finalizer: the layer of a scatter id. */
function layerOf(z: bigint): number {
  const M = (1n << 64n) - 1n;
  z ^= (z >> 31n) ^ (z >> 62n);
  z = (z * 0x319642b2d24d8ec3n) & M;
  z ^= (z >> 27n) ^ (z >> 54n);
  z = (z * 0x96de1b173f119089n) & M;
  z ^= (z >> 30n) ^ (z >> 60n);
  return Number(z >> 56n);
}

/** The densest stand of trees on dry land near the spawn: where to stand. */
async function pickStand(): Promise<{ x: number; z: number; trees: number }> {
  const wg = await loadWorldgen(fs.readFileSync(path.join(repoRoot, 'worldgen', 'pkg', 'worldgen.wasm')));
  const atlas = wg.buildAtlas(wg.specFromSeed(20261108n));
  const sx = atlas.data.spawn.x;
  const sz = atlas.data.spawn.z;
  const trees: { x: number; y: number; z: number }[] = [];
  for (let dz = -5; dz <= 5; dz++) {
    for (let dx = -5; dx <= 5; dx++) {
      const c = wg.buildChunk(atlas, Math.floor(sx / 64) + dx, Math.floor(sz / 64) + dz, 0);
      for (let i = 0; i < c.scatter.count; i++) if (layerOf(c.scatter.id(i)) === 1 && c.scatter.kind(i) !== 5) trees.push({ x: c.scatter.x(i), y: c.scatter.y(i), z: c.scatter.z(i) });
    }
  }
  // The highest water surface within 8 m (rivers and lakes; the lattice reads sea level where there is none).
  const wetNear = (x: number, z: number): number => {
    let m = -Infinity;
    for (let dz = -8; dz <= 8; dz += 2) for (let dx = -8; dx <= 8; dx += 2) m = Math.max(m, wg.waterHeight(atlas, x + dx, z + dz));
    return m;
  };
  let best = { x: sx, z: sz, trees: 0, score: -1 };
  for (const t of trees) {
    const near = trees.filter((u) => Math.hypot(u.x - t.x, u.z - t.z) < 4.4);
    // Dry, well above any lake (a dig stops 0.3 m over the water), and no trees we cannot reach.
    if (t.y < atlas.data.seaY + 8 || near.length < best.trees || wetNear(t.x, t.z) > t.y - 10) continue;
    // Flat enough to stand on, and not a hillside (the dig wants level ground).
    const h = (x: number, z: number) => wg.collisionHeight(atlas, x, z);
    const slope = Math.max(Math.abs(h(t.x + 3, t.z) - t.y), Math.abs(h(t.x, t.z + 3) - t.y));
    if (slope > 1.2) continue;
    if (near.length > best.trees) {
      const mx = near.reduce((a, u) => a + u.x, 0) / near.length;
      const mz = near.reduce((a, u) => a + u.z, 0) / near.length;
      best = { x: mx, z: mz, trees: near.length, score: near.length };
    }
  }
  return best;
}

async function main(): Promise<void> {
  const stand = await pickStand();
  note(`tree stand: ${stand.trees} trees within 4.2 m of (${stand.x.toFixed(1)}, ${stand.z.toFixed(1)})`);
  const zone = await startZone(buildZone(), '20261108', { LODESTONE_ZONE_NO_DEMONS: '1' });
  const vitePort = await freePort();
  const vite = spawn(process.execPath, [path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], { cwd: path.join(repoRoot, 'client'), stdio: 'ignore' });
  const browser = await chromium.launch({ headless: true, args: gpuArgs });
  let ok = false;
  try {
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 90000);
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => note(`  pageerror: ${e.message}`));
    await page.goto(`http://127.0.0.1:${vitePort}/?debug=1`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!(window as unknown as W).__lodestone, null, { polling: 200, timeout: 60000 });
    const ticket = devTicket({ characterId: `edits-shots-${Date.now()}`, characterName: 'Woodcutter', worldId: zone.worldId, zoneId: zone.zoneId });
    await page.evaluate((r) => (window as unknown as W).__lodestone.connectZone(r), { ticket, zoneEndpoint: `ws://127.0.0.1:${zone.port}/ws?spawn=${stand.x.toFixed(2)},${stand.z.toFixed(2)}`, zoneId: zone.zoneId, worldId: zone.worldId, name: 'Woodcutter' });
    await page.waitForFunction(() => (window as unknown as W).__lodestone.netDebug()?.phase === 'playing' && (window as unknown as W).__lodestone.player().pos.y > 5, null, { polling: 250, timeout: 180000 });
    await page.evaluate(() => {
      const l = (window as unknown as W).__lodestone;
      l.setQuality('high');
      l.setTimeOfDay(10.5 * 3600);
    });
    await page.getByRole('button', { name: "Let's go" }).click({ timeout: 8000 }).catch(() => {});
    await page.keyboard.press('F3'); // hide the debug HUD
    await page.waitForFunction(([x, z]) => ((window as unknown as W).__lodestoneEdits?.objects(x, z, 8).length ?? 0) > 3, [stand.x, stand.z], { polling: 300, timeout: 120000 });
    await sleep(3500);
    const me = await page.evaluate(() => (window as unknown as W).__lodestone.player().pos);
    note(`spawned at (${me.x.toFixed(1)}, ${me.y.toFixed(1)}, ${me.z.toFixed(1)})`);

    // A third-person view onto the stand, for the before / after pair.
    await page.evaluate(() => {
      const l = (window as unknown as W).__lodestone;
      l.setView('third', 1, 9);
      l.setLook(Math.PI * 0.25, -0.3);
    });
    await sleep(3500);
    await page.screenshot({ path: path.join(out, 'pt3-world-edits-before.png') });

    // Fell every tree within reach, one real swing at a time.
    const trees = await page.evaluate(([x, z]) => (window as unknown as W).__lodestoneEdits.objects(x, z, 4.6).filter((o) => o.layer === 1), [me.x, me.z]);
    note(`${trees.length} trees within reach`);
    let felled = 0;
    let shotFall = false;
    for (const [n, t] of trees.entries()) {
      for (let i = 0; i < 14; i++) {
        const gone = await page.evaluate(([id, px, pz]) => !(window as unknown as W).__lodestoneEdits.objects(px as number, pz as number, 7).some((o) => o.id === id), [t.id, me.x, me.z] as [string, number, number]);
        if (gone) {
          felled++;
          break;
        }
        await page.evaluate((id) => (window as unknown as W).__lodestoneEdits.harvest(id), t.id);
        await sleep(300);
      }
      if (n === trees.length - 1 && !shotFall) {
        shotFall = true;
        await sleep(850); // the last tree is mid-fall
        await page.screenshot({ path: path.join(out, 'pt3-world-edits-falling.png') });
      }
    }
    note(`felled ${felled} of ${trees.length}`);
    await sleep(4500); // the last fall, thud and the dust settle
    const left = await page.evaluate(([x, z]) => (window as unknown as W).__lodestoneEdits.objects(x, z, 4.6).filter((o) => o.layer === 1).length, [me.x, me.z]);
    note(`trees left within reach: ${left}`);
    await page.screenshot({ path: path.join(out, 'pt3-world-edits-clearing.png') });

    // Dig: a pit three metres in front of the player, real Interact 43 swings.
    const yaw = Math.PI * 0.25; // the look direction used above is yaw = pi/4 (-z at 0, so forward = (-sin, -cos))
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const px = me.x + fx * 2.6;
    const pz = me.z + fz * 2.6;
    const before = await page.evaluate(([x, z]) => (window as unknown as W).__lodestoneWorld.groundAt(x, z), [px, pz]);
    await page.evaluate(() => (window as unknown as W).__lodestoneEdits.setMode('dig'));
    for (let i = 0; i < 12; i++) {
      await page.evaluate(([x, z]) => (window as unknown as W).__lodestoneEdits.digAt(x, z, 'dig'), [px, pz]);
      await sleep(280);
      if (i === 5) await page.screenshot({ path: path.join(out, 'pt3-world-edits-digging.png') });
    }
    await sleep(2500);
    const after = await page.evaluate(([x, z]) => (window as unknown as W).__lodestoneWorld.groundAt(x, z), [px, pz]);
    const verts = await page.evaluate(() => (window as unknown as W).__lodestoneEdits.overlay.vertices());
    note(`dug at (${px.toFixed(1)}, ${pz.toFixed(1)}): ground ${before.toFixed(2)} -> ${after.toFixed(2)} (${(before - after).toFixed(2)} m), ${verts} vertices edited`);
    await page.evaluate(() => {
      const l = (window as unknown as W).__lodestone;
      l.setView('third', 1, 6);
      l.setLook(Math.PI * 0.25, -0.45);
    });
    await sleep(1500);
    await page.screenshot({ path: path.join(out, 'pt3-world-edits-pit.png') });

    // Walk into the pit (prediction against the zone's edited ground), then fill some back.
    await page.keyboard.down('KeyW');
    await sleep(1800);
    await page.keyboard.up('KeyW');
    await sleep(800);
    const inPit = await page.evaluate(() => (window as unknown as W).__lodestone.player().pos);
    const probe = (await page.evaluate(() => (window as unknown as W).__lodestone.probe())) as { corrections?: number; maxDivM?: number } | null;
    note(`walked in: feet y ${inPit.y.toFixed(2)} at (${inPit.x.toFixed(1)}, ${inPit.z.toFixed(1)}); prediction probe ${JSON.stringify(probe)}`);
    await page.evaluate(() => (window as unknown as W).__lodestoneEdits.setMode('fill'));
    // Fill under your own feet (the pit is deeper than the shovel's reach from the rim).
    const fx2 = inPit.x + fx * 1.2;
    const fz2 = inPit.z + fz * 1.2;
    const lowest = await page.evaluate(([x, z]) => (window as unknown as W).__lodestoneWorld.groundAt(x, z), [fx2, fz2]);
    for (let i = 0; i < 8; i++) {
      await page.evaluate(([x, z]) => (window as unknown as W).__lodestoneEdits.digAt(x, z, 'fill'), [fx2, fz2]);
      await sleep(280);
    }
    await sleep(2000);
    const filled = await page.evaluate(([x, z]) => (window as unknown as W).__lodestoneWorld.groundAt(x, z), [fx2, fz2]);
    note(`filled 8 swings at (${fx2.toFixed(1)}, ${fz2.toFixed(1)}): ground ${lowest.toFixed(2)} -> ${filled.toFixed(2)}`);
    await page.screenshot({ path: path.join(out, 'pt3-world-edits-pit-filled.png') });
    ok = felled >= Math.max(1, trees.length - 1) && left <= 1 && before - after > 1.5 && filled > lowest + 0.4;
    note(ok ? 'PASS' : 'FAIL');
    fs.writeFileSync(path.join(out, 'pt3-world-edits-shots.txt'), ['# Playtest 3 world edits (CR 040): real client + zone binary, official world', `date ${new Date().toISOString()}`, ...lines].join('\n') + '\n');
  } finally {
    await browser.close();
    vite.kill();
    zone.proc.kill();
    process.exitCode = ok ? 0 : 1;
  }
}

await main();
