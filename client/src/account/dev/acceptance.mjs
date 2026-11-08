#!/usr/bin/env node
// WP04 acceptance (spec 15): a headless browser signs in, creates a
// character and receives a zone ticket, which a Go test then verifies with
// ticket.Verify exactly as a zone server would. Also walks the local-profile
// path: profile -> character -> blob in IndexedDB -> tamper fails -> old
// counter fails -> export -> import -> upgrade to an account.
//
// Real processes throughout: account + director binaries on a scratch
// Postgres database (dropped afterwards), the shared Redis, Vite on 5174,
// Chromium via Playwright. WP03's zone isn't merged yet, so a fake zone entry
// is announced in the registry (server/director/cmd/fakezone).
//
// Run from the repo root (infra up):  node client/src/account/dev/acceptance.mjs
// Evidence: docs/evidence/wp04-*.png, wp04-acceptance.txt, wp04-tickets.json
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { env, killTree, root, waitHttp } from '../../../../scripts/lib.mjs';

const EVIDENCE = path.join(root, 'docs', 'evidence');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-wp04-'));
const DB = 'lodestone_wp04_e2e';
// Off the default ports so a running `npm run dev` stack is left alone.
const PORT = { account: 18091, director: 18090, vite: 5174 };
const EXE = process.platform === 'win32' ? '.exe' : '';
const FAKE_ZONE = 'wp04-fake-zone';

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
const shot = (name) => path.join(EVIDENCE, `wp04-${name}.png`);

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

const tickets = [];
async function readyTicket(page, label) {
  const r = await page.evaluate(() => {
    const s = window.__wp04.lastReady;
    return { ticket: s.ticket, socialTicket: s.socialTicket, zoneId: s.zoneId, zoneEndpoint: s.zoneEndpoint, socialEndpoint: s.socialEndpoint, worldId: s.worldId, character: s.character, isLocalProfile: s.isLocalProfile, saveCounter: s.save?.counter ?? null, ticketExpiresAt: s.ticketExpiresAt };
  });
  tickets.push({ label, ticket: r.ticket, socialTicket: r.socialTicket, zoneId: r.zoneId, worldId: r.worldId, characterId: r.character.id, characterName: r.character.name, isLocalProfile: r.isLocalProfile, receivedAt: Date.now() });
  return r;
}

