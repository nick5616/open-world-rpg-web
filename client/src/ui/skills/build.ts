// "Where everything you've specced has accumulated" (playtest 2): the build
// overview's pure half. It adds up what makes a character - level, crystal
// boons, gear per loadout (weapon material and item level, affixes, uniques,
// socketed gems, armor), learned passives, weapon skills and their
// techniques - into the numbers the zone uses, each with the list of where
// it comes from. Inputs are only what the client already receives: Event
// 900 (character stats), combat_sync (loadouts, known spells, skill XP,
// points) and Event 400 (the inventory). Gear mirrors the zone's
// items.Inventory.Gear (server/zone/internal/items/gear.go) and the damage
// factors mirror combat damageOf (server/zone/internal/combat/validate.go);
// skills.test.ts pins both. Pure; no React.

import { COMBAT, ITEMS, STAMINA_MAX, type ItemStat, type SpellDef } from '@lodestone/contracts';
import { skillLevel } from '../progression/gains';
import { displayName, EQ_LABEL, ELEMENT_NAMES, formatStat, itemDef, rarityColor, STAT_LABEL, type EqSlot, type WireItem } from '../inventory/items';
import { cap, ELEMENT_COLOR, passiveLines, SKILL_NAMES, spellByKey, spellName, statusLabel, TREE_ORDER, treeByKey, type EffectLine } from './tree';
import { loadoutsOpen, spellSlots } from '../../combat/hotbar';

/** Armor caps damage reduction from equipment (gear.go armorCap). */
export const ARMOR_CAP = 60;
/** Base critical chance (validate.go). */
export const BASE_CRIT_PCT = 5;
const LV = COMBAT.leveling;

const matByKey = new Map(ITEMS.materials.map((m) => [m.key, m]));
const gemByKey = new Map(ITEMS.gems.map((g) => [g.key, g]));
const cutByKey = new Map(ITEMS.cuts.map((c) => [c.key, c]));
const uniqueByKey = new Map(ITEMS.uniques.map((u) => [u.key, u]));
const affixByKey = new Map(ITEMS.affixes.map((a) => [a.key, a]));
const weaponByKey = new Map(COMBAT.weapons.map((w) => [w.key, w]));

/** One contribution to a number: where it comes from and how much. */
export interface Part {
  from: string;
  /** Additive amount (points or percentage points) or, for multipliers, the factor. */
  value: number;
  /** Shown instead of the formatted value (e.g. "x1.20 (Sunsteel, item level 11)"). */
  text?: string;
  /** In the contract but not applied by the zone yet. */
  inactive?: boolean;
}

export interface GearStat {
  stat: ItemStat;
  value: number;
  from: string;
}

/** What one loadout's equipped items add up to (gear.go Gear). */
export interface Gear {
  weapon: WireItem | null;
  weaponType: string;
  material: string;
  weaponMult: number;
  damagePct: number;
  critPct: number;
  spellPowerPct: number;
  health: number;
  armorPct: number;
  lootFindPct: number;
  staminaPct: number;
  /** Element of the first socketed elemental gem (forms), -1 none. */
  gemElement: number;
  formMult: number;
  killsDemons: boolean;
  stagger: boolean;
  /** Every stat contribution with its source, for the breakdowns. */
  parts: GearStat[];
}

/** A weapon item's damage multiplier: material x (1 + 2% per item level above the base's). */
export function weaponMult(it: WireItem): number {
  const d = itemDef(it.b);
  if (!d) return 1;
  const m = matByKey.get(d.material ?? '')?.mult ?? 1;
  return m * (1 + 0.02 * Math.max(0, it.l - d.level));
}

/** An armor piece's health: base x material x (1 + 5% per item level above the base's), rounded. */
export function armorHealth(it: WireItem): number {
  const d = itemDef(it.b);
  if (!d) return 0;
  const m = matByKey.get(d.material ?? '')?.mult ?? 1;
  return Math.round((d.health ?? 0) * m * (1 + 0.05 * Math.max(0, it.l - d.level)));
}

const at = (items: readonly WireItem[], slot: string) => items.find((x) => x.s === slot) ?? null;

