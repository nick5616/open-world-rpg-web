import { describe, expect, it } from 'vitest';
import { COMBAT } from '@lodestone/contracts';
import { weaponOfMove, weaponShotFamily, weaponShotRadius, weaponShotVisual } from './weaponShot';
import { ELEMENT_FAMILY } from './spellVisual';

describe('shared basic attacks: weapon shot visuals', () => {
  it('maps every shooting weapon move to its weapon (the move id is what Event 214 carries)', () => {
    const shots = COMBAT.moves.filter((m) => m.speed > 0);
    expect(shots.length).toBeGreaterThanOrEqual(4); // bow quick / charged, staff bolt, wand bolt
    for (const m of shots) expect(weaponOfMove(m.id)).toBe(m.weapon === 'bow' || m.weapon === 'staff' || m.weapon === 'wand' ? m.weapon : 'other');
    expect(weaponOfMove(502)).toBe('wand');
    expect(weaponOfMove(402)).toBe('staff');
    expect(weaponOfMove(302)).toBe('bow');
    expect(weaponOfMove(101)).toBe('other'); // a sword slash
    expect(weaponOfMove(1005)).toBeNull(); // a spell (fireball) is not a weapon move
  });

  it('a wand or staff bolt is a magic bolt in its gem element (arcane without one); an arrow a needle', () => {
    expect(weaponShotVisual('wand', -1).look).toBe('orb');
    expect(weaponShotVisual('wand', -1).family).toBe('crystal');
    expect(weaponShotVisual('staff', -1).look).toBe('orb');
    expect(weaponShotVisual('bow', -1).look).toBe('needle');
    expect(weaponShotVisual('bow', -1).family).toBe('steel');
    ELEMENT_FAMILY.forEach((fam, gem) => {
      if (fam === 'steel') return;
      expect(weaponShotFamily('wand', gem)).toBe(fam);
      expect(weaponShotVisual('bow', gem).family).toBe(fam);
    });
    // basic attacks stay quiet next to spells: no pooled light per shot
    for (const w of ['wand', 'staff', 'bow'] as const) expect(weaponShotVisual(w, 0).weight).toBe('minor');
  });

  it('is one cached object per weapon and element (yours and everyone else\'s are the same visual)', () => {
    expect(weaponShotVisual('wand', 0)).toBe(weaponShotVisual('wand', 0));
    expect(weaponShotVisual('wand', 0)).not.toBe(weaponShotVisual('staff', 0));
  });

  it('magic bolts are drawn big enough to read at range; arrows stay thin', () => {
    const wand = COMBAT.moves.find((m) => m.key === 'wand_bolt')!;
    const staff = COMBAT.moves.find((m) => m.key === 'staff_bolt')!;
    const bow = COMBAT.moves.find((m) => m.key === 'bow_charged')!;
    expect(weaponShotRadius('wand', wand.radius)).toBeGreaterThan(wand.radius);
    expect(weaponShotRadius('staff', staff.radius)).toBeGreaterThan(weaponShotRadius('wand', wand.radius));
    expect(weaponShotRadius('bow', bow.radius)).toBe(bow.radius);
  });
});
