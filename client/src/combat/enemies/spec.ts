// Enemy family -> model spec (pure, no three.js): which procedural rig and
// which sub-model draws an enemy, its palette (the contract colour, the
// element tint, eye colour), scale (contract size x elite), what it holds
// and how it dies. Every enemy in contracts/combat.yaml has an explicit
// style; anything new falls back by family, then by behaviour.

import { COMBAT } from '@lodestone/contracts';
import { ELEMENT_COLORS, type EnemyInfo } from '../events';

/** Rig families (models.ts builds one per style; pose.ts animates them). */
export type Rig = 'slime' | 'quadruped' | 'crawler' | 'biped' | 'floater' | 'winged';

export type Style =
  // slime
  | 'slime'
  | 'moss_slime'
  // quadruped beasts
  | 'boar'
  | 'wolf'
  | 'ram'
  | 'stalker'
  | 'lurker'
  | 'glintfox'
  | 'gloamhound'
  | 'behemoth'
  // many-legged
  | 'scuttler'
  | 'cave_crawler'
  | 'void_mite'
  // bipeds: bandits, golems, imps, demons, bosses
  | 'cutthroat'
  | 'archer'
  | 'brute'
  | 'sentinel'
  | 'mud_golem'
  | 'crystal_golem'
  | 'ember_imp'
  | 'gloamling'
  | 'cinder_fiend'
  | 'storm_ghoul'
  | 'grave_brute'
  | 'gale_reaver'
  | 'umbral_stalker'
  | 'void_maw'
  | 'sovereign'
  | 'warden'
  | 'hunt_master'
  | 'starfall_sentinel'
  | 'vault_keeper'
  // floaters
  | 'wisp'
  | 'frost_mote'
  | 'spark_wisp'
  | 'shade'
  | 'rime_wraith'
  | 'archon'
  // winged
  | 'gale_harpy'
  | 'gloom_bat'
  | 'lumen_moth'
  // CR 020 summons (allies): spectral bodies in their element colour
  | 'wraith_hound'
  | 'gale_phantom'
  | 'sunlit_sentinel';

export type Weapon = 'sword' | 'bow' | 'club' | 'cleaver' | 'hammer' | 'spear' | 'keystaff' | null;
export type DeathFx = 'splat' | 'smoke' | 'dust' | 'shatter' | 'motes';

export interface ModelSpec {
  key: string;
  /** Cache key of the built geometry (style + element: the accent is baked in). */
  variant: string;
  rig: Rig;
  style: Style;
  /** Body colour (the contract colour). */
  color: string;
  /** Element tint (ELEMENT_COLORS) or, for physical enemies, a lighter body shade. */
  accent: string;
  /** Element index 0-7, 8 physical. */
  element: number;
  eye: string;
  /** Eyes are emissive (demons, elementals, guardians, bosses, night things). */
  glowEyes: boolean;
  /** Final model scale (contract size, x1.2 for elites). */
  scale: number;
  elite: boolean;
  boss: boolean;
  weapon: Weapon;
  /** Flyers: the server places them 1.5 m above the ground; the body floats here. */
  flyer: boolean;
  deathFx: DeathFx;
  /** Death animation length (ms): the corpse lasts 1.5 s on the zone. */
  deathMs: number;
  /** A summoned ally (CR 020): translucent, glowing, in its element colour. */
  spectral: boolean;
  /** Hunched (demons): the torso leans forward at rest. */
  hunch: number;
  /** CR 029: a tamed pet wears a collar (models.ts); shiny pets a gold one. */
  collar: 0 | 1 | 2;
}

const STYLE_RIG: Record<Style, Rig> = {
  slime: 'slime',
  moss_slime: 'slime',
  boar: 'quadruped',
  wolf: 'quadruped',
  ram: 'quadruped',
  stalker: 'quadruped',
  lurker: 'quadruped',
  glintfox: 'quadruped',
  gloamhound: 'quadruped',
  behemoth: 'quadruped',
  hunt_master: 'biped',
  starfall_sentinel: 'biped',
  vault_keeper: 'biped',
  scuttler: 'crawler',
  cave_crawler: 'crawler',
  void_mite: 'crawler',
  cutthroat: 'biped',
  archer: 'biped',
  brute: 'biped',
  sentinel: 'biped',
  mud_golem: 'biped',
  crystal_golem: 'biped',
  ember_imp: 'biped',
  gloamling: 'biped',
  cinder_fiend: 'biped',
  storm_ghoul: 'biped',
  grave_brute: 'biped',
  gale_reaver: 'biped',
  umbral_stalker: 'biped',
  void_maw: 'biped',
  sovereign: 'biped',
  warden: 'biped',
  wisp: 'floater',
  frost_mote: 'floater',
  spark_wisp: 'floater',
  shade: 'floater',
  rime_wraith: 'floater',
  archon: 'floater',
  gale_harpy: 'winged',
  gloom_bat: 'winged',
  lumen_moth: 'winged',
  wraith_hound: 'quadruped',
  gale_phantom: 'biped',
  sunlit_sentinel: 'floater',
};

