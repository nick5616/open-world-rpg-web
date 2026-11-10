// Shared spell simulation (playtest 2 spell mechanics, CR 020). The zone has
// a line-for-line twin (server/zone/internal/combat/spellsim.go) and replays
// this file's golden vectors (golden/spellsim_golden.json) to 1e-6 m, the
// way the movement step's twins are pinned: the client flies a homing shot
// and claims what it hit, the zone re-flies the same path in the same 1/60 s
// steps against the target's recorded positions and accepts the claim only
// if that path reaches it.
//
// Also here, because both sides must agree bit for bit: the seeded pattern a
// hold-to-fire stream leans its shots by (jitter), where a rain spell's
// shots fall (rain offsets), where orbiting orbs are, and how far a held
// charge has grown. Integer hashing only (Math.imul / uint32 in Go), so the
// patterns are identical on both sides.

import type { SpellDef } from '@lodestone/contracts';

export const SIM_HZ = 60;
export const SIM_DT = 1 / SIM_HZ;

export interface Vec {
  x: number;
  y: number;
  z: number;
}

/** A homing shot's state (positions in metres, velocity m/s, age in steps). */
export interface HomingShot {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  /** 0 seeking (no lock yet), 1 locked, 2 lost (flies straight for good). */
  state: number;
}

export interface HomingParams {
  /** Most the nose turns in one step (radians). */
  turn: number;
  acquire: number;
  /** cos of half the acquire cone. */
  coneCos: number;
  delay: number;
  /** cos of the lose-lock angle. */
  loseCos: number;
  gravity: number;
}

export function homingParams(sp: SpellDef): HomingParams | null {
  const h = sp.homing;
  if (!h) return null;
  const rad = Math.PI / 180;
  return { turn: h.turnDegS * rad * SIM_DT, acquire: h.acquireM, coneCos: Math.cos((h.coneDeg / 2) * rad), delay: h.delaySteps, loseCos: Math.cos(h.loseDeg * rad), gravity: sp.gravity };
}

/** Can this shot lock onto a target centred at `t` now? (Seeking shots past their delay try every step.) */
export function canAcquire(s: HomingShot, t: Vec, p: HomingParams): boolean {
  if (s.state !== 0 || s.age < p.delay) return false;
  const wx = t.x - s.x;
  const wy = t.y - s.y;
  const wz = t.z - s.z;
  const d = Math.sqrt(wx * wx + wy * wy + wz * wz);
  if (d > p.acquire) return false;
  if (d < 1e-6) return true;
  const sp = Math.sqrt(s.vx * s.vx + s.vy * s.vy + s.vz * s.vz);
  if (sp < 1e-9) return false;
  return (wx * s.vx + wy * s.vy + wz * s.vz) / (d * sp) >= p.coneCos;
}

/**
 * One 1/60 s step. `t` is the locked target's centre this step (null: none,
 * or it died: the lock is lost). A locked shot turns its nose toward the
 * target by at most `turn` (speed kept), or loses the lock when the target
 * is more than the lose angle off its nose; then gravity and the move.
 */
export function homingStep(s: HomingShot, t: Vec | null, p: HomingParams): void {
  if (s.state === 1) {
    if (!t) s.state = 2;
    else if (s.age >= p.delay) {
      const sp = Math.sqrt(s.vx * s.vx + s.vy * s.vy + s.vz * s.vz);
      const wx = t.x - s.x;
      const wy = t.y - s.y;
      const wz = t.z - s.z;
      const d = Math.sqrt(wx * wx + wy * wy + wz * wz);
      if (sp > 1e-9 && d > 1e-6) {
        const dx = s.vx / sp;
        const dy = s.vy / sp;
        const dz = s.vz / sp;
        const ux = wx / d;
        const uy = wy / d;
        const uz = wz / d;
        let c = dx * ux + dy * uy + dz * uz;
        c = c > 1 ? 1 : c < -1 ? -1 : c;
        if (c < p.loseCos) s.state = 2;
        else {
          const ang = Math.acos(c);
          let nx: number;
          let ny: number;
          let nz: number;
          if (ang <= p.turn) {
            nx = ux;
            ny = uy;
            nz = uz;
          } else {
            const sn = Math.sin(ang);
            const a = Math.sin(ang - p.turn) / sn;
            const b = Math.sin(p.turn) / sn;
            nx = a * dx + b * ux;
            ny = a * dy + b * uy;
            nz = a * dz + b * uz;
            const n = Math.sqrt(nx * nx + ny * ny + nz * nz);
            nx /= n;
            ny /= n;
            nz /= n;
          }
          s.vx = nx * sp;
          s.vy = ny * sp;
          s.vz = nz * sp;
        }
      }
    }
  }
  s.vy -= p.gravity * SIM_DT;
  s.x += s.vx * SIM_DT;
  s.y += s.vy * SIM_DT;
  s.z += s.vz * SIM_DT;
  s.age++;
}

