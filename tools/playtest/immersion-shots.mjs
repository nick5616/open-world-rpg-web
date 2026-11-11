// Playtest 2 immersion audit: a structured screenshot set from the real
// client on a private dev stack, composed into compact contact sheets
// (docs/evidence/pt2-immersion-<sheet>-<tag>.jpg). One browser, one new
// character; travel, time, weather, enemies, gear, pets and the story go
// through the dev console. Each sheet is a list of tiles; a failing tile is
// logged and left grey, never fatal.
//
//   node tools/playtest/stack.mjs --zone-env LODESTONE_ZONE_DEV=1 --zone-env LODESTONE_ZONE_NO_WORLD_EVENTS=1
//   LODESTONE_CLIENT_URL=<its url> node tools/playtest/immersion-shots.mjs [--tag before] [--only biomes-day,towns] [--quality high]
//
// Sheets: biomes-{day,dusk,night,rain,snow}, low, towns, caves-towers,
// heartfall, enemies, avatars, firstperson, spells, camp-fishing, hud, life.
import { mkdirSync, writeFileSync } from 'node:fs';
import { launch, newCharacter, sleep, dismissCards } from './lib.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const TAG = arg('--tag', 'before');
const ONLY = arg('--only', '')
  .split(',')
  .filter(Boolean);
const OUT = arg('--out', 'docs/evidence');
const TMP = `tmp/immersion-${TAG}`;
mkdirSync(TMP, { recursive: true });
const want = (s) => !ONLY.length || ONLY.includes(s);

const T = await launch(`${TMP}/raw`, { width: 1280, height: 720 });
const { page, note, issue } = T;
const run = (line) => page.evaluate((l) => window.__lodestoneDev.run(l), line);
const L = (fn, a) => page.evaluate(fn, a);
const report = { tag: TAG, sheets: {} };

/** World only: hide every DOM element that does not hold the canvas. */
const clean = (on) =>
  L((v) => {
    let s = document.getElementById('ls-clean');
    if (!s) {
      s = document.createElement('style');
      s.id = 'ls-clean';
      s.textContent = 'body.ls-clean *:not(canvas):not(:has(canvas)) { visibility: hidden !important; }';
      document.head.appendChild(s);
    }
    document.body.classList.toggle('ls-clean', v);
  }, on);
