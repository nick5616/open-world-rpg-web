// CR 043 evidence that needs a zone (enemies and townsfolk only exist
// server-side): the real client from Vite against the real zone binary on the
// official world (seed 20261108, no DB/Redis, dev tickets, dev console). The

// dwarven camp and stronghold (it cannot teleport underground, so the script walks a tunnel and a camp passage like a player):
//
//   cd client && npx vite-node src/world/vertical/dev/dwarf-connected-shots.ts
//
// Writes docs/evidence/pt3-dwarves-{cave-monsters,dwarf-closeup,camp-folk,stronghold-market}.jpg.
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
    type Pt = { x: number; y: number; z: number };
    type Route = { mouth: { x: number; z: number; yaw: number }; pts: Pt[]; tunnelPts: number; target: { x: number; z: number } };
    // The dev console cannot teleport underground (it never lifts you under the terrain), so we walk in
    // like a player: to a tunnel mouth, along the tunnel (and across its cavern for a stronghold), then the
    // secret passage to the hall.
    const planRoute = (hold: boolean): Promise<Route | null> =>
      page.evaluate((hold) => {
        const v = (window as unknown as { __lodestoneVerticalWorld?: any }).__lodestoneVerticalWorld; // eslint-disable-line @typescript-eslint/no-explicit-any
        if (!v) return null;
        const P = (c: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          const o: { x: number; y: number; z: number }[] = [];
          for (let k = 0; k < c.pts.length / 3; k++) o.push({ x: c.pts[k * 3], y: c.pts[k * 3 + 1], z: c.pts[k * 3 + 2] });
          return o;
        };
        const len = (a: { x: number; z: number }[]) => a.reduce((s, q, i) => s + (i ? Math.hypot(q.x - a[i - 1].x, q.z - a[i - 1].z) : 0), 0);
        let best: Route | null = null;
        let bestLen = Infinity;
        v.corridors.forEach((sc: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          if (sc.kind !== 4) return;
          const hall = v.chambers[sc.to];
          if (hall.kind !== (hold ? 7 : 6) || (hold ? sc.from === 0xffff || v.chambers[sc.from].kind >= 6 : sc.from !== 0xffff)) return;
          const sp = P(sc);
          v.corridors.forEach((tc: any, ti: number) => { // eslint-disable-line @typescript-eslint/no-explicit-any
            if (tc.kind !== 0 || (hold && tc.to !== sc.from)) return;
            const tp = P(tc);
            let cut = tp.length - 1;
            const mid: Pt[] = [];
            if (hold) {
              const a = tp[tp.length - 1];
              const b = sp[0];
              const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 8);
              for (let k = 1; k < n; k++) mid.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y, z: a.z + ((b.z - a.z) * k) / n });
            } else {
              let bd = 3;
              cut = -1;
              tp.forEach((q, i) => {
                const d = Math.hypot(q.x - sp[0].x, q.z - sp[0].z);
                if (d < bd) {
                  bd = d;
                  cut = i;
                }
              });
              if (cut < 0) return;
            }
            const op = v.openings.find((o: any) => o.kind === 0 && o.target === ti); // eslint-disable-line @typescript-eslint/no-explicit-any
            if (!op) return;
            const pts = [...tp.slice(0, cut + 1), ...mid, ...sp.slice(hold ? 0 : 1), { x: hall.x, y: hall.floor, z: hall.z }];
            const l = len(pts);
            if (l < bestLen) {
              bestLen = l;
              best = { mouth: { x: op.x, z: op.z, yaw: (op.yaw / 65536) * Math.PI * 2 }, pts, tunnelPts: cut + 1, target: { x: hall.x, z: hall.z } };
            }
          });
        });
        return best as Route | null;
      }, hold);
    let route!: Route;
    const enter = async (r: Route) => {
      route = r;
      console.log(`route: mouth (${r.mouth.x.toFixed(0)}, ${r.mouth.z.toFixed(0)}), ${r.pts.length} points, hall at (${r.target.x.toFixed(0)}, ${r.target.z.toFixed(0)})`);
      await dev(`/tp ${(r.mouth.x + Math.cos(r.mouth.yaw) * 30).toFixed(1)} ${(r.mouth.z + Math.sin(r.mouth.yaw) * 30).toFixed(1)}`, 4000);
      await sleep(6000);
    };
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
    /** Walk toward a drawn entity until `d` m away (stops at walls), then face it. */
    const approach = async (pick: (l: Drawn[]) => Drawn | undefined, d: number, pitch: number) => {
      for (let k = 0; k < 60; k++) {
        const p = await me();
        const t = pick(await drawn(5));
        if (!t) return null;
        await look(lookAt(p, t), pitch);
        if (Math.hypot(t.x - p.x, t.z - p.z) < d) return t;
        await page.keyboard.down('KeyW');
        await sleep(300);
        await page.keyboard.up('KeyW');
      }
      return null;
    };

    // 1. A camp: monsters in the tunnel, then the folk.
    const wantCamp = !only || only.has('cave-monsters') || only.has('camp-folk') || only.has('dwarf-closeup-camp');
    const camp = wantCamp ? await planRoute(false) : null;
    if (wantCamp && !camp) throw new Error('no camp reachable from a tunnel in this world');
    if (camp) await enter(camp);
    let shotCave = false;
    const midTunnel = camp ? Math.floor(route.tunnelPts * 0.45) : 0;
    if (camp) await walk(0, route.pts.length - 1, 600000, async (i) => {
      if (shotCave || i < midTunnel || (only && !only.has('cave-monsters'))) return;
      shotCave = true;
      await page.keyboard.up('KeyW');
      await dev('/despawn');
      for (const e of ['cave_crawler 2', 'tunnel_spider 2', 'cave_bat 1', 'bone_crawler 1']) await dev(`/spawn ${e}`, 400);
      await sleep(2500);
      // Close the distance: walk at them until the nearest is 8-12 m away.
      for (let k = 0; k < 25; k++) {
        const en = (await drawn(2)).filter((e) => e.healthPct > 0);
        const p = await me();
        if (!en.length) break;
        en.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
        await look(lookAt(p, en[0]), 0);
        if (Math.hypot(en[0].x - p.x, en[0].z - p.z) < 11) break;
        await page.keyboard.down('KeyW');
        await sleep(250);
        await page.keyboard.up('KeyW');
      }
      const en = await drawn(2);
      const p = await me();
      console.log(`enemies in view: ${en.length}, nearest ${en.length ? Math.min(...en.map((e) => Math.hypot(e.x - p.x, e.z - p.z))).toFixed(1) : '-'} m`);
      await faceNearest(2, 0.0);
      await sleep(700);
      await shot('cave-monsters');
      await dev('/despawn');
      await page.keyboard.down('KeyW');
    });
    if (camp && only?.has('dwarf-closeup-camp')) {
      await sleep(9000); // the level-up banner fades
      const t = await approach((l) => l.find((n) => n.name === 'Thramund') ?? l.sort((a, b) => a.x - b.x)[0], 3.6, 0.02);
      console.log(`dwarf close-up: ${t ? `${t.name} at ${(await me()).x.toFixed(0)}` : 'no townsperson reachable'}`);
      await sleep(1200);
      await shot('dwarf-closeup');
      await dev('/despawn');
    }
    if (camp && (!only || only.has('camp-folk'))) {
      await faceNearest(5, -0.05);
      await sleep(800);
      await shot('camp-folk');
    }

    // 2. A stronghold: across its cavern and down the Deep Road to the market.
    if (!only || only.has('stronghold-market') || only.has('dwarf-closeup')) {
      const hold = await planRoute(true);
      if (!hold) console.log('no stronghold reachable from a tunnel through a vast cavern in this world');
      else {
        await enter(hold);
        await walk(0, route.pts.length - 1, 900000);
        await sleep(6000);
        await faceNearest(5, -0.03);
        const p = await me();
        console.log(`stronghold folk in view: ${(await drawn(5)).length} at (${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)})`);
        await sleep(1000);
        if (!only || only.has('stronghold-market')) await shot('stronghold-market');
        // A dwarf close-up in the market: the nearest townsperson, 3.6 m away.
        const t = await approach((l) => l.sort((a, b) => Math.hypot(a.x - (route.target.x), a.z - route.target.z) - Math.hypot(b.x - route.target.x, b.z - route.target.z))[0], 3.6, 0.02);
        console.log(`dwarf close-up: ${t ? t.name : 'no townsperson reachable'}`);
        await sleep(1200);
        await shot('dwarf-closeup');
      }
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
