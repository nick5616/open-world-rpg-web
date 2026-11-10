import { describe, expect, it } from 'vitest';
import { COMBAT } from '@lodestone/contracts';
import { ELEMENT_COLOR, spellName } from '../skills/tree';
import { MOCK } from '../skills/dev';
import { BASE_TYPE_LABEL, cardStat, knownCards, SCHOOL_ICON, slotsHolding, spellCardData, spellKind } from './card';

const get = (k: string) => {
  const d = spellCardData(k);
  if (!d) throw new Error(`no card for ${k}`);
  return d;
};

describe('spell card data: every spell in combat.yaml', () => {
  for (const s of COMBAT.spells) {
    it(`${s.key}`, () => {
      const d = get(s.key);
      expect(d.id).toBe(s.id);
      expect(d.name).toBe(spellName(s.key));
      // School: the tree, its colour and a glyph.
      expect(d.school).toBe(s.tree);
      expect(COMBAT.elements).toContain(d.school);
      expect(d.color).toBe(ELEMENT_COLOR[s.tree]);
      expect(SCHOOL_ICON[d.school]).toBeTruthy();
      expect(d.schoolLabel.toLowerCase()).toBe(s.tree);
      // Type: a known delivery, and never empty.
      expect(BASE_TYPE_LABEL[s.type]).toBeTruthy();
      expect(d.kind.length).toBeGreaterThan(1);
      expect(d.tier).toBe(s.tier);
      // Mana: per cast, or per shot for a stream.
      expect(d.mana).toBe(s.auto ? `${s.auto.manaPerShot}/shot` : String(s.mana));
      // Damage (or what it does instead): always something to show.
      expect(d.stat.value).toBeTruthy();
      if (s.damage > 0 && s.damage < 99999) expect(d.stat.value.startsWith(String(s.damage))).toBe(true);
      expect(d.cooldown).toBe(s.cooldownMs > 0 ? `${Math.round(s.cooldownMs / 100) / 10}s` : '');
      expect(d.passive).toBe(s.type === 'passive');
    });
  }

  it('no unknown spell', () => {
    expect(spellCardData('no_such_spell')).toBeNull();
  });
});

describe('spell type (the headline on the card)', () => {
  const kind = (k: string) => get(k).kind;
  it('CR 020 mechanics win over the delivery', () => {
    for (const s of COMBAT.spells) {
      if (s.auto) expect(kind(s.key)).toBe('Stream');
      else if (s.summon) expect(kind(s.key)).toBe('Summon');
      else if (s.orbit) expect(kind(s.key)).toBe('Orbit');
      else if (s.homing) expect(kind(s.key)).toBe('Homing');
      else if (s.charge) expect(kind(s.key)).toBe('Charge');
      else if (s.detonate) expect(kind(s.key)).toBe(s.detonate.onDeath ? 'Brand' : 'Delayed burst');
    }
  });
  it('the named examples', () => {
    expect(kind('cinder_spray')).toBe('Stream');
    expect(get('cinder_spray').base).toBe('Projectile');
    expect(get('cinder_spray').mana).toBe('2/shot');
    expect(kind('starfall_hail')).toBe('Stream');
    expect(get('starfall_hail').traits).toContain('Rain');
    expect(kind('hungering_souls')).toBe('Homing');
    expect(kind('boulder_heave')).toBe('Charge');
    expect(get('boulder_heave').base).toBe('Lobbed');
    expect(kind('whirling_blades')).toBe('Orbit');
    expect(kind('wraith_hound')).toBe('Summon');
    expect(kind('pyre_brand')).toBe('Brand');
    expect(kind('seed_burst')).toBe('Volley');
    expect(kind('fireball')).toBe(BASE_TYPE_LABEL[COMBAT.spells.find((s) => s.key === 'fireball')!.type]);
    expect(kind('magma_dash')).toBe('Mobility');
    expect(kind('ice_wall')).toBe('Defensive');
  });
  it('every delivery type maps to a label (no raw keys on cards)', () => {
    for (const s of COMBAT.spells) expect(spellKind(s)).not.toBe(s.type);
  });
  it('the type list covers what Nicole named', () => {
    const kinds = new Set(COMBAT.spells.map((s) => spellKind(s)));
    for (const want of ['Projectile', 'Beam', 'AoE', 'Rune', 'Mobility', 'Defensive', 'Stream', 'Homing', 'Charge', 'Summon']) expect(kinds).toContain(want);
  });
});

describe('the headline number', () => {
  const stat = (k: string) => cardStat(COMBAT.spells.find((s) => s.key === k)!);
  it('damage, multi-hit, volleys, kills outright', () => {
    expect(stat('fireball')).toEqual({ label: 'Damage', value: String(COMBAT.spells.find((s) => s.key === 'fireball')!.damage) });
    expect(stat('seed_burst').value).toBe('9×3');
    expect(stat('whirling_blades').value).toBe('9×16');
    const kill = COMBAT.spells.find((s) => s.damage >= 99999);
    if (kill) expect(cardStat(kill).value).toBe('Kills');
  });
  it('damage-free spells say what they do', () => {
    expect(stat('ice_wall')).toEqual({ label: 'Shield', value: '120' });
    expect(stat('halo')).toEqual({ label: 'Heals', value: '40' });
    expect(stat('wraith_hound').label).toBe('Ally hits');
    expect(Number(stat('wraith_hound').value)).toBeGreaterThan(0);
    expect(stat('sunstep')).toEqual({ label: 'Utility', value: '—' });
  });
});

describe('the grid and the slots', () => {
  it('known castable spells only, by school then tier', () => {
    const cards = knownCards(MOCK.known);
    expect(cards.every((c) => !c.passive)).toBe(true);
    expect(cards.map((c) => c.key)).not.toContain('kindling');
    expect(cards.length).toBe(MOCK.known.filter((k) => COMBAT.spells.find((s) => s.key === k)!.type !== 'passive').length);
    const order = cards.map((c) => COMBAT.elements.indexOf(c.school) * 100 + c.tier);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it('which slots hold a spell', () => {
    expect(slotsHolding('fireball', MOCK.loadouts)).toEqual(['loadout 1 slot 1']);
    expect(slotsHolding('kindling', MOCK.loadouts)).toEqual([]);
    expect(slotsHolding('glint', [{ spells: ['glint', null, null, null] }, { spells: [null, null, 'glint', null] }])).toEqual(['loadout 1 slot 1', 'loadout 2 slot 3']);
  });
});
