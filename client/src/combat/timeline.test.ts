// The client combat timeline against the spec 8 feel targets (in steps; the
// real-time version is the headless probe run) and the start rules the zone
// mirrors (server/zone/internal/combat/player.go).
import { describe, expect, it } from 'vitest';
import { COMBAT, INPUT_BUFFER_MS, InputFlag, LIGHT_RECOVERY_MAX_MS, LIGHT_STARTUP_MAX_MS, MOVE_STEP_HZ, ENEMY_WINDUP_MAX_MS, ENEMY_WINDUP_MIN_MS } from '@lodestone/contracts';
import { newMoveState } from '../sim/movement';
import { BUFFER_STEPS, CombatTimeline, shotRange, shotSpeed, type CombatButtons } from './timeline';
import { decodeSync, enemyInfo } from './events';
import { inCone } from './runtime';

const ms = (steps: number) => (steps * 1000) / MOVE_STEP_HZ;
const idle = (): CombatButtons => ({ attackDown: false, altDown: false, attackPress: 0, altPress: 0, altRelease: 0, dodgePress: 0, castPress: [null, null, null, null], castHeld: [false, false, false, false], formPress: 0, techniquePress: 0, drinkPress: 0 });

function run(t: CombatTimeline, from: number, steps: number, at: Record<number, Partial<CombatButtons>> = {}) {
  const st = newMoveState({ x: 0, y: 0, z: 0 });
  const out = [];
  for (let i = 0; i < steps; i++) {
    const seq = from + i;
    out.push({ seq, ...t.step(seq, { ...idle(), ...(at[seq] ?? {}) }, st, 0, seq * 16.67) });
  }
  return out;
}

describe('feel targets in the tables', () => {
  it('every light move starts within 100 ms and recovers within 250 ms', () => {
    for (const m of COMBAT.moves.filter((x) => x.kind === 'light')) {
      expect(ms(m.startupSteps), m.key).toBeLessThanOrEqual(LIGHT_STARTUP_MAX_MS);
      expect(ms(m.recoverySteps), m.key).toBeLessThanOrEqual(LIGHT_RECOVERY_MAX_MS);
    }
  });
  it('every enemy wind-up is 300-600 ms', () => {
    for (const a of COMBAT.enemyAttacks) {
      expect(ms(a.windupSteps), a.key).toBeGreaterThanOrEqual(ENEMY_WINDUP_MIN_MS);
      expect(ms(a.windupSteps), a.key).toBeLessThanOrEqual(ENEMY_WINDUP_MAX_MS);
    }
  });
  it('the input buffer is 150 ms', () => expect(ms(BUFFER_STEPS)).toBe(INPUT_BUFFER_MS));
});

