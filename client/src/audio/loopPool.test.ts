import { describe, expect, it } from 'vitest';
import { clusterFires, KEEP_BIAS, loopTarget, MAX_LOOP_VOICES, MIN_LOOP_GAIN, selectLoops, type LoopEmitter, type LoopListener } from './loopPool';
import { SPACE_CAVE, SPACE_OUTDOORS } from './spatial';

const L: LoopListener = { x: 0, y: 1.6, z: 0, space: SPACE_OUTDOORS, leak: 1 };
const fire = (id: string, x: number, kind: LoopEmitter['kind'] = 'campfire', space = SPACE_OUTDOORS): LoopEmitter => ({ id, kind, x, y: 1, z: 0, space });

describe('positional loop selection', () => {
  it('nearer is louder, out of range is silent, beyond range never gets a voice', () => {
    const near = loopTarget(fire('a', 4), L);
    const far = loopTarget(fire('b', 18), L);
    expect(near.gain).toBeGreaterThan(far.gain);
    expect(far.lowpassHz).toBeLessThan(near.lowpassHz);
    expect(loopTarget(fire('c', 30), L).gain).toBe(0);
    expect(selectLoops([fire('c', 30)], L, new Set())).toEqual([]);
  });

  it('caps the voices at the loudest few', () => {
    const many = Array.from({ length: 40 }, (_, i) => fire(`f${i}`, 2 + i * 0.5, 'torch'));
    const picked = selectLoops(many, L, new Set());
    expect(picked.length).toBeLessThanOrEqual(MAX_LOOP_VOICES);
    expect(picked.map((p) => p.emitter.id)).toEqual(picked.map((p) => p.emitter.id).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
    expect(picked[0].emitter.id).toBe('f0');
    for (const p of picked) expect(p.gain).toBeGreaterThanOrEqual(MIN_LOOP_GAIN);
  });

  it('favours voices already playing (no swapping between two similar fires)', () => {
    const a = fire('a', 10);
    const b = fire('b', 9.6);
    expect(selectLoops([a, b], L, new Set(), 1)[0].emitter.id).toBe('b');
    expect(selectLoops([a, b], L, new Set(['a']), 1)[0].emitter.id).toBe('a');
    // ...unless the newcomer is clearly louder
    const c = fire('c', 2);
    expect(loopTarget(c, L).gain).toBeGreaterThan(loopTarget(a, L).gain * KEEP_BIAS);
    expect(selectLoops([a, c], L, new Set(['a']), 1)[0].emitter.id).toBe('c');
  });

  it('a hearth inside a house is muffled from the street; heard plainly inside', () => {
    const hearth = fire('h', 6, 'hearth', 3);
    const out = loopTarget(hearth, L);
    const inside = loopTarget(hearth, { ...L, space: 3 });
    expect(out.gain).toBeLessThan(inside.gain * 0.5);
    expect(out.lowpassHz).toBeLessThan(1500);
  });

  it('surface fires fade in a cave with the leak', () => {
    const f = fire('a', 5);
    expect(loopTarget(f, { ...L, space: SPACE_CAVE, leak: 0.01 }).gain).toBeLessThan(loopTarget(f, L).gain * 0.02);
  });
});

describe('burning cells -> fire emitters', () => {
  it('buckets cells and scales level and reach with their number', () => {
    const cells = [
      ...Array.from({ length: 20 }, (_, i) => ({ x: 100 + (i % 5), y: 10, z: 100 + Math.floor(i / 5) })),
      { x: 300, y: 12, z: 300 },
    ];
    const em = clusterFires(cells, () => SPACE_OUTDOORS);
    expect(em.length).toBe(2);
    const big = em.find((e) => Math.abs(e.x - 102) < 1)!;
    const small = em.find((e) => e.x === 300)!;
    expect(big.z).toBeCloseTo(101.5);
    expect(big.level!).toBeGreaterThan(small.level!);
    expect(big.reach!).toBeGreaterThan(small.reach!);
    expect(big.kind).toBe('wildfire');
    expect(new Set(em.map((e) => e.id)).size).toBe(2);
  });
});
