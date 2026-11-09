// The skill tree screen's pure half (playtest 2): how a spell tree is laid
// out (columns by tier, lanes chosen so prerequisite edges run as straight
// as possible), what state each node is in for a character, and the facts a
// node's tooltip shows. Everything comes from the generated combat table
// (contracts/combat.yaml -> COMBAT), so the screen can never promise
// something the zone does not do. Unit-tested in skills.test.ts.

import { COMBAT, type SpellDef, type TreeDef } from '@lodestone/contracts';
import { tierLevel } from '../progression/gains';

export const spellByKey = new Map<string, SpellDef>(COMBAT.spells.map((s) => [s.key, s]));
export const treeByKey = new Map<string, TreeDef>(COMBAT.trees.map((t) => [t.key, t]));

/** Tree tab order: the elements' order in combat.yaml. */
export const TREE_ORDER: readonly string[] = COMBAT.elements.filter((e) => treeByKey.has(e));

/** Element display colours (tabs, node rims, edges). Readable on the dark panel. */
export const ELEMENT_COLOR: Record<string, string> = {
  fire: '#ff7a3d',
  ice: '#7cc8ff',
  lightning: '#ffe066',
  earth: '#7cc35a',
  wind: '#8fe8d2',
  light: '#fff0b3',
  dark: '#e0607e',
  void: '#a98bff',
};

export const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The player-facing name (combat.yaml `names`, the one name table). */
export function spellName(key: string): string {
  return COMBAT.names[key] ?? spellByKey.get(key)?.name ?? key;
}

/** Is this name still a proposal (combat.yaml `pending`)? */
export function namePending(key: string): boolean {
  return COMBAT.pending.includes(key) || !!spellByKey.get(key)?.pending;
}

// ---- layout ----

export interface LayoutNode {
  key: string;
  tier: number;
  /** Column index (the tree's distinct tiers, ascending). */
  col: number;
  /** Row within the graph, 0..lanes-1. */
  lane: number;
  prereqs: string[];
}

export interface LayoutEdge {
  from: string;
  to: string;
  /** Prerequisite in the same tier (drawn as a short bend inside the column). */
  sameCol: boolean;
}

export interface TreeLayout {
  tree: string;
  /** One column per distinct tier: the tier and the character level skill points need for it. */
  cols: { tier: number; level: number }[];
  lanes: number;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
}

