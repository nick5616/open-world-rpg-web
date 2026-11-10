// Playtest pass 8: how you look and cast: third-person body and weapon, and
// where spells leave (sword: the off hand; staff: its tip), first and third person.
import { launch, newCharacter, sleep, look, dismissCards } from './lib.mjs';

const out = process.argv[2] ?? 'tmp/playtest8';
const t = await launch(out);
const { page, shot, note, issue } = t;
const cast = async (name, delay = 140) => {
  await page.keyboard.press('Digit1');
  await sleep(delay);
  await shot(name);
  await sleep(120);
  await shot(`${name}-b`);
  await sleep(900);
};
try {
  await newCharacter(page, 'Caster' + (Date.now() % 100000));
  await sleep(9000); // past the discovery card
  await dismissCards(page);
  await look(page, Math.PI * 0.9, -0.05);
  await sleep(500);
  await cast('fp-sword-cast');
  await page.keyboard.press('KeyT');
  await sleep(1200);
  await shot('tp-sword-idle');
  await cast('tp-sword-cast', 180);
  await page.keyboard.press('KeyX'); // loadout 2: the training staff
  await sleep(1500);
  await shot('tp-staff-idle');
  await cast('tp-staff-cast', 180);
  await page.mouse.move(800, 450);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.up({ button: 'middle' });
  await sleep(1200);
  const third = await page.evaluate(() => document.body.innerText.includes('First person') ? document.querySelector('button[aria-pressed="true"]')?.textContent ?? 'unknown' : 'n/a');
  note(`after middle click: third person = ${third}`);
  await shot('fp-staff-idle');
  await cast('fp-staff-cast', 140);
} catch (e) {
  issue('script', String(e?.stack ?? e).slice(0, 600));
  await shot('error').catch(() => {});
} finally {
  t.save();
  await t.browser.close();
}
