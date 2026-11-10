// Playtest 2 taming and pets (CR 029) screenshots in headless Chromium: the
// real client from Vite against the real zone binary on the official world
// (seed 20261108, no DB/Redis, dev tickets, private random ports, a sunny
// afternoon): a weakened wolf calmed by the meat you carry, the taming
// meter, the tame, the pet following you, the pet fighting bandits beside
// you, the pet wheel and the pet panel.
//
//   cd client && npx vite-node src/ui/pets/dev/pet-shots.ts
//
// One zone, one Vite, ONE browser (one page). Writes
// docs/evidence/pt2-pets-*.png and pt2-pets-shots.txt. Every process it
// starts is stopped at the end.

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
const shot = (name: string) => path.join(out, `pt2-pets-${name}.png`);

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
type PetInfo = { id: number; sp: string; name: string; lv: number; out: number; hp: number; variant: number };
type PetsDbg = {
  state(): { mine: { pets: PetInfo[]; active: number; mode: number; stable: boolean } | null; calm: Record<string, { id: number; x: number; z: number; species: number }>; meter: { creature: number; ms: number } | null; tamed: { name: string; variant: number } | null; notes: string[]; selfId: number; feedable: unknown; aimed: number };
  actions(): { dev(arg: number, target?: number): void; command(cmd: number, target?: number): void; name(id: number, t: string): void; feed(id: number): void } | null;
  panel(open?: boolean): void;
};
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
  __lodestonePets?: PetsDbg;
  __lodestoneDrawn?: () => { id: number; kind: number; x: number; y: number; z: number; healthPct: number; typeId?: number; name: string }[];
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
    return w.__lodestone.netDebug()?.phase === 'playing' && (w.__lodestoneMap?.towers().length ?? 0) > 0 && !!w.__lodestonePets?.actions();
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
  // Open, gentle, dry ground outside a town with room east for a fight.
  let start: { x: number; z: number } | null = null;
  for (const town of towns.slice(0, 6)) {
    for (const r of [90, 120, 70, 150]) {
      for (let k = 0; k < 48 && !start; k++) {
        const a = (k / 48) * Math.PI * 2;
        const x = town.x + Math.cos(a) * (town.radius + r);
        const z = town.z + Math.sin(a) * (town.radius + r);
        let ok = true;
        let prev = ground.heightAt(x - 20, z);
        for (let d = -20; d <= 70 && ok; d += 2) {
          for (const dz of [-12, -6, 0, 6, 12]) if (!dry(x + d, z + dz)) ok = false;
          const h = ground.heightAt(x + d, z);
          if (Math.abs(h - prev) > 0.7) ok = false;
          prev = h;
        }
        if (ok) start = { x, z };
      }
      if (start) break;
    }
    if (start) {
      note(`taming ground at ${start.x.toFixed(1)}, ${start.z.toFixed(1)}, outside "${town.name}"`);
      break;
    }
  }
  if (!start) throw new Error('no open ground near the spawn');
  const camp = { x: start.x + 55, z: start.z };

  const zoneBin = buildZone();
  const zonePort = await randomPort();
  const zoneId = `zone-pets-${zonePort}`;
  const worldId = `pets-${Date.now()}`;
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
      LODESTONE_ZONE_DEBUG_CAMP: `${camp.x.toFixed(1)},${camp.z.toFixed(1)},1,cutthroat archer`,
      LODESTONE_ZONE_TIME_OFFSET_S: String(offsetFor(15.5)),
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
    const page = await joinPage(browser, url, newest, { ticket: devTicket({ characterId: `pt2-pets-a-${Date.now()}`, characterName: 'Ash', worldId, zoneId }), zoneEndpoint: ep(start.x, start.z), zoneId, worldId, name: 'Ash' });
    await sleep(2000);
    const P = () => page.evaluate(() => (window as unknown as W).__lodestonePets!.state());
    const me = () => page.evaluate(() => (window as unknown as W).__lodestone.player().pos);
    const drawn = () => page.evaluate(() => ((window as unknown as W).__lodestoneDrawn?.() ?? []).map((v) => ({ id: v.id, kind: v.kind, x: v.x, y: v.y, z: v.z, healthPct: v.healthPct, typeId: v.typeId, name: v.name })));
    const WEST = Math.PI / 2;
    await page.keyboard.press('KeyT'); // third person
    await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.25), WEST);
    await sleep(500);

    // Dev: every species' favourite food (5 of each), then a weakened wolf 7 m ahead.
    await page.evaluate(() => (window as unknown as W).__lodestonePets!.actions()!.dev(1));
    await sleep(1200);
    let tamedName = '';
    for (let tries = 0; tries < 4 && !tamedName; tries++) {
      await page.evaluate(() => (window as unknown as W).__lodestonePets!.actions()!.dev(2, 4)); // species 4: the wolf
      let calm: { id: number; x: number; z: number } | null = null;
      for (let k = 0; k < 40 && !calm; k++) {
        await sleep(150);
        const c = Object.values((await P()).calm);
        if (c.length) calm = c[0];
      }
      if (!calm) throw new Error('the weakened wolf never calmed');
      note(`calm wolf ${calm.id} at (${calm.x.toFixed(1)}, ${calm.z.toFixed(1)})`);
      // walk up to it
      await page.keyboard.down('KeyW');
      for (let k = 0; k < 60; k++) {
        const at = await me();
        const v = (await drawn()).find((d) => d.id === calm!.id);
        const tx = v?.x ?? calm.x;
        const tz = v?.z ?? calm.z;
        if (Math.hypot(tx - at.x, tz - at.z) < 2.6) break;
        await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.2), lookAt(at, { x: tx, z: tz }));
        await sleep(60);
      }
      await page.keyboard.up('KeyW');
      await sleep(500);
      if (tries === 0) {
        await page.screenshot({ path: shot('calm') });
        note(`shot pt2-pets-calm.png: the weakened wolf calmed (it sniffs: the "?" over it), the prompt "[E] Feed Raw Meat"; feedable ${JSON.stringify((await P()).feedable)}`);
      }
      await page.keyboard.press('KeyE');
      await sleep(300);
      const m = (await P()).meter;
      note(`meter: ${JSON.stringify(m)}`);
      if (!m) throw new Error('E did not start the taming meter');
      await sleep(Math.round(m.ms * 0.55));
      if (tries === 0) {
        await page.screenshot({ path: shot('taming') });
        note('shot pt2-pets-taming.png: the taming meter under the crosshair, hearts rising from the wolf');
      }
      for (let k = 0; k < 40; k++) {
        await sleep(150);
        const s = await P();
        if (!s.meter) {
          if (s.tamed) tamedName = s.tamed.name;
          note(`taming ended: ${JSON.stringify(s.notes.slice(-1))} tamed ${JSON.stringify(s.tamed)}`);
          break;
        }
      }
    }
    if (!tamedName) throw new Error('four tamings failed');
    // step back and to the side so the new pet is not behind your back
    await page.keyboard.down('KeyS');
    await sleep(450);
    await page.keyboard.up('KeyS');
    await page.keyboard.down('KeyA');
    await sleep(350);
    await page.keyboard.up('KeyA');
    {
      const at0 = await me();
      const pd = (await drawn()).find((d) => d.kind === 7);
      if (pd) await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.3), lookAt(at0, pd) - 0.25);
    }
    await sleep(120);
    await page.screenshot({ path: shot('tamed') });
    let st = await P();
    note(`shot pt2-pets-tamed.png: tamed! ${JSON.stringify(st.mine?.pets)}`);
    const pet = st.mine!.pets.find((p) => p.id === st.mine!.active)!;
    await page.evaluate((id) => (window as unknown as W).__lodestonePets!.actions()!.name(id, 'Fang'), pet.id);
    await page.evaluate(() => (window as unknown as W).__lodestonePets!.actions()!.dev(3, 260)); // a few levels for the panel
    await sleep(4500); // the level-up and feat banners fade

    // Following: walk east; the camera looks back past you at the pet trotting behind.
    const EAST = -Math.PI / 2;
    await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.2), EAST);
    await page.keyboard.down('KeyW');
    await sleep(2600);
    // keep walking and glance back over the shoulder at it trotting after you
    let at = await me();
    {
      const pd = (await drawn()).find((d) => d.id === pet.out);
      if (pd) await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.28), lookAt(at, pd) - 0.3);
    }
    await sleep(120);
    await page.screenshot({ path: shot('follow') });
    await page.keyboard.up('KeyW');
    at = await me();
    const pv = (await drawn()).find((d) => d.id === pet.out);
    note(`shot pt2-pets-follow.png: Fang following (${pv ? Math.hypot(pv.x - at.x, pv.z - at.z).toFixed(1) : '?'} m behind, nameplate "${pv?.name}", typeId 0x${(pv?.typeId ?? 0).toString(16)})`);

    // A fight: walk toward the bandit camp; the pet joins in.
    await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.2), EAST);
    // walk at the bandits until one is 5 m away; tap 6 aimed at it (the pet goes for it)
    let shotDone = false;
    let ordered = false;
    await page.keyboard.down('KeyW');
    for (let k = 0; k < 220 && !shotDone; k++) {
      await sleep(90);
      at = await me();
      const all = await drawn();
      const foes = all.filter((d) => d.kind === 2 && d.healthPct > 0).sort((a, b) => Math.hypot(a.x - at.x, a.z - at.z) - Math.hypot(b.x - at.x, b.z - at.z));
      if (!foes.length) break;
      const f = foes[0];
      const d = Math.hypot(f.x - at.x, f.z - at.z);
      await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.18), lookAt(at, f));
      if (d < 5.5) await page.keyboard.up('KeyW');
      if (d < 12 && !ordered) {
        ordered = true;
        await page.keyboard.press('Digit6'); // a tap: attack what the crosshair is on
        note(`6 tapped at ${f.name} (${d.toFixed(1)} m); aimed ${(await P()).aimed}`);
      }
      const pd = all.find((x) => x.id === pet.out);
      if (ordered && pd && d < 7 && Math.hypot(pd.x - f.x, pd.z - f.z) < 3.2) {
        // frame the pet and its foe: the camera looks between them
        await page.evaluate((y) => (window as unknown as W).__lodestone.setLook(y, -0.2), lookAt(at, { x: (pd.x + f.x) / 2, z: (pd.z + f.z) / 2 }) + 0.12);
        await sleep(150);
        await page.screenshot({ path: shot('fight') });
        note(`shot pt2-pets-fight.png: Fang biting ${f.name} beside you (pet health ${pd.healthPct}%, ${foes.map((x) => `${x.name} ${x.healthPct}%`).join(', ')})`);
        shotDone = true;
      }
    }
    await page.keyboard.up('KeyW');
    // let the fight finish
    for (let k = 0; k < 40; k++) {
      await sleep(250);
      at = await me();
      const foes = (await drawn()).filter((d) => d.kind === 2 && d.healthPct > 0 && Math.hypot(d.x - at.x, d.z - at.z) < 25);
      if (!foes.length) break;
    }
    st = await P();
    note(`after the fight: ${JSON.stringify(st.mine?.pets.map((p) => ({ name: p.name, lv: p.lv, hp: p.hp, out: p.out })))} notes ${JSON.stringify(st.notes)}`);

    // The pet wheel (hold 6).
    await page.keyboard.down('Digit6');
    await sleep(500);
    await page.mouse.move(640 + 90, 360 - 40);
    await sleep(200);
    await page.screenshot({ path: shot('wheel') });
    note('shot pt2-pets-wheel.png: the pet wheel (hold 6)');
    await page.mouse.move(640, 360); // back to the middle: no command
    await sleep(100);
    await page.keyboard.up('Digit6');
    await sleep(400);

    // The pet panel.
    await page.evaluate(() => (window as unknown as W).__lodestonePets!.panel(true));
    await sleep(700);
    await page.screenshot({ path: shot('panel') });
    st = await P();
    note(`shot pt2-pets-panel.png: the pet panel: ${JSON.stringify(st.mine)}`);
    await page.evaluate(() => (window as unknown as W).__lodestonePets!.panel(false));
  } finally {
    await browser?.close().catch(() => {});
    vite.kill();
    zone.kill();
    const rel = zoneLog.filter((l) => /tame|pet|violation|error/i.test(l)).slice(0, 40);
    fs.writeFileSync(path.join(out, 'pt2-pets-shots.txt'), [...lines, '', 'zone log (pets):', ...rel].join('\n') + '\n');
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    fs.appendFileSync(path.join(out, 'pt2-pets-shots.txt'), `ERROR ${e?.stack ?? e}\n`);
    process.exit(1);
  },
);
