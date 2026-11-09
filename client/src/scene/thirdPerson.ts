// Third-person camera math (playtest 2: "Need third person mode"). Pure and
// allocation-free per frame, so it is unit tested without a renderer
// (thirdPerson.test.ts) and costs a few dozen ground queries a frame.
//
//  - The boom: from the eye, out to a shoulder pivot (right or left, a little
//    above the head), then straight back along the view direction (yaw AND
//    pitch, so looking up lowers the camera behind the player and looking
//    down raises it). The camera keeps the view's orientation: mouse look is
//    exactly the first-person look (raw deltas, no smoothing added here).
//  - Collision: both legs of the boom are swept against "blocked" (terrain
//    with a clearance, building walls and ceilings, cave rock: the movement
//    ground's own queries, CameraProbe below). A blocked boom shortens at
//    once (the camera never enters a wall or the ground, not even for one
//    frame) and grows back eased, so it doesn't pump in and out of corners.
//  - Aim: the crosshair is the camera's view ray. Things the player shoots
//    or casts leave from the eye, which is beside that ray, so the combat
//    aim is converged: the direction from the eye to the first thing the
//    crosshair ray hits (an enemy, the terrain, or a point far out). Melee
//    cones and movement keep the plain view yaw (what the zone validates
//    them against); the converged ray only steers projectiles, beams and
//    aimed area spells, well inside the zone's aim slack (30 degrees).

import { atLevel } from '../sim/caves';
import type { CollideResult, GroundQuery } from '../sim/ground';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Is a camera at (x, y, z) inside something (terrain, a wall, a ceiling)? */
export type Blocked = (x: number, y: number, z: number) => boolean;

export const THIRD = {
  /** Shoulder pivot: this far to the side of the eye (m) ... */
  shoulderX: 0.55,
  /** ... and this far above it. */
  shoulderY: 0.25,
  /** Sample spacing of the collision sweep (m); walls are at least 2 x the probe radius thick. */
  step: 0.2,
  /** Pulled back this far from whatever blocked the boom (m). */
  margin: 0.08,
  /** A blocked boom grows back with this time constant (s); shortening is instant. */
  easeOutS: 0.2,
  /** Vertical follow smoothing of the pivot (s): step-ups and landings don't jolt the view. */
  followYS: 0.06,
  /** Keep the camera this far above the terrain (m). */
  clearance: 0.3,
  /** Boom shorter than this: the camera is in the head, hide the own avatar. */
  hideAvatarBelow: 0.75,
  /** Crosshair convergence: how far the crosshair ray looks for something to aim at (m). */
  aimRange: 90,
  /** ... and the largest correction applied to the eye's aim (rad). */
  aimMaxCorrection: (20 * Math.PI) / 180,
} as const;

/** View direction for yaw/pitch (yaw 0 looks down -Z, the camera convention). */
export function forwardOf(yaw: number, pitch: number, out: Vec3): Vec3 {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}

/** Horizontal right-hand direction for yaw. */
export function rightOf(yaw: number, out: Vec3): Vec3 {
  out.x = Math.cos(yaw);
  out.y = 0;
  out.z = -Math.sin(yaw);
  return out;
}

/**
 * How far along the segment a -> b (0..1) is free: samples every `step` m,
 * and on the first blocked sample bisects back to the boundary. a itself is
 * assumed free (the eye is inside the player's own collision body).
 */
export function sweep(ax: number, ay: number, az: number, bx: number, by: number, bz: number, blocked: Blocked, step: number = THIRD.step): number {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-6) return 1;
  const n = Math.max(1, Math.ceil(len / step));
  let free = 0;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    if (blocked(ax + dx * t, ay + dy * t, az + dz * t)) {
      let lo = free;
      let hi = t;
      for (let k = 0; k < 6; k++) {
        const m = (lo + hi) / 2;
        if (blocked(ax + dx * m, ay + dy * m, az + dz * m)) hi = m;
        else lo = m;
      }
      return lo;
    }
    free = t;
  }
  return 1;
}

