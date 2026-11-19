// Caves in the movement step (WP09): the TS twin of server/pkg/movement/caves.go.
//
// The step is a heightfield state machine (WP10): every mode asks
// ground.heightAt(x, z). Two optional hooks plug caves in without touching
// the modes:
//  1. atLevel(y): at the start of a step the ground is viewed at the
//     player's feet height. In a cave that view's heightAt is the highest
//     cave floor at or below feet + MAX_STEP_UP_M (probes inside rock read
//     level; water reads -Infinity underground); elsewhere it is the
//     surface (terrain + structures) unchanged.
//  2. collide(x, y, z, out): after the mode step, one wall/ceiling push-out
//     (not while climbing): horizontal velocity slides along the push, a
//     ceiling stops a rising jump, a grounded player is re-snapped to the
//     floor at the pushed point.
// Grounds without caves implement neither and step exactly as before.

import { MoveMode } from '@lodestone/contracts';
import type { CollideResult, GroundQuery } from './ground';
import type { MoveState } from './movement';

/** g viewed at feet height y (g itself unless it has caves). */
export function atLevel(g: GroundQuery, y: number): GroundQuery {
  return g.atLevel ? g.atLevel(y) : g;
}

/** The ground under a player whose feet are at y (what the step stands on). */
export function groundAt(g: GroundQuery, x: number, y: number, z: number): number {
  return atLevel(g, y).heightAt(x, z);
}

/** How far under the raw surface a step may end before surfaceGuard calls it a wall (the caves' UnderM). */
export const SURFACE_GUARD_M = 1;

/**
 * A step that starts on the open surface never ends inside the terrain
 * (playtest 2 co-op polish: the rider who fell 330 m). The level view comes
 * from the step's START feet height, so a probe one fast step ahead where a
 * cliff already stands more than UnderM above those feet was read by the
 * cave rules (open cave air: no floor; rock: the feet's own height) and the
 * step went into the hill. The way ahead is a wall: keep the start x, z,
 * drop the horizontal speed. Twin of surfaceGuard in
 * server/pkg/movement/caves.go; grounds without levels never reach it.
 */
export function surfaceGuard(raw: GroundQuery, lv: GroundQuery, s: MoveState, out: MoveState, eps: number): MoveState {
  if (!raw.atLevel || s.mode === MoveMode.climb || out.mode === MoveMode.climb || out.mode === MoveMode.swim) return out;
  const h0 = raw.heightAt(s.pos.x, s.pos.z);
  if (s.pos.y < h0 - SURFACE_GUARD_M || lv.heightAt(s.pos.x, s.pos.z) !== h0 || out.pos.y >= raw.heightAt(out.pos.x, out.pos.z) - SURFACE_GUARD_M) return out;
  const pos = { x: s.pos.x, y: out.pos.y, z: s.pos.z };
  const vel = { x: 0, y: out.vel.y, z: 0 };
  let mode = out.mode;
  const fy = lv.heightAt(s.pos.x, s.pos.z);
  if (pos.y <= fy + eps) {
    pos.y = fy;
    if (vel.y < 0) vel.y = 0;
    mode = MoveMode.ground;
  }
  return { ...out, pos, vel, mode };
}

const R: CollideResult = { x: 0, y: 0, z: 0, pushX: 0, pushZ: 0, ceiling: false };

/** Cave push-out on a mode step's result; g is the level view the step used. Mutates and returns out. */
export function collideStep(g: GroundQuery, out: MoveState): MoveState {
  if (!g.collide || out.mode === MoveMode.climb) return out;
  const r = g.collide(out.pos.x, out.pos.y, out.pos.z, R);
  if (r.pushX === 0 && r.pushZ === 0 && !r.ceiling) return out;
  const vel = { ...out.vel };
  if (r.pushX !== 0 || r.pushZ !== 0) {
    const l = Math.sqrt(r.pushX * r.pushX + r.pushZ * r.pushZ);
    const nx = r.pushX / l;
    const nz = r.pushZ / l;
    const vn = vel.x * nx + vel.z * nz;
    if (vn < 0) {
      vel.x = vel.x - vn * nx;
      vel.z = vel.z - vn * nz;
    }
  }
  const pos = { x: r.x, y: r.y, z: r.z };
  if (r.ceiling && vel.y > 0) vel.y = 0;
  const fy = g.heightAt(pos.x, pos.z);
  if (out.mode === MoveMode.ground || pos.y < fy) {
    pos.y = fy;
    if (vel.y < 0) vel.y = 0;
  }
  return { ...out, pos, vel };
}
