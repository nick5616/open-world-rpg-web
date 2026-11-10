// Playtest 2 achievements evidence (CR 031): the real client (Vite) against
// the real zone binary on the official world (seed 20261108: content is on),
// one headless browser, one player. The player equips Magma Dash (the zone
// teaches it: LODESTONE_ZONE_DEBUG_SPELLS), holds the jet looking up, then
// flies level more than 6 m above the ground for a few seconds: the zone's
// flight detection unlocks "Tony Stark built this in a cave with scraps".
// The script waits for that toast, then opens the Achievements screen (Y)
// on the Secrets category.
//
//   cd client && npx vite-node src/ui/achievements/dev/achievements-shots.ts
//
// Needs Go (the zone is built from this checkout) and worldgen/pkg/worldgen.wasm.
// Writes docs/evidence/pt2-achievements-toast.jpg, pt2-achievements-screen.jpg
// and prints what it saw.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright';
import { COMBAT } from '@lodestone/contracts';
import { devTicket } from '../../../net/dev/devTicket';
import { buildZone, freePort, repoRoot, startZone, waitHttp, type ZoneProc } from '../../../sim/dev/traversalRun';

const SEED = '20261108';
// The open shore of the dash evidence (combat/dev/dash-shots.ts): open sky, the lake to the south.
const SHORE = { x: 1418, z: 1852 };
const LAKE = { x: 1418, z: 1950 };
const TONY = 'Tony Stark built this in a cave with scraps';
const JPG = { type: 'jpeg' as const, quality: 80 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Handle {
  player(): { pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number }; mode: string; dash: number };
  setLook(yaw: number | null, pitch?: number): void;
  setQuality(q: string): void;
  setFreezeTime(v: boolean): void;
  setTimeOfDay(s: number): void;
  connectZone(r: { ticket: string; zoneEndpoint: string; zoneId: string; worldId: string; name?: string }): void;
  netDebug(): { phase: string } | null;
}
interface CombatHandle {
  runtime: { press(slot: number): void; holdCast(slot: number, on: boolean): void; timeline: { mana: number }; link: { sendInteract(k: number, id: bigint, a: number, arg: number): void } };
  hud(): { active: boolean; loadouts: { spells: (string | null)[] }[]; mana: number };
}
interface AchHandle {
  state(): { open: boolean; toasts: { current: { name: string } | null; queue: { name: string }[] } };
  open(v?: boolean): void;
  sync(): { feats: string[]; points: number };
}
type W = Window & { __lodestone: Handle; __lodestoneCombat?: CombatHandle; __lodestoneAchievements?: AchHandle; __lodestoneIntro?: { volume(v?: number): number; skip(): void } };

const yawTo = (from: { x: number; z: number }, to: { x: number; z: number }) => Math.atan2(-(to.x - from.x), -(to.z - from.z));

async function join(browser: Browser, vitePort: number, zone: ZoneProc): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log(`  pageerror: ${e.message}`));
  await page.goto(`http://127.0.0.1:${vitePort}/?debug=1&rain=0&view=third`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!(window as unknown as W).__lodestone, null, { polling: 200, timeout: 60000 });
  const ticket = devTicket({ characterId: `pt2ach-${Date.now()}`, characterName: 'Ironclad', worldId: zone.worldId, zoneId: zone.zoneId });
  await page.evaluate((r) => (window as unknown as W).__lodestone.connectZone(r), { ticket, zoneEndpoint: `ws://127.0.0.1:${zone.port}/ws?spawn=${SHORE.x},${SHORE.z}`, zoneId: zone.zoneId, worldId: zone.worldId, name: 'Ironclad' });
  await page.waitForFunction(
    () => {
      const w = window as unknown as W;
      return w.__lodestone.netDebug()?.phase === 'playing' && w.__lodestone.player().pos.y > 20 && !!w.__lodestoneCombat?.hud().active && !!w.__lodestoneAchievements;
    },
    null,
    { polling: 250, timeout: 180000 },
  );
  await page.evaluate(() => {
    const l = (window as unknown as W).__lodestone;
    l.setQuality('high');
    l.setFreezeTime(true);
    l.setTimeOfDay(0.45 * 3600);
    (window as unknown as W).__lodestoneIntro?.volume(0);
  });
  await page.mouse.move(640, 360);
  await page.keyboard.press('F3'); // hide the debug readout
  // The arrival cards and the welcome card own the screen first (the toast waits for them).
  for (let k = 0; k < 40; k++) {
    await page.evaluate(() => (window as unknown as W).__lodestoneIntro?.skip());
    const close = page.getByTestId('whatsnew-close');
    if (await close.isVisible().catch(() => false)) await close.click().catch(() => {});
    await sleep(250);
  }
  return page;
}

/** Puts a known spell in slot 4 of loadout 0 (Interact 50 action 3), as dash-shots.ts does. */
async function equip(page: Page, key: string): Promise<void> {
  const id = COMBAT.spells.find((s) => s.key === key)!.id;
  await page.evaluate((sid) => (window as unknown as W).__lodestoneCombat!.runtime.link.sendInteract(50, 0n, 3, 0 | (3 << 4) | (sid << 8)), id);
  await page.waitForFunction((k) => (window as unknown as W).__lodestoneCombat!.hud().loadouts[0]?.spells[3] === k, key, { polling: 100, timeout: 10000 });
}

