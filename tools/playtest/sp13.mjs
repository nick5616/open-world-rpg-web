// Playtest pass 13 (playtest 2 integration QA): every HUD panel and overlay
// the playtest 2 features added, up at the same time, checked for overlaps
// at 1920x1080, 1600x900 and 1280x720 with lib.mjs's hudBoxes/overlaps.
//
// The "busy" HUD is what a player can have on screen at once out in the
// world: the clock pill with the weather, a forecast line and Chilled; a
// world event tracker; a pet out (its card); a sealed vault close by (the
// puzzle panel); content notes; Rested by a campfire; a tip; the quest
// tracker, compass, hotbar, chat and voice. Each scene adds one thing on top
// (camp menu, steed panel, pet panel, instrument overlay, fishing tension
// bar, emote wheel, pet wheel, the taming meter, the Esc menu, What's new).
// States the zone would send are written straight into the client stores
// (Vite serves the same module instance to a dynamic import), so the check
// does not depend on finding a vault or a fish; panels open through their
// debug handles or keys like a player would.
//
//   node tools/playtest/stack.mjs --zone-env LODESTONE_ZONE_DEV_SPAWN=1
//   LODESTONE_CLIENT_URL=<its url> node tools/playtest/sp13.mjs <outDir> [1920x1080 1600x900 1280x720]
import { writeFileSync } from 'node:fs';
import { launch, newCharacter, hudBoxes, overlaps, sleep, dismissCards } from './lib.mjs';

const out = process.argv[2] ?? 'tmp/playtest13';
const sizes = (process.argv.slice(3).length ? process.argv.slice(3) : ['1920x1080', '1600x900', '1280x720']).map((s) => s.split('x').map(Number));
const t = await launch(out, { width: sizes[0][0], height: sizes[0][1] });
const { page, shot, note, issue } = t;
const result = {};

/** Write the busy HUD into the stores (idempotent: re-applied before every scene). */
async function busy(on) {
  await page.evaluate(async (on) => {
    const me = window.__lodestone.player().pos;
    const now = performance.now();
    const W = await import('/src/systems/weather/runtime.ts');
    const C = await import('/src/ui/content/store.ts');
    const P = await import('/src/ui/pets/store.ts');
    const K = await import('/src/ui/camps/store.ts');
    const T = await import('/src/ui/tips/store.ts');
    if (!on) {
      C.useContent.setState({ events: {}, vaults: {}, notes: [] });
      P.usePets.setState({ mine: null });
      K.useCamps.setState({ rested: null });
      T.useTips.setState({ current: null });
      return;
    }
    W.useWeatherHud.setState({ active: true, state: 6, line: 'Clearing in 3 min', chilled: true });
    C.useContent.setState({
      events: { 900001: { id: 900001, kind: 'caravan', name: 'Caravan Ambush', text: 'Bandits fall on a merchant caravan. Drive them off before the wagon breaks.', phase: 1, endsAt: now + 180000, progress: 40, x: me.x + 120, y: me.y, z: me.z, r: 40, wave: 1, waves: 3, hp: 72, at: now } },
      vaults: { 900002: { site: 900002, name: 'The Sunken Reliquary', phase: 0, opened: false, puzzle: 'levers', title: 'The Three Levers', hint: 'First the sun wakes, then the stars, and the moon goes to sleep last.', parts: [0, 1, 2].map((g) => ({ id: g + 1, kind: 'lever', label: 'lever', x: me.x + 5, y: me.y, z: me.z, on: g === 0, glyph: g })), keeper: -1, x: me.x + 10, z: me.z, r: 20 } },
      notes: [
        { id: 900003, kind: 'feat', title: 'Feat: First Blood', text: 'Defeat your first creature · +10 gold', at: now },
        { id: 900004, kind: 'codex', title: 'Bestiary: Dewdrop Slime', text: 'A new entry in your journal (J)', at: now },
      ],
    });
    P.usePets.setState({ mine: { pets: [{ id: 7, sp: 'wolf', name: 'Fang', variant: 0, el: 0, lv: 5, xp: 30, next: 100, hp: 80, hpMax: 100, dmg: 9, koMs: 0, active: true, out: 1, kills: 4, tamedAt: 0 }], active: 7, mode: 0, stable: false, max: 6, at: now } });
    K.useCamps.setState({ rested: { until: now + 600000, info: { staminaBonus: 25, regenMult: 2, manaRegenMult: 1.5, fire: true } } });
    T.useTips.setState({ current: { id: 'quest', at: now } });
  }, on);
}

