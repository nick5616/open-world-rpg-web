// Playtest 2 content (CR 023) screenshots in headless Chromium: the real
// client from Vite against the real zone binary on the official world
// (seed 20261108, no DB/Redis, dev tickets, private random ports): a
// townsperson's side quest dialogue, a world event (caravan ambush; a
// starfall), a sealed vault's lever puzzle and its keeper, a lore tablet,
// and the journal's bestiary after a first kill.
//
//   cd client && npx vite-node src/ui/content/dev/content-shots.ts [--only=dialogue,event,vault,lore,codex]
//
// One zone, one Vite, one browser (pages one after another). Writes
// docs/evidence/pt2-content-*.png and pt2-content-shots.txt.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { chromium, type Browser, type Page } from 'playwright';
import { devTicket } from '../../../net/dev/devTicket';
import { buildZone, repoRoot, waitHttp } from '../../../sim/dev/traversalRun';
import { loadWorldgenGround } from '../../../sim/worldgenGround';

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
const shot = (name: string) => path.join(out, `pt2-content-${name}.png`);
const want = (k: string) => !ONLY || ONLY.includes(k);

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

interface Debug {
  vaults: { site: number; name: string; puzzle: string; x: number; z: number; order: number[] | null }[];
  tablets: { site: number; tablet: number; x: number; y: number; z: number; name: string }[];
  givers: { town: number; townName: string; npc: number; name: string; role: number; x: number; z: number; first: string }[];
}
type ContentState = {
  events: Record<string, { id: number; kind: string; x: number; z: number; phase: number }>;
  vaults: Record<string, { site: number; phase: number; parts: { id: number; kind: string; x: number; z: number; glyph: number; on: boolean }[] }>;
  tablets: Record<string, unknown>;
  sync: { kills: Record<string, number> };
  reading: unknown;
};
type W = Window & {
  __lodestone: {
    player(): { pos: { x: number; y: number; z: number } };
    setLook(yaw: number | null, pitch?: number): void;
    setQuality(q: string): void;
    connectZone(r: { ticket: string; zoneEndpoint: string; zoneId: string; worldId: string; name?: string }): void;
    netDebug(): { phase: string } | null;
  };
  __lodestoneMap?: { towers(): unknown[] };
  __lodestoneTowns?: { settlements(): { index: number; name: string; x: number; z: number; radius: number }[]; visibleNpcs(): { name: string; entityId: number | null; x: number; z: number }[]; closePanel(): void };
  __lodestoneQuests?: { state(): { offer: { quest: { id: number; title: string; say?: string } } | null }; send(kind: number, id: string | number, action: number, arg?: number): void; journal(v?: boolean): void };
  __lodestoneContent?: { state(): ContentState; devEvent(kind: number): void; read(site: number): void; vault(site: number, part: number): void };
  __lodestoneCombat?: { runtime: { press(slot: number): void } };
  __lodestoneDrawn?: () => { id: number; kind: number; x: number; y: number; z: number; name: string; healthPct: number }[];
  __lodestoneIntro?: { volume(v?: number): number; skip(): void };
};
const lookAt = (from: { x: number; z: number }, to: { x: number; z: number }) => Math.atan2(-(to.x - from.x), -(to.z - from.z));

/** World clock offset that makes it about 11:00 (daylight, shops open). */
function dayOffset(hour: number): number {
  const day = 3600;
  const now = Date.now() / 1000;
  return (hour / 24) * day - (now % day);
}