/** Gear for loadout 0 or 1: its main-hand weapon plus the armor (gear.go Inventory.Gear). */
export function gearFor(items: readonly WireItem[], loadout: number): Gear {
  const g: Gear = { weapon: null, weaponType: '', material: '', weaponMult: 1, damagePct: 0, critPct: 0, spellPowerPct: 0, health: 0, armorPct: 0, lootFindPct: 0, staminaPct: 0, gemElement: -1, formMult: 1, killsDemons: false, stagger: false, parts: [] };
  const add = (stat: string, value: number, from: string) => {
    switch (stat) {
      case 'damagePct':
        g.damagePct += value;
        break;
      case 'critPct':
        g.critPct += value;
        break;
      case 'spellPowerPct':
        g.spellPowerPct += value;
        break;
      case 'health':
        g.health += value;
        break;
      case 'armorPct':
        g.armorPct += value;
        break;
      case 'lootFindPct':
        g.lootFindPct += value;
        break;
      case 'staminaPct':
        g.staminaPct += value;
        break;
      default:
        return;
    }
    g.parts.push({ stat: stat as ItemStat, value, from });
  };
  const addItem = (it: WireItem) => {
    const name = displayName(it);
    for (const a of it.a ?? []) add(a.s, a.v, `${name} · ${affixByKey.get(a.k)?.name ?? a.k}`);
    for (const u of it.u ?? []) {
      const ud = uniqueByKey.get(u);
      if (ud) for (const [k, v] of Object.entries(ud.stats)) add(k, v as number, `${name} · ${ud.name}`);
    }
  };
  const w = at(items, `eq:main${loadout}`);
  if (w) {
    const d = itemDef(w.b);
    g.weapon = w;
    g.weaponType = d?.weapon ?? '';
    g.material = d?.material ?? '';
    g.weaponMult = weaponMult(w);
    const mat = matByKey.get(g.material);
    g.killsDemons = !!mat?.killsDemons;
    g.stagger = !!mat?.demonStagger;
    addItem(w);
    for (const s of w.k ?? []) {
      const gd = itemDef(s);
      const gem = gemByKey.get(gd?.gem ?? '');
      const cut = cutByKey.get(gd?.cut ?? '');
      if (!gem || !cut) continue;
      if (gem.element >= 0 && g.gemElement < 0) {
        g.gemElement = gem.element;
        g.formMult = cut.formMult;
      }
      if (gem.stat) add(gem.stat, cut.utility, `${displayName(w)} · ${cut.name} ${gem.name}`);
    }
  }
  for (const slot of ['eq:head', 'eq:body', 'eq:legs']) {
    const a = at(items, slot);
    if (!a) continue;
    const d = itemDef(a.b);
    add('health', armorHealth(a), displayName(a));
    if (d?.armorPct) add('armorPct', d.armorPct, displayName(a));
    addItem(a);
  }
  g.armorPct = Math.min(ARMOR_CAP, g.armorPct);
  return g;
}

// ---- the overview ----

export interface BuildInput {
  level: number;
  /** Tower crystals attuned (Event 900). */
  attuned: number;
  skillFree: number;
  skillTotal: number;
  known: readonly string[];
  skillXp: Readonly<Record<string, number>>;
  loadouts: readonly { weapon: string; spells: readonly (string | null)[]; gem: number }[];
  activeLoadout: number;
  items: readonly WireItem[];
  /** The zone's own totals (Event 900), when known: shown beside mana and stamina if they disagree. Health is not compared: Event 900 is not re-sent when gear changes. */
  zone?: { manaMax: number; staminaMax: number } | null;
}

export type Unit = 'pts' | 'pct' | 'mult' | 'perS';

export interface StatLine {
  key: string;
  label: string;
  unit: Unit;
  total: number;
  parts: Part[];
  /** The zone's figure when it disagrees (stale stats, a missing source). */
  zone?: number;
  note?: string;
}

