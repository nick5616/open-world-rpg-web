// Playtest 2 mounts (CR 027, docs/cr/027-mounts.md): riding the spirit steed
// inside the shared movement step. Line-for-line twin of
// server/pkg/movement/ride.go; change both together and regenerate the
// goldens (golden/ride.ts).
//
// Being mounted is MoveFlag.mounted in the carried state. The step never
// SETS it: only the zone does (Interact 110 mount, server/zone/internal/game
// mounts.go), so the client learns it from SelfState and replays from it.
// The step only clears it: Space at a standstill (hop off), a hard landing
// (thrown), deep water under you (thrown, you swim), or any mode a rider
// can't be in (climb, glide, swim). The zone clears it too (E, hits, a
// demon spooking the steed), which the client sees as a reconciliation.
//
// While mounted the walk family runs stepRide instead of stepWalk:
//  - gait: `lunge` (otherwise the climb lunge, always 0 off a wall) carries
//    the gait in bits 0-1 (0 trot, 1 walk, 2 gallop), "Shift was down last
//    step" in bit 2 (a spur is a press, not a hold) and "backing up" in
//    bit 3. W rides at the gait's speed; a Shift press with W held spurs:
//    RIDE_SPUR_STAMINA from your wheel, +RIDE_SPUR_KICK m/s at once (capped
//    at RIDE_SPUR_MAX_SPEED, fading at RIDE_BURST_DECAY) and one gait up;
//    S reins in to a walk and brakes, then backs up; A/D alone turn at a walk.
//  - steering: W/A/D steer toward the camera-relative wish direction, the
//    velocity turning by at most a fixed angle per step (literal cos/sin,
//    slower at speed); below RIDE_PIVOT_SPEED it turns on the spot.
//  - terrain: walkable up to RIDE_WALKABLE_TAN_SQ (35 degrees), steeper
//    uphill ground is a wall (slide along it, never climb; RIDE_STEP_UP_M
//    lips are stepped), standing on ground past RIDE_SLIDE_TAN_SQ slides;
//    water deeper than RIDE_WADE_DEPTH_M is refused, wading is slower.
//  - air: Space while moving jumps RIDE_JUMP_SPEED, no air control, no
//    double jump or glider; landing faster than RIDE_THROW_FALL_SPEED (or
//    into deep water) throws the rider.
//  - stamina: spurs spend it; every other grounded step regenerates as on
//    foot (the wheel is the spur gauge: one pip per RIDE_SPUR_STAMINA).
// Only + - * / sqrt and comparisons on top of the yaw sin/cos the walk step
// already uses, and literal turn constants, so TS and Go agree bit for bit.

import {
  GRAVITY,
  GROUND_SNAP_M,
  InputFlag,
  JUMP_FORCE,
  MOVE_STEP_HZ,
  MoveMode,
  RIDE_ACCEL,
  RIDE_BACK_SPEED,
  RIDE_BRAKE_DECEL,
  RIDE_BURST_DECAY,
  RIDE_DISMOUNT_SPEED,
  RIDE_GALLOP_SPEED,
  RIDE_HEAD_PROBE_M,
  RIDE_JUMP_SPEED,
  RIDE_PIVOT_SPEED,
  RIDE_SLIDE_TAN_SQ,
  RIDE_SLOW_DECEL,
  RIDE_SPLASH_DEPTH_M,
  RIDE_SPUR_KICK,
  RIDE_SPUR_MAX_SPEED,
  RIDE_SPUR_STAMINA,
  RIDE_STEP_UP_M,
  RIDE_STOP_DECEL,
  RIDE_THROW_FALL_SPEED,
  RIDE_TROT_SPEED,
  RIDE_WADE_DEPTH_M,
  RIDE_WALK_SPEED,
  RIDE_WALKABLE_TAN_SQ,
  RIDE_WATER_MULT,
  SLIDE_MAX_SPEED,
  SLOPE_PROBE_M,
  STAMINA_FINE_PER_POINT,
  STAMINA_REGEN_DELAY_S,
  STAMINA_REGEN_PER_S,
  STEP_PROBE_M,
  SWIM_DEPTH_M,
  SWIM_FLOAT_DEPTH_M,
} from '@lodestone/contracts';
import type { CollideResult, GroundQuery } from './ground';
import type { MoveState, Vec2xz } from './movement';

