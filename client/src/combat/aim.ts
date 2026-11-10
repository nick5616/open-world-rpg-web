// Where a caster's aim lands (playtest 2, CR 022 shared spell visuals): one
// implementation for your own prediction (runtime.ts: claims and your
// visuals) and for drawing other players' spells (fx/engine.ts), so a beam,
// a rain point or a windup sigil lands on the same body or ground point on
// every client given the same aim.

import type { RemoteView } from '../net/interpolation';
import { isHostilePlayer } from '../ui/pvp/hostile';
import { enemyInfo } from './events';

export type V3 = { x: number; y: number; z: number };

/** Combat code shoots from this height above the feet (the eye; projectiles leave 0.15 m lower). */
export const AIM_EYE = 1.6;
/** A projectile's true path starts here above the feet (its visual eases in from the hand). */
export const SHOT_Y = AIM_EYE - 0.15;

/** Unit look vector (yaw 0 = -Z, pitch up positive). */
export function lookDir(yaw: number, pitch: number, out: V3 = { x: 0, y: 0, z: 0 }): V3 {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}

/**
 * The first ground point along the look ray from `eye` (0.5 m steps), or the
 * point at `range` dropped to the ground. `heightAt` is the terrain the
 * caller draws or validates on.
 */
export function aimPoint(eye: V3, yaw: number, pitch: number, range: number, heightAt: ((x: number, z: number, nearY: number) => number) | null): V3 {
  const d = lookDir(yaw, pitch);
  for (let s = 1; s <= range; s += 0.5) {
    const x = eye.x + d.x * s;
    const y = eye.y + d.y * s;
    const z = eye.z + d.z * s;
    const g = heightAt ? heightAt(x, z, eye.y) : 0;
    if (y <= g) return { x, y: g, z };
  }
  const x = eye.x + d.x * range;
  const z = eye.z + d.z * range;
  return { x, y: heightAt ? heightAt(x, z, eye.y) : eye.y + d.y * range, z };
}

/** What an aimed spell can land on: living enemies and demons, and players you may fight (PvP, duels). */
export function aimable(v: RemoteView): boolean {
  return ((v.kind === 2 || v.kind === 6) && v.healthPct > 0) || isHostilePlayer(v);
}

/** The body nearest the look ray within `range` and `deg` degrees (its radius widens the cone). */
export function aimTarget(eye: V3, yaw: number, pitch: number, range: number, deg: number, bodies: readonly RemoteView[], ok: (v: RemoteView) => boolean = aimable): RemoteView | null {
  const f = lookDir(yaw, pitch);
  let best: RemoteView | null = null;
  let bestA = (deg * Math.PI) / 180;
  for (const e of bodies) {
    if (!ok(e)) continue;
    const vx = e.x - eye.x;
    const vy = e.y + 0.9 - eye.y;
    const vz = e.z - eye.z;
    const d = Math.hypot(vx, vy, vz);
    if (d > range + 1 || d < 0.1) continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, (vx * f.x + vy * f.y + vz * f.z) / d))) - Math.atan2(enemyInfo(e).radius, d);
    if (ang < bestA) {
      bestA = ang;
      best = e;
    }
  }
  return best;
}

/** A body's aim point (its chest). */
export function bodyCenter(e: RemoteView): V3 {
  return { x: e.x, y: e.y + enemyInfo(e).height, z: e.z };
}

/**
 * A beam's or hitscan's end: the body it locks (6 deg) or the ground along
 * the aim. The same call draws your beam and another player's.
 */
export function beamEnd(eye: V3, yaw: number, pitch: number, range: number, bodies: readonly RemoteView[], heightAt: ((x: number, z: number, nearY: number) => number) | null): { at: V3; target: RemoteView | null } {
  const t = aimTarget(eye, yaw, pitch, range, 6, bodies);
  return t ? { at: bodyCenter(t), target: t } : { at: aimPoint(eye, yaw, pitch, range, heightAt), target: null };
}

/** Event 226's value: u16 yaw | i16 pitch << 16 (the input frame's encoding). */
export function unpackHeldAim(value: number): { yaw16: number; pitch16: number } {
  const u = value >>> 0;
  const p = (u >>> 16) & 0xffff;
  return { yaw16: u & 0xffff, pitch16: p >= 0x8000 ? p - 0x10000 : p };
}

/** Smallest signed difference a - b of two angles (radians). */
export function angleDelta(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