export interface SlotView {
  slot: EqSlot;
  label: string;
  item: WireItem | null;
  name: string;
  color: string;
  /** "Sunsteel · item level 11 · rare". */
  sub: string;
  lines: string[];
  sockets: { key: string; name: string; color: string; effect: string }[];
  emptySockets: number;
  killsDemons: boolean;
  stagger: boolean;
}

export interface LoadoutView {
  index: number;
  active: boolean;
  weapon: string;
  weaponName: string;
  /** No item in that hand: the WP13 training weapon. */
  training: boolean;
  main: SlotView;
  spells: { slot: number; key: string | null; name: string; tree: string }[];
  stats: StatLine[];
  form: { element: string; name: string; damage: number; unlocked: boolean; need: string } | null;
  demons: string;
}

export interface PassiveView {
  key: string;
  name: string;
  tree: string;
  lines: EffectLine[];
}

export interface BuildView {
  level: number;
  character: StatLine[];
  armor: SlotView[];
  loadouts: LoadoutView[];
  points: { total: number; free: number; spent: number; parts: Part[]; perTree: { tree: string; learned: number; total: number }[] };
  passives: PassiveView[];
  /** Statuses and elements your build brings (spells, passives, gems). */
  elemental: string[];
  skills: { key: string; level: number }[];
}

