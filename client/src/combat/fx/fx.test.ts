// Playtest 2 spell FX: the pure logic (quality resolution and scaling, GPU
// assessment, recipe selection for every spell, pooling and caps) and the
// runtime's routing of casts and zone Events into the FX engine.

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { COMBAT, InputFlag, yawToU16, pitchToI16, type Event as ZoneEvent } from '@lodestone/contracts';
import { FX_PROFILES, FX_TIERS, fxLightCount, resolveFxTier, fxTierForGraphics, minFxTier } from './quality';
import { classifyGpu, FrameSampler } from './gpu';
import { budget, fxCount, setFxTier } from './core';
import { familyOf, mobilitySpellForDash, spellVisual, visualKind, PALETTES, ELEMENT_FAMILY } from './spellVisual';
import { FxPrims, POOL, alive } from './transients';
import { crackle, newBoltSlot, RibbonBuffer } from './bolts';
import { ParticlePool } from './particles';
import { SpellFxEngine } from './engine';
import { setSpellFxEngine, spellFx } from './api';
import { CombatRuntime } from '../runtime';
import { EV } from '../events';
import { newMoveState } from '../../sim/movement';
import { drawnRemotes } from '../../net/netStore';
import type { RemoteView } from '../../net/interpolation';
import { streamSeed } from '../spellsim';

afterEach(() => {
  setSpellFxEngine(null);
  setFxTier('high');
  budget.emitted = 0;
  budget.scale = 1;
});

describe('quality tiers', () => {
  it('an explicit FX setting wins over everything', () => {
    for (const fx of FX_TIERS) expect(resolveFxTier({ fxSetting: fx, qualitySetting: 'low', tier: 'low', gpuCap: 'low' })).toBe(fx);
  });
  it('an explicit graphics setting picks the FX tier (high graphics = go all out); the GPU cap does not apply', () => {
    expect(resolveFxTier({ fxSetting: 'auto', qualitySetting: 'high', tier: 'high', gpuCap: 'low' })).toBe('ultra');
    expect(resolveFxTier({ fxSetting: 'auto', qualitySetting: 'medium', tier: 'medium', gpuCap: 'ultra' })).toBe('medium');
    expect(resolveFxTier({ fxSetting: 'auto', qualitySetting: 'low', tier: 'low', gpuCap: 'ultra' })).toBe('low');
  });
  it('auto: the graphics tier capped by the GPU assessment (high until assessed)', () => {
    expect(resolveFxTier({ fxSetting: 'auto', qualitySetting: 'auto', tier: 'high', gpuCap: null })).toBe('high');
    expect(resolveFxTier({ fxSetting: 'auto', qualitySetting: 'auto', tier: 'high', gpuCap: 'ultra' })).toBe('ultra');
    expect(resolveFxTier({ fxSetting: 'auto', qualitySetting: 'auto', tier: 'high', gpuCap: 'medium' })).toBe('medium');
    expect(resolveFxTier({ fxSetting: 'auto', qualitySetting: 'auto', tier: 'low', gpuCap: 'ultra' })).toBe('low');
    expect(fxTierForGraphics('medium')).toBe('medium');
    expect(minFxTier('ultra', 'low')).toBe('low');
  });
  it('profiles get monotonically louder and costlier; low has no screen effects or lights', () => {
    for (let i = 1; i < FX_TIERS.length; i++) {
      const a = FX_PROFILES[FX_TIERS[i - 1]];
      const b = FX_PROFILES[FX_TIERS[i]];
      expect(b.density).toBeGreaterThanOrEqual(a.density);
      expect(b.frameBudget).toBeGreaterThan(a.frameBudget);
      expect(b.hdr).toBeGreaterThanOrEqual(a.hdr);
      expect(b.spikes).toBeGreaterThanOrEqual(a.spikes);
    }
    const low = FX_PROFILES.low;
    expect([low.shake, low.flash, low.distortion, low.hdr]).toEqual([0, 0, 0, 1]);
    expect([fxLightCount('low'), fxLightCount('medium'), fxLightCount('high')]).toEqual([0, 2, 4]);
  });
  it('fxCount scales by density and distance, keeps a minimum, and thins past the frame budget', () => {
    const half = () => 0.99; // never round a fraction up
    setFxTier('high');
    expect(fxCount(40, 0, half)).toBe(40);
    setFxTier('low');
    expect(fxCount(40, 0, half)).toBe(14);
    expect(fxCount(1, 1, half)).toBe(1);
    setFxTier('ultra');
    expect(fxCount(40, 0, half)).toBe(60);
    budget.scale = 0.5;
    expect(fxCount(40, 0, half)).toBe(30);
    budget.scale = 1;
    budget.emitted = FX_PROFILES.ultra.frameBudget * 4; // a cast-spam frame
    expect(fxCount(40, 0, half)).toBe(15);
  });
});