async function check(label) {
  await sleep(700);
  const boxes = await hudBoxes(page);
  const o = overlaps(boxes);
  const f = await shot(label);
  return { boxes: boxes.map((b) => `${b.id || b.text}@${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}x${Math.round(b.h)}`), overlaps: o, shot: f };
}

const visible = (id) => page.evaluate((id) => !!document.querySelector(`[data-testid="${id}"]`)?.getClientRects().length, id);

const scenes = [
  ['busy', async () => {}, async () => {}],
  ['camp-menu', () => page.evaluate(() => window.__lodestoneCamps.menu(true)), () => page.evaluate(() => window.__lodestoneCamps.menu(false))],
  ['steed-panel', () => page.evaluate(() => window.__lodestoneMounts.panel(true)), () => page.evaluate(() => window.__lodestoneMounts.panel(false))],
  ['pet-panel', () => page.evaluate(() => window.__lodestonePets.panel(true)), () => page.evaluate(() => window.__lodestonePets.panel(false))],
  [
    'instrument',
    async () => {
      await page.evaluate(() => window.__lodestoneMusic.enter());
      await sleep(400);
    },
    () => page.evaluate(() => window.__lodestoneMusic.exit()),
  ],
  [
    'fishing-fight',
    () => page.evaluate(async () => {
      const F = await import('/src/ui/fishing/store.ts');
      F.useFishing.setState({ phase: 'fight', rarity: 2 });
    }),
    () => page.evaluate(async () => {
      const F = await import('/src/ui/fishing/store.ts');
      F.useFishing.setState({ phase: 'idle' });
    }),
  ],
  [
    'fishing-caught',
    () => page.evaluate(async () => {
      const F = await import('/src/ui/fishing/store.ts');
      F.useFishing.setState({ phase: 'result', resultAt: performance.now() + 60000, caught: { key: 'silverfin_minnow', name: 'Silverfin Minnow', item: 'fish:silverfin_minnow', weightG: 140, rarity: 0, water: 'river', first: true, record: true, count: 1, best: 140, id: 1 } });
    }),
    () => page.evaluate(async () => {
      const F = await import('/src/ui/fishing/store.ts');
      F.useFishing.setState({ phase: 'idle', caught: null });
    }),
  ],
  ['emote-wheel', () => page.keyboard.down('KeyH'), () => page.keyboard.up('KeyH')],
  [
    'pet-wheel',
    async () => {
      await page.keyboard.down('Digit6');
      await sleep(500);
    },
    async () => {
      await page.keyboard.press('Escape');
      await page.keyboard.up('Digit6');
    },
  ],
  [
    'tame-meter',
    () => page.evaluate(async () => {
      const P = await import('/src/ui/pets/store.ts');
      P.usePets.setState({ meter: { creature: 1, sp: 'wolf', start: performance.now(), ms: 600000, food: 'meat:raw', fav: true } });
    }),
    () => page.evaluate(async () => {
      const P = await import('/src/ui/pets/store.ts');
      P.usePets.setState({ meter: null });
    }),
  ],
  ['esc-menu', () => page.keyboard.press('Escape'), () => page.keyboard.press('Escape')],
];

try {
  await newCharacter(page, 'Hud' + (Date.now() % 100000));
  await sleep(8000);
  await dismissCards(page);
  await page.evaluate(() => window.__lodestoneMusic?.dev());
  await sleep(1500);
  for (const [w, h] of sizes) {
    const key = `${w}x${h}`;
    await page.setViewportSize({ width: w, height: h });
    await sleep(800);
    result[key] = {};
    for (const [name, up, down] of scenes) {
      await busy(true);
      await up();
      const r = await check(`${key}-${name}`);
      result[key][name] = r;
      if (r.overlaps.length) issue('hud-overlap', `${key} ${name}: ${r.overlaps.join('; ')}`);
      else note(`${key} ${name}: no overlaps (${r.boxes.length} boxes)`);
      await down();
      await sleep(300);
    }
    // nothing left open by a scene
    await busy(false);
    for (const id of ['camp-menu', 'steed-panel', 'pet-panel', 'music-overlay', 'emote-wheel', 'pet-wheel', 'esc-menu']) if (await visible(id)) issue('panel-stuck', `${key}: ${id} still open after its scene`);
  }
} catch (e) {
  issue('script', String(e?.stack ?? e).slice(0, 800));
  await shot('error').catch(() => {});
} finally {
  writeFileSync(`${out}/hud.json`, JSON.stringify(result, null, 1));
  t.save();
  await t.browser.close();
}
