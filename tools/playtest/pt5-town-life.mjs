/* global window */
// Playtest 5 town life (CR 054): the real client against a private stack
// (node tools/playtest/stack.mjs; the dev console is on). Real key presses
// (E), real frames. Evidence goes to docs/evidence/pt5-town-life-*.jpg and
// pt5-town-life.txt.
//
//   cd client && LODESTONE_CLIENT_URL=<stack url> node ../tools/playtest/pt5-town-life.mjs <outDir> [part ...]
//   parts: names pet cat third sundial weather   (default: all)
import { writeFileSync } from 'node:fs';
import { launch, newCharacter, sleep, dismissCards, pl, look, yawTo } from './lib.mjs';

const out = process.argv[2] ?? 'tmp/pt5-town-life';
const parts = process.argv.slice(3);
const want = (p) => parts.length === 0 || parts.includes(p);
const W = 1280;
const H = 720;
const t = await launch(out, { width: W, height: H });
const { page, note, issue, save } = t;
page.on('console', (m) => { if (m.text().startsWith('[dbg')) console.log(m.text()); });
const results = [];
const check = (ok, what) => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  note(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) issue('check', what);
};
const run = (line) => page.evaluate((l) => window.__lodestoneDev.run(l), line);
const jpg = (name) => page.screenshot({ path: `${out}/pt5-town-life-${name}.jpg`, type: 'jpeg', quality: 72 });
const towns = async (fn, ...a) => {
  await page.waitForFunction(() => !!window.__lodestoneTowns, null, { timeout: 60000 });
  return page.evaluate(([f, args]) => window.__lodestoneTowns[f](...args), [fn, a]);
};
/** Press E like a player and say what the HUD showed and what happened. */
const pressE = async (label) => {
  const before = await page.evaluate(() => ({ target: window.__lodestoneTowns.target(), prompt: document.querySelector('[data-testid="town-prompt"]')?.textContent ?? '' }));
  await page.keyboard.press('KeyE');
  await sleep(350);
  const after = await page.evaluate(() => ({ active: window.__lodestoneTowns.pet().active, toast: document.querySelector('[data-testid="town-toast"]')?.textContent ?? '', last: window.__lodestoneTowns.target() && null }));
  note(`E (${label}): target ${JSON.stringify(before.target)} prompt "${before.prompt}" -> active ${after.active} toast "${after.toast}"`);
  return after.active;
};
const setView = (mode) => page.evaluate(async (m) => (await import('/src/stores/viewStore.ts')).useViewStore.getState().setMode(m), mode);

