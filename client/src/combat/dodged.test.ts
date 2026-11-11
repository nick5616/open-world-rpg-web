// Playtest 2 co-op: "Dodged!" toasts only for strikes you could see.
import { describe, expect, it } from 'vitest';
import { DODGE_SEEN_MS, SeenTelegraphs, telegraphContains } from './dodged';
import type { TelegraphView } from './events';

const tele = (o: Partial<TelegraphView>): TelegraphView => ({ enemy: 5, shape: 1, x: 0, y: 0, z: 0, yaw: 0, radius: 3, reach: 0, arc: 0, width: 0, windupMs: 500, attackId: 1, activeMs: 200, ...o });

describe('telegraph areas (twin of the zone attackArea.contains)', () => {
  it('circle and ground: within the radius plus the body', () => {
    expect(telegraphContains(tele({ shape: 1, radius: 3 }), 3.5, 0, 0)).toBe(true);
    expect(telegraphContains(tele({ shape: 2, radius: 3 }), 4.5, 0, 0)).toBe(false);
    expect(telegraphContains(tele({ shape: 1, radius: 3 }), 0, 6, 0)).toBe(false); // 6 m above
  });
  it('cone: yaw 0 faces -Z', () => {
    const cone = tele({ shape: 0, reach: 5, arc: 60 });
    expect(telegraphContains(cone, 0, 0, -4)).toBe(true);
    expect(telegraphContains(cone, 0, 0, 4)).toBe(false); // behind
    expect(telegraphContains(cone, 0, 0, -7)).toBe(false); // out of reach
    expect(telegraphContains(tele({ shape: 0, reach: 5, arc: 60, yaw: Math.PI / 2 }), -4, 0, 0)).toBe(true); // yaw pi/2 faces -X
  });
  it('line: along the yaw within its width', () => {
    const line = tele({ shape: 3, reach: 10, width: 2 });
    expect(telegraphContains(line, 0.5, 0, -8)).toBe(true);
    expect(telegraphContains(line, 3, 0, -8)).toBe(false);
    expect(telegraphContains(line, 0, 0, 3)).toBe(false);
  });
});

describe('evaded toasts', () => {
  it('parries always toast', () => {
    expect(new SeenTelegraphs().evadedToast(2, 5, 0)).toBe('Parried!');
  });
  it('no telegraph from that enemy (lightning, a far boss strike): no toast', () => {
    const s = new SeenTelegraphs();
    expect(s.evadedToast(1, 5, 1000)).toBeNull();
    expect(s.evadedToast(3, 5, 1000)).toBeNull();
    s.record(tele({ enemy: 6 }), 0, 0, 0, 1000);
    expect(s.evadedToast(1, 5, 1200)).toBeNull(); // another enemy's wind-up
  });
  it('an i-frame dodge of a strike you saw coming toasts; a stale one does not', () => {
    const s = new SeenTelegraphs();
    s.record(tele({ x: 50 }), 0, 0, 0, 1000); // far from you, but you saw it
    expect(s.evadedToast(1, 5, 1600)).toBe('Dodged!');
    expect(s.evadedToast(1, 5, 1000 + DODGE_SEEN_MS + 1)).toBeNull();
  });
  it('outside the area: only if the area held you when it was shown', () => {
    const s = new SeenTelegraphs();
    s.record(tele({ radius: 3 }), 1, 0, 0, 1000); // you stood in it, then stepped out
    expect(s.evadedToast(3, 5, 1500)).toBe('Dodged!');
    s.record(tele({ enemy: 7, radius: 3, x: 30 }), 0, 0, 0, 2000); // aimed at someone else
    expect(s.evadedToast(3, 7, 2400)).toBeNull();
  });
});
