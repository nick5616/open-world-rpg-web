// combat.yaml -> normalized combat tables (WP13, CR 009).
//
// The YAML is written for people (maps keyed by name, milliseconds); the
// normalized form is written for code: arrays with a `key` and a numeric
// `id`, every `xxxMs` timing joined by an `xxxSteps` sibling (60 Hz input
// steps, the unit both sides simulate in), defaults filled in, names
// resolved from the single name table. The same normalized object is
// emitted as a TS module (client) and as JSON embedded by
// server/pkg/combatdefs (zone), so the two can never disagree.
//
// Validation here is the build-time half of the spec 8 feel targets: a
// light move that starts slower than LIGHT_STARTUP_MAX_MS or recovers
// slower than LIGHT_RECOVERY_MAX_MS, or an enemy wind-up outside
// ENEMY_WINDUP_MIN_MS..MAX_MS, fails `npm run gen`.
import { HEADER_NOTE } from './util.mjs';

const STEP_HZ = 60;
const toSteps = (ms) => Math.round((ms * STEP_HZ) / 1000);
const stepsToMs = (s) => (s * 1000) / STEP_HZ;

/** Add `xxxSteps` for every numeric `xxxMs` field (recursively for plain objects). */
function withSteps(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    out[k] = v;
    if (typeof v === 'number' && k.endsWith('Ms')) out[k.slice(0, -2) + 'Steps'] = toSteps(v);
  }
  return out;
}

function fail(msg) {
  throw new Error(`combat.yaml: ${msg}`);
}

function uniqueIds(list, what) {
  const seen = new Map();
  for (const x of list) {
    if (!Number.isInteger(x.id) || x.id <= 0 || x.id > 65535) fail(`${what} ${x.key}: id must be 1..65535`);
    if (seen.has(x.id)) fail(`${what} ${x.key}: id ${x.id} already used by ${seen.get(x.id)}`);
    seen.set(x.id, x.key);
  }
}

/**
 * Parse and validate; `consts` is the parsed constants list (for the feel
 * limits) so the two contracts can't drift.
 */
