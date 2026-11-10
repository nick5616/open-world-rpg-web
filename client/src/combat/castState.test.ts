// CR 022 shared spell visuals: the caster record both your prediction and
// replication fill, the replication decoders (Events 214 / 223 / 226 / 219 /
// 707 and the casting bit), and parity: the same action held the same way
// poses your avatar and another player's identically, and the FX engine
// draws a beam from the same record for both.

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { COMBAT, i16ToPitch, pitchToI16, u16ToYaw, yawToU16, type Event as ZoneEvent } from '@lodestone/contracts';
import { castState, remoteEvent, beamHoldMs, CAST_FX_DASH, CAST_FX_GUARD, CAST_FX_MINE, type RemoteFx } from './castState';
import { aimPoint, beamEnd, unpackHeldAim, angleDelta } from './aim';
import { streamSeed } from './spellsim';
import { AvatarAnimator, followCaster, heldDashSpec, type ActionKind } from '../net/avatarAnim';
import { CombatRuntime } from './runtime';
import { newMoveState } from '../sim/movement';
import { setSpellFxEngine } from './fx/api';
import { SpellFxEngine } from './fx/engine';
import { drawnRemotes } from '../net/netStore';
import type { RemoteView } from '../net/interpolation';

const sp = (key: string) => COMBAT.spells.find((s) => s.key === key)!;
const ev = (kind: number, o: Partial<ZoneEvent> = {}): ZoneEvent => ({ kind, entityId: 0, targetId: 0, value: 0, x: 0, y: 0, z: 0, data: new Uint8Array(0), ...o }) as ZoneEvent;
const aimData = (yaw: number, pitch: number, extra: number[] = []) => {
  const b = new Uint8Array(4 + extra.length);
  const d = new DataView(b.buffer);
  d.setUint16(0, yawToU16(yaw), true);
  d.setInt16(2, pitchToI16(pitch), true);
  extra.forEach((v, i) => (b[4 + i] = v));
  return b;
};
const u32 = (b: Uint8Array, off: number, v: number) => new DataView(b.buffer).setUint32(off, v, true);
/** Go's combat.HeldAim(yaw, pitch): u16 yaw | i16 pitch << 16 as int32. */
const heldAim = (yaw16: number, pitch16: number) => ((yaw16 & 0xffff) | ((pitch16 & 0xffff) << 16)) | 0;

function sink() {
  const calls: { k: string; a: unknown[] }[] = [];
  const fx = new Proxy({}, { get: (_t, k) => (...a: unknown[]) => void calls.push({ k: String(k), a }) }) as unknown as RemoteFx;
  return { fx, calls, kinds: () => calls.map((c) => c.k) };
}

afterEach(() => {
  castState.clear();
  setSpellFxEngine(null);
  drawnRemotes.views = [];
  vi.useRealTimers();
});

