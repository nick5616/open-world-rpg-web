#!/usr/bin/env node
// WP12 acceptance (G3's map and tower flow, spec 15): two players in a
// party, real account + director + zone + social processes, dev auth, two
// headless Chromium processes.
//
//   1. Alyssa and Bruno sign in (dev auth), Alyssa invites Bruno (/invite),
//      Bruno accepts in the party frame: both get the same party id from
//      the zone (party ring), and each shows on the other's compass and map.
//   2. Alyssa touches the waypoint stone at the spawn settlement, then walks
//      to the nearest tower and climbs it (until WP10's climbing lands, the
//      ground snap carries her up the 80 degree wall, exactly as the zone
//      simulates it). The zone validates the top: the region is revealed on
//      her map, the tower unlocks for fast travel, discovery XP is granted.
//   3. Alyssa drops a party pin on the map (Shift+right-click): Bruno gets it
//      on his map and compass.
//   4. Alyssa fast travels to the waypoint, then back to the tower, through
//      the map UI. Standing on the tower again grants nothing new.
//   5. Alyssa reloads and signs in again: progress came back from Postgres.
//
// Private ports (account 18291, director 18290, zone 18292, social 18293,
// Vite 5293) and a scratch database (lodestone_wp04_wp12e2e, dropped after),
// so nothing else running on the machine is touched. Real GPU through ANGLE
// (as WP05's benchmark) so the walk runs at full speed headless.
//
//   node client/src/ui/map/dev/acceptance.mjs
//
// Evidence: docs/evidence/wp12-acceptance.txt, wp12-acceptance.json,
// wp12-zone-exploration.log, wp12-*.png
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { env, killTree, root, waitHttp } from '../../../../../scripts/lib.mjs';

const EVIDENCE = path.join(root, 'docs', 'evidence');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-wp12-'));
const DB = 'lodestone_wp04_wp12e2e';
const PORT = { account: 18291, director: 18290, zone: 18292, social: 18293, vite: 5293 };
const EXE = process.platform === 'win32' ? '.exe' : '';
const ZONE_ID = 'zone-wp12-e2e';
const GPU_ARGS = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'];

