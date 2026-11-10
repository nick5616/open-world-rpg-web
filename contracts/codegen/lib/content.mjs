// content.yaml -> normalized content tables (playtest 2, CR 022).
//
// Like items.mjs: maps keyed for people become arrays with stable ids, every
// reference is checked (enemy keys against combat.yaml, item keys against
// items.yaml, roles, biomes, feat stats, story step kinds), and the same
// object is emitted as a TS module (client: codex, lore, feats, herbs, event
// names) and as JSON embedded by server/pkg/contentdefs (zone: generators,
// rules and rewards).
import { HEADER_NOTE } from './util.mjs';

function fail(msg) {
  throw new Error(`content.yaml: ${msg}`);
}

export const ROLES = ['villager', 'merchant', 'blacksmith', 'innkeeper', 'bounty', 'farmer', 'guard'];
const SHOPS = ['general', 'provisions', 'herbalist', 'tools', 'smith'];
const SIDE_KINDS = ['hunt', 'gather', 'deliver', 'explore', 'rescue'];
const STEP_KINDS = ['talk', 'reach', 'read', 'attune', 'kill', 'clear', 'give', 'dungeon'];
const SITE_KINDS = ['shrine', 'ruin', 'watchtower', 'tower', 'banditcamp', 'landmark', 'dungeon'];
const TOWNS = ['home', 'next', 'far'];
const FEAT_STATS = ['towers', 'kills', 'demons', 'regions', 'duels', 'quests', 'side', 'stories', 'events', 'dungeons', 'tablets', 'codex', 'forage', 'honored', 'level', 'bounties', 'fish', 'fishspecies', 'fishlegend', 'notes', 'ovations', 'firesongs', 'tamed', 'tamedspecies', 'shinytamed', 'petlevel'];
const PET_ABILITY_KINDS = ['heal', 'buff', 'charge', 'strike'];
const EVENT_KINDS = ['starfall', 'caravan', 'behemoth', 'wildhunt', 'glintfox'];
const PUZZLES = ['levers', 'plates', 'braziers', 'font'];
const WATERS = ['lake', 'river', 'sea'];
const FISH_RARITIES = ['common', 'uncommon', 'rare', 'legendary'];
const FISH_TIMES = ['any', 'day', 'night', 'dawn', 'dusk'];
const FISH_WEATHER = ['any', 'rain', 'clear'];
const VOICES = ['pluck', 'flute', 'drum', 'bell'];
const POSES = ['strum', 'flute', 'drum', 'bells'];

const range = (v, what) => {
  if (!Array.isArray(v) || v.length !== 2 || !(v[0] <= v[1]) || v[0] < 0) fail(`${what}: [min, max] with 0 <= min <= max`);
  return v;
};
const texts = (v, what) => {
  if (!Array.isArray(v) || !v.length || v.some((t) => typeof t !== 'string' || !t)) fail(`${what}: a non-empty list of lines`);
  return v;
};