/** The boom's state between frames (one per camera). */
export class Boom {
  /** Current boom length (m) behind the pivot. */
  dist = 0;
  /** Current share of the shoulder offset (0..1; walls beside the head shrink it). */
  side = 0;
  /** Smoothed eye height (m). */
  private eyeY = 0;
  private init = false;
  /** Where the camera is (written by update). */
  readonly cam: Vec3 = { x: 0, y: 0, z: 0 };
  /** The shoulder pivot the boom hangs from. */
  readonly pivot: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly f: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly r: Vec3 = { x: 0, y: 0, z: 0 };

  /** Forget the history (teleports, switching view): the next update snaps. */
  reset(): void {
    this.init = false;
  }

  /**
   * Place the camera for this frame: eye = the player's eye (drawn), the
   * view's yaw/pitch, shoulder +1/-1, wanted boom length. Returns `cam`.
   */
  update(eye: Vec3, yaw: number, pitch: number, shoulder: number, distance: number, blocked: Blocked, dt: number): Vec3 {
    if (!this.init) {
      this.eyeY = eye.y;
      this.dist = 0;
      this.side = 0;
    }
    // Vertical follow: smooth small steps, never lag more than half a metre.
    const k = this.init ? 1 - Math.exp(-Math.max(0, dt) / THIRD.followYS) : 1;
    this.eyeY += (eye.y - this.eyeY) * k;
    if (Math.abs(eye.y - this.eyeY) > 0.5) this.eyeY = eye.y - Math.sign(eye.y - this.eyeY) * 0.5;
    const ey = this.eyeY;
    // A smoothed eye below the real one could start the sweep inside the
    // ground on a steep climb; the real eye is always free, so fall back to it.
    const ex = eye.x;
    const ez = eye.z;
    const y0 = blocked(ex, ey, ez) ? eye.y : ey;

    const f = forwardOf(yaw, pitch, this.f);
    const r = rightOf(yaw, this.r);
    const grow = this.init ? 1 - Math.exp(-Math.max(0, dt) / THIRD.easeOutS) : 1;

    // Leg 1: eye -> shoulder pivot.
    const sx = r.x * THIRD.shoulderX * shoulder;
    const sz = r.z * THIRD.shoulderX * shoulder;
    const sy = THIRD.shoulderY;
    const sideLen = Math.sqrt(sx * sx + sy * sy + sz * sz);
    let s1 = sweep(ex, y0, ez, ex + sx, y0 + sy, ez + sz, blocked);
    if (s1 < 1) s1 = Math.max(0, s1 - THIRD.margin / sideLen);
    this.side = s1 < this.side ? s1 : this.side + (s1 - this.side) * grow;
    const p = this.pivot;
    p.x = ex + sx * this.side;
    p.y = y0 + sy * this.side;
    p.z = ez + sz * this.side;

    // Leg 2: pivot -> straight back along the view.
    const s2 = sweep(p.x, p.y, p.z, p.x - f.x * distance, p.y - f.y * distance, p.z - f.z * distance, blocked);
    const allowed = s2 < 1 ? Math.max(0, s2 * distance - THIRD.margin) : distance;
    this.dist = allowed < this.dist ? allowed : this.dist + (allowed - this.dist) * grow;
    const c = this.cam;
    c.x = p.x - f.x * this.dist;
    c.y = p.y - f.y * this.dist;
    c.z = p.z - f.z * this.dist;
    this.init = true;
    return c;
  }
}

/** Collision body radius (PLAYER_CAPSULE_RADIUS) minus the camera's own clearance from walls (0.2 m). */
const WALL_PUSH = 0.2;

/**
 * "Is a camera here inside something" from the movement ground (the same
 * terrain, building boxes and cave rock the player collides with): below
 * the terrain (+ clearance), or touching a wall or ceiling, using the
 * player's own push-out query centred on the camera (the body capsule's
 * radius keeps the near plane off the walls). One level view per frame.
 */
export class CameraProbe {
  private lv: GroundQuery | null = null;
  private readonly res: CollideResult = { x: 0, y: 0, z: 0, pushX: 0, pushZ: 0, ceiling: false };