fs.mkdirSync(EVIDENCE, { recursive: true });
const lines = [];
function step(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  lines.push(line);
}
const failures = [];
function check(cond, msg, detail) {
  const d = detail === undefined ? '' : '  ' + JSON.stringify(detail);
  if (!cond) failures.push(msg);
  step(`${cond ? 'PASS' : 'FAIL'} ${msg}${d}`);
  return cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (name) => path.join(EVIDENCE, `wp12-${name}.png`);

function goSync(args, extra = {}) {
  const r = spawnSync('go', args, { cwd: root, env: env(extra), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`go ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
const children = [];
function start(name, cmd, args, extra, cwd = root) {
  const out = fs.createWriteStream(path.join(TMP, `${name}.log`));
  const child = spawn(cmd, args, { cwd, env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  children.push(child);
  return child;
}

async function signInAndPlay(page, user, charName) {
  await page.getByTestId('auth-dev-username').waitFor({ timeout: 120000 });
  await page.getByTestId('auth-dev-username').fill(user);
  await page.getByTestId('auth-dev-submit').click();
  await page.getByTestId('char-name').waitFor();
  if ((await page.getByTestId(`play-${charName}`).count()) === 0) {
    await page.getByTestId('char-name').fill(charName);
    await page.getByTestId('char-create').click();
  }
  await page.getByTestId(`play-${charName}`).click();
  await page.waitForFunction(() => window.__lodestone?.netDebug?.()?.phase === 'playing', null, { timeout: 60000 });
  // The world loaded (towers built) and the zone sent our progress.
  await page.waitForFunction(() => window.__lodestoneMap?.towers().length > 0 && window.__lodestoneMap.state().online && window.__lodestoneMap.state().stats.events > 0, null, { timeout: 120000 });
}

const mapState = (page) => page.evaluate(() => window.__lodestoneMap.state());
const player = (page) => page.evaluate(() => window.__lodestoneMap.player());

async function openChat(page) {
  if ((await page.getByTestId('chat-input').count()) === 0) await page.getByTestId('chat-open').click();
  await page.getByTestId('chat-input').waitFor();
}
async function say(page, text) {
  await openChat(page);
  await page.getByTestId('chat-input').fill(text);
  await page.getByTestId('chat-input').press('Enter');
  await page.getByTestId('chat-input').press('Escape').catch(() => {});
}

/**
 * Walk (sprinting) toward (x, z) like a player: face it, hold W + Shift,
 * re-aim every 200 ms. Stops when `done` says so or within `stopAt` m.
 */
async function walkTo(page, x, z, { stopAt = 1, timeoutMs = 240000, done = null, sprint = true, label = '' } = {}) {
  const t0 = Date.now();
  let p = await player(page);
  let lastLog = 0;
  await page.keyboard.down('KeyW');
  if (sprint) await page.keyboard.down('ShiftLeft');
  try {
    for (;;) {
      p = await player(page);
      const d = Math.hypot(x - p.x, z - p.z);
      if (d <= stopAt || (done && (await done(p, d)))) return { ok: true, p, d, ms: Date.now() - t0 };
      if (Date.now() - t0 > timeoutMs) return { ok: false, p, d, ms: Date.now() - t0 };
      await page.evaluate(([dx, dz]) => window.__lodestone.setLook(Math.atan2(-dx, -dz), 0), [x - p.x, z - p.z]);
      if (Date.now() - lastLog > 10000) {
        lastLog = Date.now();
        step(`  ${label} walking: ${d.toFixed(0)} m to go, at (${p.x.toFixed(0)}, ${p.y.toFixed(1)}, ${p.z.toFixed(0)})`);
      }
      await sleep(200);
    }
  } finally {
    await page.keyboard.up('KeyW');
    if (sprint) await page.keyboard.up('ShiftLeft');
  }
}

/** Open the map and click a world point on it (left, or right with Shift for a party pin). */
async function mapClick(page, x, z, opts = {}) {
  const pos = await page.evaluate(([x, z]) => window.__lodestoneMap.mapScreenPos(x, z), [x, z]);
  if (!pos) throw new Error('map is not open');
  if (opts.shift) await page.keyboard.down('ShiftLeft');
  await page.mouse.click(pos.x, pos.y, { button: opts.button ?? 'left' });
  if (opts.shift) await page.keyboard.up('ShiftLeft');
  return pos;
}
async function openMap(page) {
  if (!(await mapState(page)).mapOpen) await page.keyboard.press('KeyM');
  await page.getByTestId('map-canvas').waitFor();
  await sleep(400);
}
async function closeMap(page) {
  if ((await mapState(page)).mapOpen) await page.keyboard.press('Escape');
  await sleep(200);
}

/** Fast travel through the map UI: open, click the site, press Travel. */
async function fastTravelUI(page, site) {
  await openMap(page);
  await mapClick(page, site.x, site.z);
  try {
    await page.getByTestId('map-travel').click({ timeout: 5000 });
  } catch (e) {
    const geo = await page.evaluate(() => {
      const b = document.querySelector('[data-testid=map-travel]').getBoundingClientRect();
      const c = document.querySelector('[data-testid=map-canvas]').getBoundingClientRect();
      const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return { button: [b.x, b.y, b.width, b.height], canvas: [c.x, c.y, c.width, c.height], hit: hit?.tagName, vw: innerWidth, vh: innerHeight };
    });
    step('travel button geometry ' + JSON.stringify(geo));
    await page.screenshot({ path: shot('debug-travel') });
    throw e;
  }
}

let browsers = [];
const result = {};
try {
  step('WP12 acceptance: towers, waypoints, map, compass, party pins, fast travel, discovery XP');
  for (const [name, port] of Object.entries(PORT)) {
    const busy = await fetch(`http://localhost:${port}/`).then(() => true, () => false);
    if (busy) throw new Error(`port ${port} (${name}) is already in use; free it or edit PORT in this script`);
  }
  const pgUrl = goSync(['run', './server/account/cmd/devdb', 'create', DB]).trim().split('\n').pop();
  step(`scratch database ${DB} (migrations incl. 0012_exploration_pins)`);
  for (const [name, pkg] of [['account', './server/account'], ['director', './server/director'], ['zone', './server/zone'], ['social', './server/social']]) goSync(['build', '-o', path.join(TMP, name + EXE), pkg]);
  step('built account, director, zone, social');
  const svcEnv = {
    LODESTONE_PG_URL: pgUrl,
    LODESTONE_ACCOUNT_PORT: String(PORT.account),
    LODESTONE_DIRECTOR_PORT: String(PORT.director),
    LODESTONE_SOCIAL_PORT: String(PORT.social),
    LODESTONE_SOCIAL_URL: `ws://localhost:${PORT.social}/ws`,
    LODESTONE_DEV_AUTH: '1',
    LODESTONE_CORS_ORIGIN: '*',
  };
  start('account', path.join(TMP, 'account' + EXE), [], svcEnv);
  check(await waitHttp(`http://localhost:${PORT.account}/healthz`, 60000), `account healthy on :${PORT.account} (mints the official world)`);
  start('social', path.join(TMP, 'social' + EXE), [], svcEnv);
  check(await waitHttp(`http://localhost:${PORT.social}/healthz`, 30000), `social healthy on :${PORT.social}`);
  start('director', path.join(TMP, 'director' + EXE), [], svcEnv);
  check(await waitHttp(`http://localhost:${PORT.director}/healthz`, 30000), `director healthy on :${PORT.director}`);
  start('zone', path.join(TMP, 'zone' + EXE), [], { ...svcEnv, LODESTONE_ZONE_PORT: String(PORT.zone), LODESTONE_ZONE_ID: ZONE_ID, LODESTONE_ZONE_WT_ADDR: 'off' });
  check(await waitHttp(`http://localhost:${PORT.zone}/healthz`, 60000), `zone healthy on :${PORT.zone}`);
  const zoneInfo = await (await fetch(`http://localhost:${PORT.zone}/debug/zone`)).json();
  step(`zone serves world ${zoneInfo.worldId} seed ${zoneInfo.seed} genVersion ${zoneInfo.genVersion} atlas ${zoneInfo.atlasHash}`);
  start('vite', process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT.vite), '--strictPort'], { VITE_ACCOUNT_URL: `http://localhost:${PORT.account}`, VITE_DIRECTOR_URL: `http://localhost:${PORT.director}`, VITE_SOLO: '0' }, path.join(root, 'client'));
  check(await waitHttp(`http://localhost:${PORT.vite}/`, 60000), `vite on :${PORT.vite}`);
  await sleep(6000); // zone registry heartbeat reaches the director

  const consoleLog = [];
  browsers = [await chromium.launch({ args: GPU_ARGS }), await chromium.launch({ args: GPU_ARGS })];
  const pages = [];
  for (const [i, br] of browsers.entries()) {
    const label = i === 0 ? 'A' : 'B';
    const ctx = await br.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    page.on('console', (m) => consoleLog.push(`[${label}] ${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => consoleLog.push(`[${label}] pageerror: ${e.message}`));
    await page.goto(`http://localhost:${PORT.vite}/?debug=1&autoplay=1&transport=ws`);
    pages.push(page);
  }
  const [a, b] = pages;
  await Promise.all([signInAndPlay(a, 'wp12alice', 'Alyssa'), signInAndPlay(b, 'wp12bruno', 'Bruno')]);
  for (const p of pages) await p.evaluate(() => window.__lodestone.setQuality('high'));
  const a0 = await mapState(a);
  const b0 = await mapState(b);
  step(`signed in: Alyssa level ${a0.level} xp ${a0.xp}, Bruno level ${b0.level} xp ${b0.xp}`);
  check(a0.revealed === 0 && b0.revealed === 0, 'fresh characters: every region unrevealed', { a: a0.revealed, b: b0.revealed });

  // ---- 1. party ----
  await say(a, '/invite Bruno');
  await b.getByTestId('party-accept').click({ timeout: 15000 });
  await Promise.all([a, b].map((p) => p.waitForFunction(() => window.__lodestoneMap.state().partyId !== 0, null, { timeout: 15000 })));
  const [pa, pb] = [await mapState(a), await mapState(b)];
  check(pa.partyId === pb.partyId && pa.partyId !== 0, 'zone put both in the same party (party ring id from the social party)', { a: pa.partyId, b: pb.partyId });
  await b.waitForFunction(() => window.__lodestoneMap.compass().some((m) => m.kind === 'party' && m.label === 'Alyssa'), null, { timeout: 10000 });
  await a.waitForFunction(() => window.__lodestoneMap.compass().some((m) => m.kind === 'party' && m.label === 'Bruno'), null, { timeout: 10000 });
  check(true, 'each sees the other on the compass');

  const towers = await a.evaluate(() => window.__lodestoneMap.towers());
  const start0 = await player(a);
  const waypoints = await a.evaluate(() => window.__lodestoneMap.sites('waypoint'));
  const wp = waypoints.map((s) => ({ ...s, d: Math.hypot(s.x - start0.x, s.z - start0.z) })).sort((p, q) => p.d - q.d)[0];
  const tower = towers.map((t) => ({ ...t, d: Math.hypot(t.x - start0.x, t.z - start0.z) })).sort((p, q) => p.d - q.d)[0];
  step(`Alyssa at (${start0.x.toFixed(1)}, ${start0.z.toFixed(1)}); nearest waypoint #${wp.index} "${wp.name}" ${wp.d.toFixed(1)} m; nearest tower #${tower.site} "${tower.name}" (region ${tower.region}) ${tower.d.toFixed(0)} m, top y ${tower.topY.toFixed(2)}`);

  // ---- 2a. waypoint ----
  const w = await walkTo(a, wp.x, wp.z, { stopAt: 0.8, sprint: false, timeoutMs: 60000, label: 'to waypoint', done: async () => (await mapState(a)).waypointsUnlocked > 0 });
  await a.waitForFunction(() => window.__lodestoneMap.state().waypointsUnlocked > 0, null, { timeout: 5000 }).catch(() => {});
  const aw = await mapState(a);
  check(aw.waypointsUnlocked === 1 && aw.lastWaypoint === wp.index, 'touching the waypoint stone activates it and makes it the respawn point', { unlocked: aw.waypointsUnlocked, lastWaypoint: aw.lastWaypoint, walkMs: w.ms, toasts: aw.toasts });

  // ---- 2b. tower ----
  const xpBefore = (await mapState(a)).xp;
  const discBefore = (await mapState(a)).stats.discoveries;
  const approach = await walkTo(a, tower.x, tower.z, { stopAt: tower.maxR + 45, label: 'to tower' });
  check(approach.ok, `reached the tower's surroundings (${approach.d.toFixed(0)} m from its axis) in ${(approach.ms / 1000).toFixed(0)} s`);
  // Tower screenshot: face it, look up a little.
  await a.evaluate(([dx, dz]) => window.__lodestone.setLook(Math.atan2(-dx, -dz), 0.32), [tower.x - approach.p.x, tower.z - approach.p.z]);
  await sleep(1500);
  await a.screenshot({ path: shot('tower') });
  const climb = await walkTo(a, tower.x, tower.z, { stopAt: 0.5, label: 'climbing', timeoutMs: 60000, done: async () => (await mapState(a)).revealed !== 0 });
  await a.waitForFunction(() => window.__lodestoneMap.state().revealed !== 0, null, { timeout: 5000 }).catch(() => {});
  const top = await player(a);
  const at = await mapState(a);
  check(at.revealed === 1 << tower.region, `standing on the top (y ${top.y.toFixed(2)} vs top ${tower.topY.toFixed(2)}) reveals region ${tower.region} on the map`, { revealed: at.revealed, climbMs: climb.ms });
  check(at.towersUnlocked === 1, 'tower unlocked for fast travel', { towersUnlocked: at.towersUnlocked });
  const towerToast = at.toasts.find((t) => t.kind === 'tower');
  const xpGained = at.xp - xpBefore;
  const discoveryXp = at.stats.xpGained; // sum of discovery Events' XP since sign-in
  check(!!towerToast && at.toasts.some((t) => t.kind === 'discovery'), 'discovery and tower toasts shown', at.toasts);
  check(xpGained >= 40 + 150 && at.stats.discoveries > discBefore, `discovery XP granted: +${xpGained} XP (tower discovery 40 + climb 150 + places passed on the way)`, { xpBefore, xpAfter: at.xp, discoveries: at.stats.discoveries, discoveryXpTotal: discoveryXp, level: at.level });
  // Look out from the top over the revealed region.
  await a.evaluate(() => window.__lodestone.setLook(2.4, -0.18));
  await sleep(1200);
  await a.screenshot({ path: shot('tower-top') });

  // ---- 3. map + party pin ----
  await openMap(a);
  await sleep(600);
  await a.screenshot({ path: shot('map-revealed') });
  const pinAt = { x: tower.x + 260, z: tower.z + 180 };
  await mapClick(a, pinAt.x, pinAt.z, { button: 'right', shift: true });
  await b.waitForFunction(() => window.__lodestoneMap.state().pins.some((p) => p.party && p.owner === 'Alyssa'), null, { timeout: 10000 }).catch(() => {});
  const bPins = (await mapState(b)).pins;
  const partyPin = bPins.find((p) => p.party && p.owner === 'Alyssa');
  check(!!partyPin && Math.abs(partyPin.x - pinAt.x) < 15 && Math.abs(partyPin.z - pinAt.z) < 15, "Alyssa's party pin shows for Bruno", { pinAt, bPins });
  // A personal pin stays personal.
  await mapClick(a, tower.x - 300, tower.z + 100, { button: 'right' });
  await a.waitForFunction(() => window.__lodestoneMap.state().pins.some((p) => !p.party), null, { timeout: 5000 }).catch(() => {});
  await sleep(800);
  const aPins = (await mapState(a)).pins;
  const bPins2 = (await mapState(b)).pins;
  check(aPins.some((p) => !p.party) && !bPins2.some((p) => !p.party), "a personal pin is Alyssa's alone", { a: aPins.length, b: bPins2.length });
  await sleep(500);
  await a.screenshot({ path: shot('map-pins') });
  await closeMap(a);

  // Bruno: compass and map show Alyssa (far away, through the party ring) and her pin.
  const bp = await player(b);
  await b.evaluate(([dx, dz]) => window.__lodestone.setLook(Math.atan2(-dx, -dz) + 0.25, 0.05), [tower.x - bp.x, tower.z - bp.z]);
  await sleep(800);
  const bCompass = await b.evaluate(() => window.__lodestoneMap.compass());
  check(bCompass.some((m) => m.kind === 'party' && m.label === 'Alyssa') && bCompass.some((m) => m.kind === 'pin' && m.label === 'Alyssa'), 'Bruno\'s compass shows Alyssa and her party pin', bCompass.map((m) => ({ kind: m.kind, label: m.label, dist: Math.round(m.dist), relDeg: Math.round((m.rel * 180) / Math.PI) })));
  // The debug HUD (F3) overlaps the strip at this viewport: hide it for these two shots.
  await b.keyboard.press('F3');
  await sleep(300);
  await b.screenshot({ path: shot('compass') });
  await b.screenshot({ path: shot('compass-strip'), clip: { x: 340, y: 0, width: 600, height: 60 } });
  await b.keyboard.press('F3');
  await openMap(b);
  await sleep(600);
  await b.screenshot({ path: shot('map-bruno') });
  await closeMap(b);

  // ---- 4. fast travel ----
  const tp0 = (await mapState(a)).stats.teleports;
  await fastTravelUI(a, wp);
  await a.waitForFunction(([x, z]) => { const p = window.__lodestoneMap.player(); return Math.hypot(p.x - x, p.z - z) < 6; }, [wp.x, wp.z], { timeout: 10000 }).catch(() => {});
  const atWp = await player(a);
  check(Math.hypot(atWp.x - wp.x, atWp.z - wp.z) < 6, `fast travel to the waypoint (map UI): now ${Math.hypot(atWp.x - wp.x, atWp.z - wp.z).toFixed(1)} m from the stone`, { at: atWp });
  await sleep(2500); // past the zone's 2 s cooldown
  const xpBeforeReturn = (await mapState(a)).xp;
  const towerToastsBefore = (await mapState(a)).stats.towers;
  await fastTravelUI(a, { x: tower.x, z: tower.z });
  await a.waitForFunction(([x, z, y]) => { const p = window.__lodestoneMap.player(); return Math.hypot(p.x - x, p.z - z) < 1 && p.y > y - 0.7; }, [tower.x, tower.z, tower.topY], { timeout: 10000 }).catch(() => {});
  const back = await player(a);
  check(Math.hypot(back.x - tower.x, back.z - tower.z) < 1 && back.y > tower.topY - 0.7, `fast travel to the unlocked tower: on its top (${back.y.toFixed(2)} vs ${tower.topY.toFixed(2)})`, { at: back });
  const tp1 = (await mapState(a)).stats.teleports;
  check(tp1 >= tp0 + 2, 'zone sent teleport Events for both hops', { before: tp0, after: tp1 });
  await sleep(2500);
  const again = await mapState(a);
  check(again.xp === xpBeforeReturn && again.stats.towers === towerToastsBefore, 'back on the tower top: no XP granted twice', { xpBeforeReturn, xpNow: again.xp });
  await a.evaluate(() => window.__lodestone.setLook(-0.8, -0.12));
  await sleep(1000);
  await a.screenshot({ path: shot('fast-travel-top') });
  const bSees = await b.evaluate(() => window.__lodestoneMap.compass().find((m) => m.kind === 'party'));
  check(!!bSees, "Bruno's compass follows Alyssa after her fast travel", bSees);

  // ---- 5. persistence: reload Alyssa ----
  const beforeReload = await mapState(a);
  await sleep(1500); // the logout save rides the write-behind queue; the periodic one already ran on change
  await a.reload();
  await signInAndPlay(a, 'wp12alice', 'Alyssa');
  await a.waitForFunction(() => window.__lodestoneMap.state().revealed !== 0, null, { timeout: 15000 }).catch(() => {});
  const reloaded = await mapState(a);
  check(reloaded.revealed === beforeReload.revealed && reloaded.xp === beforeReload.xp && reloaded.towersUnlocked === 1 && reloaded.waypointsUnlocked === 1 && reloaded.pins.filter((p) => !p.party).length === 1,
    'after a reload the progress comes back from Postgres (revealed regions, XP, unlocks, personal pin)', { before: { revealed: beforeReload.revealed, xp: beforeReload.xp }, after: { revealed: reloaded.revealed, xp: reloaded.xp, towers: reloaded.towersUnlocked, waypoints: reloaded.waypointsUnlocked, pins: reloaded.pins.length } });

  Object.assign(result, { tower, waypoint: wp, alyssa: reloaded, bruno: await mapState(b), xpGained, compassBruno: bCompass });
  const errors = consoleLog.filter((l) => /pageerror/.test(l));
  fs.writeFileSync(path.join(EVIDENCE, 'wp12-acceptance-console.txt'), consoleLog.join('\n') + '\n');
  check(errors.length === 0, 'no page errors in either browser', errors.slice(0, 5));
} catch (e) {
  failures.push(String(e));
  step(`ERROR ${e.stack ?? e}`);
} finally {
  for (const br of browsers) await br.close().catch(() => {});
  for (const c of children) killTree(c);
  await sleep(500);
  try {
    const zl = fs.readFileSync(path.join(TMP, 'zone.log'), 'utf8').split('\n').filter((l) => /exploration|fast travel|join|leave|tower|terrain ready|exploration ready/.test(l));
    fs.writeFileSync(path.join(EVIDENCE, 'wp12-zone-exploration.log'), zl.join('\n') + '\n');
  } catch {}
  try {
    goSync(['run', './server/account/cmd/devdb', 'drop', DB]);
    step(`dropped ${DB}`);
  } catch (e) {
    step(`could not drop ${DB}: ${e.message}`);
  }
  step(failures.length ? `FAILED: ${failures.join('; ')}` : 'ALL PASS');
  fs.writeFileSync(path.join(EVIDENCE, 'wp12-acceptance.txt'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(EVIDENCE, 'wp12-acceptance.json'), JSON.stringify(result, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
  process.exit(failures.length ? 1 : 0);
}