describe('GPU assessment', () => {
  const info = (renderer: string, maxTextureSize = 16384) => ({ renderer, maxTextureSize, maxPointSize: 1024 });
  it('classifies renderer strings', () => {
    expect(classifyGpu(info('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'))).toBe('low');
    expect(classifyGpu(info('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)'))).toBe('ultra');
    expect(classifyGpu(info('ANGLE (Intel, Intel(R) HD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)'))).toBe('medium');
    expect(classifyGpu(info('Mali-G78'))).toBe('medium');
    expect(classifyGpu(info('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)'))).toBe('high');
    expect(classifyGpu(info('ANGLE (NVIDIA, GeForce GTX 1060)', 4096))).toBe('medium');
  });
  it('the frame sample skips the loading frames and caps by the median', () => {
    const fast = new FrameSampler(10, 3);
    for (let i = 0; i < 3; i++) expect(fast.add(500)).toBeNull(); // loading hitches ignored
    for (let i = 0; i < 9; i++) expect(fast.add(8)).toBeNull();
    expect(fast.add(8)).toBe('ultra');
    const slow = new FrameSampler(4, 0);
    for (const d of [30, 31, 29, 28]) slow.add(d);
    expect(slow.result).toBe('medium');
    const awful = new FrameSampler(3, 0);
    for (const d of [60, 70, 80]) awful.add(d);
    expect(awful.result).toBe('low');
  });
});

