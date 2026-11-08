#!/usr/bin/env node
// WP17 acceptance (spec 15): mint a world from the seed only, from sliders
// (presets + slider edits) and, with the flag on and a FAKE Messages API,
// from vibe text; then restart with the flag off and show no code path calls
// a model. Real processes: the creator Go endpoint (built binary) on a
// scratch Postgres database + the shared Redis, the fake Messages API
// (cmd/fakeclaude), the Vite app, headless Chromium via Playwright.
//
// Run from the repo root (infra up, wasm built):  npm run e2e -w @lodestone/creator
// Evidence: docs/evidence/wp17-*.png, wp17-e2e.txt, wp17-mint-flag-on.txt,
// wp17-mint-flag-off.txt, wp17-fake-model.txt, wp17-worlds.json
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { env, killTree, root, waitHttp } from '../../../scripts/lib.mjs';

const EVIDENCE = path.join(root, 'docs', 'evidence');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-wp17-'));
const DB = 'lodestone_wp04_wp17e2e'; // devdb only creates lodestone_wp04_* names
// Off the default ports (8094/5177) so a running creator, or another agent's
// server on the same machine, is left alone.
const PORT = { api: 18194, web: 15177, fake: 18195 };
// vite.config.ts reads these when it loads (dev port and /v1 proxy target).
process.env.LODESTONE_CREATOR_PORT = String(PORT.api);
process.env.LODESTONE_CREATOR_WEB_PORT = String(PORT.web);
const EXE = process.platform === 'win32' ? '.exe' : '';
const SEED = '20261108';
const VIBE = `drowned cathedral archipelago, cold, lots of caves (run ${Date.now().toString(36)})`;
// sha256(normalized prompt + "\n" + specVersion), as internal/vibe.CacheKey.
const vibeKey = () => 'creator:vibe:' + crypto.createHash('sha256').update(VIBE.toLowerCase().split(/\s+/).filter(Boolean).join(' ') + '\n1').digest('hex');