/** MoveFlag.mounted (SelfState.flags bit 3). Mirrored in movement.ts MoveFlag. */
export const MOUNTED = 8;
/** MoveFlag.exhausted / sliding (movement.ts MoveFlag; repeated here to avoid an import cycle). */
const EXHAUSTED = 1;
const SLIDING = 4;
const EPS = 1e-4; // movement.ts GROUND_EPS

/** Gaits carried in lunge bits 0-1. */
export const GAIT = { trot: 0, walk: 1, gallop: 2 } as const;
const PREV_SPRINT = 4;
const BACKING = 8;

/** Spur cost in fine stamina units. */
export const SPUR_COST = Math.round(RIDE_SPUR_STAMINA * STAMINA_FINE_PER_POINT);

// Turn per step as literal cos/sin (150, 110 and 75 degrees per second at 60 Hz),
// so both languages rotate by the identical doubles (no trig per step).
const TURN_WALK_C = 0.9990482215818578;
const TURN_WALK_S = 0.043619387365336;
const TURN_TROT_C = 0.9994881171794909;
const TURN_TROT_S = 0.03199224307541267;
const TURN_GALLOP_C = 0.9997620270799091;
const TURN_GALLOP_S = 0.02181488503456112;

export const mounted = (s: Pick<MoveState, 'flags'>): boolean => (s.flags & MOUNTED) !== 0;
export const gaitOf = (s: Pick<MoveState, 'lunge'>): number => s.lunge & 3;

function gaitSpeed(g: number): number {
  return g === GAIT.walk ? RIDE_WALK_SPEED : g === GAIT.gallop ? RIDE_GALLOP_SPEED : RIDE_TROT_SPEED;
}

// movement.ts slopeAt and the regen integers, repeated (not imported) so the
// two modules have no import cycle; same arithmetic, same doubles.
function slopeAt(g: GroundQuery, x: number, z: number): { gx: number; gz: number; t2: number } {
  const w = 2 * SLOPE_PROBE_M;
  const gx = (g.heightAt(x + SLOPE_PROBE_M, z) - g.heightAt(x - SLOPE_PROBE_M, z)) / w;
  const gz = (g.heightAt(x, z + SLOPE_PROBE_M) - g.heightAt(x, z - SLOPE_PROBE_M)) / w;
  return { gx, gz, t2: gx * gx + gz * gz };
}
const REGEN = Math.round((STAMINA_REGEN_PER_S * STAMINA_FINE_PER_POINT) / MOVE_STEP_HZ);
const REGEN_DELAY = Math.round(STAMINA_REGEN_DELAY_S * MOVE_STEP_HZ);

function waterAt(g: GroundQuery, x: number, z: number): number {
  return g.waterAt ? g.waterAt(x, z) : -Infinity;
}

function rideStepUpOK(g: GroundQuery, px0: number, py0: number, pz0: number, dx: number, dz: number): boolean {
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d === 0) return false;
  const px = px0 + (dx / d) * STEP_PROBE_M;
  const pz = pz0 + (dz / d) * STEP_PROBE_M;
  if (g.heightAt(px, pz) - py0 > RIDE_STEP_UP_M) return false;
  return slopeAt(g, px, pz).t2 <= RIDE_WALKABLE_TAN_SQ;
}

/** The rider leaves the saddle: the flag and the gait bits go. */
export function dismounted(s: MoveState): MoveState {
  return { ...s, flags: s.flags & ~MOUNTED, lunge: 0 };
}

