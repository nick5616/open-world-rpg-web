// WP20 interaction target selection: within 4 m of the eye, roughly in
// front of the view; the one nearest the view ray wins.

import { describe, expect, it } from 'vitest';
import { pickTarget, promptFor, REACH_M, type Candidate } from './interact';

const cand = (kind: Candidate['kind'], x: number, y: number, z: number, extra: Partial<Candidate> = {}): Candidate => ({ kind, x, y, z, entityId: null, stableId: 1n, index: -1, name: '', role: -1, merchant: 255, settlement: 0, ...extra });
const eye = { x: 0, y: 1.7, z: 0 };
const north = { x: 0, y: 0, z: -1 };

describe('pickTarget', () => {
  it('picks what is in front and within reach', () => {
    const a = cand('npc', 0, 1.5, -3, { name: 'Mira', role: 2 });
    expect(pickTarget(eye, north, [a])).toBe(a);
  });
  it('ignores things behind, beside, or out of reach', () => {
    expect(pickTarget(eye, north, [cand('board', 0, 1.6, 3)])).toBeNull();
    expect(pickTarget(eye, north, [cand('board', 3, 1.6, -0.5)])).toBeNull();
    expect(pickTarget(eye, north, [cand('forge', 0, 1.0, -(REACH_M + 0.5))])).toBeNull();
  });
  it('prefers the one nearest the view ray', () => {
    const off = cand('anvil', 1.2, 1.5, -2.5);
    const on = cand('forge', 0.1, 1.4, -3.2);
    expect(pickTarget(eye, north, [off, on])).toBe(on);
  });
  it('signposts are readable from a little further', () => {
    const s = cand('sign', 0, 2.0, -5.5, { name: 'Signpost: Millbrook 1.2 km' });
    expect(pickTarget(eye, north, [s])).toBe(s);
  });
  it('standing on top of a target still targets it', () => {
    const a = cand('shaft', 0.1, 1.65, 0.1);
    expect(pickTarget(eye, { x: 0, y: -1, z: 0 }, [a])).toBe(a);
  });
});

describe('prompts', () => {
  const role = (r: number) => ['villager', 'merchant', 'blacksmith'][r] ?? 'villager';
  it('reads like the spec', () => {
    expect(promptFor(cand('npc', 0, 0, 0, { name: 'Mira', role: 2 }), role)).toBe('[E] Talk to Mira (blacksmith)');
    expect(promptFor(cand('board', 0, 0, 0), role)).toBe('[E] Read the bounty board');
    expect(promptFor(cand('forge', 0, 0, 0), role)).toBe('[E] Use the forge');
    expect(promptFor(cand('shaft', 0, 0, 0), role)).toBe('[E] Descend the shaft');
  });
});
