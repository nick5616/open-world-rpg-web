// WP13 (CR 005): the dodge and mobility-spell dashes inside the shared
// movement step. Line-for-line twin of server/pkg/movement/dash.go: a dash
// starts on a step whose input has the dodge flag, castSlot names the
// variant (0 = plain dodge, constants DODGE_*; 1..15 = combat.yaml dashes),
// the horizontal velocity is set to dir * speed and held for `steps` steps
// (no friction, no steering), then clamped to DASH_EXIT_SPEED. I-frames
// count down independently; a new dash starts once both counters are 0.
// Whether a variant is allowed (equipped, cooldown, mana) is the combat
// layer's call (client/src/combat/timeline.ts on this side, the zone's
// combat layer on the other), never the step's. Change both twins together.

import { COMBAT, DASH_EXIT_SPEED, DODGE_DASH_STEPS, DODGE_IFRAME_STEPS, DODGE_SPEED, DODGE_STAMINA, InputFlag, MoveMode, STAMINA_FINE_PER_POINT } from '@lodestone/contracts';
import type { MoveState, Vec2xz } from './movement';

export interface DashVariant {
  speed: number;
  steps: number;
  iframes: number;
  lift: number;
  /** Stamina cost, fine units. */
  cost: number;
  /** No key held: dash backwards (the plain dodge) instead of forwards. */
  back: boolean;
}

const VARIANTS: (DashVariant | null)[] = (() => {
  const t: (DashVariant | null)[] = new Array(16).fill(null);
  t[0] = { speed: DODGE_SPEED, steps: DODGE_DASH_STEPS, iframes: DODGE_IFRAME_STEPS, lift: 0, cost: Math.round(DODGE_STAMINA * STAMINA_FINE_PER_POINT), back: true };
  for (const d of COMBAT.dashes) if (d.id >= 1 && d.id <= 15) t[d.id] = { speed: d.speed, steps: d.steps, iframes: d.iframes, lift: d.lift, cost: 0, back: false };
  return t;
})();

export function dashVariant(v: number): DashVariant | null {
  return v >= 0 && v <= 15 ? VARIANTS[v] : null;
}

export const invulnerable = (s: Pick<MoveState, 'iframes'>): boolean => (s.iframes ?? 0) > 0;
export const dashing = (s: Pick<MoveState, 'dash'>): boolean => (s.dash ?? 0) > 0;

/**
 * The dash part of a step, before the mode dispatch (Go beginDash): timers
 * down, exit clamp for a dash that just ended, start a new one if asked and
 * allowed. Returns the state the mode step runs on (a copy) and whether this
 * step is a dashing step.
 */
export function beginDash(s: MoveState, flags: number, castSlot: number, yaw: number, wish: Vec2xz): { state: MoveState; dashing: boolean } {
  const prevDash = s.dash ?? 0;
  const d: MoveState = { ...s, pos: { ...s.pos }, vel: { ...s.vel }, dash: Math.max(0, prevDash - 1), iframes: Math.max(0, (s.iframes ?? 0) - 1) };
  if (prevDash === 1) {
    const sp = Math.sqrt(d.vel.x * d.vel.x + d.vel.z * d.vel.z);
    if (sp > DASH_EXIT_SPEED) {
      const k = DASH_EXIT_SPEED / sp;
      d.vel.x *= k;
      d.vel.z *= k;
    }
  }
  let isDashing = (d.dash ?? 0) > 0;
  if ((flags & InputFlag.dodge) === 0 || d.dash !== 0 || d.iframes !== 0) return { state: d, dashing: isDashing };
  if (d.mode !== MoveMode.ground && d.mode !== MoveMode.air && d.mode !== MoveMode.glide) return { state: d, dashing: isDashing };
  const v = dashVariant(castSlot);
  const canUse = (d.flags & 1) === 0 && d.stamina > 0; // MoveFlag.exhausted
  if (!v || (v.cost > 0 && !canUse)) return { state: d, dashing: isDashing };
  let dx = wish.x;
  let dz = wish.z;
  if (dx === 0 && dz === 0) {
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    if (v.back) {
      dx = sn;
      dz = c;
    } else {
      dx = -sn;
      dz = -c;
    }
  }
  d.vel.x = dx * v.speed;
  d.vel.z = dz * v.speed;
  if (v.lift > 0) d.vel.y = v.lift;
  d.stamina -= Math.min(d.stamina, v.cost);
  d.timer = 0;
  d.dash = v.steps;
  d.iframes = v.iframes;
  if (d.mode === MoveMode.glide) d.mode = MoveMode.air;
  isDashing = true;
  return { state: d, dashing: isDashing };
}