/** Parse and validate; `combat`/`items` are the normalized combat and item tables. */
export function parseContent(doc, combat, items) {
  if (doc.version !== 1) fail('version must be 1');
  const itemKeys = new Set(items.items.map((i) => i.key));
  const item = (k, what) => {
    if (!itemKeys.has(k)) fail(`${what}: unknown item ${k}`);
    return k;
  };
  const enemyByKey = new Map(combat.enemies.map((e) => [e.key, e]));
  const enemy = (k, what) => {
    if (!enemyByKey.has(k)) fail(`${what}: unknown enemy ${k}`);
    return k;
  };
  // combat.yaml tables.biome order (the atlas biome index).
  const biomeNames = ['meadow', 'forest', 'highlands', 'snowpeak', 'badlands', 'wetland'];
  const role = (r, what) => {
    const i = ROLES.indexOf(r);
    if (i < 0) fail(`${what}: unknown role ${r} (${ROLES.join(', ')})`);
    return i;
  };

  // ---- reputation ----
  const rp = doc.reputation;
  const tiers = rp.tiers.map((t, i) => ({ key: t.key, id: i, name: t.name, min: t.min }));
  tiers.forEach((t, i) => {
    if (i === 0 && t.min !== 0) fail('reputation.tiers: the first tier starts at 0');
    if (i > 0 && !(t.min > tiers[i - 1].min)) fail('reputation.tiers: increasing min');
  });
  const wares = tiers.map((t) => {
    const byShop = rp.wares[t.key] ?? {};
    for (const s of Object.keys(byShop)) if (!SHOPS.includes(s)) fail(`reputation.wares.${t.key}: unknown shop ${s}`);
    return SHOPS.map((s) => (byShop[s] ?? []).map((w) => ({ item: item(w.item, `reputation.wares.${t.key}.${s}`), price: w.price, stock: w.stock ?? 1 })));
  });

  // ---- side quests ----
  const sq = doc.sidequests;
  const givers = { min: sq.givers.min, max: sq.givers.max, roles: sq.givers.roles.map((r) => role(r, 'sidequests.givers')) };
  if (!(givers.min >= 1 && givers.max >= givers.min && givers.max <= 6)) fail('sidequests.givers: 1 <= min <= max <= 6');
  if (sq.creatures.length !== 6) fail('sidequests.creatures: one per biome (6)');
  texts(sq.villagers, 'sidequests.villagers');
  const kinds = SIDE_KINDS.map((k) => {
    const s = sq.kinds[k] ?? fail(`sidequests.kinds.${k} missing`);
    const out = {
      key: k, weight: s.weight ?? 1, titles: texts(s.titles, `${k}.titles`), offer: texts(s.offer, `${k}.offer`), step: s.step, note: s.note ?? '',
      back: s.back ?? '', thanks: texts(s.thanks, `${k}.thanks`), gold: range(s.gold, `${k}.gold`), xp: range(s.xp, `${k}.xp`), rep: s.rep ?? 0,
      n: s.n ? range(s.n, `${k}.n`) : [1, 1], radius: s.radius ?? 0, items: [], escort: s.escort ?? '', escortNote: s.escortNote ?? '', found: s.found ?? '',
    };
    if (!out.step) fail(`sidequests.kinds.${k}: step text`);
    if (k === 'gather') out.items = s.items.map((g) => ({ item: item(g.item, 'gather.items'), qty: range(g.qty, `gather ${g.item} qty`) }));
    if (k === 'hunt' && !(out.radius > 0)) fail('hunt.radius');
    if ((k === 'hunt' || k === 'explore' || k === 'rescue') && !out.back) fail(`${k}.back`);
    if (k === 'rescue' && (!out.escort || !out.found)) fail('rescue: escort and found');
    return out;
  });

  // ---- stories ----
  const featKeys = new Set(Object.keys(doc.feats));
  const stories = Object.entries(doc.stories).map(([key, s], i) => {
    const steps = s.steps.map((st, j) => {
      const what = `story ${key} step ${j + 1}`;
      if (!STEP_KINDS.includes(st.kind)) fail(`${what}: kind ${st.kind}`);
      if (st.site !== undefined && !SITE_KINDS.includes(st.site)) fail(`${what}: site ${st.site}`);
      if (st.near !== undefined && !TOWNS.includes(st.near)) fail(`${what}: near ${st.near}`);
      if (st.town !== undefined && !TOWNS.includes(st.town)) fail(`${what}: town ${st.town}`);
      if (['reach', 'read', 'kill', 'clear', 'dungeon'].includes(st.kind) && !st.site) fail(`${what}: needs a site`);
      if (['talk', 'give'].includes(st.kind) && (!st.role || !st.town)) fail(`${what}: needs role and town`);
      if (st.kind === 'give' && !st.item) fail(`${what}: give needs an item`);
      if (st.kind === 'kill' && !(st.n > 0)) fail(`${what}: kill needs n`);
      if (!st.text) fail(`${what}: text`);
      return {
        kind: st.kind, site: st.site ?? '', near: st.near ?? 'home', town: st.town ?? '', role: st.role ? role(st.role, what) : -1, n: st.n ?? 0,
        item: st.item ? item(st.item, what) : '', grant: st.grant ? item(st.grant, what) : '', text: st.text, note: st.note ?? '', say: st.say ?? '',
      };
    });
    if (s.feat && !featKeys.has(s.feat) && !['hum', 'watch', 'bell'].includes(s.feat)) fail(`story ${key}: unknown feat ${s.feat}`);
    return {
      key, id: i + 1, title: s.title, role: role(s.role, `story ${key}`), altRole: s.altRole ? role(s.altRole, `story ${key}`) : -1, offer: s.offer,
      gold: s.gold ?? 0, xp: s.xp ?? 0, rep: s.rep ?? 0, items: s.items ?? 0, steps,
    };
  });

  // ---- world events ----
  const ev = doc.events;
  for (const k of ['everyS', 'chancePerPlayer', 'maxActive', 'minGapM', 'spawnMinM', 'spawnMaxM', 'announceM', 'playerCooldownS']) {
    if (!(ev.scheduler[k] > 0)) fail(`events.scheduler.${k}`);
  }
  const affixKeys = new Set(combat.affixes.map((a) => a.key));
  const eventKinds = EVENT_KINDS.map((k, i) => {
    const e = ev.kinds[k] ?? fail(`events.kinds.${k} missing`);
    const r = e.reward ?? {};
    const out = {
      key: k, id: i + 1, name: e.name, weight: e.weight ?? 1, night: !!e.night, announce: e.announce, success: e.success, fail: e.fail,
      durationS: e.durationS, comp: (e.comp ?? []).map((c) => enemy(c, `events.${k}.comp`)), elite: e.elite ?? '', radius: e.radius ?? 25,
      waves: (e.waves ?? []).map((w) => w.map((c) => enemy(c, `events.${k}.waves`))), caravanHp: e.caravanHp ?? 0, damagePerBandit: e.damagePerBandit ?? 0,
      roamSpeed: e.roamSpeed ?? 0, roamLegM: e.roamLegM ?? 0,
      reward: { gold: range(r.gold ?? [0, 0], `events.${k}.reward.gold`), xp: r.xp ?? 0, items: r.items ?? 0, luck: r.luck ?? 1, ore: r.ore ? item(r.ore, `events.${k}`) : '', oreQty: r.oreQty ?? [0, 0], gems: r.gems ?? [0, 0] },
    };
    if (out.elite && !affixKeys.has(out.elite)) fail(`events.${k}: unknown elite affix ${out.elite}`);
    if (!(out.durationS > 0)) fail(`events.${k}.durationS`);
    if (k === 'caravan' && (!out.waves.length || !(out.caravanHp > 0))) fail('events.caravan: waves and caravanHp');
    if (k !== 'caravan' && !out.comp.length) fail(`events.${k}: comp`);
    for (const t of [out.announce, out.success, out.fail]) if (!t) fail(`events.${k}: announce, success and fail lines`);
    return out;
  });

  // ---- dungeons ----
  const dg = doc.dungeons;
  const bossKeys = new Set(combat.bosses.map((b) => b.key));
  enemy(dg.boss, 'dungeons.boss');
  if (!bossKeys.has(dg.boss)) fail(`dungeons.boss ${dg.boss} has no bosses entry in combat.yaml`);
  const puzzles = PUZZLES.map((k, i) => {
    const p = dg.puzzles[k] ?? fail(`dungeons.puzzles.${k} missing`);
    return { key: k, id: i, name: p.name, hint: p.hint, wrong: p.wrong ?? '', parts: p.parts ?? 1, holdS: p.holdS ?? 0, element: p.element ?? '' };
  });
  const dungeons = {
    discoverM: dg.discoverM, activeM: dg.activeM, resetS: dg.resetS, names: texts(dg.names, 'dungeons.names'), door: dg.door, puzzles,
    packs: dg.packs.map((p) => p.map((k) => enemy(k, 'dungeons.packs'))), boss: dg.boss,
    chest: { gold: range(dg.chest.gold, 'dungeons.chest.gold'), minRarity: items.rarities.findIndex((r) => r.key === dg.chest.minRarity), items: dg.chest.items, luck: dg.chest.luck, cooldownH: dg.chest.cooldownH },
  };
  if (dungeons.chest.minRarity < 0) fail(`dungeons.chest.minRarity: unknown rarity ${dg.chest.minRarity}`);

  // ---- tablets ----
  const tabSeen = new Set();
  const tablets = doc.tablets.map((t, i) => {
    if (tabSeen.has(t.key)) fail(`tablets: duplicate ${t.key}`);
    tabSeen.add(t.key);
    if (!t.title || !t.text) fail(`tablet ${t.key}: title and text`);
    return { key: t.key, id: i + 1, title: t.title, text: t.text };
  });

  // ---- codex: every enemy has an entry ----
  for (const k of Object.keys(doc.codex)) enemy(k, 'codex');
  const codex = combat.enemies.map((e) => {
    const c = doc.codex[e.key] ?? fail(`codex: no entry for enemy ${e.key}`);
    if (!c.habitat || !c.lore) fail(`codex ${e.key}: habitat and lore`);
    return { key: e.key, enemyId: e.id, habitat: c.habitat, lore: c.lore };
  });

  // ---- feats ----
  const familyKeys = new Set(combat.enemies.map((e) => e.family));
  const feats = Object.entries(doc.feats).map(([key, f], i) => {
    const [stat, arg] = String(f.stat).split(':');
    if (stat === 'family') {
      if (!familyKeys.has(arg)) fail(`feat ${key}: unknown family ${arg}`);
    } else if (!FEAT_STATS.includes(stat)) fail(`feat ${key}: unknown stat ${f.stat}`);
    if (!(f.n > 0)) fail(`feat ${key}: n > 0`);
    return { key, id: i + 1, name: f.name, desc: f.desc, stat: f.stat, n: f.n, gold: f.gold ?? 0, xp: f.xp ?? 0, title: f.title ?? '' };
  });
  if (feats.length > 63) fail('feats: at most 63 (title ids ride in 6 bits)');

  // ---- foraging ----
  const fg = doc.forage;
  const herbs = Object.entries(fg.herbs).map(([key, h], i) => {
    const it = items.items.find((x) => x.key === h.item);
    if (!it) fail(`forage.${key}: unknown item ${h.item}`);
    const biomes = h.biomes.map((b) => {
      const bi = biomeNames.indexOf(b);
      if (bi < 0) fail(`forage.${key}: unknown biome ${b}`);
      return bi;
    });
    return { key, id: i + 1, item: h.item, name: it.name, biomes, color: h.color, weight: h.weight ?? 1 };
  });
  if (herbs.length > 15) fail('forage: at most 15 herbs');
  const forage = { cellM: fg.cellM, chance: fg.chance, regrowS: fg.regrowS, reachM: fg.reachM, herbs };

  // ---- fishing (playtest 2, CR 026) ----
  const fi = doc.fishing ?? fail('fishing: missing');
  item(fi.rod, 'fishing.rod');
  const rarityKeys = Object.keys(fi.rarities);
  if (rarityKeys.join(',') !== FISH_RARITIES.join(',')) fail(`fishing.rarities: exactly ${FISH_RARITIES.join(', ')}`);
  const fishRarities = rarityKeys.map((k, i) => ({ key: k, id: i, weight: fi.rarities[k].weight, color: fi.rarities[k].color }));
  const species = Object.entries(fi.species).map(([key, f], i) => {
    const it = items.items.find((x) => x.key === f.item);
    if (!it) fail(`fishing.${key}: unknown item ${f.item}`);
    if (!f.item.startsWith('fish:')) fail(`fishing.${key}: the item must be a fish: item`);
    const rarity = FISH_RARITIES.indexOf(f.rarity);
    if (rarity < 0) fail(`fishing.${key}: unknown rarity ${f.rarity}`);
    const water = f.water.map((w) => {
      const wi = WATERS.indexOf(w);
      if (wi < 0) fail(`fishing.${key}: unknown water ${w}`);
      return wi;
    });
    const biomes = f.biomes.includes('any')
      ? []
      : f.biomes.map((b) => {
          const bi = biomeNames.indexOf(b);
          if (bi < 0) fail(`fishing.${key}: unknown biome ${b}`);
          return bi;
        });
    if (!FISH_TIMES.includes(f.time)) fail(`fishing.${key}: time must be one of ${FISH_TIMES.join(', ')}`);
    if (!FISH_WEATHER.includes(f.weather)) fail(`fishing.${key}: weather must be one of ${FISH_WEATHER.join(', ')}`);
    range(f.weight, `fishing.${key}.weight`);
    const fight = f.fight ?? {};
    for (const k of ['strength', 'erratic']) if (!(fight[k] >= 0 && fight[k] <= 1)) fail(`fishing.${key}.fight.${k}: 0..1`);
    if (!(fight.stamina >= 1 && fight.stamina <= 12)) fail(`fishing.${key}.fight.stamina: 1..12 s`);
    if (!f.habitat || !f.lore) fail(`fishing.${key}: habitat and lore`);
    return { key, id: i + 1, name: f.name, item: f.item, rarity, water, biomes, time: f.time, weather: f.weather, weight: f.weight, fight: { strength: fight.strength, erratic: fight.erratic, stamina: fight.stamina }, habitat: f.habitat, lore: f.lore };
  });
  if (!species.length || species.length > 63) fail('fishing: 1..63 species');
  for (const f of feats) if (f.stat === 'fishspecies' && f.n > species.length) fail(`feat ${f.key}: more species than exist`);
  const fishing = {
    rod: fi.rod, castM: range(fi.castM, 'fishing.castM'), minDepthM: fi.minDepthM, biteS: range(fi.biteS, 'fishing.biteS'), hookWindowMs: fi.hookWindowMs,
    maxFightS: fi.maxFightS, castCooldownS: fi.castCooldownS, castBurst: fi.castBurst, castEveryS: fi.castEveryS, walkAwayM: fi.walkAwayM, seeM: fi.seeM,
    waters: WATERS, times: FISH_TIMES, rarities: fishRarities, species,
  };

  // ---- emotes (playtest 2, CR 026) ----
  const em = doc.emotes ?? fail('emotes: missing');
  const emoteIds = new Set();
  const emotes = Object.entries(em.list).map(([key, e]) => {
    if (!(Number.isInteger(e.id) && e.id > 0 && e.id < 32)) fail(`emote ${key}: id 1..31`);
    if (emoteIds.has(e.id)) fail(`emote ${key}: duplicate id ${e.id}`);
    emoteIds.add(e.id);
    if (!e.loop && !(e.durS > 0)) fail(`emote ${key}: durS or loop`);
    return { key, id: e.id, name: e.name, durS: e.durS ?? 0, loop: !!e.loop, system: !!e.system };
  });
  const emoteDefs = { seeM: em.seeM, burst: em.burst, everyS: em.everyS, list: emotes };

  // ---- taming and pets (playtest 2, CR 029) ----
  const tm = doc.taming ?? fail('taming: missing');
  const num = (v, what, lo = 0, hi = Infinity) => {
    if (typeof v !== 'number' || !(v >= lo && v <= hi)) fail(`taming.${what}: a number in [${lo}, ${hi}]`);
    return v;
  };
  for (const k of ['weakenPct', 'favouriteMult', 'favouriteBonus', 'shinyChance', 'elementalChance', 'hpPerLevel', 'damagePerLevel', 'regenPctS', 'feedHealPct']) num(tm[k], k, 0, 1);
  for (const k of ['calmS', 'smellM', 'feedReachM', 'stayM', 'koRecoverS', 'stableM', 'xpBase', 'xpGrowth', 'followM', 'warpM', 'stayGuardM', 'aggroM', 'leashM']) num(tm[k], k, 0.01);
  if (!(Number.isInteger(tm.maxPets) && tm.maxPets >= 1 && tm.maxPets <= 16)) fail('taming.maxPets: 1..16');
  if (!(Number.isInteger(tm.levelMax) && tm.levelMax >= 2 && tm.levelMax <= 60)) fail('taming.levelMax: 2..60');
  if (tm.xpGrowth < 1) fail('taming.xpGrowth: >= 1');
  const statusKeys = new Set(combat.statuses.map((s) => s.key));
  const abilityIds = new Set();
  const petAbilities = Object.entries(tm.abilities ?? {}).map(([key, a]) => {
    if (!(Number.isInteger(a.id) && a.id > 0 && a.id < 256) || abilityIds.has(a.id)) fail(`taming.abilities.${key}: a unique id 1..255`);
    abilityIds.add(a.id);
    if (!PET_ABILITY_KINDS.includes(a.kind)) fail(`taming.abilities.${key}: kind one of ${PET_ABILITY_KINDS.join(', ')}`);
    num(a.cooldownS, `abilities.${key}.cooldownS`, 1);
    num(a.power, `abilities.${key}.power`, 0.01, 5);
    if (a.status && !statusKeys.has(a.status)) fail(`taming.abilities.${key}: unknown status ${a.status}`);
    let element = -1;
    if (a.element) {
      element = combat.elements.indexOf(a.element);
      if (element < 0) fail(`taming.abilities.${key}: unknown element ${a.element}`);
    }
    if (a.kind === 'heal' && !(a.healBelow > 0 && a.healBelow <= 1)) fail(`taming.abilities.${key}: healBelow 0..1`);
    if (a.kind === 'buff' && !(a.durationS > 0)) fail(`taming.abilities.${key}: durationS`);
    if (a.kind === 'charge') range(a.rangeM, `taming.abilities.${key}.rangeM`);
    if (!a.name || !a.desc) fail(`taming.abilities.${key}: name and desc`);
    return { key, id: a.id, name: a.name, kind: a.kind, cooldownS: a.cooldownS, power: a.power, healBelow: a.healBelow ?? 0, party: !!a.party, durationS: a.durationS ?? 0, rangeM: a.rangeM ?? [0, 0], radiusM: a.radiusM ?? 0, status: a.status ?? '', element, desc: a.desc };
  });
  const speciesIds = new Set();
  const petSpecies = Object.entries(tm.species ?? {}).map(([key, p]) => {
    if (!(Number.isInteger(p.id) && p.id > 0 && p.id < 64) || speciesIds.has(p.id)) fail(`taming.species.${key}: a unique id 1..63`);
    speciesIds.add(p.id);
    const en = enemyByKey.get(enemy(p.enemy, `taming.species.${key}`));
    if (en.family === 'demon' || en.family === 'boss' || en.demon) fail(`taming.species.${key}: demons and bosses can't be tamed`);
    if (!Array.isArray(p.foods) || !p.foods.length) fail(`taming.species.${key}: foods (the first is its favourite)`);
    for (const f of p.foods) {
      item(f, `taming.species.${key}.foods`);
      if (!/^(food|meat|herb|fish):/.test(f)) fail(`taming.species.${key}: ${f} is not something to eat`);
    }
    num(p.tameS, `species.${key}.tameS`, 0.5, 30);
    num(p.chance, `species.${key}.chance`, 0.05, 1);
    num(p.hp, `species.${key}.hp`, 1);
    num(p.damage, `species.${key}.damage`, 0.1);
    num(p.speed, `species.${key}.speed`, 1, 20);
    const at = p.attack ?? fail(`taming.species.${key}: attack`);
    num(at.reach, `species.${key}.attack.reach`, 0.5, 6);
    num(at.everyMs, `species.${key}.attack.everyMs`, 200);
    num(at.windupMs, `species.${key}.attack.windupMs`, 0);
    const ab = petAbilities.find((a) => a.key === p.ability) ?? fail(`taming.species.${key}: unknown ability ${p.ability}`);
    if (!p.blurb) fail(`taming.species.${key}: blurb`);
    return { key, id: p.id, enemy: p.enemy, enemyId: en.id, foods: p.foods, tameS: p.tameS, chance: p.chance, hp: p.hp, damage: p.damage, speed: p.speed, attack: { reach: at.reach, everyMs: at.everyMs, windupMs: at.windupMs }, ability: ab.id, blurb: p.blurb };
  });
  if (!petSpecies.length) fail('taming: no species');
  if (new Set(petSpecies.map((p) => p.enemy)).size !== petSpecies.length) fail('taming: one species per creature');
  for (const f of feats) if (f.stat === 'tamedspecies' && f.n > petSpecies.length) fail(`feat ${f.key}: more species than can be tamed`);
  for (const f of feats) if (f.stat === 'petlevel' && f.n > tm.levelMax) fail(`feat ${f.key}: above taming.levelMax`);
  const taming = {
    weakenPct: tm.weakenPct, calmS: tm.calmS, smellM: tm.smellM, feedReachM: tm.feedReachM, stayM: tm.stayM, favouriteMult: tm.favouriteMult, favouriteBonus: tm.favouriteBonus,
    shinyChance: tm.shinyChance, elementalChance: tm.elementalChance, maxPets: tm.maxPets, koRecoverS: tm.koRecoverS, stableM: tm.stableM, levelMax: tm.levelMax,
    xpBase: tm.xpBase, xpGrowth: tm.xpGrowth, hpPerLevel: tm.hpPerLevel, damagePerLevel: tm.damagePerLevel, regenPctS: tm.regenPctS, feedHealPct: tm.feedHealPct,
    followM: tm.followM, warpM: tm.warpM, stayGuardM: tm.stayGuardM, aggroM: tm.aggroM, leashM: tm.leashM,
    abilities: petAbilities, species: petSpecies,
  };

  // ---- instruments (playtest 2, CR 028) ----
  const ins = doc.instruments ?? fail('instruments: missing');
  const pos = (v, what) => {
    if (!(typeof v === 'number' && v > 0)) fail(`instruments.${what}: a positive number`);
    return v;
  };
  for (const k of ['hearM', 'batchMs', 'batchBurst', 'batchesPerS', 'notesBurst', 'notesPerS', 'holdMaxS']) pos(ins[k], k);
  if (ins.batchMs > 63) fail('instruments.batchMs: at most 63 (a note offset rides in 6 bits)');
  if (1000 / ins.batchMs > ins.batchesPerS) fail('instruments.batchesPerS: below what an honest client sends (1000 / batchMs)');
  for (const k of ['gapS', 'minNotes', 'minS']) pos(ins.song?.[k], `song.${k}`);
  for (const k of ['npcM', 'maxNpcs', 'everyS']) pos(ins.applause?.[k], `applause.${k}`);
  for (const k of ['songS', 'gapS']) pos(ins.fireside?.[k], `fireside.${k}`);
  range(ins.jam?.bpm, 'instruments.jam.bpm');
  if (!(ins.jam.defaultBpm >= ins.jam.bpm[0] && ins.jam.defaultBpm <= ins.jam.bpm[1])) fail('instruments.jam.defaultBpm: inside bpm');
  const instrumentIds = new Set();
  const instrumentList = Object.entries(ins.list).map(([key, x]) => {
    if (!(Number.isInteger(x.id) && x.id > 0 && x.id < 16)) fail(`instrument ${key}: id 1..15`);
    if (instrumentIds.has(x.id)) fail(`instrument ${key}: duplicate id ${x.id}`);
    instrumentIds.add(x.id);
    item(x.item, `instruments.${key}`);
    if (!x.item.startsWith('instrument:')) fail(`instruments.${key}: the item must be an instrument: item`);
    if (!VOICES.includes(x.voice)) fail(`instruments.${key}: voice one of ${VOICES.join(', ')}`);
    if (!POSES.includes(x.pose)) fail(`instruments.${key}: pose one of ${POSES.join(', ')}`);
    range(x.range, `instruments.${key}.range`);
    if (!(Number.isInteger(x.range[0]) && Number.isInteger(x.range[1]) && x.range[0] >= 12 && x.range[1] <= 120 && x.range[1] - x.range[0] >= 12)) fail(`instruments.${key}.range: MIDI notes 12..120, an octave at least`);
    return { key, id: x.id, item: x.item, name: x.name, voice: x.voice, range: x.range, sustain: !!x.sustain, pose: x.pose };
  });
  if (!instrumentList.length) fail('instruments: none listed');
  for (const s of Object.keys(ins.wares ?? {})) if (!SHOPS.includes(s)) fail(`instruments.wares: unknown shop ${s}`);
  const instrumentWares = SHOPS.map((s) => (ins.wares?.[s] ?? []).map((w) => ({ item: item(w.item, `instruments.wares.${s}`), price: pos(w.price, `wares.${s}.price`), stock: w.stock ?? 1 })));
  if (!emotes.some((e) => e.id === 22 && e.system && e.loop)) fail('emotes: 22 (playing music) must be a looping system emote');
  const instruments = {
    hearM: ins.hearM, batchMs: ins.batchMs, batchBurst: ins.batchBurst, batchesPerS: ins.batchesPerS, notesBurst: ins.notesBurst, notesPerS: ins.notesPerS, holdMaxS: ins.holdMaxS,
    song: { gapS: ins.song.gapS, minNotes: ins.song.minNotes, minS: ins.song.minS },
    applause: { npcM: ins.applause.npcM, maxNpcs: ins.applause.maxNpcs, everyS: ins.applause.everyS },
    fireside: { songS: ins.fireside.songS, gapS: ins.fireside.gapS },
    jam: { bpm: ins.jam.bpm, defaultBpm: ins.jam.defaultBpm },
    list: instrumentList,
    wares: instrumentWares,
  };

  return {
    version: doc.version,
    reputation: { tiers, shops: SHOPS, wares },
    sidequests: { givers, near: sq.near, creatures: sq.creatures, villagers: sq.villagers, kinds },
    stories,
    events: { scheduler: ev.scheduler, kinds: eventKinds },
    dungeons,
    tablets,
    codex,
    feats,
    forage,
    fishing,
    emotes: emoteDefs,
    taming,
    instruments,
    roles: ROLES,
  };
}

