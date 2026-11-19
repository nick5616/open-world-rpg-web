// Playtest 2 vibe explorer (docs/cr/036-vibe-explorer.md): the search
// filter, its wire packing (Interact 250 action 29; the zone's
// game.VibeFilter.Pack, same vector in both test suites) and the
// `/vibe find` argument parser. Pure.
//
// The two lists below are on the wire by position: the zone's
// game.VibeLandmarks / game.VibeBiomes are the same, in the same order
// (server/zone/internal/game/vibe_test.go reads this file).

export const VIBE_LANDMARKS = [
  'settlement', 'hamlet', 'village', 'town', 'tower', 'waypoint', 'cave', 'landmark', 'enemy_camp',
  'ruin', 'watchtower', 'mineshaft', 'shrine', 'bandit_camp', 'wizard_tower', 'meteor_crater', 'sunken_temple', 'demon_lair',
  'vault', 'heartfall', 'event', 'lake', 'river', 'coast', 'peak', 'forest', 'wilds',
  'standing_stones', 'great_tree', 'stone_arch', 'monolith', 'giant_bones', 'crystal_outcrop', 'statue', 'hot_spring',
  // CR 038, the vertical world.
  'tunnel', 'cavern', 'crystal_cavern', 'cenote', 'river_cavern', 'fungal_cavern', 'depths', 'depths_gate',
  'archipelago', 'sky_town', 'sky_palace', 'sky_ruin', 'sky_lift',
  // CR 043, the dwarves.
  'dwarf_camp', 'dwarf_stronghold', 'dwarf_door', 'lower_halls',
  'rift', // CR 040: an open rift portal
] as const;

/** CR 038: the layer filter's keys (game.VibeLayers); the filter sends index + 1 (0 any). */
export const VIBE_LAYERS = ['surface', 'sky', 'underground', 'depths'] as const;
export type VibeLandmark = (typeof VIBE_LANDMARKS)[number];

export const VIBE_BIOMES = ['meadow', 'forest', 'highlands', 'snowpeak', 'badlands', 'wetland'] as const;
export type VibeBiome = (typeof VIBE_BIOMES)[number];

/** combat.yaml difficulty tiers, by index (the filter sends the index). */
export const VIBE_TIERS = ['haven', 'quiet', 'wilds', 'perilous', 'dread', 'deadly'] as const;

/** Labels for the landmark picker. */
export const LANDMARK_LABEL: Record<VibeLandmark, string> = {
  settlement: 'Any settlement',
  hamlet: 'Hamlet (small)',
  village: 'Village (medium)',
  town: 'Town (walled, large)',
  tower: 'Crystal tower',
  waypoint: 'Wilderness waypoint',
  cave: 'Cave mouth',
  landmark: 'Any natural landmark',
  enemy_camp: 'Enemy camp',
  ruin: 'Ruin',
  watchtower: 'Watchtower',
  mineshaft: 'Mineshaft',
  shrine: 'Shrine',
  bandit_camp: 'Bandit camp',
  wizard_tower: 'Wizard tower',
  meteor_crater: 'Meteor crater',
  sunken_temple: 'Sunken temple',
  demon_lair: 'Demon lair',
  vault: 'Vault',
  heartfall: 'The Heartfall',
  event: 'Live world event',
  lake: 'Lake shore',
  river: 'River bank',
  coast: 'Coast',
  peak: 'Peak',
  forest: 'Deep forest (wilds)',
  wilds: 'Open wilds (one per area)',
  standing_stones: 'Standing stones',
  great_tree: 'Great tree',
  stone_arch: 'Stone arch',
  monolith: 'Monolith',
  giant_bones: 'Giant bones',
  crystal_outcrop: 'Crystal outcrop',
  statue: 'Statue',
  hot_spring: 'Hot spring',
  tunnel: 'Tunnel entrance (to the Underground)',
  cavern: 'Any cavern (Underground)',
  crystal_cavern: 'Crystal cavern',
  cenote: 'Cenote lake (skylights)',
  river_cavern: 'River cavern',
  fungal_cavern: 'Fungal cavern',
  depths: 'The Depths (hall)',
  depths_gate: 'Gate to the Depths',
  archipelago: 'Sky archipelago',
  sky_town: 'Sky town',
  sky_palace: 'Sky palace (entrance)',
  sky_ruin: 'Sky ruin',
  sky_lift: 'Sky lift (by a town)',
  dwarf_camp: 'Dwarven camp (Underground)',
  dwarf_stronghold: 'Dwarven stronghold (Underground)',
  dwarf_door: 'Dwarven door (secret or great)',
  lower_halls: 'Lower halls (the warden)',
  rift: 'An open rift (CR 040)',
};

