#!/usr/bin/env node
// WP08 acceptance (spec 15): chat in every channel and whispers between
// players presenting different zones, in real browsers with real director
// tickets; blocked whispers dropped; rate limits; parties; friends; reports
// and the admin CLI. Then a bot flood against the same social process.
//
// Real processes: account + director + social + e2ezones (two stand-in zones
// splitting the world, so the director hands Alice and Bob tickets for
// DIFFERENT zones) on a scratch Postgres database, the shared Redis, Vite on
// 5175, three Chromium contexts via Playwright:
//   Alice  dev account, spawn (2048, 2048) -> region 2,2 -> zone-east
//   Bob    dev account, moved to (500, 500) -> region 0,0 -> zone-west
//   Lina   local profile, stands 10 m from Alice (zone-east)
//
// Run from the repo root (infra up):  node client/src/social/dev/e2e.mjs [--keep-db]
// Evidence: docs/evidence/wp08-*.png, wp08-e2e.txt, wp08-admin.txt, wp08-flood.*
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { env, killTree, root, waitHttp } from '../../../../scripts/lib.mjs';

const EVIDENCE = path.join(root, 'docs', 'evidence');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-wp08-'));
// devdb only creates lodestone_wp04_* names (WP04's guard against dropping real databases).
const DB = 'lodestone_wp04_wp08e2e';
// Off the default ports (and WP04's 1809x) so a running dev stack is left alone.
const PORT = { account: 18191, director: 18190, social: 18193, vite: 5175 };
const EXE = process.platform === 'win32' ? '.exe' : '';