fs.mkdirSync(EVIDENCE, { recursive: true });
const lines = [];
const step = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  lines.push(line);
};
const check = (cond, msg, detail) => {
  if (!cond) throw new Error(`FAIL ${msg}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  step(`PASS ${msg}${detail === undefined ? '' : '  ' + JSON.stringify(detail)}`);
};
const shot = (name) => path.join(EVIDENCE, `wp17-${name}.png`);

function goSync(args) {
  const r = spawnSync('go', args, { cwd: root, env: env(), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`go ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

const children = new Set();
function startBin(name, args, extra, logFile) {
  const out = fs.createWriteStream(logFile);
  const child = spawn(path.join(TMP, name + EXE), args, { cwd: root, env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}
async function stopBin(child) {
  const done = new Promise((r) => child.once('exit', r));
  killTree(child);
  await done;
}

let vite;
let browser;
let dbURL;
let fakeLog;
async function main() {
  step('build creator + fakeclaude binaries');
  goSync(['build', '-o', path.join(TMP, 'creator' + EXE), './tools/creator/server']);
  goSync(['build', '-o', path.join(TMP, 'fakeclaude' + EXE), './tools/creator/server/cmd/fakeclaude']);
  dbURL = goSync(['run', './server/account/cmd/devdb', 'create', DB]).trim().split('\n').pop();
  step(`scratch database ${DB}`);

  fakeLog = path.join(EVIDENCE, 'wp17-fake-model.txt');
  startBin('fakeclaude', ['-addr', `127.0.0.1:${PORT.fake}`], {}, fakeLog);
  const creatorEnv = (llm) => ({
    LODESTONE_CREATOR_PORT: String(PORT.api),
    LODESTONE_PG_URL: dbURL,
    LODESTONE_CREATOR_LLM: llm,
    ANTHROPIC_API_KEY: 'sk-fake-e2e-not-a-real-key',
    LODESTONE_CREATOR_LLM_BASE_URL: `http://127.0.0.1:${PORT.fake}`,
  });
  let creator = startBin('creator', [], creatorEnv('1'), path.join(EVIDENCE, 'wp17-mint-flag-on.txt'));
  check(await waitHttp(`http://127.0.0.1:${PORT.api}/healthz`), 'creator endpoint up (LODESTONE_CREATOR_LLM=1, fake Messages API)');

  vite = await createServer({ configFile: path.join(root, 'tools', 'creator', 'vite.config.ts') });
  await vite.listen();
  step(`vite on ${PORT.web}`);

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1480, height: 1060 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  const waitPreview = async (prevHash) => {
    await page.waitForFunction((h) => document.body.dataset.busy === '0' && !!document.body.dataset.previewHash && document.body.dataset.previewHash !== h, prevHash, { timeout: 60000 });
    return page.evaluate(() => document.body.dataset.previewHash);
  };
  const mint = async () => {
    await page.waitForSelector('#mint:not([disabled])');
    const before = await page.evaluate(() => document.querySelector('#mintresult')?.getAttribute('data-world-id') ?? '');
    await page.click('#mint');
    await page.waitForFunction((b) => {
      const el = document.querySelector('#mintresult');
      return el && el.getAttribute('data-world-id') !== b;
    }, before, { timeout: 60000 });
    return page.evaluate(() => {
      const el = document.querySelector('#mintresult');
      return { id: el.dataset.worldId, atlasHash: el.dataset.atlasHash, matches: el.dataset.matchesPreview === 'true', text: el.textContent.replace(/\s+/g, ' ').trim() };
    });
  };

  // 1. Seed only (the default path).
  await page.goto(`http://localhost:${PORT.web}/?seed=${SEED}`);
  await page.waitForSelector('body[data-ready="1"][data-server="1"]', { timeout: 60000 });
  let hash = await waitPreview('');
  check((await page.textContent('#mode')) === 'seed only', 'page opens in seed-only mode', { seed: SEED, previewHash: hash });
  // Screenshots are taken after each mint so the preview and the server's
  // result (atlas hash match) are on the same image.
  let m = await mint();
  await page.screenshot({ path: shot('01-seed-only') });
  check(m.matches, 'seed-only mint: server atlas hash == browser preview hash', m);
  const minted = [{ source: 'seed', ...m }];

  // 2. Preset: Archipelago.
  await page.click('button[data-preset="archipelago"]');
  hash = await waitPreview(hash);
  check((await page.textContent('#mode')) === 'preset: Archipelago', 'Archipelago preset applied, preview regenerated', { previewHash: hash });
  m = await mint();
  await page.screenshot({ path: shot('02-preset-archipelago') });
  check(m.matches && m.text.includes('(preset)'), 'preset mint: hashes match', m);
  minted.push({ source: 'preset:archipelago', ...m });

  // 3. Back to the seed, then slider edits only (no preset): taller, colder,
  // shallower caves, renamed.
  await page.click('#fromseed');
  hash = await waitPreview(hash);
  const setSlider = (key, value) =>
    page.$eval(`input[data-key="${key}"]`, (el, v) => {
      el.value = String(v);
      el.dispatchEvent(new el.ownerDocument.defaultView.Event('input', { bubbles: true }));
    }, value);
  await setSlider('mountainHeight', 1);
  await setSlider('landFraction', 0.88);
  await setSlider('temperatureBias', -0.6);
  await setSlider('biomeWeights.snowpeak', 1);
  await setSlider('biomeWeights.highlands', 1);
  await setSlider('caveMaxDepth', 120);
  await page.fill('#name', 'Crown of Spires');
  hash = await waitPreview(hash);
  const validation = (await page.textContent('#validation')).replace(/\s+/g, ' ').trim();
  check((await page.textContent('#mode')) === 'edited', 'slider edits switch the spec to "edited" and normalize it', validation);
  m = await mint();
  await page.screenshot({ path: shot('03-sliders') });
  check(m.matches && m.text.includes('Crown of Spires') && m.text.includes('(sliders)'), 'slider mint: hashes match', m);
  minted.push({ source: 'sliders', ...m });

  // 4. Highland and Badlands preset screenshots (preview only).
  for (const p of ['highland', 'badlands']) {
    await page.click(`button[data-preset="${p}"]`);
    hash = await waitPreview(hash);
    await page.screenshot({ path: shot(`04-preset-${p}`) });
    step(`${p} preview ${hash}`);
  }

  // 5. Vibe text (flag on, fake model). The run tag keeps the shared Redis
  // cache from answering with an earlier run's entry; the key is deleted at
  // the end.
  await page.fill('#vibe', VIBE);
  await page.click('#vibego');
  await page.waitForSelector('#vibeok', { timeout: 30000 });
  hash = await waitPreview(hash);
  const vibeText = (await page.textContent('#vibeok')).replace(/\s+/g, ' ');
  check((await page.textContent('#mode')) === 'from vibe' && vibeText.includes('caveDensity clamped'), 'vibe filled the sliders; clamp notice shown', vibeText);
  check((await page.inputValue('#name')) === 'The Drowned Cathedral Archipelago', 'vibe name in the name field');
  m = await mint();
  await page.screenshot({ path: shot('05-vibe') });
  check(m.matches && m.text.includes('(vibe)'), 'vibe mint: hashes match', m);
  minted.push({ source: 'vibe', ...m });
  // Same vibe again: served from the cache, no model call.
  await page.fill('#vibe', `  ${VIBE.toUpperCase()}   `);
  await page.click('#vibego');
  await page.waitForFunction(() => document.querySelector('#vibeok')?.textContent.startsWith('From cache'), null, { timeout: 30000 });
  step('repeat vibe served from cache');
  const fakeCallsFlagOn = (fs.readFileSync(fakeLog, 'utf8').match(/request #/g) ?? []).length;
  check(fakeCallsFlagOn === 1, 'fake Messages API saw exactly one request (second vibe was cached)', { fakeCallsFlagOn });

  // 6. Flag off: restart the endpoint without LODESTONE_CREATOR_LLM.
  await stopBin(creator);
  creator = startBin('creator', [], creatorEnv('0'), path.join(EVIDENCE, 'wp17-mint-flag-off.txt'));
  check(await waitHttp(`http://127.0.0.1:${PORT.api}/healthz`), 'creator endpoint restarted with LODESTONE_CREATOR_LLM=0 (key still set)');
  await page.goto(`http://localhost:${PORT.web}/?seed=777`);
  await page.waitForSelector('body[data-ready="1"][data-server="1"]', { timeout: 60000 });
  hash = await waitPreview('');
  check(await page.isDisabled('#vibego'), 'vibe button disabled with the flag off');
  check(!!(await page.$('#vibeoff')), 'flag-off notice shown', (await page.textContent('#vibeoff')).trim());
  const direct = await page.evaluate(async () => {
    const r = await fetch('/v1/vibe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'frozen isles', seed: '1' }) });
    return { status: r.status, body: await r.json() };
  });
  check(direct.status === 503 && direct.body.error === 'llm_disabled', 'POST /v1/vibe with the flag off -> 503 llm_disabled', direct);
  await page.click('button[data-preset="frostreach"]');
  hash = await waitPreview(hash);
  m = await mint();
  await page.screenshot({ path: shot('06-flag-off-frostreach') });
  check(m.matches, 'flag off: preset mint still works', m);
  minted.push({ source: 'preset:frostreach (flag off)', ...m });
  const fakeCallsAfter = (fs.readFileSync(fakeLog, 'utf8').match(/request #/g) ?? []).length;
  check(fakeCallsAfter === fakeCallsFlagOn, 'flag off: zero requests reached the (fake) model', { fakeCallsAfter });

  const worlds = await (await fetch(`http://127.0.0.1:${PORT.api}/v1/worlds`)).json();
  fs.writeFileSync(path.join(EVIDENCE, 'wp17-worlds.json'), JSON.stringify(worlds, null, 2) + '\n');
  check(worlds.worlds.length === minted.length, 'worlds table has one row per mint', worlds.worlds.map((w) => `${w.name} seed=${w.seed} gen=${w.genVersion} atlas=${w.atlasHash}`));
  // The only expected console error is the browser logging the deliberate 503 above.
  const unexpected = errors.filter((e) => !e.includes('status of 503'));
  check(unexpected.length === 0, 'no page errors', unexpected);
  await stopBin(creator);
}

try {
  await main();
  step('ALL PASS');
} catch (e) {
  step(String(e.stack ?? e));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await vite?.close().catch(() => {});
  for (const c of children) killTree(c);
  // Best effort: drop this run's vibe cache entry from the shared Redis.
  const del = spawnSync('docker', ['exec', 'lodestone-redis-1', 'redis-cli', 'DEL', vibeKey()], { encoding: 'utf8' });
  step(`vibe cache cleanup: DEL ${vibeKey().slice(0, 29)}... -> ${(del.stdout ?? '').trim() || del.error?.message || 'n/a'}`);
  if (dbURL && !process.argv.includes('--keep-db')) {
    try {
      goSync(['run', './server/account/cmd/devdb', 'drop', DB]);
      step(`dropped ${DB}`);
    } catch (e) {
      step(`could not drop ${DB}: ${e.message}`);
    }
  }
  fs.writeFileSync(path.join(EVIDENCE, 'wp17-e2e.txt'), lines.join('\n') + '\n');
}
