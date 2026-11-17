// CR 043 evidence that needs a zone (enemies and townsfolk only exist
// server-side): the real client from Vite against the real zone binary on the
// official world (seed 20261108, no DB/Redis, dev tickets, dev console). The

// dwarven camp (it cannot teleport underground, so the script walks a tunnel and a camp passage like a player):
//
//   cd client && npx vite-node src/world/vertical/dev/dwarf-connected-shots.ts
//
// Writes docs/evidence/pt3-dwarves-{cave-monsters,camp-folk}.jpg.
// Every process it starts is stopped at the end.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { chromium, type Browser, type Page } from 'playwright';
import { devTicket } from '../../../net/dev/devTicket';
import { buildZone, repoRoot, waitHttp } from '../../../sim/dev/traversalRun';

const SEED = '20261108';
const out = path.join(repoRoot, 'docs', 'evidence');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gpuArgs = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const only = process.argv.includes('--only') ? new Set(process.argv[process.argv.indexOf('--only') + 1].split(',')) : null;

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
type Drawn = { id: number; kind: number; x: number; y: number; z: number; healthPct: number; name?: string };
type W = Window & {
  __lodestone: {
    player(): { pos: V };
    setLook(yaw: number | null, pitch?: number): void;
    setQuality(q: string): void;
    setView(v: string): void;
    connectZone(r: { ticket: string; zoneEndpoint: string; zoneId: string; worldId: string; name?: string }): void;
    netDebug(): { phase: string } | null;
  };
  __lodestoneMap?: { towers(): unknown[] };
  __lodestoneIntro?: { volume(v?: number): number; skip(): void };
  __lodestoneDev?: { run(line: string): unknown; open(o: boolean): void };
  __lodestoneDrawn?: () => Drawn[];
};
const lookAt = (from: { x: number; z: number }, to: { x: number; z: number }) => Math.atan2(-(to.x - from.x), -(to.z - from.z));

