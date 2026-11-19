// CR 039 ("Hotbar slots"): the slot and loadout table, the castSlot wire
// mapping (the zone's combat.CastSlotOf), combat_sync v2, the rebindable
// keys and the fanfare / hotbar card.

import { beforeEach, describe, expect, it } from 'vitest';
import { COMBAT } from '@lodestone/contracts';
import { DEFAULT_KEYS, _resetForTest, castSlotOf, hotbarKey, hotbarLines, keyName, loadoutsOpen, slotForKey, slotForEvent, setHotbarKey, slotLevel, spellSlotOf, spellSlots } from './hotbar';
import { decodeSync } from './events';
import { takenBy } from './HotbarKeys';
import { gainLines } from '../ui/progression/gains';
import { reduceProgressionEvent } from '../ui/progression/store';
import { encodeStats, PEV, STATS_REASON } from '../ui/progression/events';
import { eqDisplay, mainLoadout, EQ_SLOTS } from '../ui/inventory/items';

describe('hotbar slots by level', () => {
  it('opens a spell slot every ten levels up to eight, a third loadout at 20', () => {
    const rows = [1, 9, 10, 19, 20, 30, 39, 40, 60].map((l) => [l, spellSlots(l), loadoutsOpen(l)]);
    expect(rows).toEqual([
      [1, 4, 2],
      [9, 4, 2],
      [10, 5, 2],
      [19, 5, 2],
      [20, 6, 3],
      [30, 7, 3],
      [39, 7, 3],
      [40, 8, 3],
      [60, 8, 3],
    ]);
    expect([0, 3, 4, 5, 6, 7].map(slotLevel)).toEqual([1, 1, 10, 20, 30, 40]);
    expect(COMBAT.start.loadouts.map((l) => l.weapon)).toEqual(['sword', 'staff', 'bow']);
  });

  it('sends slots 5-8 as castSlot 6-9, past the form (4) and the technique (5)', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(castSlotOf)).toEqual([0, 1, 2, 3, 6, 7, 8, 9]);
    for (let i = 0; i < 8; i++) expect(spellSlotOf(castSlotOf(i))).toBe(i);
    expect([4, 5, 10].map(spellSlotOf)).toEqual([-1, -1, -1]);
  });
});

describe('combat_sync v2', () => {
  const u16 = (v: number) => [v & 0xff, v >> 8];
  it('decodes three loadouts of eight and the open counts', () => {
    const b: number[] = [2, 2, 3, 8];
    for (let l = 0; l < 3; l++) {
      b.push([1, 4, 3][l] ?? 1); // weapon ids: sword, staff, bow (combat.yaml ids)
      for (let k = 0; k < 8; k++) b.push(...u16(l === 2 && k === 5 ? 1001 : 0));
      b.push(0xff);
    }
    b.push(...u16(1), ...u16(1001));
    b.push(0);
    b.push(...u16(1000), 3, ...u16(2), 23, 6, 3, 0, 0, 0);
    const s = decodeSync(new Uint8Array(b))!;
    expect(s.active).toBe(2);
    expect(s.loadouts).toHaveLength(3);
    expect(s.loadouts[2].spells).toHaveLength(8);
    expect(s.loadouts[2].spells[5]).toBe('ember_flick');
    expect(s.level).toBe(23);
    expect(s.slotsOpen).toBe(6);
    expect(s.loadoutsOpen).toBe(3);
  });
});

describe('slot keys', () => {
  beforeEach(() => _resetForTest());
  it('defaults to 1-4 then - [ ] \\, clear of the whistle, the pet, the torch, the hammer and the work tool (5-9, =)', () => {
    expect(DEFAULT_KEYS.map(keyName)).toEqual(['1', '2', '3', '4', '-', '[', ']', '\\']);
    expect(slotForKey('Minus')).toBe(4);
    for (const k of ['Digit8', 'Digit9', 'Equal']) expect(slotForKey(k)).toBe(-1);
    expect(slotForKey('Digit5')).toBe(-1);
    expect(slotForEvent({ code: 'Digit7', key: '/' } as KeyboardEvent)).toBe(-1);
  });
  it('rebinds: a free key, a swap with another slot, refusals for keys the world uses', () => {
    expect(setHotbarKey(4, 'Mouse3', takenBy)).toBeNull();
    expect(keyName(hotbarKey(4))).toBe('Mouse back');
    expect(setHotbarKey(0, 'BracketLeft', takenBy)).toBeNull(); // slot 6's key: they swap
    expect([hotbarKey(0), hotbarKey(5)]).toEqual(['BracketLeft', 'Digit1']);
    expect(setHotbarKey(6, 'KeyE', takenBy)).toMatch(/talk|trade|E/i);
    expect(setHotbarKey(6, 'Digit5', takenBy)).toMatch(/whistle/);
    expect(setHotbarKey(6, 'KeyW', takenBy)).toMatch(/forward/);
    expect(setHotbarKey(6, 'Escape', takenBy)).toMatch(/menu/);
    expect(hotbarKey(6)).toBe('BracketRight');
  });
});

describe('the fanfare and the hotbar card', () => {
  beforeEach(() => _resetForTest());
  it('says "New spell slot!" at 10 and "New weapon loadout!" at 20, first', () => {
    expect(gainLines(9, 10)[0]).toBe('New spell slot! Slot 5 (-)');
    expect(gainLines(19, 20).slice(0, 2)).toEqual(['New spell slot! Slot 6 ([)', 'New weapon loadout! Loadout 3 (X cycles)']);
    expect(gainLines(10, 11).some((l) => l.startsWith('New'))).toBe(false);
    expect(hotbarLines(1, 23)).toHaveLength(3);
  });
  it("a migrated character's join (Event 900 reason 3) shows only its hotbar news", () => {
    const st = { reason: STATS_REASON.hotbar, level: 23, prevLevel: 1, xp: 0n, xpInto: 0, xpNext: 100, healthMax: 100, manaMax: 100, staminaMax: 100, damagePct: 0, skillFree: 0, skillTotal: 0, attunedCount: 0 };
    const ev = { kind: PEV.characterStats, entityId: 1, targetId: 3, value: 23, x: 0, y: 0, z: 0, data: encodeStats(st) };
    const base = { stats: null, area: null, fanfare: null, notices: [], attuned: null, panelOpen: false, actions: null };
    const p = reduceProgressionEvent(base, ev as never, 1000)!;
    expect(p.fanfare?.hotbar).toBe(true);
    expect(p.fanfare?.lines).toEqual(['New spell slot! Slot 5 (-)', 'New spell slot! Slot 6 ([)', 'New weapon loadout! Loadout 3 (X cycles)']);
  });
});

describe('the third main hand', () => {
  it('appends eq:main2 to the unequip order and shows it only when open', () => {
    expect(EQ_SLOTS.indexOf('eq:main2')).toBe(5);
    expect(eqDisplay(2)).toEqual(['eq:main0', 'eq:main1', 'eq:head', 'eq:body', 'eq:legs']);
    expect(eqDisplay(3)).toEqual(['eq:main0', 'eq:main1', 'eq:main2', 'eq:head', 'eq:body', 'eq:legs']);
    expect(['eq:main2', 'eq:head'].map(mainLoadout)).toEqual([2, -1]);
  });
});
