// Playtest 2 graphics settings: presets, the resolver, persistence, the
// first-run auto-detect choice and migration of the old stored value.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTROL_PRESETS, QUALITY_PRESETS, QUALITY_STORAGE_KEY, TIER_ORDER, migrateQuality, sanitizeOverrides, tierForSetting, type QualityTier } from './qualityStore';
import { grassFor, pixelRatioFor, resolveGraphics } from './graphics';
import { AUTO_BUDGET, AutoGovernor, classifyGpu } from './gpuDetect';
import { STYLES, STYLE_ORDER } from '../world/style/styles';
import { WORLD_TIERS } from '../world/config';

describe('quality presets', () => {
  it('Low < Medium < High < Ultra on every cost knob', () => {
    for (let i = 1; i < TIER_ORDER.length; i++) {
      const a = CONTROL_PRESETS[TIER_ORDER[i - 1]];
      const b = CONTROL_PRESETS[TIER_ORDER[i]];
      expect(b.dprCap).toBeGreaterThanOrEqual(a.dprCap);
      expect(b.viewDistance).toBeGreaterThanOrEqual(a.viewDistance);
      expect(b.foliage).toBeGreaterThanOrEqual(a.foliage);
      expect(b.shadowDistance).toBeGreaterThanOrEqual(a.shadowDistance);
      expect(WORLD_TIERS[TIER_ORDER[i]].scatterDistance).toBeGreaterThanOrEqual(WORLD_TIERS[TIER_ORDER[i - 1]].scatterDistance);
      expect(QUALITY_PRESETS[TIER_ORDER[i]].viewDistance).toBeGreaterThanOrEqual(QUALITY_PRESETS[TIER_ORDER[i - 1]].viewDistance);
    }
  });
  it('resolves to the pre-settings numbers for Low and High (no silent cost change)', () => {
    const low = resolveGraphics('low', 'low', {}, 'lodestone');
    expect(low.shadowCascades).toBe(0); // spec 12: none on low
    expect(low.bloom).toBe(false);
    expect(low.godRays).toBe(false);
    expect(low.msaa).toBe(0);
    expect(low.world.grassDistance).toBe(0);
    expect(low.controls.viewDistance).toBe(600);
    const med = resolveGraphics('medium', 'medium', {}, 'lodestone');
    expect(med.shadowCascades).toBe(2);
    expect(med.msaa).toBe(2);
    expect(med.world.grassDistance).toBe(WORLD_TIERS.medium.grassDistance);
    expect(med.world.grassDensity).toBeCloseTo(WORLD_TIERS.medium.grassDensity);
    const high = resolveGraphics('high', 'high', {}, 'lodestone');
    expect(high.shadowCascades).toBe(3);
    expect(high.shadowMapSize).toBe(2048);
    expect(high.shadowDistance).toBe(WORLD_TIERS.high.shadowDistance);
    expect(high.bloom && high.godRays).toBe(true);
    expect(high.msaa).toBe(4);
    expect(high.world.grassDistance).toBe(WORLD_TIERS.high.grassDistance);
    expect(high.custom).toBe(false);
  });
  it('overrides win over the preset and mark it custom', () => {
    const g = resolveGraphics('high', 'high', { shadows: 'off', renderScale: 0.6, antialias: 'fxaa', foliage: 0, maxFps: 60 }, 'lodestone');
    expect(g.custom).toBe(true);
    expect(g.shadowCascades).toBe(0);
    expect(g.world.shadowDistance).toBe(0);
    expect(g.msaa).toBe(0);
    expect(g.fxaa).toBe(true);
    expect(g.world.grassDistance).toBe(0);
    expect(g.controls.maxFps).toBe(60);
    expect(pixelRatioFor(g, 2, 1080)).toBeCloseTo(1.75 * 0.6);
  });
  it('cheap knobs follow the stepped tier, shader knobs the shader tier (WP19)', () => {
    const g = resolveGraphics('low', 'high', {}, 'lodestone'); // auto stepped down twice
    expect(g.controls.viewDistance).toBe(600);
    expect(g.controls.dprCap).toBe(1);
    expect(g.shadowCascades).toBe(3);
    expect(g.msaa).toBe(4);
  });
  it('post off drops bloom, god rays and FXAA', () => {
    const g = resolveGraphics('high', 'high', { post: false, antialias: 'fxaa' }, 'lodestone');
    expect(g.bloom || g.godRays || g.fxaa).toBe(false);
  });
  it('grass follows the foliage control', () => {
    expect(grassFor(0)).toEqual({ grassDistance: 0, grassDensity: 0 });
    expect(grassFor(1)).toEqual({ grassDistance: 36, grassDensity: 2.4 });
  });
  it('the spell screen pass runs from Medium up, in every style', () => {
    expect(resolveGraphics('low', 'low', {}, 'lodestone').spellScreen).toBe(false);
    expect(resolveGraphics('high', 'high', {}, 'lodestone').spellScreen).toBe(true);
    for (const s of STYLE_ORDER) expect(resolveGraphics('high', 'high', {}, s).spellScreen).toBe(true);
    expect(resolveGraphics('low', 'low', {}, 'retro').spellScreen).toBe(false);
  });
});

