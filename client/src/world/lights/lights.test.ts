import { describe, expect, it } from 'vitest';
import { COMBAT } from '@lodestone/contracts';
import { FAMILIARS, familiarById, familiarOfSpell, unpackLight } from './familiars';
import { breathe, flameFlicker, flickerSwing } from './flicker';
import { MAX_REACH_M, poolSizeFor, rank, type LightSource } from './lightPool';
import { applyLightEvent, ownLightBits, resetLights, useLights } from './lightStore';
import { QUALITY_PRESETS } from '../../stores/qualityStore';

const src = (key: string, x: number, priority = 1): LightSource => ({ key, x, y: 0, z: 0, color: '#fff', intensity: 10, range: 10, priority, d2: 0, seed: 0, flame: true });

describe('flicker', () => {
  it('stays within its swing and never changes faster than a gentle sway', () => {
    for (const reduce of [false, true]) {
      const swing = flickerSwing(reduce);
      let lo = 9;
      let hi = 0;
      let maxStep = 0;
      let prev = flameFlicker(0, 3, swing);
      // 60 fps for two minutes
      for (let i = 1; i < 60 * 120; i++) {
        const v = flameFlicker(i / 60, 3, swing);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
        maxStep = Math.max(maxStep, Math.abs(v - prev));
        prev = v;
      }
      expect(lo).toBeGreaterThanOrEqual(1 - swing - 1e-9);
      expect(hi).toBeLessThanOrEqual(1 + swing + 1e-9);
      // no strobing: a frame never moves the light more than 1% (well under any flash threshold)
      expect(maxStep).toBeLessThan(0.01);
    }
    expect(flickerSwing(true)).toBeLessThan(flickerSwing(false));
  });

  it('breathing is slow and small', () => {
    let prev = breathe(0, 1, 0.1);
    for (let i = 1; i < 600; i++) {
      const v = breathe(i / 60, 1, 0.1);
      expect(Math.abs(v - prev)).toBeLessThan(0.01);
      prev = v;
    }
  });
});

describe('the pooled lights', () => {
  it('give your own lights the first slots, then the nearest, and nothing far away', () => {
    const all = [src('far', 40), src('near', 5), src('mine', 30, 0), src('beyond', MAX_REACH_M + 1), src('mid', 12)];
    const got = rank(all, 3, 0, 0, 0).map((s) => s.key);
    expect(got).toEqual(['mine', 'near', 'mid']);
    expect(rank(all, 10, 0, 0, 0).map((s) => s.key)).not.toContain('beyond');
  });

  it('are fewer on the low tiers, and never exceed the shader tier budget', () => {
    expect(poolSizeFor(QUALITY_PRESETS.low.maxLights)).toBe(2);
    expect(poolSizeFor(QUALITY_PRESETS.medium.maxLights)).toBe(3);
    expect(poolSizeFor(QUALITY_PRESETS.high.maxLights)).toBe(4);
    expect(poolSizeFor(QUALITY_PRESETS.ultra.maxLights)).toBe(4);
    expect(poolSizeFor(QUALITY_PRESETS.low.maxLights)).toBeLessThan(poolSizeFor(QUALITY_PRESETS.high.maxLights));
  });
});

describe('familiar lights (combat.yaml)', () => {
  it('there is one in every school of magic, each cheap and learnable at the root of its tree', () => {
    const trees = COMBAT.trees.map((t) => t.key).sort();
    const have = FAMILIARS.map((f) => COMBAT.spells.find((s) => s.id === f.spellId)!.tree).sort();
    expect(have).toEqual(trees);
    for (const f of FAMILIARS) {
      const sp = COMBAT.spells.find((s) => s.id === f.spellId)!;
      expect(sp.type).toBe('defensive');
      expect(sp.mana).toBeLessThanOrEqual(5);
      expect(sp.tier).toBe(1);
      const node = COMBAT.trees.find((t) => t.key === sp.tree)!.nodes.find((n) => n.key === f.spellKey)!;
      expect(node.prereqs).toEqual([]);
      expect(f.upkeepPerS).toBeGreaterThan(0);
      expect(f.upkeepPerS).toBeLessThan(COMBAT.mana.regenPerS); // sustainable at rest
      expect(f.range).toBeGreaterThan(8);
      expect(familiarById(f.id)).toBe(f);
      expect(familiarOfSpell(f.spellId)).toBe(f);
    }
    expect(new Set(FAMILIARS.map((f) => f.id)).size).toBe(FAMILIARS.length);
    expect(new Set(FAMILIARS.map((f) => f.kind)).size).toBe(FAMILIARS.length);
  });

  it('light bits: bit 0 the torch, bits 1-5 the familiar', () => {
    expect(unpackLight(0)).toEqual({ torch: false, familiar: 0 });
    expect(unpackLight(1)).toEqual({ torch: true, familiar: 0 });
    expect(unpackLight(2 << 1 | 1)).toEqual({ torch: true, familiar: 2 });
    expect(unpackLight(31 << 1)).toEqual({ torch: false, familiar: 31 });
  });
});

describe('your light from the zone', () => {
  it('Event 1840 sets it, 1841 and a fade leave a line to show', () => {
    resetLights();
    expect(ownLightBits()).toBe(0);
    const ice = FAMILIARS.find((f) => f.kind === 'icicle')!;
    expect(applyLightEvent({ kind: 1840, entityId: 1, targetId: ice.spellId, value: (ice.id << 1) | 1, x: 0, y: 0, z: 0, data: new Uint8Array([0]) } as never)).toBe(true);
    expect(useLights.getState()).toMatchObject({ torch: true, familiar: ice.id });
    expect(ownLightBits()).toBe((ice.id << 1) | 1);
    applyLightEvent({ kind: 1840, entityId: 1, targetId: 0, value: ice.id << 1, x: 0, y: 0, z: 0, data: new Uint8Array([1]) } as never);
    expect(useLights.getState().torch).toBe(false);
    expect(useLights.getState().note?.text).toMatch(/water/);
    applyLightEvent({ kind: 1841, entityId: 1, targetId: 1, value: 1, x: 0, y: 0, z: 0, data: new Uint8Array() } as never);
    expect(useLights.getState().note?.text).toMatch(/no torch/i);
    expect(applyLightEvent({ kind: 1500 } as never)).toBe(false);
    resetLights();
  });
});