const view = (mode, dist = 3.4) => L(([m, d]) => window.__lodestone.setView(m, 1, d), [mode, dist]);
const look = (yaw, pitch = 0) => L(([y, p]) => window.__lodestone.setLook(y, p), [yaw, pitch]);
const me = () => L(() => window.__lodestone.player().pos);
const yawTo = (p, x, z) => Math.atan2(-(x - p.x), -(z - p.z));
async function lookAt(x, y, z) {
  const p = await me();
  await look(yawTo(p, x, z), Math.atan2(y - (p.y + 1.7), Math.hypot(x - p.x, z - p.z)));
}
async function settle(ms = 1500) {
  for (let i = 0; i < 60; i++) {
    const st = await L(() => window.__lodestoneWorld?.stats?.());
    if (!st?.terrain || (st.terrain.queued + st.terrain.inFlight === 0 && st.terrain.missingWanted === 0)) break;
    await sleep(250);
  }
  await sleep(ms);
}
const tp = async (x, z, ms = 1500) => {
  await run(`/tp ${Math.round(x)} ${Math.round(z)}`);
  await sleep(600);
  await settle(ms);
};
const time = (h) => run(`/time ${h}`);
const weather = async (w, ms = 7000) => {
  await run(`/weather ${w}`);
  await sleep(ms);
};
async function closePanels() {
  await L(() => {
    for (let i = 0; i < 6 && window.__lodestonePanels?.top(); i++) window.__lodestonePanels.closeTop();
  });
  await dismissCards(page);
  for (let i = 0; i < 3 && (await page.getByTestId('tip-close').isVisible().catch(() => false)); i++) await page.getByTestId('tip-close').click({ force: true }).catch(() => {});
}
// ── sheets ────────────────────────────────────────────────────────────────
let tiles = [];
const tile = async (label, { hud = false } = {}) => {
  try {
    if (hud) await dismissCards(page); // the welcome card is the capture's artefact, not the scene's
    await clean(!hud);
    await sleep(250);
    const buf = await page.screenshot({ type: 'jpeg', quality: 82 });
    tiles.push({ label, buf });
    note(`  tile ${label}`);
  } catch (e) {
    issue('tile', `${label}: ${e.message}`);
    tiles.push({ label: `${label} (failed)`, buf: null });
  } finally {
    await clean(false).catch(() => {});
  }
};
async function sheet(name, cols = 3) {
  const ctx = await T.browser.newContext();
  const p = await ctx.newPage();
  const W = 640;
  const H = 360;
  const rows = Math.ceil(tiles.length / cols);
  await p.setViewportSize({ width: W * cols, height: H * rows + 28 });
  const src = (b) => (b ? `data:image/jpeg;base64,${b.toString('base64')}` : '');
  await p.setContent(
    `<body style="margin:0;background:#16141a;font:600 14px system-ui;color:#fff"><div style="height:28px;line-height:28px;padding-left:10px;color:#d9c9a0">Lodestone immersion audit · ${name} · ${TAG}</div><div style="display:grid;grid-template-columns:repeat(${cols},${W}px)">${tiles
      .map((t) => `<div style="position:relative;width:${W}px;height:${H}px;background:#333">${t.buf ? `<img src="${src(t.buf)}" width="${W}" height="${H}">` : ''}<div style="position:absolute;left:8px;top:6px;text-shadow:0 1px 3px #000,0 0 2px #000">${t.label}</div></div>`)
      .join('')}</div></body>`,
  );
  await sleep(200);
  const f = `${OUT}/pt2-immersion-${name}-${TAG}.jpg`;
  await p.screenshot({ path: f, type: 'jpeg', quality: 70, fullPage: true });
  await ctx.close();
  report.sheets[name] = tiles.map((t) => t.label);
  note(`sheet ${f} (${tiles.length})`);
  tiles = [];
}

const BIOMES = ['meadow', 'forest', 'highlands', 'snowpeak', 'badlands', 'wetland'];
let spots = null;
async function biomeSpots() {
  if (spots) return spots;
  spots = await L((n) => n.map((_, i) => window.__lodestoneWorld.biomeSpot(i)), BIOMES);
  note(`biome spots ${JSON.stringify(spots)}`);
  return spots;
}
/** Turn toward the nearest enemies (spawned packs). */
async function lookAtPack(nearest = false) {
  const e = await L(async (n) => {
    const ns = await import('/src/net/netStore.ts');
    const p = window.__lodestone.player().pos;
    const es = ns.drawnRemotes.views.filter((v) => v.kind === 2).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
    if (!es.length) return null;
    const take = n ? es.slice(0, 1) : es.slice(0, 6);
    const c = take.reduce((s, v) => ({ x: s.x + v.x / take.length, y: s.y + v.y / take.length, z: s.z + v.z / take.length }), { x: 0, y: 0, z: 0 });
    return c;
  }, nearest).catch(() => null);
  if (e) await lookAt(e.x, e.y + 1.2, e.z);
  else await look(0, -0.12);
}

/** A look over the biome: third person, the avatar small in the frame. */
async function biomeShot(i, label) {
  const s = (await biomeSpots())[i];
  if (!s) return tile(`${BIOMES[i]}: no spot`);
  await tp(s.x, s.z, 1800);
  await view('third', 4.2);
  await look(0.6 + i * 1.05, -0.08);
  await sleep(900);
  await tile(`${BIOMES[i]} ${label}`);
}

async function placesInfo() {
  return L(() => {
    const W = window.__lodestoneWorld;
    const T = window.__lodestoneTowns;
    const p = window.__lodestone.player().pos;
    const towns = T.settlements()
      .filter((s) => s.buildings >= 8)
      .sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
    const sites = W.sites();
    const tower = sites.filter((s) => s.kind === 'tower' || s.category === 'tower').sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0] ?? null;
    const vault = sites.filter((s) => /vault/.test(s.kind)).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0] ?? null;
    const kinds = [...new Set(sites.map((s) => `${s.category}/${s.kind}`))];
    return { town: towns[0] ?? null, town2: towns[1] ?? null, tower, vault, kinds };
  });
}

