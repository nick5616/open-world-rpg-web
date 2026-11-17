import { describe, expect, it } from 'vitest';
import { ANIMAL, MAX_CHICKENS, followGoal, peckPitch, planAnimals, trotLeg, type PlanInput } from './animalsPlan';

const town = (size: number, id = 77, farms = 3, doors = 30): PlanInput => ({
  id,
  size,
  x: 100,
  z: 200,
  farms: Array.from({ length: farms }, (_, i) => ({ x: 120 + i * 30, z: 210 })),
  doors: Array.from({ length: doors }, (_, i) => ({ x: 90 + i, z: 190 + (i % 5) })),
});
const count = (a: ReturnType<typeof planAnimals>, kind: number) => a.filter((x) => x.kind === kind).length;

describe('town animals plan', () => {
  it('is deterministic per settlement and differs between settlements', () => {
    expect(planAnimals(town(2), false)).toEqual(planAnimals(town(2), false));
    expect(planAnimals(town(2, 78), false)).not.toEqual(planAnimals(town(2, 77), false));
  });
  it('puts chickens at the farms, dogs in the streets, cats on the steps', () => {
    const p = planAnimals(town(2), false);
    expect(count(p, ANIMAL.chicken)).toBeGreaterThanOrEqual(6);
    expect(count(p, ANIMAL.chicken)).toBeLessThanOrEqual(MAX_CHICKENS);
    expect(count(p, ANIMAL.dog)).toBe(2);
    expect(count(p, ANIMAL.cat)).toBe(4);
    for (const c of p.filter((x) => x.kind === ANIMAL.chicken)) {
      const farm = town(2).farms[c.home];
      expect(Math.hypot(c.x - farm.x, c.z - farm.z)).toBeLessThan(4.2);
    }
    expect(p.filter((x) => x.follower)).toHaveLength(1);
    expect(p.find((x) => x.follower)?.kind).toBe(ANIMAL.dog);
  });
  it('scales with the settlement: a hamlet has few animals, a farmless town no chickens, a doorless one no cats', () => {
    expect(count(planAnimals(town(1), false), ANIMAL.dog)).toBe(1);
    expect(count(planAnimals(town(0, 5, 0, 4), false), ANIMAL.cat)).toBe(0);
    expect(count(planAnimals(town(2, 5, 0, 30), false), ANIMAL.chicken)).toBe(0);
    for (let id = 0; id < 20; id++) expect(count(planAnimals(town(0, id), false), ANIMAL.dog)).toBeLessThanOrEqual(1);
  });
  it('halves on Low', () => {
    for (let id = 1; id < 12; id++) {
      const hi = planAnimals(town(2, id), false);
      const lo = planAnimals(town(2, id), true);
      expect(lo.length).toBeLessThanOrEqual(Math.ceil(hi.length * 0.6));
      expect(count(lo, ANIMAL.dog)).toBe(1);
      expect(count(lo, ANIMAL.cat)).toBe(2);
    }
  });
  it('keeps a following dog a gap short of the visitor, on the line to it', () => {
    const g = followGoal(10, 0, 0, 0, 2.5);
    expect(g.arrived).toBe(false);
    expect(g.x).toBeCloseTo(2.5, 5);
    expect(g.z).toBeCloseTo(0, 5);
    expect(followGoal(2.6, 0, 0, 0, 2.5).arrived).toBe(true);
  });
  it('pecks in quick dips then looks up; trots on diagonals', () => {
    let dips = 0;
    let was = 0;
    for (let t = 0; t < 3.2; t += 0.02) {
      const v = peckPitch(t, 3.2);
      expect(v).toBeLessThanOrEqual(0);
      expect(v).toBeGreaterThan(-1);
      if (v < -0.5 && was >= -0.5) dips++;
      was = v;
    }
    expect(dips).toBe(2);
    expect(peckPitch(2.9, 3.2)).toBe(0);
    expect(trotLeg(1, 0)).toBeCloseTo(trotLeg(1, 3), 8);
    expect(trotLeg(1, 0)).toBeCloseTo(-trotLeg(1, 1), 8);
  });
});