async function main(): Promise<void> {
  const zoneBin = buildZone();
  const zonePort = await randomPort();
  const zoneId = `zone-dwarf-${zonePort}`;
  const worldId = `dwarf-${Date.now()}`;
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
      LODESTONE_ZONE_NO_WORLD_EVENTS: '1',
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
  try {
    await waitHttp(`http://127.0.0.1:${zonePort}/healthz`, 120000);
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 90000);
    browser = await chromium.launch({ headless: true, args: gpuArgs });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page: Page = await ctx.newPage();
    page.on('pageerror', (e) => console.log(`pageerror: ${e.message}`));
    await page.addInitScript((id) => {
      localStorage.setItem('lodestone_tips_enabled', '0');
      localStorage.setItem('lodestone_whatsnew_seen', id);
    }, newest);
    await page.goto(`http://127.0.0.1:${vitePort}/?debug=1`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!(window as unknown as W).__lodestone, null, { polling: 200, timeout: 60000 });
    const conn = { ticket: devTicket({ characterId: `pt3-dwarf-${Date.now()}`, characterName: 'Ash', worldId, zoneId }), zoneEndpoint: `ws://127.0.0.1:${zonePort}/ws`, zoneId, worldId, name: 'Ash' };
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
    await page.keyboard.press('F3');
    const dev = async (line: string, ms = 500) => {
      await page.evaluate((l) => (window as unknown as W).__lodestoneDev!.run(l), line);
      await sleep(ms);
    };
    const me = () => page.evaluate(() => (window as unknown as W).__lodestone.player().pos);
    const drawn = (kind: number) => page.evaluate((k) => ((window as unknown as W).__lodestoneDrawn?.() ?? []).filter((v) => v.kind === k), kind);
    const look = (yaw: number, pitch: number) => page.evaluate(([y, p]) => (window as unknown as W).__lodestone.setLook(y, p), [yaw, pitch]);
    const hide = () =>
      page.evaluate(() => {
        for (const el of document.querySelectorAll<HTMLElement>('[data-testid="debug-hud"],[data-testid="lock-hint"],[data-testid="dev-console"],[data-testid="vibe-panel"]')) el.style.display = 'none';
      });
    const shot = async (name: string) => {
      await hide();
      await page.screenshot({ path: path.join(out, `pt3-dwarves-${name}.jpg`), type: 'jpeg', quality: 82 });
      const p = await me();
      console.log(`shot ${name} at (${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)})`);
    };
    await dev('/god on');
    await dev('/stamina on');

    // The nearest drawn entity of a kind to the player.
    const faceNearest = async (kind: number, pitch: number) => {
      const p = await me();
      const list = (await drawn(kind)).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
      if (!list.length) return null;
      await look(lookAt(p, list[0]), pitch);
      return list;
    };

    // The dev console cannot teleport underground (it never lifts you under the terrain), so we walk in
    // like a player: to a tunnel mouth, then along the tunnel and a camp's secret passage.
    type Route = { mouth: { x: number; z: number; yaw: number }; pts: { x: number; y: number; z: number }[]; tunnelPts: number; camp: { x: number; z: number; floor: number; rx: number } };
    const route: Route | null = await page.evaluate(() => {
      const v = (window as unknown as { __lodestoneVerticalWorld?: any }).__lodestoneVerticalWorld; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (!v) return null;
      const P = (c: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        const o: { x: number; y: number; z: number }[] = [];
        for (let k = 0; k < c.pts.length / 3; k++) o.push({ x: c.pts[k * 3], y: c.pts[k * 3 + 1], z: c.pts[k * 3 + 2] });
        return o;
      };
      let best: Route | null = null;
      let bestLen = Infinity;
      v.corridors.forEach((sc: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        if (sc.kind !== 4 || sc.from !== 0xffff) return;
        const camp = v.chambers[sc.to];
        if (camp.kind !== 6) return;
        const sp = P(sc);
        v.corridors.forEach((tc: any, ti: number) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          if (tc.kind !== 0) return;
          const tp = P(tc);
          let bi = -1;
          let bd = 3;
          tp.forEach((q, i) => {
            const d = Math.hypot(q.x - sp[0].x, q.z - sp[0].z);
            if (d < bd) {
              bd = d;
              bi = i;
            }
          });
          if (bi < 0) return;
          const op = v.openings.find((o: any) => o.kind === 0 && o.target === ti); // eslint-disable-line @typescript-eslint/no-explicit-any
          if (!op) return;
          let len = 0;
          for (let i = 1; i <= bi; i++) len += Math.hypot(tp[i].x - tp[i - 1].x, tp[i].z - tp[i - 1].z);
          if (len < bestLen) {
            bestLen = len;
            best = { mouth: { x: op.x, z: op.z, yaw: (op.yaw / 65536) * Math.PI * 2 }, pts: [...tp.slice(0, bi + 1), ...sp.slice(1), { x: camp.x, y: camp.floor, z: camp.z }], tunnelPts: bi + 1, camp: { x: camp.x, z: camp.z, floor: camp.floor, rx: camp.rx } };
          }
        });
      });
      return best as Route | null;
    });
    if (!route) throw new Error('no camp reachable from a tunnel in this world');
    console.log(`route: mouth (${route.mouth.x.toFixed(0)}, ${route.mouth.z.toFixed(0)}), ${route.pts.length} points, camp at (${route.camp.x.toFixed(0)}, ${route.camp.z.toFixed(0)})`);
    await dev(`/tp ${(route.mouth.x + Math.cos(route.mouth.yaw) * 30).toFixed(1)} ${(route.mouth.z + Math.sin(route.mouth.yaw) * 30).toFixed(1)}`, 4000);
    await sleep(6000);

    let shotCave = false;
    const walk = async (i0: number, i1: number, maxMs: number, onIndex?: (i: number) => Promise<void>) => {
      await page.keyboard.down('KeyW');
      await page.keyboard.down('ShiftLeft');
      const t0 = Date.now();
      let last = await me();
      let lastMove = Date.now();
      try {
        for (let i = i0; i < i1; ) {
          const p = await me();
          const t = route.pts[i];
          if (Math.hypot(t.x - p.x, t.z - p.z) < 3.2) {
            i++;
            if (onIndex) await onIndex(i);
            continue;
          }
          await look(lookAt(p, t), -0.04);
          if (Math.hypot(p.x - last.x, p.z - last.z) > 0.5) {
            last = p;
            lastMove = Date.now();
          } else if (Date.now() - lastMove > 2500) {
            await page.keyboard.press('Space');
            lastMove = Date.now();
          }
          if (Date.now() - t0 > maxMs) throw new Error(`walk timed out at point ${i}/${i1} (${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)})`);
          await sleep(90);
        }
      } finally {
        await page.keyboard.up('ShiftLeft');
        await page.keyboard.up('KeyW');
      }
    };
    const midTunnel = Math.floor(route.tunnelPts * 0.45);
    await walk(0, route.pts.length - 1, 600000, async (i) => {
      if (shotCave || i < midTunnel || (only && !only.has('cave-monsters'))) return;
      shotCave = true;
      await page.keyboard.up('KeyW');
      await dev('/despawn');
      for (const e of ['cave_crawler 2', 'tunnel_spider 2', 'cave_bat 2', 'bone_crawler 1', 'rock_troll 1']) await dev(`/spawn ${e}`, 400);
      await sleep(5500); // they come for us
      const en = await drawn(2);
      console.log(`enemies in view: ${en.length}`);
      await faceNearest(2, 0.0);
      await sleep(900);
      await shot('cave-monsters');
      await dev('/despawn');
      await page.keyboard.down('KeyW');
    });
    // In the camp: the townsfolk of the square.
    if (!only || only.has('camp-folk')) {
      await sleep(9000); // the level-up banner fades
      let list = await faceNearest(5, -0.05);
      for (let k = 0; k < 30 && list; k++) {
        const p = await me();
        if (Math.hypot(list[0].x - p.x, list[0].z - p.z) < 10) break;
        await look(lookAt(p, list[0]), -0.05);
        await page.keyboard.down('KeyW');
        await sleep(250);
        await page.keyboard.up('KeyW');
        list = await faceNearest(5, -0.05);
      }
      console.log(`townsfolk in view: ${(await drawn(5)).length}`);
      await sleep(1200);
      await shot('camp-folk');
    }
  } finally {
    await browser?.close().catch(() => {});
    vite.kill();
    zone.kill();
    const rel = zoneLog.filter((l) => /dev command|violation|error|panic|vertical packs/i.test(l)).slice(0, 12);
    console.log(rel.join('\n'));
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
