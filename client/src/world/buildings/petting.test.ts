import { describe, expect, it } from 'vitest';
import { ANIMAL } from './animalsPlan';
import { OwnerBarks, keeperIndex } from './animalBarks';
import { plateAlpha, PLATE_MAX_M } from './animalPlate';
import { npcFocus } from './npcFocus';
import { PET_DUR_S, PET_REACH_M, animalKey, beginPet, endPet, forwardOfYaw, handTarget, petBeat, petBlocked, petCancelled, petState, rollAngle, rollsOver, splitKey, tickPet } from './petting';
import { crouchCamera } from '../../scene/FirstPersonPet';
import { HUFFS, huffEnv, purrEnv } from '../../audio/animalSynth';

describe('the petting timeline', () => {
  it('crouches in, strokes three times head to rump, and rises again', () => {
    expect(petBeat(0).crouch).toBe(0);
    expect(petBeat(1.2).crouch).toBeCloseTo(1, 5);
    expect(petBeat(PET_DUR_S).crouch).toBeCloseTo(0, 5);
    // monotone down, then up: eased, no jumps
    let prev = 0;
    for (let t = 0; t <= 0.6; t += 0.02) {
      const c = petBeat(t).crouch;
      expect(c).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = c;
    }
    for (let t = 0; t <= PET_DUR_S; t += 0.01) expect(Math.abs(petBeat(t + 0.01).crouch - petBeat(t).crouch)).toBeLessThan(0.06);
    const strokes = new Set<number>();
    let maxS = 0;
    for (let t = 0; t < PET_DUR_S; t += 0.01) {
      const b = petBeat(t);
      if (b.stroke >= 0) strokes.add(b.stroke);
      maxS = Math.max(maxS, b.s);
      expect(b.s).toBeGreaterThanOrEqual(0);
      expect(b.s).toBeLessThanOrEqual(1);
    }
    expect([...strokes].sort()).toEqual([0, 1, 2]);
    expect(maxS).toBeGreaterThan(0.99);
  });
  it('lifts the hand between strokes and keeps it off the fur while stroking', () => {
    const mid = petBeat(0.7 + 0.45 * 0.4); // mid-stroke
    expect(mid.lift).toBeLessThan(0.02);
    const back = petBeat(0.7 + 0.45 * 0.9); // on the way back
    expect(back.lift).toBeGreaterThan(0.05);
    for (let t = 0; t < PET_DUR_S; t += 0.01) expect(petBeat(t).lift).toBeGreaterThan(0);
  });
  it('keeps the hand on the head-to-rump line, above it', () => {
    const head = { x: 0, y: 0.8, z: 0 };
    const back = { x: 1, y: 0.6, z: 0 };
    const out = { x: 0, y: 0, z: 0 };
    handTarget(head, back, petBeat(0.7), out);
    expect(out.x).toBeCloseTo(0, 2);
    handTarget(head, back, { ...petBeat(1), s: 1, lift: 0.01 }, out);
    expect(out.x).toBeCloseTo(1, 5);
    expect(out.y).toBeCloseTo(0.61, 5);
  });
  it('the joy builds, holds and fades after the end', () => {
    expect(petBeat(0).joy).toBe(0);
    expect(petBeat(1.5).joy).toBeCloseTo(1, 5);
    expect(petBeat(PET_DUR_S + 2).joy).toBeCloseTo(0, 5);
  });
  it('rolls over for about one dog in four, never a cat, and ends upright', () => {
    let n = 0;
    for (let s = 1; s <= 400; s++) if (rollsOver(s * 7919, 123456, ANIMAL.dog)) n++;
    expect(n).toBeGreaterThan(60);
    expect(n).toBeLessThan(140);
    expect(rollsOver(5, 99, ANIMAL.cat)).toBe(false);
    expect(rollAngle(0)).toBe(0);
    expect(rollAngle(1.7)).toBeCloseTo(Math.PI, 5);
    expect(rollAngle(PET_DUR_S)).toBeCloseTo(0, 5);
  });
});

describe('the petting rules', () => {
  const ok = { mounted: false, downed: false, inCombat: false, grounded: true, dist: 1.5 };
  it('allows a petting on foot within reach', () => {
    expect(petBlocked(ok)).toBeNull();
    expect(petBlocked({ ...ok, dist: PET_REACH_M })).toBeNull();
  });
  it('refuses mounted, in combat, downed, airborne, swimming or too far', () => {
    expect(petBlocked({ ...ok, mounted: true })).toMatch(/saddle/);
    expect(petBlocked({ ...ok, inCombat: true })).toMatch(/fight/);
    expect(petBlocked({ ...ok, downed: true })).toMatch(/fight/);
    expect(petBlocked({ ...ok, grounded: false })).toBeTruthy();
    expect(petBlocked({ ...ok, swimming: true })).toBeTruthy();
    expect(petBlocked({ ...ok, dist: 9 })).toBeTruthy();
  });
  it('is cancelled by moving, jumping, the saddle and a fight, not by standing still', () => {
    const still = { speed: 0.1, grounded: true, mounted: false, inCombat: false, downed: false };
    expect(petCancelled(still)).toBe(false);
    expect(petCancelled({ ...still, speed: 1.5 })).toBe(true);
    expect(petCancelled({ ...still, grounded: false })).toBe(true);
    expect(petCancelled({ ...still, mounted: true })).toBe(true);
    expect(petCancelled({ ...still, inCombat: true })).toBe(true);
    expect(petCancelled({ ...still, downed: true })).toBe(true);
  });
  it('runs by the clock and finishes by itself', () => {
    beginPet(animalKey(3, 66), ANIMAL.dog, 'Biscuit', 1000, { x: 0, z: 0 });
    expect(petState.active).toBe(true);
    const before = petState.finished;
    expect(tickPet(2000)).toBe(true);
    expect(petState.t).toBeCloseTo(1, 5);
    expect(tickPet(1000 + PET_DUR_S * 1000 + 1)).toBe(false);
    expect(petState.active).toBe(false);
    expect(petState.finished).toBe(before + 1);
    beginPet(1, 1, 'x', 0, { x: 0, z: 0 });
    endPet(false); // a cancelled petting is not a finished one
    expect(petState.finished).toBe(before + 1);
  });
  it('packs the animal key for the wire', () => {
    expect(splitKey(animalKey(41, 0x42))).toEqual({ settlement: 41, index: 0x42 });
  });
  it('faces where the yaw faces (yaw 0 is north, -z)', () => {
    expect(forwardOfYaw(0)).toEqual({ x: -0, z: -1 });
    expect(forwardOfYaw(Math.PI / 2).x).toBeCloseTo(-1, 5);
  });
});