export interface VibeFilter {
  /** -1 any, else VIBE_BIOMES index. */
  biome: number;
  /** 0 any, else VIBE_LANDMARKS index + 1. */
  landmark: number;
  /** -1 any, else the atlas region index. */
  region: number;
  /** Area level range (0 = open). Unstamped areas match on what they would be stamped at for you. */
  levelMin: number;
  levelMax: number;
  /** 0 any, 1 known (stamped, Haven, override), 2 unstamped only. */
  stamped: number;
  /** Metres from the world spawn (64 m steps; max 0 = open). */
  distMin: number;
  distMax: number;
  /** -1 any, else VIBE_TIERS index. */
  tier: number;
  /** CR 038: 0 any, else VIBE_LAYERS index + 1. */
  layer?: number;
  n: number;
  offset: number;
  go: boolean;
  random: boolean;
}

export const anyVibe = (): VibeFilter => ({ biome: -1, landmark: 0, region: -1, levelMin: 0, levelMax: 0, stamped: 0, distMin: 0, distMax: 0, tier: -1, layer: 0, n: 0, offset: 0, go: false, random: false });

const clampB = (v: number, lo: number, hi: number) => BigInt(Math.max(lo, Math.min(hi, Math.trunc(v))));
const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.trunc(v)));

/** Interact 250/29 targetId and arg (game.VibeFilter.Pack). */
export function packVibe(f: VibeFilter): { target: bigint; arg: number } {
  const target =
    clampB(f.biome + 1, 0, 15) |
    (clampB(f.landmark, 0, 63) << 4n) |
    (clampB(f.region + 1, 0, 255) << 10n) |
    (clampB(f.levelMin, 0, 255) << 18n) |
    (clampB(f.levelMax, 0, 255) << 26n) |
    (clampB(f.stamped, 0, 3) << 34n) |
    (clampB(f.distMin / 64, 0, 127) << 36n) |
    (clampB(f.distMax / 64, 0, 127) << 43n) |
    (clampB(f.tier + 1, 0, 15) << 50n) |
    (clampB(f.layer ?? 0, 0, 7) << 54n);
  const arg = (clampN(f.n, 0, 255) | (clampN(f.offset, 0, 4095) << 8) | (f.go ? 1 << 20 : 0) | (f.random ? 1 << 21 : 0)) >>> 0;
  return { target, arg };
}

export function unpackVibe(target: bigint, arg: number): VibeFilter {
  const t = (shift: bigint, mask: bigint) => Number((target >> shift) & mask);
  return {
    biome: t(0n, 0xfn) - 1,
    landmark: t(4n, 0x3fn),
    region: t(10n, 0xffn) - 1,
    levelMin: t(18n, 0xffn),
    levelMax: t(26n, 0xffn),
    stamped: t(34n, 0x3n),
    distMin: t(36n, 0x7fn) * 64,
    distMax: t(43n, 0x7fn) * 64,
    tier: t(50n, 0xfn) - 1,
    layer: t(54n, 0x7n),
    n: arg & 0xff,
    offset: (arg >>> 8) & 0xfff,
    go: ((arg >>> 20) & 1) === 1,
    random: ((arg >>> 21) & 1) === 1,
  };
}

/** A key or label prefix in a list ("snow" -> snowpeak, "camp" is ambiguous). */
function pick<T extends string>(list: readonly T[], q: string, what: string): { i: number } | { error: string } {
  const s = q.toLowerCase().replace(/[\s-]+/g, '_');
  const exact = list.indexOf(s as T);
  if (exact >= 0) return { i: exact };
  const hits = list.map((k, i) => ({ k, i })).filter((x) => x.k.startsWith(s) || x.k.includes(s));
  if (hits.length === 1) return { i: hits[0].i };
  if (hits.length > 1) return { error: `"${q}" could be ${hits.map((h) => h.k).join(', ')}` };
  return { error: `no ${what} "${q}" (${list.join(', ')})` };
}

/** "4-8", "4", "4-", "-8" -> [min, max] (0 open). */
function range(s: string): [number, number] | null {
  const m = /^(\d*)(?:-(\d*))?$/.exec(s);
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return null;
  const a = m[1] === '' ? 0 : Number(m[1]);
  const b = m[2] === undefined ? a : m[2] === '' ? 0 : Number(m[2]);
  if (b && a > b) return [b, a];
  return [a, b];
}

