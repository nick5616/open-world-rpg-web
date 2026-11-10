// What a spell card shows on its face (playtest 2, Nicole: "spell cards
// instead of a dropdown ... class and type on the spell card not on hover").
// Pure: everything comes from the generated combat table, the same source the
// skill tree tooltip (../skills/tree.ts spellFacts) reads for the deep info.
// Unit-tested for every spell in combat.yaml in spellcards.test.ts.

import { COMBAT, type SpellDef } from '@lodestone/contracts';
import { cap, ELEMENT_COLOR, spellByKey, spellName } from '../skills/tree';

/** The spell's delivery (combat.yaml `type`), as a card says it. */
export const BASE_TYPE_LABEL: Record<string, string> = {
  projectile: 'Projectile',
  arc: 'Lobbed',
  hitscan: 'Ray',
  beam: 'Beam',
  aoe: 'AoE',
  domain: 'Domain',
  direct: 'Targeted',
  rune: 'Rune',
  mobility: 'Mobility',
  defensive: 'Defensive',
  passive: 'Passive',
  orbit: 'Orbit',
  summon: 'Summon',
};

/**
 * The card's headline type: the CR 020 mechanic when the spell has one
 * (a hold-to-fire stream, a seeker, a charge...), else its delivery.
 */
export function spellKind(s: SpellDef): string {
  if (s.summon || s.type === 'summon') return 'Summon';
  if (s.orbit || s.type === 'orbit') return 'Orbit';
  if (s.auto) return 'Stream';
  if (s.homing) return 'Homing';
  if (s.charge) return 'Charge';
  if (s.detonate) return s.detonate.onDeath ? 'Brand' : 'Delayed burst';
  if (s.rain) return 'Rain';
  if (s.spread > 1) return 'Volley';
  return BASE_TYPE_LABEL[s.type] ?? cap(s.type);
}

/** Short extra traits worth a chip (the tooltip spells them out). */
export function spellTraits(s: SpellDef): string[] {
  const out: string[] = [];
  const kind = spellKind(s);
  if (s.rain && kind !== 'Rain') out.push('Rain');
  if (s.spread > 1 && kind !== 'Volley') out.push('Volley');
  if (s.chain > 0) out.push('Chain');
  if (s.pierce) out.push('Pierce');
  if (s.lifesteal > 0) out.push('Lifesteal');
  if (s.heal > 0) out.push('Heal');
  if (s.absorb > 0) out.push('Shield');
  if (s.killsDemons) out.push('Kills demons');
  return out;
}

/** The headline number: damage, or what a damage-free spell does instead. */
export interface CardStat {
  label: 'Damage' | 'Heals' | 'Shield' | 'Ally hits' | 'Utility';
  value: string;
}

export function cardStat(s: SpellDef): CardStat {
  if (s.damage >= 99999) return { label: 'Damage', value: 'Kills' };
  if (s.damage > 0) {
    const n = s.hits > 1 ? s.hits : s.spread > 1 ? s.spread : 1;
    return { label: 'Damage', value: n > 1 ? `${s.damage}×${n}` : String(s.damage) };
  }
  if (s.summon) {
    const m = COMBAT.summons.find((x) => x.key === s.summon!.key);
    if (m) return { label: 'Ally hits', value: String(m.attack.damage) };
  }
  if (s.heal > 0) return { label: 'Heals', value: String(s.heal) };
  if (s.absorb > 0) return { label: 'Shield', value: String(s.absorb) };
  return { label: 'Utility', value: '—' };
}

const secs = (ms: number): string => `${Math.round(ms / 100) / 10}s`;

export interface SpellCardData {
  key: string;
  id: number;
  name: string;
  /** The school (element / tree key) and how it is written. */
  school: string;
  schoolLabel: string;
  color: string;
  tier: number;
  /** Headline type (Stream, Homing, AoE...) and the delivery when they differ ("projectile"). */
  kind: string;
  base: string;
  traits: string[];
  /** Mana per cast, or per shot for a hold-to-fire stream ("2/shot"). */
  mana: string;
  stat: CardStat;
  /** "1.5s", or "" without a cooldown. */
  cooldown: string;
  passive: boolean;
}

/** Everything a card's face shows for one spell (null for an unknown key). */
export function spellCardData(key: string): SpellCardData | null {
  const s = spellByKey.get(key);
  if (!s) return null;
  const kind = spellKind(s);
  const base = BASE_TYPE_LABEL[s.type] ?? cap(s.type);
  return {
    key,
    id: s.id,
    name: spellName(key),
    school: s.tree,
    schoolLabel: cap(s.tree),
    color: ELEMENT_COLOR[s.tree] ?? '#ffd166',
    tier: s.tier,
    kind,
    base: base === kind ? '' : base,
    traits: spellTraits(s),
    mana: s.auto ? `${s.auto.manaPerShot}/shot` : String(s.mana),
    stat: cardStat(s),
    cooldown: s.cooldownMs > 0 ? secs(s.cooldownMs) : '',
    passive: s.type === 'passive',
  };
}

/** Which loadout slots hold a spell ("loadout 1 slot 3"). */
export function slotsHolding(key: string, loadouts: readonly { spells: readonly (string | null)[] }[]): string[] {
  return loadouts.flatMap((l, li) => l.spells.map((x, si) => (x === key ? `loadout ${li + 1} slot ${si + 1}` : ''))).filter(Boolean);
}

/** Known castable spells for the card grid: school order (combat.yaml elements), then tier, then name. */
export function knownCards(known: readonly string[]): SpellCardData[] {
  const order = new Map(COMBAT.elements.map((e, i) => [e, i]));
  return known
    .map(spellCardData)
    .filter((c): c is SpellCardData => !!c && !c.passive)
    .sort((a, b) => (order.get(a.school) ?? 99) - (order.get(b.school) ?? 99) || a.tier - b.tier || a.name.localeCompare(b.name));
}

/**
 * The school glyphs (24x24 SVG paths, drawn with stroke): a flame, a
 * snowflake, a bolt, a mountain, gusts, a sun, a crescent, a ring. Paths so
 * they look the same on every machine (no emoji fonts).
 */
export const SCHOOL_ICON: Record<string, { d: string; fill?: boolean }> = {
  fire: { d: 'M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-6 0 2 1 3 2 3 0-4-1-6 1-9z', fill: true },
  ice: { d: 'M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7M9 3.5l3 2.5 3-2.5M9 20.5l3-2.5 3 2.5' },
  lightning: { d: 'M13 2L4 14h7l-1 8 9-12h-7l1-8z', fill: true },
  earth: { d: 'M2 20L9 7l4 6 3-4 6 11H2z', fill: true },
  wind: { d: 'M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8' },
  light: { d: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 1v3M12 20v3M1 12h3M20 12h3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1' },
  dark: { d: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z', fill: true },
  void: { d: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z' },
};