let browser;
let exitCode = 0;
try {
  step(`scratch database ${DB}`);
  const pgUrl = goSync(['run', './server/account/cmd/devdb', 'create', DB]).trim().split('\n').pop();
  const svcEnv = {
    LODESTONE_PG_URL: pgUrl,
    LODESTONE_ACCOUNT_PORT: String(PORT.account),
    LODESTONE_DIRECTOR_PORT: String(PORT.director),
    LODESTONE_DEV_AUTH: '1',
    LODESTONE_CORS_ORIGIN: '*',
  };
  step('building account, director, fakezone');
  for (const [name, pkg] of [['account', './server/account'], ['director', './server/director'], ['fakezone', './server/director/cmd/fakezone']]) {
    goSync(['build', '-o', path.join(TMP, name + EXE), pkg]);
  }
  start('account', path.join(TMP, 'account' + EXE), [], svcEnv);
  check(await waitHttp(`http://localhost:${PORT.account}/healthz`, 30000), `account healthy on :${PORT.account}`);
  start('director', path.join(TMP, 'director' + EXE), [], svcEnv);
  check(await waitHttp(`http://localhost:${PORT.director}/healthz`, 30000), `director healthy on :${PORT.director}`);
  start('vite', process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT.vite), '--strictPort'], {
    VITE_ACCOUNT_URL: `http://localhost:${PORT.account}`,
    VITE_DIRECTOR_URL: `http://localhost:${PORT.director}`,
  }, path.join(root, 'client'));
  const pageUrl = `http://localhost:${PORT.vite}/account-dev.html`;
  check(await waitHttp(pageUrl, 60000), `vite serving ${pageUrl}`);

  browser = await chromium.launch();
  const consoleLog = [];
  const newPage = async (label) => {
    const ctx = await browser.newContext({ viewport: { width: 760, height: 820 }, acceptDownloads: true });
    const page = await ctx.newPage();
    page.on('console', (m) => consoleLog.push(`[${label}] ${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => consoleLog.push(`[${label}] pageerror: ${e.message}`));
    await page.goto(pageUrl);
    await page.getByTestId('auth-local').waitFor();
    return page;
  };

  // ---------------- account path (dev auth) ----------------
  step('--- account path ---');
  const a = await newPage('account');
  check(await a.getByTestId('auth-google').count() === 0, 'Google button hidden without a Firebase config');
  await a.screenshot({ path: shot('01-choose') });
  await a.getByTestId('auth-dev-username').fill('nicole');
  await a.getByTestId('auth-dev-submit').click();
  await a.getByTestId('char-name').fill('Nicole');
  await a.getByTestId('char-create').click();
  await a.getByTestId('play-Nicole').waitFor();
  check(true, 'dev sign-in and character "Nicole" created');
  await a.getByTestId('char-name').fill('NICOLE');
  await a.getByTestId('char-create').click();
  await a.getByTestId('error').waitFor();
  check((await a.getByTestId('error').textContent()).includes('taken'), 'duplicate name (case-insensitive) refused', await a.getByTestId('error').textContent());
  await a.getByTestId('char-name').fill('no spaces');
  await a.getByTestId('char-create').click();
  await a.waitForFunction(() => document.querySelector('[data-testid=error]')?.textContent?.includes('letters'));
  check(true, 'invalid name refused', await a.getByTestId('error').textContent());
  await a.screenshot({ path: shot('02-characters') });

  // No zone registered yet: the director says "waking the world" and the client keeps retrying.
  await a.getByTestId('play-Nicole').click();
  await a.getByTestId('waking').waitFor({ timeout: 15000 });
  check(true, 'no live zone -> 503 waking_world, client shows "Waking the world…"');
  await a.screenshot({ path: shot('03-waking') });
  start('fakezone', path.join(TMP, 'fakezone' + EXE), ['-zone', FAKE_ZONE, '-endpoint', 'ws://localhost:8092/ws'], svcEnv);
  step(`fake zone "${FAKE_ZONE}" announced in zones:{worldId}`);
  await a.getByTestId('ready-session').waitFor({ timeout: 30000 });
  const accReady = await readyTicket(a, 'account');
  check(accReady.zoneId === FAKE_ZONE && accReady.ticket.length > 50 && !accReady.isLocalProfile, 'client retried and received a zone ticket + social ticket', { zone: accReady.zoneId, endpoint: accReady.zoneEndpoint, social: accReady.socialEndpoint });
  await a.screenshot({ path: shot('04-ticket') });

  // ---------------- local profile path ----------------
  step('--- local profile path ---');
  const l = await newPage('local');
  await l.getByTestId('auth-local').click();
  await l.getByTestId('char-name').fill('Wanderer');
  await l.getByTestId('char-create').click();
  await l.getByTestId('play-Wanderer').waitFor();
  const idb = await l.evaluate(async () => {
    const st = await window.__wp04.SaveStore.open();
    const p = await st.getProfile();
    const saves = await st.listSaves(p.profileId);
    return { profileId: p.profileId, stores: await st.storeNames(), saves: saves.map((s) => ({ characterId: s.characterId, counter: s.blob.counter, format: s.blob.format, state: JSON.parse(s.blob.state) })) };
  });
  check(idb.saves.length === 1 && idb.saves[0].counter === 1 && idb.saves[0].state.name === 'Wanderer', 'local character created; signed blob (counter 1) stored in IndexedDB object store "saves"', { profile: idb.profileId, stores: idb.stores, save: idb.saves[0] });
  await l.screenshot({ path: shot('05-local-profile') });

  const r = await l.evaluate(async () => {
    const { api, SaveStore } = window.__wp04;
    const st = await SaveStore.open();
    const p = await st.getProfile();
    const sess = (await api.localSession(p.profileId, p.profileSecret)).session;
    const blob1 = (await st.listSaves(p.profileId))[0].blob;
    const code = async (fn) => {
      try {
        await fn();
        return 'accepted';
      } catch (e) {
        return e.code;
      }
    };
    const out = {};
    const evil = { ...blob1, state: blob1.state.replace('"level":1', '"level":99') };
    out.tamperedVerify = await code(() => api.verifySave(sess, evil));
    out.tamperedConnect = await code(() => api.connect(sess, blob1.characterId, evil));
    // A save point (the zone, later; the dev endpoint stands in) issues counter 2.
    const blob2 = await api.devResave(sess, blob1, { level: 4, xp: 777 });
    out.blob2Counter = blob2.counter;
    out.stored2 = await st.putSave(blob2);
    out.storeRefusesOlder = !(await st.putSave(blob1));
    out.oldVerify = await code(() => api.verifySave(sess, blob1));
    out.oldConnect = await code(() => api.connect(sess, blob1.characterId, blob1));
    out.newestVerify = (await api.verifySave(sess, blob2)).ok;
    out.storedCounter = (await st.getSave(blob1.characterId)).blob.counter;
    return out;
  });
  check(r.tamperedVerify === 'bad_signature' && r.tamperedConnect === 'bad_signature', 'tampered blob (level 1 -> 99) fails the signature at account service and director', r);
  check(r.blob2Counter === 2 && r.stored2 && r.storeRefusesOlder && r.storedCounter === 2, 'save point issued counter 2; IndexedDB keeps the newest and refuses to overwrite it with counter 1');
  check(r.oldVerify === 'stale_save' && r.oldConnect === 'stale_save' && r.newestVerify === true, 'old blob (counter 1) fails the counter check; newest (counter 2) verifies');

  const caches = await l.evaluate(async () => {
    const { openLodestoneDb, clearCaches, SaveStore } = window.__wp04;
    const db = await openLodestoneDb([{ name: 'cache:wp04-test', keyPath: 'k' }]);
    await new Promise((res, rej) => {
      const tx = db.transaction('cache:wp04-test', 'readwrite');
      tx.objectStore('cache:wp04-test').put({ k: 'atlas', v: new Uint8Array(1024) });
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    const cleared = await clearCaches(db);
    db.close();
    const st = await SaveStore.open();
    const p = await st.getProfile();
    return { cleared, stores: await st.storeNames(), saves: (await st.listSaves(p.profileId)).length };
  });
  check(caches.cleared.includes('cache:wp04-test') && caches.saves === 1, 'clearing cache stores leaves saves intact (separate object stores in one DB)', caches);

  await l.reload();
  await l.getByTestId('auth-local').click();
  await l.getByTestId('play-Wanderer').waitFor();
  await l.getByTestId('play-Wanderer').click();
  await l.getByTestId('ready-session').waitFor({ timeout: 30000 });
  const locReady = await readyTicket(l, 'local');
  check(locReady.isLocalProfile && locReady.saveCounter === 2 && locReady.zoneId === FAKE_ZONE, 'local character presents its newest blob and receives a zone ticket', { zone: locReady.zoneId, save: locReady.saveCounter });
  await l.screenshot({ path: shot('06-local-ticket') });

  const [dl] = await Promise.all([l.waitForEvent('download'), l.getByTestId('export').click()]);
  const exportPath = path.join(TMP, 'profile-export.json');
  await dl.saveAs(exportPath);
  const exp = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  check(exp.format === 'lodestone-profile-export' && exp.saves.length === 1 && exp.saves[0].counter === 2, 'Export downloads a profile file with the newest blob', { file: dl.suggestedFilename(), saves: exp.saves.length, counter: exp.saves[0].counter });

  // An edited export is refused on import.
  const evilPath = path.join(TMP, 'profile-export-tampered.json');
  const evilExp = JSON.parse(JSON.stringify(exp));
  evilExp.saves[0].state = evilExp.saves[0].state.replace('"level":4', '"level":60');
  fs.writeFileSync(evilPath, JSON.stringify(evilExp));
  const t = await newPage('tampered-import');
  await t.getByTestId('import-file').setInputFiles(evilPath);
  await t.getByTestId('error').waitFor();
  check((await t.getByTestId('error').textContent()).includes('modified'), 'importing an edited profile file is refused', await t.getByTestId('error').textContent());

  // Import into a fresh browser (another device).
  const i = await newPage('import');
  await i.getByTestId('import-file').setInputFiles(exportPath);
  await i.getByTestId('play-Wanderer').waitFor();
  const listText = await i.getByTestId('character-list').textContent();
  check(listText.includes('save #2') && listText.includes('lv 4'), 'Import restores the profile and its newest save (level 4) in a fresh browser', listText);
  await i.screenshot({ path: shot('07-imported') });

  // Upgrade the imported profile to a (dev) account.
  await i.getByTestId('upgrade').click();
  await i.getByTestId('auth-dev-username').fill('upgrader');
  await i.getByTestId('auth-dev-submit').click();
  await i.waitForFunction(() => document.querySelector('[data-testid=status]')?.textContent?.includes('Upgraded'));
  const after = await i.getByTestId('character-list').textContent();
  const who = await i.getByTestId('signed-in-as').textContent();
  check(who.startsWith('Account') && after.includes('Wanderer') && after.includes('lv 4') && !after.includes('save #'), 'Upgrade imports the verified blob into Postgres: Wanderer is now an account character at level 4', { who, after });
  await i.screenshot({ path: shot('08-upgraded') });
  const gone = await i.evaluate(async () => {
    const { api, SaveStore } = window.__wp04;
    const p = await (await SaveStore.open()).getProfile();
    try {
      await api.localSession(p.profileId, p.profileSecret);
      return 'accepted';
    } catch (e) {
      return e.code;
    }
  });
  check(gone === 'profile_upgraded', 'the upgraded local profile can no longer open sessions (410 profile_upgraded)');
  await i.getByTestId('play-Wanderer').click();
  await i.getByTestId('ready-session').waitFor({ timeout: 30000 });
  const upReady = await readyTicket(i, 'upgraded-account');
  check(!upReady.isLocalProfile && upReady.character.level === 4, 'upgraded character plays from its account with a zone ticket', { level: upReady.character.level });

  // ---------------- Go-side ticket verification ----------------
  const ticketFile = path.join(EVIDENCE, 'wp04-tickets.json');
  fs.writeFileSync(ticketFile, JSON.stringify(tickets, null, 2) + '\n');
  step('go test: ticket.Verify on the tickets the browser received (as a zone server would)');
  const gt = spawnSync('go', ['test', '-count=1', '-v', '-run', 'TestAcceptanceTicketFile', './internal/director'], {
    cwd: path.join(root, 'server', 'director'),
    env: env({ LODESTONE_WP04_TICKET_FILE: ticketFile, LODESTONE_WP04_FRESH: '1' }),
    encoding: 'utf8',
  });
  for (const ln of (gt.stdout + gt.stderr).split('\n').filter((x) => x.trim())) step(`  go> ${ln}`);
  check(gt.status === 0, 'Go ticket.Verify accepts every ticket for its zone (and rejects it for another zone)');

  const errors = consoleLog.filter((x) => x.includes('pageerror'));
  check(errors.length === 0, 'no uncaught page errors', errors);
  step('ALL PASS');
} catch (e) {
  exitCode = 1;
  step(String(e.stack ?? e));
} finally {
  if (browser) await browser.close();
  for (const c of children) killTree(c);
  for (const name of ['account', 'director']) {
    const f = path.join(TMP, `${name}.log`);
    if (!fs.existsSync(f)) continue;
    const keep = fs.readFileSync(f, 'utf8').split('\n').filter((x) => /ticket issued|local profile upgraded|dev auth|insecure|official world|ready|ERROR|error/.test(x));
    step(`--- ${name} log (filtered) ---`);
    for (const k of keep) step(`  ${k}`);
  }
  try {
    goSync(['run', './server/account/cmd/devdb', 'drop', DB]);
    step(`dropped ${DB} and its zone registry keys`);
  } catch (e) {
    step(`cleanup failed: ${e.message}`);
  }
  fs.writeFileSync(path.join(EVIDENCE, 'wp04-acceptance.txt'), lines.join('\n') + '\n');
  process.exit(exitCode);
}