describe('timeline', () => {
  it('a press starts the attack on the very next step, combos chain', () => {
    const t = new CombatTimeline();
    const out = run(t, 1, 80, { 1: { attackPress: 1 }, 20: { attackPress: 1 }, 40: { attackPress: 1 } });
    const starts = out.filter((o) => o.started);
    expect(starts[0].seq).toBe(1);
    expect(starts.map((o) => o.started!.move!.key)).toEqual(['sword_slash_1', 'sword_slash_2', 'sword_slash_3']);
    expect(starts.every((o) => (o.flags & InputFlag.attack) !== 0)).toBe(true);
  });

  it('a press during recovery is buffered and fires on the first legal step (never lost)', () => {
    const t = new CombatTimeline();
    const m = COMBAT.moves.find((x) => x.key === 'sword_slash_1')!;
    const total = m.startupSteps + m.activeSteps + m.recoverySteps;
    const pressAt = 1 + total - 5; // 5 steps before the move ends: inside the buffer
    const out = run(t, 1, 60, { 1: { attackPress: 1 }, [pressAt]: { attackPress: 1 } });
    const starts = out.filter((o) => o.started);
    expect(starts.length).toBe(2);
    expect(starts[1].seq).toBe(1 + total);
  });

  it('a dodge after the hit frames cancels the recovery', () => {
    const t = new CombatTimeline();
    const m = COMBAT.moves.find((x) => x.key === 'sword_slash_1')!;
    const activeEnd = 1 + m.startupSteps + m.activeSteps;
    const out = run(t, 1, 60, { 1: { attackPress: 1 }, [activeEnd]: { dodgePress: 1 }, [activeEnd + 1]: { attackPress: 1 } });
    expect(out.find((o) => o.seq === activeEnd)!.flags & InputFlag.dodge).toBeTruthy();
    const second = out.filter((o) => o.started)[1];
    expect(second.seq).toBe(activeEnd + 1);
    expect(second.seq).toBeLessThan(activeEnd + m.recoverySteps);
  });

  it('spells respect cooldown and mana; mobility spells become a dash variant', () => {
    const t = new CombatTimeline();
    const out = run(t, 1, 10, { 1: { castPress: [1, null, null, null] }, 2: { castPress: [2, null, null, null] }, 5: { castPress: [null, null, 5, null] } });
    expect(out[0].flags & InputFlag.cast).toBeTruthy();
    expect(out[0].castSlot).toBe(0);
    expect(out[1].started).toBeNull(); // cooldown: buffered
    const dash = out.find((o) => o.seq === 5)!;
    expect(dash.flags & InputFlag.dodge).toBeTruthy();
    expect(dash.castSlot).toBe(COMBAT.spells.find((s) => s.key === 'magma_dash')!.dash);
  });

  // CR 033 (playtest 2 bow rework): the primary draws, letting go looses.
  const bowT = () => {
    const t = new CombatTimeline();
    t.loadout = { weapon: 'bow', spells: [null, null, null, null], gem: -1 };
    return t;
  };
  const bowCharged = COMBAT.moves.find((m) => m.key === 'bow_charged')!;
  const lmb = (from: number, to: number, extra: Record<number, Partial<CombatButtons>> = {}) => {
    const at: Record<number, Partial<CombatButtons>> = {};
    for (let s = from; s <= to; s++) at[s] = { attackDown: true, attackPress: s === from ? 1 : 0 };
    return { ...at, ...extra };
  };

  it('bow: holding the primary draws (the alt_attack bit), letting go looses a charged shot', () => {
    expect(bowCharged.chargeSteps).toBe(60); // 1 s to full draw
    const t = bowT();
    const out = run(t, 1, 80, lmb(1, 60));
    for (let s = 1; s <= 60; s++) {
      expect(out[s - 1].flags & InputFlag.alt_attack, `step ${s}`).toBeTruthy();
      expect(out[s - 1].started, `nothing shoots while drawing (step ${s})`).toBeNull();
    }
    const shots = out.filter((o) => o.started);
    expect(shots.length).toBe(1);
    expect(shots[0].seq).toBe(61);
    expect(shots[0].started!.move!.key).toBe('bow_charged');
    expect(shots[0].started!.charge).toBe(1);
    expect(shots[0].flags & InputFlag.alt_attack).toBe(0);
    expect(shots[0].flags & InputFlag.attack).toBeTruthy();
  });

  it('bow: the draw scales with the hold, and the view reads it', () => {
    const t = bowT();
    const out = run(t, 1, 40, lmb(1, 30));
    const shot = out.find((o) => o.started)!;
    expect(shot.seq).toBe(31);
    expect(shot.started!.charge).toBeCloseTo(0.5, 9);
    const u = bowT();
    run(u, 1, 45, lmb(1, 45));
    expect(u.drawFrac).toBeCloseTo(45 / 60, 9);
    expect(u.heldSteps).toBe(45);
    run(u, 46, 30, lmb(46, 75));
    expect(u.drawFrac).toBe(1); // capped at full draw
  });

  it('bow: a tap draws the minimum, then looses a weak shot (never an instant one)', () => {
    const min = bowCharged.minChargeSteps!;
    expect(min).toBe(9); // 150 ms
    const t = bowT();
    const out = run(t, 1, 30, { 1: { attackPress: 1 } }); // pressed and released inside one step
    const shot = out.find((o) => o.started)!;
    expect(shot.seq).toBe(1 + min);
    expect(shot.started!.charge).toBeCloseTo(min / 60, 9);
    expect(out.slice(0, min).every((o) => (o.flags & InputFlag.alt_attack) !== 0)).toBe(true);
    // No bow press ever starts the light move (the zone refuses it).
    expect(out.some((o) => o.started?.move?.kind === 'light')).toBe(false);
  });

  it('bow: a draw held through the last shot recovery starts after it (the release is never lost)', () => {
    const t = bowT();
    const rec = bowCharged.startupSteps + bowCharged.activeSteps + bowCharged.recoverySteps;
    // Shoot at 21, press again at once and hold 30 more steps.
    const out = run(t, 1, 120, { ...lmb(1, 20), ...lmb(22, 60) });
    const shots = out.filter((o) => o.started);
    expect(shots.map((o) => o.seq)).toEqual([21, 61]);
    const nextDraw = 21 + rec;
    expect(out.find((o) => o.seq === nextDraw - 1)!.flags & InputFlag.alt_attack).toBe(0); // still recovering: no draw
    expect(out.find((o) => o.seq === nextDraw)!.flags & InputFlag.alt_attack).toBeTruthy();
    expect(shots[1].started!.charge).toBeCloseTo((61 - nextDraw) / 60, 9);
  });

  it('bow: the secondary (Z) lowers the draw without shooting; the next press draws again', () => {
    const t = bowT();
    const out = run(t, 1, 90, { ...lmb(1, 40, { 20: { attackDown: true, altPress: 1, altDown: true } }), 41: { altRelease: 1 }, ...lmb(50, 70) });
    expect(out.find((o) => o.seq === 20)!.drawCancelled).toBe(true);
    expect(out.filter((o) => o.seq >= 20 && o.seq <= 49).every((o) => (o.flags & InputFlag.alt_attack) === 0 && !o.started)).toBe(true);
    const shots = out.filter((o) => o.started);
    expect(shots.map((o) => o.seq)).toEqual([71]);
    expect(shots[0].started!.charge).toBeCloseTo(21 / 60, 9);
  });

  it('bow: the shot speed and reach follow the draw like the zone (combat.ShotSpeed / ShotRange)', () => {
    expect(shotSpeed(bowCharged, 0)).toBe(bowCharged.speed);
    expect(shotSpeed(bowCharged, 1)).toBe(bowCharged.chargeSpeed);
    expect(shotRange(bowCharged, 1)).toBe(bowCharged.reach);
    expect(shotRange(bowCharged, 9 / 60)).toBeCloseTo((bowCharged.reach * (45 + 30 * 0.15)) / 75, 9);
    const spear = COMBAT.moves.find((m) => m.key === 'spear_charged')!;
    expect(shotRange(spear, 1)).toBe(spear.reach);
  });

  it('spear: the secondary still charges and the primary still thrusts', () => {
    const t = new CombatTimeline();
    t.loadout = { weapon: 'spear', spells: [null, null, null, null], gem: -1 };
    const hold: Record<number, Partial<CombatButtons>> = {};
    for (let s = 1; s <= 30; s++) hold[s] = { altDown: true, altPress: s === 1 ? 1 : 0 };
    hold[31] = { altRelease: 1 };
    hold[80] = { attackPress: 1 };
    const out = run(t, 1, 90, hold);
    expect(out.filter((o) => o.started).map((o) => o.started!.move!.key)).toEqual(['spear_charged', 'spear_thrust']);
  });

  it('a downed player starts nothing', () => {
    const t = new CombatTimeline();
    t.downed = true;
    expect(run(t, 1, 5, { 1: { attackPress: 1 } }).some((o) => o.started)).toBe(false);
  });
});

