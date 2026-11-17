#!/usr/bin/env node
// Pt3 title + creation: drives the REAL screens (title -> sign-in -> character
// select/create -> play) against a mocked account service and director
// (Playwright route interception: no Postgres, no Go), checking the testids the
// acceptance harnesses and infra/smoke-live.mjs click, and that the look
// chosen in the creator is what the account API receives and what comes back.
//
//   node client/scripts/title-flow.mjs        (starts its own Vite on a random port)

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const client = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = 20000 + Math.floor(Math.random() * 20000);
const require = (await import('node:module')).createRequire(import.meta.url);
const viteBin = join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
const vite = spawn(process.execPath, [viteBin, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: client, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
let failures = 0;
const check = (ok, what, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${extra ? ` ${extra}` : ''}`);
  if (!ok) failures++;
};
let browser;
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(base)).ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 120) throw new Error('vite did not start');
    await new Promise((r) => setTimeout(r, 500));
  }
  browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // ---- mocks
  const WORLD = '11111111-1111-4111-8111-111111111111';
  const chars = [];
  const created = [];
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }, body: JSON.stringify(body) });
  await page.route('http://localhost:8090/**', (route) => (route.request().method() === 'OPTIONS' ? json(route, {}) : json(route, { awake: true, state: 'awake', provider: 'none' })));
  await page.route('http://localhost:8091/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'OPTIONS') return json(route, {});
    if (url.pathname === '/v1/auth/config') return json(route, { devAuth: false, firebase: null, localProfiles: true, providers: [] });
    if (url.pathname === '/v1/worlds') return json(route, { worlds: [{ id: WORLD, name: 'Lodestone', seed: '1', spec: {}, genVersion: '3', atlasHash: 'x', official: true }] });
    if (url.pathname === '/v1/local/session') return json(route, { session: 'lss1.mock', expiresAt: Date.now() + 1e7, kind: 'local', profile: { id: 'p', createdAt: '' } });
    if (url.pathname === '/v1/characters' && req.method() === 'GET') return json(route, { characters: chars.map((c) => c.character) });
    if (url.pathname === '/v1/characters' && req.method() === 'POST') {
      const body = JSON.parse(req.postData());
      created.push(body);
      const id = `c${chars.length + 1}`;
      const character = { id, worldId: WORLD, name: body.name, level: 1, xp: 0, position: { x: 0, y: 0, z: 0 }, local: true, profileId: 'p', createdAt: '' };
      const state = JSON.stringify({ characterId: id, name: body.name, level: 1, appearance: body.appearance });
      const save = { format: 'lodestone-save', v: 1, profileId: JSON.parse(req.headers()['x-profile'] ?? '"p"'), characterId: id, worldId: WORLD, counter: 1, issuedAt: 1, state, sig: 'mock' };
      chars.push({ character, save });
      return json(route, { character, save }, 201);
    }
    const del = url.pathname.match(/^\/v1\/characters\/(.+)$/);
    if (del && req.method() === 'DELETE') {
      const i = chars.findIndex((c) => c.character.id === del[1]);
      if (i < 0) return json(route, { error: 'not_found', message: 'no such character' }, 404);
      chars.splice(i, 1);
      return json(route, { ok: true });
    }
    return json(route, { error: 'unmocked', message: url.pathname }, 404);
  });

  // ---- the flow
  await page.goto(`${base}/?cave=0`);
  await page.getByTestId('play').click();
  await page.getByTestId('account-screen').waitFor({ timeout: 20000 });
  check(true, 'title -> account screen (testids play, account-screen)');
  await page.getByTestId('auth-local').click();
  await page.getByTestId('char-name').waitFor({ timeout: 20000 });
  check((await page.getByTestId('account-screen').getAttribute('data-phase')) === 'characters', 'local profile -> characters phase');

  await page.getByTestId('look-hair-5').click();
  await page.getByTestId('look-haircolor-8').click();
  await page.getByTestId('look-beard-3').click();
  await page.getByTestId('look-build-2').click();
  await page.getByTestId('char-name').fill('Thorgrim');
  await page.getByTestId('char-create').click();
  await page.getByTestId('play-Thorgrim').waitFor({ timeout: 10000 });
  check(true, 'create -> the new character is selected with its big Play button (testid play-<name>)');
  const sent = created[0]?.appearance?.look;
  check(sent && sent.hairStyle === 5 && sent.hairColor === 8 && sent.beard === 3 && sent.build === 2, 'the creator sent the chosen look as the appearance', JSON.stringify(sent));
  check((await page.getByTestId('stage-name').textContent()) === 'Thorgrim', 'stage shows the character');
  check((await page.getByTestId('character-list').textContent()).includes('lv 1'), 'character-list shows level');

  // a second character: the first becomes a quick-play row with the same testid
  await page.getByTestId('char-name').fill('Wren');
  await page.getByTestId('look-random').click();
  await page.getByTestId('char-create').click();
  await page.getByTestId('play-Wren').waitFor({ timeout: 10000 });
  check(await page.getByTestId('play-Thorgrim').isVisible(), 'a non-selected character keeps a play-<name> button');

  // delete asks first
  await page.getByTestId('select-Thorgrim').click();
  await page.getByTestId('char-delete').click();
  check(await page.getByTestId('char-delete-confirm').isVisible(), 'delete asks for confirmation');
  await page.getByTestId('char-delete-confirm').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="select-Thorgrim"]'), null, { timeout: 10000 });
  check(chars.length === 1 && chars[0].character.name === 'Wren', 'delete removed the character through DELETE /v1/characters/{id}');
  check(errors.length === 0, 'no page errors', errors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('FAIL', e.message);
  failures++;
} finally {
  await browser?.close();
  vite.kill();
}
process.exitCode = failures ? 1 : 0;
