// Discovery intro screenshots (pt/ux-intros) in headless Chromium: the real
// client from Vite against the real zone binary on the official world
// (seed 20261108, no DB/Redis, dev tickets, private random ports). Each shot
// is triggered by a real zone discovery Event: a fresh character is dropped
// (dev spawn) just outside a site's discovery radius and walks in.
//
//   cd client && npx vite-node src/ui/intro/dev/intro-shots.ts
//
// Writes docs/evidence/pt-ux-intro-*.png and pt-ux-intro-shots.txt.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright';
import type { Site } from '@lodestone/worldgen';
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
const shot = (name: string) => path.join(out, `pt-ux-intro-${name}.png`);

/** A free port in 20000-45000 (clear of Hyper-V's reserved ranges and the owner's dev stack). */
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

interface IntroState {
  current: { key: string; variant: string; title: string; subtitle?: string; detail?: string; startedAt: number; endsAt: number; inMs: number; pace: number } | null;
  queue: string[];
  now: number;
}
interface Handle {
  player(): { pos: { x: number; y: number; z: number } };
  setLook(yaw: number | null, pitch?: number): void;
  setQuality(q: string): void;
  connectZone(r: { ticket: string; zoneEndpoint: string; zoneId: string; worldId: string; name?: string }): void;
  netDebug(): { phase: string } | null;
}
type W = Window & {
  __lodestone: Handle;
  __lodestoneMap?: { towers(): unknown[]; state(): { stats: { events: number }; toasts: { kind: string; title: string }[] } };
  __lodestoneIntro?: { state(): IntroState; history(): { key: string; title: string; variant: string }[]; skip(): void; show(s: Record<string, unknown>): void; volume(v?: number): number };
};

