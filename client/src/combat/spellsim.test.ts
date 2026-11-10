import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMBAT } from '@lodestone/contracts';
import { buildSpellsimGolden, flyHoming, targetAt } from './golden/spellsim.golden';
import { canAcquire, chargeFrac, hash32, homingParams, homingStep, launchShot, rainOffset, shotJitter, unit32 } from './spellsim';

const GOLDEN = path.join(__dirname, 'golden', 'spellsim_golden.json');

describe('spellsim (CR 020)', () => {
  it('golden vectors are current (LODESTONE_GOLDEN_WRITE=1 rewrites them)', () => {
    const g = buildSpellsimGolden();
    const text = JSON.stringify(g, null, 1) + '\n';
    if (process.env.LODESTONE_GOLDEN_WRITE) fs.writeFileSync(GOLDEN, text);
    expect(fs.readFileSync(GOLDEN, 'utf8')).toBe(text);
  });

  it('a homing shot locks, turns no faster than its rate and hits a strafing target', () => {
    const c = buildSpellsimGolden().homing.find((h) => h.name === 'motes_strafing')!;
    const sp = COMBAT.spells.find((s) => s.key === c.spell)!;
    const p = homingParams(sp)!;
    let prev = { x: 0, y: 0, z: 0 };
    let minD = Infinity;
    c.states.forEach((st, i) => {
      const v = { x: st[3], y: st[4], z: st[5] };
      const sp1 = Math.hypot(v.x, v.y, v.z);
      expect(sp1).toBeCloseTo(sp.speed, 6); // speed kept
      if (i > 0) {
        const cos = (prev.x * v.x + prev.y * v.y + prev.z * v.z) / (Math.hypot(prev.x, prev.y, prev.z) * sp1);
        expect(Math.acos(Math.min(1, cos))).toBeLessThanOrEqual(p.turn + 1e-9);
      }
      prev = v;
      const t = targetAt(c.target, i);
      minD = Math.min(minD, Math.hypot(st[0] - t.x, st[1] - t.y, st[2] - t.z));
    });
    expect(c.states.some((s) => s[6] === 1)).toBe(true);
    expect(minD).toBeLessThan(0.6);
  });

  it('a target racing across the nose breaks the lock for good', () => {
    const c = buildSpellsimGolden().homing.find((h) => h.name === 'souls_lose_lock')!;
    const states = c.states.map((s) => s[6]);
    const firstLock = states.indexOf(1);
    const lost = states.indexOf(2);
    expect(firstLock).toBeGreaterThanOrEqual(0);
    expect(lost).toBeGreaterThan(firstLock);
    expect(states.slice(lost).every((s) => s === 2)).toBe(true);
  });

  it('no target in the cone: straight flight, the delay holds the nose', () => {
    const flat = flyHoming({ name: 'x', spell: 'guiding_motes', eye: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, target: { x: 0, y: 0, z: 40, ax: 0, az: 0, rx: 0, rz: 0 }, steps: 30 });
    expect(flat.every((s) => s[6] === 0 && Math.abs(s[0]) < 1e-9)).toBe(true);
    const sp = COMBAT.spells.find((s) => s.key === 'storm_seekers')!;
    const p = homingParams(sp)!;
    const s = launchShot({ x: 0, y: 0, z: 0 }, 0, 0, sp.speed);
    const t = { x: 0, y: 0, z: -10 };
    for (let i = 0; i < p.delay; i++) {
      expect(canAcquire(s, t, p)).toBe(false);
      homingStep(s, null, p);
    }
    expect(canAcquire(s, t, p)).toBe(true);
  });

  it('hash, jitter and rain patterns are uint32-exact and in range', () => {
    expect(hash32(0, 0)).toBe(hash32(0, 0));
    expect(hash32(1, 2)).not.toBe(hash32(2, 1));
    for (let k = 0; k < 200; k++) {
      const u = unit32(hash32(99, k));
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      const j = shotJitter(1234, k, 6);
      expect(Math.abs(j.dyaw)).toBeLessThanOrEqual((6 * Math.PI) / 180);
      expect(Math.abs(j.dpitch)).toBeLessThanOrEqual((3 * Math.PI) / 180);
      const r = rainOffset(1234, k, 4);
      expect(Math.hypot(r.dx, r.dz)).toBeLessThanOrEqual(4 + 1e-12);
    }
    expect(chargeFrac(36, 72)).toBe(0.5);
    expect(chargeFrac(500, 72)).toBe(1);
  });
});
