// The PvP marker on player nameplates (playtest 2, CR 018): crossed swords
// drawn on the nameplate canvas (net/avatar.ts), red for a player flagged
// for PvP, gold for one in a duel. Read from the snapshot typeId bits, so it
// costs nothing on the wire beyond the toggle itself.

import { TYPE_DUELING, TYPE_PVP_FLAG } from './events';

export const SWORD_PATHS = ['M4 3 L6.2 3 L15.6 12.4 L14.2 13.8 L4 3.6 Z', 'M13.2 15.6 L17.6 11.2 L18.8 12.4 L14.4 16.8 Z', 'M16.2 15 L19.8 18.6 L18.6 19.8 L15 16.2 Z'];

/** The marker a player's typeId asks for ('' none). */
export function pvpMark(typeId: number | undefined): '' | 'pvp' | 'duel' {
  const t = typeId ?? 0;
  if (t & TYPE_DUELING) return 'duel';
  if (t & TYPE_PVP_FLAG) return 'pvp';
  return '';
}

export const MARK_COLOR = { pvp: '#ff4d4d', duel: '#ffd166' } as const;

/** Draw crossed swords centred at (cx, cy), `size` px tall. */
export function drawSwords(c: CanvasRenderingContext2D, cx: number, cy: number, size: number, color: string): void {
  if (typeof Path2D === 'undefined') return;
  const s = size / 24;
  c.save();
  c.translate(cx - size / 2, cy - size / 2);
  c.scale(s, s);
  c.fillStyle = color;
  c.strokeStyle = 'rgba(0,0,0,0.65)';
  c.lineWidth = 0.9;
  c.lineJoin = 'round';
  const one = () => {
    for (const d of SWORD_PATHS) {
      const p = new Path2D(d);
      c.fill(p);
      c.stroke(p);
    }
  };
  one();
  c.translate(24, 0);
  c.scale(-1, 1);
  one();
  c.restore();
}
