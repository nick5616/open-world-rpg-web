// "Dodged!" only for strikes you could see (playtest 2 co-op). The zone
// sends Event 207 evaded (value 1 i-frames, 2 parry, 3 outside the area) for
// every strike that missed you, also ones you never saw: lightning, a boss's
// `everyone` strike far away. The toast now needs a telegraph (Event 204)
// from that enemy within DODGE_SEEN_MS, and for value 3 its area must have
// held you when it was shown (you stepped out of something real). "Parried!"
// is unchanged. Pure; unit-tested in dodged.test.ts.

import type { TelegraphView } from './events';

/** A telegraph this recent (ms) counts as one you saw coming. */
export const DODGE_SEEN_MS = 2500;
/** The player's body radius for the area test (the zone's combatbot uses 0.9). */
const BODY_R = 0.9;

/** Twin of the zone's attackArea.contains (internal/combat/ai.go); yaw 0 faces -Z. */
export function telegraphContains(t: Pick<TelegraphView, 'shape' | 'x' | 'y' | 'z' | 'yaw' | 'radius' | 'reach' | 'arc' | 'width'>, px: number, py: number, pz: number, r = BODY_R): boolean {
  if (Math.abs(py - t.y) > 4) return false;
  const dx = px - t.x;
  const dz = pz - t.z;
  const d = Math.hypot(dx, dz);
  switch (t.shape) {
    case 1: // circle
    case 2: // ground
      return d <= t.radius + r;
    case 0: {
      // cone
      if (d > t.reach + r) return false;
      if (d < r + 0.5) return true;
      // atan2 is in [-pi, pi] and the wire yaw in [0, 2pi): the sum below stays positive.
      const diff = Math.abs(((Math.atan2(-dx, -dz) - t.yaw + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      return diff <= (t.arc / 2) * (Math.PI / 180) + Math.atan2(r, d);
    }
    case 3: {
      // line
      const fx = -Math.sin(t.yaw);
      const fz = -Math.cos(t.yaw);
      const along = dx * fx + dz * fz;
      return along >= -r && along <= t.reach + r && Math.abs(dx * fz - dz * fx) <= t.width / 2 + r;
    }
    default:
      return true; // a projectile volley: aimed at someone, cheap to call it seen
  }
}

interface Seen {
  at: number;
  inside: boolean;
}

/** The latest telegraph per enemy: when it came and whether its area held you. */
export class SeenTelegraphs {
  private byEnemy = new Map<number, Seen>();

  record(t: TelegraphView, px: number, py: number, pz: number, now: number): void {
    const prev = this.byEnemy.get(t.enemy);
    // Several wind-ups in a row: keep "inside" if any recent one held you.
    const inside = telegraphContains(t, px, py, pz) || (!!prev && prev.inside && now - prev.at <= DODGE_SEEN_MS);
    this.byEnemy.set(t.enemy, { at: now, inside });
    if (this.byEnemy.size > 64) for (const [k, v] of this.byEnemy) if (now - v.at > DODGE_SEEN_MS) this.byEnemy.delete(k);
  }

  /** The toast for Event 207 (value, enemy = its targetId), or null for a strike you never saw. */
  evadedToast(value: number, enemy: number, now: number): 'Parried!' | 'Dodged!' | null {
    if (value === 2) return 'Parried!';
    const s = this.byEnemy.get(enemy);
    if (!s || now - s.at > DODGE_SEEN_MS) return null;
    if (value === 1) return 'Dodged!';
    if (value === 3 && s.inside) return 'Dodged!';
    return null;
  }

  clear(): void {
    this.byEnemy.clear();
  }
}
