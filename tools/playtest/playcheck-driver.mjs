// Playtest 4 playcheck: a long-lived headless client you drive with small step files.
//   LODESTONE_CLIENT_URL=<stack url> node tools/playtest/playcheck-driver.mjs <name> <dir>
// Then write <dir>/step.mjs (`export default async (c) => {...}`) and touch <dir>/go; the result of the
// step is written to <dir>/out.json. Used to play features with real input (keys, mouse).
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { launch, newCharacter, sleep, dismissCards, pl, look, walkTo, go, yawTo } from './lib.mjs';

const [name, dir] = [process.argv[2] ?? 'Pc', process.argv[3] ?? 'tmp/pc'];
const t = await launch(dir, { width: 1280, height: 720 });
const { page } = t;
page.on('pageerror', (e) => writeFileSync(`${dir}/pageerror-${Date.now()}.txt`, String(e.stack ?? e)));
const charName = name + Date.now().toString(36).slice(-3);
if (process.env.PC_LOOK) {
  // A customised look: the title screen, the creation screen (screenshots), then play.
  const { BASE } = await import('./lib.mjs');
  await page.goto(BASE + '/');
  await sleep(4000);
  await page.screenshot({ path: `${dir}/00-title.jpg`, type: 'jpeg', quality: 60 });
  await page.getByTestId('play').click({ timeout: 5000 }).catch(() => {});
  await page.getByTestId('account-screen').waitFor({ timeout: 120000 });
  await page.getByTestId('auth-local').click();
  await page.getByTestId('char-name').waitFor({ timeout: 30000 });
  await page.getByTestId('char-name').fill(charName);
  for (const id of ['look-build-2', 'look-skin-5', 'look-hair-3', 'look-haircolor-4', 'look-beard-2', 'look-eyes-3']) await page.getByTestId(id).click().catch(() => {});
  await sleep(1500);
  await page.screenshot({ path: `${dir}/01-creation.jpg`, type: 'jpeg', quality: 60 });
  await page.getByTestId('char-create').click();
  await page.getByTestId(`play-${charName}`).click();
  await page.waitForFunction(() => window.__lodestone?.netDebug?.()?.phase === 'playing', null, { timeout: 120000 });
} else await newCharacter(page, charName);
await sleep(1500);
const c = {
  ...t, sleep, yawTo, dir,
  dismissCards: () => dismissCards(page),
  pl: () => pl(page),
  look: (y, p) => look(page, y, p),
  walkTo: (x, z, o) => walkTo(page, x, z, o),
  go: (x, z, o) => go(page, x, z, o),
  closeAll: async () => {
    for (let i = 0; i < 5; i++) {
      const open = await page.evaluate(() => [...document.querySelectorAll('[data-ui-panel]')].some((e) => e.getClientRects().length > 0));
      if (!open) break;
      await page.keyboard.press('Escape');
      await sleep(350);
    }
    await page.mouse.click(640, 400);
    await sleep(300);
  },
  key: (k, ms = 60) => page.keyboard.down(k).then(() => sleep(ms)).then(() => page.keyboard.up(k)),
  run: (l) => page.evaluate((x) => window.__lodestoneDev.run(x), l),
  devlog: () => page.evaluate(() => window.__lodestoneDev.state().log.slice(-8).map((l) => `${l.kind} ${l.text}`)),
  ev: (fn, arg) => page.evaluate(fn, arg),
  jpg: (n) => page.screenshot({ path: `${dir}/${n}.jpg`, type: 'jpeg', quality: 60 }),
};
writeFileSync(`${dir}/out.json`, JSON.stringify({ ready: true }));
for (let i = 0; ; i++) {
  if (existsSync(`${dir}/stop`)) break;
  if (existsSync(`${dir}/go`)) {
    rmSync(`${dir}/go`);
    let out;
    try {
      const m = await import(pathToFileURL(`${process.cwd()}/${dir}/step.mjs`).href + `?v=${Date.now()}`);
      out = { ok: true, result: await m.default(c) };
    } catch (e) {
      out = { ok: false, error: String(e?.stack ?? e).slice(0, 1500) };
    }
    writeFileSync(`${dir}/out.json`, JSON.stringify(out, null, 1));
  }
  await sleep(300);
}
await t.browser.close();