describe('the first-person crouch', () => {
  it('lowers about half a metre and leans toward the animal, not past it', () => {
    const out = { x: 0, y: 0, z: 0 };
    crouchCamera({ x: 0, y: 1.6, z: 0 }, { x: 0, y: 0, z: -1.45 }, 1, out);
    expect(out.y).toBeCloseTo(1.08, 5);
    expect(out.z).toBeLessThan(-0.2);
    expect(out.z).toBeGreaterThan(-0.45);
    crouchCamera({ x: 0, y: 1.6, z: 0 }, { x: 0, y: 0, z: -1.45 }, 0, out);
    expect(out).toEqual({ x: 0, y: 1.6, z: 0 });
  });
});

describe('the owners and the nameplate', () => {
  const npcs = [{ role: 6 }, { role: 0 }, { role: 5 }, { role: 1 }, { role: 0 }];
  it('picks a keeper among the villagers and farmers', () => {
    for (let idx = 64; idx < 70; idx++) {
      const k = keeperIndex(77, idx, npcs, 0, npcs.length);
      expect([1, 2, 4]).toContain(k);
      expect(keeperIndex(77, idx, npcs, 0, npcs.length)).toBe(k);
    }
    expect(keeperIndex(77, 64, [{ role: 6 }], 0, 1)).toBe(-1);
  });
  it('calls the animal by name when it is close to a visitor and the keeper is in earshot, then holds its tongue', () => {
    npcFocus.reset();
    const b = new OwnerBarks();
    const dog = { key: 5, kind: ANIMAL.dog, name: 'Biscuit', x: 2, z: 0, seed: 11, keeper: 3 };
    const near = [{ key: 40, index: 3, x: 6, z: 0 }];
    b.update(1000, { x: 0, z: 0 }, [dog], near);
    expect(npcFocus.lineOf(40, 1001)?.text).toContain('Biscuit');
    npcFocus.reset();
    b.update(5000, { x: 0, z: 0 }, [dog], near);
    expect(npcFocus.lineOf(40, 5001)).toBeNull(); // the gap
    expect(b.said).toBe(1);
  });
  it('says nothing from out of earshot or for an animal far from the visitor', () => {
    npcFocus.reset();
    const b = new OwnerBarks();
    const dog = { key: 5, kind: ANIMAL.dog, name: 'Biscuit', x: 2, z: 0, seed: 11, keeper: 3 };
    b.update(0, { x: 0, z: 0 }, [dog], [{ key: 40, index: 3, x: 80, z: 0 }]);
    b.update(0, { x: 50, z: 0 }, [dog], [{ key: 40, index: 3, x: 52, z: 0 }]);
    expect(b.said).toBe(0);
  });
  it('remarks on the animal right after you petted it', () => {
    npcFocus.reset();
    const b = new OwnerBarks();
    const dog = { key: 5, kind: ANIMAL.dog, name: 'Biscuit', x: 30, z: 0, seed: 11, keeper: 3 };
    b.update(0, { x: 0, z: 0 }, [dog], [{ key: 40, index: 3, x: 5, z: 0 }], 5);
    expect(npcFocus.lineOf(40, 1)?.text).toContain('Biscuit');
  });
  it('fades the nameplate with distance', () => {
    expect(plateAlpha(2)).toBe(1);
    expect(plateAlpha(PLATE_MAX_M)).toBe(0);
    expect(plateAlpha(6)).toBeGreaterThan(0);
    expect(plateAlpha(6)).toBeLessThan(1);
  });
});

describe('the animal sounds', () => {
  it('shape the huffs and the purr', () => {
    expect(HUFFS).toHaveLength(3);
    expect(huffEnv(-1, 0.2)).toBe(0);
    expect(huffEnv(0.2, 0.2)).toBe(0);
    expect(huffEnv(0.03, 0.2)).toBeGreaterThan(huffEnv(0.15, 0.2));
    expect(purrEnv(0, 2.6)).toBe(0);
    expect(purrEnv(2.6, 2.6)).toBe(0);
    let peak = 0;
    for (let t = 0; t < 2.6; t += 0.004) peak = Math.max(peak, purrEnv(t, 2.6));
    expect(peak).toBeGreaterThan(0.8);
    expect(peak).toBeLessThanOrEqual(1);
  });
});
