import { describe, expect, it } from 'vitest';
import { Activity, COMBAT } from '@lodestone/contracts';
import { AvatarAnimator, BOW_DRAW_MS, CAST_FX_DASH, CAST_FX_GUARD, classifyAction, DODGE_MIN_SPEED, MINE_SPEC, type AnimInput, type Pose } from './avatarAnim';

const DT = 1 / 60;

function input(over: Partial<AnimInput> = {}): AnimInput {
  return { x: 0, y: 10, z: 0, yaw: 0, pitch: 0, speed: 0, activity: 0, healthPct: 100, ...over };
}

const places = new WeakMap<AvatarAnimator, { z: number; y: number }>();
/** Run n frames; moving at `speed` along -Z (facing direction at yaw 0) from where it was. Returns the last pose. */
function run(a: AvatarAnimator, n: number, over: Partial<AnimInput> = {}, at = places.get(a) ?? { z: 0, y: 10 }): Pose {
  places.set(a, at);
  let p = a.pose;
  for (let i = 0; i < n; i++) {
    at.z -= (over.speed ?? 0) * DT;
    p = a.update(input({ ...over, z: at.z, y: over.y ?? at.y }), DT);
  }
  return p;
}

const moveId = (key: string) => COMBAT.moves.find((m) => m.key === key)!.id;
const spell = (pred: (s: (typeof COMBAT.spells)[number]) => boolean) => COMBAT.spells.find(pred)!;

describe('action classification (Event 214 targetIds)', () => {
  it('maps weapon moves, spells, forms, dashes and the guard to motions', () => {
    expect(classifyAction(moveId('sword_slash_1'), 'sword')).toMatchObject({ kind: 'slash', dir: 1 });
    expect(classifyAction(moveId('sword_slash_2'), 'sword')).toMatchObject({ kind: 'slash', dir: -1 });
    expect(classifyAction(moveId('sword_whirlwind'), 'sword').kind).toBe('spin');
    expect(classifyAction(moveId('sword_plunge'), 'sword').kind).toBe('plunge');
    expect(classifyAction(moveId('spear_thrust'), 'spear').kind).toBe('thrust');
    expect(classifyAction(moveId('spear_sweep'), 'spear').kind).toBe('slash');
    expect(classifyAction(moveId('bow_charged'), 'bow').kind).toBe('bow');
    expect(classifyAction(moveId('staff_bolt'), 'staff').kind).toBe('bolt');
    expect(classifyAction(moveId('wand_jab'), 'wand').kind).toBe('bonk');
    const proj = spell((s) => s.type === 'projectile');
    // playtest 2: a staff/wand casts from its tip (the weapon hand raises it); other weapons from the off hand
    expect(classifyAction(proj.id, 'staff')).toMatchObject({ kind: 'castStaff', color: proj.color });
    expect(classifyAction(proj.id, 'sword')).toMatchObject({ kind: 'cast', color: proj.color });
    expect(classifyAction(spell((s) => s.type === 'aoe' && s.selfCast).id, null).kind).toBe('castBig');
    expect(classifyAction(spell((s) => s.type === 'beam').id, null).kind).toBe('castBeam');
    expect(classifyAction(spell((s) => s.type === 'defensive').id, null).kind).toBe('shield');
    expect(classifyAction(COMBAT.forms[0].id, 'sword')).toMatchObject({ kind: 'form' });
    expect(classifyAction(COMBAT.forms[0].id, 'sword').color).toBeTruthy();
    const dash = classifyAction(1 | CAST_FX_DASH, null);
    expect(dash.kind).toBe('dash');
    expect(dash.color).toBeTruthy(); // magma_dash's fire colour
    expect(classifyAction(CAST_FX_GUARD, 'sword').kind).toBe('parry');
    expect(classifyAction(CAST_FX_GUARD, 'spear')).toMatchObject({ kind: 'charge', hold: true });
    expect(classifyAction(CAST_FX_GUARD, 'bow')).toMatchObject({ kind: 'draw', hold: true });
    // cached: no allocation per event
    expect(classifyAction(moveId('sword_slash_1'), 'sword')).toBe(classifyAction(moveId('sword_slash_1'), 'sword'));
  });
});

