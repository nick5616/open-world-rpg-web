import { describe, expect, it } from 'vitest';
import { ANIMAL, planAnimals } from './animalsPlan';
import { CAT_NAMES, DOG_NAMES, animalName, nameAll, ownerLine, ownerOf, petPrompt } from './animalNames';

describe('animal names', () => {
  it('are deterministic per settlement and animal', () => {
    expect(animalName(ANIMAL.dog, 77, 3)).toBe(animalName(ANIMAL.dog, 77, 3));
    expect(DOG_NAMES).toContain(animalName(ANIMAL.dog, 77, 3));
    expect(CAT_NAMES).toContain(animalName(ANIMAL.cat, 77, 3));
    expect(animalName(ANIMAL.chicken, 77, 3)).toBe('');
  });
  it('differ between towns (not one list order everywhere)', () => {
    const seen = new Set<string>();
    for (let id = 1; id <= 60; id++) seen.add(animalName(ANIMAL.dog, id, 0));
    expect(seen.size).toBeGreaterThan(12);
  });
  it('never repeat inside one settlement', () => {
    for (let id = 1; id <= 200; id++) {
      const plan = planAnimals({ id, size: 2, x: 0, z: 0, farms: [{ x: 5, z: 5 }], doors: Array.from({ length: 30 }, (_, i) => ({ x: i, z: 0 })) }, false);
      const names = nameAll(plan.map((p) => p.kind), id);
      for (const kind of [ANIMAL.dog, ANIMAL.cat]) {
        const list = names.filter((_, i) => plan[i].kind === kind);
        expect(new Set(list).size).toBe(list.length);
        expect(list.every((n) => n.length > 0)).toBe(true);
      }
    }
  });
  it('probes past taken names', () => {
    const first = animalName(ANIMAL.dog, 5, 0);
    expect(animalName(ANIMAL.dog, 5, 0, new Set([first]))).not.toBe(first);
  });
  it('pick an owner in range', () => {
    expect(ownerOf(9, 0, 0)).toBe(-1);
    for (let i = 0; i < 20; i++) expect(ownerOf(9, i, 7)).toBeLessThan(7);
  });
  it('are spoken by their owners', () => {
    expect(ownerLine(ANIMAL.dog, 'Biscuit', false, 1)).toContain('Biscuit');
    expect(ownerLine(ANIMAL.dog, 'Biscuit', true, 2)).toContain('Biscuit');
    expect(ownerLine(ANIMAL.cat, 'Soot', true, 3)).toContain('Soot');
    expect(ownerLine(ANIMAL.cat, 'Soot', false, 3)).not.toContain('{n}');
  });
  it('word the E prompt', () => {
    expect(petPrompt(ANIMAL.dog, 'Biscuit')).toBe('[E] Pet Biscuit');
    expect(petPrompt(ANIMAL.cat, '')).toBe('[E] Pet the cat');
  });
});
