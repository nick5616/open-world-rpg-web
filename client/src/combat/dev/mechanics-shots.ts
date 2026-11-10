// CR 020 spell mechanics end to end: two real clients (Vite, headless
// Chromium on the GPU) on a real zone process with training camps. "Caster"
// learns each new spell (dev Interact 50 action 7, a tome stand-in) and uses
// it through the real runtime (held keys for streams and charges); "Watcher"
// stands aside and sees it through Events 223 (streams, charges), 214, 224
// (bursts), 225 (ally attacks) and the allies' entities.
//
//   npx vite-node src/combat/dev/mechanics-shots.ts      (from client/; needs Go and the worldgen wasm)
//
// Writes docs/evidence/pt2-spell-mechanics-{streams,homing,charge-orbit,bursts,summons}.jpg
// and pt2-spell-mechanics-run.json (claims accepted/refused per spell, FX counters).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright';
import { COMBAT } from '@lodestone/contracts';
import { devTicket } from '../../net/dev/devTicket';
import { buildZone, repoRoot, startZone, waitHttp, type ZoneProc } from '../../sim/dev/traversalRun';

const SEED = '20261108';
const HINT = { x: 1330, z: 2330 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Handle {
  player(): { pos: { x: number; y: number; z: number } };
  setLook(yaw: number | null, pitch?: number): void;
  setQuality(q: string): void;
  setFreezeTime(v: boolean): void;
  setTimeOfDay(s: number): void;
  connectZone(r: { ticket: string; zoneEndpoint: string; zoneId: string; worldId: string; name?: string }): void;
  netDebug(): { phase: string } | null;
}
interface CombatHandle {
  runtime: { press(slot: number): void; hold(slot: number, on: boolean): void; timeline: { mana: number } };
  hud(): { active: boolean; known: number[]; loadouts: { spells: (string | null)[] }[]; activeLoadout: number; mana: number };
  interact(kind: number, action: number, arg: number): void;
}
interface FxHandle {
  stats(): Record<string, number>;
}
type W = Window & { __lodestone: Handle; __lodestoneCombat?: CombatHandle; __lodestoneFx?: FxHandle; __lodestoneDrawn?: () => { id: number; kind: number; x: number; z: number; healthPct: number }[] };

async function join(browser: Browser, vitePort: number, zone: ZoneProc, name: string, at: { x: number; z: number }): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [${name}] pageerror: ${e.message}`));
  await page.goto(`http://127.0.0.1:${vitePort}/?debug=1&rain=0`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!(window as unknown as W).__lodestone, null, { polling: 200, timeout: 60000 });
  const ticket = devTicket({ characterId: `pt2mech-${name}-${Date.now()}`, characterName: name, worldId: zone.worldId, zoneId: zone.zoneId });
  await page.evaluate((r) => (window as unknown as W).__lodestone.connectZone(r), { ticket, zoneEndpoint: `ws://127.0.0.1:${zone.port}/ws?spawn=${at.x.toFixed(2)},${at.z.toFixed(2)}`, zoneId: zone.zoneId, worldId: zone.worldId, name });
  await page.waitForFunction(() => (window as unknown as W).__lodestone.netDebug()?.phase === 'playing' && (window as unknown as W).__lodestone.player().pos.y > 20 && !!(window as unknown as W).__lodestoneCombat?.hud().active && !!(window as unknown as W).__lodestoneFx, null, { polling: 250, timeout: 120000 });
  await page.evaluate(() => {
    const l = (window as unknown as W).__lodestone;
    l.setQuality('high');
    l.setFreezeTime(true);
    l.setTimeOfDay(0.45 * 3600);
  });
  await page.mouse.move(640, 360);
  await page.keyboard.press('F3'); // hide the debug HUD
  return page;
}

const face = (page: Page, x: number, z: number, pitch = -0.12, yawOff = 0) =>
  page.evaluate(([tx, tz, p, o]) => {
    const l = (window as unknown as W).__lodestone;
    const me = l.player().pos;
    l.setLook(Math.atan2(-(tx - me.x), -(tz - me.z)) + o, p);
  }, [x, z, pitch, yawOff] as const);

