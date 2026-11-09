// Spell selection (playtest 1): the mouse wheel cycles what the right mouse
// button does: the weapon's secondary action (-1: sword parry, bow draw,
// spear charge, staff/wand heavy; the WP13 default) or one of the four
// spell slots (0-3, empty slots skipped). Number keys still cast directly
// (and select their slot). Hold Z for the weapon's secondary at any time.

export const WEAPON_SELECTED = -1;

/** The next selection in direction dir (+1 down the wheel, -1 up), wrapping. */
export function nextSelection(current: number, spells: readonly (string | null)[], dir: 1 | -1): number {
  const order = [WEAPON_SELECTED, ...spells.map((s, i) => (s ? i : null)).filter((i): i is number => i !== null)];
  const at = Math.max(0, order.indexOf(current));
  return order[(at + dir + order.length) % order.length];
}

/** A selection that still points at something (an emptied slot falls back to the weapon). */
export function validSelection(current: number, spells: readonly (string | null)[]): number {
  return current >= 0 && current < spells.length && spells[current] ? current : WEAPON_SELECTED;
}

/**
 * Wheel accumulator: trackpads send many small deltas, mice one ~100 px
 * notch; one step per 60 px, at most one step per 70 ms.
 */
export class WheelStepper {
  private acc = 0;
  private last = -Infinity;
  step(deltaY: number, now: number): 0 | 1 | -1 {
    if (now - this.last > 400) this.acc = 0;
    this.acc += deltaY;
    if (Math.abs(this.acc) < 60 || now - this.last < 70) return 0;
    const dir = this.acc > 0 ? 1 : -1;
    this.acc = 0;
    this.last = now;
    return dir;
  }
}
