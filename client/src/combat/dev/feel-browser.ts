// WP13 headless browser run: the real game client (Vite dev server, headless
// Chromium on the real GPU via ANGLE/D3D11, real mouse and keyboard events)
// connected to the real zone binary on the generated official world. It
// drives scripted feel sequences through the client's input-to-hit timing
// probe (client/src/combat/probe.ts), then fights a real generated enemy
// group, and records the probe summary and screenshots.
//
//   npm run combat:browser -w client      (needs Go, `npm run build:wasm`, Playwright Chromium)
//
// Writes docs/evidence/wp13-feel.{txt,json} and wp13-browser-*.png.
// LODESTONE_BENCH_GL=swiftshader forces software GL (real-time numbers are
// then meaningless: the frame period is the measurement floor).

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { devTicket } from '../../net/dev/devTicket';
import { buildZone, repoRoot, startZone, waitHttp } from '../../sim/dev/traversalRun';
import { spawn } from 'node:child_process';

const SEED = '20261108';
const out = path.join(repoRoot, 'docs', 'evidence');
const lines: string[] = [];
const note = (s: string) => {
  lines.push(s);
  console.log(s);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const software = process.env.LODESTONE_BENCH_GL === 'swiftshader';
const gpuArgs = software ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];

interface Handle {
  player(): { pos: { x: number; y: number; z: number }; seq: number };
  setLook(yaw: number | null, pitch?: number): void;
  setQuality(q: string): void;
  setFreezeTime(v: boolean): void;
  setTimeOfDay(s: number): void;
  connectZone(r: { ticket: string; zoneEndpoint: string; zoneId: string; worldId: string; name?: string }): void;
  netDebug(): { phase: string; prediction: { reconciles: number; agreements: number; maxError: number } } | null;
}
interface CombatHandle {
  probe(): Record<string, unknown>;
  hud(): { active: boolean; health: number };
}
type W = Window & { __lodestone: Handle; __lodestoneCombat?: CombatHandle };

interface Group {
  id: number;
  kind: string;
  x: number;
  y: number;
  z: number;
  level: number;
  enemies?: { id: number; key: string; x: number; z: number; hp: number; state: string }[];
}

// Near the official world's spawn settlement; the zone snaps dev placements
// to walkable ground (WalkableNear), and the browser spawns at the snapped
// anchor. Session 1 (feel sequences) has an EMPTY placement and no enemies
// at all, so nothing disturbs the timing probe; session 2 (the fight) puts a
// level-1 training camp at the same snapped spot and spawns the browser
// 6 m from it, facing it.
const HINT = { x: 1330, z: 2330 };

interface Session {
  page: import('playwright').Page;
  zonePort: number;
  anchor: Group;
  close(): Promise<void>;
  face(x: number, z: number): Promise<unknown>;
  click(hold?: number): Promise<void>;
}

async function openSession(vitePort: number, camp: string, offset: number, name: string): Promise<Session> {
  const zone = await startZone(buildZone(), SEED, { LODESTONE_ZONE_DEBUG_CAMP: `${HINT.x},${HINT.z},1,${camp}`, LODESTONE_ZONE_NO_ATLAS_ENEMIES: '1' });
  let dbg: { groups: Group[] } | null = null;
  for (let i = 0; i < 60 && !dbg?.groups; i++) {
    dbg = (await (await fetch(`http://127.0.0.1:${zone.port}/debug/combat`)).json()) as { groups: Group[] } | null;
    if (!dbg?.groups) await sleep(250);
  }
  const anchor = dbg?.groups.find((g) => g.kind === 'test');
  if (!anchor) throw new Error('the dev placement is missing');
  const spawnAt = { x: anchor.x + offset, z: anchor.z };
  const browser = await chromium.launch({ headless: true, args: gpuArgs });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => note(`  pageerror: ${e.message}`));
  await page.goto(`http://127.0.0.1:${vitePort}/?debug=1&rain=0`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!(window as unknown as W).__lodestone, null, { polling: 200, timeout: 60000 });
  const ticket = devTicket({ characterId: `wp13-${name}-${Date.now()}`, characterName: 'Feelprobe', worldId: zone.worldId, zoneId: zone.zoneId });
  await page.evaluate((r) => (window as unknown as W).__lodestone.connectZone(r), { ticket, zoneEndpoint: `ws://127.0.0.1:${zone.port}/ws?spawn=${spawnAt.x.toFixed(2)},${spawnAt.z.toFixed(2)}`, zoneId: zone.zoneId, worldId: zone.worldId, name: 'Feelprobe' });
  await page.waitForFunction(() => (window as unknown as W).__lodestone.netDebug()?.phase === 'playing' && (window as unknown as W).__lodestone.player().pos.y > 20 && !!(window as unknown as W).__lodestoneCombat?.hud().active, null, { polling: 250, timeout: 120000 });
  await page.evaluate(() => {
    const l = (window as unknown as W).__lodestone;
    l.setQuality('medium');
    l.setFreezeTime(true);
    l.setTimeOfDay(0.42 * 3600);
  });
  await page.mouse.move(640, 360);
  return {
    page,
    zonePort: zone.port,
    anchor,
    face: (tx, tz) =>
      page.evaluate(([x, z]) => {
        const l = (window as unknown as W).__lodestone;
        const p = l.player().pos;
        l.setLook(Math.atan2(-(x - p.x), -(z - p.z)), -0.18);
      }, [tx, tz]),
    click: async (hold = 40) => {
      await page.mouse.down();
      await sleep(hold);
      await page.mouse.up();
    },
    close: async () => {
      await browser.close();
      zone.proc.kill();
    },
  };
}