describe('replication decoders (castState.remoteEvent)', () => {
  it('214: an action with its exact u16/i16 aim; dash variants, the guard and channelled beams become state', () => {
    const { fx, calls } = sink();
    const fireball = sp('fireball');
    expect(remoteEvent(ev(214, { entityId: 7, targetId: fireball.id, x: 100, y: 200, z: 300, data: aimData(1.25, -0.3) }), 1, 0, fx)).toBe(true);
    const s = castState.get(7);
    expect(s.action?.id).toBe(fireball.id);
    expect(s.actions).toBe(1);
    expect(s.aimPrecise).toBe(true);
    expect(s.aimYaw).toBeCloseTo(u16ToYaw(yawToU16(1.25)), 9);
    expect(s.aimPitch).toBeCloseTo(i16ToPitch(pitchToI16(-0.3)), 9);
    expect(calls[0].k).toBe('remoteCast');
    expect(calls[0].a.slice(0, 5)).toEqual([7, fireball.id, 1, 2, 3]);
    // a dash: its variant is the running dash (not held until the casting bit says so)
    remoteEvent(ev(214, { entityId: 7, targetId: CAST_FX_DASH | 1, data: aimData(0, 0) }), 1, 0, fx);
    expect(s.dash).toMatchObject({ variant: 1, holding: false });
    // the guard press holds the guard; the shot that follows releases it
    remoteEvent(ev(214, { entityId: 8, targetId: CAST_FX_GUARD, data: aimData(0, 0) }), 1, 0, fx);
    expect(castState.get(8).held?.kind).toBe('guard');
    const bowShot = COMBAT.moves.find((m) => m.key === 'bow_charged')!.id;
    remoteEvent(ev(214, { entityId: 8, targetId: bowShot, data: aimData(0, 0, [200]) }), 1, 0, fx);
    expect(castState.get(8).held).toBeNull();
    expect(castState.get(8).action?.charge).toBeCloseTo(200 / 255, 6); // CR 022: a charged move's draw
    // a channelled beam is held for windup + duration
    const cauterize = sp('cauterize');
    remoteEvent(ev(214, { entityId: 9, targetId: cauterize.id, data: aimData(0, 0) }), 1, 0, fx);
    const h = castState.get(9).held!;
    expect(h.kind).toBe('beam');
    expect(h.until - h.at).toBeCloseTo(beamHoldMs(cauterize), 6);
    // your own and id 0 are not replication
    expect(remoteEvent(ev(214, { entityId: 1, targetId: fireball.id, data: aimData(0, 0) }), 1, 0, fx)).toBe(false);
  });

  it('223: a stream / charge start holds it (stream simulated from its seed), the stop ends it', () => {
    const { fx, calls, kinds } = sink();
    const arc = sp('arc_sparks');
    const start = aimData(0.5, 0.1, [0, 0, 0, 0]);
    u32(start, 4, 4242);
    remoteEvent(ev(223, { entityId: 9, targetId: arc.id, value: 1, data: start }), 1, 0, fx);
    expect(castState.get(9).held).toMatchObject({ kind: 'stream', id: arc.id, startSeq: 4242 });
    expect(calls[0].k).toBe('remoteStream');
    expect(calls[0].a[7]).toBe(streamSeed(4242, arc.id));
    remoteEvent(ev(223, { entityId: 9, targetId: arc.id, value: 0, data: new Uint8Array(6) }), 1, 0, fx);
    expect(castState.get(9).held).toBeNull();
    expect(kinds()).toContain('remoteChannelEnd');
    const boulder = sp('boulder_heave');
    remoteEvent(ev(223, { entityId: 9, targetId: boulder.id, value: 2, data: start }), 1, 0, fx);
    expect(castState.get(9).held?.kind).toBe('charge');
    expect(kinds()).toContain('chargeStart');
  });

  it('226: the precise aim (Go HeldAim packing); a late observer starts the stream at its shot index; a dash keepalive says which dash thrusts', () => {
    expect(unpackHeldAim(heldAim(0xbeef, -1234))).toEqual({ yaw16: 0xbeef, pitch16: -1234 });
    expect(unpackHeldAim(heldAim(0, 32767))).toEqual({ yaw16: 0, pitch16: 32767 });
    const { fx, calls } = sink();
    const cinder = sp('cinder_spray');
    const data = new Uint8Array(6);
    u32(data, 0, 777);
    new DataView(data.buffer).setUint16(4, 9, true); // 9 shots fired so far
    remoteEvent(ev(226, { entityId: 4, targetId: cinder.id, value: heldAim(yawToU16(2), pitchToI16(0.2)), data }), 1, 0, fx);
    const s = castState.get(4);
    expect(s.aimYaw).toBeCloseTo(u16ToYaw(yawToU16(2)), 9);
    expect(s.held).toMatchObject({ kind: 'stream', startSeq: 777, bitSeen: true });
    expect(calls[0].k).toBe('remoteStream');
    expect(calls[0].a[7]).toBe(streamSeed(777, cinder.id));
    expect(calls[0].a[8]).toBe(9);
    // a second update for the same stream only moves the aim
    remoteEvent(ev(226, { entityId: 4, targetId: cinder.id, value: heldAim(yawToU16(2.1), 0), data }), 1, 0, fx);
    expect(calls.length).toBe(1);
    expect(castState.get(4).aimYaw).toBeCloseTo(u16ToYaw(yawToU16(2.1)), 9);
    remoteEvent(ev(226, { entityId: 5, targetId: CAST_FX_DASH | 1, value: 0, data }), 1, 0, fx);
    expect(castState.get(5).dash).toMatchObject({ variant: 1, holding: true });
  });

  it('219 value 0 bursts another player\'s shell; 707 is a pickaxe swing action', () => {
    const { fx, calls } = sink();
    remoteEvent(ev(219, { entityId: 3, value: 0 }), 1, 0, fx);
    remoteEvent(ev(219, { entityId: 3, value: 40 }), 1, 0, fx); // points left: only the owner cares
    expect(calls.map((c) => c.k)).toEqual(['shieldBroken']);
    remoteEvent(ev(707, { entityId: 3 }), 1, 0, fx);
    expect(castState.get(3).action?.id).toBe(CAST_FX_MINE);
  });

  it('events wait for the caster\'s drawn moment (their interpolation delay)', () => {
    const { fx, calls } = sink();
    castState.activity(6, 0, 0, 0, 120, 1000);
    remoteEvent(ev(214, { entityId: 6, targetId: sp('fireball').id, data: aimData(0, 0) }), 1, 1000, fx);
    expect(calls.length).toBe(0);
    expect(castState.pending()).toBe(1);
    castState.flush(1100);
    expect(calls.length).toBe(0);
    castState.flush(1121);
    expect(calls.length).toBe(1);
    expect(castState.get(6).actions).toBe(1);
  });

  it('the casting bit: a drop ends a hold it was seen on (not one that just started); a dash thrusts while it is set', () => {
    const { fx, kinds } = sink();
    const start = aimData(0, 0, [1, 0, 0, 0]);
    remoteEvent(ev(223, { entityId: 9, targetId: sp('arc_sparks').id, value: 1, data: start }), 1, 0, fx);
    castState.activity(9, 0, 0, 0, 0, 10, fx); // the snapshot with the bit is not drawn yet
    expect(castState.get(9).held).not.toBeNull();
    castState.activity(9, 8, 0, 0, 0, 20, fx);
    castState.activity(9, 0, 0, 0, 0, 30, fx); // released (the stop event may come later)
    expect(castState.get(9).held).toBeNull();
    expect(kinds()).toContain('remoteChannelEnd');
    remoteEvent(ev(214, { entityId: 10, targetId: CAST_FX_DASH | 1, data: aimData(0, 0) }), 1, 0, fx);
    castState.activity(10, 8, 0, 0, 0, 40);
    expect(castState.get(10).dash?.holding).toBe(true);
    castState.activity(10, 0, 0, 0, 0, 50);
    expect(castState.get(10).dash).toBeNull(); // the hold ended: the dash is over
    // a later casting bit (a sword's parry stance) is not a dash's thrust
    remoteEvent(ev(214, { entityId: 10, targetId: CAST_FX_DASH | 1, data: aimData(0, 0) }), 1, 0, fx);
    castState.activity(10, 0, 0, 0, 0, performance.now() + 700); // a plain burst, never held
    castState.activity(10, 8, 0, 0, 0, performance.now() + 800);
    expect(castState.get(10).dash).toBeNull();
  });

  it('aimOf: yours exactly; theirs is the precise aim moved by their drawn look since, the drawn look when stale', () => {
    castState.aim('self', 1, 0.2, true, 0);
    expect(castState.aimOf('self', 5, 5, 10)).toEqual({ yaw: 1, pitch: 0.2 });
    castState.activity(7, 0, 0.5, 0.1, 0, 0);
    castState.aim(7, 0.52, 0.11, true, 0);
    const a = castState.aimOf(7, 0.6, 0.15, 100);
    expect(a.yaw).toBeCloseTo(0.62, 9);
    expect(a.pitch).toBeCloseTo(0.16, 9);
    // a drawn look at rest leaves no offset: the newest exact aim stands (the zone sends the one a turn ended on)
    castState.activity(7, 0, 0.6, 0.15, 0, 50);
    expect(castState.aimOf(7, 0.6, 0.15, 400)).toEqual({ yaw: 0.52, pitch: 0.11 });
    expect(castState.aimOf(7, 0.6, 0.15, 10000)).toEqual({ yaw: 0.6, pitch: 0.15 });
    expect(angleDelta(0.1, 2 * Math.PI - 0.1)).toBeCloseTo(0.2, 9);
  });
});

