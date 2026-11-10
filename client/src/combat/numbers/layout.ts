// Damage numbers (playtest 2: "huge white blocky text"): the pure half —
// style per kind (size, colour by element, crit pop), the rise-and-fade
// curve and the screen-space stacking that keeps numbers from overlapping.
// layer.ts draws them (one instanced draw of glyph quads, constant pixel
// size, so they read the same in first and third person).

import { ELEMENT_COLORS } from '../events';
import type { DamageNumber } from '../store';

export type NumberKind = DamageNumber['kind'];

/** How long a number lives (ms). */
export const NUMBER_MS = 950;
/** Glyph height in CSS px per kind (crits pop from POP_SCALE x down to their size). */
export const NUMBER_PX: Record<NumberKind, number> = { dealt: 19, weak: 23, resist: 16, crit: 28, taken: 21, heal: 19, miss: 15 };
export const POP_SCALE = 1.75;
const POP_MS = 170;
/** Pixels risen over the life. */
const RISE_PX = 46;

/** Readable tint of an element colour (dark ones are lifted toward white). */
function readable(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const k = lum < 140 ? (140 - lum) / 200 + 0.2 : 0;
  const f = (c: number) => Math.round(c + (255 - c) * k);
  return `#${((f(r) << 16) | (f(g) << 8) | f(b)).toString(16).padStart(6, '0')}`;
}

/** The colour of a number: its element for your hits (physical white / gold crits), red for damage taken, green heals. */
export function numberColor(kind: NumberKind, element = 8): string {
  switch (kind) {
    case 'taken':
      return '#ff5a50';
    case 'heal':
      return '#6cff8a';
    case 'miss':
      return '#b4bac2';
    case 'resist':
      return element < 8 ? mix(readable(ELEMENT_COLORS[element]), '#9aa0a8', 0.55) : '#9aa0a8';
    case 'crit':
      return element < 8 ? readable(ELEMENT_COLORS[element]) : '#ffd84a';
    default:
      return element < 8 ? readable(ELEMENT_COLORS[element]) : kind === 'weak' ? '#ffb040' : '#ffffff';
  }
}

function mix(a: string, b: string, t: number): string {
  const x = parseInt(a.slice(1), 16);
  const y = parseInt(b.slice(1), 16);
  const c = (s: number) => Math.round(((x >> s) & 255) * (1 - t) + ((y >> s) & 255) * t);
  return `#${((c(16) << 16) | (c(8) << 8) | c(0)).toString(16).padStart(6, '0')}`;
}

/** The text of a number (crits get a "!", heals a "+"). */
export function numberText(kind: NumberKind, value: number): string {
  if (kind === 'miss') return value > 0 ? String(value) : 'MISS';
  const v = String(Math.max(0, Math.round(value)));
  return kind === 'crit' ? `${v}!` : kind === 'heal' ? `+${v}` : v;
}

export interface NumberMotion {
  /** Pixels above the anchor (rise). */
  rise: number;
  /** Scale on the base size (crit pop, a small pop for others). */
  scale: number;
  alpha: number;
}

/** Rise + fade (+ the crit pop) at `ageMs`. */
export function numberMotion(kind: NumberKind, ageMs: number, out: NumberMotion = { rise: 0, scale: 1, alpha: 1 }): NumberMotion {
  const t = Math.max(0, Math.min(1, ageMs / NUMBER_MS));
  out.rise = RISE_PX * (1 - Math.pow(1 - t, 2.2));
  const popK = Math.max(0, 1 - ageMs / POP_MS);
  const pop = kind === 'crit' ? POP_SCALE : kind === 'weak' ? 1.35 : 1.15;
  out.scale = 1 + (pop - 1) * popK * popK;
  out.alpha = t < 0.6 ? 1 : Math.max(0, 1 - (t - 0.6) / 0.4);
  return out;
}

/**
 * Screen-space stacking (greedy, oldest first: older numbers keep their
 * place, a newer one that would overlap moves up above it). Rects are
 * centred at (x[i], y[i]) with size (w[i], h[i]) in px, y down; writes the
 * upward shift of each into `dy` (>= 0). `order` lists indices oldest first.
 */
export function stackNumbers(n: number, order: ArrayLike<number>, x: ArrayLike<number>, y: ArrayLike<number>, w: ArrayLike<number>, h: ArrayLike<number>, dy: Float32Array | number[], gap = 2): void {
  for (let oi = 0; oi < n; oi++) {
    const i = order[oi];
    let cy = y[i];
    // move up until clear of every placed one (bounded: n passes)
    for (let pass = 0; pass < n; pass++) {
      let moved = false;
      for (let oj = 0; oj < oi; oj++) {
        const j = order[oj];
        const jy = y[j] - dy[j];
        if (Math.abs(x[i] - x[j]) * 2 < w[i] + w[j] && Math.abs(cy - jy) * 2 < h[i] + h[j] + gap * 2) {
          cy = jy - (h[i] + h[j]) / 2 - gap;
          moved = true;
        }
      }
      if (!moved) break;
    }
    dy[i] = y[i] - cy;
  }
}