/**
 * One riding step (walk family, mounted). `flags` are the frame's (dodge and
 * channel already masked by the caller), `wish` the camera-relative
 * W/A/D direction, `yaw` the look in radians (backing up goes away from it).
 */
export function stepRide(s: MoveState, flags: number, wish: Vec2xz, yaw: number, ground: GroundQuery, dt: number): MoveState {
  const fwd = (flags & InputFlag.forward) !== 0;
  const back = (flags & InputFlag.back) !== 0;
  const side = (flags & (InputFlag.left | InputFlag.right)) !== 0;
  const sprint = (flags & InputFlag.sprint) !== 0;
  let gait = s.lunge & 3;
  const spurPress = sprint && (s.lunge & PREV_SPRINT) === 0;
  let backing = (s.lunge & BACKING) !== 0;
  const exhausted = (s.flags & EXHAUSTED) !== 0;

  const h0 = ground.heightAt(s.pos.x, s.pos.z);
  const grounded = s.pos.y <= h0 + EPS;
  let sliding = false;
  let sl = { gx: 0, gz: 0, t2: 0 };
  if (grounded) {
    sl = slopeAt(ground, s.pos.x, s.pos.z);
    sliding = sl.t2 > RIDE_SLIDE_TAN_SQ;
  }

  let vx = s.vel.x;
  let vz = s.vel.z;
  let stamina = s.stamina;
  let timer = s.timer;
  let spurred = false;
  if (grounded && !sliding) {
    // Steering wish: W/A/D only (S is the brake, not "turn around").
    const steer = fwd || side;
    if (back && !fwd) gait = GAIT.walk;
    if (spurPress && fwd && !exhausted && stamina >= SPUR_COST) {
      stamina -= SPUR_COST;
      timer = 0;
      spurred = true;
      gait = gait === GAIT.walk ? GAIT.trot : GAIT.gallop;
    }
    if (back && !fwd && !side) {
      const sp = Math.sqrt(vx * vx + vz * vz);
      if (!backing && sp > RIDE_PIVOT_SPEED * 0.5) {
        // Brake along the current heading.
        const ns = Math.max(0, sp - RIDE_BRAKE_DECEL * dt);
        const k = ns / sp;
        vx *= k;
        vz *= k;
      } else {
        // Back up, away from the look, easing onto RIDE_BACK_SPEED.
        backing = true;
        const tx = Math.sin(yaw) * RIDE_BACK_SPEED;
        const tz = Math.cos(yaw) * RIDE_BACK_SPEED;
        const dx = tx - vx;
        const dz = tz - vz;
        const d = Math.sqrt(dx * dx + dz * dz);
        const m = RIDE_ACCEL * dt;
        if (d <= m) {
          vx = tx;
          vz = tz;
        } else {
          vx += dx * (m / d);
          vz += dz * (m / d);
        }
      }
    } else {
      backing = false;
      let target = fwd ? gaitSpeed(gait) : side ? RIDE_WALK_SPEED : 0;
      const depth = waterAt(ground, s.pos.x, s.pos.z) - h0;
      if (depth > RIDE_SPLASH_DEPTH_M) target *= RIDE_WATER_MULT;
      let sp = Math.sqrt(vx * vx + vz * vz);
      let dx = 0;
      let dz = 0;
      if (sp > 0) {
        dx = vx / sp;
        dz = vz / sp;
      }
      if (steer && (wish.x !== 0 || wish.z !== 0)) {
        if (sp < RIDE_PIVOT_SPEED) {
          dx = wish.x;
          dz = wish.z;
        } else {
          let c = TURN_GALLOP_C;
          let sn = TURN_GALLOP_S;
          if (sp < 5) {
            c = TURN_WALK_C;
            sn = TURN_WALK_S;
          } else if (sp < 10) {
            c = TURN_TROT_C;
            sn = TURN_TROT_S;
          }
          const dot = dx * wish.x + dz * wish.z;
          if (dot >= c) {
            dx = wish.x;
            dz = wish.z;
          } else {
            const cross = dx * wish.z - dz * wish.x;
            if (cross < 0) sn = -sn;
            const rx = dx * c - dz * sn;
            const rz = dx * sn + dz * c;
            dx = rx;
            dz = rz;
          }
        }
      }
      if (spurred) sp = Math.min(RIDE_SPUR_MAX_SPEED, sp + RIDE_SPUR_KICK);
      if (sp < target) sp = Math.min(target, sp + RIDE_ACCEL * dt);
      else if (sp > target) {
        let decel = RIDE_SLOW_DECEL;
        if (target === 0) decel = RIDE_STOP_DECEL;
        else if (gait === GAIT.gallop && sp > RIDE_GALLOP_SPEED) decel = RIDE_BURST_DECAY; // a spur's burst fades slowly
        sp = Math.max(target, sp - decel * dt);
      }
      if (sp === 0 && gait === GAIT.gallop && !fwd) gait = GAIT.trot;
      vx = dx * sp;
      vz = dz * sp;
    }
  } else if (sliding) {
    // Steeper than the steed can stand: slide down like a person past 50 degrees.
    const t = Math.sqrt(sl.t2);
    const a = (-GRAVITY * t) / (1 + sl.t2);
    vx -= (sl.gx / t) * a * dt;
    vz -= (sl.gz / t) * a * dt;
    const sp = Math.sqrt(vx * vx + vz * vz);
    if (sp > SLIDE_MAX_SPEED) {
      const k = SLIDE_MAX_SPEED / sp;
      vx *= k;
      vz *= k;
    }
    backing = false;
  }

  let vy = s.vel.y;
  if (!grounded) vy += GRAVITY * dt;
  let mount = true;
  if (grounded && !sliding && (flags & InputFlag.jump_edge) !== 0) {
    const sp = Math.sqrt(vx * vx + vz * vz);
    if (sp < RIDE_DISMOUNT_SPEED && !fwd) {
      mount = false; // hop off
      vy = JUMP_FORCE;
    } else vy = RIDE_JUMP_SPEED;
  }

  let x = s.pos.x + vx * dt;
  let y = s.pos.y + vy * dt;
  let z = s.pos.z + vz * dt;
  let groundY = ground.heightAt(x, z);

  if (grounded && !sliding) {
    // Uphill steeper than the steed walks is a wall (it never climbs): keep
    // the along-contour part, or stand.
    const dx = x - s.pos.x;
    const dz = z - s.pos.z;
    const rise = groundY - s.pos.y;
    if (rise > 0 && rise * rise > RIDE_WALKABLE_TAN_SQ * (dx * dx + dz * dz)) {
      const w = slopeAt(ground, x, z);
      if (w.t2 > RIDE_WALKABLE_TAN_SQ && !rideStepUpOK(ground, s.pos.x, s.pos.y, s.pos.z, dx, dz)) {
        const t = Math.sqrt(w.t2);
        const nx = w.gx / t;
        const nz = w.gz / t;
        const d = dx * nx + dz * nz;
        const x2 = s.pos.x + (dx - d * nx);
        const z2 = s.pos.z + (dz - d * nz);
        const vd = vx * nx + vz * nz;
        if (vd > 0) {
          vx -= vd * nx;
          vz -= vd * nz;
        }
        const gy2 = ground.heightAt(x2, z2);
        const rise2 = gy2 - s.pos.y;
        const ex = x2 - s.pos.x;
        const ez = z2 - s.pos.z;
        if (rise2 > 0 && rise2 * rise2 > RIDE_WALKABLE_TAN_SQ * (ex * ex + ez * ez) && slopeAt(ground, x2, z2).t2 > RIDE_WALKABLE_TAN_SQ) {
          x = s.pos.x;
          z = s.pos.z;
          groundY = h0;
          vx = 0;
          vz = 0;
        } else {
          x = x2;
          z = z2;
          groundY = gy2;
        }
      }
    }
    // Deep water ahead: the steed refuses (stands at the edge).
    if (waterAt(ground, x, z) - groundY >= RIDE_WADE_DEPTH_M) {
      x = s.pos.x;
      z = s.pos.z;
      groundY = h0;
      vx = 0;
      vz = 0;
    }
  }

  let thrown = false;
  if (y <= groundY || (vy <= 0 && y - groundY <= GROUND_SNAP_M)) {
    if (!grounded && vy <= -RIDE_THROW_FALL_SPEED) thrown = true;
    y = groundY;
    vy = 0;
  }
  let mode: number = y <= groundY + EPS ? MoveMode.ground : MoveMode.air;
  // Landing in (or riding off into) deep water: thrown, you swim.
  const w = waterAt(ground, x, z);
  if (w - groundY >= SWIM_DEPTH_M && y <= w - SWIM_FLOAT_DEPTH_M) {
    y = w - SWIM_FLOAT_DEPTH_M;
    vy = 0;
    mode = MoveMode.swim;
    thrown = true;
  }
  if (thrown) {
    mount = false;
    vx *= 0.3;
    vz *= 0.3;
  }

  // Stamina: a spur paid above; every other grounded walkable step counts
  // toward the regen delay and then refills, as on foot.
  if (grounded && !sliding && !spurred) {
    timer = Math.min(timer + 1, 255);
    if (timer >= REGEN_DELAY) stamina = Math.min(s.staminaMax, stamina + REGEN);
  }
  const lunge = mount ? gait | (sprint ? PREV_SPRINT : 0) | (backing ? BACKING : 0) : 0;
  const outFlags = (s.flags & EXHAUSTED) | (sliding ? SLIDING : 0) | (mount ? MOUNTED : 0);
  return { pos: { x, y, z }, vel: { x: vx, y: vy, z: vz }, airJumps: 0, mode, stamina, staminaMax: s.staminaMax, timer, lunge, flags: outFlags };
}

