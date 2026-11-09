// What a character level gives and what the next ones unlock (playtest 1,
// CR 012). Pure: everything comes from combat.yaml's `leveling` table (the
// same numbers the zone applies), so the panel and the level-up fanfare
// can never promise something the server doesn't do.

import { COMBAT, STAMINA_MAX } from '@lodestone/contracts';

const LV = COMBAT.leveling;

export interface LevelStats {
  health: number;
  mana: number;
  stamina: number;
  damagePct: number;
  skillPoints: number;
}

/** Stats a character has at `level` with `attuned` tower crystals (before gear). */
export function statsAt(level: number, attuned = 0): LevelStats {
  const l = Math.max(0, level - 1);
  return {
    health: LV.health.base + LV.health.perLevel * l + LV.attune.health * attuned,
    mana: Math.round(COMBAT.mana.base + COMBAT.mana.perLevel * l),
    stamina: STAMINA_MAX + Math.min(LV.stamina.max, LV.stamina.perLevel * l) + LV.attune.stamina * attuned,
    damagePct: LV.damagePctPerLevel * l,
    skillPoints: LV.skillPoints.base + LV.skillPoints.perLevel * Math.max(1, level) + LV.attune.skillPoints * attuned,
  };
}

/** The character level a spell tree tier needs for skill-point learning. */
export function tierLevel(tier: number): number {
  let lvl = 1;
  for (const t of LV.spellTierLevels) if (tier >= t.tier) lvl = t.level;
  return lvl;
}

const tierRange = (i: number): string => {
  const t = LV.spellTierLevels[i];
  const next = LV.spellTierLevels[i + 1];
  return next ? `tier ${t.tier}-${next.tier - 1}` : `tier ${t.tier}+`;
};

const DOMAIN_TIER = 10;

/** Unlocks that arrive exactly at `level` (spell tree tiers). */
export function unlocksAt(level: number): string[] {
  const out: string[] = [];
  LV.spellTierLevels.forEach((t, i) => {
    if (t.level !== level) return;
    out.push(t.tier >= DOMAIN_TIER && t.tier < 12 ? `Spell trees ${tierRange(i)}: domain expansions` : t.tier >= 12 ? `Spell trees ${tierRange(i)}: pinnacle spells` : `Spell trees ${tierRange(i)}`);
  });
  return out;
}

/** Human lines for going from level `from` to `to` (the fanfare). */
export function gainLines(from: number, to: number): string[] {
  if (to <= from) return [];
  const a = statsAt(from);
  const b = statsAt(to);
  const out = [`+${b.health - a.health} health`];
  if (b.stamina > a.stamina) out.push(`+${b.stamina - a.stamina} stamina`);
  out.push(`+${b.damagePct - a.damagePct}% damage`);
  if (b.mana > a.mana) out.push(`+${b.mana - a.mana} mana`);
  const sp = b.skillPoints - a.skillPoints;
  if (sp > 0) out.push(`+${sp} skill point${sp === 1 ? '' : 's'}`);
  for (let l = from + 1; l <= to; l++) for (const u of unlocksAt(l)) out.push(`Unlocked: ${u}`);
  return out;
}

export interface UpcomingLevel {
  level: number;
  lines: string[];
}

/** The next `n` levels after `level`: what each gives and unlocks. */
export function upcoming(level: number, n = 4): UpcomingLevel[] {
  const out: UpcomingLevel[] = [];
  for (let l = level + 1; l <= level + n; l++) out.push({ level: l, lines: gainLines(l - 1, l) });
  // The next tier unlock beyond the window, so a goal is always visible.
  const next = LV.spellTierLevels.find((t) => t.level > level + n);
  if (next) out.push({ level: next.level, lines: unlocksAt(next.level).map((u) => `Unlocked: ${u}`) });
  return out;
}

/** Skill level for cumulative skill XP (combatdefs SkillLevel). */
export function skillLevel(xp: number): number {
  const need = (n: number) => (n <= 1 ? 0 : Math.round(COMBAT.skills.xpBase * Math.pow(n - 1, COMBAT.skills.xpExp)));
  let lv = 1;
  while (lv < 100 && xp >= need(lv + 1)) lv++;
  return lv;
}

/** A weapon skill's next technique (null when all are learned). */
export function nextTechnique(skill: string, level: number): { level: number; name: string } | null {
  const s = COMBAT.skills.list.find((x) => x.key === skill);
  const t = s?.techniques.find((x) => x.level > level);
  return t ? { level: t.level, name: t.name } : null;
}

export interface LearnableSpell {
  key: string;
  id: number;
  name: string;
  tree: string;
  tier: number;
  needsLevel: number;
  /** Prereqs met and the tier is open: a skill point learns it. */
  ready: boolean;
  passive: boolean;
}

/** Tree nodes you could learn next (prereqs met), ready or level-locked. */
export function learnable(known: readonly string[], level: number): LearnableSpell[] {
  const k = new Set(known);
  const out: LearnableSpell[] = [];
  for (const tree of COMBAT.trees) {
    for (const node of tree.nodes) {
      if (k.has(node.key)) continue;
      if (node.prereqs.length && !node.prereqs.some((p) => k.has(p))) continue;
      const sp = COMBAT.spells.find((s) => s.key === node.key);
      if (!sp) continue;
      const needsLevel = tierLevel(sp.tier);
      out.push({ key: sp.key, id: sp.id, name: sp.name, tree: tree.key, tier: sp.tier, needsLevel, ready: level >= needsLevel, passive: sp.type === 'passive' });
    }
  }
  return out.sort((a, b) => Number(b.ready) - Number(a.ready) || a.tier - b.tier || a.tree.localeCompare(b.tree));
}

/** Total XP that reaches `level` (WP12 curve 60 + 40 x level). */
export function xpForLevel(level: number): number {
  let xp = 0;
  for (let l = 1; l < level; l++) xp += 60 + 40 * l;
  return xp;
}