describe('wire helpers', () => {
  it('unpacks enemy typeIds', () => {
    const boar = COMBAT.enemies.find((e) => e.key === 'boar')!;
    const info = enemyInfo({ typeId: boar.id | ((0 + 1) << 8) | (2 << 12) });
    expect(info.key).toBe('boar');
    expect(info.element).toBe(0);
    expect(info.affix).toBe(2);
  });
  it('decodes combat_sync', () => {
    const b: number[] = [1, 1];
    for (let l = 0; l < 2; l++) {
      b.push(l === 0 ? 1 : 4);
      for (let k = 0; k < 4; k++) b.push(k === 0 ? 1001 & 0xff : 0, k === 0 ? 1001 >> 8 : 0);
      b.push(0xff);
    }
    b.push(1, 0, 1001 & 0xff, 1001 >> 8);
    b.push(1, 1, 50, 0, 0, 0);
    b.push(1000 & 0xff, 1000 >> 8, 3, 2, 0, 1);
    const s = decodeSync(new Uint8Array(b))!;
    expect(s.active).toBe(1);
    expect(s.loadouts[1].weapon).toBe('staff');
    expect(s.loadouts[0].spells[0]).toBe('ember_flick');
    expect(s.known).toEqual(['ember_flick']);
    expect(s.skillXp.swordsmanship).toBe(50);
    expect(s.manaMax).toBe(100);
    expect(s.charges).toBe(3);
  });
  it('melee cones', () => {
    expect(inCone({ x: 0, z: 0 }, 0, 3, 110, { x: 0, z: -2 })).toBe(true);
    expect(inCone({ x: 0, z: 0 }, 0, 3, 110, { x: 0, z: 2 })).toBe(false);
  });
});
