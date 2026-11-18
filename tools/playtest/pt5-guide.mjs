// Playtest 5 (CR 055): "Guide me" from the journal's Info tab starts the wisp toward a far service (the tower).
//   LODESTONE_CLIENT_URL=<stack url> node tools/playtest/pt5-guide.mjs [outDir]
import { launch, newCharacter, sleep, dismissCards } from './lib.mjs';

const out = process.argv[2] ?? 'docs/evidence';
const A = await launch('tmp/pt5/w', { width: 1280, height: 720 });
try {
  await newCharacter(A.page, `Nic${Date.now().toString(36).slice(-4)}`);
  await sleep(3000);
  await dismissCards(A.page);
  for (let i = 0; i < 6 && !(await A.page.evaluate(() => window.__lodestoneDev?.state().dev === true)); i++) {
    await A.page.keyboard.press('F3').catch(() => {});
    await sleep(2500);
  }
  await A.page.waitForFunction(() => window.__lodestoneDev?.state().dev === true, null, { timeout: 30000 });
  await A.page.evaluate(() => window.__lodestoneDev.run('/god'));
  await A.page.evaluate(() => window.__lodestoneDev.run('/time 10'));
  await sleep(2500);
  await A.page.evaluate(() => window.__lodestoneQuests?.journal(true));
  await sleep(500);
  await A.page.getByTestId('journal-tab-info').click();
  await sleep(500);
  await A.page.locator('[data-testid="info-service"][data-kind="tower"] [data-testid="info-guide"]').click();
  await sleep(3500);
  const wisp = await A.page.evaluate(() => ({ wisp: window.__lodestoneDiegetic?.wisp?.(), head: window.__lodestoneDiegetic?.head?.(), player: window.__lodestone.player() }));
  console.log('wisp:', JSON.stringify(wisp));
  const note = await A.page.evaluate(() => document.querySelector('[data-testid="guide-note"]')?.textContent ?? null);
  console.log('guide note:', note);
  await A.page.screenshot({ path: `${out}/pt5-guidance-guide-wisp.jpg`, type: 'jpeg', quality: 72 });
} finally {
  await A.browser.close();
}