async function main(): Promise<void> {
  fs.mkdirSync(out, { recursive: true });
  const ground = await loadWorldgenGround(fs.readFileSync(path.join(repoRoot, 'worldgen', 'pkg', 'worldgen.wasm')), SEED);
  const atlas = ground.atlas.data;
  const dry = (x: number, z: number) => ground.waterAt(x, z) < ground.heightAt(x, z) - 0.3 && ground.heightAt(x, z) > atlas.seaY + 1;

  /** A dry spot `dist` m from the site whose straight walk in is gentle. */
  function approach(s: Site, dist: number): { x: number; z: number } | null {
    let best: { x: number; z: number; cost: number } | null = null;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const x = s.x + Math.cos(a) * dist;
      const z = s.z + Math.sin(a) * dist;
      if (x < 64 || z < 64 || x > atlas.worldSize - 64 || z > atlas.worldSize - 64) continue;
      let cost = 0;
      let ok = true;
      let prev = ground.heightAt(x, z);
      for (let t = 1; t <= 20; t++) {
        const px = x + ((s.x - x) * t) / 20;
        const pz = z + ((s.z - z) * t) / 20;
        if (t < 18 && !dry(px, pz)) ok = false;
        const h = ground.heightAt(px, pz);
        cost += Math.abs(h - prev);
        prev = h;
      }
      if (ok && dry(x, z) && (!best || cost < best.cost)) best = { x, z, cost };
    }
    return best;
  }

  const zoneBin = buildZone();
  const zonePort = await randomPort();
  const zoneId = `zone-intro-${zonePort}`;
  const worldId = `intro-${Date.now()}`;
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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const keep = (b: Buffer) => {
    for (const l of b.toString().split('\n')) if (l.trim()) zoneLog.push(l);
  };
  zone.stdout?.on('data', keep);
  zone.stderr?.on('data', keep);
  const vitePort = await randomPort();
  const vite = spawn(process.execPath, [path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], { cwd: path.join(repoRoot, 'client'), stdio: 'ignore' });
  let browser: Browser | null = null;
  let n = 0;
  try {
    await waitHttp(`http://127.0.0.1:${zonePort}/healthz`, 120000);
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 90000);
    note(`zone :${zonePort} (seed ${SEED}), vite :${vitePort}`);
    browser = await chromium.launch({ headless: true, args: gpuArgs });

    const intro = (page: Page) => page.evaluate(() => (window as unknown as W).__lodestoneIntro!.state());

    async function join(at: { x: number; z: number }, label: string, viewport = { width: 1280, height: 720 }): Promise<Page> {
      const page = await browser!.newPage({ viewport });
      page.on('pageerror', (e) => note(`  [${label}] pageerror: ${e.message}`));
      await page.goto(`http://127.0.0.1:${vitePort}/?debug=1`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => !!(window as unknown as W).__lodestone, null, { polling: 200, timeout: 60000 });
      const name = `Intro${++n}`;
      const ticket = devTicket({ characterId: `pt-ux-intro-${Date.now()}-${n}`, characterName: name, worldId, zoneId });
      await page.evaluate((r) => (window as unknown as W).__lodestone.connectZone(r), { ticket, zoneEndpoint: `ws://127.0.0.1:${zonePort}/ws?spawn=${at.x.toFixed(2)},${at.z.toFixed(2)}`, zoneId, worldId, name });
      await page.waitForFunction(
        () => {
          const w = window as unknown as W;
          return w.__lodestone.netDebug()?.phase === 'playing' && (w.__lodestoneMap?.towers().length ?? 0) > 0 && (w.__lodestoneMap?.state().stats.events ?? 0) > 0 && !!w.__lodestoneIntro;
        },
        null,
        { polling: 250, timeout: 180000 },
      );
      await page.evaluate(() => (window as unknown as W).__lodestone.setQuality('high'));
      await page.keyboard.press('F3'); // hide the debug HUD
      await page.evaluate(() => (window as unknown as W).__lodestoneIntro!.volume(0)); // headless: no audio device anyway
      return page;
    }

    /** Wait until the intro on screen has been up `ms` (raf polling), then screenshot. */
    async function shootAt(page: Page, key: string, ms: number, file: string): Promise<void> {
      await page.waitForFunction(([k, t]) => {
        const s = (window as unknown as W).__lodestoneIntro!.state();
        return !s.current || s.current.key !== k || s.now - s.current.startedAt >= (t as number);
      }, [key, ms] as const, { polling: 'raf', timeout: 15000 });
      await page.screenshot({ path: file });
      const s = await intro(page);
      note(`  shot ${path.basename(file)}: ${s.current ? `${s.current.key} "${s.current.title}" / ${s.current.subtitle ?? ''} / ${s.current.detail ?? ''} at ${(s.now - s.current.startedAt).toFixed(0)} ms of ${(s.current.endsAt - s.current.startedAt).toFixed(0)} (in ${s.current.inMs} ms)` : 'no intro'}`);
    }

    /**
     * Fresh character outside `site`'s discovery radius: let the region
     * intro play (shot optional), then walk in until the zone's discovery
     * Event puts the site's intro on screen. Returns the page and the key.
     */
    async function discover(site: Site, radius: number, label: string, regionShot?: string): Promise<{ page: Page; key: string } | null> {
      const at = approach(site, radius + 22);
      if (!at) return null;
      note(`${label}: site #${site.index} ${site.kind} "${site.name ?? ''}" (${site.x.toFixed(0)}, ${site.z.toFixed(0)}), dropped at (${at.x.toFixed(0)}, ${at.z.toFixed(0)})`);
      const page = await join(at, label);
      const yaw = Math.atan2(-(site.x - at.x), -(site.z - at.z));
      await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, 0.05), yaw);
      // The first-entry region intro comes up ~1.5 s after the zone's progress.
      await page.waitForFunction(() => (window as unknown as W).__lodestoneIntro!.state().current?.key.startsWith('region:') ?? false, null, { polling: 100, timeout: 8000 }).catch(() => {});
      const r = await intro(page);
      if (r.current) {
        note(`  region entry: "${r.current.title}" / ${r.current.subtitle ?? ''} / ${r.current.detail ?? ''}`);
        if (regionShot) await shootAt(page, r.current.key, r.current.inMs + 600, regionShot);
      }
      await page.waitForFunction(() => !(window as unknown as W).__lodestoneIntro!.state().current, null, { polling: 100, timeout: 12000 }).catch(() => {});
      const key = `site:${site.index}`;
      await page.keyboard.down('KeyW');
      try {
        const t0 = Date.now();
        for (;;) {
          const s = await intro(page);
          if (s.current?.key === key) break;
          if (Date.now() - t0 > 45000) {
            note(`  ${label}: no discovery within 45 s; history ${JSON.stringify(await page.evaluate(() => (window as unknown as W).__lodestoneIntro!.history()))}`);
            await page.close();
            return null;
          }
          const p = await page.evaluate(() => (window as unknown as W).__lodestone.player().pos);
          await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, 0.05), Math.atan2(-(site.x - p.x), -(site.z - p.z)));
          await sleep(60);
        }
      } finally {
        await page.keyboard.up('KeyW');
      }
      const toasts = await page.evaluate(() => (window as unknown as W).__lodestoneMap!.state().toasts);
      note(`  discovery Event -> intro; store toasts (hidden from the HUD): ${JSON.stringify(toasts)}`);
      return { page, key };
    }

    const sites = atlas.sites;
    const from = atlas.spawn;
    const byDist = (list: Site[]) => list.slice().sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z));

    // 1. Tower: the 3-frame strip and the tower shot.
    for (const t of byDist(sites.filter((s) => s.kind === 'tower')).slice(0, 4)) {
      const d = await discover(t, 40, 'tower', shot('region-entry'));
      if (!d) continue;
      const s = (await intro(d.page)).current!;
      await shootAt(d.page, d.key, Math.round(s.inMs * 0.3), shot('frames-1'));
      await shootAt(d.page, d.key, s.inMs + 900, shot('frames-2'));
      await shootAt(d.page, d.key, s.endsAt - s.startedAt - Math.round(s.inMs * 0.55), shot('frames-3'));
      await d.page.close();
      const again = await discover(t, 40, 'tower (again, fresh character)');
      if (again) {
        const s2 = (await intro(again.page)).current!;
        await shootAt(again.page, again.key, s2.inMs + 700, shot('tower'));
        await again.page.close();
      }
      break;
    }

    // 2. Town: walk into a settlement's footprint.
    for (const s of byDist(sites.filter((x) => x.category === 'settlement' && x.size >= 1)).slice(0, 4)) {
      const d = await discover(s, s.radius, 'town');
      if (!d) continue;
      const c = (await intro(d.page)).current!;
      await shootAt(d.page, d.key, c.inMs + 700, shot('town'));
      await d.page.close();
      break;
    }

    // 3. A structure / cave / landmark, caught mid-animation.
    const others = byDist(sites.filter((x) => x.category === 'structure' || x.kind === 'cave_mouth' || x.kind === 'landmark'));
    for (const s of others.slice(0, 6)) {
      const r = s.category === 'structure' ? Math.max(s.radius, 15) + 10 : s.kind === 'cave_mouth' ? 20 : 25;
      const d = await discover(s, r, 'discovery');
      if (!d) continue;
      const c = (await intro(d.page)).current!;
      await shootAt(d.page, d.key, Math.round(c.inMs * 0.6), shot('discovery'));
      await d.page.close();
      break;
    }

    // 4. Spawned on a tower top: the zone unlocks it at once (600) -> region reveal,
    //    queued with the tower's discovery and the region entry (collapse/pace).
    const top = byDist(sites.filter((s) => s.kind === 'tower'))[1] ?? byDist(sites.filter((s) => s.kind === 'tower'))[0];
    if (top) {
      note(`region reveal: spawn on tower #${top.index} "${top.name ?? ''}"`);
      const page = await join({ x: top.x, z: top.z }, 'reveal');
      await page.evaluate(() => (window as unknown as W).__lodestone.setLook(2.4, -0.15));
      const ok = await page.waitForFunction(() => (window as unknown as W).__lodestoneIntro!.state().current?.key.startsWith('reveal:') ?? false, null, { polling: 100, timeout: 30000 }).then(() => true, () => false);
      note(`  history: ${JSON.stringify(await page.evaluate(() => (window as unknown as W).__lodestoneIntro!.history()))}`);
      if (ok) {
        const c = (await intro(page)).current!;
        await shootAt(page, c.key, c.inMs + 700, shot('region'));
      }
      // Responsive: the same layout at 1920x1080 and an 800 px window (dev handle, real names).
      const title = top.name ?? 'The Forgotten Spire';
      for (const [vw, vh, file] of [[1920, 1080, '1080'], [800, 600, '800']] as const) {
        await page.setViewportSize({ width: vw, height: vh });
        await page.evaluate(() => (window as unknown as W).__lodestoneIntro!.skip());
        await page.waitForFunction(() => !(window as unknown as W).__lodestoneIntro!.state().current, null, { polling: 100, timeout: 20000 }).catch(() => {});
        await page.evaluate((t) => (window as unknown as W).__lodestoneIntro!.show({ variant: 'major', title: t, subtitle: 'Tower of The Whispering Highlands', detail: '+40 XP', accent: '#ff7b72' }), title);
        await sleep(1700);
        await page.screenshot({ path: shot(file) });
        note(`  shot pt-ux-intro-${file}.png (${vw}x${vh}, dev handle)`);
      }
      await page.close();
    }
  } finally {
    await browser?.close().catch(() => {});
    vite.kill();
    zone.kill();
    fs.writeFileSync(path.join(out, 'pt-ux-intro-shots.txt'), lines.join('\n') + '\n');
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    fs.writeFileSync(path.join(out, 'pt-ux-intro-shots.txt'), [...lines, `ERROR ${e?.stack ?? e}`].join('\n') + '\n');
    process.exit(1);
  },
);
