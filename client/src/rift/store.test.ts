// CR 040: the rift store's reducer, the arena on the movement ground, the
// bullet clock and the HUD's helpers.

import { describe, expect, it } from 'vitest';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { FlatGround } from '../sim/ground';
import { stepMovement } from '../sim/movement';
import { BulletClock } from './clock';
import { collide, stageLayout, START_Z, HALF_Z } from './layout';
import { RiftGround } from './riftGround';
import { applyRiftEvent, reduceRiftEvent, resetRift, riftRuntime, useRift, RIFT_EV, LEFT, type RiftState } from './store';
import { leftLine, portalInReach } from './RiftHud';

const enc = new TextEncoder();
const ev = (kind: number, value: number, data: unknown, targetId = 0): ZoneEvent => ({ kind, entityId: 7, targetId, value, x: 0, y: 0, z: 0, data: data instanceof Uint8Array ? data : enc.encode(JSON.stringify(data)) }) as unknown as ZoneEvent;
const base = (): RiftState => ({ ...useRift.getState(), self: 7 });

const STAGE = { run: 3, chapter: 2, chapterName: 'The Drowned Atrium', color: '#5cc8ff', stage: 7, stages: 50, kind: 0, kindName: '', level: 6, ox: 150000, oy: 285500, oz: 220000, startTick: 900, tick: 900, foes: [{ id: 50, name: 'Ringbell', kind: 1 }], members: [{ id: 7, name: 'Ayla', perks: { keen_edge: 1 }, spoils: 40, banked: 100 }], checkpoint: false, portal: 1 };

describe('rift store', () => {
  it('a room, perks, a reward, the bank, leaving', () => {
    let s = base();
    const apply = (e: ZoneEvent) => (s = { ...s, ...reduceRiftEvent(s, e, 1000) });
    apply(ev(RIFT_EV.stage, 7, STAGE));
    expect(s.stage?.stage).toBe(7);
    expect([s.spoils, s.banked, s.taken.keen_edge]).toEqual([40, 100, 1]);
    apply(ev(RIFT_EV.clear, 7, new Uint8Array()));
    expect(s.cleared).toBe(true);
    apply(ev(RIFT_EV.perks, 7, { stage: 7, seconds: 25, cards: [{ i: 0, key: 'keen_edge', name: 'Keen Edge', text: '+18% damage', have: 1 }, { i: 4, key: 'lull', name: 'Lull', text: 'slower', have: 0 }] }));
    expect(s.perks?.cards).toHaveLength(2);
    apply(ev(RIFT_EV.perk, 4, new Uint8Array(), 7));
    expect(s.perks).toBeNull();
    expect(s.taken).toEqual({ keen_edge: 1, lull: 1 });
    apply(ev(RIFT_EV.door, 1, new Uint8Array()));
    expect(s.door).toBe(2);
    apply(ev(RIFT_EV.reward, 30, { stage: 7, gold: 30, spoils: 70, banked: 100, items: ['weapon:iron_sword'], gems: 0, luck: 1.8, minRarity: 0 }));
    expect([s.spoils, s.reward?.items?.length]).toEqual([70, 1]);
    apply(ev(RIFT_EV.bank, 70, new Uint8Array()));
    expect([s.spoils, s.banked]).toEqual([0, 170]);
    apply(ev(RIFT_EV.left, LEFT.died, { reason: 1, best: 9, banked: 170, chapter: 2, chapterName: 'The Drowned Atrium', stage: 10, perks: null, ms: 300000 }));
    expect(s.stage).toBeNull();
    expect(s.left?.best).toBe(9);
    expect(leftLine(LEFT.died, 9, 170)).toMatch(/fell.*9.*170 gold banked/);
    expect(leftLine(LEFT.exit, 20, 900)).toMatch(/walked out at room 20/);
  });

  it('the arena reaches the runtime with the room; a refusal is only a note', () => {
    resetRift();
    useRift.setState({ self: 7 });
    applyRiftEvent(ev(RIFT_EV.stage, 7, STAGE));
    expect(riftRuntime.arena).toMatchObject({ chapter: 2, stage: 7, ox: 1500, oy: 2855, oz: 2200 });
    expect(riftRuntime.arena?.layout).toEqual(stageLayout(2, 7));
    applyRiftEvent(ev(RIFT_EV.left, 0, { refused: 'Walk up to the rift first.' }));
    expect(riftRuntime.arena).not.toBeNull();
    expect(useRift.getState().notes.at(-1)?.text).toMatch(/Walk up/);
    applyRiftEvent(ev(RIFT_EV.left, LEFT.exit, { reason: 2, best: 7, banked: 0, chapter: 2, chapterName: 'x', stage: 7, perks: null, ms: 1 }));
    expect(riftRuntime.arena).toBeNull();
  });

  it('the portal in reach', () => {
    const p = { id: 1, x: 100, y: 20, z: 100, chapter: 1, name: 'Emberglass Steps', color: '#f80', level: 3, endsInMs: 1000, at: 0 };
    expect(portalInReach([p], 104, 100, 20)?.id).toBe(1);
    expect(portalInReach([p], 107, 100, 20)).toBeNull();
    expect(portalInReach([p], 100, 100, 40)).toBeNull();
  });
});

describe('the arena on the movement ground', () => {
  it('stands on the floor, walls and pillars push, outside the band it is the world', () => {
    resetRift();
    applyRiftEvent(ev(RIFT_EV.stage, 1, { ...STAGE, chapter: 1, stage: 2, ox: 0, oy: 260000, oz: 0 }));
    const g = new RiftGround(new FlatGround(12));
    expect(g.atLevel(2600.5).heightAt(3, 3)).toBe(2600);
    expect(g.atLevel(40).heightAt(3, 3)).toBe(12);
    // Walking north from the entrance for 3 s stays on the floor, inside the room.
    let s = { pos: { x: 0, y: 2600, z: START_Z }, vel: { x: 0, y: 0, z: 0 }, mode: 0 } as unknown as Parameters<typeof stepMovement>[0];
    for (let i = 0; i < 400; i++) s = stepMovement(s, { flags: 1, yaw: 0, pitch: 0, castSlot: 0 }, g);
    expect(s.pos.y).toBeCloseTo(2600, 6);
    expect(s.pos.z).toBeGreaterThanOrEqual(-HALF_Z);
    const [cx, cz] = collide(riftRuntime.arena!.layout, s.pos.x, s.pos.z);
    expect([cx, cz]).toEqual([s.pos.x, s.pos.z]);
    resetRift();
    expect(g.atLevel(2600.5).heightAt(3, 3)).toBe(12);
  });
});

describe('the bullet clock', () => {
  it('lands on the tick the frame on screen reaches the zone, and glides', () => {
    const c = new BulletClock();
    expect(c.now({ tick: 1000, ackSeq: 500, lastSeq: 506 }, 0)).toBe(1003);
    let t = 1003;
    for (let k = 1; k <= 30; k++) {
      const n = c.now({ tick: 1000 + k, ackSeq: 500 + 2 * k, lastSeq: 506 + 2 * k }, k * 33.33);
      expect(n).toBeGreaterThan(t - 0.01);
      expect(n - t).toBeLessThan(2.5); // never jumps
      t = n;
    }
    expect(Math.abs(t - 1033)).toBeLessThan(1.5);
    expect(c.now({ tick: 5000, ackSeq: 0, lastSeq: 0 }, 2000)).toBe(5000); // a teleport-sized gap snaps
  });
});
