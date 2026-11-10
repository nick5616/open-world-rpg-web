// Colour tokens for the character panel (C) and the spell cards, chosen so
// every text colour meets WCAG AA (4.5:1 for normal text) on the surface it
// sits on. Nicole, playtest 2: "make this screen have higher contrast ratio
// in text". Text is never dimmed with opacity any more (opacity over a
// translucent panel over the 3D world gives no guaranteed contrast); it uses
// one of these solid colours instead. theme.test.ts computes every pair.

/** Panel surface: near opaque so the world behind cannot wash the text out. */
export const PANEL_BG = 'rgba(12,14,20,0.97)';
/** A spell card's face (solid). */
export const CARD_BG = '#171b25';
/** A card that is selected or under a drag (solid, a touch lighter). */
export const CARD_BG_HOT = '#232838';
/** An empty slot's well. */
export const SLOT_BG = '#10131b';
/** Buttons on the panel (gold tinted). */
export const BTN_BG = '#2a2617';

/** Primary text. */
export const TEXT = '#f1f3f5';
/** Secondary text: labels, sub lines, hints. */
export const TEXT_2 = '#cfd5dd';
/** Tertiary text: footnotes, empty slots, locked rows. Still AA on every surface. */
export const TEXT_3 = '#a9b2bd';
/** Headings, level, points to spend. */
export const GOLD = '#ffd166';
/** Learned / in a slot. */
export const GREEN = '#8ce99a';
/** Warnings (offline, needs level). */
export const WARN = '#ffb27a';
/** Errors (locked by a prerequisite). */
export const RED = '#ff8f8f';
/** Mana numbers on a card. */
export const MANA = '#9ec5ff';

/** Borders (non-text: 3:1 is not required for decoration, but slots and cards keep a visible edge). */
export const BORDER = 'rgba(255,255,255,0.22)';
export const BORDER_GOLD = 'rgba(255,209,102,0.6)';

/** Text tokens and the surfaces each must be readable on (theme.test.ts checks every pair). */
export const TEXT_TOKENS = { TEXT, TEXT_2, TEXT_3, GOLD, GREEN, WARN, RED, MANA } as const;
export const SURFACES = { PANEL_BG, CARD_BG, CARD_BG_HOT, SLOT_BG, BTN_BG } as const;

// ---- WCAG maths (pure; used by the test and handy in the console) ----

export type RGBA = [number, number, number, number];

/** '#rgb', '#rrggbb', '#rrggbbaa' or 'rgba(r,g,b,a)' / 'rgb(r,g,b)' to [r, g, b, a] (0-255, alpha 0-1). */
export function parseColor(c: string): RGBA {
  const s = c.trim();
  if (s.startsWith('#')) {
    let h = s.slice(1);
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  const m = s.match(/^rgba?\(([^)]+)\)$/);
  if (!m) throw new Error(`unparsed colour ${c}`);
  const p = m[1].split(',').map((x) => parseFloat(x));
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}

/** Paint `top` over the opaque `under`. */
export function composite(top: RGBA, under: RGBA): RGBA {
  const a = top[3];
  return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
}

export function luminance([r, g, b]: RGBA): number {
  const lin = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of two colours (translucent ones painted over `backdrop`, default black). */
export function contrastRatio(fg: string, bg: string, backdrop: string = '#000000'): number {
  const under = parseColor(backdrop);
  const b = composite(parseColor(bg), under);
  const f = composite(parseColor(fg), b);
  const l1 = luminance(f);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