  /** View the ground at the player's feet height for this frame. */
  setLevel(g: GroundQuery, feetY: number): void {
    this.lv = atLevel(g, feetY);
  }

  readonly blocked: Blocked = (x, y, z) => {
    const lv = this.lv;
    if (!lv) return false;
    if (y < lv.heightAt(x, z) + THIRD.clearance) return true;
    if (lv.collide) {
      // The body runs from its feet to 1.9 m above with a 0.4 m radius; with
      // its feet 1.5 m below the camera, ceilings within 0.4 m above count,
      // and a push longer than 0.2 m means a wall within 0.2 m (a camera
      // sliding along a wall at the body's own distance is not blocked).
      const r = lv.collide(x, y - 1.5, z, this.res);
      if (r.ceiling || r.pushX * r.pushX + r.pushZ * r.pushZ > WALL_PUSH * WALL_PUSH) return true;
    }
    return false;
  };
}

/** Something the crosshair can land on: a sphere at (x, y, z) of radius r. */
export interface AimSphere {
  x: number;
  y: number;
  z: number;
  r: number;
}

/**
 * Distance along the ray (o, unit d) to the first hit, from `start` out to
 * `range`: spheres analytically, the terrain by marching (0.75 m steps near,
 * 1.5 m far) and bisecting. Returns `range` when nothing is hit.
 */
export function crosshairDistance(o: Vec3, d: Vec3, start: number, range: number, heightAt: ((x: number, z: number) => number) | null, spheres: readonly AimSphere[]): number {
  let best = range;
  for (const s of spheres) {
    const vx = s.x - o.x;
    const vy = s.y - o.y;
    const vz = s.z - o.z;
    const tc = vx * d.x + vy * d.y + vz * d.z;
    if (tc < start) continue;
    const d2 = vx * vx + vy * vy + vz * vz - tc * tc;
    const r2 = s.r * s.r;
    if (d2 > r2) continue;
    const t = tc - Math.sqrt(r2 - d2);
    if (t < best) best = Math.max(start, t);
  }
  if (!heightAt) return best;
  let prev = start;
  for (let t = start; t < best; ) {
    const y = o.y + d.y * t;
    if (y < heightAt(o.x + d.x * t, o.z + d.z * t)) {
      let lo = prev;
      let hi = t;
      for (let k = 0; k < 5; k++) {
        const m = (lo + hi) / 2;
        if (o.y + d.y * m < heightAt(o.x + d.x * m, o.z + d.z * m)) hi = m;
        else lo = m;
      }
      return Math.min(best, hi);
    }
    prev = t;
    t += t < 24 ? 0.75 : 1.5;
  }
  return best;
}

/**
 * The converged combat aim: yaw/pitch from the eye to point p, unless that
 * turns further than THIRD.aimMaxCorrection from the view (a point right
 * beside the eye: keep the view's aim). Writes out, returns it.
 */
export function aimFromEye(eye: Vec3, p: Vec3, viewYaw: number, viewPitch: number, out: { yaw: number; pitch: number }): { yaw: number; pitch: number } {
  const dx = p.x - eye.x;
  const dy = p.y - eye.y;
  const dz = p.z - eye.z;
  const h = Math.sqrt(dx * dx + dz * dz);
  out.yaw = viewYaw;
  out.pitch = viewPitch;
  if (h + Math.abs(dy) < 1.5) return out;
  const yaw = Math.atan2(-dx, -dz);
  const pitch = Math.atan2(dy, h);
  // angle between the two directions
  const cpa = Math.cos(pitch);
  const cpb = Math.cos(viewPitch);
  const dot = cpa * cpb * Math.cos(yaw - viewYaw) + Math.sin(pitch) * Math.sin(viewPitch);
  if (Math.acos(Math.max(-1, Math.min(1, dot))) > THIRD.aimMaxCorrection) return out;
  // keep yaw continuous with the view's (no wrap jump)
  let dyaw = yaw - viewYaw;
  dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
  out.yaw = viewYaw + dyaw;
  out.pitch = pitch;
  return out;
}
