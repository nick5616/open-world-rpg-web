// Playtest 5 (CR 057): Auto quality applies the governor's verdicts to both the effective and the
// shader tier, never touches an explicit choice, and tells the player once.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { QUALITY_STORAGE_KEY } from './qualityStore';

const mem = new Map<string, string>();
const storage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};
afterEach(() => {
  mem.clear();
  vi.unstubAllGlobals();
  vi.resetModules();
});
async function fresh() {
  vi.stubGlobal('localStorage', storage);
  vi.resetModules();
  const q = (await import('./qualityStore')).useQualityStore;
  const n = await import('../ui/graphics/autoTierNotice');
  return { q, n };
}

describe('autoApply', () => {
  it('moves tier and shaderTier together in Auto, capped at High', async () => {
    const { q } = await fresh();
    q.getState().setSetting('auto');
    expect(q.getState().autoApply('medium', 21)).toBe(true);
    expect(q.getState().tier).toBe('medium');
    expect(q.getState().shaderTier).toBe('medium');
    expect(q.getState().autoApply('medium', 20)).toBe(false);
    q.getState().autoApply('ultra', null);
    expect(q.getState().tier).toBe('high');
  });
  it('never touches a tier the player chose', async () => {
    const { q } = await fresh();
    for (const t of ['low', 'medium', 'high', 'ultra'] as const) {
      q.getState().setSetting(t);
      expect(q.getState().autoApply(t === 'low' ? 'high' : 'low', 12)).toBe(false);
      expect(q.getState().tier).toBe(t);
      expect(q.getState().shaderTier).toBe(t);
    }
  });
});

describe('the one-time notice', () => {
  it('shows once per new tier, in Auto only, and persists what the player was told', async () => {
    const { q, n } = await fresh();
    q.getState().setSetting('auto');
    expect(n.announceAutoTier('high')).toBe(true);
    expect(n.useAutoTierNotice.getState().text).toBe('Graphics set to High; F10 to change');
    expect(n.announceAutoTier('high')).toBe(false);
    expect(n.announceAutoTier('medium')).toBe(true);
    expect(JSON.parse(mem.get(QUALITY_STORAGE_KEY)!).state.autoNoticed).toBe('medium');
    q.getState().setSetting('low');
    expect(n.announceAutoTier('high')).toBe(false);
  });
  it('a player saved as Auto by the old rules is re-evaluated after the update', async () => {
    mem.set(QUALITY_STORAGE_KEY, JSON.stringify({ state: { setting: 'auto', detected: { renderer: 'x', gpuTier: 'low', tier: 'low', frameMs: 41 } }, version: 1 }));
    const { q } = await fresh();
    expect(q.getState().setting).toBe('auto');
    expect(q.getState().detected?.tier).not.toBe('low'); // jsdom has no GPU probe: falls back to the heuristic start, not the stored Low
    expect(q.getState().tier).not.toBe('low');
  });
  it('an explicit Low saved by an older build stays Low', async () => {
    mem.set(QUALITY_STORAGE_KEY, JSON.stringify({ state: { setting: 'low' }, version: 1 }));
    const { q } = await fresh();
    expect(q.getState().tier).toBe('low');
  });
});
