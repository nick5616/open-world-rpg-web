// Character look (pt3 title + creation, CR 047): the choices the creation
// screen offers and the avatar renders. Pure data, no three.js: the account
// service stores it as the character's `appearance` JSON object, the zone's
// armor `appearance` bits (EntityRecord.appearance) are a different thing.
//
// Every field is a small index into a table here, so a stored look from an
// older or newer client still decodes (out-of-range clamps, missing fields
// fall back to the default look).

export interface Look {
  /** 0 lean, 1 average, 2 broad: height and width of the whole figure. */
  build: number;
  skin: number;
  hairStyle: number;
  hairColor: number;
  beard: number;
  eyes: number;
}

export const BUILDS = [
  { name: 'Lean', sx: 0.93, sy: 1.03 },
  { name: 'Average', sx: 1, sy: 1 },
  { name: 'Broad', sx: 1.09, sy: 0.98 },
] as const;

export const SKIN_TONES = [0xf1d3b8, 0xe2b896, 0xc9a27e, 0xa97a55, 0x835838, 0x5c3b27] as const;
export const SKIN_NAMES = ['Fair', 'Light', 'Tan', 'Bronze', 'Brown', 'Deep'] as const;

export const HAIR_STYLES = ['Bald', 'Cropped', 'Swept', 'Long', 'Topknot', 'Mohawk'] as const;
export const HAIR_COLORS = [0x1f1915, 0x3b2a1e, 0x6b4428, 0xa8743c, 0xd4b06a, 0x8a3a1e, 0xbdb3a6, 0x3b5fa6, 0x7a4fb0, 0x2f9f6a] as const;
export const HAIR_COLOR_NAMES = ['Black', 'Brown', 'Chestnut', 'Auburn', 'Blond', 'Ginger', 'Silver', 'Sapphire', 'Amethyst', 'Emerald'] as const;

export const BEARDS = ['None', 'Stubble', 'Short', 'Full', 'Braided'] as const;

export const EYE_COLORS = [0x2a1d17, 0x4a6fa5, 0x3f8f5b, 0x7a5a2e, 0x7d8a96, 0xb0488a] as const;
export const EYE_NAMES = ['Dark', 'Blue', 'Green', 'Hazel', 'Grey', 'Violet'] as const;

/** What a character with no stored look wears (the pre-CR 047 figure: tan skin). */
export const DEFAULT_LOOK: Look = { build: 1, skin: 2, hairStyle: 2, hairColor: 1, beard: 0, eyes: 0 };

const LIMITS: Record<keyof Look, number> = {
  build: BUILDS.length,
  skin: SKIN_TONES.length,
  hairStyle: HAIR_STYLES.length,
  hairColor: HAIR_COLORS.length,
  beard: BEARDS.length,
  eyes: EYE_COLORS.length,
};

export const LOOK_KEYS = Object.keys(LIMITS) as (keyof Look)[];

/** Count of options per field (for the pickers). */
export function lookLimit(k: keyof Look): number {
  return LIMITS[k];
}

/** Any JSON (a stored appearance object, maybe `{}` or from another version) -> a valid Look. */
export function parseLook(raw: unknown): Look {
  const out = { ...DEFAULT_LOOK };
  if (!raw || typeof raw !== 'object') return out;
  const o = raw as Record<string, unknown>;
  // the stored object nests the look so other appearance data can live beside it
  const src = (typeof o.look === 'object' && o.look ? (o.look as Record<string, unknown>) : o) as Record<string, unknown>;
  for (const k of LOOK_KEYS) {
    const v = src[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.min(LIMITS[k] - 1, Math.max(0, Math.floor(v)));
  }
  return out;
}

/** True when the object carries a look (so a legacy `{}` can keep the default per-id hair). */
export function hasLook(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return typeof o.look === 'object' && o.look !== null;
}

/** The appearance JSON the account service stores. */
export function lookToAppearance(l: Look): { v: 1; look: Look } {
  return { v: 1, look: { ...l } };
}

/** A random look from any [0,1) source (tests pass a seeded one). */
export function randomLook(rand: () => number = Math.random): Look {
  const pick = (n: number) => Math.min(n - 1, Math.floor(rand() * n));
  const l = { ...DEFAULT_LOOK };
  for (const k of LOOK_KEYS) l[k] = pick(LIMITS[k]);
  // natural hair more often than the gem colours (the last three)
  if (l.hairColor >= 7 && rand() < 0.7) l.hairColor = pick(7);
  return l;
}

export function sameLook(a: Look, b: Look): boolean {
  return LOOK_KEYS.every((k) => a[k] === b[k]);
}