export function genContentJson(d) {
  return JSON.stringify(d, null, 1) + '\n';
}

const TS_TYPES = `
export interface RepTierDef { key: string; id: number; name: string; min: number }
export interface StoryDef { key: string; id: number; title: string; role: number; altRole: number; offer: string; gold: number; xp: number; rep: number; items: number; steps: { kind: string; text: string; [k: string]: unknown }[]; [k: string]: unknown }
export interface EventKindDef { key: string; id: number; name: string; night: boolean; announce: string; success: string; fail: string; durationS: number; radius: number; [k: string]: unknown }
export interface PuzzleDef { key: string; id: number; name: string; hint: string; wrong: string; parts: number; holdS: number; element: string }
export interface TabletDef { key: string; id: number; title: string; text: string }
export interface CodexDef { key: string; enemyId: number; habitat: string; lore: string }
export interface FeatDef { key: string; id: number; name: string; desc: string; stat: string; n: number; gold: number; xp: number; title: string }
export interface HerbDef { key: string; id: number; item: string; name: string; biomes: number[]; color: string; weight: number }
export interface FishDef { key: string; id: number; name: string; item: string; rarity: number; water: number[]; biomes: number[]; time: 'any' | 'day' | 'night' | 'dawn' | 'dusk'; weather: 'any' | 'rain' | 'clear'; weight: [number, number]; fight: { strength: number; erratic: number; stamina: number }; habitat: string; lore: string }
export interface FishingDefs { rod: string; castM: [number, number]; minDepthM: number; biteS: [number, number]; hookWindowMs: number; maxFightS: number; castCooldownS: number; castBurst: number; castEveryS: number; walkAwayM: number; seeM: number; waters: string[]; times: string[]; rarities: { key: string; id: number; weight: number; color: string }[]; species: FishDef[] }
export interface EmoteDef { key: string; id: number; name: string; durS: number; loop: boolean; system: boolean }
export interface PetAbilityDef { key: string; id: number; name: string; kind: 'heal' | 'buff' | 'charge' | 'strike'; cooldownS: number; power: number; healBelow: number; party: boolean; durationS: number; rangeM: [number, number]; radiusM: number; status: string; element: number; desc: string }
export interface PetSpeciesDef { key: string; id: number; enemy: string; enemyId: number; foods: string[]; tameS: number; chance: number; hp: number; damage: number; speed: number; attack: { reach: number; everyMs: number; windupMs: number }; ability: number; blurb: string }
export interface TamingDefs { weakenPct: number; calmS: number; smellM: number; feedReachM: number; stayM: number; favouriteMult: number; favouriteBonus: number; shinyChance: number; elementalChance: number; maxPets: number; koRecoverS: number; stableM: number; levelMax: number; xpBase: number; xpGrowth: number; hpPerLevel: number; damagePerLevel: number; regenPctS: number; feedHealPct: number; followM: number; warpM: number; stayGuardM: number; aggroM: number; leashM: number; abilities: PetAbilityDef[]; species: PetSpeciesDef[] }
export interface InstrumentDef { key: string; id: number; item: string; name: string; voice: 'pluck' | 'flute' | 'drum' | 'bell'; range: [number, number]; sustain: boolean; pose: 'strum' | 'flute' | 'drum' | 'bells' }
export interface InstrumentDefs { hearM: number; batchMs: number; batchBurst: number; batchesPerS: number; notesBurst: number; notesPerS: number; holdMaxS: number; song: { gapS: number; minNotes: number; minS: number }; applause: { npcM: number; maxNpcs: number; everyS: number }; fireside: { songS: number; gapS: number }; jam: { bpm: [number, number]; defaultBpm: number }; list: InstrumentDef[]; wares: { item: string; price: number; stock: number }[][] }
export interface ContentDefs {
  version: number;
  reputation: { tiers: RepTierDef[]; shops: string[]; wares: { item: string; price: number; stock: number }[][][] };
  sidequests: Record<string, unknown>;
  stories: StoryDef[];
  events: { scheduler: Record<string, number>; kinds: EventKindDef[] };
  dungeons: { discoverM: number; activeM: number; resetS: number; names: string[]; door: string; puzzles: PuzzleDef[]; boss: string; [k: string]: unknown };
  tablets: TabletDef[];
  codex: CodexDef[];
  feats: FeatDef[];
  forage: { cellM: number; chance: number; regrowS: number; reachM: number; herbs: HerbDef[] };
  fishing: FishingDefs;
  emotes: { seeM: number; burst: number; everyS: number; list: EmoteDef[] };
  taming: TamingDefs;
  instruments: InstrumentDefs;
  roles: string[];
}
`;

export function genContentTs(d) {
  return `// ${HEADER_NOTE}\n// Source: contracts/content.yaml (normalized by contracts/codegen/lib/content.mjs)\n/* eslint-disable */\n${TS_TYPES}\nexport const CONTENT: ContentDefs = ${JSON.stringify(d)};\n`;
}
