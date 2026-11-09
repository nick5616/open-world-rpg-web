import { describe, expect, it } from 'vitest';
import { DEDUPE_MS, pickVariant, STACK_MAX, STACK_WINDOW_MS, variation, VoiceLimiter } from './voiceLimit';

const at = (x: number, z = 0) => ({ x, y: 0, z });

describe('voice limiter', () => {
  it('cooldown: repeats closer than the cue cooldown collapse into one', () => {
    const l = new VoiceLimiter();
    expect(l.admit('land', 0, null, { cooldownMs: 150 })).toBe('play');
    expect(l.admit('land', 100, null, { cooldownMs: 150 })).toBe('cooldown');
    expect(l.admit('land', 160, null, { cooldownMs: 150 })).toBe('play');
  });

  it('a rejected play does not restart the cooldown', () => {
    const l = new VoiceLimiter();
    l.admit('ui_error', 0, null, { cooldownMs: 250 });
    l.admit('ui_error', 200, null, { cooldownMs: 250 });
    expect(l.admit('ui_error', 260, null, { cooldownMs: 250 })).toBe('play');
  });

  it('the same cue at the same place in the same moment is one sound', () => {
    const l = new VoiceLimiter();
    expect(l.admit('hit', 0, at(5))).toBe('play');
    expect(l.admit('hit', 10, at(5.5))).toBe('duplicate');
    expect(l.admit('hit', 12, at(9))).toBe('play');
    expect(l.admit('hit', DEDUPE_MS + 20, at(5))).toBe('play');
    // non-spatial: same moment = same sound
    expect(l.admit('ui_click', 0, null)).toBe('play');
    expect(l.admit('ui_click', 20, null)).toBe('duplicate');
    expect(l.admit('ui_click', DEDUPE_MS + 1, null)).toBe('play');
  });

  it('an area hit on eight enemies is at most STACK_MAX starts', () => {
    const l = new VoiceLimiter();
    const verdicts = Array.from({ length: 8 }, (_, i) => l.admit('hit', i * 2, at(i * 3)));
    expect(verdicts.filter((v) => v === 'play').length).toBe(STACK_MAX);
    expect(verdicts.slice(STACK_MAX).every((v) => v === 'stacked')).toBe(true);
    expect(l.admit('hit', STACK_WINDOW_MS + 20, at(40))).toBe('play');
  });

  it('different cues never limit each other', () => {
    const l = new VoiceLimiter();
    expect(l.admit('hit', 0, at(1))).toBe('play');
    expect(l.admit('hit_crit', 0, at(1))).toBe('play');
    expect(l.admit('swing_sword', 0, null)).toBe('play');
  });
});

describe('variation', () => {
  it('never the same variant twice in a row', () => {
    let last = -1;
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const v = pickVariant(4, last);
      expect(v).not.toBe(last);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(4);
      seen.add(v);
      last = v;
    }
    expect(seen.size).toBe(4);
    expect(pickVariant(1, 0)).toBe(0);
    expect(pickVariant(2, 0, () => 0.99)).toBe(1);
    expect(pickVariant(2, 1, () => 0)).toBe(0);
  });

  it('pitch and gain stay within their spread', () => {
    expect(variation(0.08, 0.1, () => 0)).toEqual({ rate: 0.92, gain: 0.9 });
    expect(variation(0.08, 0.1, () => 1)).toEqual({ rate: 1.08, gain: 1.1 });
    expect(variation(0, 0, Math.random)).toEqual({ rate: 1, gain: 1 });
  });
});