/**
 * `/vibe find` arguments: `biome=<b> landmark=<l> level=<a-b> region=<name|index>
 * tier=<t> stamped|unstamped dist=<a-b> [n]` (keys may be shortened to their first
 * letters: b=, l=, lv=, r=, t=, d=). Regions resolve against the names the
 * zone sent (empty: indices only).
 */
export function parseVibeFind(words: readonly string[], regions: readonly string[] = []): VibeFilter | { error: string } {
  const f = anyVibe();
  for (const w of words) {
    const lw = w.toLowerCase();
    if (/^\d+$/.test(lw)) {
      f.n = Math.min(60, Number(lw));
      continue;
    }
    if (lw === 'stamped' || lw === 'known') {
      f.stamped = 1;
      continue;
    }
    if (lw === 'unstamped' || lw === 'new') {
      f.stamped = 2;
      continue;
    }
    const eq = lw.indexOf('=');
    if (eq < 1) return { error: `don't know "${w}" (biome=, landmark=, level=, region=, tier=, dist=, stamped|unstamped, a count)` };
    const k = lw.slice(0, eq);
    const v = w.slice(eq + 1);
    if (!v) return { error: `${k}= needs a value` };
    if (['biome', 'b'].includes(k)) {
      const r = pick(VIBE_BIOMES, v, 'biome');
      if ('error' in r) return r;
      f.biome = r.i;
    } else if (['landmark', 'l', 'lm', 'near', 'what'].includes(k)) {
      const r = pick(VIBE_LANDMARKS, v, 'landmark');
      if ('error' in r) return r;
      f.landmark = r.i + 1;
    } else if (['level', 'lv', 'lvl', 'area'].includes(k)) {
      const r = range(v);
      if (!r) return { error: `level=${v}: a level or a range like 4-8` };
      [f.levelMin, f.levelMax] = r;
    } else if (['dist', 'd', 'distance'].includes(k)) {
      const r = range(v);
      if (!r) return { error: `dist=${v}: metres from the spawn, like 500-1500` };
      [f.distMin, f.distMax] = r;
    } else if (['tier', 't'].includes(k)) {
      const r = pick(VIBE_TIERS, v, 'tier');
      if ('error' in r) return r;
      f.tier = r.i;
    } else if (['layer', 'lay', 'y'].includes(k)) {
      const r = pick(VIBE_LAYERS, v, 'layer');
      if ('error' in r) return r;
      f.layer = r.i + 1;
    } else if (['region', 'r'].includes(k)) {
      if (/^\d+$/.test(v)) f.region = Number(v);
      else {
        const s = v.toLowerCase();
        const hits = regions.map((n, i) => ({ n: n.toLowerCase(), i })).filter((x) => x.n.includes(s));
        if (hits.length !== 1) return { error: regions.length === 0 ? `region=${v}: open the Vibe tab once (it loads the region names) or give the index` : hits.length ? `region "${v}" could be ${hits.map((h) => regions[h.i]).join(', ')}` : `no region "${v}"` };
        f.region = hits[0].i;
      }
    } else return { error: `don't know ${k}= (biome, landmark, level, region, tier, layer, dist)` };
  }
  return f;
}

/** One line describing a filter ("forest, shrine, level 4-8"). */
export function describeVibe(f: VibeFilter, regions: readonly string[] = []): string {
  const parts: string[] = [];
  if (f.biome >= 0) parts.push(VIBE_BIOMES[f.biome]);
  if (f.landmark > 0) parts.push(VIBE_LANDMARKS[f.landmark - 1].replace(/_/g, ' '));
  if (f.region >= 0) parts.push(`in ${regions[f.region] ?? `region ${f.region}`}`);
  if (f.levelMin || f.levelMax) parts.push(`level ${f.levelMin || 1}${f.levelMax !== f.levelMin ? `-${f.levelMax || '∞'}` : ''}`);
  if (f.tier >= 0) parts.push(VIBE_TIERS[f.tier]);
  if (f.layer) parts.push(VIBE_LAYERS[f.layer - 1]);
  if (f.stamped) parts.push(f.stamped === 1 ? 'stamped' : 'unstamped');
  if (f.distMin || f.distMax) parts.push(`${f.distMin}-${f.distMax || '∞'} m out`);
  return parts.length ? parts.join(', ') : 'anywhere';
}