try {
  await newCharacter(page, `Pet${Date.now().toString(36).slice(-4)}`);
  await sleep(1500);
  await dismissCards(page);
  await page.waitForFunction(() => window.__lodestoneDev?.state().dev === true, null, { timeout: 20000 });
  await run('/god');
  await run('/time 11:00');
  await run('/weather clear');
  await page.keyboard.press('F3').catch(() => {}); // the debug readout off for the pictures
  await page.waitForFunction(() => !!window.__lodestoneTowns, null, { timeout: 90000 });
  // The biggest town: two dogs.
  // The town the character starts in (not the biggest: that one may be a dwarven hall, which has no animals).
  const p0 = (await pl(page)).pos;
  const all = await towns('settlements');
  const st = [...all].sort((a, b) => Math.hypot(a.x - p0.x, a.z - p0.z) - Math.hypot(b.x - p0.x, b.z - p0.z))[0];
  const si = st.index;
  note(`largest town ${si} ${st.name} at ${st.x.toFixed(0)}, ${st.z.toFixed(0)}`);
  await run(`/tp ${Math.round(st.x + 6)} ${Math.round(st.z + 6)}`);
  await sleep(9000);
  await dismissCards(page);
  let dogs = (await towns('animalList')).filter((a) => a.kind === 'dog');
  note(`dogs: ${JSON.stringify(dogs)}`);
  check(dogs.length >= 1 && dogs.every((d) => d.name.length > 0), `the town has named dogs (${dogs.map((d) => d.name).join(', ')})`);
  const cats = (await towns('animalList')).filter((a) => a.kind === 'cat');
  note(`cats: ${cats.map((c) => c.name).join(', ')}`);

  /** Stand `d` m from the first dog, facing it. */
  const stand = async (d = 2.0, from = 0, kind = 'dog') => {
    for (let k = 0; k < 6; k++) {
      dogs = (await towns('animalList')).filter((a) => a.kind === kind);
      const dog = dogs[0];
      const ang = from + k * 0.9;
      await run(`/tp ${(dog.x + Math.cos(ang) * d).toFixed(2)} ${(dog.z + Math.sin(ang) * d).toFixed(2)}`);
      await sleep(900);
      const p = (await pl(page)).pos;
      const dd = (await towns('animalList')).find((a) => a.key === dog.key);
      await look(page, yawTo(p, dd.x, dd.z), -Math.atan2(1.2, Math.hypot(dd.x - p.x, dd.z - p.z)));
      await sleep(500);
      const pets = await towns('pettables');
      if (d > 2.6 || pets.some((x) => x.key === dog.key)) return dog;
    }
    return null;
  };

  if (want('names')) {
    let dog = await stand(2.3);
    check(!!dog, 'stood within reach of a dog');
    const tg = await towns('target');
    check(tg?.kind === 'animal' && tg.name === dog?.name, `the E target is the dog (${JSON.stringify(tg)})`);
    const promptText = await page.evaluate(() => document.querySelector('[data-testid="town-prompt"]')?.textContent ?? '');
    check(promptText === `[E] Pet ${dog?.name}`, `prompt text "${promptText}"`);
    // the nameplate, from a little further off (looking at it, not yet in reach)
    const p = (await pl(page)).pos;
    const d = (await towns('animalList')).find((a) => a.key === dog.key);
    await run(`/tp ${(d.x + (p.x - d.x) * 2.0).toFixed(2)} ${(d.z + (p.z - d.z) * 2.0).toFixed(2)}`);
    await sleep(900);
    const q = (await pl(page)).pos;
    const d2 = (await towns('animalList')).find((a) => a.key === dog.key);
    await look(page, yawTo(q, d2.x, d2.z), -Math.atan2(0.9, Math.hypot(d2.x - q.x, d2.z - q.z)));
    await sleep(900);
    const plate = await towns('plate');
    check(plate === dog?.name, `the nameplate shows the dog's name (${plate})`);
    await jpg('nameplate');
  }

  if (want('pet')) {
    const dog = await stand(2.0, 1.2);
    check(!!dog, 'in reach of a dog');
    await sleep(400);
    await setView('first');
    await look(page, yawTo((await pl(page)).pos, (await towns('animalList')).find((a) => a.key === dog.key).x, (await towns('animalList')).find((a) => a.key === dog.key).z), -0.4);
    await sleep(500);
    note(`before E: target ${JSON.stringify(await towns('target'))}, prompt "${await page.evaluate(() => document.querySelector('[data-testid="town-prompt"]')?.textContent ?? '')}", pettables ${JSON.stringify(await towns('pettables'))}`);
    await page.keyboard.press('KeyE');
    const marks = [];
    const shots = new Set();
    for (let i = 0; i < 40; i++) {
      const s = await page.evaluate(() => window.__lodestoneTowns.pet());
      marks.push({ t: +s.t.toFixed(2), crouch: +s.beat.crouch.toFixed(2), s: +s.beat.s.toFixed(2), stroke: s.beat.stroke, active: s.active });
      if (s.active && s.beat.reach > 0.9 && !shots.has('a')) { shots.add('a'); await jpg('first-person-reach'); }
      if (s.active && s.beat.stroke >= 1 && s.beat.s > 0.2 && s.beat.s < 0.85 && !shots.has('b')) { shots.add('b'); await jpg('first-person-pet'); }
      if (!s.active && i > 3) break;
      await sleep(70);
    }
    note(`first-person pet timeline ${JSON.stringify(marks)}`);
    check(marks[0].active && marks.some((m) => m.crouch > 0.95), 'E started a petting and the body crouched');
    check(shots.has('a') && shots.has('b'), 'took the reach and mid-stroke pictures');
    check(new Set(marks.map((m) => m.stroke).filter((s) => s >= 0)).size >= 2, 'the hand stroked more than once');
    await sleep(900);
    const done = await towns('pet');
    check(!done.active && done.finished >= 1, 'the petting ended by itself with a finish');
    // movement cancels it
    await look(page, yawTo((await pl(page)).pos, (await towns('animalList')).find((a) => a.key === dog.key).x, (await towns('animalList')).find((a) => a.key === dog.key).z), -0.4);
    await sleep(600);
    await pressE('second');
    await sleep(350);
    const before = (await towns('pet')).active;
    await page.keyboard.down('KeyS');
    await sleep(500);
    await page.keyboard.up('KeyS');
    await sleep(300);
    const after = (await towns('pet')).active;
    check(before && !after, `walking away cancelled it (active ${before} -> ${after})`);
    const p2 = await pl(page);
    await sleep(400);
    check(!!p2, 'back on my feet');
  }

  if (want('cat')) {
    await sleep(2000);
    const cat = await stand(1.9, 0.6, 'cat');
    check(!!cat, 'in reach of a cat (it let me walk up slowly)');
    const pc = (await pl(page)).pos;
    const cc = (await towns('animalList')).find((a) => a.key === cat.key);
    await look(page, yawTo(pc, cc.x, cc.z), -Math.atan2(1.3, Math.hypot(cc.x - pc.x, cc.z - pc.z)));
    await sleep(400);
    const ok = await pressE('cat');
    check(ok, `E on ${cat?.name} the cat started a petting`);
    for (let i = 0; i < 30; i++) {
      const s2 = await page.evaluate(() => window.__lodestoneTowns.pet());
      if (s2.active && s2.beat.stroke >= 1) {
        await jpg('cat-pet');
        break;
      }
      await sleep(80);
    }
    await sleep(2200);
  }

  if (want('third')) {
    await sleep(3000);
    const dog = await stand(2.0, 2.4);
    check(!!dog, 'in reach again (third person)');
    await setView('third');
    await page.evaluate(async () => (await import('/src/stores/viewStore.ts')).useViewStore.setState({ shoulder: -1, distance: 2.7 }));
    await sleep(800);
    const p = (await pl(page)).pos;
    const d = (await towns('animalList')).find((a) => a.key === dog.key);
    await look(page, yawTo(p, d.x, d.z), -0.3);
    await sleep(500);
    await page.keyboard.press('KeyE');
    note(`emote record: ${JSON.stringify(await page.evaluate(async () => (await import('/src/ui/emotes/store.ts')).emoteOf(-1) ?? null))}`);
    for (const ms of [200, 400, 600]) {
      await sleep(ms === 200 ? 200 : 200);
      note(`avatar ${ms}: ${JSON.stringify(await page.evaluate(() => window.__lodestoneLocalAvatar?.()))}`);
    }
    await sleep(400);
    const av = await page.evaluate(() => ({ avatar: window.__lodestoneLocalAvatar?.(), mode: window.__lodestone.player().mode, grounded: window.__lodestone.player().grounded }));
    note(`third-person body at 1.1 s: ${JSON.stringify(av)}`);
    check(av.avatar && av.avatar.armR > 0.15 && av.avatar.armR < 1.2, `your avatar's right arm is reaching down (swing ${av.avatar?.armR})`);
    await sleep(400);
    check((await towns('pet')).active, 'third person petting running');
    await jpg('third-person-pet');
    await sleep(1500);
    await setView('first');
  }

  if (want('sundial')) {
    await run('/time 10:00');
    await sleep(1200);
    let sd = await towns('sundial');
    note(`sundial ${JSON.stringify(sd)}`);
    if (!sd.nearest) {
      await run(`/tp ${Math.round(st.x)} ${Math.round(st.z)}`);
      await sleep(3000);
      sd = await towns('sundial');
    }
    check(!!sd.nearest, 'a sundial stands in the town square');
    const n = sd.nearest;
    // look at the plate from the south-east, 2.6 m away, from above
    await run(`/tp ${(n.x + 1.6).toFixed(2)} ${(n.z + 2.0).toFixed(2)}`);
    await sleep(1500);
    const p = (await pl(page)).pos;
    await look(page, yawTo(p, n.x, n.z), -0.62);
    await sleep(700);
    sd = await towns('sundial');
    check(sd.lit && sd.opacity > 0.3, `the gnomon casts a shadow by day (lit ${sd.lit}, phi ${sd.phi?.toFixed(2)}, len ${sd.len?.toFixed(2)})`);
    await jpg('sundial-10am');
    const phi10 = sd.phi;
    await run('/time 15:00');
    await sleep(1500);
    sd = await towns('sundial');
    check(sd.lit && Math.abs(sd.phi - phi10) > 0.5, `the shadow moved by 15:00 (phi ${phi10.toFixed(2)} -> ${sd.phi.toFixed(2)})`);
    await jpg('sundial-3pm');
    const dial = await page.evaluate(() => document.querySelector('[data-testid="sundial-clock"]')?.getAttribute('data-hour'));
    check(Math.abs(+dial - 15) < 0.5, `the HUD dial reads the time (hour ${dial})`);
    await run('/time 23:00');
    await sleep(1500);
    sd = await towns('sundial');
    check(!sd.lit, 'no shadow at night');
    await jpg('sundial-night');
    // the HUD dial, a crop
    await run('/time 9:30');
    await sleep(1000);
    await look(page, 0, 0.1);
    await page.screenshot({ path: `${out}/pt5-town-life-hud-dial.jpg`, type: 'jpeg', quality: 80, clip: { x: W / 2 - 330, y: 0, width: 660, height: 80 } });
  }

  if (want('weather')) {
    await run('/time 14:00');
    await run('/weather rain');
    await run(`/tp ${Math.round(st.x + 3)} ${Math.round(st.z + 3)}`);
    await sleep(6000);
    await look(page, 0.6, 0.05);
    const eOut = await towns('exposure');
    check(eOut > 0.95, `outside in the rain: exposure ${eOut}`);
    await jpg('rain-outside');
    // into the inn (or any enclosed building): by the door
    const bs = await towns('buildings', si);
    const inn = bs.find((b) => b.role === 'inn') ?? bs.find((b) => b.floors > 0 && b.role !== 'stall');
    note(`building ${inn.role} #${inn.index} at ${inn.x.toFixed(1)}, ${inn.z.toFixed(1)} floorY ${inn.floorY}`);
    await page.evaluate(() => {
      window.__expo = [];
      const f = () => {
        window.__expo.push([performance.now(), window.__lodestoneTowns.exposure()]);
        if (window.__expo.length < 400) requestAnimationFrame(f);
      };
      f();
    });
    await sleep(300);
    await run(`/tp ${inn.x.toFixed(2)} ${inn.z.toFixed(2)}`);
    await sleep(2500);
    const expo = await page.evaluate(() => window.__expo);
    const i0 = expo.findIndex((e) => e[1] < 0.98);
    const i1 = expo.findIndex((e) => e[1] < 0.02);
    const fadeMs = expo[i1][0] - expo[i0 - 1][0];
    let maxStep = 0;
    for (let i = Math.max(1, i0 - 1); i <= i1; i++) maxStep = Math.max(maxStep, Math.abs(expo[i][1] - expo[i - 1][1]));
    note(`exposure fade: ${(i1 - i0 + 1)} frames over ${fadeMs.toFixed(0)} ms, biggest step ${maxStep.toFixed(2)}`);
    const pin = (await pl(page)).pos;
    const eIn = await towns('exposure');
    note(`inside at y ${pin.y.toFixed(2)} (floor ${inn.floorY}); exposure ${eIn}`);
    check(eIn < 0.02, `inside: exposure ${eIn}`);
    check(fadeMs > 350 && fadeMs < 900 && maxStep < 0.2, `the rain faded out over ${fadeMs.toFixed(0)} ms, biggest frame step ${maxStep.toFixed(2)}`);
    await look(page, inn.s !== undefined ? 1.2 : 0, 0.0);
    await jpg('rain-inside');
  }
  writeFileSync(`${out}/pt5-town-life.txt`, results.join('\n') + '\n');
} catch (e) {
  issue('script', String(e?.stack ?? e));
} finally {
  save();
  await t.browser.close();
}