async function main(): Promise<void> {
  fs.mkdirSync(out, { recursive: true });
  const ground = await loadWorldgenGround(fs.readFileSync(path.join(repoRoot, 'worldgen', 'pkg', 'worldgen.wasm')), SEED);
  const atlas = ground.atlas.data;
  const dry = (x: number, z: number) => ground.waterAt(x, z) < ground.heightAt(x, z) - 0.3 && ground.heightAt(x, z) > atlas.seaY + 1;
  const town = atlas.sites.filter((s) => s.category === 'settlement').sort((a, b) => Math.hypot(a.x - atlas.spawn.x, a.z - atlas.spawn.z) - Math.hypot(b.x - atlas.spawn.x, b.z - atlas.spawn.z))[0];
  // Gentle dry ground 150 m outside the town (world events, the slime camp).
  let open = { x: town.x + town.radius + 150, z: town.z };
  for (let k = 0; k < 36; k++) {
    const a = (k / 36) * Math.PI * 2;
    const x = town.x + Math.cos(a) * (town.radius + 150);
    const z = town.z + Math.sin(a) * (town.radius + 150);
    let flat = true;
    for (const [dx, dz] of [[-60, 0], [60, 0], [0, -60], [0, 60], [0, 0], [-30, -30], [30, 30]]) {
      if (!dry(x + dx, z + dz) || Math.abs(ground.heightAt(x + dx, z + dz) - ground.heightAt(x, z)) > 4) flat = false;
    }
    if (flat) {
      open = { x, z };
      break;
    }
  }
  const slimes = { x: open.x + 14, z: open.z };
  note(`town "${town.name}" (${town.x.toFixed(0)}, ${town.z.toFixed(0)}); open ground (${open.x.toFixed(0)}, ${open.z.toFixed(0)})`);

  const zoneBin = buildZone();
  const zonePort = await randomPort();
  const zoneId = `zone-content-${zonePort}`;
  const worldId = `content-${Date.now()}`;
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
      LODESTONE_ZONE_NO_WORLD_EVENTS: '1', // events are started by the dev Interact here
      LODESTONE_ZONE_VAULT_PACKS: '0', // the yard's elites would end the run before the shots
      LODESTONE_ZONE_TIME_OFFSET_S: String(dayOffset(11)),
      LODESTONE_ZONE_DEBUG_CAMP: `${slimes.x.toFixed(1)},${slimes.z.toFixed(1)},1,slime moss_slime`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const keep = (b: Buffer) => {
    for (const l of b.toString().split('\n')) if (l.trim()) zoneLog.push(l);
  };
  zone.stdout?.on('data', keep);
  zone.stderr?.on('data', keep);
  const clientDir = path.join(repoRoot, 'client');
  const vitePort = await randomPort();
  const vite = spawn(process.execPath, [path.join(path.dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin', 'vite.js'), '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], { cwd: clientDir, stdio: 'ignore' });
  let browser: Browser | null = null;
  let n = 0;
  try {
    await waitHttp(`http://127.0.0.1:${zonePort}/healthz`, 120000);
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 90000);
    const dbg = (await (await fetch(`http://127.0.0.1:${zonePort}/debug/content`)).json()) as Debug;
    note(`zone :${zonePort}, vite :${vitePort}; ${dbg.vaults.length} vaults, ${dbg.tablets.length} tablets, ${dbg.givers.length} quest givers`);
    browser = await chromium.launch({ headless: true, args: gpuArgs });

    async function join(at: { x: number; z: number }, label: string): Promise<Page> {
      const page = await browser!.newPage({ viewport: { width: 1280, height: 720 } });
      page.on('pageerror', (e) => note(`  [${label}] pageerror: ${e.message}`));
      await page.goto(`http://127.0.0.1:${vitePort}/?debug=1`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => !!(window as unknown as W).__lodestone, null, { polling: 200, timeout: 60000 });
      const name = `${label}${++n}`;
      const ticket = devTicket({ characterId: `pt2-content-${Date.now()}-${n}`, characterName: name, worldId, zoneId });
      await page.evaluate((r) => (window as unknown as W).__lodestone.connectZone(r), { ticket, zoneEndpoint: `ws://127.0.0.1:${zonePort}/ws?spawn=${at.x.toFixed(2)},${at.z.toFixed(2)}`, zoneId, worldId, name });
      await page.waitForFunction(() => {
        const w = window as unknown as W;
        return w.__lodestone.netDebug()?.phase === 'playing' && (w.__lodestoneMap?.towers().length ?? 0) > 0 && !!w.__lodestoneContent;
      }, null, { polling: 250, timeout: 180000 });
      await page.evaluate(() => (window as unknown as W).__lodestone.setQuality('high'));
      await page.keyboard.press('F3');
      await page.evaluate(() => (window as unknown as W).__lodestoneIntro?.volume(0));
      for (let k = 0; k < 8; k++) {
        await page.evaluate(() => (window as unknown as W).__lodestoneIntro?.skip());
        await sleep(200);
      }
      await sleep(1500);
      return page;
    }
    const content = (p: Page) => p.evaluate(() => (window as unknown as W).__lodestoneContent!.state());
    const pos = (p: Page) => p.evaluate(() => (window as unknown as W).__lodestone.player().pos);
    const walkTo = async (p: Page, to: { x: number; z: number }, ms: number, within = 1.2, sprint = false) => {
      const t0 = Date.now();
      await p.keyboard.down('KeyW');
      if (sprint) await p.keyboard.down('ShiftLeft');
      try {
        while (Date.now() - t0 < ms) {
          const at = await pos(p);
          if (Math.hypot(to.x - at.x, to.z - at.z) < within) return true;
          await p.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, 0), lookAt(at, to));
          await sleep(80);
        }
        return false;
      } finally {
        await p.keyboard.up('KeyW');
        if (sprint) await p.keyboard.up('ShiftLeft');
      }
    };

    // ---- 1. a townsperson's side quest dialogue ----
    if (want('dialogue')) {
      const gs = dbg.givers.filter((g) => g.townName === town.name);
      note(`givers in ${town.name}: ${gs.map((g) => `${g.name} (${g.first})`).join(', ')}`);
      const g = gs.find((x) => x.first === 'rescue') ?? gs.find((x) => x.first === 'hunt') ?? gs[0];
      const page = await join({ x: g.x + 1.5, z: g.z + 1.5 }, 'Wanderer');
      await sleep(5000); // the town's discovery level-up fanfare fades first
      let offer = null as null | { quest: { id: number; title: string; say?: string } };
      for (let k = 0; k < 30 && !offer?.quest.say; k++) {
        const npc = await page.evaluate((nm) => (window as unknown as W).__lodestoneTowns!.visibleNpcs().find((v) => v.name === nm) ?? null, g.name);
        if (npc?.entityId) {
          const at = await pos(page);
          if (Math.hypot(npc.x - at.x, npc.z - at.z) > 3) await walkTo(page, { x: npc.x, z: npc.z }, 4000, 2.2);
          await page.evaluate((id) => (window as unknown as W).__lodestoneQuests!.send(30, id, 1), npc.entityId);
          await sleep(800);
          offer = await page.evaluate(() => (window as unknown as W).__lodestoneQuests!.state().offer);
          const me = await pos(page);
          await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.05), lookAt(me, npc));
        }
        await sleep(300);
      }
      await page.evaluate(() => (window as unknown as W).__lodestoneTowns?.closePanel());
      await sleep(600);
      await page.screenshot({ path: shot('sidequest-dialogue') });
      note(`shot pt2-content-sidequest-dialogue.png: ${g.name} offers "${offer?.quest.title}" ("${offer?.quest.say}")`);
      if (offer) {
        await page.click('[data-testid="quest-offer-accept"]').catch(() => {});
        await sleep(1500);
        await page.screenshot({ path: shot('sidequest-accepted') });
        note('shot pt2-content-sidequest-accepted.png (the request in the tracker, its markers on the compass)');
      }
      await page.close();
    }

    // ---- 2. world events: a caravan ambush and a starfall ----
    if (want('event')) {
      for (const [kind, label] of [[2, 'caravan'], [1, 'starfall']] as const) {
        const page = await join(open, 'Defender');
        await page.evaluate(() => (window as unknown as W).__lodestone.setLook(0, 0));
        await page.evaluate((k) => (window as unknown as W).__lodestoneContent!.devEvent(k), kind);
        let ev: ContentState['events'][string] | undefined;
        for (let k = 0; k < 40 && !ev; k++) {
          await sleep(250);
          ev = Object.values((await content(page)).events).find((e) => e.kind === label);
        }
        if (!ev) {
          note(`no ${label} event`);
          await page.close();
          continue;
        }
        // Close in until the fight starts, then look at it.
        await walkTo(page, { x: ev.x, z: ev.z }, 6000, 24);
        await sleep(kind === 2 ? 3500 : 2500);
        const me = await pos(page);
        await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.08), lookAt(me, ev));
        await sleep(1200);
        const foes = await page.evaluate(() => (window as unknown as W).__lodestoneDrawn!().filter((v) => v.kind === 2).map((v) => v.name || `#${v.id}`));
        await page.screenshot({ path: shot(`event-${label}`) });
        note(`shot pt2-content-event-${label}.png: ${ev.kind} at (${ev.x.toFixed(0)}, ${ev.z.toFixed(0)}); enemies drawn: ${foes.join(', ')}`);
        await page.close();
      }
    }

    // ---- 3. a sealed vault: the lever puzzle and the keeper ----
    if (want('vault')) {
      const v = dbg.vaults.find((x) => x.puzzle === 'levers') ?? dbg.vaults[0];
      note(`vault "${v.name}" (${v.puzzle}) at (${v.x.toFixed(0)}, ${v.z.toFixed(0)}), order ${JSON.stringify(v.order)}`);
      const page = await join({ x: v.x + 16, z: v.z + 10 }, 'Delver');
      let vs: ContentState['vaults'][string] | undefined;
      for (let k = 0; k < 40 && !vs; k++) {
        await sleep(250);
        vs = (await content(page)).vaults[String(v.site)];
      }
      if (!vs) throw new Error('no vault state');
      let me = await pos(page);
      await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.12), lookAt(me, v));
      await sleep(1500);
      await page.screenshot({ path: shot('vault-puzzle') });
      note(`shot pt2-content-vault-puzzle.png (${vs.parts.map((p) => p.kind).join(', ')})`);
      if (v.puzzle === 'levers' && v.order) {
        for (const g of v.order) {
          const lever = vs.parts.find((p) => p.kind === 'lever' && p.glyph === g)!;
          await walkTo(page, { x: lever.x, z: lever.z }, 8000, 1.8, true);
          me = await pos(page);
          await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.3), lookAt(me, lever));
          await sleep(300);
          const target = await page.evaluate(() => (window as unknown as { __lodestoneContent: { target(): { kind: string; label: string } | null } }).__lodestoneContent.target());
          const at = await pos(page);
          note(`  at the lever of ${['sun', 'moon', 'star'][g]}: ${Math.hypot(at.x - lever.x, at.z - lever.z).toFixed(1)} m (dy ${(at.y - (lever as unknown as { y: number }).y).toFixed(1)}), prompt ${JSON.stringify(target)}`);
          await page.keyboard.press('KeyE');
          await sleep(500);
          const pulled = (await content(page)).vaults[String(v.site)]?.parts.find((p) => p.id === lever.id)?.on;
          if (!pulled) await page.evaluate(([s, id]) => (window as unknown as W).__lodestoneContent!.vault(s, id), [v.site, lever.id] as const);
          // Keep alive against the shrine's guardians: a draught when hurt.
          const hp = await page.evaluate(() => (window as unknown as { __lodestone: { player(): { health?: number } } }).__lodestone.player().health ?? 100);
          if (hp < 60) await page.keyboard.press('KeyR');
          await sleep(300);
          if (g === v.order[1]) {
            await page.screenshot({ path: shot('vault-lever') });
            note('shot pt2-content-vault-lever.png (two of three levers down)');
          }
        }
      }
      // The keeper rises at the door: wait for its sigil telegraph.
      for (let k = 0; k < 30; k++) {
        await sleep(300);
        vs = (await content(page)).vaults[String(v.site)];
        if (vs?.phase === 1) break;
      }
      me = await pos(page);
      await page.keyboard.down('KeyS');
      await sleep(900);
      await page.keyboard.up('KeyS');
      me = await pos(page);
      await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.1), lookAt(me, v));
      let best = 0;
      for (let k = 0; k < 14; k++) {
        await sleep(450);
        const keeper = await page.evaluate(() => (window as unknown as W).__lodestoneDrawn!().find((d) => d.kind === 2 && /Keeper/.test(d.name)) ?? null);
        if (keeper) {
          me = await pos(page);
          await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.12), lookAt(me, keeper));
          await page.screenshot({ path: shot(`vault-keeper${best ? '-2' : ''}`) });
          best++;
          if (best >= 2) break;
          await sleep(900);
        }
      }
      note(`shot pt2-content-vault-keeper.png (phase ${vs?.phase}, ${best} frames)`);
      await page.close();
    }

    // ---- 4. a lore tablet ----
    if (want('lore')) {
      const t = [...dbg.tablets].sort((a, b) => Math.hypot(a.x - town.x, a.z - town.z) - Math.hypot(b.x - town.x, b.z - town.z))[0];
      const page = await join({ x: t.x + 2.2, z: t.z + 1.2 }, 'Reader');
      for (let k = 0; k < 20; k++) {
        if (Object.keys((await content(page)).tablets).length) break;
        await sleep(250);
      }
      const me = await pos(page);
      await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.25), lookAt(me, t));
      await sleep(1200);
      await page.screenshot({ path: shot('lore-tablet-world') });
      await page.keyboard.press('KeyE');
      await sleep(1200);
      if (!(await content(page)).reading) await page.evaluate((s) => (window as unknown as W).__lodestoneContent!.read(s), t.site);
      await sleep(1000);
      await page.screenshot({ path: shot('lore-tablet') });
      note(`shot pt2-content-lore-tablet-world.png / pt2-content-lore-tablet.png: ${t.name} (tablet ${t.tablet})`);
      await page.close();
    }

    // ---- 5. the bestiary after a first kill ----
    if (want('codex')) {
      const page = await join({ x: slimes.x - 9, z: slimes.z }, 'Hunter');
      for (let k = 0; k < 120; k++) {
        const kills = Object.keys((await content(page)).sync.kills).length;
        if (kills >= 1) break;
        const foe = await page.evaluate(() => (window as unknown as W).__lodestoneDrawn!().filter((d) => d.kind === 2 && d.healthPct > 0)[0] ?? null);
        if (!foe) {
          await sleep(400);
          continue;
        }
        const me = await pos(page);
        const d = Math.hypot(foe.x - me.x, foe.z - me.z);
        await page.evaluate(([y, p]) => (window as unknown as W).__lodestone.setLook(y, p), [lookAt(me, foe), -Math.atan2(me.y + 1.5 - foe.y, d)] as const);
        await page.evaluate(() => (window as unknown as W).__lodestoneCombat?.runtime.press(0));
        await sleep(700);
      }
      const st = await content(page);
      note(`codex: ${JSON.stringify(st.sync.kills)}`);
      await page.keyboard.press('KeyJ');
      await sleep(600);
      await page.click('[data-testid="journal-tab-bestiary"]').catch(() => {});
      await sleep(1200);
      await page.screenshot({ path: shot('codex') });
      await page.click('[data-testid="journal-tab-achievements"]').catch(() => {});
      await sleep(900);
      await page.screenshot({ path: shot('feats') });
      note('shot pt2-content-codex.png (bestiary) and pt2-content-feats.png (the journal Achievements tab, CR 031)');
      await page.close();
    }
  } finally {
    await browser?.close().catch(() => {});
    vite.kill();
    zone.kill();
    const rel = zoneLog.filter((l) => /world event|vault|quest|feat|content/.test(l)).slice(0, 60);
    fs.writeFileSync(path.join(out, 'pt2-content-shots.txt'), [...lines, '', 'zone log (content):', ...rel].join('\n') + '\n');
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    fs.writeFileSync(path.join(out, 'pt2-content-shots.txt'), [...lines, `ERROR ${e?.stack ?? e}`].join('\n') + '\n');
    process.exit(1);
  },
);
