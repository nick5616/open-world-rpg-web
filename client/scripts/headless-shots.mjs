#!/usr/bin/env node
/* global requestAnimationFrame */
// Headless acceptance capture for WP02 (spec rule 5: run what you build).
// Start the client first (`npm run dev:solo`), then:
//   npm run shots -w client                 (default http://localhost:5173)
//   LODESTONE_CLIENT_URL=http://localhost:5199 npm run shots -w client
//
// Drives real keyboard input through Playwright (headless Chromium has no
// pointer lock, so look is scripted via window.__lodestone.setLook), takes
// screenshots of title, walking, sprinting, jumping, double jump, fly and the
// cell-border overlay with the debug HUD visible, and writes a log with the
// HUD readings and in-browser movement measurements to docs/evidence/.
//
// Headless notes (from wizard-wars scripts/playtest/browser-playtest.mjs):
// SwiftShader renders on the CPU, so fps here is far below a real GPU and is
// not a performance measurement; page.waitForFunction uses polling, because
// the default rAF polling stalls on busy pages.

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '..', '..', 'docs', 'evidence');
mkdirSync(out, { recursive: true });
const url = process.env.LODESTONE_CLIENT_URL ?? 'http://localhost:5173';

const log = [];
const note = (msg, data) => {
  const line = data === undefined ? msg : `${msg} ${JSON.stringify(data)}`;
  log.push(line);
  console.log(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
});

const player = () => page.evaluate(() => window.__lodestone.player());
const hud = () => page.evaluate(() => ({ fps: document.querySelector('[data-testid="hud-fps"]')?.textContent, frame: window.__lodestoneFrame }));
const shot = async (name) => {
  await page.screenshot({ path: join(out, `wp02-${name}.png`) });
  note(`screenshot wp02-${name}.png`, { player: await player(), hud: await hud() });
};
const holdKeys = async (keys, ms) => {
  for (const k of keys) await page.keyboard.down(k);
  await sleep(ms);
};
const releaseKeys = async (keys) => {
  for (const k of [...keys].reverse()) await page.keyboard.up(k);
};

note(`open ${url}`);
await page.goto(url, { waitUntil: 'networkidle' });
await page.screenshot({ path: join(out, 'wp02-title.png') });
note('screenshot wp02-title.png');

await page.click('[data-testid="play"]');
await page.waitForSelector('canvas', { timeout: 60000 });
await page.waitForFunction(() => /\d+ FPS/.test(document.querySelector('[data-testid="hud-fps"]')?.textContent ?? ''), null, { polling: 250, timeout: 60000 });
await page.evaluate(() => {
  // Pin the tier: in 'auto' the PerformanceMonitor would step down under
  // SwiftShader mid-capture and the shots would differ run to run.
  window.__lodestone.setQuality('medium');
  window.__lodestone.setFreezeTime(true);
  window.__lodestone.setTimeOfDay(0.42 * 3600);
  // Face the landmark (north, -Z) with a slight downward look.
  window.__lodestone.setLook(0, -0.05);
});
await sleep(1500);
const spawn = await player();
note('spawn', spawn);
await shot('spawn');

// Walk: hold W ~2 s, measure speed from the HUD state while still holding.
await holdKeys(['KeyW'], 2000);
const walk = await player();
await shot('walking');
await releaseKeys(['KeyW']);
const walkSpeed = Math.hypot(walk.vel.x, walk.vel.z);
note('walk speed m/s (expected ~4.889, the wizard-wars ground equilibrium)', +walkSpeed.toFixed(3));

// Sprint while turning slightly right.
await page.evaluate(() => window.__lodestone.setLook(-0.4, -0.05));
await holdKeys(['ShiftLeft', 'KeyW'], 2000);
const sprint = await player();
await shot('sprinting');
const sprintSpeed = Math.hypot(sprint.vel.x, sprint.vel.z);
note('sprint speed m/s (expected ~7.822)', +sprintSpeed.toFixed(3));

// Jump while sprinting, then double jump on a fresh press. Max height and air
// jumps are sampled inside the page every frame (polling from here would miss the apex).
await page.evaluate(() => {
  const w = window;
  w.__jumpProbe = { maxY: 0, maxAirJumps: 0 };
  const tick = () => {
    const p = w.__lodestone.player();
    w.__jumpProbe.maxY = Math.max(w.__jumpProbe.maxY, p.pos.y);
    w.__jumpProbe.maxAirJumps = Math.max(w.__jumpProbe.maxAirJumps, p.airJumps);
    if (!w.__jumpProbe.stop) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
await page.keyboard.down('Space');
await sleep(120);
await page.keyboard.up('Space');
await sleep(220);
await page.keyboard.down('Space');
await sleep(60);
await page.keyboard.up('Space');
await sleep(150);
await shot('double-jump');
await sleep(1500);
await releaseKeys(['ShiftLeft', 'KeyW']);
const { maxY, maxAirJumps } = await page.evaluate(() => {
  window.__jumpProbe.stop = true;
  return window.__jumpProbe;
});
note('double jump: max feet height m (single jump apex ~1.05, double ~2.1 depending on press timing), air jumps used', { maxY: +maxY.toFixed(3), maxAirJumps });
await sleep(800);
const landed = await player();
note('landed', { y: landed.pos.y, grounded: landed.grounded, mode: landed.mode });

// Debug tools: teleport, cell borders, fly, HUD back to the mouse.
await page.evaluate(() => window.__lodestone.teleport({ x: 1000, z: 1000 }));
await page.evaluate(() => {
  window.__lodestone.setShowCells(true);
  window.__lodestone.setLook(-0.75 * Math.PI, -0.3); // face +x +z: the region corner (1024, 1024)
});
await sleep(800);
const tp = await player();
note('teleported next to the region corner (1024, 1024)', tp.pos);
await shot('cell-borders');

await page.keyboard.press('KeyV');
await page.evaluate(() => window.__lodestone.setLook(-0.75 * Math.PI, 0.35));
await holdKeys(['KeyW'], 1500);
await releaseKeys(['KeyW']);
const fly = await player();
note('fly mode after 1.5 s forward, pitched up', { pos: fly.pos, mode: fly.mode });
await shot('fly');

await page.keyboard.press('Backquote');
await sleep(400);
await shot('debug-panel');

// Frame stats over a few windows for the log.
const frames = [];
for (let i = 0; i < 3; i++) {
  await sleep(1100);
  frames.push((await hud()).frame);
}
note('frame windows (SwiftShader software GL, not a GPU number)', frames);

note('page errors', errors);
writeFileSync(join(out, 'wp02-headless.txt'), log.join('\n') + '\n');
await browser.close();

const ok = errors.length === 0 && Math.abs(walkSpeed - 4.889) < 0.05 && Math.abs(sprintSpeed - 7.822) < 0.08 && maxAirJumps === 1 && maxY > 1.6 && landed.grounded;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
