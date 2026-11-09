// Movement sounds of the local player, derived from the per-frame
// localPlayer state (state/live.ts): footsteps by distance walked, jump and
// landing from grounded transitions, double jumps from airJumps, water
// entry and strokes, the glider opening, hand-over-hand climbing. There are
// no explicit movement events in the sim, so this is the one place that
// turns state changes into sound moments. Pure (no Web Audio): it returns
// the triggers to fire, and movement.test.ts drives it.

import type { MoveMode } from '../state/live';
import type { TriggerName, TriggerPayload } from './triggers';
import type { StepSurface } from './surface';

export interface MoveSnapshot {
  mode: MoveMode;
  grounded: boolean;
  pos: { x: number; y: number; z: number };
  vel: { x: number; y: number; z: number };
  airJumps: number;
  /** 0..1 */
  underground: number;
  inTown: boolean;
  /** What is underfoot (surface.ts classifySurface, sampled by the engine); else stone in towns and caves, soft ground elsewhere. */
  surface?: StepSurface;
}

export type Fired = [TriggerName, TriggerPayload];

export const STEP_WALK_M = 1.7;
export const STEP_SPRINT_M = 2.3;
export const CLIMB_GRAB_M = 0.55;
export const SWIM_STROKE_S = 1.1;
/** Falls slower than this land silently (stairs, small bumps). */
export const LAND_MIN_SPEED = 3;

export class MovementSounds {
  private prev: MoveSnapshot | null = null;
  private stepAcc = 0;
  private climbAcc = 0;
  private swimAcc = 0;
  private fallSpeed = 0;

  update(s: MoveSnapshot, dt: number): Fired[] {
    const out: Fired[] = [];
    const p = this.prev;
    this.prev = { ...s, pos: { ...s.pos }, vel: { ...s.vel } };
    if (!p) return out;
    const dx = s.pos.x - p.pos.x;
    const dz = s.pos.z - p.pos.z;
    const dy = s.pos.y - p.pos.y;
    const horiz = Math.hypot(dx, dz);
    // A teleport (respawn, fast travel, handoff) is not a step.
    if (horiz > 12 || Math.abs(dy) > 12) {
      this.stepAcc = this.climbAcc = 0;
      return out;
    }
    const surface: StepSurface = s.surface ?? (s.underground > 0.5 || s.inTown ? 'hard' : 'soft');
    if (!s.grounded && s.mode !== 'swim' && s.mode !== 'climb') this.fallSpeed = Math.max(this.fallSpeed, -s.vel.y);

    // Footsteps
    if (s.grounded && (s.mode === 'walk' || s.mode === 'sprint')) {
      this.stepAcc += horiz;
      const stride = s.mode === 'sprint' ? STEP_SPRINT_M : STEP_WALK_M;
      if (this.stepAcc >= stride) {
        this.stepAcc -= stride;
        out.push(['step', { surface }]);
      }
    } else if (s.grounded) this.stepAcc = Math.min(this.stepAcc, STEP_WALK_M * 0.6);

    // Jump / land / double jump
    if (p.grounded && !s.grounded && s.vel.y > 2 && s.mode !== 'swim') out.push(['jump', {}]);
    if (!p.grounded && s.grounded) {
      if (this.fallSpeed >= LAND_MIN_SPEED) out.push(['land', { speed: this.fallSpeed, surface }]);
      this.fallSpeed = 0;
      this.stepAcc = 0;
    }
    if (s.airJumps > p.airJumps) out.push(['jump', {}]);

    // Water
    if (s.mode === 'swim' && p.mode !== 'swim') {
      out.push(['splash', {}]);
      this.swimAcc = 0;
      this.fallSpeed = 0;
    }
    if (s.mode === 'swim' && horiz / Math.max(dt, 1e-3) > 0.8) {
      this.swimAcc += dt;
      if (this.swimAcc >= SWIM_STROKE_S) {
        this.swimAcc = 0;
        out.push(['swim', {}]);
      }
    }

    // Glider
    if (s.mode === 'glide' && p.mode !== 'glide') {
      out.push(['glide_open', {}]);
      this.fallSpeed = 0;
    }
    if (s.mode === 'glide') this.fallSpeed = 0;

    // Climbing
    if (s.mode === 'climb') {
      if (p.mode !== 'climb') {
        out.push(['climb', {}]);
        this.climbAcc = 0;
      }
      this.climbAcc += Math.abs(dy) + horiz * 0.5;
      if (this.climbAcc >= CLIMB_GRAB_M) {
        this.climbAcc = 0;
        out.push(['climb', {}]);
      }
      this.fallSpeed = 0;
    }
    return out;
  }
}