async function main() {
  const vitePort = 5300 + Math.floor(Math.random() * 400);
  const vite = spawn(process.execPath, [path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], { cwd: path.join(repoRoot, 'client'), stdio: 'ignore' });
  await waitHttp(`http://127.0.0.1:${vitePort}/`, 90000);
  const result: Record<string, unknown> = { software };
  try {
    // ---- session 1: the feel sequences, no enemies ----
    const s1 = await openSession(vitePort, ' ', 0, 'feel');
    const { page, click } = s1;
    await page.evaluate(() => (window as unknown as W).__lodestone.setLook(Math.PI / 2, -0.1));
    await sleep(2500);
    const fps = await page.evaluate(() => new Promise<number>((res) => {
      let n = 0;
      const t0 = performance.now();
      const f = () => (++n < 60 ? requestAnimationFrame(f) : res((n * 1000) / (performance.now() - t0)));
      requestAnimationFrame(f);
    }));
    note(`session 1 (feel, no enemies) at (${s1.anchor.x.toFixed(0)}, ${s1.anchor.z.toFixed(0)}): render rate ${fps.toFixed(0)} fps (${software ? 'SwiftShader' : 'ANGLE/D3D11 GPU'})`);
    // A1: single light attacks (press -> first hit frame).
    for (let i = 0; i < 20; i++) {
      await click();
      await sleep(650);
    }
    // A2: a second press during the move, ~100 ms before it ends (inside the 150 ms buffer).
    for (let i = 0; i < 8; i++) {
      await click(30);
      await sleep(270);
      await click(30);
      await sleep(900);
    }
    // A3: dodge-cancel: attack, dodge right after the hit frames, attack.
    for (let i = 0; i < 8; i++) {
      await click(30);
      await sleep(190);
      await page.keyboard.press('KeyF');
      await sleep(40);
      await click(30);
      await sleep(1000);
    }
    // A4: dodges (i-frames).
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('KeyF');
      await sleep(700);
    }
    // A5: drink while walking.
    await page.keyboard.down('KeyD');
    await sleep(700);
    await page.keyboard.press('KeyR');
    await sleep(1400);
    await page.keyboard.press('KeyR');
    await sleep(1000);
    await page.keyboard.up('KeyD');
    await sleep(500);
    await page.screenshot({ path: path.join(out, 'wp13-browser-hud.png') });
    const feel = await page.evaluate(() => (window as unknown as W).__lodestoneCombat!.probe());
    const net1 = await page.evaluate(() => (window as unknown as W).__lodestone.netDebug());
    note(`feel probe: ${JSON.stringify(feel)}`);
    note(`prediction: ${JSON.stringify(net1?.prediction ? { reconciles: net1.prediction.reconciles, agreements: net1.prediction.agreements } : null)}`);
    Object.assign(result, { fps, feel, feelPrediction: net1?.prediction });
    await s1.close();

    // ---- session 2: a fight with a level-1 training camp ----
    const s2 = await openSession(vitePort, 'boar', 6, 'fight');
    note(`session 2 (fight): training camp (a level-1 boar) at (${s2.anchor.x.toFixed(0)}, ${s2.anchor.z.toFixed(0)}), the browser 6 m east of it`);
    const p2 = s2.page;
    await s2.face(s2.anchor.x, s2.anchor.z);
    const t0 = Date.now();
    let shots = 0;
    let seen = 0;
    while (Date.now() - t0 < 45000) {
      const st = await p2.evaluate(() => {
        const views = (window as unknown as { __lodestoneDrawn?: () => { x: number; z: number; healthPct: number; kind: number }[] }).__lodestoneDrawn?.() ?? [];
        const p = (window as unknown as W).__lodestone.player().pos;
        let best: { x: number; z: number } | null = null;
        let bd = 1e9;
        let n = 0;
        for (const v of views) {
          if (v.kind !== 2 || v.healthPct === 0) continue;
          n++;
          const d = Math.hypot(v.x - p.x, v.z - p.z);
          if (d < bd) {
            bd = d;
            best = v;
          }
        }
        return { best, bd, n };
      });
      seen = Math.max(seen, st.n);
      if (!st.best) {
        if (Date.now() - t0 > 8000) break;
        await sleep(200);
        continue;
      }
      await s2.face(st.best.x, st.best.z);
      if (st.bd > 2.4) {
        await p2.keyboard.down('KeyW');
        await sleep(Math.min(350, (st.bd - 2) * 150));
        await p2.keyboard.up('KeyW');
      }
      // Screenshot BEFORE the swing: a capture stalls the page, and a stall
      // inside a hitstop would distort its measurement.
      if (st.bd < 7 && shots < 3 && Date.now() - t0 > 600 + shots * 1800) {
        await p2.screenshot({ path: path.join(out, `wp13-browser-fight-${shots + 1}.png`) });
        shots++;
      }
      await s2.click(30);
      await sleep(220);
      if (Math.random() < 0.15) await p2.keyboard.press('KeyF');
    }
    const fight = await p2.evaluate(() => (window as unknown as W).__lodestoneCombat!.probe());
    const after = (await (await fetch(`http://127.0.0.1:${s2.zonePort}/debug/combat`)).json()) as { stats: unknown; groups: Group[] };
    note(`fight: ${seen} enemies seen, ${shots} screenshots`);
    note(`fight probe: ${JSON.stringify(fight)}`);
    note(`zone combat stats: ${JSON.stringify(after.stats)}`);
    Object.assign(result, { fight, zoneStats: after.stats, camp: after.groups.find((g) => g.kind === 'test') });
    fs.writeFileSync(path.join(out, 'wp13-feel.json'), JSON.stringify(result, null, 2) + '\n');
    await s2.close();
  } finally {
    fs.writeFileSync(path.join(out, 'wp13-feel.txt'), lines.join('\n') + '\n');
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