fs.mkdirSync(EVIDENCE, { recursive: true });
const lines = [];
function step(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  lines.push(line);
}
function check(cond, msg, detail) {
  if (!cond) throw new Error(`FAIL ${msg}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  step(`PASS ${msg}${detail === undefined ? '' : '  ' + JSON.stringify(detail)}`);
}
const shot = (name) => path.join(EVIDENCE, `wp08-${name}.png`);

function goSync(args, extra = {}) {
  const r = spawnSync('go', args, { cwd: root, env: env(extra), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`go ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
function binSync(name, args, extra = {}) {
  const r = spawnSync(path.join(TMP, name + EXE), args, { cwd: root, env: env(extra), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${name} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
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

// ---- page helpers (all state read from window.__wp08.store) ----
const tabTexts = (page, tab) => page.evaluate((t) => (window.__wp08.store.getState().tabs[t] ?? []).map((l) => l.text), tab);
async function waitLine(page, tab, text, timeout = 8000) {
  await page.waitForFunction(
    ([t, x]) => (window.__wp08.store.getState().tabs[t] ?? []).some((l) => l.text === x),
    [tab, text],
    { timeout },
  );
}
async function waitNotice(page, includes, timeout = 8000) {
  await page.waitForFunction(
    (x) => (window.__wp08.store.getState().tabs.system ?? []).some((l) => l.text.includes(x)),
    includes,
    { timeout },
  );
}
async function openChat(page) {
  if ((await page.getByTestId('chat-input').count()) === 0) await page.getByTestId('chat-open').click();
  await page.getByTestId('chat-input').waitFor();
}
async function say(page, text) {
  await openChat(page);
  await page.getByTestId('chat-input').fill(text);
  await page.getByTestId('chat-input').press('Enter');
}
async function tab(page, key) {
  await openChat(page);
  await page.getByTestId(`chat-tab-${key}`).click();
}
async function closeChat(page) {
  if ((await page.getByTestId('chat-input').count()) > 0) await page.getByTestId('chat-input').press('Escape');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
let exitCode = 0;
let svcEnv;
try {
  step(`scratch database ${DB}`);
  const pgUrl = goSync(['run', './server/account/cmd/devdb', 'create', DB]).trim().split('\n').pop();
  svcEnv = {
    LODESTONE_PG_URL: pgUrl,
    LODESTONE_ACCOUNT_PORT: String(PORT.account),
    LODESTONE_DIRECTOR_PORT: String(PORT.director),
    LODESTONE_SOCIAL_PORT: String(PORT.social),
    LODESTONE_SOCIAL_URL: `ws://localhost:${PORT.social}/ws`,
    LODESTONE_DEV_AUTH: '1',
    LODESTONE_CORS_ORIGIN: '*',
  };
  step('building account, director, social, e2ezones, admin, flood');
  for (const [name, pkg] of [
    ['account', './server/account'], ['director', './server/director'], ['social', './server/social'],
    ['e2ezones', './server/social/cmd/e2ezones'], ['admin', './server/social/cmd/admin'], ['flood', './server/social/cmd/flood'],
  ]) {
    goSync(['build', '-o', path.join(TMP, name + EXE), pkg]);
  }
  start('account', path.join(TMP, 'account' + EXE), [], svcEnv);
  check(await waitHttp(`http://localhost:${PORT.account}/healthz`, 30000), `account healthy on :${PORT.account}`);
  start('e2ezones', path.join(TMP, 'e2ezones' + EXE), ['announce'], svcEnv);
  start('social', path.join(TMP, 'social' + EXE), [], svcEnv);
  check(await waitHttp(`http://localhost:${PORT.social}/healthz`, 30000), `social healthy on :${PORT.social}`);
  start('director', path.join(TMP, 'director' + EXE), [], svcEnv);
  check(await waitHttp(`http://localhost:${PORT.director}/healthz`, 30000), `director healthy on :${PORT.director}`);

  // Bob's character must exist before the move puts it in the west half.
  const acct = `http://localhost:${PORT.account}`;
  const post = (url, body, token) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then((r) => r.json());
  const bobSession = (await post(`${acct}/v1/auth/dev`, { username: 'wp08bob' })).session;
  const world = (await fetch(`${acct}/v1/worlds`).then((r) => r.json())).worlds.find((w) => w.official);
  await post(`${acct}/v1/characters`, { worldId: world.id, name: 'Bob' }, bobSession);
  step(binSync('e2ezones', ['move', '-name', 'Bob', '-x', '500', '-z', '500'], svcEnv).trim());

  start('vite', process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT.vite), '--strictPort'], {
    VITE_ACCOUNT_URL: acct,
    VITE_DIRECTOR_URL: `http://localhost:${PORT.director}`,
  }, path.join(root, 'client'));
  const base = `http://localhost:${PORT.vite}/social-dev.html`;
  check(await waitHttp(base, 60000), `vite serving ${base}`);

  browser = await chromium.launch();
  const consoleLog = [];
  const open = async (label, query) => {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 640 } });
    const page = await ctx.newPage();
    page.on('console', (m) => consoleLog.push(`[${label}] ${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => consoleLog.push(`[${label}] pageerror: ${e.message}`));
    await page.goto(`${base}?${query}`);
    await page.waitForFunction(() => window.__wp08.store.getState().status === 'online' || window.__wp08.error, null, { timeout: 30000 });
    const err = await page.evaluate(() => window.__wp08.error);
    if (err) throw new Error(`${label}: ${err}`);
    return page;
  };

  // ---------------- connect three players ----------------
  step('--- connect: real director tickets, two zones ---');
  const A = await open('alice', 'user=wp08alice&name=Alice');
  const B = await open('bob', 'user=wp08bob&name=Bob');
  const L = await open('lina', 'local=1&name=Lina&x=2058&z=2048');
  const info = async (p) => p.evaluate(() => ({ zone: window.__wp08.connect.zone.zoneId, region: window.__wp08.connect.region, local: window.__wp08.connect.isLocalProfile, name: window.__wp08.connect.character.name }));
  const [ia, ib, il] = [await info(A), await info(B), await info(L)];
  check(ia.zone === 'zone-east' && ib.zone === 'zone-west', 'director assigned Alice and Bob to different zones', { alice: ia, bob: ib });
  check(il.local && il.zone === 'zone-east', 'Lina is a local profile on zone-east', il);
  await sleep(1200); // first presence frames (2 Hz) -> zone history

  // ---------------- global ----------------
  step('--- global ---');
  await tab(A, 'global');
  await say(A, 'Hello from the east!');
  await waitLine(B, 'global', 'Hello from the east!');
  await waitLine(L, 'global', 'Hello from the east!');
  check(true, 'global: Alice (zone-east) -> Bob (zone-west) and Lina');
  await say(A, 'second global line too soon');
  await waitNotice(A, 'slow mode');
  check(!(await tabTexts(B, 'global')).includes('second global line too soon'), 'global slow mode: second message within 10 s refused and not delivered');
  await tab(L, 'global');
  await say(L, 'can locals talk here?');
  await waitNotice(L, 'Global chat needs an account');
  check(true, 'local profile cannot send global chat (but reads it)');
  await A.screenshot({ path: shot('01-global-slowmode-alice') });

  // ---------------- zone ----------------
  step('--- zone ---');
  await say(A, '/z anyone in region 2,2?');
  await waitLine(L, 'zone', 'anyone in region 2,2?');
  await sleep(500);
  check(!(await tabTexts(B, 'zone')).includes('anyone in region 2,2?'), 'zone: reaches Lina (same region), not Bob (region 0,0)');

  // ---------------- local + bubbles ----------------
  step('--- local + speech bubbles ---');
  await say(A, '/s psst, over here');
  await waitLine(L, 'local', 'psst, over here');
  await L.waitForFunction(() => window.__wp08.bubbles().some((b) => b.name === 'Alice' && b.text === 'psst, over here'));
  await sleep(500);
  check(!(await tabTexts(B, 'local')).includes('psst, over here'), 'local: reaches Lina 10 m away (with a speech bubble), not Bob 2 km away');
  await closeChat(L);
  await L.screenshot({ path: shot('02-local-bubble-lina') });

  // ---------------- whispers across zones ----------------
  step('--- whispers across zones ---');
  await closeChat(B);
  await say(A, '/w bob meet me at the tower');
  await B.waitForFunction(() => window.__wp08.store.getState().toasts.some((t) => t.text === 'meet me at the tower'));
  await B.getByTestId('chat-toast').first().waitFor();
  check(true, 'whisper zone-east -> zone-west delivered; toast while Bob\'s chat is closed');
  // Bob never opened chat: Alice's global line and the whisper are both unread.
  check((await B.getByTestId('chat-open').textContent()).includes('2 new'), 'unread count on the closed chat button', await B.getByTestId('chat-open').textContent());
  await B.screenshot({ path: shot('03-whisper-toast-bob') });
  await openChat(B);
  check((await B.getByTestId('chat-unread-w:alice').textContent()) === '1', 'whisper tab "Alice" shows 1 unread');
  await B.screenshot({ path: shot('04-whisper-tab-unread-bob') });
  await tab(B, 'w:alice');
  await say(B, '/r on my way');
  await waitLine(A, 'w:bob', 'on my way');
  check(true, '/r reply zone-west -> zone-east');
  await say(A, '/w Nobody_Here hello?');
  await waitNotice(A, 'no one called');
  check(true, 'whisper to unknown name -> "There is no one called ..."');

  // ---------------- party across zones ----------------
  step('--- party across zones ---');
  await tab(A, 'party');
  await say(A, '/invite Bob');
  await B.getByTestId('party-accept').click();
  await A.waitForFunction(() => window.__wp08.store.getState().party?.members.length === 2);
  await say(A, 'party check');
  await waitLine(B, 'party', 'party check');
  await sleep(400);
  check(!(await tabTexts(L, 'party')).includes('party check'), 'party chat reaches Bob across zones, not Lina');
  const party = await A.evaluate(() => window.__wp08.store.getState().party);
  check(party.members.every((m) => m.online) && party.members.some((m) => m.name === 'Bob' && m.region === '0,0'), 'party frame shows members online with regions', party.members);
  await A.screenshot({ path: shot('05-party-alice') });

  // ---------------- friends + local-profile whisper rules ----------------
  step('--- friends + local-profile rules ---');
  await say(L, '/w Alice hi stranger');
  await waitNotice(L, 'Local profiles can whisper only friends and party members');
  check(true, 'local profile cannot whisper a stranger');
  await L.getByTestId('friends-toggle').click();
  await L.getByTestId('friend-add').fill('alice');
  await L.getByTestId('friend-add').press('Enter');
  await A.getByTestId('friends-toggle').click();
  await A.getByTestId('friend-incoming').getByText('Accept').click();
  await A.waitForFunction(() => window.__wp08.store.getState().friends.some((f) => f.name === 'Lina' && f.state === 'accepted' && f.online && f.region === '2,2'));
  check(true, 'friend request -> accept; friends list shows Lina online in region 2,2');
  await A.screenshot({ path: shot('06-friends-alice') });
  await say(L, '/w Alice hi friend');
  await waitLine(A, 'w:lina', 'hi friend');
  check(true, 'local profile whispers a friend');

  // ---------------- block: whispers silently dropped ----------------
  step('--- block ---');
  await say(B, '/w Lina hello Lina');
  await waitLine(L, 'w:bob', 'hello Lina');
  await say(L, '/block Bob');
  await L.waitForFunction(() => window.__wp08.store.getState().relations.blocked.includes('Bob'));
  const bobWhisperTabBefore = (await tabTexts(B, 'w:lina')).length;
  await say(B, '/w Lina are you ignoring me?');
  await waitLine(B, 'w:lina', 'are you ignoring me?');
  await sleep(800);
  const bobSees = await tabTexts(B, 'w:lina');
  check(!bobSees.some((t) => t.includes('offline')) && bobSees.length === bobWhisperTabBefore + 1, 'blocked: Bob sees his own line and no offline/blocked notice (status "delivered")', bobSees);
  check(!(await tabTexts(L, 'w:bob')).includes('are you ignoring me?'), 'blocked: Lina never receives the whisper');
  await say(B, '/g Lina, why so quiet');
  await waitLine(A, 'global', 'Lina, why so quiet');
  await sleep(400);
  check(!(await tabTexts(L, 'global')).includes('Lina, why so quiet'), 'blocked: Bob\'s global chat hidden from Lina');
  await L.screenshot({ path: shot('07-block-lina') });

  // ---------------- report + admin CLI ----------------
  step('--- report + admin CLI ---');
  await tab(L, 'w:bob');
  await say(L, '/report Bob unwanted whispers');
  await waitNotice(L, 'report about Bob');
  const reports = binSync('admin', ['reports'], svcEnv);
  const reportId = reports.trim().split('\n')[0].split(/\s+/)[0];
  const report = binSync('admin', ['report', reportId], svcEnv);
  check(report.includes('hello Lina') && report.includes('whisper'), 'report stored in Postgres with the whisper conversation as context');
  const muteOut = binSync('admin', ['mute', 'Bob', '-reason', 'e2e'], svcEnv);
  await waitNotice(B, 'muted by a moderator');
  await say(B, '/p can I still talk?');
  await waitNotice(B, 'You are muted by a moderator.');
  check(!(await tabTexts(A, 'party')).includes('can I still talk?'), 'admin mute applies live: Bob cannot send');
  const unmuteOut = binSync('admin', ['unmute', 'Bob'], svcEnv);
  await waitNotice(B, 'lifted your mute');
  const resolveOut = binSync('admin', ['resolve', reportId, 'warned Bob'], svcEnv);
  fs.writeFileSync(path.join(EVIDENCE, 'wp08-admin.txt'),
    `$ admin reports\n${reports}\n$ admin report ${reportId}\n${report}\n$ admin mute Bob -reason e2e\n${muteOut}\n$ admin unmute Bob\n${unmuteOut}\n$ admin resolve ${reportId} "warned Bob"\n${resolveOut}`);
  check(true, 'admin CLI: reports, report, mute, unmute, resolve (docs/evidence/wp08-admin.txt)');
  await B.screenshot({ path: shot('08-admin-mute-bob') });

  // ---------------- system + reconnect ----------------
  step('--- reconnect keeps party; history on join ---');
  await B.reload();
  await B.waitForFunction(() => window.__wp08.store.getState().status === 'online', null, { timeout: 30000 });
  await B.waitForFunction(() => window.__wp08.store.getState().party?.members.length === 2, null, { timeout: 10000 });
  const bobAfter = await B.evaluate(() => ({ global: window.__wp08.store.getState().tabs.global.length, whisper: (window.__wp08.store.getState().tabs['w:alice'] ?? []).map((l) => l.text) }));
  check(bobAfter.global > 0 && bobAfter.whisper.includes('meet me at the tower'), 'reload: party kept, global and whisper history restored', bobAfter);
  await openChat(A);
  await tab(A, 'system');
  await A.screenshot({ path: shot('09-system-alice') });

  const errors = consoleLog.filter((l) => l.includes('pageerror'));
  check(errors.length === 0, 'no page errors', errors);
  for (const p of [A, B, L]) await p.context().close();

  // ---------------- flood ----------------
  step('--- bot flood against the same social process ---');
  const flood = spawnSync(path.join(TMP, 'flood' + EXE), ['-url', `ws://localhost:${PORT.social}/ws`, '-clients', '50', '-duration', '20s', '-rate', '40', '-json', path.join(EVIDENCE, 'wp08-flood.json')], { cwd: root, env: env(svcEnv), encoding: 'utf8' });
  const metrics = await fetch(`http://localhost:${PORT.social}/metrics`).then((r) => r.text());
  fs.writeFileSync(path.join(EVIDENCE, 'wp08-flood.txt'), flood.stdout + flood.stderr + '\n--- social /metrics after the flood ---\n' + metrics.split('\n').filter((l) => l.startsWith('social_')).join('\n') + '\n');
  check(flood.status === 0, 'flood: rate limits held (docs/evidence/wp08-flood.txt)', flood.stdout.split('\n').filter((l) => /^(global|zone|local|party|whisper|PASS|FAIL)/.test(l)));
  step('ALL PASS');
} catch (e) {
  exitCode = 1;
  step(String(e.stack ?? e));
  for (const f of fs.readdirSync(TMP).filter((f) => f.endsWith('.log'))) {
    step(`--- ${f} (tail) ---\n` + fs.readFileSync(path.join(TMP, f), 'utf8').split('\n').slice(-30).join('\n'));
  }
} finally {
  if (browser) await browser.close();
  for (const c of children) killTree(c);
  fs.writeFileSync(path.join(EVIDENCE, 'wp08-e2e.txt'), lines.join('\n') + '\n');
  if (!process.argv.includes('--keep-db') && svcEnv) {
    try {
      goSync(['run', './server/account/cmd/devdb', 'drop', DB]);
    } catch (e) {
      console.error(String(e));
    }
  }
  process.exit(exitCode);
}
