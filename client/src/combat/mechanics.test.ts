// CR 020 spell mechanics on the client: the timeline's streams and charges
// (the zone's twin is server/zone/internal/combat/stream.go; mechanics_test.go
// pins the same numbers there), the avatar poses and the skill tree facts.
import { describe, expect, it } from 'vitest';
import { COMBAT, InputFlag } from '@lodestone/contracts';
import { newMoveState } from '../sim/movement';
import { CombatTimeline, type CombatButtons, type StepOut } from './timeline';
import { classifyChannel } from '../net/avatarAnim';
import { spellFacts, spellByKey } from '../ui/skills/tree';

const idle = (): CombatButtons => ({ attackDown: false, altDown: false, attackPress: 0, altPress: 0, altRelease: 0, dodgePress: 0, castPress: [null, null, null, null], castHeld: [false, false, false, false], formPress: 0, techniquePress: 0, drinkPress: 0 });
const sp = (k: string) => COMBAT.spells.find((s) => s.key === k)!;

function timeline(key: string): CombatTimeline {
  const t = new CombatTimeline();
  t.loadout = { weapon: 'staff', spells: [key, null, null, null], gem: -1 };
  t.mana = t.manaMax = 1000;
  t.manaRegenPerStep = 0;
  return t;
}

/** Runs steps from seq 1; `held(seq)` says whether slot 0 is held, `extra(seq)` adds presses. */
function run(t: CombatTimeline, steps: number, held: (seq: number) => boolean, extra: (seq: number) => Partial<CombatButtons> = () => ({})): (StepOut & { seq: number })[] {
  const st = newMoveState({ x: 0, y: 0, z: 0 });
  const out: (StepOut & { seq: number })[] = [];
  let was = false;
  for (let seq = 1; seq <= steps; seq++) {
    const h = held(seq);
    const b = { ...idle(), castHeld: [h, false, false, false], ...extra(seq) };
    if (h && !was) b.castPress = [seq * 16, null, null, null];
    was = h;
    out.push({ seq, ...t.step(seq, b, st, 0, seq * 16) });
  }
  return out;
}

describe('hold-to-fire streams (CR 020)', () => {
  it('fire one shot per interval while held, paying per shot, the channel bit set after the cast step', () => {
    const s = sp('cinder_spray');
    const t = timeline('cinder_spray');
    const out = run(t, 61, () => true);
    const shots = out.flatMap((o) => o.shots);
    expect(shots.length).toBe(Math.floor(60 / s.auto!.intervalSteps) + 1);
    expect(shots.map((x) => x.seq)).toEqual(shots.map((_, k) => 1 + k * s.auto!.intervalSteps));
    expect(shots.every((x, k) => x.shot === k && x.streamStart === 1)).toBe(true);
    expect(1000 - t.mana).toBeCloseTo(shots.length * s.auto!.manaPerShot, 9);
    expect(out[0].flags & InputFlag.cast).toBeTruthy();
    expect(out.slice(1).every((o) => (o.flags & InputFlag.channel) !== 0 && (o.flags & InputFlag.cast) === 0)).toBe(true);
  });

  it('stop when released, when mana runs out, or on a dodge; ready again no faster than the rate', () => {
    const s = sp('arc_sparks');
    const t = timeline('arc_sparks');
    const out = run(t, 30, (seq) => seq <= 12);
    const end = out.find((o) => o.channelEnd);
    expect(end?.seq).toBe(13);
    expect(out[12].flags & InputFlag.channel).toBe(0);
    expect(t.cooldownLeft(s.id)).toBe(0); // 17 steps later the pause is over
    const t2 = timeline('arc_sparks');
    t2.mana = s.auto!.manaPerShot * 3 + 0.01;
    const o2 = run(t2, 40, () => true);
    expect(o2.flatMap((o) => o.shots).length).toBe(3);
    expect(t2.channel).toBeNull();
    const t3 = timeline('arc_sparks');
    const o3 = run(t3, 20, () => true, (seq) => (seq === 9 ? { dodgePress: 1 } : {}));
    expect(o3.find((o) => o.channelEnd)?.seq).toBe(9);
    expect(o3[8].flags & InputFlag.dodge).toBeTruthy();
  });

  it('no press pattern beats the stream rate (taps, re-presses, holding), like the zone', () => {
    const s = sp('arc_sparks');
    for (const pattern of [(seq: number) => seq % 2 === 1, (seq: number) => seq % 3 !== 0, () => true]) {
      const t = timeline('arc_sparks');
      const shots = run(t, 120, pattern).flatMap((o) => o.shots).length;
      expect(shots).toBeLessThanOrEqual(120 / s.auto!.intervalSteps + 1);
      expect(shots).toBeGreaterThan(0);
    }
  });

  it('a held key restarts the stream once mana allows', () => {
    const s = sp('cinder_spray');
    const t = timeline('cinder_spray');
    t.mana = s.auto!.manaPerShot * 2 + 0.01;
    run(t, 20, () => true);
    expect(t.channel).toBeNull();
    t.mana = 100;
    const out = run(t, 40, () => true);
    expect(out.some((o) => o.started?.stream)).toBe(true);
  });
});