export function parseCombat(doc, consts) {
  const C = Object.fromEntries(consts.list.map((c) => [c.name, c.value]));
  const names = doc.names ?? {};
  const pending = new Set(doc.pending ?? []);
  const nameOf = (key, what) => {
    if (!(key in names)) fail(`${what} ${key} has no entry in names`);
    return names[key];
  };
  for (const p of pending) if (!(p in names)) fail(`pending ${p} is not in names`);

  const elements = doc.elements;
  if (!Array.isArray(elements) || elements.length !== 8) fail('elements must list the 8 elements');
  const elIndex = (e, what) => {
    if (e === undefined || e === null || e === 'none' || e === 'physical') return 8;
    const i = elements.indexOf(e);
    if (i < 0) fail(`${what}: unknown element ${e}`);
    return i;
  };

  const statuses = Object.entries(doc.statuses).map(([key, s]) => withSteps({ key, ...s }));
  uniqueIds(statuses, 'status');
  const statusKeys = new Set(statuses.map((s) => s.key));
  const checkStatus = (s, what) => {
    if (s !== undefined && !statusKeys.has(s)) fail(`${what}: unknown status ${s}`);
  };

  const skills = {
    xpBase: doc.skills.xpBase,
    xpExp: doc.skills.xpExp,
    list: Object.entries(doc.skills.list).map(([key, s]) => ({
      key,
      id: s.id,
      techniques: Object.entries(s.techniques ?? {}).map(([lvl, t]) => ({ level: Number(lvl), key: t, name: nameOf(t, 'technique'), pending: pending.has(t) })),
    })),
  };
  uniqueIds(skills.list, 'skill');
  const skillKeys = new Set(skills.list.map((s) => s.key));

  const dashes = Object.entries(doc.dashes).map(([key, d]) => ({ key, ...d }));
  uniqueIds(dashes, 'dash');
  for (const d of dashes) {
    if (d.id > 15) fail(`dash ${d.key}: ids 1..15 (castSlot rides in 4 bits of the variant)`);
    if (d.steps > 15 || d.iframes > 15) fail(`dash ${d.key}: steps and iframes at most 15 (4 bits each in SelfState.moveExt)`);
  }
  const dashKeys = new Map(dashes.map((d) => [d.key, d.id]));

  const moves = [];
  const weapons = Object.entries(doc.weapons).map(([key, w]) => {
    if (!skillKeys.has(w.skill)) fail(`weapon ${key}: unknown skill ${w.skill}`);
    const ms = Object.entries(w.moves).map(([mk, m]) => {
      const mv = withSteps({ key: mk, weapon: key, combo: 0, hits: 1, gravity: 0, radius: 0, speed: 0, ...m });
      if (mv.technique && !names[mv.technique]) fail(`move ${mk}: technique ${mv.technique} has no name`);
      if (mv.kind === 'light') {
        if (stepsToMs(mv.startupSteps) > C.LIGHT_STARTUP_MAX_MS + 1e-9) fail(`move ${mk}: light startup ${mv.startupMs} ms > LIGHT_STARTUP_MAX_MS`);
        if (stepsToMs(mv.recoverySteps) > C.LIGHT_RECOVERY_MAX_MS + 1e-9) fail(`move ${mk}: light recovery ${mv.recoveryMs} ms > LIGHT_RECOVERY_MAX_MS`);
      }
      if (mv.startupSteps < 1 || mv.activeSteps < 1) fail(`move ${mk}: startup and active need at least one step`);
      moves.push(mv);
      return mk;
    });
    const out = withSteps({ key, id: w.id, skill: w.skill, spellPower: w.spellPower ?? 1, manaRegen: w.manaRegen ?? 1, cooldownMult: w.cooldownMult ?? 1, moves: ms });
    if (w.parryMs !== undefined) {
      out.parryMs = w.parryMs;
      out.parrySteps = toSteps(w.parryMs);
    }
    if (w.arrows) out.arrows = Object.entries(w.arrows).map(([k, a]) => ({ key: k, mult: a.mult, demonStagger: !!a.demonStagger, killsDemons: !!a.killsDemons }));
    return out;
  });
  uniqueIds(weapons, 'weapon');
  uniqueIds(moves, 'move');

  const forms = Object.entries(doc.forms).map(([el, f]) => {
    const key = `form_${el}`;
    checkStatus(f.status, `form ${key}`);
    if (f.dash !== undefined && !dashes.some((d) => d.id === f.dash)) fail(`form ${key}: unknown dash id ${f.dash}`);
    return withSteps({ key, element: elIndex(el, `form ${key}`), name: nameOf(key, 'form'), pending: pending.has(key), radius: 0, reach: 0, arc: 0, width: 0, chain: 0, lifesteal: 0, demonMult: 1, killsDemons: false, dash: 0, selfCast: false, ...f });
  });
  uniqueIds(forms, 'form');

  // WP15 (CR 011): weapon materials; killsDemons is the whole demon rule.
  const materials = Object.entries(doc.materials ?? {}).map(([key, m]) => ({ key, mult: 1, demonStagger: false, killsDemons: false, ...m }));
  uniqueIds(materials, 'material');

  const treeKeys = new Set(Object.keys(doc.trees));
  const spells = Object.entries(doc.spells).map(([key, s]) => {
    if (!treeKeys.has(s.tree)) fail(`spell ${key}: unknown tree ${s.tree}`);
    checkStatus(s.status, `spell ${key}`);
    const free = s.type === 'mobility' || s.type === 'defensive' || s.type === 'passive';
    const mana = s.mana ?? (free ? 0 : doc.mana.byTier[Math.min(Math.floor(s.tier), doc.mana.byTier.length - 1)]);
    const sp = withSteps({
      key,
      name: nameOf(key, 'spell'),
      pending: pending.has(key),
      element: elIndex(doc.trees[s.tree].element, `spell ${key}`),
      damage: 0,
      cooldownMs: 0,
      windupMs: 0,
      durationMs: 0,
      radius: 0,
      range: 0,
      speed: 0,
      gravity: 0,
      hits: 1,
      spread: 1,
      spreadDeg: 0,
      cone: 0,
      line: 0,
      chain: 0,
      lifesteal: 0,
      heal: 0,
      healRadius: 0,
      absorb: 0,
      pierce: false,
      selfCast: false,
      nonBossOnly: false,
      stripShield: false,
      ...s,
      // WP15: a tree's killsDemons flag (Light) marks every spell in it.
      killsDemons: !!doc.trees[s.tree].killsDemons,
      mana,
      dash: s.dash === undefined ? 0 : dashKeys.get(s.dash) ?? fail(`spell ${key}: unknown dash ${s.dash}`),
    });
    // Default reach for aimed spells (server validates the claim against it).
    if (!sp.range) {
      if (sp.type === 'projectile' || sp.type === 'arc') sp.range = Math.max(20, sp.speed * 1.5);
      else if (sp.type === 'hitscan' || sp.type === 'direct') sp.range = 60;
      else if (sp.type === 'aoe' && !sp.selfCast && !sp.cone && !sp.line) sp.range = 20;
      else if (sp.type === 'rune') sp.range = 12;
    }
    if (sp.type === 'mobility' && !sp.dash) fail(`spell ${key}: mobility needs a dash`);
    return sp;
  });
  uniqueIds(spells, 'spell');
  const spellKeys = new Set(spells.map((s) => s.key));

  const trees = Object.entries(doc.trees).map(([key, t]) => ({
    key,
    element: elIndex(t.element, `tree ${key}`),
    killsDemons: !!t.killsDemons,
    nodes: Object.entries(t.nodes).map(([n, pre]) => {
      if (!spellKeys.has(n)) fail(`tree ${key}: unknown node ${n}`);
      for (const p of pre) if (!(p in t.nodes)) fail(`tree ${key}: ${n} requires unknown ${p}`);
      return { key: n, prereqs: pre };
    }),
  }));
  for (const s of spells) if (!trees.find((t) => t.key === s.tree)?.nodes.some((n) => n.key === s.key)) fail(`spell ${s.key} is in no tree`);

  for (const sp of doc.start.spells) if (!spellKeys.has(sp)) fail(`start: unknown spell ${sp}`);
  for (const l of doc.start.loadouts) {
    if (!weapons.some((w) => w.key === l.weapon)) fail(`start: unknown weapon ${l.weapon}`);
    if (l.spells.length !== C.MAX_EQUIPPED_SPELLS) fail(`start: a loadout has exactly ${C.MAX_EQUIPPED_SPELLS} spell slots`);
    for (const sp of l.spells) if (sp !== null && !doc.start.spells.includes(sp)) fail(`start: loadout spell ${sp} is not a start spell`);
  }

  const enemyAttacks = Object.entries(doc.enemyAttacks).map(([key, a]) => {
    const at = withSteps({ key, radius: 0, reach: 0, arc: 0, width: 0, speed: 0, minRange: 0, volley: 1, spreadDeg: 0, charge: false, everyone: false, ...a, element: elIndex(a.element, `attack ${key}`) });
    const w = stepsToMs(at.windupSteps);
    if (w < C.ENEMY_WINDUP_MIN_MS - 1e-9 || w > C.ENEMY_WINDUP_MAX_MS + 1e-9) fail(`attack ${key}: wind-up ${a.windupMs} ms outside ENEMY_WINDUP_MIN_MS..MAX_MS`);
    if (!['cone', 'circle', 'ground', 'line', 'projectile'].includes(at.shape)) fail(`attack ${key}: bad shape ${at.shape}`);
    return at;
  });
  uniqueIds(enemyAttacks, 'enemy attack');
  const attackKeys = new Set(enemyAttacks.map((a) => a.key));

  const enemyNames = doc.enemyNames ?? {};
  const enemies = Object.entries(doc.enemies).map(([key, e]) => {
    if (!(key in enemyNames)) fail(`enemy ${key} has no entry in enemyNames`);
    for (const a of e.attacks) if (!attackKeys.has(a)) fail(`enemy ${key}: unknown attack ${a}`);
    if (e.id > 255) fail(`enemy ${key}: ids 1..255 (8 bits of typeId)`);
    return { key, name: enemyNames[key], keepAway: 0, ...e, element: elIndex(e.element, `enemy ${key}`) };
  });
  uniqueIds(enemies, 'enemy');
  const enemyKeys = new Set(enemies.map((e) => e.key));

  // WP15 demons: every demon-family enemy has a rank; the spawn tables name demons only.
  const dm = doc.demons ?? { regen: {}, lesser: [], greater: {}, lord: '' };
  const ranks = ['lesser', 'greater', 'lord'];
  for (const e of enemies) {
    if (e.family !== 'demon') continue;
    if (!e.demon || !ranks.includes(e.demon.rank)) fail(`enemy ${e.key}: demons need demon.rank (lesser | greater | lord)`);
    const regen = dm.regen?.[e.demon.rank];
    if (typeof regen !== 'number') fail(`demons.regen.${e.demon.rank} missing`);
    e.demon = { regen, ...e.demon };
  }
  const isDemon = (k, rank) => enemies.some((e) => e.key === k && e.family === 'demon' && e.demon.rank === rank);
  for (const k of dm.lesser) if (!isDemon(k, 'lesser')) fail(`demons.lesser: ${k} is not a lesser demon`);
  for (const el of elements) if (!isDemon(dm.greater[el], 'greater')) fail(`demons.greater.${el}: not a greater demon`);
  if (!isDemon(dm.lord, 'lord')) fail(`demons.lord: ${dm.lord} is not a demon lord`);
  const demons = { regen: dm.regen, lesser: dm.lesser, greater: elements.map((el) => dm.greater[el]), lord: dm.lord };

  const bossTitles = doc.bosses.titles;
  const bossNames = doc.bosses.names;
  const bosses = Object.entries(doc.bosses)
    .filter(([k]) => k !== 'titles' && k !== 'names')
    .map(([key, b]) => {
      if (!enemyKeys.has(key)) fail(`boss ${key} is not an enemy`);
      let last = 2;
      const phases = b.phases.map((p) => {
        if (!(p.at < last)) fail(`boss ${key}: phases must have decreasing 'at'`);
        last = p.at;
        for (const a of p.attacks) if (!attackKeys.has(a)) fail(`boss ${key}: unknown attack ${a}`);
        return { adds: 0, speedMult: 1, cooldownMult: 1, ...p };
      });
      if (phases.length < 2 || phases.length > 3) fail(`boss ${key}: spec 8 wants 2 or 3 phases`);
      return withSteps({ key, transitionMs: b.transitionMs, arenaRadius: b.arenaRadius, phases });
    });

  const affixes = Object.entries(doc.affixes).map(([key, a]) => ({ key, hpMult: 1, damageMult: 1, speedMult: 1, cooldownMult: 1, shieldPct: 0, shieldRegenMs: 0, splitInto: 0, splitHpPct: 0, ...a, shieldRegenSteps: toSteps(a.shieldRegenMs ?? 0) }));
  uniqueIds(affixes, 'affix');

  const t = doc.tables;
  for (const list of [...Object.values(t.biome), ...Object.values(t.site), ...Object.values(t.depth).map((d) => d.extra)]) for (const k of list) if (!enemyKeys.has(k)) fail(`tables: unknown enemy ${k}`);
  for (const k of Object.values(t.element)) if (!enemyKeys.has(k)) fail(`tables: unknown enemy ${k}`);
  // Playtest 1 (CR 012): the beginner table (Haven, quiet lands) names non-demon, non-boss enemies.
  const beginner = t.beginner ?? [];
  if (!beginner.length) fail('tables.beginner: at least one enemy (CR 012)');
  for (const k of beginner) {
    const e = enemies.find((x) => x.key === k);
    if (!e) fail(`tables.beginner: unknown enemy ${k}`);
    if (e.family === 'demon' || e.family === 'boss') fail(`tables.beginner: ${k} is a ${e.family}`);
  }
  const biomes = ['meadow', 'forest', 'highlands', 'snowpeak', 'badlands', 'wetland'];
  for (const b of biomes) if (!t.biome[b]) fail(`tables.biome: missing ${b} (worldgen biome ids 0..5)`);
  const tables = {
    biome: biomes.map((b) => t.biome[b]),
    element: elements.map((e) => t.element[e]),
    site: t.site,
    depth: t.depth,
    beginner,
  };

  // Playtest 1 (CR 012): leveling and discovery-stamped difficulty.
  const lv = doc.leveling;
  if (!lv) fail('leveling: missing (CR 012)');
  const num = (v, what) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) fail(`${what}: a non-negative number`);
    return v;
  };
  const spellTierLevels = Object.entries(lv.spellTierLevels ?? {})
    .map(([tier, level]) => ({ tier: Number(tier), level: num(level, `leveling.spellTierLevels.${tier}`) }))
    .sort((a, b) => a.tier - b.tier);
  for (let i = 1; i < spellTierLevels.length; i++) if (spellTierLevels[i].level < spellTierLevels[i - 1].level) fail('leveling.spellTierLevels: levels must not decrease with the tier');
  const leveling = {
    health: { base: num(lv.health.base, 'leveling.health.base'), perLevel: num(lv.health.perLevel, 'leveling.health.perLevel') },
    damagePctPerLevel: num(lv.damagePctPerLevel, 'leveling.damagePctPerLevel'),
    stamina: { perLevel: num(lv.stamina.perLevel, 'leveling.stamina.perLevel'), max: num(lv.stamina.max, 'leveling.stamina.max') },
    skillPoints: { base: num(lv.skillPoints.base, 'leveling.skillPoints.base'), perLevel: num(lv.skillPoints.perLevel, 'leveling.skillPoints.perLevel') },
    spellTierLevels,
    attune: { stamina: num(lv.attune.stamina, 'leveling.attune.stamina'), health: num(lv.attune.health, 'leveling.attune.health'), skillPoints: num(lv.attune.skillPoints, 'leveling.attune.skillPoints'), xp: num(lv.attune.xp, 'leveling.attune.xp') },
  };
  const df = doc.difficulty;
  if (!df) fail('difficulty: missing (CR 012)');
  for (const k of ['cellM', 'havenRadiusM', 'maxStep', 'neighbourWeight', 'dangerBonus', 'maxLevel', 'stampReachM', 'demonSafeBelow', 'demonSafeMarginM']) num(df[k], `difficulty.${k}`);
  if (df.neighbourWeight > 1) fail('difficulty.neighbourWeight: 0..1');
  if (C.WORLD_SIZE_M % df.cellM !== 0) fail('difficulty.cellM must divide WORLD_SIZE_M');
  if (df.stampReachM <= C.ENEMY_SPAWN_M) fail("difficulty.stampReachM must exceed ENEMY_SPAWN_M (a group's area is stamped before it spawns)");
  const tierKeys = new Set();
  let lastMin = -1;
  const tiers = df.tiers.map((tr, i) => {
    if (tierKeys.has(tr.key)) fail(`difficulty.tiers: duplicate ${tr.key}`);
    tierKeys.add(tr.key);
    if (i === 0 && tr.key !== 'haven') fail('difficulty.tiers: the first tier is the haven');
    if (tr.minLevel <= lastMin) fail('difficulty.tiers: minLevel must increase');
    lastMin = tr.minLevel;
    for (const k of ['beginner', 'elite', 'demons', 'greater', 'demonSpeed']) num(tr[k], `difficulty.tiers.${tr.key}.${k}`);
    if (tr.beginner > 1) fail(`difficulty.tiers.${tr.key}.beginner: 0..1`);
    return { key: tr.key, name: tr.name, minLevel: tr.minLevel, beginner: tr.beginner, elite: tr.elite, demons: tr.demons, greater: tr.greater, demonSpeed: tr.demonSpeed, lords: !!tr.lords, bosses: !!tr.bosses, defense: !!tr.defense };
  });
  if (tiers.length < 2 || tiers[1].minLevel !== 1) fail('difficulty.tiers: the first non-haven tier starts at level 1');
  if (tiers[0].demons !== 0) fail('difficulty.tiers.haven: no demons in the Haven');
  const difficulty = { cellM: df.cellM, havenRadiusM: df.havenRadiusM, maxStep: df.maxStep, neighbourWeight: df.neighbourWeight, dangerBonus: df.dangerBonus, maxLevel: df.maxLevel, stampReachM: df.stampReachM, demonSafeBelow: df.demonSafeBelow, demonSafeMarginM: df.demonSafeMarginM, tiers };

  // Playtest 2 (CR 018): opt-in PvP and party duels.
  const pv = doc.pvp;
  if (!pv || !pv.duel) fail('pvp: missing (CR 018)');
  for (const k of ['damageMult', 'flagOffDelayS', 'toggleCooldownS', 'combatLockS', 'settlementMarginM']) num(pv[k], `pvp.${k}`);
  for (const k of ['challengeRangeM', 'answerS', 'countdownS', 'ringRadiusM', 'outsideForfeitS', 'maxS']) num(pv.duel[k], `pvp.duel.${k}`);
  if (pv.damageMult <= 0 || pv.damageMult > 1) fail('pvp.damageMult: 0 < m <= 1 (PvP never hits harder than PvE)');
  if (pv.duel.ringRadiusM * 2 < pv.duel.challengeRangeM) fail('pvp.duel.ringRadiusM: the ring must hold two players challengeRangeM apart');
  const pvp = {
    damageMult: pv.damageMult, flagOffDelayS: pv.flagOffDelayS, toggleCooldownS: pv.toggleCooldownS, combatLockS: pv.combatLockS, settlementMarginM: pv.settlementMarginM,
    duel: { challengeRangeM: pv.duel.challengeRangeM, answerS: pv.duel.answerS, countdownS: pv.duel.countdownS, ringRadiusM: pv.duel.ringRadiusM, outsideForfeitS: pv.duel.outsideForfeitS, maxS: pv.duel.maxS },
  };

  const pairs = {};
  for (const [a, list] of Object.entries(doc.effectiveness.pairs)) pairs[elIndex(a, 'effectiveness')] = list.map((d) => elIndex(d, 'effectiveness'));

  return {
    version: doc.version,
    stepHz: STEP_HZ,
    elements,
    effectiveness: { strong: doc.effectiveness.strong, resist: doc.effectiveness.resist, voidAll: doc.effectiveness.voidAll, pairs },
    statuses,
    skills,
    weapons,
    moves,
    forms,
    materials,
    dashes,
    mana: doc.mana,
    spells,
    trees,
    start: doc.start,
    names,
    pending: [...pending],
    enemyAttacks,
    enemies,
    bosses,
    bossTitles,
    bossNames,
    affixes,
    tables,
    demons,
    leveling,
    difficulty,
    pvp,
  };
}