describe('visual styles', () => {
  it('every style is complete and the default is Lodestone', () => {
    expect(STYLE_ORDER).toEqual(['lodestone', 'painterly', 'grim', 'retro']);
    for (const id of STYLE_ORDER) {
      const s = STYLES[id];
      for (const [k, v] of Object.entries(s)) if (typeof v === 'number') expect(Number.isFinite(v), `${id}.${k}`).toBe(true);
    }
    expect(migrateQuality(null, 1).style).toBe('lodestone');
  });
  it('no style is named after another game', () => {
    for (const id of STYLE_ORDER) expect(`${id} ${STYLES[id].label} ${STYLES[id].blurb}`.toLowerCase()).not.toMatch(/queen|king's field|zelda|valheim|breath of the wild|playstation|ps1/);
  });
  it('Retro is cheaper: caps view distance, foliage, AA, post and shadows without touching what is stored', () => {
    const ov = { viewDistance: 2400 };
    const g = resolveGraphics('ultra', 'ultra', ov, 'retro');
    const r = STYLES.retro.retro!;
    expect(g.controls.viewDistance).toBe(r.maxView);
    expect(g.controls.foliage).toBeLessThanOrEqual(0.5);
    expect(g.msaa).toBe(0);
    expect(g.fxaa).toBe(false);
    expect(g.bloom || g.godRays).toBe(false);
    expect(g.shadowCascades).toBeLessThanOrEqual(2);
    expect(ov.viewDistance).toBe(2400);
    // A fixed number of rows, nearest-neighbour upscaled.
    expect(pixelRatioFor(g, 2, 960)).toBeCloseTo(r.lines / 960);
    // Other styles do not cap.
    expect(resolveGraphics('ultra', 'ultra', ov, 'grim').controls.viewDistance).toBe(2400);
  });
});

describe('auto-detect', () => {
  const probe = (renderer: string, extra: Partial<Parameters<typeof classifyGpu>[0]> = {}) => classifyGpu({ renderer, cores: 8, mobile: false, maxTextureSize: 16384, ...extra });
  it('classifies renderer strings', () => {
    expect(probe('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 (0x00002488) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('high');
    expect(probe('ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('high');
    expect(probe('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('medium');
    // Optimistic start (playtest 5): modern integrated GPUs begin at High; the governor steps down if they cannot hold it.
    expect(probe('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('high');
    expect(probe('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('high');
    expect(probe('ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('high');
    expect(probe('Apple GPU')).toBe('high');
    expect(probe('Apple GPU', { mobile: true })).toBe('low');
    expect(probe('Mali-G78')).toBe('low');
    expect(probe('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)')).toBe('low');
    expect(probe('')).toBe('high');
    expect(probe('', { cores: 4 })).toBe('medium');
    expect(probe('NVIDIA GeForce GTX 1060', { maxTextureSize: 4096 })).toBe('medium');
  });
  it('never picks Ultra on its own', () => {
    for (const r of ['NVIDIA GeForce RTX 4090', 'Apple M3 Max', 'AMD Radeon RX 7900 XTX']) expect(probe(r)).not.toBe('ultra');
    expect(tierForSetting('auto', { renderer: '', gpuTier: 'ultra', tier: 'ultra', frameMs: null })).toBe('high');
  });
  describe('AutoGovernor (frame times in real play)', () => {
    type Step = ReturnType<AutoGovernor['add']>;
    /** Feed frames for `ms` of play; returns every verdict. */
    const feed = (g: AutoGovernor, ms: number, frame: (i: number) => number) => {
      const out: NonNullable<Step>[] = [];
      for (let t = 0, i = 0; t < ms; i++) {
        const dt = frame(i);
        t += dt;
        const v = g.add(dt);
        if (v) out.push(v);
      }
      return out;
    };
    it('skips the warm-up, then steps down when p90 is over budget and never climbs back', () => {
      const g = new AutoGovernor('high');
      const v = feed(g, 45000, (i) => (i < 20 ? 200 : 36));
      expect(v[0]).toMatchObject({ kind: 'down', tier: 'medium' });
      expect(v[1]).toMatchObject({ kind: 'down', tier: 'low' });
      expect(v[v.length - 1]).toMatchObject({ kind: 'settled', tier: 'low' });
      expect(g.done).toBe(true);
    });
    it('keeps a smooth 60 fps High and settles without changing it', () => {
      const g = new AutoGovernor('high');
      const v = feed(g, 40000, () => 16.7);
      expect(v).toHaveLength(1);
      expect(v[0]).toMatchObject({ kind: 'settled', tier: 'high' });
    });
    it("steps up from a lower start when there is headroom, but never above Auto's max", () => {
      const g = new AutoGovernor('low');
      const v = feed(g, 40000, () => 8);
      expect(v[0]).toMatchObject({ kind: 'up', tier: 'medium' });
      expect(v[1]).toMatchObject({ kind: 'up', tier: 'high' });
      expect(v[v.length - 1]).toMatchObject({ kind: 'settled', tier: 'high' });
      expect(v.some((s) => s.tier === 'ultra')).toBe(false);
    });
    it('a failed step up goes back down once and stays there', () => {
      const g = new AutoGovernor('medium');
      let onHigh = false;
      const v: NonNullable<Step>[] = [];
      for (let t = 0; t < 40000; ) {
        const dt = onHigh ? 40 : 10;
        t += dt;
        const s = g.add(dt);
        if (s) {
          v.push(s);
          onHigh = s.tier === 'high';
        }
      }
      expect(v.map((s) => s.kind + ':' + s.tier).slice(0, 3)).toEqual(['up:high', 'down:medium', 'settled:medium']);
    });
    it('hitches (alt-tab, loads) are not frame times', () => {
      const g = new AutoGovernor('high');
      const v = feed(g, 40000, (i) => (i % 40 === 0 ? 600 : 16.7));
      expect(v.every((s) => s.kind === 'settled')).toBe(true);
      expect(v[0].tier).toBe('high');
    });
    it('one window that is a few long stalls (a load, alt-tab) is discarded, not judged', () => {
      const g = new AutoGovernor('high');
      const v = feed(g, 40000, (i) => (i < 3 ? 3000 : 16.7));
      expect(v.some((x) => x.kind === 'down')).toBe(false);
      expect(v[v.length - 1]).toMatchObject({ kind: 'settled', tier: 'high' });
    });
    it('stall after stall (under 1 fps) is the machine: it steps down', () => {
      const g = new AutoGovernor('high');
      const v = feed(g, 60000, () => 1600);
      expect(v[0]).toMatchObject({ kind: 'down', tier: 'medium' });
    });
    it('sustained slowness (4 fps) is the machine, not a stall: it steps down', () => {
      const g = new AutoGovernor('high');
      const v = feed(g, 45000, () => 250 + 300);
      expect(v[0]).toMatchObject({ kind: 'down', tier: 'medium' });
    });
    it('budgets: down is above up', () => {
      expect(AUTO_BUDGET.downP90Ms).toBeGreaterThan(AUTO_BUDGET.upP90Ms);
    });
  });
  it("the player's choice wins over detection", () => {
    const d = { renderer: 'x', gpuTier: 'low' as QualityTier, tier: 'low' as QualityTier, frameMs: 50 };
    expect(tierForSetting('ultra', d)).toBe('ultra');
    expect(tierForSetting('high', d)).toBe('high');
    expect(tierForSetting('auto', d)).toBe('low');
  });
});

describe('migration of the stored value', () => {
  it('version 0 ({ setting }) keeps the setting and gets the new defaults', () => {
    for (const setting of ['auto', 'low', 'medium', 'high'] as const) {
      expect(migrateQuality({ setting }, 0)).toEqual({ setting, overrides: {}, style: 'lodestone', effects: 'auto', detected: null, autoNoticed: null });
    }
  });
  it('a bare tier string and junk are read safely', () => {
    expect(migrateQuality('medium', 0).setting).toBe('medium');
    expect(migrateQuality({ setting: 'potato' }, 0).setting).toBe('auto');
    expect(migrateQuality(42, 0).setting).toBe('auto');
    expect(migrateQuality(undefined, 0).setting).toBe('auto');
  });
  it('version 1 -> 2 (playtest 5): Auto is re-evaluated, an explicit tier is kept', () => {
    const detected = { renderer: 'r', gpuTier: 'low', tier: 'low', frameMs: 40 };
    const auto = migrateQuality({ setting: 'auto', detected }, 1);
    expect(auto.setting).toBe('auto');
    expect(auto.detected).toBeNull(); // the old rules' verdict is thrown away, so the optimistic guess and the governor run again
    expect(migrateQuality({ setting: 'low', detected }, 1).setting).toBe('low');
    // Current-version detection and the told tier survive.
    const v2 = migrateQuality({ setting: 'auto', detected: { ...detected, tier: 'high' }, autoNoticed: 'high' }, 2);
    expect(v2.detected?.tier).toBe('high');
    expect(v2.autoNoticed).toBe('high');
  });
  it('version 1 values are validated and clamped', () => {
    const m = migrateQuality({ setting: 'ultra', style: 'retro', effects: 'low', overrides: { renderScale: 0.1, viewDistance: 99999, shadows: 'max', antialias: 'msaa2', post: 'yes', maxFps: 60 }, detected: { renderer: 'r', gpuTier: 'high', tier: 'medium', frameMs: 27 } }, 1);
    expect(m.setting).toBe('ultra');
    expect(m.style).toBe('retro');
    expect(m.effects).toBe('low');
    expect(m.overrides).toEqual({ renderScale: 0.5, viewDistance: 3000, antialias: 'msaa2', maxFps: 60 });
    expect(m.detected).toBeNull(); // version 1 detection is dropped (see above)
    expect(migrateQuality({ detected: { renderer: 'r', gpuTier: 'high', tier: 'medium', frameMs: 27 } }, 2).detected?.tier).toBe('medium');
    expect(migrateQuality({ style: 'queens' }, 1).style).toBe('lodestone');
    expect(sanitizeOverrides({ foliage: Number.NaN })).toEqual({});
  });
});

describe('style shader hooks', () => {
  it('patch three chunks once and share one uniform array across every material', async () => {
    const THREE = await import('three');
    const { lsStyle, lsRetro, installStyleChunks } = await import('../world/style/styleShader');
    installStyleChunks();
    const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
    expect(chunks.lights_physical_pars_fragment).toContain('dotNL = lsToon( dotNL );');
    expect(chunks.lights_lambert_pars_fragment).toContain('lsToon');
    expect(chunks.logdepthbuf_vertex).toContain('lsRetro');
    expect(chunks.common.match(/uniform vec4 lsStyle;/g)?.length).toBe(1);
    const cloned = THREE.UniformsUtils.clone(THREE.ShaderLib.physical.uniforms);
    expect(cloned.lsStyle.value).toBe(lsStyle); // by reference: a style switch is a write, not a recompile
    expect(THREE.ShaderLib.depth.uniforms.lsRetro.value).toBe(lsRetro);
  });
});

describe('persistence (localStorage)', () => {
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
    return (await import('./qualityStore')).useQualityStore;
  }

  it('reads the old version-0 value the benchmarks still write', async () => {
    mem.set(QUALITY_STORAGE_KEY, JSON.stringify({ state: { setting: 'low' }, version: 0 }));
    const s = (await fresh()).getState();
    expect(s.setting).toBe('low');
    expect(s.tier).toBe('low');
    expect(s.shaderTier).toBe('low');
    expect(s.style).toBe('lodestone');
  });
  it('reads a raw legacy string', async () => {
    mem.set(QUALITY_STORAGE_KEY, 'medium');
    expect((await fresh()).getState().setting).toBe('medium');
  });
  it('round-trips preset, controls, style and effects', async () => {
    let store = await fresh();
    store.getState().setSetting('ultra');
    store.getState().setControl('shadows', 'low');
    store.getState().setControl('maxFps', 90);
    store.getState().setStyle('grim');
    store.getState().setEffects('medium');
    const saved = JSON.parse(mem.get(QUALITY_STORAGE_KEY)!);
    expect(saved.version).toBe(2);
    expect(saved.state).toMatchObject({ setting: 'ultra', overrides: { shadows: 'low', maxFps: 90 }, style: 'grim', effects: 'medium' });
    store = await fresh();
    const s = store.getState();
    expect(s.setting).toBe('ultra');
    expect(s.tier).toBe('ultra');
    expect(s.overrides).toEqual({ shadows: 'low', maxFps: 90 });
    expect(s.style).toBe('grim');
    expect(s.effects).toBe('medium');
  });
  it('picking a preset clears the individual controls; auto steps stay at or below High', async () => {
    const store = await fresh();
    store.getState().setControl('foliage', 0.2);
    store.getState().setSetting('medium');
    expect(store.getState().overrides).toEqual({});
    store.getState().setSetting('auto');
    for (let i = 0; i < 6; i++) store.getState().stepUp();
    expect(store.getState().tier).toBe('high');
  });
  it('a stored detection sets where auto starts', async () => {
    mem.set(QUALITY_STORAGE_KEY, JSON.stringify({ state: { setting: 'auto', detected: { renderer: 'Intel', gpuTier: 'medium', tier: 'medium', frameMs: 21 } }, version: 2 }));
    const s = (await fresh()).getState();
    expect(s.tier).toBe('medium');
    expect(s.shaderTier).toBe('medium');
  });
});