describe('recipe selection', () => {
  const castable = COMBAT.spells.filter((s) => s.type !== 'passive');
  it('every castable spell has a visual (type, family, palette, look); passives none', () => {
    for (const sp of COMBAT.spells) {
      const kind = visualKind(sp);
      expect(kind === 'none').toBe(sp.type === 'passive');
      const v = spellVisual(sp);
      expect(PALETTES[v.family]).toBeTruthy();
      expect(v.palette.main).toMatch(/^#[0-9a-f]{6}$/i);
      expect(v.sigil).toBeGreaterThanOrEqual(3);
    }
    expect(castable.length).toBeGreaterThan(60);
  });
  it('earth splits into nature / stone / crystal, dark into blood and void, the rest follow their tree', () => {
    const fam = (k: string) => familyOf(COMBAT.spells.find((s) => s.key === k)!);
    expect(fam('thorn_dart')).toBe('nature');
    expect(fam('avalanche')).toBe('stone');
    expect(fam('crystal_shard')).toBe('crystal');
    expect(fam('blood_lance')).toBe('blood');
    expect(fam('obliterate')).toBe('void');
    expect(fam('soul_drain')).toBe('blood');
    expect(fam('fireball')).toBe('fire');
    expect(fam('chain_lightning')).toBe('lightning');
    expect(fam('gust')).toBe('wind');
    expect(fam('glint')).toBe('light');
    expect(fam('rift_shot')).toBe('void');
  });
  it('looks per spell and set pieces for the big ones', () => {
    const v = (k: string) => spellVisual(COMBAT.spells.find((s) => s.key === k)!);
    expect(v('avalanche').look).toBe('boulder');
    expect(v('glacial_spike').look).toBe('needle');
    expect(v('crystal_shard').look).toBe('shard');
    expect(v('razor_wind').look).toBe('crescent');
    expect(v('ball_lightning').look).toBe('ball');
    expect(v('obliterate').look).toBe('void');
    expect(v('fireball').look).toBe('orb');
    for (const k of ['god_ray', 'lightning_strike', 'act_of_god', 'let_there_be_light', 'frost_nova', 'eruption', 'death_note']) expect(v(k).setPiece).toBe(k);
    for (const sp of COMBAT.spells.filter((s) => s.type === 'domain')) {
      expect(v(sp.key).weight).toBe('ultimate');
      expect(v(sp.key).setPiece).toBe('domain');
    }
    expect(v('ember_flick').weight).toBe('minor');
    expect(v('amaterasu').palette).toBe(PALETTES.blackflame);
  });
  it('every dash variant (Event 214 id | 0x8000) maps back to its mobility spell', () => {
    for (const sp of COMBAT.spells.filter((s) => s.type === 'mobility')) expect(mobilitySpellForDash(sp.dash)?.key).toBe(sp.key);
    expect(ELEMENT_FAMILY).toHaveLength(9);
  });
});

describe('pools and caps', () => {
  it('transient pools recycle the oldest slot past their cap', () => {
    const p = new FxPrims(2, 16, 64, 4);
    for (let i = 0; i < POOL.rings + 5; i++) p.ring(i, 0, 0, new THREE.Color('#fff'));
    expect(p.stats().rings).toBe(POOL.rings);
    const held = [];
    for (let i = 0; i < POOL.zones + 1; i++) held.push(p.holdZone());
    expect(alive(held[0])).toBe(false); // stolen by the 13th
    expect(alive(held[held.length - 1])).toBe(true);
    p.release(held[held.length - 1]);
    expect(alive(held[held.length - 1])).toBe(false);
  });
  it('the light pool is fixed: pulses steal the dimmest, held lights never steal', () => {
    const p = new FxPrims(2, 16, 64, 4);
    expect(p.lights).toHaveLength(2);
    const a = p.holdLight(new THREE.Color(), 10, 5);
    const b = p.holdLight(new THREE.Color(), 10, 5);
    expect(a && b).toBeTruthy();
    expect(p.holdLight(new THREE.Color(), 10, 5)).toBeNull();
    p.light(0, 0, 0, new THREE.Color(), 50); // all held: no pulse
    expect(p.lights.every((l) => l.held)).toBe(true);
    p.releaseLight(a);
    p.light(0, 0, 0, new THREE.Color(), 50);
    expect(p.lights.filter((l) => l.on).length).toBe(2);
    expect(new FxPrims(0, 16, 64, 4).holdLight(new THREE.Color(), 1, 1)).toBeNull();
  });
  it('spikes are capped per style and never grow in your face', () => {
    const p = new FxPrims(0, 8, 64, 4);
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(0, 1.6, 0);
    cam.updateMatrixWorld();
    p.update(0, cam);
    p.spikeRing('ice', 10, 10, 0, 2, 40, 1);
    expect(p.spikes.ice.n).toBe(8);
    p.spike('stone', 0.5, 0.5, 0, { height: 1, width: 0.2 });
    expect(p.spikes.stone.n).toBe(0);
  });
  it('bolts crackle allocation-free within their point budget; the ribbon buffer caps segments', () => {
    const s = newBoltSlot();
    Object.assign(s, { ax: 0, ay: 0, az: 0, bx: 0, by: 30, bz: 0, segs: 200, jitter: 1, forks: 20 });
    const pts = s.pts;
    crackle(s);
    expect(s.pts).toBe(pts);
    expect(s.n).toBeLessThanOrEqual(96);
    const r = new RibbonBuffer(10);
    r.begin();
    r.addSlot(s, 0.1, 1);
    r.end();
    expect(r.segments).toBe(10);
  });
  it('particles write into a fixed ring buffer and count against the frame budget', () => {
    const pool = new ParticlePool(8, true);
    budget.emitted = 0;
    for (let i = 0; i < 20; i++) pool.emit(0, 0, 0, 0, 0, 0, new THREE.Color(), 1, 0.1);
    expect(budget.emitted).toBe(20);
    expect(pool.capacity).toBe(8);
    pool.clear();
    expect(pool.liveAt(0)).toBe(0);
  });
  it('the engine caps live projectiles at 64 and ends them on request', () => {
    const e = new SpellFxEngine(2);
    const sp = COMBAT.spells.find((s) => s.key === 'ember_flick')!;
    const handles: number[] = [];
    for (let i = 0; i < 70; i++) handles.push(e.projectile(sp, 0, 1, 0, 0, 0, -30, 0, 0.3, 1));
    expect(e.stats().projectiles).toBe(64);
    e.projectileEnd(handles[69], 0, 1, -5, 'hit');
    expect(e.stats().projectiles).toBe(63);
    e.clear();
    expect(e.stats().projectiles).toBe(0);
    e.dispose();
  });
});

describe('the runtime drives the FX engine', () => {
  const fake = () => {
    const calls: { k: string; a: unknown[] }[] = [];
    const proxy = new Proxy({}, { get: (_t, k) => (...a: unknown[]) => (calls.push({ k: String(k), a }), 1) });
    setSpellFxEngine(proxy as unknown as SpellFxEngine);
    return calls;
  };
  const runtime = () => {
    const r = new CombatRuntime({ sendHitClaim: () => {}, sendInteract: () => {}, latestTick: () => 0, selfId: () => 1 });
    r.timeline.mana = 1000;
    r.timeline.manaMax = 1000;
    return r;
  };
  const ev = (kind: number, o: Partial<ZoneEvent> = {}): ZoneEvent => ({ kind, entityId: 0, targetId: 0, value: 0, x: 0, y: 0, z: 0, data: new Uint8Array(0), ...o }) as ZoneEvent;

  it('your own projectile: cast flourish at once, the shot on its first hit frame', () => {
    const calls = fake();
    const r = runtime();
    r.timeline.loadout = { weapon: 'wand', spells: ['ember_flick', 'magma_dash', 'ice_wall', null], gem: -1 };
    r.press(0);
    const st = newMoveState({ x: 0, y: 10, z: 0 });
    const out = r.stepHook(10, st, false);
    expect(out.flags & InputFlag.cast).toBeTruthy();
    expect(calls.map((c) => c.k)).toContain('castStart');
    for (let s = 10; s < 14; s++) r.afterStep(s, st);
    expect(calls.map((c) => c.k)).toContain('projectile');
  });
  it('mobility and defensive spells (no visual before) start a dash and a shield', () => {
    const calls = fake();
    const r = runtime();
    r.timeline.loadout = { weapon: 'wand', spells: ['ember_flick', 'magma_dash', 'ice_wall', null], gem: -1 };
    r.press(1);
    r.stepHook(10, newMoveState({ x: 0, y: 10, z: 0 }), false);
    r.press(2);
    r.stepHook(40, newMoveState({ x: 0, y: 10, z: 0 }), false);
    const started = calls.filter((c) => c.k === 'castStart').map((c) => (c.a[0] as { key: string }).key);
    expect(started).toEqual(['magma_dash', 'ice_wall']);
  });
  it('Events: other players\' casts (214), statuses (206), shields (219), enemy projectiles (205)', () => {
    const calls = fake();
    const r = runtime();
    const yawPitch = new Uint8Array(4);
    new DataView(yawPitch.buffer).setUint16(0, yawToU16(1.5), true);
    new DataView(yawPitch.buffer).setInt16(2, pitchToI16(-0.2), true);
    r.onEvent(ev(EV.cast, { entityId: 7, targetId: 1005, x: 100, y: 200, z: 300, data: yawPitch }));
    r.onEvent(ev(EV.status, { entityId: 1, targetId: 99, value: 1 }));
    r.onEvent(ev(EV.shield, { entityId: 1, targetId: 0, value: 0 }));
    const proj = new Uint8Array(10);
    new DataView(proj.buffer).setUint16(8, 3000, true);
    r.onEvent(ev(EV.projectile, { entityId: 5, targetId: 3, data: proj }));
    const byKind = Object.fromEntries(calls.map((c) => [c.k, c.a]));
    expect(byKind.remoteCast.slice(0, 5)).toEqual([7, 1005, 1, 2, 3]);
    expect(byKind.remoteCast[5] as number).toBeCloseTo(1.5, 3);
    expect(byKind.remoteCast[6] as number).toBeCloseTo(-0.2, 3);
    expect(byKind.status).toEqual([99, 1]);
    expect(byKind.shieldPoints).toEqual([0]);
    expect(byKind.enemyProjectile[0]).toBe(5);
  });
  it('CR 020: your stream starts, fires a projectile per shot and ends; a held charge gathers then fires', () => {
    const calls = fake();
    const r = runtime();
    r.timeline.loadout = { weapon: 'wand', spells: ['cinder_spray', 'boulder_heave', null, null], gem: -1 };
    const st = newMoveState({ x: 0, y: 10, z: 0 });
    r.hold(0, true);
    for (let s = 10; s < 21; s++) r.stepHook(s, st, false);
    r.hold(0, false);
    r.stepHook(21, st, false);
    const ks = calls.map((c) => c.k);
    expect(ks).toContain('streamStart');
    expect(ks.filter((k) => k === 'projectile').length).toBe(3); // shots at steps 10, 15, 20
    expect(ks).toContain('channelEnd');
    calls.length = 0;
    r.hold(1, true);
    for (let s = 40; s < 60; s++) r.stepHook(s, st, false);
    r.hold(1, false);
    r.stepHook(60, st, false);
    for (let s = 60; s < 64; s++) r.afterStep(s, st);
    const k2 = calls.map((c) => c.k);
    expect(k2).toContain('chargeStart');
    expect(k2).toContain('projectile');
  });
  it('CR 020 Events: a remote stream (223) simulated from its seed, its stop, bursts (224), ally attacks (225), a released charge (214 + u8)', () => {
    const calls = fake();
    const r = runtime();
    const sp = COMBAT.spells.find((s) => s.key === 'arc_sparks')!;
    const start = new Uint8Array(8);
    new DataView(start.buffer).setUint32(4, 4242, true);
    r.onEvent(ev(EV.channel, { entityId: 9, targetId: sp.id, value: 1, data: start }));
    r.onEvent(ev(EV.channel, { entityId: 9, targetId: sp.id, value: 0, data: new Uint8Array(6) }));
    const radius = new Uint8Array(2);
    new DataView(radius.buffer).setUint16(0, 300, true);
    r.onEvent(ev(EV.detonate, { entityId: 9, targetId: 50, value: COMBAT.spells.find((s) => s.key === 'burrowing_seed')!.id, data: radius }));
    r.onEvent(ev(EV.summonAttack, { entityId: 77, targetId: 50, value: COMBAT.spells.find((s) => s.key === 'wraith_hound')!.id }));
    const charged = new Uint8Array(5);
    charged[4] = 255;
    r.onEvent(ev(EV.cast, { entityId: 9, targetId: COMBAT.spells.find((s) => s.key === 'boulder_heave')!.id, data: charged }));
    const byKind = Object.fromEntries(calls.map((c) => [c.k, c.a]));
    expect(byKind.remoteStream[0]).toBe(9);
    expect(byKind.remoteStream[7]).toBe(streamSeed(4242, sp.id));
    expect(byKind.remoteChannelEnd).toEqual([9]);
    expect(byKind.detonate[4]).toBe(3);
    expect(byKind.summonAttack.slice(0, 2)).toEqual([77, 50]);
    expect(byKind.remoteCast[7]).toBe(1);
  });
  it('remote casts route: dash variants, forms (on their first hit frame, as yours), spells, weapon moves (visual only, from the event origin)', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const e = new SpellFxEngine(0);
    const spy = { castStart: vi.spyOn(e, 'castStart'), form: vi.spyOn(e, 'form'), castFrom: vi.spyOn(e, 'castFrom'), swing: vi.spyOn(e, 'swing') };
    drawnRemotes.views = [{ id: 7, x: 1, y: 0, z: 1, kind: 1, healthPct: 100 } as RemoteView];
    const cam = new THREE.PerspectiveCamera();
    const frame = () => e.update(cam, { width: 1280, height: 720, dpr: 1, maxPoint: 256 });
    frame();
    const dash = COMBAT.spells.find((s) => s.type === 'mobility')!;
    e.remoteCast(7, 0x8000 | dash.dash, 1, 0, 1, 0, 0);
    expect(spy.castStart.mock.calls[0][0].key).toBe(dash.key);
    e.remoteCast(7, COMBAT.forms[0].id, 1, 0, 1, 0, 0);
    expect(spy.form).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(50); // FORM_STARTUP_STEPS (2) later
    frame();
    expect(spy.form).toHaveBeenCalledTimes(1);
    e.remoteCast(7, 1005, 1, 0, 1, 0, 0);
    expect(spy.castFrom.mock.calls[0][0].key).toBe('fireball');
    e.remoteCast(8, 1001, 5, 0, 5, 0, 0); // a caster we don't draw: plays from the event origin
    expect(spy.castFrom.mock.calls[1][1]).toEqual({ x: 5, y: 0, z: 5 });
    const slash = COMBAT.moves.find((m) => m.key === 'sword_slash_1')!;
    e.remoteCast(7, slash.id, 1, 0, 1, 0, 0); // CR 022: a weapon swing draws its arc for others too
    expect(spy.castFrom).toHaveBeenCalledTimes(2);
    expect(spy.swing).toHaveBeenCalledTimes(1);
    expect(spy.swing.mock.calls[0].slice(0, 2)).toEqual([7, slash.id]);
    drawnRemotes.views = [];
    e.clear();
    e.dispose();
    vi.useRealTimers();
  });
  it('every castable spell, every form and every status plays through the engine without errors', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const e = new SpellFxEngine(4);
      e.prims.ground = { heightAt: (x: number, z: number) => Math.sin(x * 0.1) + Math.cos(z * 0.1) };
      drawnRemotes.views = [{ id: 50, x: 0, y: 0, z: -12, kind: 2, healthPct: 100, typeId: COMBAT.enemies[0].id } as RemoteView];
      const cam = new THREE.PerspectiveCamera();
      cam.position.set(0, 2, 6);
      cam.updateMatrixWorld();
      const frames = (n: number) => {
        for (let i = 0; i < n; i++) {
          vi.advanceTimersByTime(16);
          e.update(cam, { width: 1280, height: 720, dpr: 1, maxPoint: 256 });
        }
      };
      for (const sp of COMBAT.spells.filter((s) => s.type !== 'passive')) {
        e.castFrom(sp, { x: 0, y: 0, z: 0 }, 0, 0, 0, 0, -0.1);
        frames(20);
      }
      for (const f of COMBAT.forms) e.form(f, { x: 0, y: 0, z: 0 }, 0);
      for (const s of COMBAT.statuses) e.status(50, s.id);
      frames(200);
      const st = e.stats();
      expect(st.casts).toBeGreaterThan(60);
      expect(st.ongoing).toBeLessThanOrEqual(48);
      e.clear();
      e.dispose();
    } finally {
      drawnRemotes.views = [];
      vi.useRealTimers();
    }
  });
  it('a missing engine is a no-op and a throwing one never breaks combat', () => {
    setSpellFxEngine(null);
    expect(spellFx.projectile(null, 0, 0, 0, 0, 0, 0, 0, 0, 1)).toBe(0);
    setSpellFxEngine({ hit: () => { throw new Error('boom'); } } as unknown as SpellFxEngine);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => spellFx.hit(null, 0, 0, 0)).not.toThrow();
    warn.mockRestore();
  });
});