describe('one state, one pose: your avatar and another player\'s', () => {
  /** The animator's action kind after following a record for a few frames. */
  const pose = (a: AvatarAnimator, key: 'self' | number, weapon: Parameters<typeof followCaster>[2], frames = 3, vy = 0): ActionKind | null => {
    for (let i = 0; i < frames; i++) {
      followCaster(a, castState.peek(key), weapon);
      a.update({ x: 0, y: 10 + i * vy * 0.016, z: -i * 0.5, yaw: 0, pitch: 0, speed: 30, activity: 0, healthPct: 100 }, 1 / 60);
    }
    return a.current;
  };
  const runtime = () => {
    const r = new CombatRuntime({ sendHitClaim: () => {}, sendInteract: () => {}, latestTick: () => 0, selfId: () => 1 });
    r.timeline.mana = 1000;
    r.timeline.manaMax = 1000;
    return r;
  };

  it('a held stream: your prediction and Event 223 hold the same casting pose and end with the same flick', () => {
    const r = runtime();
    r.timeline.loadout = { weapon: 'wand', spells: ['cinder_spray', null, null, null], gem: -1 };
    const st = newMoveState({ x: 0, y: 10, z: 0 });
    const mine = new AvatarAnimator();
    const theirs = new AvatarAnimator();
    pose(mine, 'self', 'wand', 1);
    r.hold(0, true);
    for (let s = 10; s < 20; s++) r.stepHook(s, st, false);
    const { fx } = sink();
    const start = aimData(0, 0, [10, 0, 0, 0]);
    remoteEvent(ev(223, { entityId: 9, targetId: sp('cinder_spray').id, value: 1, data: start }), 1, 0, fx);
    pose(theirs, 9, 'wand', 1);
    expect(castState.get('self').held).toMatchObject({ kind: 'stream', startSeq: 10 });
    expect(castState.get(9).held).toMatchObject({ kind: 'stream', startSeq: 10 });
    const held = pose(mine, 'self', 'wand', 40);
    expect(held).toBe('castStaff');
    expect(pose(theirs, 9, 'wand', 40)).toBe(held);
    r.hold(0, false);
    r.stepHook(20, st, false);
    remoteEvent(ev(223, { entityId: 9, targetId: sp('cinder_spray').id, value: 0, data: new Uint8Array(6) }), 1, 0, fx);
    expect(castState.get('self').held).toBeNull();
    expect(pose(mine, 'self', 'wand', 2)).toBe(pose(theirs, 9, 'wand', 2));
    expect(mine.heldSpec).toBeNull();
    expect(theirs.heldSpec).toBeNull();
  });

  it('a held jet: your timeline\'s hold and their casting bit fly the same Iron Man pose; letting go ends it on both', () => {
    const magma = COMBAT.dashes.find((d) => d.sustain?.kind === 'jet')!;
    expect(heldDashSpec(magma.id)?.kind).toBe('jet');
    const mine = new AvatarAnimator();
    const theirs = new AvatarAnimator();
    castState.action('self', CAST_FX_DASH | magma.id, performance.now());
    castState.dashHolding('self', magma.id, true, performance.now());
    const { fx } = sink();
    remoteEvent(ev(214, { entityId: 9, targetId: CAST_FX_DASH | magma.id, data: aimData(0, 0.6) }), 1, 0, fx);
    castState.activity(9, 8, 0, 0.6, 0, 0);
    expect(pose(mine, 'self', 'staff', 30, 20)).toBe('jet');
    expect(pose(theirs, 9, 'staff', 30, 20)).toBe('jet');
    // flying upward: the body stands up along the climb (not the short dash pose)
    expect(mine.pose.bodyPitch).toBeGreaterThan(-1.2);
    castState.dashHolding('self', magma.id, false, 0);
    castState.activity(9, 0, 0, 0.6, 0, 0);
    expect(pose(mine, 'self', 'staff', 2)).toBe(pose(theirs, 9, 'staff', 2));
    expect(mine.current).not.toBe('jet');
  });

  it('a bow draw held past 3 s stays drawn for others (the casting bit) and releases when you let go', () => {
    const r = runtime();
    r.timeline.loadout = { weapon: 'bow', spells: [null, null, null, null], gem: -1 };
    const st = newMoveState({ x: 0, y: 10, z: 0 });
    const mine = new AvatarAnimator();
    pose(mine, 'self', 'bow', 1);
    r.press('alt');
    for (let s = 10; s < 14; s++) r.stepHook(s, st, false);
    expect(castState.get('self').held?.kind).toBe('guard');
    expect(pose(mine, 'self', 'bow', 2)).toBe('draw');
    const theirs = new AvatarAnimator();
    const { fx } = sink();
    remoteEvent(ev(214, { entityId: 9, targetId: CAST_FX_GUARD, data: aimData(0, 0) }), 1, 0, fx);
    castState.activity(9, 8, 0, 0, 0, 0);
    pose(theirs, 9, 'bow', 1);
    expect(pose(theirs, 9, 'bow', 60 * 4)).toBe('draw'); // 4 s: was a 3 s time-out before
    expect(pose(mine, 'self', 'bow', 60 * 4)).toBe('draw');
    // Letting go looses the drawn shot: your prediction starts it, the zone sends it to them (214 + the draw).
    r.press('altRelease');
    r.stepHook(14, st, false);
    expect(castState.get('self').held).toBeNull();
    const shot = castState.get('self').action!;
    expect(COMBAT.moves.find((m) => m.id === shot.id)?.key).toBe('bow_charged');
    remoteEvent(ev(214, { entityId: 9, targetId: shot.id, data: aimData(0, 0, [255]) }), 1, 0, fx);
    castState.activity(9, 0, 0, 0, 0, 5000);
    expect(castState.get(9).held).toBeNull();
    expect(pose(mine, 'self', 'bow', 2)).toBe('bow');
    expect(pose(theirs, 9, 'bow', 2)).toBe('bow');
  });

  it('third person: a step that aims a spell carries the crosshair aim in its frame (what the zone and others use); a sword swing keeps the look', async () => {
    const { localPlayer } = await import('../state/live');
    const saved = { ...localPlayer };
    try {
      localPlayer.yaw = 0;
      localPlayer.pitch = 0;
      localPlayer.aimYaw = 0.06; // the crosshair converges 3.4 deg off the camera look
      localPlayer.aimPitch = -0.02;
      const r = runtime();
      r.timeline.loadout = { weapon: 'sword', spells: ['ember_flick', null, null, null], gem: -1 };
      const st = newMoveState({ x: 0, y: 10, z: 0 });
      r.press(0);
      const cast = r.stepHook(10, st, false);
      expect(cast.aim).toEqual({ yaw: 0.06, pitch: -0.02 });
      expect(r.stepHook(11, st, false).aim).toBeNull();
      r.press('attack');
      let swing = r.stepHook(60, st, false);
      for (let s = 61; !(swing.flags & 0x100) && s < 90; s++) swing = r.stepHook(s, st, false);
      expect(swing.flags & 0x100).toBeTruthy();
      expect(swing.aim).toBeNull();
    } finally {
      Object.assign(localPlayer, saved);
    }
  });

  it('mining and weapon swings: the same action ids for you and for them', () => {
    const mine = new AvatarAnimator();
    const theirs = new AvatarAnimator();
    pose(mine, 'self', 'sword', 1);
    pose(theirs, 9, 'sword', 1);
    castState.action('self', CAST_FX_MINE, performance.now());
    const { fx } = sink();
    remoteEvent(ev(707, { entityId: 9 }), 1, 0, fx);
    expect(pose(mine, 'self', 'sword', 2)).toBe('mine');
    expect(pose(theirs, 9, 'sword', 2)).toBe('mine');
  });
});

