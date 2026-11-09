// Playtest 1 spell selection: the wheel cycles weapon → non-empty spell
// slots, the right button uses the selection, number keys still cast, and
// the weapon's secondary (parry/draw/charge/heavy) keeps its WP13 path.
import { describe, expect, it } from 'vitest';
import { InputFlag } from '@lodestone/contracts';
import { newMoveState } from '../sim/movement';
import { nextSelection, validSelection, WEAPON_SELECTED, WheelStepper } from './spellSelect';
import { CombatRuntime } from './runtime';
import { useCombatHud } from './store';

describe('selection order', () => {
  const spells = ['ember_flick', null, 'frost_bite', 'glint'];
  it('cycles weapon and the filled slots, both ways, wrapping', () => {
    let s = WEAPON_SELECTED;
    const seen = [];
    for (let i = 0; i < 5; i++) seen.push((s = nextSelection(s, spells, 1)));
    expect(seen).toEqual([0, 2, 3, -1, 0]);
    expect(nextSelection(-1, spells, -1)).toBe(3);
    expect(nextSelection(2, spells, -1)).toBe(0);
    expect(nextSelection(-1, [null, null, null, null], 1)).toBe(-1);
  });
  it('an emptied slot falls back to the weapon', () => {
    expect(validSelection(1, spells)).toBe(-1);
    expect(validSelection(2, spells)).toBe(2);
    expect(validSelection(7, spells)).toBe(-1);
  });
  it('the wheel steps once per notch, not per trackpad tick', () => {
    const w = new WheelStepper();
    expect(w.step(100, 0)).toBe(1);
    expect(w.step(100, 20)).toBe(0); // too soon after the last step
    expect(w.step(10, 100)).toBe(1); // accumulated past the threshold
    expect(w.step(20, 1000)).toBe(0);
    expect(w.step(20, 1010)).toBe(0);
    expect(w.step(-120, 1020)).toBe(-1);
  });
});

describe('right button uses the selection', () => {
  const rt = () => {
    const r = new CombatRuntime({ sendHitClaim: () => {}, sendInteract: () => {}, latestTick: () => 0, selfId: () => 1 });
    r.timeline.loadout = { weapon: 'sword', spells: ['ember_flick', null, 'frost_bite', null], gem: -1 };
    r.timeline.mana = 1000;
    r.timeline.manaMax = 1000;
    useCombatHud.getState().set({ selected: -1 });
    return r;
  };
  const step = (r: CombatRuntime, seq: number) => r.stepHook(seq, newMoveState({ x: 0, y: 0, z: 0 }), false);

  it('casts the selected slot', () => {
    const r = rt();
    expect(r.cycleSelection(1)).toBe(0);
    expect(r.cycleSelection(1)).toBe(2);
    r.useSelected();
    const out = step(r, 10);
    expect(out.flags & InputFlag.cast).toBeTruthy();
    expect(out.castSlot).toBe(2);
  });

  it('with the weapon selected it is the WP13 secondary (sword parry held)', () => {
    const r = rt();
    r.select(-1);
    r.useSelected();
    const out = step(r, 10);
    expect(out.flags & InputFlag.cast).toBeFalsy();
    expect(out.flags & InputFlag.alt_attack).toBeTruthy();
  });

  it('swapping to a loadout whose selected slot is empty falls back to the weapon', () => {
    const r = rt();
    r.select(2);
    expect(useCombatHud.getState().selected).toBe(2);
    useCombatHud.getState().set({ loadouts: [{ weapon: 'sword', spells: ['ember_flick', null, 'frost_bite', null], gem: -1 }, { weapon: 'bow', spells: [null, null, null, null], gem: -1 }] });
    r.swapLoadout();
    expect(useCombatHud.getState().selected).toBe(-1);
  });
});