export const ALL_STYLES = Object.keys(STYLE_RIG) as Style[];

const KEY_STYLE: Record<string, Style> = {
  starless_sovereign: 'sovereign',
  thornhide_behemoth: 'behemoth',
};

/** Fallback by family (an enemy added to combat.yaml without a model of its own). */
const FAMILY_STYLE: Record<string, Style> = {
  slime: 'slime',
  beast: 'wolf',
  bandit: 'cutthroat',
  guardian: 'sentinel',
  elemental: 'wisp',
  cave: 'cave_crawler',
  demon: 'gloamling',
  boss: 'warden',
  critter: 'glintfox',
  hunt: 'gloamhound',
};

const WEAPON: Partial<Record<Style, Weapon>> = {
  cutthroat: 'sword',
  archer: 'bow',
  gale_phantom: 'bow',
  brute: 'club',
  warden: 'hammer',
  hunt_master: 'spear',
  vault_keeper: 'keystaff',
  sovereign: 'cleaver',
};

const DEATH: Partial<Record<Rig, DeathFx>> = { slime: 'splat', floater: 'motes' };

export function isStyle(s: string): s is Style {
  return s in STYLE_RIG;
}

/** Which style draws this enemy key / family / behaviour. */
export function styleFor(key: string, family: string, behavior: string): Style {
  if (KEY_STYLE[key]) return KEY_STYLE[key];
  if (isStyle(key)) return key;
  if (family === 'demon') return 'gloamling';
  if (behavior === 'flyer') return family === 'cave' ? 'gloom_bat' : 'wisp';
  return FAMILY_STYLE[family] ?? 'wolf';
}

export function rigFor(style: Style): Rig {
  return STYLE_RIG[style];
}

const specCache = new Map<string, ModelSpec>();

/** The model spec for an enemy (cached per key, element and affix). */
export function modelSpec(info: Pick<EnemyInfo, 'key' | 'family' | 'behavior' | 'element' | 'affix' | 'size' | 'color'>): ModelSpec {
  const ck = `${info.key}|${info.family}|${info.element}|${info.affix}`;
  const hit = specCache.get(ck);
  if (hit) return hit;
  const style = styleFor(info.key, info.family, info.behavior);
  const rig = rigFor(style);
  const el = info.element >= 0 && info.element < 8 ? info.element : 8;
  const demon = info.family === 'demon';
  const boss = info.affix === 7 || info.family === 'boss' || style === 'sovereign';
  const elite = info.affix >= 1 && info.affix <= 3;
  const accent = el < 8 ? ELEMENT_COLORS[el] : lighten(info.color);
  const glowEyes = demon || boss || style === 'gloamhound' || info.family === 'elemental' || info.family === 'guardian' || style === 'crystal_golem' || style === 'gloom_bat' || style === 'cave_crawler';
  const eye = demon ? (el < 8 ? ELEMENT_COLORS[el] : '#ff3b2a') : glowEyes ? (el < 8 ? ELEMENT_COLORS[el] : style === 'cave_crawler' ? '#c8ff6a' : '#bfe8ff') : '#1a1410';
  const deathFx: DeathFx = demon ? 'smoke' : style === 'crystal_golem' || style === 'sentinel' || style === 'mud_golem' || style === 'starfall_sentinel' || style === 'vault_keeper' ? 'shatter' : (DEATH[rig] ?? 'dust');
  const spec: ModelSpec = {
    key: info.key,
    variant: `${style}|${el}`,
    rig,
    style,
    color: info.color,
    accent,
    element: el,
    eye,
    glowEyes,
    scale: info.size * (elite ? 1.2 : 1),
    elite,
    boss,
    weapon: WEAPON[style] ?? null,
    flyer: info.behavior === 'flyer',
    deathFx,
    deathMs: rig === 'slime' ? 900 : boss ? 1450 : 1250,
    spectral: false,
    hunch: demon ? (style === 'gloamling' ? 0.45 : style === 'grave_brute' ? 0.55 : 0.35) : style === 'brute' ? 0.12 : 0,
    collar: 0,
  };
  specCache.set(ck, spec);
  return spec;
}

const SUMMON_STYLE: Record<string, Style> = {
  wraith_hound: 'wraith_hound',
  gale_phantom: 'gale_phantom',
  sunlit_sentinel: 'sunlit_sentinel',
};
const SUMMON_FAMILY_STYLE: Record<string, Style> = { beast: 'wraith_hound', humanoid: 'gale_phantom', turret: 'sunlit_sentinel' };
const summonById = new Map(COMBAT.summons.map((m) => [m.id, m]));

/**
 * An ally of a summon spell (EntityKind effect, typeId = summon id |
 * (element + 1) << 8): the summon's family rig, spectral, in its element
 * colour (the contract colour), cached per typeId.
 */