/** A shot leaving `eye` along yaw/pitch at `speed` (yaw 0 looks down -Z, as everywhere). */
export function launchShot(eye: Vec, yaw: number, pitch: number, speed: number): HomingShot {
  const cp = Math.cos(pitch);
  return { x: eye.x, y: eye.y, z: eye.z, vx: -Math.sin(yaw) * cp * speed, vy: Math.sin(pitch) * speed, vz: -Math.cos(yaw) * cp * speed, age: 0, state: 0 };
}

// ---- seeded patterns ----

/** uint32 hash of two uint32s (murmur3's finalizer over a golden-ratio mix). Go: hash32. */
export function hash32(a: number, b: number): number {
  let h = (Math.imul(a >>> 0, 0x9e3779b1) ^ (b >>> 0)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** 0 <= u < 1 from a hash (24 bits: exact in float64 on both sides). */
export function unit32(h: number): number {
  return (h >>> 8) / 16777216;
}

/** A stream's seed: its start seq and spell id (the zone sends the start seq in Event 223). */
export function streamSeed(startSeq: number, spellId: number): number {
  return hash32(startSeq, spellId);
}

/** How far shot k of a stream leans off the aim (radians): yaw by up to jitter, pitch by half that. */
export function shotJitter(seed: number, k: number, jitterDeg: number): { dyaw: number; dpitch: number } {
  const j = (jitterDeg * Math.PI) / 180;
  const u1 = unit32(hash32(seed, 2 * k));
  const u2 = unit32(hash32(seed, 2 * k + 1));
  return { dyaw: (2 * u1 - 1) * j, dpitch: (2 * u2 - 1) * j * 0.5 };
}

/** Where shot k of a rain stream lands relative to the aim point (uniform over the disc). */
export function rainOffset(seed: number, k: number, radius: number): { dx: number; dz: number } {
  const s = (seed ^ 0x5bd1e995) >>> 0;
  const r = radius * Math.sqrt(unit32(hash32(s, 2 * k)));
  const th = 2 * Math.PI * unit32(hash32(s, 2 * k + 1));
  return { dx: r * Math.cos(th), dz: r * Math.sin(th) };
}

/** Steps after a stream's start that shot k fires (windup, then one per interval). */
export function shotStep(k: number, windupSteps: number, intervalSteps: number): number {
  return windupSteps + k * intervalSteps;
}

/** Orb i's offset from the caster's feet `steps` after an orbit spell started (height 1 m). */
export function orbOffset(i: number, count: number, steps: number, periodSteps: number, radius: number): Vec {
  const th = (2 * Math.PI * steps) / periodSteps + (2 * Math.PI * i) / count;
  return { x: radius * Math.sin(th), y: 1, z: radius * Math.cos(th) };
}

/** 0..1 of a held charge. */
export function chargeFrac(heldSteps: number, maxSteps: number): number {
  return Math.max(0, Math.min(1, heldSteps / Math.max(1, maxSteps)));
}

/** A charge multiplier at fraction f (1 at a tap, `mult` at full). */
export function chargeMult(mult: number, f: number): number {
  return 1 + (mult - 1) * f;
}