const R: CollideResult = { x: 0, y: 0, z: 0, pushX: 0, pushZ: 0, ceiling: false };

/**
 * The steed's chest: after the rider's own push-out, the point
 * RIDE_HEAD_PROBE_M ahead along the motion is pushed out of the same
 * colliders (buildings, props, camp pieces, cave walls) and the whole body
 * moves with it; velocity into the wall is removed. Mutates and returns out.
 */
export function collideHead(g: GroundQuery, out: MoveState): MoveState {
  if (!g.collide || (out.flags & MOUNTED) === 0) return out;
  const sp = Math.sqrt(out.vel.x * out.vel.x + out.vel.z * out.vel.z);
  if (sp < 0.1) return out;
  const px = out.pos.x + (out.vel.x / sp) * RIDE_HEAD_PROBE_M;
  const pz = out.pos.z + (out.vel.z / sp) * RIDE_HEAD_PROBE_M;
  const r = g.collide(px, out.pos.y, pz, R);
  if (r.pushX === 0 && r.pushZ === 0) return out;
  const l = Math.sqrt(r.pushX * r.pushX + r.pushZ * r.pushZ);
  const nx = r.pushX / l;
  const nz = r.pushZ / l;
  const vn = out.vel.x * nx + out.vel.z * nz;
  const vel = { ...out.vel };
  if (vn < 0) {
    vel.x = vel.x - vn * nx;
    vel.z = vel.z - vn * nz;
  }
  const pos = { x: out.pos.x + (r.x - px), y: out.pos.y, z: out.pos.z + (r.z - pz) };
  const fy = g.heightAt(pos.x, pos.z);
  if (out.mode === MoveMode.ground || pos.y < fy) {
    pos.y = fy;
    if (vel.y < 0) vel.y = 0;
  }
  return { ...out, pos, vel };
}
