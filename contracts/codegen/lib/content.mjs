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
const FEAT_STATS = ['towers', 'kills', 'demons', 'regions', 'duels', 'quests', 'side', 'stories', 'events', 'dungeons', 'tablets', 'codex', 'forage', 'honored', 'level', 'bounties'];
const EVENT_KINDS = ['starfall', 'caravan', 'behemoth', 'wildhunt', 'glintfox'];
const PUZZLES = ['levers', 'plates', 'braziers', 'font'];

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
  roles: string[];
}
`;

export function genContentTs(d) {
  return `// ${HEADER_NOTE}\n// Source: contracts/content.yaml (normalized by contracts/codegen/lib/content.mjs)\n/* eslint-disable */\n${TS_TYPES}\nexport const CONTENT: ContentDefs = ${JSON.stringify(d)};\n`;
}