export function summonSpec(typeId: number): ModelSpec {
  const ck = `summon|${typeId}`;
  const hit = specCache.get(ck);
  if (hit) return hit;
  const def = summonById.get(typeId & 0xff);
  const el0 = ((typeId >> 8) & 0xf) - 1;
  const el = el0 >= 0 && el0 < 8 ? el0 : def && def.element >= 0 ? def.element : 8;
  const style = (def && (SUMMON_STYLE[def.key] ?? SUMMON_FAMILY_STYLE[def.family])) ?? 'gale_phantom';
  const color = def?.color ?? (el < 8 ? ELEMENT_COLORS[el] : '#b0a0ff');
  const spec: ModelSpec = {
    key: def?.key ?? 'summon',
    variant: `${style}|${el}|spectral`,
    rig: rigFor(style),
    style,
    color,
    accent: lighten(color),
    element: el,
    eye: '#ffffff',
    glowEyes: true,
    scale: def?.size ?? 1,
    elite: false,
    boss: false,
    weapon: WEAPON[style] ?? null,
    flyer: false,
    deathFx: 'motes',
    deathMs: 700,
    spectral: true,
    hunch: 0,
    collar: 0,
  };
  specCache.set(ck, spec);
  return spec;
}

// ---- CR 029: tamed pets (EntityKind effect, typeId bit 15) ----

/** A pet's typeId bit (Go: combat.PetTypeBit). */
export const PET_TYPE_BIT = 0x8000;
/** A shiny pet's typeId bit (Go: combat.PetTypeShiny). */
export const PET_TYPE_SHINY = 0x1000;

export function isPetTypeId(typeId: number): boolean {
  return (typeId & PET_TYPE_BIT) !== 0;
}

/** A pet's typeId as the zone sends it (tests, the gallery). */
export function petTypeId(enemyId: number, element = -1, shiny = false): number {
  return PET_TYPE_BIT | (enemyId & 0xff) | ((element >= 0 && element < 8 ? element + 1 : 0) << 8) | (shiny ? PET_TYPE_SHINY : 0);
}

const enemyDefById = new Map(COMBAT.enemies.map((e) => [e.id, e]));
const SHINY_BODY = '#e9c35a';

/**
 * A tamed pet: its creature's model, friendlier (a warm, lighter body, dark
 * friendly eyes, no glow), with a red collar and a gold tag; a shiny one is
 * gold-touched with a gold collar; an elemental one carries its element as
 * the accent and an aura ring.
 */
export function petSpec(typeId: number): ModelSpec {
  const ck = `pet|${typeId}`;
  const hit = specCache.get(ck);
  if (hit) return hit;
  const def = enemyDefById.get(typeId & 0xff);
  const el0 = ((typeId >> 8) & 0xf) - 1;
  const shiny = (typeId & PET_TYPE_SHINY) !== 0;
  const own = def && def.element >= 0 ? def.element : 8;
  const el = el0 >= 0 && el0 < 8 ? el0 : own;
  const key = def?.key ?? 'wolf';
  const style = styleFor(key, def?.family ?? 'beast', 'melee');
  const base = def?.color ?? '#8a7a5a';
  const color = shiny ? mixRgb(base, SHINY_BODY, 0.62) : mixRgb(base, '#fff1d6', 0.12);
  const spec: ModelSpec = {
    key,
    variant: `${style}|${el}|pet${shiny ? '|shiny' : ''}`,
    rig: rigFor(style),
    style,
    color,
    accent: el < 8 ? ELEMENT_COLORS[el] : shiny ? '#fff3b0' : lighten(color),
    element: el0 >= 0 && el0 < 8 ? el : 8, // the aura ring only for an elemental variant
    eye: '#1a1410',
    glowEyes: false,
    scale: (def?.size ?? 1) * 0.92,
    elite: false,
    boss: false,
    weapon: null,
    flyer: false,
    deathFx: 'dust',
    deathMs: 900,
    spectral: false,
    hunch: 0,
    collar: shiny ? 2 : 1,
  };
  specCache.set(ck, spec);
  return spec;
}

function mixRgb(a: string, b: string, t: number): string {
  const na = parseInt(a.slice(1), 16);
  const nb = parseInt(b.slice(1), 16);
  const ch = (s: number) => Math.round(((na >> s) & 255) * (1 - t) + ((nb >> s) & 255) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

/** Every summon in the contract (tests, the gallery): its typeId as the zone sends it. */
export function contractSummons(): { key: string; typeId: number }[] {
  return COMBAT.summons.map((m) => ({ key: m.key, typeId: m.id | ((m.element >= 0 ? m.element + 1 : 0) << 8) }));
}

/** Every enemy key in the contract (tests, the gallery). */
export function contractEnemies(): { key: string; family: string; behavior: string; element: number; size: number; color: string }[] {
  return COMBAT.enemies.map((e) => ({ key: e.key, family: e.family, behavior: e.behavior, element: e.element >= 0 ? e.element : 8, size: e.size, color: e.color }));
}

function lighten(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.min(255, Math.round(c + (255 - c) * 0.35));
  const r = f((n >> 16) & 255);
  const g = f((n >> 8) & 255);
  const b = f(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}
