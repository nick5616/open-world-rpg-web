// Playtest 2 onboarding: when tips show, once per character, and the cliff probe.

import { describe, expect, it } from 'vitest';
import { cliffAhead, clearSeen, forwardOf, IDLE_CONTEXT, loadSeen, nextTip, relevant, saveSeen, setTipsEnabled, settled, TIP_GAP_S, TIP_SHOW_S, TIP_WITHDRAW_S, TIPS, tipsEnabled, withdrawForCombat, type KV, type TipContext, type TipId } from './tips';

class MemKV implements KV {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

const ctx = (p: Partial<TipContext> = {}): TipContext => ({ ...IDLE_CONTEXT, playingS: 30, ...p });
const none = new Set<TipId>();

describe('which tip', () => {
  it('starts with getting around on first spawn, not before 2 s', () => {
    expect(nextTip(ctx({ playingS: 1 }), none, 99)).toBeNull();
    expect(nextTip(ctx({ playingS: 2.5 }), none, 99)).toBe('look');
  });

  it('shows each tip once', () => {
    const seen = new Set<TipId>(['look']);
    expect(nextTip(ctx(), seen, 99)).toBeNull();
    expect(nextTip(ctx({ questTracked: true }), seen, 99)).toBe('quest');
    seen.add('quest');
    expect(nextTip(ctx({ questTracked: true }), seen, 99)).toBeNull();
  });

  it('fires each trigger', () => {
    const all = new Set<TipId>(TIPS.map((t) => t.id));
    const only = (id: TipId) => new Set([...all].filter((x) => x !== id));
    expect(nextTip(ctx({ nearPerson: true }), only('talk'), 99)).toBe('talk');
    expect(nextTip(ctx({ enemyNear: true }), only('fight'), 99)).toBe('fight');
    expect(nextTip(ctx({ health: 0.3, draughts: 2 }), only('heal'), 99)).toBe('heal');
    expect(nextTip(ctx({ night: true }), only('night'), 99)).toBe('night');
    expect(nextTip(ctx({ cliff: true }), only('climb'), 99)).toBe('climb');
    expect(nextTip(ctx({ falling: true }), only('glide'), 99)).toBe('glide');
    expect(nextTip(ctx({ freePoints: 1 }), only('skills'), 99)).toBe('skills');
    // a downed player (health 0) is not told to drink
    expect(relevant('heal', ctx({ health: 0 }))).toBe(false);
  });

  it('urgent tips win and skip the quiet gap; others wait for it', () => {
    const seen = new Set<TipId>(['look']);
    expect(nextTip(ctx({ nearPerson: true, enemyNear: true }), seen, 99)).toBe('fight');
    expect(nextTip(ctx({ nearPerson: true }), seen, TIP_GAP_S - 1)).toBeNull();
    expect(nextTip(ctx({ enemyNear: true }), seen, 0.1)).toBe('fight');
    expect(nextTip(ctx({ health: 0.2, enemyNear: true }), seen, 0.1)).toBe('heal');
  });

  it('waits until out of combat, except the fight tip before you are hit (playtest 2 co-op)', () => {
    const seen = new Set<TipId>(['look']);
    // A boss bar is up (or you are downed), not yet hit: only the fight tip.
    expect(nextTip(ctx({ inCombat: true, questTracked: true }), seen, 99)).toBeNull();
    expect(nextTip(ctx({ inCombat: true, enemyNear: true }), seen, 99)).toBe('fight');
    // Hit: nothing at all, not even the fight or heal tip.
    expect(nextTip(ctx({ inCombat: true, hurt: true, enemyNear: true }), seen, 99)).toBeNull();
    expect(nextTip(ctx({ inCombat: true, hurt: true, health: 0.2 }), seen, 99)).toBeNull();
    expect(nextTip(ctx({ inCombat: true, hurt: true, night: true, nearPerson: true }), seen, 99)).toBeNull();
    // Out of combat again: they come.
    expect(nextTip(ctx({ health: 0.2 }), seen, 99)).toBe('heal');
    expect(nextTip(ctx({ night: true }), seen, 99)).toBe('night');
  });

  it('a fresh non-urgent tip steps aside when a fight starts', () => {
    expect(withdrawForCombat('night', ctx({ inCombat: true }), 1)).toBe(true);
    expect(withdrawForCombat('night', ctx({ inCombat: true }), TIP_WITHDRAW_S + 0.5)).toBe(false); // already read
    expect(withdrawForCombat('night', ctx(), 1)).toBe(false);
    expect(withdrawForCombat('fight', ctx({ inCombat: true }), 1)).toBe(false);
    expect(withdrawForCombat('heal', ctx({ inCombat: true }), 1)).toBe(false);
  });

  it('never while a panel, the menu or chat is up', () => {
    expect(nextTip(ctx({ busy: true, enemyNear: true }), none, 99)).toBeNull();
  });

  it('closes after its time, or early once its moment passed', () => {
    expect(settled('look', ctx(), 3)).toBe(false);
    expect(settled('look', ctx(), TIP_SHOW_S)).toBe(true);
    expect(settled('talk', ctx({ nearPerson: true }), 6)).toBe(false);
    expect(settled('talk', ctx({ nearPerson: false }), 6)).toBe(true);
    expect(settled('talk', ctx({ nearPerson: false }), 2)).toBe(false); // always readable for a moment
    expect(settled('heal', ctx({ health: 0.8 }), 6)).toBe(true);
  });
});

describe('remembered per character', () => {
  it('keeps seen tips per character and the on/off switch globally', () => {
    const kv = new MemKV();
    saveSeen(kv, 'char-a', new Set<TipId>(['look', 'talk']));
    expect([...loadSeen(kv, 'char-a')].sort()).toEqual(['look', 'talk']);
    expect(loadSeen(kv, 'char-b').size).toBe(0);
    clearSeen(kv, 'char-a');
    expect(loadSeen(kv, 'char-a').size).toBe(0);
    expect(tipsEnabled(kv)).toBe(true);
    setTipsEnabled(kv, false);
    expect(tipsEnabled(kv)).toBe(false);
    setTipsEnabled(kv, true);
    expect(tipsEnabled(kv)).toBe(true);
  });

  it('survives junk and storage that throws', () => {
    const kv = new MemKV();
    kv.setItem('lodestone_tips_seen:x', '{nope');
    expect(loadSeen(kv, 'x').size).toBe(0);
    kv.setItem('lodestone_tips_seen:x', JSON.stringify(['look', 'bogus', 3]));
    expect([...loadSeen(kv, 'x')]).toEqual(['look']);
    const bad: KV = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(tipsEnabled(bad)).toBe(true);
    expect(loadSeen(bad, 'x').size).toBe(0);
    expect(() => saveSeen(bad, 'x', new Set<TipId>(['look']))).not.toThrow();
    expect(tipsEnabled(null)).toBe(true);
  });
});

describe('cliff probe', () => {
  // A wall 2 m north (-z) of the origin: flat before it, 6 m up after.
  const wall = (_x: number, z: number) => (z < -2 ? 6 : 0);
  it('sees a cliff right ahead, not behind or to the side', () => {
    expect(cliffAhead(wall, 0, 0, 0, 0)).toBe(true); // yaw 0 looks down -z
    expect(cliffAhead(wall, 0, 0, 0, Math.PI)).toBe(false);
    expect(cliffAhead(wall, 0, 0, 0, Math.PI / 2)).toBe(false);
  });
  it('ignores a gentle hill and a low step', () => {
    expect(cliffAhead((_x, z) => -z * 0.5, 0, 0, 0, 0)).toBe(false);
    expect(cliffAhead((_x, z) => (z < -2 ? 1.2 : 0), 0, 0, 0, 0)).toBe(false);
  });
  it('uses the look convention of the rest of the client', () => {
    const f = forwardOf(0);
    expect(f.x).toBeCloseTo(0);
    expect(f.z).toBeCloseTo(-1);
  });
});