describe('hold-to-empower charges (CR 020)', () => {
  it('pay at the cast, fire on release with the held fraction; a dodge cancels', () => {
    const s = sp('boulder_heave');
    const t = timeline('boulder_heave');
    const out = run(t, s.charge!.maxSteps / 2 + 3, (seq) => seq <= s.charge!.maxSteps / 2);
    expect(out[0].chargeStart?.key).toBe('boulder_heave');
    expect(1000 - t.mana).toBe(s.mana);
    const rel = out.find((o) => o.started)!;
    expect(rel.seq).toBe(s.charge!.maxSteps / 2 + 1);
    expect(rel.started!.charge).toBeCloseTo(0.5, 9);
    expect(rel.flags & (InputFlag.cast | InputFlag.dodge | InputFlag.attack)).toBe(0);
    const t2 = timeline('boulder_heave');
    const o2 = run(t2, 12, () => true, (seq) => (seq === 6 ? { dodgePress: 1 } : {}));
    expect(o2.some((o) => o.started)).toBe(false);
    expect(o2[5].channelEnd?.charge).toBe(true);
  });
});

describe('poses and the skill tree (CR 020)', () => {
  it('another player streaming holds the cast pose until the stop', () => {
    const s = sp('arc_sparks');
    expect(classifyChannel(s.id, 1, 'staff')).toMatchObject({ kind: 'castStaff', hold: true });
    expect(classifyChannel(s.id, 2, null)).toMatchObject({ kind: 'castBig', hold: true });
    expect(classifyChannel(s.id, 0, null).hold).toBe(false);
  });
  it('tooltips say how each mechanic plays', () => {
    const f = (k: string) => Object.fromEntries(spellFacts(spellByKey.get(k)!).map((x) => [x.label, x.value]));
    expect(f('cinder_spray')['Hold to fire']).toMatch(/12 shots\/s/);
    expect(f('guiding_motes').Seeks).toBeTruthy();
    expect(f('boulder_heave')['Hold to charge']).toMatch(/x2.75/);
    expect(f('wraith_hound').Calls).toMatch(/Wraith Hound/);
    expect(f('pyre_brand').Brands).toBeTruthy();
    expect(f('burrowing_seed').Bursts).toBeTruthy();
    expect(f('whirling_blades').Orbit).toBeTruthy();
  });
  it('a new character finds a stream and a seeker at level 1 (tier 1 nodes off known or root spells)', () => {
    const fire = COMBAT.trees.find((t) => t.key === 'fire')!;
    const light = COMBAT.trees.find((t) => t.key === 'light')!;
    expect(fire.nodes.find((n) => n.key === 'cinder_spray')!.prereqs).toContain('ember_flick');
    expect(COMBAT.start.spells).toContain('ember_flick');
    expect(light.nodes.find((n) => n.key === 'guiding_motes')!.prereqs).toEqual([]);
    expect(sp('cinder_spray').tier).toBe(1);
    expect(sp('guiding_motes').tier).toBe(1);
  });
});