describe('the FX engine draws held spells from the caster record', () => {
  it('another player\'s channelled beam follows their replicated aim (Event 226), with the same aim function as yours', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const e = new SpellFxEngine(0);
    e.prims.ground = { heightAt: () => 0 };
    drawnRemotes.views = [{ id: 7, x: 0, y: 0, z: 0, kind: 1, healthPct: 100, yaw: 0, pitch: 0 } as RemoteView];
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(0, 2, 10);
    const frame = () => {
      vi.advanceTimersByTime(16);
      e.update(cam, { width: 1280, height: 720, dpr: 1, maxPoint: 256 });
    };
    frame();
    const ends: number[][] = [];
    const place = vi.spyOn(e.prims, 'placeBeam').mockImplementation((_b, _ax, _ay, _az, bx, by, bz) => void ends.push([bx, by, bz]));
    castState.activity(7, 8, 0, 0, 0, performance.now());
    castState.aim(7, 0, -0.2, true, performance.now()); // looking ahead and down
    const cauterize = sp('cauterize');
    e.channelBeam(cauterize, 7, cauterize.durationMs);
    frame();
    const first = ends[ends.length - 1];
    const want = beamEnd({ x: 0, y: 1.6, z: 0 }, 0, -0.2, cauterize.range, [], () => 0).at;
    expect(first[0]).toBeCloseTo(want.x, 6);
    expect(first[2]).toBeCloseTo(want.z, 6);
    // they turn 90 degrees left (yaw +pi/2 = facing -X): the beam swings with them
    castState.aim(7, Math.PI / 2, -0.2, true, performance.now());
    frame();
    const turned = ends[ends.length - 1];
    const want2 = aimPoint({ x: 0, y: 1.6, z: 0 }, Math.PI / 2, -0.2, cauterize.range, () => 0);
    expect(turned[0]).toBeCloseTo(want2.x, 6);
    expect(turned[2]).toBeCloseTo(want2.z, 6);
    expect(turned[0]).toBeLessThan(-3);
    place.mockRestore();
    e.clear();
    e.dispose();
  });

  it('a held dash keeps its FX up while the casting bit holds it, even slowed below the dash speed', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const e = new SpellFxEngine(0);
    e.prims.ground = { heightAt: () => 0 };
    const view = { id: 7, x: 0, y: 0, z: 0, kind: 1, healthPct: 100, yaw: 0, pitch: 0 } as RemoteView;
    drawnRemotes.views = [view];
    const cam = new THREE.PerspectiveCamera();
    const frame = () => {
      vi.advanceTimersByTime(16);
      view.z -= 0.1; // 6 m/s: below the 14 m/s "still dashing" speed
      e.update(cam, { width: 1280, height: 720, dpr: 1, maxPoint: 256 });
    };
    frame();
    const magma = COMBAT.dashes.find((d) => d.sustain?.kind === 'jet')!;
    castState.action(7, CAST_FX_DASH | magma.id, performance.now());
    castState.activity(7, 8, 0, 0, 0, performance.now());
    e.remoteCast(7, CAST_FX_DASH | magma.id, 0, 0, 0, 0, 0);
    for (let i = 0; i < 90; i++) frame();
    const held = e.stats().ongoing;
    expect(held).toBeGreaterThan(0);
    castState.activity(7, 0, 0, 0, 0, performance.now());
    for (let i = 0; i < 5; i++) frame();
    expect(e.stats().ongoing).toBeLessThan(held);
    e.clear();
    e.dispose();
  });
});
