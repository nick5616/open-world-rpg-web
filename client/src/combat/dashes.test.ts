// CR 021: held dashes in the client timeline (dashes.ts) driving the shared
// step (sim/dash.ts) the way LocalSim does.
import { describe, expect, it } from 'vitest';
import { COMBAT, InputFlag, yawToU16 } from '@lodestone/contracts';
import { FlatGround } from '../sim/ground';
import { newMoveState, stepMovement, type MoveState } from '../sim/movement';
import { CombatTimeline, type CombatButtons } from './timeline';
import { holdManaPerStep } from './dashes';

const idle = (held = false): CombatButtons => ({ attackDown: false, altDown: false, attackPress: 0, altPress: 0, altRelease: 0, dodgePress: 0, castPress: [null, null, null, null], formPress: 0, techniquePress: 0, drinkPress: 0, castHeld: [false, false, held, false] });
const g = new FlatGround(0);

/** Runs the timeline + shared step like LocalSim; returns the frames it produced. */
function fly(t: CombatTimeline, steps: number, heldFor: number, pitch = 0) {
  let s: MoveState = newMoveState({ x: 100, y: 0, z: 100 });
  const frames: { flags: number; castSlot: number }[] = [];
  for (let seq = 1; seq <= steps; seq++) {
    const b = idle(seq <= heldFor);
    if (seq === 1) b.castPress[2] = 0;
    t.manaRegenPerStep = 0;
    const out = t.step(seq, b, s, 0, 0);
    frames.push({ flags: out.flags, castSlot: out.castSlot });
    s = stepMovement(s, { flags: out.flags, yaw: yawToU16(0), pitch: Math.round(pitch * 20860), castSlot: out.castSlot }, g);
  }
  return { frames, s };
}

describe('held dashes in the timeline (CR 021)', () => {
  const jet = COMBAT.dashes.find((d) => d.key === 'magma_dash')!;
  const spell = COMBAT.spells.find((s) => s.key === 'magma_dash')!;

  it('names the dash every step, holds it with channel while the key is down, and pays mana per step', () => {
    const t = new CombatTimeline(); // the start loadout has Magma Dash in slot 3
    t.mana = 100;
    const { frames, s } = fly(t, 80, 61, 0.5);
    expect(frames[0].flags & InputFlag.dodge).toBeTruthy();
    expect(frames[0].castSlot).toBe(jet.id);
    const held = frames.filter((f) => (f.flags & InputFlag.channel) !== 0);
    expect(held.length).toBe(60);
    expect(frames.slice(1, 61).every((f) => f.castSlot === jet.id && (f.flags & InputFlag.channel) !== 0)).toBe(true);
    expect(t.mana).toBeCloseTo(100 - spell.mana - 60 * holdManaPerStep(jet), 6);
    // released: the carry still names the variant, never holds again
    expect(frames.slice(61, 61 + jet.sustain!.carrySteps).every((f) => f.castSlot === jet.id && (f.flags & InputFlag.channel) === 0)).toBe(true);
    expect(frames.slice(70).every((f) => f.castSlot === 0)).toBe(true);
    expect(s.dash).toBe(0);
  });

  it('stops holding when the predicted mana runs out', () => {
    const t = new CombatTimeline();
    t.mana = spell.mana + 10 * holdManaPerStep(jet) + 1e-9;
    const { frames } = fly(t, 40, 40);
    expect(frames.filter((f) => (f.flags & InputFlag.channel) !== 0).length).toBe(10);
  });

  it('a tap is the plain dash: no hold, castSlot only through the dash', () => {
    const t = new CombatTimeline();
    t.mana = 100;
    const { frames } = fly(t, 30, 0);
    expect(frames.some((f) => (f.flags & InputFlag.channel) !== 0)).toBe(false);
    expect(frames.slice(1, jet.steps).every((f) => f.castSlot === jet.id)).toBe(true);
  });
});