describe('avatar animation state machine', () => {
  it('breathes when idle and stays near the rest pose', () => {
    const a = new AvatarAnimator();
    const samples: number[] = [];
    for (let i = 0; i < 240; i++) samples.push(a.update(input(), DT).torsoPitch);
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(0.02); // breathing
    expect(Math.abs(a.pose.legR.swing)).toBeLessThan(0.01);
    expect(a.current).toBeNull();
  });

  it('walk cycle: legs swing opposite, amplitude and cadence grow with speed, sprint leans', () => {
    const swingRange = (speed: number) => {
      const a = new AvatarAnimator();
      let lo = 0;
      let hi = 0;
      let crossings = 0;
      let prev = 0;
      const at = { z: 0, y: 10 };
      for (let i = 0; i < 120; i++) {
        const p = run(a, 1, { speed }, at);
        lo = Math.min(lo, p.legR.swing);
        hi = Math.max(hi, p.legR.swing);
        expect(p.legL.swing).toBeCloseTo(-p.legR.swing, 6);
        if (prev < 0 && p.legR.swing >= 0) crossings++;
        prev = p.legR.swing;
      }
      return { amp: hi - lo, crossings, lean: a.pose.bodyPitch };
    };
    const walk = swingRange(4.9);
    const sprint = swingRange(7.8);
    expect(walk.amp).toBeGreaterThan(0.8);
    expect(sprint.amp).toBeGreaterThan(walk.amp);
    expect(sprint.crossings).toBeGreaterThan(walk.crossings); // faster cadence
    expect(sprint.lean).toBeLessThan(walk.lean - 0.1); // leans forward (negative pitch)
  });

  it('jump tucks, fall spreads the arms, landing dips', () => {
    const a = new AvatarAnimator();
    run(a, 5);
    // rising
    const at = { z: 0, y: 10 };
    let p = a.pose;
    for (let i = 0; i < 12; i++) {
      at.y += 5 * DT;
      p = a.update(input({ y: at.y, activity: Activity.airborne }), DT);
    }
    const tuck = p.legR.bend;
    const armsUp = p.armR.spread;
    // falling
    for (let i = 0; i < 30; i++) {
      at.y -= 8 * DT;
      p = a.update(input({ y: at.y, activity: Activity.airborne }), DT);
    }
    expect(tuck).toBeGreaterThan(p.legR.bend + 0.3);
    expect(p.armR.spread).toBeGreaterThan(armsUp + 0.2);
    // land
    p = a.update(input({ y: at.y }), DT);
    expect(p.bodyY).toBeLessThan(-0.08);
    run(a, 60, { y: at.y });
    expect(a.pose.bodyY).toBeGreaterThan(-0.03);
  });

  it('glide, climb and swim poses', () => {
    const g = new AvatarAnimator().update(input({ activity: Activity.gliding | Activity.airborne, speed: 9 }), DT);
    expect(g.glider).toBe(true);
    expect(g.armR.swing).toBeGreaterThan(2.8); // holding the wing overhead
    const c = new AvatarAnimator();
    const cl = run(c, 20, { activity: Activity.climbing, speed: 1 });
    expect(cl.armL.swing).toBeGreaterThan(2);
    const s = new AvatarAnimator().update(input({ activity: Activity.swimming, speed: 2 }), DT);
    expect(s.bodyPitch).toBeLessThan(-1); // lying forward in the water
  });

  it('the head and torso follow the look pitch', () => {
    const a = new AvatarAnimator();
    const up = a.update(input({ pitch: 0.8 }), DT);
    expect(up.headPitch).toBeGreaterThan(0.3);
    expect(up.torsoPitch).toBeGreaterThan(0.15);
    const down = a.update(input({ pitch: -0.8 }), DT);
    expect(down.headPitch).toBeLessThan(-0.3);
  });

  it('a sword slash raises then sweeps the right arm and ends back at rest', () => {
    const a = new AvatarAnimator();
    run(a, 10);
    const rest = a.pose.armR.swing;
    const spec = classifyAction(moveId('sword_slash_1'), 'sword');
    a.trigger(spec);
    expect(a.current).toBe('slash');
    let peak = -Infinity;
    let peakAt = 0;
    const yaw: number[] = [];
    for (let i = 0; i * DT * 1000 < spec.durMs + 50; i++) {
      const p = a.update(input(), DT);
      if (p.armR.swing > peak) {
        peak = p.armR.swing;
        peakAt = i;
      }
      yaw.push(p.torsoYaw);
    }
    expect(peak).toBeGreaterThan(rest + 1.2); // wound up over the shoulder
    expect(peakAt * DT * 1000).toBeLessThan(spec.durMs * 0.45);
    expect(Math.max(...yaw)).toBeGreaterThan(0.3); // the cut turns the torso
    expect(a.current).toBeNull();
    expect(Math.abs(a.pose.armR.swing - rest)).toBeLessThan(0.05);
  });

  it('a spear thrust straightens the elbow forward', () => {
    const a = new AvatarAnimator();
    run(a, 5);
    const spec = classifyAction(moveId('spear_thrust'), 'spear');
    a.trigger(spec);
    let maxBend = 0;
    let minBendAfterPeak = Infinity;
    for (let i = 0; i * DT * 1000 < spec.durMs * 0.6; i++) {
      const p = a.update(input(), DT);
      if (p.armR.bend > maxBend) maxBend = p.armR.bend;
      else minBendAfterPeak = Math.min(minBendAfterPeak, p.armR.bend);
    }
    expect(maxBend).toBeGreaterThan(1.2); // pulled back
    expect(minBendAfterPeak).toBeLessThan(0.5); // thrust out
  });

  // CR 033: observers see the archer's real draw: it grows with the hold as the archer's own does
  // (linear to bow_charged's chargeMs), a release snaps from where it got to, a late observer starts
  // mid-draw, and a held full draw trembles without ever timing out.
  it('bow: the draw follows the hold time, the release looses from the draw reached', () => {
    expect(BOW_DRAW_MS).toBeCloseTo(1000, 6);
    const a = new AvatarAnimator();
    a.trigger(classifyAction(CAST_FX_GUARD, 'bow'));
    expect(run(a, 30).bowDraw).toBeCloseTo(0.5, 1); // half a second: half drawn
    a.trigger(classifyAction(moveId('bow_charged'), 'bow')); // a half-draw release
    const first = run(a, 1).bowDraw;
    expect(first).toBeLessThan(0.5);
    expect(first).toBeGreaterThan(0.1); // snapping from the half draw (not from a full one, nor drawn again)
    expect(run(a, 4).bowDraw).toBeLessThan(0.02);
    // late: joined 0.8 s into the draw (Event 226's progress), it starts 80% drawn
    const late = new AvatarAnimator();
    late.trigger(classifyAction(CAST_FX_GUARD, 'bow'), 800);
    expect(run(late, 1).bowDraw).toBeGreaterThan(0.75);
    // held 20 s at full draw: still drawn, and the arms tremble
    const held = new AvatarAnimator();
    held.trigger(classifyAction(CAST_FX_GUARD, 'bow'));
    run(held, 60 * 20);
    const swings: number[] = [];
    for (let i = 0; i < 20; i++) swings.push(run(held, 3).armL.swing);
    expect(held.current).toBe('draw');
    expect(held.pose.bowDraw).toBeGreaterThan(0.95);
    expect(Math.max(...swings) - Math.min(...swings)).toBeGreaterThan(0.005);
  });

  it('bow: the guard draws and holds, the release snaps the string', () => {
    const a = new AvatarAnimator();
    a.trigger(classifyAction(CAST_FX_GUARD, 'bow'));
    let p = run(a, 70);
    expect(a.current).toBe('draw');
    expect(p.bowDraw).toBeGreaterThan(0.9);
    expect(p.armL.swing).toBeGreaterThan(1.3); // bow arm out
    a.trigger(classifyAction(moveId('bow_charged'), 'bow')); // the release
    p = run(a, 4);
    expect(p.bowDraw).toBeLessThan(0.2); // loosed at once from the full draw
    expect(p.armL.swing).toBeGreaterThan(1.3); // the bow arm stays up a moment
    // a quick shot with no guard before it: a short draw, then loosed
    const q = new AvatarAnimator();
    const spec = classifyAction(moveId('bow_quick'), 'bow');
    q.trigger(spec);
    let peak = 0;
    for (let i = 0; i * DT * 1000 < spec.durMs * 0.48; i++) peak = Math.max(peak, q.update(input(), DT).bowDraw);
    expect(peak).toBeGreaterThan(0.6);
    expect(run(q, 12).bowDraw).toBeLessThan(0.1);
    // a held guard ends on release without an attack
    a.trigger(classifyAction(CAST_FX_GUARD, 'spear'));
    run(a, 10);
    expect(a.current).toBe('charge');
    a.release();
    expect(a.current).toBeNull();
  });

  it('a cast raises the off hand with a glow in the spell colour', () => {
    const a = new AvatarAnimator();
    const sp = spell((s) => s.type === 'projectile' && !!s.color);
    const spec = classifyAction(sp.id, 'sword');
    a.trigger(spec);
    let glow = 0;
    let lift = 0;
    for (let i = 0; i * DT * 1000 < spec.durMs * 0.5; i++) {
      const p = a.update(input(), DT);
      glow = Math.max(glow, p.glow);
      lift = Math.max(lift, p.armL.swing);
      if (p.glow > 0) {
        expect(p.glowL).toBe(true);
        expect(p.glowColor).toBe(sp.color);
      }
    }
    expect(glow).toBeGreaterThan(0.6);
    expect(lift).toBeGreaterThan(1.2);
    run(a, 60);
    expect(a.pose.glow).toBe(0);
  });

  it('derives a dodge roll from a burst of ground speed, not from steady sprinting or gliding', () => {
    const a = new AvatarAnimator();
    run(a, 60, { speed: 7.8 }); // sprinting: no dodge
    expect(a.current).toBeNull();
    run(a, 1, { speed: DODGE_SPEED_TEST });
    expect(a.current).toBe('dodge');
    // the roll turns the body all the way over
    let minPitch = 0;
    for (let i = 0; i < 20; i++) minPitch = Math.min(minPitch, run(a, 1, { speed: DODGE_SPEED_TEST }).bodyPitch);
    expect(minPitch).toBeLessThan(-3);

    const g = new AvatarAnimator();
    run(g, 30, { speed: 4, activity: Activity.gliding | Activity.airborne });
    run(g, 2, { speed: 14, activity: Activity.gliding | Activity.airborne });
    expect(g.current).toBeNull();
  });

  it('a hurt flinch is additive and short; health 0 lies down until health returns', () => {
    const a = new AvatarAnimator();
    run(a, 10);
    const base = a.pose.torsoPitch;
    a.hurt();
    const p = run(a, 9);
    expect(p.torsoPitch).toBeGreaterThan(base + 0.2);
    run(a, 30);
    expect(Math.abs(a.pose.torsoPitch - base)).toBeLessThan(0.05);

    a.trigger(MINE_SPEC);
    run(a, 60, { healthPct: 0 });
    expect(a.current).toBeNull(); // downed cancels actions
    expect(a.pose.bodyPitch).toBeGreaterThan(1.3); // on the back
    expect(a.pose.bodyY).toBeLessThan(-0.6);
    run(a, 90, { healthPct: 100 });
    expect(Math.abs(a.pose.bodyPitch)).toBeLessThan(0.05);
  });

  it('health 0 from a zone without combat (never above 0) is not "downed" until Event 203', () => {
    const a = new AvatarAnimator();
    run(a, 60, { healthPct: 0 });
    expect(a.pose.bodyPitch).toBeLessThan(0.2);
    a.downedEvent();
    run(a, 60, { healthPct: 0 });
    expect(a.pose.bodyPitch).toBeGreaterThan(1.3);
  });

  it('allocates nothing per frame (the same pose object every update)', () => {
    const a = new AvatarAnimator();
    const p0 = a.update(input(), DT);
    a.trigger(classifyAction(moveId('sword_slash_1'), 'sword'));
    expect(a.update(input({ speed: 5 }), DT)).toBe(p0);
    expect(a.pose.armR).toBe(p0.armR);
  });
});

const DODGE_SPEED_TEST = DODGE_MIN_SPEED + 2;

describe('staff and wand casts (playtest 2)', () => {
  it('raise the weapon hand with the glow there', () => {
    const a = new AvatarAnimator();
    const sp = COMBAT.spells.find((s) => s.type === 'projectile' && !!s.color)!;
    a.trigger(classifyAction(sp.id, 'wand'));
    let lift = 0;
    for (let i = 0; i < 20; i++) {
      const p = a.update(input(), 1 / 60);
      lift = Math.max(lift, p.armR.swing);
      if (p.glow > 0) expect(p.glowR).toBe(true);
    }
    expect(lift).toBeGreaterThan(1);
  });
});