async function sheet(browser: Browser, file: string, title: string, imgs: { label: string; png: Buffer }[]): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 400 } });
  const cells = imgs.map((i) => `<figure><img src="data:image/png;base64,${i.png.toString('base64')}" width="640" height="360"><figcaption>${i.label}</figcaption></figure>`).join('');
  await page.setContent(`<html><body style="margin:0;background:#111;color:#ddd;font:14px system-ui"><div style="padding:8px 10px;font-weight:600">${title}</div><div style="display:grid;grid-template-columns:repeat(2,640px)">${cells}</div><style>figure{margin:0}figcaption{height:22px;line-height:22px;padding:0 8px;background:#1c1c1c;overflow:hidden;white-space:nowrap}img{display:block}</style></body></html>`);
  await page.screenshot({ path: file, fullPage: true, type: 'jpeg', quality: 86 });
  await page.close();
  console.log(file);
}

async function main() {
  const bin = buildZone();
  const vitePort = 20000 + Math.floor(Math.random() * 25000);
  const viteBin = path.join(path.dirname(createRequire(path.join(repoRoot, 'client', 'package.json')).resolve('vite/package.json')), 'bin', 'vite.js');
  const vite = spawn(process.execPath, [viteBin, '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], { cwd: path.join(repoRoot, 'client'), stdio: 'ignore' });
  let zone: ZoneProc | null = null;
  let browser: Browser | null = null;
  const report: Record<string, unknown> = {};
  try {
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 90000);
    // A training camp of dummies (dev placement's `dummy` flag: they stand and take hits), sturdy
    // enough (level 20) to survive the whole run, so every mechanic has something to hit.
    zone = await startZone(bin, SEED, { LODESTONE_ZONE_DEBUG_CAMP: `${HINT.x},${HINT.z},20,sentinel boar wolf ram brute sentinel,,dummy`, LODESTONE_ZONE_NO_ATLAS_ENEMIES: '1', LODESTONE_ZONE_NO_DEMONS: '1' });
    let anchor: { x: number; z: number } | null = null;
    for (let i = 0; i < 60 && !anchor; i++) {
      const dbg = (await (await fetch(`http://127.0.0.1:${zone.port}/debug/combat`)).json()) as { groups?: { kind: string; x: number; z: number }[] } | null;
      anchor = dbg?.groups?.find((g) => g.kind === 'test') ?? null;
      if (!anchor) await sleep(250);
    }
    if (!anchor) throw new Error('no training camp');
    const A = { ...anchor };
    const home = { ...anchor };
    browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
    const caster = await join(browser, vitePort, zone, 'Caster', { x: home.x + 14, z: home.z });
    const watcher = await join(browser, vitePort, zone, 'Watcher', { x: home.x + 11, z: home.z + 10 });
    await sleep(1500);
    // The caster looks at the nearest living slime (its chest), yawOff radians to the side.
    const aim = async (yawOff = 0, pitchAdd = 0) => {
      const t = await caster.evaluate(([o, pa]) => {
        const l = (window as unknown as W).__lodestone;
        const me = l.player().pos;
        const vs = ((window as unknown as W).__lodestoneDrawn?.() ?? []).filter((v) => v.kind === 2 && v.healthPct > 0) as { x: number; y?: number; z: number }[];
        vs.sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z));
        const e = vs[0];
        if (!e) return null;
        const d = Math.hypot(e.x - me.x, e.z - me.z);
        l.setLook(Math.atan2(-(e.x - me.x), -(e.z - me.z)) + o, Math.atan2((e.y ?? me.y) + 0.7 - (me.y + 1.6), d) + pa);
        return { x: e.x, z: e.z };
      }, [yawOff, pitchAdd] as const);
      if (t) {
        A.x = t.x;
        A.z = t.z;
      }
    };
    const drink = async () => {
      const low = await caster.evaluate(() => {
        const h = (window as unknown as W).__lodestoneCombat!.hud() as unknown as { health?: number; healthMax?: number };
        return (h.health ?? 100) < (h.healthMax ?? 100) * 0.5;
      });
      if (low) await caster.evaluate(() => (window as unknown as W).__lodestoneCombat!.runtime.press('drink' as unknown as number));
    };
    const stats = async (p: Page) => p.evaluate(() => (window as unknown as W).__lodestoneFx!.stats());
    const claims = async () => (await (await fetch(`http://127.0.0.1:${zone!.port}/debug/combat`)).json()) as { stats: { ClaimsAccepted: number; ClaimsRefused: number; Kills: number } };
    // Learn and slot a spell (slot 0 of the active loadout), then wait for combat_sync.
    const equip = async (key: string) => {
      const sp = COMBAT.spells.find((s) => s.key === key)!;
      await caster.evaluate((id) => {
        const c = (window as unknown as W).__lodestoneCombat!;
        c.interact(50, 7, id);
        c.interact(50, 3, c.hud().activeLoadout | (0 << 4) | (id << 8));
      }, sp.id);
      await caster.waitForFunction((k) => (window as unknown as W).__lodestoneCombat!.hud().loadouts[(window as unknown as W).__lodestoneCombat!.hud().activeLoadout]?.spells[0] === k, key, { timeout: 10000 });
    };
    const waitMana = async (min: number) => {
      await caster.waitForFunction((m) => (window as unknown as W).__lodestoneCombat!.runtime.timeline.mana >= m, min, { timeout: 30000, polling: 200 });
    };
    // The watcher frames the caster and the camp.
    const frameWatcher = async () => {
      const cp = await caster.evaluate(() => (window as unknown as W).__lodestone.player().pos);
      await face(watcher, (cp.x * 2 + A.x) / 3, (cp.z * 2 + A.z) / 3, -0.16);
    };
    const snap = async (out: { label: string; png: Buffer }[], label: string) => {
      out.push({ label: `${label}: caster`, png: await caster.screenshot() });
      out.push({ label: `${label}: watcher (another player)`, png: await watcher.screenshot() });
    };
    const record = async (key: string, before: { stats: { ClaimsAccepted: number; ClaimsRefused: number } }) => {
      const after = await claims();
      report[key] = { accepted: after.stats.ClaimsAccepted - before.stats.ClaimsAccepted, refused: after.stats.ClaimsRefused - before.stats.ClaimsRefused, watcherFx: await stats(watcher) };
      console.log(key, JSON.stringify(report[key]).slice(0, 200));
    };

    // ---- Streams: hold to fire ----
    const streams: { label: string; png: Buffer }[] = [];
    for (const [key, label, pitch] of [
      ['cinder_spray', 'Cinder Spray (fire, tier 1): hold to spray sparks, 12/s', 0.02],
      ['arc_sparks', 'Arc Sparks (lightning, tier 2): 15/s, shock', 0.02],
      ['frost_bubbles', 'Frost Bubbles (ice, tier 2): drifting bubbles that pop and slow', 0.0],
      ['starfall_hail', 'Starfall Hail (void, tier 3): hail falls around the aim point', -0.06],
    ] as const) {
      await equip(key);
      await waitMana(60);
      await drink();
      await aim(0, pitch);
      await frameWatcher();
      const before = await claims();
      await caster.evaluate(() => (window as unknown as W).__lodestoneCombat!.runtime.hold(0, true));
      await sleep(900);
      await snap(streams, label);
      await sleep(400);
      await caster.evaluate(() => (window as unknown as W).__lodestoneCombat!.runtime.hold(0, false));
      await sleep(900);
      await record(key, before);
    }
    await sheet(browser, path.join(repoRoot, 'docs', 'evidence', 'pt2-spell-mechanics-streams.jpg'), 'Hold-to-fire streams (CR 020): the caster holds the key; the watcher sees the stream simulated from Event 223 (start + seed, no event per bullet)', streams);

    // ---- Homing ----
    const homing: { label: string; png: Buffer }[] = [];
    for (const [key, label, off, ms] of [
      ['guiding_motes', 'Guiding Motes (light, tier 1): aimed 35 deg off the slime, the motes curve in', 0.6, 300],
      ['storm_seekers', 'Storm Seekers (lightning, tier 3): a fan that curves in after 0.3 s', 0.4, 520],
      ['hungering_souls', 'Hungering Souls (dark, tier 3): four souls hunt, heal you on hit', 0.5, 700],
    ] as const) {
      await equip(key);
      await waitMana(30);
      await drink();
      await aim(off, 0.02);
      await frameWatcher();
      const before = await claims();
      await caster.evaluate(() => (window as unknown as W).__lodestoneCombat!.runtime.press(0));
      await sleep(ms);
      await snap(homing, label);
      await sleep(1600);
      await record(key, before);
    }
    await sheet(browser, path.join(repoRoot, 'docs', 'evidence', 'pt2-spell-mechanics-homing.jpg'), 'Homing (CR 020): shots fly straight for their delay, lock the nearest target in their cone and turn in; the zone re-flies the same 1/60 s path to accept the hit', homing);

    // ---- Charge and orbit ----
    const co: { label: string; png: Buffer }[] = [];
    await equip('boulder_heave');
    await waitMana(30);
    await aim(0, 0.12);
    await frameWatcher();
    let before = await claims();
    await caster.evaluate(() => (window as unknown as W).__lodestoneCombat!.runtime.hold(0, true));
    await sleep(1150);
    await snap(co, 'Boulder Heave (earth, tier 3): holding, the boulder gathers (up to x2.75)');
    await caster.evaluate(() => (window as unknown as W).__lodestoneCombat!.runtime.hold(0, false));
    await sleep(700);
    await snap(co, 'Boulder Heave: released at full charge, wider burst');
    await record('boulder_heave', before);
    await equip('whirling_blades');
    await waitMana(30);
    await aim(0, -0.3);
    await frameWatcher();
    before = await claims();
    await caster.evaluate(() => (window as unknown as W).__lodestoneCombat!.runtime.press(0));
    await sleep(700);
    await snap(co, 'Whirling Blades (wind, tier 3): three blades orbit you for 8 s');
    await sleep(2500);
    await record('whirling_blades', before);
    await sheet(browser, path.join(repoRoot, 'docs', 'evidence', 'pt2-spell-mechanics-charge-orbit.jpg'), 'Hold to empower and orbiting blades (CR 020)', co);

    // ---- Bursts: delayed charge and brand chain ----
    const bursts: { label: string; png: Buffer }[] = [];
    await equip('burrowing_seed');
    await waitMana(30);
    await aim(0, 0);
    await frameWatcher();
    before = await claims();
    await caster.evaluate(() => (window as unknown as W).__lodestoneCombat!.runtime.press(0));
    await sleep(1650);
    await snap(bursts, 'Burrowing Seed (earth, tier 4): the seed bursts 1.5 s after it hits (Event 224)');
    await record('burrowing_seed', before);
    await equip('pyre_brand');
    await waitMana(30);
    await aim(0, 0);
    before = await claims();
    await caster.evaluate(() => (window as unknown as W).__lodestoneCombat!.runtime.press(0));
    await sleep(600);
    await snap(bursts, 'Pyre Brand (fire, tier 4): a fan brands the pack; a branded death bursts and chains');
    await record('pyre_brand', before);
    await sheet(browser, path.join(repoRoot, 'docs', 'evidence', 'pt2-spell-mechanics-bursts.jpg'), 'Delayed detonation and chain-reaction brands (CR 020): the zone resolves the bursts itself', bursts);

    // ---- Summons ----
    const sum: { label: string; png: Buffer }[] = [];
    for (const [key, label] of [
      ['wraith_hound', 'Wraith Hound (dark, tier 4): a spectral hound hunts for 15 s'],
      ['gale_phantom', 'Gale Phantom (wind, tier 4): a phantom archer keeps its distance and shoots'],
      ['sunlit_sentinel', 'Sunlit Sentinel (light, tier 5): a crystal turret where you aim, sears demons'],
    ] as const) {
      await equip(key);
      await waitMana(30);
      await drink();
      await aim(0, -0.1);
      await frameWatcher();
      before = await claims();
      await caster.evaluate(() => (window as unknown as W).__lodestoneCombat!.runtime.press(0));
      await sleep(1800);
      await snap(sum, label);
      const allies = await watcher.evaluate(() => ((window as unknown as W).__lodestoneDrawn?.() ?? []).filter((v) => v.kind === 7).length);
      report[`${key}_alliesSeenByWatcher`] = allies;
      await record(key, before);
    }
    await sheet(browser, path.join(repoRoot, 'docs', 'evidence', 'pt2-spell-mechanics-summons.jpg'), 'Summoned allies (CR 020): zone-side bodies owned by the caster (EntityKind effect), attacking enemies (Event 225)', sum);
    fs.writeFileSync(path.join(repoRoot, 'docs', 'evidence', 'pt2-spell-mechanics-run.json'), JSON.stringify(report, null, 2) + '\n');
  } finally {
    await browser?.close();
    zone?.proc.kill();
    vite.kill();
  }
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