const me = (p: Page) => p.evaluate(() => (window as unknown as W).__lodestone.player());
const look = (p: Page, yaw: number, pitch: number) => p.evaluate(([y, pi]) => (window as unknown as W).__lodestone.setLook(y, pi), [yaw, pitch] as const);
const toastName = (p: Page) => p.evaluate(() => (window as unknown as W).__lodestoneAchievements!.state().toasts.current?.name ?? '');

/** Up like a rocket, then level jet flight well above the ground: the zone's "take flight". */
async function fly(page: Page, yaw: number): Promise<{ maxY: number; y0: number }> {
  const y0 = (await me(page)).pos.y;
  let maxY = y0;
  await look(page, yaw, 1.15);
  await page.evaluate(() => {
    const rt = (window as unknown as W).__lodestoneCombat!.runtime;
    rt.holdCast(3, true);
    rt.press(3);
  });
  const t0 = Date.now();
  let levelled = false;
  while (Date.now() - t0 < 3600) {
    if (!levelled && Date.now() - t0 > 650) {
      await look(page, yaw, 0.12); // level off, a touch nose-up
      levelled = true;
    }
    maxY = Math.max(maxY, (await me(page)).pos.y);
    await sleep(100);
  }
  await page.evaluate(() => (window as unknown as W).__lodestoneCombat!.runtime.holdCast(3, false));
  return { maxY, y0 };
}

async function main(): Promise<void> {
  const out = path.join(repoRoot, 'docs', 'evidence');
  fs.mkdirSync(out, { recursive: true });
  const bin = buildZone();
  const vitePort = await freePort();
  const viteBin = path.join(path.dirname(createRequire(path.join(repoRoot, 'client', 'package.json')).resolve('vite/package.json')), 'bin', 'vite.js');
  const vite = spawn(process.execPath, [viteBin, '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], { cwd: path.join(repoRoot, 'client'), stdio: 'ignore' });
  let zone: ZoneProc | null = null;
  let browser: Browser | null = null;
  try {
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 90000);
    zone = await startZone(bin, SEED, {
      LODESTONE_ZONE_DEBUG_SPELLS: 'magma_dash',
      LODESTONE_ZONE_NO_DEMONS: '1',
      LODESTONE_ZONE_NO_WILD_PACKS: '1',
      LODESTONE_ZONE_NO_ATLAS_ENEMIES: '1',
      LODESTONE_ZONE_NO_WORLD_EVENTS: '1',
    });
    console.log(`zone :${zone.port}, vite :${vitePort}`);
    browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
    const page = await join(browser, vitePort, zone);
    await equip(page, 'magma_dash');
    const yaw = yawTo(SHORE, LAKE);
    // 1. Take flight; the toast queue may show "Zoom" (the first dash) and a level-up first.
    let shot = false;
    for (let attempt = 1; attempt <= 3 && !shot; attempt++) {
      const f = await fly(page, yaw);
      console.log(`flight ${attempt}: from y ${f.y0.toFixed(1)} up to ${f.maxY.toFixed(1)}`);
      const t0 = Date.now();
      while (Date.now() - t0 < 40000) {
        const name = await toastName(page);
        if (name === TONY && (await page.getByTestId('achievement-toast').isVisible().catch(() => false))) {
          await sleep(500); // the card's fade-in
          await page.screenshot({ path: path.join(out, 'pt2-achievements-toast.jpg'), ...JPG });
          console.log('shot pt2-achievements-toast.jpg');
          shot = true;
          break;
        }
        const earned = await page.evaluate(() => (window as unknown as W).__lodestoneAchievements!.sync().feats);
        if (!earned.includes('tony_stark') && Date.now() - t0 > 8000) break; // not earned: fly again
        await sleep(200);
      }
      if (!shot) await sleep(4000); // mana back
    }
    if (!shot) throw new Error('no Tony Stark toast (see the zone log)\n' + zone.log.filter((l) => /achiev|feat|dash/i.test(l)).slice(-30).join('\n'));
    // 2. The Achievements screen (Y), on the Secrets category: the one just earned and the others still "???".
    await page.waitForFunction(() => !(window as unknown as W).__lodestoneAchievements!.state().toasts.current, null, { polling: 250, timeout: 30000 }).catch(() => {});
    await page.keyboard.press('KeyY');
    await page.getByTestId('achievements-panel').waitFor({ timeout: 10000 });
    await page.getByTestId('ach-cat-secrets').click();
    await sleep(1500); // the screen asks the zone for fresh counters on open
    await page.screenshot({ path: path.join(out, 'pt2-achievements-screen.jpg'), ...JPG });
    const s = await page.evaluate(() => (window as unknown as W).__lodestoneAchievements!.sync());
    console.log(`shot pt2-achievements-screen.jpg; earned ${s.feats.join(', ')}; ${s.points} points`);
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
