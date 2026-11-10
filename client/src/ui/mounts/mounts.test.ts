// CR 027 (playtest 2 mounts) in the browser: the wire decoders and the store,
// where an arriving / bolting steed is drawn, name chunks, the steed rig's
// gaits, the rider's seated pose on the avatar rig, the combat timeline in
// the saddle, and the gallop's FOV kick.
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { InputFlag, type Event as ZoneEvent } from '@lodestone/contracts';
import { newMoveState } from '../../sim/movement';
import { MOUNTED } from '../../sim/ride';
import { CombatTimeline, type CombatButtons } from '../../combat/timeline';
import { rideKick } from '../../combat/dashFeel';
import { nameChunks, PHASE, ridingOf, steedPose, STEED_EV, TYPE_RIDING } from './events';
import { initialMounts, reduceSteedEvent } from './store';
import { SADDLE_Y, SteedRig } from './model';
import type { RemoteView } from '../../net/interpolation';

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => null }) };
});

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const ev = (kind: number, entityId: number, value: number, data: unknown, targetId = 1): ZoneEvent => ({ kind, entityId, targetId, value, x: 0, y: 0, z: 0, data: enc(data) }) as unknown as ZoneEvent;

describe('steed events and store', () => {
  it('1141 tracks each owner’s steed by version; gone removes it; 1140 is yours', () => {
    let s = { ...initialMounts(), selfId: 5 };
    s = reduceSteedEvent(s, ev(STEED_EV.state, 9, PHASE.arriving, { p: 1, x: 10, y: 2, z: 20, fx: 30, fz: 20, ms: 2400, c: 2, n: 'Pip', k: 1 }, 3), 1000);
    expect(s.steeds[9].phase).toBe(PHASE.arriving);
    expect(s.steeds[9].until).toBe(3400);
    s = reduceSteedEvent(s, ev(STEED_EV.state, 9, PHASE.standing, { p: 2, x: 10, y: 2, z: 20, c: 2, n: 'Pip', k: 1 }, 2), 1100); // older version: ignored
    expect(s.steeds[9].phase).toBe(PHASE.arriving);
    s = reduceSteedEvent(s, ev(STEED_EV.state, 9, PHASE.ridden, { p: 3, x: 10, y: 2, z: 20, c: 4, n: 'Pip', k: 1 }, 4), 1200);
    expect(s.steeds[9].colour).toBe(4);
    s = reduceSteedEvent(s, ev(STEED_EV.state, 9, PHASE.gone, { p: 0, x: 0, y: 0, z: 0, c: 4, n: 'Pip', k: 1 }, 5), 1300);
    expect(s.steeds[9]).toBeUndefined();
    s = reduceSteedEvent(s, ev(STEED_EV.sync, 5, 0, { owned: true, name: 'Misty', colour: 1, kind: 1, whistle: true, phase: 0, x: 0, z: 0, coolMs: 0, colours: 6, count: 1, arriveMs: 0 }), 1400);
    expect(s.mine?.name).toBe('Misty');
    s = reduceSteedEvent(s, ev(STEED_EV.refused, 5, 3, null, 4200), 1500);
    expect(s.notes.at(-1)?.text).toMatch(/spooked \(5 s\)/);
    s = reduceSteedEvent(s, ev(STEED_EV.thrown, 5, 2, null), 1600);
    expect(s.thrownAt).toBe(1600);
    expect(s.notes.at(-1)?.text).toMatch(/demon/);
  });

  it('an arriving steed gallops in from afar and slows at the end; a bolting one fades', () => {
    const v = { owner: 1, phase: PHASE.arriving, x: 0, y: 0, z: 0, fx: 26, fz: 0, until: 2400, at: 0, colour: 0, name: '', kind: 1, ver: 1 };
    const a = steedPose(v, 0);
    const mid = steedPose(v, 1200);
    const end = steedPose(v, 2400);
    expect(a.x).toBeCloseTo(26, 6);
    expect(mid.x).toBeGreaterThan(0);
    expect(mid.x).toBeLessThan(13);
    expect(end.x).toBeCloseTo(0, 6);
    expect(a.speed).toBeGreaterThan(mid.speed);
    expect(Math.abs(Math.sin(a.yaw) - 1)).toBeLessThan(1e-9); // facing -x: yaw +pi/2
    const b = steedPose({ ...v, phase: PHASE.bolting, fx: 14 }, 2000);
    expect(b.alpha).toBeLessThan(0.4);
  });

  it('names travel as 4-byte chunks ending with a 0 byte', () => {
    expect(nameChunks('Misty')).toEqual([0x7473694d, 0x79]);
    expect(nameChunks('Sixteen chars ok')).toHaveLength(4);
    expect(ridingOf(TYPE_RIDING | 0x123)).toBe(true);
    expect(ridingOf(0x3123)).toBe(false);
  });
});