const sum = (parts: Part[]) => parts.reduce((a, p) => a + (p.inactive ? 0 : p.value), 0);
const prod = (parts: Part[]) => parts.reduce((a, p) => a * (p.inactive ? 1 : p.value), 1);
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/** Format a number for its unit ("+12", "+8.4%", "x1.32", "11.5/s"). */
export function fmt(v: number, unit: Unit, signed = false): string {
  const n = (x: number) => {
    const r = Math.round(x * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  };
  switch (unit) {
    case 'mult':
      return `x${v.toFixed(2)}`;
    case 'pct':
      return `${signed && v >= 0 ? '+' : ''}${n(v)}%`;
    case 'perS':
      return `${n(v)}/s`;
    default:
      return `${signed && v >= 0 ? '+' : ''}${n(v)}`;
  }
}

function slotView(slot: EqSlot, it: WireItem | null): SlotView {
  if (!it) return { slot, label: EQ_LABEL[slot], item: null, name: 'empty', color: '#6c757d', sub: '', lines: [], sockets: [], emptySockets: 0, killsDemons: false, stagger: false };
  const d = itemDef(it.b);
  const mat = matByKey.get(d?.material ?? '');
  const rarity = ITEMS.rarities[Math.max(0, Math.min(ITEMS.rarities.length - 1, it.r))];
  const lines: string[] = [];
  if (d?.kind === 'weapon') lines.push(`${fmt(weaponMult(it), 'mult')} weapon damage (${mat?.name ?? 'base'} x${mat?.mult ?? 1}, item level ${it.l})`);
  if (d?.kind === 'armor') lines.push(`${formatStat('health', armorHealth(it))}${d.armorPct ? `, ${formatStat('armorPct', d.armorPct)}` : ''}`);
  for (const a of it.a ?? []) lines.push(`${formatStat(a.s, a.v)} (${affixByKey.get(a.k)?.name ?? a.k})`);
  for (const u of it.u ?? []) {
    const ud = uniqueByKey.get(u);
    if (ud) lines.push(`${ud.name}: ${Object.entries(ud.stats).map(([k, v]) => formatStat(k, v as number)).join(', ')}`);
  }
  const sockets = (it.k ?? []).filter(Boolean).map((key) => {
    const gd = itemDef(key);
    const gem = gemByKey.get(gd?.gem ?? '');
    const cut = cutByKey.get(gd?.cut ?? '');
    const effect = !gem ? '' : gem.element >= 0 ? `${ELEMENT_NAMES[gem.element]} element, form x${cut?.formMult ?? 1}` : gem.stat && cut ? formatStat(gem.stat, cut.utility) : '';
    return { key, name: gd?.name ?? key, color: gem && gem.element >= 0 ? ELEMENT_HEX[gem.element] : '#e9e4f2', effect };
  });
  return {
    slot,
    label: EQ_LABEL[slot],
    item: it,
    name: displayName(it),
    color: rarityColor(it.r),
    sub: [mat?.name, `item level ${it.l}`, rarity?.name].filter(Boolean).join(' · '),
    lines,
    sockets,
    emptySockets: (it.k ?? []).filter((x) => !x).length,
    // The demon rule reads the weapon's material only (combat.yaml materials).
    killsDemons: d?.kind === 'weapon' && !!mat?.killsDemons,
    stagger: d?.kind === 'weapon' && !!mat?.demonStagger,
  };
}

/** Element colours by combat element index (gems, forms). */
export const ELEMENT_HEX = COMBAT.elements.map((e) => ELEMENT_COLOR[e] ?? '#e9e4f2');

const hasTech = (skill: string, level: number, tech: string) => !!COMBAT.skills.list.find((s) => s.key === skill)?.techniques.some((t) => t.key === tech && level >= t.level);
const techLevel = (skill: string, tech: string) => COMBAT.skills.list.find((s) => s.key === skill)?.techniques.find((t) => t.key === tech)?.level ?? 0;

/** Everything that makes up the character, with where each number comes from. */
export function buildOverview(inp: BuildInput): BuildView {
  const level = Math.max(1, inp.level);
  const lv = level - 1;
  const known = new Set(inp.known);
  const skills = Object.fromEntries(COMBAT.skills.list.map((s) => [s.key, skillLevel(inp.skillXp[s.key] ?? 0)]));
  const nLoadouts = loadoutsOpen(level); // CR 039: the third loadout from level 20
  const active = Math.max(0, Math.min(nLoadouts - 1, inp.activeLoadout));
  const gears = Array.from({ length: nLoadouts }, (_, l) => gearFor(inp.items, l));
  const g = gears[active];
  const levelDmgMult = 1 + (LV.damagePctPerLevel / 100) * lv;

  const gearParts = (gg: Gear, stat: ItemStat): Part[] => gg.parts.filter((p) => p.stat === stat).map((p) => ({ from: p.from, value: p.value }));

  // Character-wide numbers (the active loadout's gear, like the zone).
  const health: Part[] = [{ from: 'Base', value: LV.health.base }];
  if (lv) health.push({ from: `Level ${level} (+${LV.health.perLevel} per level)`, value: LV.health.perLevel * lv });
  if (inp.attuned) health.push({ from: `${inp.attuned} crystal${inp.attuned === 1 ? '' : 's'} attuned (+${LV.attune.health} each)`, value: LV.attune.health * inp.attuned });
  health.push(...gearParts(g, 'health'));

  const mana: Part[] = [{ from: 'Base', value: COMBAT.mana.base }];
  if (lv) mana.push({ from: `Level ${level} (+${COMBAT.mana.perLevel} per level)`, value: COMBAT.mana.perLevel * lv });

  const stamina: Part[] = [{ from: 'Base', value: STAMINA_MAX }];
  const stLevel = Math.min(LV.stamina.max, LV.stamina.perLevel * lv);
  if (stLevel) stamina.push({ from: `Level ${level} (+${LV.stamina.perLevel} per level, at most ${LV.stamina.max})`, value: stLevel });
  if (inp.attuned) stamina.push({ from: `${inp.attuned} crystal${inp.attuned === 1 ? '' : 's'} attuned (+${LV.attune.stamina} each)`, value: LV.attune.stamina * inp.attuned });
  const moon = gearParts(g, 'staminaPct');
  for (const m of moon) stamina.push({ ...m, text: `${fmt(m.value, 'pct', true)} (not applied yet)`, inactive: true });

  const levelDmg: Part[] = [{ from: `Level ${level} (+${LV.damagePctPerLevel}% per level, every attack, spell and form)`, value: LV.damagePctPerLevel * lv }];

  const armorParts = gearParts(g, 'armorPct');
  const armorRaw = sum(armorParts);
  const lootParts = gearParts(g, 'lootFindPct');
  const smith = skills.smithing ?? 1;

  const zone = inp.zone ?? null;
  const healthTotal = sum(health);
  const character: StatLine[] = [
    { key: 'health', label: 'Health', unit: 'pts', total: healthTotal, parts: health },
    { key: 'mana', label: 'Mana', unit: 'pts', total: sum(mana), parts: mana, zone: zone && Math.round(zone.manaMax) !== Math.round(sum(mana)) ? zone.manaMax : undefined },
    { key: 'stamina', label: 'Stamina', unit: 'pts', total: sum(stamina), parts: stamina, zone: zone && Math.round(zone.staminaMax) !== Math.round(sum(stamina)) ? zone.staminaMax : undefined },
    { key: 'damage', label: 'Damage (level)', unit: 'pct', total: sum(levelDmg), parts: levelDmg },
    { key: 'armor', label: 'Armor', unit: 'pct', total: Math.min(ARMOR_CAP, armorRaw), parts: armorParts, note: armorRaw > ARMOR_CAP ? `capped at ${ARMOR_CAP}% (gear adds ${round(armorRaw, 1)}%)` : 'less damage from enemies' },
    { key: 'loot', label: 'Loot find', unit: 'pct', total: sum(lootParts), parts: lootParts, note: `rarity luck x${round(1 + sum(lootParts) / 100)}` },
    { key: 'forge', label: 'Forge luck', unit: 'pct', total: smith, parts: [{ from: `Smithing ${smith} (+1% per level)`, value: smith }], note: 'rarer rolls on forged gear' },
  ];

  // Per loadout.
  const loadouts: LoadoutView[] = Array.from({ length: nLoadouts }, (_, l) => l).map((l) => {
    const lo = inp.loadouts[l] ?? { weapon: COMBAT.start.loadouts[l]?.weapon ?? 'sword', spells: [null, null, null, null], gem: -1 };
    const gg = gears[l];
    const wdef = weaponByKey.get(lo.weapon);
    const skillKey = wdef?.skill ?? 'swordsmanship';
    const wl = skills[skillKey] ?? 1;
    const sc = skills.spellcraft ?? 1;
    const training = !gg.weapon || gg.weaponType !== lo.weapon;

    // validate.go damageOf: skill, weapon item (material x item level), gear damage %, character level.
    const weaponHit: Part[] = [{ from: `Level ${level}`, value: levelDmgMult }, { from: `${SKILL_NAMES[skillKey] ?? cap(skillKey)} ${wl} (+1% per level)`, value: 1 + 0.01 * wl }];
    if (gg.weapon) weaponHit.push({ from: `${displayName(gg.weapon)} (${matByKey.get(gg.material)?.name ?? 'material'}, item level ${gg.weapon.l})`, value: gg.weaponMult });
    const dp = gearParts(gg, 'damagePct');
    if (dp.length) weaponHit.push({ from: `Gear damage ${fmt(sum(dp), 'pct', true)}: ${dp.map((p) => p.from).join(', ')}`, value: 1 + sum(dp) / 100 });
    const spell: Part[] = [{ from: `Level ${level}`, value: levelDmgMult }, { from: `${cap(lo.weapon)} spell power`, value: wdef?.spellPower ?? 1 }, { from: `Spellcraft ${sc} (+1% per level)`, value: 1 + 0.01 * sc }];
    if (hasTech('spellcraft', sc, 'overflow')) spell.push({ from: 'Overflow (Spellcraft technique)', value: 1.15 });
    const sp = gearParts(gg, 'spellPowerPct');
    if (sp.length) spell.push({ from: `Gear spell power ${fmt(sum(sp), 'pct', true)}: ${sp.map((p) => p.from).join(', ')}`, value: 1 + sum(sp) / 100 });

    const crit: Part[] = [{ from: 'Base', value: BASE_CRIT_PCT }];
    for (const p of gearParts(gg, 'critPct')) crit.push(p);
    if (known.has('solar_flare')) crit.push({ from: `${spellName('solar_flare')} (Fire passive)`, value: 10 });

    const regen: Part[] = [{ from: `Level ${level}`, value: COMBAT.mana.regenPerS + COMBAT.mana.regenPerLevel * lv, text: `${round(COMBAT.mana.regenPerS + COMBAT.mana.regenPerLevel * lv, 1)}/s` }];
    regen.push({ from: `${cap(lo.weapon)}`, value: wdef?.manaRegen ?? 1, text: `x${wdef?.manaRegen ?? 1}` });
    if (hasTech('spellcraft', sc, 'mana_flow')) regen.push({ from: 'Mana Flow (Spellcraft technique)', value: 1.2, text: 'x1.2' });

    const cd: Part[] = [];
    if ((wdef?.cooldownMult ?? 1) !== 1) cd.push({ from: cap(lo.weapon), value: wdef!.cooldownMult });
    if (hasTech('spellcraft', sc, 'quick_cast')) cd.push({ from: 'Quick Cast (Spellcraft technique)', value: 0.9 });

    const stats: StatLine[] = [
      { key: 'weaponHit', label: 'Weapon hits', unit: 'mult', total: prod(weaponHit), parts: weaponHit },
      { key: 'spell', label: 'Spells', unit: 'mult', total: prod(spell), parts: spell, note: 'before tree passives (below)' },
      { key: 'crit', label: 'Critical chance', unit: 'pct', total: sum(crit), parts: crit, note: 'crits deal x1.5' },
      { key: 'regen', label: 'Mana regen', unit: 'perS', total: prod(regen), parts: regen },
      { key: 'cooldown', label: 'Spell cooldowns', unit: 'mult', total: prod(cd), parts: cd },
    ];

    let form: LoadoutView['form'] = null;
    if (gg.gemElement >= 0) {
      const fd = COMBAT.forms.find((f) => f.element === gg.gemElement);
      const tech = lo.weapon === 'spear' ? 'spear_form' : 'sword_form';
      const formable = lo.weapon === 'sword' || lo.weapon === 'spear';
      const unlocked = formable && hasTech(skillKey, wl, tech);
      const dmg = (fd?.damage ?? 0) * (1 + 0.01 * wl) * gg.weaponMult * (1 + gg.damagePct / 100) * gg.formMult * levelDmgMult;
      form = {
        element: COMBAT.elements[gg.gemElement] ?? '',
        name: fd ? (COMBAT.names[`form_${fd.key}`] ?? fd.name) : '',
        damage: Math.round(dmg),
        unlocked,
        need: !formable ? 'forms need a sword or spear' : unlocked ? '' : `needs ${cap(skillKey)} ${techLevel(skillKey, tech)}`,
      };
    }
    const lightKnown = [...known].some((k) => spellByKey.get(k)?.tree === 'light' && spellByKey.get(k)?.type !== 'passive');
    const demons = gg.killsDemons ? 'Weapon kills demons (sunsteel)' : gg.stagger ? 'Weapon staggers demons (silver)' : lightKnown ? 'Only Light spells kill the strongest demons with this loadout' : `Nothing here kills level ${COMBAT.demons.ordinary.immuneFrom}+ demons: forge sunsteel or learn Light`;

    const main = slotView(`eq:main${l}` as EqSlot, gg.weapon);
    return {
      index: l,
      active: l === active,
      weapon: lo.weapon,
      weaponName: training ? `Training ${lo.weapon}` : displayName(gg.weapon!),
      training,
      main,
      spells: Array.from({ length: spellSlots(level) }, (_, i) => i).map((i) => {
        const k = lo.spells[i] ?? null;
        return { slot: i, key: k, name: k ? spellName(k) : '', tree: k ? spellByKey.get(k)?.tree ?? '' : '' };
      }),
      stats,
      form,
      demons,
    };
  });

  // Points.
  const pointParts: Part[] = [{ from: 'Base', value: LV.skillPoints.base }, { from: `Level ${level} (+${LV.skillPoints.perLevel} per level)`, value: LV.skillPoints.perLevel * level }];
  if (inp.attuned) pointParts.push({ from: `${inp.attuned} crystal${inp.attuned === 1 ? '' : 's'} attuned`, value: LV.attune.skillPoints * inp.attuned });
  const total = inp.skillTotal || sum(pointParts);
  const free = Math.max(0, inp.skillFree);
  // Known nodes per tree, the starting spells included (the same counts as the tree tabs).
  const perTree = TREE_ORDER.map((k) => treeByKey.get(k)!).map((t) => ({ tree: t.key, learned: t.nodes.filter((n) => known.has(n.key)).length, total: t.nodes.length }));

  // Passives and elemental effects.
  const passives: PassiveView[] = COMBAT.spells.filter((s) => s.type === 'passive' && known.has(s.key)).map((s) => ({ key: s.key, name: spellName(s.key), tree: s.tree, lines: passiveLines(s) }));
  const elemental = elementalLines(inp, known, gears[active]);

  return {
    level,
    character,
    armor: (['eq:head', 'eq:body', 'eq:legs'] as EqSlot[]).map((s) => slotView(s, at(inp.items, s))),
    loadouts,
    points: { total, free, spent: Math.max(0, total - free), parts: pointParts, perTree },
    passives,
    elemental,
    skills: COMBAT.skills.list.map((s) => ({ key: s.key, level: skills[s.key] ?? 1 })),
  };
}

/** What elements and statuses the build brings: slotted spells, passives, the socketed gem. */
function elementalLines(inp: BuildInput, known: Set<string>, g: Gear): string[] {
  const out: string[] = [];
  const lo = inp.loadouts[inp.activeLoadout];
  const statuses = new Map<string, string[]>();
  for (const k of lo?.spells ?? []) {
    const s = k ? spellByKey.get(k) : undefined;
    if (s?.status) statuses.set(s.status, [...(statuses.get(s.status) ?? []), spellName(s.key)]);
  }
  for (const [st, from] of statuses) out.push(`${statusLabel(st)} from ${from.join(', ')}`);
  for (const s of COMBAT.spells) {
    if (s.type !== 'passive' || !known.has(s.key) || typeof s.effect?.treeStatus !== 'string') continue;
    const ch = typeof s.effect.chance === 'number' ? `${Math.round((s.effect.chance as number) * 100)}% chance: ` : '';
    out.push(`${ch}${cap(s.tree)} spells also inflict ${statusLabel(s.effect.treeStatus)} (${spellName(s.key)})`);
  }
  if (g.gemElement >= 0) out.push(`${ELEMENT_NAMES[g.gemElement]} gem socketed: your weapon's elemental form is ${ELEMENT_NAMES[g.gemElement]}`);
  const trees = new Set((lo?.spells ?? []).filter((k): k is string => !!k).map((k) => spellByKey.get(k)?.tree ?? ''));
  if (trees.size) out.push(`Slotted elements: ${[...trees].filter(Boolean).map(cap).join(', ')}`);
  return out;
}

/** A spell's damage per hit with a loadout's build (before the enemy's element, statuses and crits), for the tooltip. */
export function spellHitWith(s: SpellDef, view: BuildView, loadout: number, known: ReadonlySet<string>): number {
  if (s.damage <= 0 || s.damage >= 99999) return 0;
  const lo = view.loadouts[loadout];
  const mult = lo?.stats.find((x) => x.key === 'spell')?.total ?? 1;
  let tree = 1;
  for (const k of known) {
    const p = spellByKey.get(k);
    const v = p?.type === 'passive' && p.tree === s.tree ? p.effect?.treeDamage : undefined;
    if (typeof v === 'number') tree *= v;
  }
  return Math.round(s.damage * mult * tree);
}

/** Tree passive multipliers you have per tree (x1.21 Fire from Kindling and ...). */
export function treeDamageMults(known: readonly string[]): { tree: string; mult: number; from: string[] }[] {
  const out = new Map<string, { mult: number; from: string[] }>();
  for (const k of known) {
    const p = spellByKey.get(k);
    const v = p?.type === 'passive' ? p.effect?.treeDamage : undefined;
    if (!p || typeof v !== 'number') continue;
    const cur = out.get(p.tree) ?? { mult: 1, from: [] };
    cur.mult *= v;
    cur.from.push(spellName(k));
    out.set(p.tree, cur);
  }
  return [...out].map(([tree, v]) => ({ tree, ...v }));
}

export { STAT_LABEL };
