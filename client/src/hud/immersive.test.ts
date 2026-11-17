import { beforeEach, describe, expect, it } from 'vitest';
import { BARS_LINGER_MS, barsVisible, HOTBAR_LINGER_MS, hotbarVisible, hudActivity, resetHudActivity, sampleBars, TRACKER_LINGER_MS, trackerExpanded, useHudSettings } from './immersive';
import { heartbeatPeriod, lowHealthAmount } from './ImmersiveHud';

describe('Immersive HUD visibility rules', () => {
  beforeEach(() => resetHudActivity());

  it('the setting off shows everything, always', () => {
    expect(barsVisible({ immersive: false, now: 1e6, barsAt: -1e9, hp: 1, mana: 1 })).toBe(true);
    expect(hotbarVisible({ immersive: false, now: 1e6, hotbarAt: -1e9, inCombat: false, boss: false })).toBe(true);
    expect(trackerExpanded({ immersive: false, now: 1e6, stepAt: -1e9, tabHeld: false, journalOpen: false })).toBe(true);
  });

  it('is on by default', () => {
    expect(useHudSettings.getState().immersive).toBe(true);
  });

  it('health and mana show when not full, or shortly after they changed, then fade', () => {
    expect(barsVisible({ immersive: true, now: 10_000, barsAt: -1e9, hp: 1, mana: 1 })).toBe(false);
    expect(barsVisible({ immersive: true, now: 10_000, barsAt: -1e9, hp: 0.6, mana: 1 })).toBe(true);
    expect(barsVisible({ immersive: true, now: 10_000, barsAt: -1e9, hp: 1, mana: 0.2 })).toBe(true);
    expect(barsVisible({ immersive: true, now: 10_000, barsAt: 10_000 - BARS_LINGER_MS + 1, hp: 1, mana: 1 })).toBe(true);
    expect(barsVisible({ immersive: true, now: 10_000, barsAt: 10_000 - BARS_LINGER_MS - 1, hp: 1, mana: 1 })).toBe(false);
  });

  it('a change is noticed, the first sample after loading is not', () => {
    expect(sampleBars(1000, 1, 1, 1)).toBe(true); // first sample: "changed" but does not stamp
    expect(hudActivity.barsAt).toBe(-1e9);
    expect(sampleBars(1100, 1, 1, 1)).toBe(false);
    expect(sampleBars(1200, 0.8, 1, 1)).toBe(true);
    expect(hudActivity.barsAt).toBe(1200);
    sampleBars(1300, 0.8, 1, 1);
    expect(hudActivity.barsAt).toBe(1200); // no change, no new stamp
    sampleBars(1400, 0.8, 0.9, 1); // mana spent
    expect(hudActivity.barsAt).toBe(1400);
  });

  it('the hotbar shows in combat, in a boss fight, when downed, and for a while after a hotbar key', () => {
    const base = { immersive: true, now: 20_000, hotbarAt: -1e9, inCombat: false, boss: false };
    expect(hotbarVisible(base)).toBe(false);
    expect(hotbarVisible({ ...base, inCombat: true })).toBe(true);
    expect(hotbarVisible({ ...base, boss: true })).toBe(true);
    expect(hotbarVisible({ ...base, downed: true })).toBe(true);
    expect(hotbarVisible({ ...base, hotbarAt: 20_000 - HOTBAR_LINGER_MS + 5 })).toBe(true);
    expect(hotbarVisible({ ...base, hotbarAt: 20_000 - HOTBAR_LINGER_MS - 5 })).toBe(false);
  });

  it('the quest tracker collapses unless the step just changed, Tab is held or the journal is open', () => {
    const base = { immersive: true, now: 50_000, stepAt: -1e9, tabHeld: false, journalOpen: false };
    expect(trackerExpanded(base)).toBe(false);
    expect(trackerExpanded({ ...base, tabHeld: true })).toBe(true);
    expect(trackerExpanded({ ...base, journalOpen: true })).toBe(true);
    expect(trackerExpanded({ ...base, stepAt: 50_000 - TRACKER_LINGER_MS + 10 })).toBe(true);
    expect(trackerExpanded({ ...base, stepAt: 50_000 - TRACKER_LINGER_MS - 10 })).toBe(false);
  });
});

describe('low health feedback', () => {
  it('starts below 40%, is strongest near 10%, and is off when downed or healthy', () => {
    expect(lowHealthAmount(1)).toBe(0);
    expect(lowHealthAmount(0.4)).toBe(0);
    expect(lowHealthAmount(0.25)).toBeCloseTo(0.5, 6);
    expect(lowHealthAmount(0.1)).toBe(1);
    expect(lowHealthAmount(0.02)).toBe(1);
    expect(lowHealthAmount(0)).toBe(0);
  });
  it('the heartbeat never gets faster than about 70 a minute (no frantic pulse)', () => {
    expect(heartbeatPeriod(0)).toBeCloseTo(1.5, 6);
    expect(heartbeatPeriod(1)).toBeCloseTo(0.85, 6);
    expect(60 / heartbeatPeriod(1)).toBeLessThan(75);
  });
});
