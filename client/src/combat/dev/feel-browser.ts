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
import { chromium, type Page } from 'playwright';
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

async function main() {
  const zone = await startZone(buildZone(), SEED);
  const dbg = (await (await fetch(`http://127.0.0.1:${zone.port}/debug/combat`)).json()) as { groups: Group[] };
  const groups = dbg.groups.filter((g) => (g.kind === 'pack' || g.kind === 'camp') && g.level <= 3);
  groups.sort((a, b) => a.level - b.level || Math.hypot(a.x - 1228, a.z - 2410) - Math.hypot(b.x - 1228, b.z - 2410));
  const target = groups[0];
  if (!target) throw new Error('no low-level group on the official world');
  const spawnAt = { x: target.x + 30, z: target.z };
  note(`target group #${target.id} ${target.kind} lvl ${target.level} at (${target.x.toFixed(0)}, ${target.z.toFixed(0)}); browser spawns 30 m east`);

  const vitePort = 5300 + Math.floor(Math.random() * 400);
  const vite = spawn(process.execPath, [path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], { cwd: path.join(repoRoot, 'client'), stdio: 'ignore' });
  await waitHttp(`http://127.0.0.1:${vitePort}/`, 90000);
  const browser = await chromium.launch({ headless: true, args: gpuArgs });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => note(`  pageerror: ${e.message}`));
  try {
    await page.goto(`http://127.0.0.1:${vitePort}/?debug=1&rain=0`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!(window as unknown as W).__lodestone, null, { polling: 200, timeout: 60000 });
    const ticket = devTicket({ characterId: `wp13-browser-${Date.now()}`, characterName: 'Feelprobe', worldId: zone.worldId, zoneId: zone.zoneId });
    await page.evaluate((r) => (window as unknown as W).__lodestone.connectZone(r), { ticket, zoneEndpoint: `ws://127.0.0.1:${zone.port}/ws?spawn=${spawnAt.x.toFixed(2)},${spawnAt.z.toFixed(2)}`, zoneId: zone.zoneId, worldId: zone.worldId, name: 'Feelprobe' });
    await page.waitForFunction(() => (window as unknown as W).__lodestone.netDebug()?.phase === 'playing' && (window as unknown as W).__lodestone.player().pos.y > 20 && !!(window as unknown as W).__lodestoneCombat?.hud().active, null, { polling: 250, timeout: 120000 });
    await page.evaluate(() => {
      const l = (window as unknown as W).__lodestone;
      l.setQuality('medium');
      l.setFreezeTime(true);
      l.setTimeOfDay(0.42 * 3600);
    });
    // Face the group (yaw 0 faces -Z; the group is west: -X).
    const face = async (tx: number, tz: number) =>
      page.evaluate(([x, z]) => {
        const l = (window as unknown as W).__lodestone;
        const p = l.player().pos;
        l.setLook(Math.atan2(-(x - p.x), -(z - p.z)), -0.12);
      }, [tx, tz]);
    await face(target.x, target.z);
    await sleep(2500);
    const fps = await page.evaluate(() => new Promise<number>((res) => {
      let n = 0;
      const t0 = performance.now();
      const f = () => (++n < 60 ? requestAnimationFrame(f) : res((n * 1000) / (performance.now() - t0)));
      requestAnimationFrame(f);
    }));
    note(`render rate ${fps.toFixed(0)} fps (${software ? 'SwiftShader' : 'ANGLE/D3D11 GPU'})`);
    const cx = 640;
    const cy = 360;
    await page.mouse.move(cx, cy);
    const click = async (hold = 40) => {
      await page.mouse.down();
      await sleep(hold);
      await page.mouse.up();
    };
    // A1: single light attacks (press -> first hit frame).
    for (let i = 0; i < 14; i++) {
      await click();
      await sleep(650);
    }
    // A2: presses during the animation (buffer) -> recovery measured.
    for (let i = 0; i < 6; i++) {
      await click(30);
      await sleep(200);
      await click(30);
      await sleep(900);
    }
    // A3: dodge-cancel: attack, dodge right after the hit frames, attack.
    for (let i = 0; i < 6; i++) {
      await click(30);
      await sleep(190);
      await page.keyboard.press('KeyF');
      await sleep(40);
      await click(30);
      await sleep(1000);
    }
    // A4: dodges (i-frames).
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('KeyF');
      await sleep(700);
    }
    // A5: drink while walking (strafe so we keep our distance).
    await page.keyboard.down('KeyD');
    await sleep(700);
    await page.keyboard.press('KeyR');
    await sleep(1400);
    await page.keyboard.press('KeyR');
    await sleep(1000);
    await page.keyboard.up('KeyD');
    await sleep(500);
    await page.screenshot({ path: path.join(out, 'wp13-browser-hud.png') });

    // B: fight the group with the real client: approach, swing, dodge.
    note('fight: approaching the group');
    const t0 = Date.now();
    let shots = 0;
    while (Date.now() - t0 < 60000) {
      const st = await page.evaluate(() => {
        const views = (window as unknown as { __lodestoneDrawn?: () => { x: number; z: number; healthPct: number; kind: number }[] }).__lodestoneDrawn?.() ?? [];
        const p = (window as unknown as W).__lodestone.player().pos;
        let best: { x: number; z: number } | null = null;
        let bd = 1e9;
        for (const v of views) {
          if (v.kind !== 2 || v.healthPct === 0) continue;
          const d = Math.hypot(v.x - p.x, v.z - p.z);
          if (d < bd) {
            bd = d;
            best = v;
          }
        }
        return { best, bd };
      });
      if (!st.best) {
        if (Date.now() - t0 > 15000) break;
        await face(target.x, target.z);
        await page.keyboard.down('KeyW');
        await sleep(300);
        await page.keyboard.up('KeyW');
        continue;
      }
      await face(st.best.x, st.best.z);
      if (st.bd > 2.6) {
        await page.keyboard.down('KeyW');
        await sleep(Math.min(400, (st.bd - 2) * 150));
        await page.keyboard.up('KeyW');
      }
      await click(30);
      await sleep(260);
      if (Math.random() < 0.18) await page.keyboard.press('KeyF');
      if ((shots === 0 && Date.now() - t0 > 4000) || (shots === 1 && Date.now() - t0 > 12000) || (shots === 2 && Date.now() - t0 > 22000)) {
        await page.screenshot({ path: path.join(out, `wp13-browser-fight-${shots + 1}.png`) });
        shots++;
      }
    }
    const probe = await page.evaluate(() => (window as unknown as W).__lodestoneCombat!.probe());
    const net = await page.evaluate(() => (window as unknown as W).__lodestone.netDebug());
    const after = (await (await fetch(`http://127.0.0.1:${zone.port}/debug/combat`)).json()) as { groups: Group[]; stats: unknown };
    note(`probe: ${JSON.stringify(probe)}`);
    note(`prediction: ${JSON.stringify(net?.prediction)}`);
    note(`zone combat stats: ${JSON.stringify(after.stats)}`);
    fs.writeFileSync(path.join(out, 'wp13-feel.json'), JSON.stringify({ fps, software, target, probe, prediction: net?.prediction, zoneStats: after.stats }, null, 2) + '\n');
  } finally {
    fs.writeFileSync(path.join(out, 'wp13-feel.txt'), lines.join('\n') + '\n');
    await browser.close();
    vite.kill();
    zone.proc.kill();
  }
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