export function genCombatJson(c) {
  return JSON.stringify(c, null, 1) + '\n';
}

const TS_TYPES = `
export type ElementIndex = number; // 0..7 = worldgen element ids (fire, ice, lightning, earth, wind, light, dark, void), 8 = physical

export interface StatusDef { key: string; id: number; durationMs: number; durationSteps: number; tickMs?: number; tickSteps?: number; tickDamage?: number; maxStacks?: number; speedMult?: number; damageMult?: number; breakOnDamage?: boolean }
export interface TechniqueDef { level: number; key: string; name: string; pending: boolean }
export interface SkillDef { key: string; id: number; techniques: TechniqueDef[] }
export interface MoveDef {
  key: string; id: number; weapon: string; kind: string; combo: number;
  startupMs: number; startupSteps: number; activeMs: number; activeSteps: number; recoveryMs: number; recoverySteps: number;
  damage: number; reach: number; arc: number; hits: number; speed: number; gravity: number; radius: number;
  chargeMs?: number; chargeSteps?: number; chargeMult?: number; chargeSpeed?: number; perMeter?: number; maxBonus?: number; technique?: string; cooldownMs?: number; cooldownSteps?: number;
}
export interface ArrowDef { key: string; mult: number; demonStagger: boolean; killsDemons: boolean }
export interface WeaponDef { key: string; id: number; skill: string; spellPower: number; manaRegen: number; cooldownMult: number; moves: string[]; parryMs?: number; parrySteps?: number; arrows?: ArrowDef[] }
export interface FormDef { key: string; id: number; element: ElementIndex; name: string; pending: boolean; shape: string; radius: number; reach: number; arc: number; width: number; chain: number; lifesteal: number; demonMult: number; killsDemons: boolean; dash: number; selfCast: boolean; damage: number; status?: string; cooldownMs: number; cooldownSteps: number; stamina: number }
export interface WeaponMaterialDef { key: string; id: number; mult: number; demonStagger: boolean; killsDemons: boolean }
export interface DashDef { key: string; id: number; speed: number; steps: number; iframes: number; lift: number }
export interface SpellDef {
  key: string; id: number; name: string; pending: boolean; tree: string; tier: number; type: string; element: ElementIndex;
  damage: number; cooldownMs: number; cooldownSteps: number; windupMs: number; windupSteps: number; durationMs: number; durationSteps: number;
  armMs?: number; armSteps?: number; radius: number; range: number; speed: number; gravity: number; hits: number; spread: number; spreadDeg: number;
  cone: number; line: number; chain: number; lifesteal: number; heal: number; healRadius: number; absorb: number; pierce: boolean; selfCast: boolean;
  nonBossOnly: boolean; stripShield: boolean; killsDemons: boolean; mana: number; dash: number; status?: string; requiresStatus?: string; color?: string; bossDamage?: number;
  effect?: Record<string, unknown>; vsStatus?: { status: string; mult: number }; lowTargetHp?: { below: number; mult: number }; ported?: string;
}
export interface TreeDef { key: string; element: ElementIndex; killsDemons: boolean; nodes: { key: string; prereqs: string[] }[] }
export interface EnemyAttackDef {
  key: string; id: number; shape: 'cone' | 'circle' | 'ground' | 'line' | 'projectile'; element: ElementIndex;
  windupMs: number; windupSteps: number; activeMs: number; activeSteps: number; recoveryMs: number; recoverySteps: number; cooldownMs: number; cooldownSteps: number;
  damage: number; radius: number; reach: number; arc: number; width: number; speed: number; minRange: number; volley: number; spreadDeg: number; charge: boolean; everyone: boolean;
}
export interface EnemyDef { key: string; id: number; name: string; family: string; hp: number; speed: number; aggro: number; attacks: string[]; behavior: string; keepAway: number; element: ElementIndex; xp: number; size: number; color: string; demon?: { rank: 'lesser' | 'greater' | 'lord'; regen: number } }
export interface BossPhaseDef { at: number; attacks: string[]; adds: number; speedMult: number; cooldownMult: number }
export interface BossDef { key: string; transitionMs: number; transitionSteps: number; arenaRadius: number; phases: BossPhaseDef[] }
export interface AffixDef { key: string; id: number; hpMult: number; damageMult: number; speedMult: number; cooldownMult: number; shieldPct: number; shieldRegenMs: number; shieldRegenSteps: number; splitInto: number; splitHpPct: number }
export interface CombatDefs {
  version: number; stepHz: number; elements: string[];
  effectiveness: { strong: number; resist: number; voidAll: number; pairs: Record<string, number[]> };
  statuses: StatusDef[]; skills: { xpBase: number; xpExp: number; list: SkillDef[] };
  weapons: WeaponDef[]; moves: MoveDef[]; forms: FormDef[]; materials: WeaponMaterialDef[]; dashes: DashDef[];
  mana: { base: number; perLevel: number; regenPerS: number; regenPerLevel: number; byTier: number[] };
  spells: SpellDef[]; trees: TreeDef[];
  start: { spells: string[]; loadouts: { weapon: string; spells: (string | null)[] }[]; consumable: { charges: number; heal: number } };
  names: Record<string, string>; pending: string[];
  enemyAttacks: EnemyAttackDef[]; enemies: EnemyDef[]; bosses: BossDef[]; bossTitles: Record<string, string>; bossNames: Record<string, string>;
  affixes: AffixDef[];
  tables: { biome: string[][]; element: string[]; site: Record<string, string[]>; depth: Record<string, { extra: string[]; levelBonus: number; eliteChance: number }>; beginner: string[] };
  /** WP15: night spawn tables (greater: indexed by element). */
  demons: { regen: Record<string, number>; lesser: string[]; greater: string[]; lord: string };
  /** Playtest 1 (CR 012): what a character level gives. */
  leveling: LevelingDef;
  /** Playtest 1 (CR 012): discovery-stamped area difficulty. */
  difficulty: DifficultyDef;
  /** Playtest 2 (CR 018): opt-in PvP and party duels. */
  pvp: PvpDef;
}
export interface LevelingDef {
  health: { base: number; perLevel: number }; damagePctPerLevel: number; stamina: { perLevel: number; max: number };
  skillPoints: { base: number; perLevel: number }; spellTierLevels: { tier: number; level: number }[];
  attune: { stamina: number; health: number; skillPoints: number; xp: number };
}
export interface DifficultyTierDef { key: string; name: string; minLevel: number; beginner: number; elite: number; demons: number; greater: number; demonSpeed: number; lords: boolean; bosses: boolean; defense: boolean }
export interface DifficultyDef {
  cellM: number; havenRadiusM: number; maxStep: number; neighbourWeight: number; dangerBonus: number; maxLevel: number; stampReachM: number;
  demonSafeBelow: number; demonSafeMarginM: number; tiers: DifficultyTierDef[];
}
export interface PvpDef {
  damageMult: number; flagOffDelayS: number; toggleCooldownS: number; combatLockS: number; settlementMarginM: number;
  duel: { challengeRangeM: number; answerS: number; countdownS: number; ringRadiusM: number; outsideForfeitS: number; maxS: number };
}
`;

export function genCombatTs(c) {
  return `// ${HEADER_NOTE}\n// Source: contracts/combat.yaml (normalized by contracts/codegen/lib/combat.mjs)\n/* eslint-disable */\n${TS_TYPES}\nexport const COMBAT: CombatDefs = ${JSON.stringify(c)};\n`;
}
