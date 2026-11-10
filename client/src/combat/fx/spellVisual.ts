// Which look every spell gets (pure data, no three.js; fx.test.ts checks
// every spell in contracts/combat.yaml resolves). Adapted from wizard-wars
// fx/fxCore.ts (PALETTES, SPELL_PALETTE) and recipes.ts (trailStyleFor):
// Lodestone's trees are elements (fire, ice, lightning, earth, wind, light,
// dark, void), and earth carries wizard-wars' druid AND crystalmancer
// halves, so a "family" splits them again.

import { COMBAT, type SpellDef } from '@lodestone/contracts';

export interface Palette {
  /** Bright core / hottest tone. */
  hot: string;
  /** Main body colour. */
  main: string;
  /** Deeper / edge tone. */
  deep: string;
  /** Contrast accent (sparkles, glints). */
  accent: string;
  /** Normal-blended smoke / mist tone. */
  smoke: string;
}

export type Family = 'fire' | 'ice' | 'lightning' | 'nature' | 'stone' | 'crystal' | 'wind' | 'light' | 'dark' | 'blood' | 'void' | 'steel';

export const PALETTES: Record<Family | 'blackflame', Palette> = {
  fire: { hot: '#fff1c4', main: '#ff8a2a', deep: '#ff3a0a', accent: '#ffd36b', smoke: '#4a3c34' },
  ice: { hot: '#ffffff', main: '#a8e4ff', deep: '#3fa8ff', accent: '#e9fbff', smoke: '#cfeeff' },
  lightning: { hot: '#ffffff', main: '#fff3a0', deep: '#ffd23a', accent: '#cfe8ff', smoke: '#2a2a3a' },
  nature: { hot: '#f2ffc8', main: '#9be35f', deep: '#3f8f26', accent: '#ffe27a', smoke: '#2c2414' },
  stone: { hot: '#ffe6b8', main: '#c09a60', deep: '#7a5a30', accent: '#ffcf7a', smoke: '#5a4630' },
  crystal: { hot: '#ffffff', main: '#a6e4ff', deep: '#4fa4e0', accent: '#ff9be0', smoke: '#c8e8ff' },
  wind: { hot: '#ffffff', main: '#b8fff0', deep: '#5fd8c0', accent: '#e8fffa', smoke: '#d8f4ee' },
  light: { hot: '#ffffff', main: '#ffe08a', deep: '#ffb830', accent: '#fff8d8', smoke: '#fff0c8' },
  dark: { hot: '#f0c8ff', main: '#b04dff', deep: '#6a00d6', accent: '#ff5ef0', smoke: '#14051f' },
  blood: { hot: '#ffd0d6', main: '#ff2a4a', deep: '#a0001a', accent: '#ff7088', smoke: '#1c0306' },
  void: { hot: '#e6d0ff', main: '#7a2cff', deep: '#2a0066', accent: '#ff4fd8', smoke: '#07020f' },
  steel: { hot: '#ffffff', main: '#e6ecff', deep: '#9aa6c8', accent: '#fff4c8', smoke: '#6c7280' },
  blackflame: { hot: '#ff5050', main: '#ff1030', deep: '#600010', accent: '#ff8080', smoke: '#050002' },
};

/** Index order of contracts elements (ElementIndex): 8 = physical. */
export const ELEMENT_FAMILY: Family[] = ['fire', 'ice', 'lightning', 'nature', 'wind', 'light', 'dark', 'void', 'steel'];

const CRYSTAL = new Set(['crystal_shard', 'shard_burst', 'geode_bomb', 'gem_plop', 'crystal_spire', 'crystal_wall', 'petrify', 'shard_fracture', 'prism_field', 'the_monolith', 'resonance']);
const STONE = new Set(['avalanche', 'fissure', 'root_launch']);
const BLOOD = new Set(['blood_lance', 'blood_nova', 'rune_hex', 'rune_soul', 'soul_drain', 'crimson_hunger', 'death_note']);
const VOIDISH = new Set(['obliterate', 'void_bloom', 'hex_bomb', 'singularity', 'event_horizon', 'null_gaze', 'phase_slip']);

/** The visual family of a spell (its trail, impact and zone recipes). */
export function familyOf(sp: Pick<SpellDef, 'key' | 'tree'>): Family {
  if (CRYSTAL.has(sp.key)) return 'crystal';
  if (STONE.has(sp.key)) return 'stone';
  if (BLOOD.has(sp.key)) return 'blood';
  if (VOIDISH.has(sp.key)) return 'void';
  switch (sp.tree) {
    case 'fire':
      return 'fire';
    case 'ice':
      return 'ice';
    case 'lightning':
      return 'lightning';
    case 'earth':
      return 'nature';
    case 'wind':
      return 'wind';
    case 'light':
      return 'light';
    case 'dark':
      return 'dark';
    case 'void':
      return 'void';
  }
  return 'steel';
}

export type Look = 'orb' | 'needle' | 'shard' | 'void' | 'boulder' | 'seed' | 'crescent' | 'lance' | 'ball';
export type SpikeStyle = 'ice' | 'crystal' | 'bramble' | 'stone' | 'void' | 'light';

