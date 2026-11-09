import { beforeEach, describe, expect, it } from 'vitest';
import { parseTeleport, useDebugStore } from './debugStore';
import { useQualityStore, QUALITY_PRESETS, TIER_ORDER } from './qualityStore';
import { useAppStore } from './appStore';
import { FrameStatsWindow } from '../hud/frameStats';
import { lineKind } from '../scene/CellBorders';

describe('parseTeleport', () => {
  it('accepts "x z" and "x y z" with spaces or commas', () => {
    expect(parseTeleport('100 200')).toEqual({ x: 100, z: 200 });
    expect(parseTeleport(' 1.5, 30 ,-4 ')).toEqual({ x: 1.5, y: 30, z: -4 });
  });
  it('rejects junk', () => {
    expect(parseTeleport('')).toBeNull();
    expect(parseTeleport('1')).toBeNull();
    expect(parseTeleport('a b')).toBeNull();
    expect(parseTeleport('1 2 3 4')).toBeNull();
  });
});

describe('debug store', () => {
  it('teleport is consumed exactly once', () => {
    useDebugStore.getState().teleport({ x: 1, z: 2 });
    expect(useDebugStore.getState().takeTeleport()).toEqual({ x: 1, z: 2 });
    expect(useDebugStore.getState().takeTeleport()).toBeNull();
  });
});

describe('quality store', () => {
  beforeEach(() => useQualityStore.getState().setSetting('auto'));
  it('auto mode steps within bounds', () => {
    const s = useQualityStore.getState();
    for (let i = 0; i < 5; i++) s.stepDown();
    expect(useQualityStore.getState().tier).toBe('low');
    for (let i = 0; i < 5; i++) useQualityStore.getState().stepUp();
    expect(useQualityStore.getState().tier).toBe('high');
  });
  it('auto steps never change the shader tier (no recompile freeze, WP19)', () => {
    const start = useQualityStore.getState().shaderTier;
    useQualityStore.getState().stepDown();
    useQualityStore.getState().stepDown();
    expect(useQualityStore.getState().tier).toBe('low');
    expect(useQualityStore.getState().shaderTier).toBe(start);
    useQualityStore.getState().setSetting('low');
    expect(useQualityStore.getState().shaderTier).toBe('low');
  });
  it('a pinned setting ignores the monitor', () => {
    useQualityStore.getState().setSetting('medium');
    useQualityStore.getState().stepDown();
    expect(useQualityStore.getState().tier).toBe('medium');
  });
  it('presets get monotonically more expensive', () => {
    for (let i = 1; i < TIER_ORDER.length; i++) {
      const a = QUALITY_PRESETS[TIER_ORDER[i - 1]];
      const b = QUALITY_PRESETS[TIER_ORDER[i]];
      expect(b.dpr).toBeGreaterThanOrEqual(a.dpr);
      expect(b.viewDistance).toBeGreaterThanOrEqual(a.viewDistance);
      expect(b.shadowCascades).toBeGreaterThanOrEqual(a.shadowCascades);
    }
    expect(QUALITY_PRESETS.low.shadowCascades).toBe(0); // spec 12: none on low
  });
});

describe('app flow', () => {
  it('title -> account slot when not solo (WP04 mounts sign-in there)', () => {
    useAppStore.getState().setScreen('title');
    useAppStore.getState().startFromTitle();
    expect(useAppStore.getState().screen).toBe('account');
  });
});

describe('FrameStatsWindow', () => {
  it('reports fps, max and dropped frames once per second', () => {
    const w = new FrameStatsWindow();
    let t = 0;
    let out = w.tick(t);
    for (let i = 0; i < 59 && !out; i++) out = w.tick((t += 1000 / 60));
    out = w.tick((t += 50)); // one 50 ms hitch closes the window
    expect(out).not.toBeNull();
    expect(out!.dropped).toBe(1);
    expect(out!.maxMs).toBeCloseTo(50, 9);
    expect(out!.fps).toBeGreaterThan(55);
  });
});

describe('cell border classification', () => {
  it('region > chunk > cell', () => {
    expect(lineKind(0)).toBe('region');
    expect(lineKind(1024)).toBe('region');
    expect(lineKind(64)).toBe('chunk');
    expect(lineKind(-64)).toBe('chunk');
    expect(lineKind(32)).toBe('cell');
  });
});