/** Integer lanes for one column: as close to `want` as possible, in that order, no two equal, within 0..lanes-1. */
function placeColumn(keys: string[], want: Map<string, number>, lanes: number, order: Map<string, number>): Map<string, number> {
  const sorted = [...keys].sort((a, b) => want.get(a)! - want.get(b)! || order.get(a)! - order.get(b)!);
  const n = sorted.length;
  const out: number[] = sorted.map((k) => Math.round(want.get(k)!));
  for (let i = 0; i < n; i++) out[i] = Math.max(out[i], i === 0 ? 0 : out[i - 1] + 1);
  for (let i = n - 1; i >= 0; i--) out[i] = Math.min(out[i], i === n - 1 ? lanes - 1 : out[i + 1] - 1);
  for (let i = 0; i < n; i++) out[i] = Math.max(out[i], i === 0 ? 0 : out[i - 1] + 1);
  return new Map(sorted.map((k, i) => [k, out[i]]));
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Lay a tree out: x = tier column, y = lane. A few barycentre sweeps
 * (Sugiyama style: each node pulled toward its prerequisites going right,
 * toward what it unlocks going left) keep chains straight and branches
 * apart. Deterministic: the same tree always gives the same picture.
 */
export function layoutTree(tree: TreeDef): TreeLayout {
  const tierOf = (k: string) => spellByKey.get(k)?.tier ?? 1;
  const tiers = [...new Set(tree.nodes.map((n) => tierOf(n.key)))].sort((a, b) => a - b);
  const colOf = new Map(tree.nodes.map((n) => [n.key, tiers.indexOf(tierOf(n.key))]));
  const order = new Map(tree.nodes.map((n, i) => [n.key, i]));
  const columns: string[][] = tiers.map(() => []);
  for (const n of tree.nodes) columns[colOf.get(n.key)!].push(n.key);
  const lanes = Math.max(...columns.map((c) => c.length));
  const parents = new Map(tree.nodes.map((n) => [n.key, n.prereqs.filter((p) => colOf.has(p))]));
  const children = new Map<string, string[]>(tree.nodes.map((n) => [n.key, []]));
  for (const n of tree.nodes) for (const p of parents.get(n.key)!) children.get(p)!.push(n.key);

  const lane = new Map<string, number>();
  // Start: each column spread evenly over the lanes, in contract order.
  for (const col of columns) col.forEach((k, i) => lane.set(k, col.length === 1 ? (lanes - 1) / 2 : (i * (lanes - 1)) / (col.length - 1)));
  const sweep = (c: number, near: (k: string) => string[]) => {
    const want = new Map<string, number>();
    for (const k of columns[c]) {
      const ns = near(k);
      want.set(k, ns.length ? mean(ns.map((x) => lane.get(x)!)) : lane.get(k)!);
    }
    for (const [k, v] of placeColumn(columns[c], want, lanes, order)) lane.set(k, v);
  };
  for (let iter = 0; iter < 6; iter++) {
    for (let c = 0; c < columns.length; c++) sweep(c, (k) => parents.get(k)!);
    for (let c = columns.length - 1; c >= 0; c--) sweep(c, (k) => [...children.get(k)!, ...parents.get(k)!]);
  }
  for (let c = 0; c < columns.length; c++) sweep(c, (k) => (parents.get(k)!.length ? parents.get(k)! : children.get(k)!));

  return {
    tree: tree.key,
    cols: tiers.map((t) => ({ tier: t, level: tierLevel(t) })),
    lanes,
    nodes: tree.nodes.map((n) => ({ key: n.key, tier: tierOf(n.key), col: colOf.get(n.key)!, lane: lane.get(n.key)!, prereqs: [...n.prereqs] })),
    edges: tree.nodes.flatMap((n) => parents.get(n.key)!.map((p) => ({ from: p, to: n.key, sameCol: colOf.get(p) === colOf.get(n.key) }))),
  };
}

// ---- node state ----

export type NodeStatus = 'learned' | 'learnable' | 'noPoints' | 'needsLevel' | 'needsPrereq';

export interface NodeState {
  status: NodeStatus;
  /** Character level a skill point needs for this node's tier. */
  needsLevel: number;
  /** The prerequisites (any one of them unlocks it; empty for a root). */
  prereqs: string[];
  /** A prerequisite is learned (or there are none). */
  prereqMet: boolean;
  levelMet: boolean;
}

/** Where a node stands for a character: learned, learnable now, or what it still needs. Mirrors the zone's Profile.LearnWith. */
export function nodeState(treeKey: string, key: string, known: ReadonlySet<string>, level: number, freePoints: number): NodeState {
  const node = treeByKey.get(treeKey)?.nodes.find((n) => n.key === key);
  const prereqs = node?.prereqs ?? [];
  const needsLevel = tierLevel(spellByKey.get(key)?.tier ?? 1);
  const prereqMet = prereqs.length === 0 || prereqs.some((p) => known.has(p));
  const levelMet = level >= needsLevel;
  let status: NodeStatus;
  if (known.has(key)) status = 'learned';
  else if (!prereqMet) status = 'needsPrereq';
  else if (!levelMet) status = 'needsLevel';
  else status = freePoints > 0 ? 'learnable' : 'noPoints';
  return { status, needsLevel, prereqs, prereqMet, levelMet };
}

/** One line saying what a node still needs ("" when learned). */
export function needLine(st: NodeState): string {
  switch (st.status) {
    case 'learned':
      return '';
    case 'learnable':
      return 'Learnable now: 1 skill point';
    case 'noPoints':
      return 'Needs a free skill point (level up or attune a crystal)';
    case 'needsLevel':
      return `Needs character level ${st.needsLevel}`;
    case 'needsPrereq': {
      const names = st.prereqs.map(spellName);
      const pre = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names[0];
      return `Needs ${pre} first${st.levelMet ? '' : ` · level ${st.needsLevel}`}`;
    }
  }
}

/** Learned nodes per tree, not counting the starting spells (what skill points or tomes bought). */
export function learnedCounts(known: readonly string[]): Record<string, { learned: number; total: number }> {
  const k = new Set(known);
  const out: Record<string, { learned: number; total: number }> = {};
  for (const t of COMBAT.trees) out[t.key] = { learned: t.nodes.filter((n) => k.has(n.key)).length, total: t.nodes.length };
  return out;
}

/** Can this spell sit in a loadout slot (passives work on their own)? */
export const castable = (key: string): boolean => {
  const s = spellByKey.get(key);
  return !!s && s.type !== 'passive';
};

// ---- tooltip facts ----

const TYPE_LABEL: Record<string, string> = {
  projectile: 'Projectile',
  arc: 'Lobbed',
  hitscan: 'Instant ray',
  beam: 'Beam',
  aoe: 'Area',
  domain: 'Domain expansion',
  direct: 'Targeted',
  rune: 'Rune (trap)',
  mobility: 'Mobility (dash)',
  defensive: 'Defensive',
  passive: 'Passive',
};

const STATUS_LABEL: Record<string, string> = {
  burn: 'Burn',
  slow: 'Slow',
  freeze: 'Freeze',
  stun: 'Stun',
  petrify: 'Petrify',
  airborne: 'Airborne',
  curse: 'Curse',
  shock: 'Shock',
  pull: 'Pull',
  knockback: 'Knockback',
  taunt: 'Taunt',
  black_flame: 'Black flame',
};

export const statusLabel = (s: string): string => STATUS_LABEL[s] ?? cap(s.replace(/_/g, ' '));

const sec = (ms: number): string => `${Math.round(ms / 100) / 10} s`;
const pct = (mult: number): string => `${Math.round((mult - 1) * 100)}%`;

/** Passive effects the zone applies (combat validate.go passiveMult / statusOf, solar_flare's crit). The rest are data only for now (docs/STATUS.md WP13). */
const APPLIED_EFFECTS = new Set(['treeDamage', 'treeStatus', 'lowHpDamage', 'vsStatus', 'lowTargetHp', 'vsElement', 'critChance']);

export interface EffectLine {
  text: string;
  /** False: the effect is in the contract but the zone does not apply it yet. */
  active: boolean;
}

/** What a passive does, in words ("+10% Fire spell damage"). */
export function passiveLines(s: SpellDef): EffectLine[] {
  const e = s.effect ?? {};
  const tree = cap(s.tree);
  const out: EffectLine[] = [];
  for (const [k, raw] of Object.entries(e)) {
    const v = raw as never;
    let text = '';
    switch (k) {
      case 'treeDamage':
        text = `+${pct(v)} ${tree} spell damage`;
        break;
      case 'treeStatus': {
        const ch = typeof e.chance === 'number' ? `${Math.round((e.chance as number) * 100)}% chance: ` : '';
        text = `${ch}${tree} spells also inflict ${statusLabel(v)}`;
        break;
      }
      case 'chance':
        continue;
      case 'lowHpDamage':
        text = `+${pct(v)} ${tree} spell damage while you are below half health`;
        break;
      case 'critChance':
        text = `+${Math.round((v as number) * 100)}% critical chance (all attacks)`;
        break;
      case 'vsStatus': {
        const o = v as { status: string; mult: number };
        text = `+${pct(o.mult)} ${tree} spell damage against ${statusLabel(o.status).toLowerCase()} enemies`;
        break;
      }
      case 'lowTargetHp': {
        const o = v as { below: number; mult: number };
        text = `+${pct(o.mult)} ${tree} spell damage against enemies under ${Math.round(o.below * 100)}% health`;
        break;
      }
      case 'vsElement': {
        const o = v as { element: string; mult: number };
        text = `+${pct(o.mult)} ${tree} spell damage against ${o.element} enemies`;
        break;
      }
      case 'damageTaken':
        text = `-${Math.round((1 - (v as number)) * 100)}% damage taken`;
        break;
      case 'killHeal':
        text = `Heal ${v} on a kill`;
        break;
      case 'killShield':
        text = `A ${v} point shield on a kill`;
        break;
      case 'cheatDeath':
        text = `${Math.round((v as number) * 100)}% chance to survive a killing blow`;
        break;
      default:
        text = `${k}: ${JSON.stringify(v)}`;
    }
    out.push({ text, active: APPLIED_EFFECTS.has(k) });
  }
  return out;
}

export interface Fact {
  label: string;
  value: string;
  accent?: boolean;
}

/** The numbers a node's tooltip lists (damage, cooldown, mana, type, status, kills demons...). */
export function spellFacts(s: SpellDef): Fact[] {
  const out: Fact[] = [{ label: 'Type', value: TYPE_LABEL[s.type] ?? cap(s.type) }];
  const tree = treeByKey.get(s.tree);
  if (s.type !== 'passive') {
    if (s.damage >= 99999) out.push({ label: 'Damage', value: s.bossDamage ? `kills outright (bosses take ${s.bossDamage})` : 'kills outright' });
    else if (s.damage > 0) out.push({ label: 'Damage', value: s.hits > 1 ? `${s.damage} x up to ${s.hits} hits` : String(s.damage) });
    if (s.cooldownMs > 0) out.push({ label: 'Cooldown', value: sec(s.cooldownMs) });
    out.push({ label: 'Mana', value: s.mana > 0 ? String(s.mana) : 'none' });
    if (s.windupMs > 0) out.push({ label: 'Wind-up', value: sec(s.windupMs) });
    if (s.durationMs > 0 && s.type !== 'mobility') out.push({ label: s.type === 'rune' ? 'Lasts (armed)' : 'Duration', value: sec(s.durationMs) });
    if (s.range > 0) out.push({ label: 'Range', value: `${s.range} m` });
    else if (s.type === 'projectile' || s.type === 'arc') out.push({ label: 'Speed', value: `${s.speed} m/s` });
    if (s.radius > 0 && s.type !== 'projectile') out.push({ label: s.cone ? 'Cone' : s.line ? 'Line' : 'Radius', value: s.cone ? `${s.radius} m, ${s.cone} deg` : s.line ? `${s.line} m long` : `${s.radius} m` });
    if (s.chain > 0) out.push({ label: 'Chains', value: `to ${s.chain} more` });
    if (s.pierce) out.push({ label: 'Pierces', value: 'yes' });
    if (s.lifesteal > 0) out.push({ label: 'Lifesteal', value: `${Math.round(s.lifesteal * 100)}%` });
    if (s.heal > 0) out.push({ label: 'Heals', value: s.healRadius ? `${s.heal} (allies within ${s.healRadius} m)` : String(s.heal) });
    if (s.absorb > 0) out.push({ label: 'Shield', value: `${s.absorb} points` });
    if (s.type === 'mobility') {
      const d = COMBAT.dashes.find((x) => x.key === s.key || x.id === s.dash);
      if (d) out.push({ label: 'Dash', value: `${d.lift ? `${d.lift} m/s upward` : `${d.speed} m/s`} · ${Math.round((d.iframes * 1000) / COMBAT.stepHz)} ms untouchable` });
    }
  }
  if (s.status) out.push({ label: 'Status', value: statusLabel(s.status), accent: true });
  if (s.requiresStatus) out.push({ label: 'Needs', value: `a ${statusLabel(s.requiresStatus).toLowerCase()} target` });
  if (s.vsStatus) out.push({ label: 'Bonus', value: `x${s.vsStatus.mult} against ${statusLabel(s.vsStatus.status).toLowerCase()}` });
  if (s.lowTargetHp) out.push({ label: 'Bonus', value: `x${s.lowTargetHp.mult} under ${Math.round(s.lowTargetHp.below * 100)}% health` });
  if (s.nonBossOnly) out.push({ label: 'Note', value: 'non-boss enemies only' });
  if (s.stripShield) out.push({ label: 'Note', value: 'strips shields' });
  if (s.killsDemons || tree?.killsDemons) out.push({ label: 'Demons', value: 'kills demons (Light)', accent: true });
  return out;
}

// ---- weapon skills and techniques ----

/** What each technique does, and whether the zone applies it yet (docs/STATUS.md WP13 "data only"). */
export const TECHNIQUE_INFO: Record<string, { text: string; active: boolean }> = {
  parry_riposte: { text: 'A parry opens a riposte: a 45-damage counter-cut', active: true },
  dash_cut: { text: 'Sprint attacks deal x1.5 damage', active: true },
  sword_form: { text: 'Q: the elemental form of the gem socketed in your sword', active: true },
  whirlwind: { text: 'Heavy attack: a 360 deg whirling cut', active: true },
  sweep: { text: 'A wide sweeping strike', active: false },
  pole_vault: { text: 'Vault over obstacles with the spear', active: false },
  spear_form: { text: 'Q: the elemental form of the gem socketed in your spear', active: true },
  impale: { text: 'A pinning thrust', active: false },
  quick_draw: { text: 'Draw the bow faster', active: false },
  double_shot: { text: 'Loose two arrows at once', active: false },
  charged_pierce: { text: 'Fully drawn arrows pierce', active: false },
  arrow_rain: { text: 'Heavy attack: four arrows rain on an area (8 s cooldown)', active: true },
  mana_flow: { text: '+20% mana regeneration', active: true },
  quick_cast: { text: '-10% spell cooldowns', active: true },
  overflow: { text: '+15% spell damage', active: true },
  twin_cast: { text: 'Cast a second copy of a spell', active: false },
};

export const SKILL_NAMES: Record<string, string> = { swordsmanship: 'Swordsmanship', spearmanship: 'Spearmanship', archery: 'Archery', spellcraft: 'Spellcraft', mining: 'Mining', smithing: 'Smithing' };

/** What a skill's level itself gives (besides techniques). */
export const SKILL_EFFECT: Record<string, string> = {
  swordsmanship: '+1% sword damage per level',
  spearmanship: '+1% spear damage per level',
  archery: '+1% bow damage per level',
  spellcraft: '+1% spell damage per level',
  mining: 'Grows as you mine ore and gems',
  smithing: '+1% forge luck per level (rarer forged gear)',
};