try {
  const name = `Look${Date.now().toString(36).slice(-4)}`;
  await newCharacter(page, name);
  await sleep(2500);
  await dismissCards(page);
  await page.waitForFunction(() => window.__lodestoneDev?.state().dev === true, null, { timeout: 30000 });
  await page.keyboard.press('F3').catch(() => {});
  await L((q) => window.__lodestone.setQuality(q), arg('--quality', 'high'));
  await L(() => window.__lodestone.setStyle('lodestone'));
  await L(() => window.__lodestoneIntro?.volume?.(0));
  for (const l of ['/god', '/level 20', '/freeze on', '/mana', '/nocd']) await run(l);
  const P = await placesInfo();
  note(`places ${JSON.stringify(P)}`);
  report.places = P;

  // ── biomes by time and weather ──
  const cond = [
    ['biomes-day', 11, 'clear', 'day'],
    ['biomes-dusk', 19.1, 'clear', 'dusk'],
    ['biomes-night', 23, 'clear', 'night'],
    ['biomes-rain', 14, 'rain', 'rain'],
    ['biomes-snow', 13, 'snow', 'snow'],
  ];
  for (const [sheetName, h, w, label] of cond) {
    if (!want(sheetName)) continue;
    note(sheetName);
    await time(h);
    await weather(w, 2000);
    for (let i = 0; i < BIOMES.length; i++) {
      if (i === 0 && w !== 'clear') await sleep(6000);
      await biomeShot(i, label);
    }
    await sheet(sheetName);
  }
  await weather('clear', 1000);

  // ── towns ──
  if (want('towns') && P.town) {
    note('towns');
    const t = P.town;
    await time(10.5);
    await tp(t.x + 24, t.z + 16, 2500);
    await view('first');
    await lookAt(t.x, t.y + 4, t.z);
    await tile('town approach 10:30 (1st person)');
    const c = t.square && t.square.x !== undefined ? t.square : { x: t.x, z: t.z };
    await tp(c.x + 3, c.z + 2, 3500);
    await view('third', 3.6);
    await look(2.2, -0.1);
    await tile('square midday, townsfolk', { hud: true });
    await look(5.1, -0.05);
    await tile('square other side');
    const npcs = await L(() => window.__lodestoneTowns.visibleNpcs?.() ?? []);
    const n0 = npcs.find((n) => n.entityId !== null) ?? npcs[0];
    if (n0) {
      await tp(n0.x + 2.4, n0.z + 1.2, 1500);
      await view('first');
      await lookAt(n0.x, n0.y + 1.4, n0.z);
      await sleep(600);
      await tile(`npc close: ${n0.name ?? n0.role ?? '?'}`, { hud: true });
    }
    await time(20.5);
    await tp(c.x + 3, c.z + 2, 2500);
    await view('third', 3.6);
    await look(2.2, -0.1);
    await sleep(1200);
    await tile('square 20:30 (evening routine)', { hud: true });
    await time(23);
    await sleep(1200);
    await tile('square 23:00 lanterns');
    // fire close: the first campfire / brazier / torch on the ground
    const fire = await L((ti) => {
      const T = window.__lodestoneTowns;
      const W = window.__lodestoneWorld;
      for (const kind of [22, 30, 17, 27]) {
        const ps = T.props(ti, kind).filter((p) => Math.abs(p.y - (W.groundAt(p.x, p.z) ?? p.y)) < 1.5);
        if (ps.length) return ps[0];
      }
      return null;
    }, t.index);
    if (fire) {
      await tp(fire.x + 3, fire.z + 2.5, 1500);
      await view('first');
      await lookAt(fire.x, fire.y + 0.6, fire.z);
      await tile('town fire close, night');
    }
    // an interior: a door's inside (first building with a hearth)
    const inside = await L((ti) => {
      const T = window.__lodestoneTowns;
      const b = T.buildings?.(ti) ?? [];
      const h = b.find((x) => x.role === 'inn' || x.role === 'tavern') ?? b.find((x) => x.hx > 3) ?? b[0];
      return h ? { x: h.x, z: h.z, y: h.floorY } : null;
    }, t.index).catch(() => null);
    if (inside) {
      await time(12);
      await tp(inside.x, inside.z, 1500);
      await view('first');
      await look(0.3, -0.15);
      await tile('interior (midday)');
      await look(3.4, -0.15);
      await tile('interior other wall');
    }
    await time(15);
    await tp(c.x - 30, c.z + 30, 2500);
    await view('first');
    await lookAt(c.x, (t.y ?? 0) + 6, c.z);
    await tile('town skyline 15:00 (chimneys)');
    await sheet('towns');
  }

  // ── caves, towers, the crystal, a vault ──
  if (want('caves-towers')) {
    note('caves-towers');
    await time(11);
    const cave = await L(() => {
      const C = window.__lodestoneCaves;
      if (!C) return null;
      const sys = C.systems();
      let best = null;
      for (let si = 0; si < Math.min(sys.length, 12); si++) for (const c of C.chambers(si)) if (!best || c.gems > best.c.gems) best = { si, c };
      if (!best) return null;
      const v = C.veins(best.si).filter((x) => x.chamber === best.c.k);
      return { c: best.c, v: v.find((x) => x.kind === 'gem') ?? v[0] ?? null, mouth: sys[best.si]?.entrances?.[0] ?? null };
    });
    if (cave) {
      const { c, v } = cave;
      await L(([x, y, z]) => window.__lodestone.teleport({ x, y, z }), [c.x + 2, c.y + 0.5, c.z + 2]);
      await sleep(2500);
      await view('first');
      if (v) await lookAt(v.x, v.y, v.z);
      await sleep(800);
      await tile('cave chamber, gem vein');
      await view('third', 3.2);
      await look(1.2, -0.1);
      await tile('cave third person');
    }
    if (P.tower) {
      await tp(P.tower.x + 26, P.tower.z + 18, 2500);
      await view('first');
      await lookAt(P.tower.x, P.tower.y + 12, P.tower.z);
      await tile('tower from 30 m');
      await tp(P.tower.x + 11, P.tower.z + 8, 2000);
      await lookAt(P.tower.x, P.tower.y + 3, P.tower.z);
      await tile('tower base / crystal');
      await time(22.5);
      await sleep(1500);
      await tile('tower at night');
      await time(11);
    }
    if (P.vault) {
      await run(`/tp ${P.vault.name}`);
      await sleep(3000);
      await settle(1500);
      await view('first');
      await look(0.4, -0.05);
      await tile(`vault: ${P.vault.name}`);
      await view('third', 3);
      await look(2.6, -0.1);
      await tile('vault third person');
    }
    await sheet('caves-towers');
  }

  // ── enemies in the world (packs and close) ──
  if (want('enemies')) {
    note('enemies');
    const s = (await biomeSpots())[0];
    await tp(s.x + 30, s.z + 30, 2000);
    await time(15);
    await view('third', 4.5);
    const packs = [
      ['wolf', 5],
      ['boar', 3],
      ['slime', 6],
      ['cutthroat', 3],
      ['sentinel', 1],
      ['shade', 3],
    ];
    for (const [k, n] of packs) {
      const r = await run(`/spawn ${k} ${n}`);
      if (!r || r.ok === false) note(`spawn ${k}: ${JSON.stringify(r)?.slice(0, 120)}`);
      await sleep(2600);
      await lookAtPack();
      await tile(`pack: ${k} x${n}`, { hud: true });
      await run('/despawn');
      await sleep(600);
    }
    await time(23);
    await run('/spawn gloamling 3');
    await sleep(2600);
    await lookAtPack();
    await tile('demons at night', { hud: true });
    await view('first');
    await lookAtPack(true);
    await sleep(500);
    await tile('a demon close (1st person)');
    await view('third', 4.5);
    await run('/despawn');
    await sheet('enemies');
  }

  // ── the Heartfall and the Hush ──
  if (want('heartfall')) {
    note('heartfall');
    await run('/story act 6 2');
    await time(22);
    await sleep(800);
    await run('/story heartfall');
    const intro = await page.waitForFunction(() => window.__lodestoneStory?.state().cinematic, null, { timeout: 30000 }).catch(() => null);
    await view('first');
    if (intro) {
      await sleep(1500);
      await tile('the Hush: entrance (HUD)', { hud: true });
      await sleep(2500);
      await tile('the Hush: entrance later', { hud: true });
    }
    await sleep(5000);
    const f = await L(() => window.__lodestoneStory.state().finale);
    if (f) {
      await tp(f.x + 16, f.z + 6, 1500);
      await view('third', 4);
      await lookAt(f.x, (await me()).y + 4, f.z);
      await sleep(1500);
      await tile('the Hush from 16 m');
      await tp(f.x + 8, f.z + 2, 600);
      await lookAt(f.x, (await me()).y + 3, f.z);
      await sleep(1500);
      await tile('the Hush close (shroud?)', { hud: true });
      await run('/story hush 69');
      await sleep(4000);
      await view('third', 5);
      await look(1.8, -0.05);
      await tile('the choir: Hollow Bells', { hud: true });
      const bell = await L(async () => {
        const ns = await import('/src/net/netStore.ts');
        const v = ns.drawnRemotes.views.find((x) => x.kind === 3 && x.typeId === 112);
        return v ? { x: v.x, y: v.y, z: v.z } : null;
      }).catch(() => null);
      if (bell) {
        await tp(bell.x + 3.5, bell.z + 2, 600);
        await view('first');
        await lookAt(bell.x, bell.y + 1.6, bell.z);
        await sleep(1000);
        await tile('a Hollow Bell close');
      }
      await run('/story bells');
      await sleep(1500);
      await run('/story hush 34');
      await sleep(4000);
      await view('third', 5);
      await lookAt(f.x, (await me()).y + 3, f.z);
      await tile('phase 3: the endless night', { hud: true });
      await run('/story win');
      await sleep(5000);
      await tile('ending', { hud: true });
      await sleep(9000);
      await tile('ending later / credits', { hud: true });
    }
    await closePanels();
    await sheet('heartfall');
  }

  // ── avatars ──
  if (want('avatars')) {
    note('avatars');
    const s = (await biomeSpots())[0];
    await tp(s.x - 20, s.z + 10, 1500);
    await time(16);
    const front = async (label, dist = 3.2, h = 1.2) => {
      const p = await me();
      const yaw = await L(() => window.__lodestone.player().yaw);
      await L(() => window.__lodestonePhoto.enter());
      await sleep(400);
      await L(() => window.__lodestonePhoto.set({ panelHidden: true, hidePlates: false }));
      // in front of the avatar (forward = (-sin, -cos)), looking back at it
      const fx = p.x - Math.sin(yaw) * dist + Math.cos(yaw) * 0.8;
      const fz = p.z - Math.cos(yaw) * dist - Math.sin(yaw) * 0.8;
      await L(([x, y, z, yw, pt]) => window.__lodestonePhoto.pose(x, y, z, yw, pt), [fx, p.y + h + 0.3, fz, Math.atan2(-(p.x - fx), -(p.z - fz)), -0.12]);
      await sleep(700);
      await tile(label);
      await L(() => window.__lodestonePhoto.exit());
      await sleep(300);
    };
    await look(0, 0);
    await view('third', 3.2);
    await sleep(500);
    await front('bare avatar, front');
    for (const l of ['/equip iron_helm', '/equip iron_cuirass', '/equip iron_greaves', '/equip iron_sword']) await run(l);
    await sleep(1200);
    await front('armored, front');
    await view('third', 3.2);
    await tile('armored, back (3rd person)');
    await L(() => window.__lodestoneEmotes?.play('wave'));
    await sleep(600);
    await front('emote: wave');
    await L(() => window.__lodestoneEmotes?.play('dance'));
    await sleep(900);
    await front('emote: dance');
    await run('/pet wolf');
    await sleep(2500);
    await view('third', 4);
    await look(0.8, -0.15);
    await tile('pet wolf beside (3rd)');
    await L(() => window.__lodestoneMusic?.dev?.());
    await sleep(800);
    await L(() => window.__lodestoneMusic?.enter?.(1));
    await sleep(800);
    await front('playing the lute');
    await L(() => window.__lodestoneMusic?.exit?.());
    await run('/steed');
    await sleep(800);
    await page.keyboard.press('Digit5');
    await sleep(5000);
    await L(() => window.__lodestoneMounts?.actions?.()?.mount?.());
    await sleep(1500);
    await front('riding the steed', 4.5, 1.6);
    await view('third', 5);
    await page.keyboard.down('KeyW');
    await sleep(2500);
    await tile('galloping (3rd)');
    await page.keyboard.up('KeyW');
    await L(() => window.__lodestoneMounts?.actions?.()?.dismount?.());
    await sheet('avatars');
  }

  // ── first person per weapon, casting ──
  if (want('firstperson')) {
    note('firstperson');
    const s = (await biomeSpots())[1];
    await tp(s.x, s.z, 1500);
    await time(10);
    await view('first');
    await look(1, -0.05);
    for (const w of ['iron_sword', 'oak_bow', 'oak_staff', 'iron_spear', 'birch_wand']) {
      const r = await run(`/equip ${w}`);
      if (!r || r.ok === false) note(`equip ${w}: ${JSON.stringify(r)?.slice(0, 160)}`);
      await sleep(1500);
      await tile(`1st person: ${w}`, { hud: true });
    }
    await page.mouse.click(640, 360);
    await page.keyboard.down('Digit1');
    await sleep(350);
    await tile('casting (slot 1)', { hud: true });
    await page.keyboard.up('Digit1');
    await sheet('firstperson');
  }

  // ── spells, dash ──
  if (want('spells')) {
    note('spells');
    const s = (await biomeSpots())[0];
    await tp(s.x + 10, s.z - 20, 1500);
    await time(17);
    await run('/learn all');
    await view('third', 4);
    await look(2.4, -0.1);
    await run('/spawn slime 3');
    await sleep(1500);
    for (const [k, label] of [
      ['Digit1', 'slot 1'],
      ['Digit2', 'slot 2'],
      ['Digit3', 'slot 3 (dash)'],
    ]) {
      await page.keyboard.down(k);
      await sleep(260);
      await tile(`spell ${label}`, { hud: true });
      await page.keyboard.up(k);
      await sleep(1200);
    }
    await page.keyboard.press('KeyF');
    await sleep(120);
    await tile('dodge dash');
    await run('/despawn');
    await sheet('spells');
  }

  // ── camp at night, fishing ──
  if (want('camp-fishing')) {
    note('camp-fishing');
    const s = (await biomeSpots())[0];
    await tp(s.x + 50, s.z - 10, 1500);
    await time(21.5);
    await L(() => window.__lodestoneCamps?.dev?.());
    await sleep(800);
    const K = await L(() => window.__lodestoneCamps?.kinds?.() ?? null);
    const p = await me();
    if (K) {
      await L(([k, x, z]) => window.__lodestoneCamps.place(k, 0, x, z), [K.campfire, p.x + 3, p.z - 3]);
      if (K.tent !== undefined) await L(([k, x, z]) => window.__lodestoneCamps.place(k, 0, x, z), [K.tent, p.x + 6, p.z - 6]);
      await sleep(2000);
      await view('third', 4);
      await lookAt(p.x + 3, p.y, p.z - 3);
      await tile('camp at night');
      await view('first');
      await lookAt(p.x + 3, p.y + 0.3, p.z - 3);
      await tile('campfire close');
    }
    const spot = await L(([x, z]) => window.__lodestoneFishing?.findSpot?.(x, z, 400) ?? null, [p.x, p.z]);
    if (spot) {
      await time(9);
      await tp(spot.x, spot.z, 2000);
      await L(() => window.__lodestoneFishing.devRod?.());
      await view('third', 3.5);
      if (spot.wx !== undefined) await lookAt(spot.wx, (await me()).y, spot.wz);
      await tile('fishing spot (water, shore)');
      await page.keyboard.press('KeyE');
      await sleep(2500);
      await tile('fishing: line out', { hud: true });
    }
    await sheet('camp-fishing');
  }

  // ── HUD, calm and in combat; menus ──
  if (want('hud')) {
    note('hud');
    const s = (await biomeSpots())[0];
    await tp(s.x, s.z, 1500);
    await time(11);
    await closePanels();
    await view('first');
    await tile('HUD calm', { hud: true });
    await run('/spawn wolf 3');
    await sleep(3000);
    await page.mouse.click(640, 360);
    await page.mouse.click(640, 360);
    await sleep(200);
    await tile('HUD combat', { hud: true });
    await run('/despawn');
    for (const [k, label] of [
      ['KeyI', 'inventory'],
      ['KeyM', 'map'],
      ['KeyJ', 'journal'],
      ['KeyN', 'skills'],
      ['KeyC', 'character'],
    ]) {
      await page.keyboard.press(k);
      await sleep(900);
      await tile(`panel: ${label}`, { hud: true });
      await closePanels();
      await sleep(300);
    }
    await sheet('hud');
  }

  // ── Low quality ──
  if (want('low')) {
    note('low');
    await L(() => window.__lodestone.setQuality('low'));
    await sleep(2500);
    const sp = await biomeSpots();
    await time(11);
    await biomeShot(0, 'day, Low');
    await biomeShot(1, 'day, Low');
    await time(23);
    await biomeShot(1, 'night, Low');
    if (P.town) {
      await tp(P.town.x + 24, P.town.z + 16, 2500);
      await view('first');
      await lookAt(P.town.x, P.town.y + 4, P.town.z);
      await tile('town night, Low');
    }
    await time(19.1);
    await biomeShot(5, 'dusk, Low');
    await weather('rain', 7000);
    await biomeShot(2, 'rain, Low');
    await weather('clear', 500);
    void sp;
    await L(() => window.__lodestone.setQuality('high'));
    await sheet('low');
  }

  // ── world life (fixes): birds, butterflies, fireflies, smoke, leaves ──
  if (want('life')) {
    note('life');
    const sp = await biomeSpots();
    await time(10);
    await weather('clear', 500);
    await tp(sp[0].x, sp[0].z, 2000);
    await view('first');
    await look(0.5, 0.25);
    await sleep(6000);
    await tile('meadow sky 10:00 (birds?)');
    await look(0.5, -0.2);
    await tile('meadow ground (butterflies?)');
    await tp(sp[1].x, sp[1].z, 2000);
    await look(1.5, 0.0);
    await tile('forest 10:00 (leaves?)');
    await time(22.5);
    await tp(sp[1].x, sp[1].z, 2000);
    await look(1.5, -0.05);
    await sleep(5000);
    await tile('forest 22:30 (fireflies?)');
    await tp(sp[5].x + 60, sp[5].z, 2000);
    await look(0.5, -0.1);
    await sleep(5000);
    await tile('wetland 22:30 (fireflies?)');
    await time(15);
    await tp(sp[2].x, sp[2].z, 2000);
    await look(0.5, 0.3);
    await sleep(5000);
    await tile('highlands 15:00 sky (hawks?)');
    if (P.town) {
      await time(9);
      await tp(P.town.x - 30, P.town.z + 30, 2500);
      await lookAt(P.town.x, P.town.y + 8, P.town.z);
      await tile('town chimneys 09:00 (smoke?)');
    }
    await sheet('life');
  }
} catch (e) {
  issue('fatal', `${e.message}\n${e.stack}`);
} finally {
  report.issues = T.issues;
  writeFileSync(`${TMP}/report.json`, JSON.stringify(report, null, 2));
  T.save();
  await T.browser.close();
}