/** Ground zone shader styles (materials.ts createZoneMaterial). */
export const ZONE_STYLE: Record<Family, number> = { fire: 0, ice: 1, void: 2, dark: 2, blood: 2, steel: 3, nature: 4, stone: 4, crystal: 5, lightning: 6, wind: 7, light: 8 };

export interface SpellVisual {
  key: string;
  family: Family;
  palette: Palette;
  look: Look;
  spike: SpikeStyle;
  /** Magic-circle points (runes, windup sigils). */
  sigil: number;
  /** minor (tier <= 3), major, ultimate (tier >= 9 or a domain): how loud the set piece is. */
  weight: 'minor' | 'major' | 'ultimate';
  /** A bespoke set piece in recipes.ts (god ray from the sky, lightning strike...), else ''. */
  setPiece: string;
}

const SIGIL: Record<Family, number> = { fire: 5, ice: 6, lightning: 6, nature: 5, stone: 4, crystal: 6, wind: 3, light: 8, dark: 5, blood: 5, void: 7, steel: 4 };
const SPIKE: Record<Family, SpikeStyle> = { fire: 'stone', ice: 'ice', lightning: 'crystal', nature: 'bramble', stone: 'stone', crystal: 'crystal', wind: 'crystal', light: 'light', dark: 'void', blood: 'void', void: 'void', steel: 'stone' };

const SET_PIECES = new Set([
  'god_ray', 'divine_judgement', 'null_gaze', 'verdant_lance', 'the_monolith', 'heavens_exhale',
  'lightning_strike', 'act_of_god', 'chain_lightning', 'eruption', 'dawnbreak', 'downburst', 'collapse',
  'let_there_be_light', 'frost_nova', 'blood_nova', 'sunburst', 'thunderclap', 'null_field', 'blizzard',
  'singularity', 'cyclone', 'immolate', 'amaterasu', 'death_note', 'unwritten', 'shatter', 'unmake',
  'root_snare', 'petrify', 'halo', 'ice_wall', 'crystal_wall', 'gem_plop',
]);

function lookOf(sp: SpellDef, fam: Family): Look {
  switch (sp.key) {
    case 'ball_lightning':
      return 'ball';
    case 'avalanche':
      return 'boulder';
    case 'seed_burst':
    case 'spore_pod':
      return 'seed';
    case 'radiant_lance':
    case 'glint':
    case 'spark_jab':
      return 'lance';
  }
  if (fam === 'crystal') return 'shard';
  if (fam === 'wind') return 'crescent';
  if (fam === 'void' || (fam === 'dark' && sp.type === 'arc')) return 'void';
  if (fam === 'ice' || fam === 'blood' || sp.key === 'thorn_dart') return 'needle';
  return 'orb';
}

const cache = new Map<string, SpellVisual>();

/** The look of one spell (cached). */
export function spellVisual(sp: SpellDef): SpellVisual {
  let v = cache.get(sp.key);
  if (v) return v;
  const family = familyOf(sp);
  const weight = sp.type === 'domain' || sp.tier >= 9 ? 'ultimate' : sp.tier >= 4 ? 'major' : 'minor';
  v = {
    key: sp.key,
    family,
    palette: sp.key === 'amaterasu' ? PALETTES.blackflame : PALETTES[family],
    look: lookOf(sp, family),
    spike: SPIKE[family],
    sigil: SIGIL[family],
    weight,
    setPiece: SET_PIECES.has(sp.key) ? sp.key : sp.type === 'domain' ? 'domain' : '',
  };
  cache.set(sp.key, v);
  return v;
}

export const spellByKey = new Map(COMBAT.spells.map((s) => [s.key, s]));
export const spellById = new Map(COMBAT.spells.map((s) => [s.id, s]));
export const formById = new Map(COMBAT.forms.map((f) => [f.id, f]));
export const statusById = new Map(COMBAT.statuses.map((s) => [s.id, s]));
export const statusByKey = new Map(COMBAT.statuses.map((s) => [s.key, s.id]));
export const enemyAttackById = new Map(COMBAT.enemyAttacks.map((a) => [a.id, a]));

/** A mobility spell from its dash id (Event 214 sends dash variants as id | 0x8000). */
export function mobilitySpellForDash(dashId: number): SpellDef | undefined {
  return COMBAT.spells.find((s) => s.type === 'mobility' && s.dash === dashId);
}

/**
 * Kinds of visual a spell type produces: the audit table in the README and
 * the tests use it to prove every type has a visual. 'none' only for passives.
 */
export function visualKind(sp: Pick<SpellDef, 'type'>): 'projectile' | 'beam' | 'area' | 'rune' | 'target' | 'dash' | 'shield' | 'domain' | 'orbit' | 'summon' | 'none' {
  switch (sp.type) {
    case 'projectile':
    case 'arc':
      return 'projectile';
    case 'hitscan':
    case 'beam':
      return 'beam';
    case 'aoe':
      return 'area';
    case 'domain':
      return 'domain';
    case 'rune':
      return 'rune';
    case 'direct':
      return 'target';
    case 'mobility':
      return 'dash';
    case 'defensive':
      return 'shield';
    case 'orbit':
      return 'orbit'; // CR 020: orbs circling the caster (engine.orbit)
    case 'summon':
      return 'summon'; // CR 020: an ally (engine.summonAppear, CombatLayer draws the body)
    default:
      return 'none';
  }
}