describe('steed rig', () => {
  it('walks, trots and gallops with speed; the legs move, standing still they rest', () => {
    const r = new SteedRig(1);
    for (let i = 0; i < 30; i++) r.update(1 / 60, 0);
    expect(r.gait).toBe('idle');
    const gaits = [2.5, 7, 13.5].map((sp) => {
      for (let i = 0; i < 30; i++) r.update(1 / 60, sp);
      return r.gait;
    });
    expect(gaits).toEqual(['walk', 'trot', 'gallop']);
    r.setOpacity(0.3);
    expect(r.root.visible).toBe(true);
    r.setOpacity(0);
    expect(r.root.visible).toBe(false);
    r.dispose();
  });
});

describe('a rider on the avatar rig', () => {
  const view = (typeId: number, x: number): RemoteView => ({ id: 7, kind: 1, name: 'Rider', level: 3, healthPct: 100, activity: 0, partyId: 0, typeId, ring: 'near', delayMs: 0, x, y: 0, z: 20, yaw: 0, pitch: 0, speed: 8, mode: 'interp' }) as unknown as RemoteView;

  it('sits on a steed facing its motion, hips at the saddle; off the bit, no steed', async () => {
    const { Avatar } = await import('../../net/avatar');
    const a = new Avatar(7);
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(0, 2, 30);
    for (let i = 0; i < 40; i++) a.update(view(TYPE_RIDING, 10 + i * (8 / 60)), cam, 1 / 60); // riding east (+x)
    expect(a.steedGait).toBe('trot');
    expect(Math.abs(a.heading + Math.PI / 2)).toBeLessThan(0.05); // facing +x
    expect(a.pose.bodyY).toBeGreaterThan(SADDLE_Y - 0.88 - 0.1);
    expect(a.anim.current).toBeNull(); // a speed jump on a steed is no dodge
    a.update(view(0, 20), cam, 1 / 60);
    expect(a.steedGait).toBe('');
    expect(a.pose.bodyY).toBeLessThan(0.3);
  });
});

describe('combat in the saddle', () => {
  const idle = (): CombatButtons => ({ attackDown: false, altDown: false, attackPress: 0, altPress: 0, altRelease: 0, dodgePress: 0, castPress: [null, null, null, null], castHeld: [false, false, false, false], formPress: 0, techniquePress: 0, drinkPress: 0 });
  const rider = () => {
    const s = newMoveState({ x: 0, y: 0, z: 0 });
    s.flags |= MOUNTED;
    return s;
  };

  it('no sword swings, parries, dodges or dashes; spells and the bow work', () => {
    const t = new CombatTimeline();
    const st = rider();
    const flags: number[] = [];
    for (let seq = 1; seq < 40; seq++) {
      const b = { ...idle(), attackPress: seq === 1 ? 1 : 0, dodgePress: seq === 2 ? 1 : 0, altDown: seq > 3 && seq < 6, castPress: [seq === 8 ? seq : null, null, seq === 20 ? seq : null, null] as (number | null)[] };
      flags.push(t.step(seq, b, st, 0, seq * 16.67).flags);
    }
    const any = (f: number) => flags.some((x) => (x & f) !== 0);
    expect(any(InputFlag.attack)).toBe(false);
    expect(any(InputFlag.dodge)).toBe(false); // neither the dodge nor Magma Dash (slot 3)
    expect(any(InputFlag.alt_attack)).toBe(false);
    expect(any(InputFlag.cast)).toBe(true); // Ember Flick (slot 1)

    const bow = new CombatTimeline();
    bow.loadout = { ...bow.loadout, weapon: 'bow' };
    // CR 033: the left button draws from the saddle too (the alt bit), and a tap looses after the minimum draw
    const outs = Array.from({ length: 12 }, (_, i) => bow.step(1 + i, { ...idle(), attackPress: i === 0 ? 1 : 0 }, st, 0, 16 * (i + 1)));
    expect(outs[0].flags & InputFlag.alt_attack).toBeTruthy();
    expect(outs.some((o) => (o.flags & InputFlag.attack) !== 0 && o.started?.move?.key === 'bow_charged')).toBe(true);
  });

  it('the gallop widens the view a little; a trot not at all', () => {
    expect(rideKick(8.5)).toBe(0);
    expect(rideKick(13.5)).toBeGreaterThan(0.2);
    expect(rideKick(19)).toBeLessThanOrEqual(0.56);
  });
});
