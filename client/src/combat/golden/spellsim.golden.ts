// CR 020 golden vectors for the shared spell simulation (spellsim.ts). The
// zone replays them through its twin (server/zone/internal/combat/
// spellsim_golden_test.go): homing flights against scripted moving targets
// (acquire, turn, lose lock), the stream jitter and rain patterns, orbit
// positions and charge fractions. spellsim.test.ts fails when the stored
// JSON is stale; `LODESTONE_GOLDEN_WRITE=1 npx vitest run src/combat/spellsim`
// rewrites it.

import { COMBAT } from '@lodestone/contracts';
import { canAcquire, chargeFrac, hash32, homingParams, homingStep, launchShot, orbOffset, rainOffset, shotJitter, streamSeed, type Vec } from '../spellsim';

export interface HomingCase {
  name: string;
  spell: string;
  eye: Vec;
  yaw: number;
  pitch: number;
  /** Target centre per step: base + amp * sin(rate * step) per axis (x, z), y fixed. */
  target: { x: number; y: number; z: number; ax: number; az: number; rx: number; rz: number };
  steps: number;
  /** [x, y, z, vx, vy, vz, state] after each step. */
  states: number[][];
}

export interface SpellsimGolden {
  format: 'lodestone-spellsim-golden';
  version: 1;
  homing: HomingCase[];
  hashes: { a: number; b: number; h: number }[];
  jitter: { seed: number; k: number; deg: number; dyaw: number; dpitch: number }[];
  rain: { seed: number; k: number; radius: number; dx: number; dz: number }[];
  orbit: { i: number; count: number; steps: number; period: number; radius: number; x: number; y: number; z: number }[];
  charge: { held: number; max: number; f: number }[];
}

export function targetAt(c: HomingCase['target'], step: number): Vec {
  return { x: c.x + c.ax * Math.sin(c.rx * step), y: c.y, z: c.z + c.az * Math.sin(c.rz * step) };
}

/** Flies one homing case: acquire when the target is in the cone, steer while locked. */
export function flyHoming(c: Omit<HomingCase, 'states'>): number[][] {
  const sp = COMBAT.spells.find((s) => s.key === c.spell)!;
  const p = homingParams(sp)!;
  const s = launchShot(c.eye, c.yaw, c.pitch, sp.speed);
  const out: number[][] = [];
  for (let i = 0; i < c.steps; i++) {
    const t = targetAt(c.target, i);
    if (canAcquire(s, t, p)) s.state = 1;
    homingStep(s, s.state === 1 ? t : null, p);
    out.push([s.x, s.y, s.z, s.vx, s.vy, s.vz, s.state]);
  }
  return out;
}

const CASES: Omit<HomingCase, 'states'>[] = [
  { name: 'motes_strafing', spell: 'guiding_motes', eye: { x: 100, y: 11.6, z: 100 }, yaw: 0.3, pitch: 0.05, target: { x: 95, y: 10.9, z: 82, ax: 3, az: 2, rx: 0.03, rz: 0.05 }, steps: 90 },
  { name: 'seekers_fan_left', spell: 'storm_seekers', eye: { x: 2048, y: 41.6, z: 2048 }, yaw: 0.87, pitch: -0.02, target: { x: 2040, y: 41, z: 2025, ax: 4, az: 1, rx: 0.02, rz: 0.04 }, steps: 120 },
  { name: 'seekers_fan_right', spell: 'storm_seekers', eye: { x: 2048, y: 41.6, z: 2048 }, yaw: -0.3, pitch: -0.02, target: { x: 2040, y: 41, z: 2025, ax: 4, az: 1, rx: 0.02, rz: 0.04 }, steps: 120 },
  // A target racing across the nose: the shot locks, overshoots and loses it.
  { name: 'souls_lose_lock', spell: 'hungering_souls', eye: { x: 500, y: 21.6, z: 500 }, yaw: 0, pitch: 0, target: { x: 500, y: 21, z: 490, ax: 4, az: 0, rx: 0.2, rz: 0 }, steps: 140 },
  // Nothing in the cone: straight flight (acquire never passes).
  { name: 'motes_no_target', spell: 'guiding_motes', eye: { x: 300, y: 5.6, z: 300 }, yaw: 3.0, pitch: 0.1, target: { x: 300, y: 5, z: 330, ax: 0, az: 0, rx: 0, rz: 0 }, steps: 60 },
];

export function buildSpellsimGolden(): SpellsimGolden {
  const homing = CASES.map((c) => ({ ...c, states: flyHoming(c) }));
  const seeds = [0, 1, 12345, 0xffffffff, streamSeed(4242, 1018), streamSeed(77, 1709)];
  const hashes: SpellsimGolden['hashes'] = [];
  for (const a of seeds) for (const b of [0, 1, 7, 99999, 0x80000000]) hashes.push({ a, b, h: hash32(a, b) });
  const jitter: SpellsimGolden['jitter'] = [];
  const rain: SpellsimGolden['rain'] = [];
  for (const seed of seeds)
    for (let k = 0; k < 12; k++) {
      const j = shotJitter(seed, k, 7);
      jitter.push({ seed, k, deg: 7, dyaw: j.dyaw, dpitch: j.dpitch });
      const r = rainOffset(seed, k, 4.5);
      rain.push({ seed, k, radius: 4.5, dx: r.dx, dz: r.dz });
    }
  const orbit: SpellsimGolden['orbit'] = [];
  for (const steps of [0, 1, 17, 66, 133, 479])
    for (let i = 0; i < 3; i++) {
      const o = orbOffset(i, 3, steps, 66, 2.2);
      orbit.push({ i, count: 3, steps, period: 66, radius: 2.2, x: o.x, y: o.y, z: o.z });
    }
  const charge = [0, 1, 36, 71, 72, 200].map((held) => ({ held, max: 72, f: chargeFrac(held, 72) }));
  return { format: 'lodestone-spellsim-golden', version: 1, homing, hashes, jitter, rain, orbit, charge };
}
