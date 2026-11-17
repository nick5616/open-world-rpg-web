// CR 048: the magma dash grows with the character level (a lesser dash first).
import { describe, expect, it } from 'vitest';
import { COMBAT, InputFlag, yawToU16, pitchToI16 } from '@lodestone/contracts';
import { FlatGround } from '../sim/ground';
import { newMoveState, stepMovement, type MoveState } from '../sim/movement';
import { CombatTimeline, type CombatButtons } from './timeline';
import { resolveDash } from './dashes';
import { spellFacts } from '../ui/skills/tree';

const key = (k: string) => COMBAT.dashes.find((d) => d.key === k)!;
const magma = COMBAT.spells.find((s) => s.key === 'magma_dash')!;
const g = new FlatGround(0);

describe('magma dash tiers (CR 048)', () => {
  it('level 1 is lesser, honed from 8, the full dash from 15', () => {
    expect(resolveDash(magma.dash, 1)).toBe(key('magma_dash_lesser').id);
    expect(resolveDash(magma.dash, 7)).toBe(key('magma_dash_lesser').id);
    expect(resolveDash(magma.dash, 8)).toBe(key('magma_dash_honed').id);
    expect(resolveDash(magma.dash, 14)).toBe(key('magma_dash_honed').id);
    expect(resolveDash(magma.dash, 15)).toBe(key('magma_dash').id);
    expect(resolveDash(magma.dash, 60)).toBe(key('magma_dash').id);
    // An untiered dash is itself.
    const glacier = key('glacier_step');
    expect(resolveDash(glacier.id, 1)).toBe(glacier.id);
  });

  it('the lesser dash is shorter, steered not flown, and costs more to hold', () => {
    const [lesser, honed, full] = [key('magma_dash_lesser'), key('magma_dash_honed'), key('magma_dash')];
    expect(lesser.speed * lesser.steps).toBeLessThan(honed.speed * honed.steps);
    expect(honed.speed * honed.steps).toBeLessThan(full.speed * full.steps);
    expect(lesser.sustain!.kind).toBe('dash');
    expect(full.sustain!.kind).toBe('jet');
    expect(lesser.sustain!.manaPerS).toBeGreaterThan(honed.sustain!.manaPerS);
    expect(honed.sustain!.manaPerS).toBeGreaterThan(full.sustain!.manaPerS);
  });

  const heightAfterHold = (id: number): number => {
    let s: MoveState = newMoveState({ x: 100, y: 0, z: 100 });
    const pitch = pitchToI16(0.6);
    s = stepMovement(s, { flags: InputFlag.dodge, yaw: yawToU16(0), pitch, castSlot: id }, g);
    for (let i = 0; i < 90; i++) s = stepMovement(s, { flags: InputFlag.channel, yaw: yawToU16(0), pitch, castSlot: id }, g);
    return s.pos.y;
  };

  it('holding the lesser dash does not fly where the full dash does', () => {
    const lesser = heightAfterHold(key('magma_dash_lesser').id);
    const full = heightAfterHold(key('magma_dash').id);
    expect(full).toBeGreaterThan(20);
    expect(lesser).toBeLessThan(full / 3);
  });

  it('the timeline names the variant for its character level', () => {
    const idle = (): CombatButtons => ({ attackDown: false, altDown: false, attackPress: 0, altPress: 0, altRelease: 0, dodgePress: 0, castPress: [null, null, 0, null], formPress: 0, techniquePress: 0, drinkPress: 0, castHeld: [false, false, false, false] });
    for (const [level, want] of [[1, 'magma_dash_lesser'], [10, 'magma_dash_honed'], [20, 'magma_dash']] as const) {
      const t = new CombatTimeline();
      t.charLevel = level;
      const out = t.step(1, idle(), newMoveState({ x: 100, y: 0, z: 100 }), 0, 0);
      expect(out.castSlot, `level ${level}`).toBe(key(want).id);
    }
  });

  it('the tooltip names the tier and what the next needs', () => {
    const at = (level: number) => spellFacts(magma, level).find((f) => f.label === 'Tier')!.value;
    expect(at(1)).toBe('Lesser (Honed at level 8)');
    expect(at(8)).toBe('Honed (Full at level 15)');
    expect(at(15)).toBe('Full (best)');
  });
});
