// WP13 (CR 009): the dodge and mobility-spell dashes inside the shared
// movement step. Line-for-line twin of server/pkg/movement/dash.go: a dash
// starts on a step whose input has the dodge flag, castSlot names the
// variant (0 = plain dodge, constants DODGE_*; 1..15 = combat.yaml dashes),
// the horizontal velocity is set to dir * speed and held for `steps` steps
// (no friction, no steering), then clamped to the variant's exit speed.
// I-frames count down independently; a new dash starts once both counters
// are 0. Whether a variant is allowed (equipped, cooldown, mana) is the
// combat layer's call (client/src/combat/timeline.ts on this side, the
// zone's combat layer on the other), never the step's. Change both twins
// together.
//
// Playtest 2 dash overhaul (CR 021): `aim: look` starts along the 3D look
// (yaw and pitch), and a running dash is HELD by frames with
// InputFlag.channel + castSlot = a variant with a sustain block (no attack,
// dodge or cast): it re-arms carrySteps and applies the kind (jet, dash,
// skate over water, blink pulses, glide, phase). The client names the
// running variant in castSlot on every step of the dash, so the exit clamp
// knows its exit speed. See dash.go for the whole contract.

import { COMBAT, DASH_EXIT_SPEED, DODGE_DASH_STEPS, DODGE_IFRAME_STEPS, DODGE_SPEED, DODGE_STAMINA, GRAVITY, InputFlag, MoveMode, STAMINA_FINE_PER_POINT } from '@lodestone/contracts';
import type { GroundQuery } from './ground';
import type { MoveState, Vec2xz } from './movement';

/** Sustain kinds (combat.yaml dashes.*.sustain.kind; Go combatdefs.Sustain*). */
export const SUSTAIN = { jet: 1, dash: 2, skate: 3, blink: 4, glide: 5, phase: 6 } as const;

export interface DashVariant {
  speed: number;
  steps: number;
  iframes: number;
  lift: number;
  /** Stamina cost, fine units. */
  cost: number;
  /** No key held: dash backwards (the plain dodge) instead of forwards. */
  back: boolean;
  /** CR 021: start along the 3D look direction. */
  look: boolean;
  /** Horizontal speed kept when the dash ends. */
  exit: number;
  /** Sustain kind (0 none) and its numbers. */
  kind: number;
  susSpeed: number;
  steer: number;
  carry: number;
  blinkSpeed: number;
  blinkEvery: number;
  sink: number;
}

const VARIANTS: (DashVariant | null)[] = (() => {
  const t: (DashVariant | null)[] = new Array(16).fill(null);
  const none = { kind: 0, susSpeed: 0, steer: 0, carry: 0, blinkSpeed: 0, blinkEvery: 0, sink: 0 };
  t[0] = { speed: DODGE_SPEED, steps: DODGE_DASH_STEPS, iframes: DODGE_IFRAME_STEPS, lift: 0, cost: Math.round(DODGE_STAMINA * STAMINA_FINE_PER_POINT), back: true, look: false, exit: DASH_EXIT_SPEED, ...none };
  for (const d of COMBAT.dashes) {
    if (d.id < 1 || d.id > 15) continue;
    const s = d.sustain;
    t[d.id] = {
      speed: d.speed,
      steps: d.steps,
      iframes: d.iframes,
      lift: d.lift,
      cost: 0,
      back: false,
      look: d.aim === 'look',
      exit: d.exitSpeed > 0 ? d.exitSpeed : DASH_EXIT_SPEED,
      ...(s ? { kind: s.kindId, susSpeed: s.speed, steer: s.steer, carry: s.carrySteps, blinkSpeed: s.blinkSpeed, blinkEvery: s.blinkEvery, sink: s.sink } : none),
    };
  }
  return t;
})();

export function dashVariant(v: number): DashVariant | null {
  return v >= 0 && v <= 15 ? VARIANTS[v] : null;
}

export const invulnerable = (s: Pick<MoveState, 'iframes'>): boolean => (s.iframes ?? 0) > 0;
export const dashing = (s: Pick<MoveState, 'dash'>): boolean => (s.dash ?? 0) > 0;

const SUSTAIN_BLOCK = InputFlag.attack | InputFlag.dodge | InputFlag.cast;

/** Do these frame bits hold the dash `prev` is running? (Go Holding.) */
export function holding(prev: Pick<MoveState, 'dash'>, flags: number, castSlot: number): boolean {
  if ((prev.dash ?? 0) <= 0 || (flags & InputFlag.channel) === 0 || (flags & SUSTAIN_BLOCK) !== 0) return false;
  const v = dashVariant(castSlot);
  return !!v && v.kind !== 0 && castSlot !== 0;
}

function lookDir(yaw: number, pitch: number): { x: number; y: number; z: number } {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

/**
 * The dash part of a step, before the mode dispatch (Go beginDash): timers
 * down, sustain a held dash, exit clamp for a dash that just ended, start a
 * new one if asked and allowed. Returns the state the mode step runs on (a
 * copy), whether this step is a dashing step and the sustain kind applied.
 */
export function beginDash(s: MoveState, flags: number, castSlot: number, yaw: number, pitch: number, wish: Vec2xz, grounded: boolean, dt: number): { state: MoveState; dashing: boolean; kind: number } {
  const prevDash = s.dash ?? 0;
  const d: MoveState = { ...s, pos: { ...s.pos }, vel: { ...s.vel }, dash: Math.max(0, prevDash - 1), iframes: Math.max(0, (s.iframes ?? 0) - 1) };
  let kind = 0;
  if (holding(s, flags, castSlot) && (d.mode === MoveMode.ground || d.mode === MoveMode.air || d.mode === MoveMode.glide)) {
    const v = dashVariant(castSlot)!;
    kind = v.kind;
    let dx = wish.x;
    let dz = wish.z;
    if (dx === 0 && dz === 0) {
      dx = -Math.sin(yaw);
      dz = -Math.cos(yaw);
    }
    let sp = v.susSpeed;
    if (v.kind === SUSTAIN.jet) {
      const f = lookDir(yaw, pitch);
      const k = v.steer;
      d.vel.x += (f.x * sp - d.vel.x) * k;
      d.vel.y += (f.y * sp - d.vel.y) * k;
      d.vel.z += (f.z * sp - d.vel.z) * k;
      if (!grounded) d.vel.y -= GRAVITY * dt; // the walk step adds it back: thrust holds you up
    } else {
      if (v.kind === SUSTAIN.blink && prevDash <= 1) sp = v.blinkSpeed; // one step at blink speed, re-armed
      d.vel.x = dx * sp;
      d.vel.z = dz * sp;
    }
    if (v.kind === SUSTAIN.blink) {
      if (prevDash <= 1) d.dash = v.blinkEvery;
    } else d.dash = v.carry;
    if (v.kind === SUSTAIN.glide && d.vel.y < -v.sink) d.vel.y = -v.sink;
    if (v.kind === SUSTAIN.phase) d.iframes = Math.max(d.iframes ?? 0, 2);
    if (d.mode === MoveMode.glide) d.mode = MoveMode.air;
  } else if (prevDash === 1) {
    let exit = DASH_EXIT_SPEED;
    const ev = dashVariant(castSlot);
    if (ev && castSlot !== 0 && (flags & SUSTAIN_BLOCK) === 0) exit = ev.exit; // the client names the running variant on every step of it
    const sp = Math.sqrt(d.vel.x * d.vel.x + d.vel.z * d.vel.z);
    if (sp > exit) {
      const k = exit / sp;
      d.vel.x *= k;
      d.vel.z *= k;
    }
  }
  let isDashing = (d.dash ?? 0) > 0;
  if ((flags & InputFlag.dodge) === 0 || d.dash !== 0 || d.iframes !== 0) return { state: d, dashing: isDashing, kind };
  if (d.mode !== MoveMode.ground && d.mode !== MoveMode.air && d.mode !== MoveMode.glide) return { state: d, dashing: isDashing, kind };
  const v = dashVariant(castSlot);
  const canUse = (d.flags & 1) === 0 && d.stamina > 0; // MoveFlag.exhausted
  if (!v || (v.cost > 0 && !canUse)) return { state: d, dashing: isDashing, kind };
  if (v.look) {
    const f = lookDir(yaw, pitch);
    d.vel.x = f.x * v.speed;
    d.vel.y = f.y * v.speed;
    d.vel.z = f.z * v.speed;
  } else {
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
  }
  if (v.lift > 0) d.vel.y = v.lift;
  d.stamina -= Math.min(d.stamina, v.cost);
  d.timer = 0;
  d.dash = v.steps;
  d.iframes = v.iframes;
  if (d.mode === MoveMode.glide) d.mode = MoveMode.air;
  isDashing = true;
  return { state: d, dashing: isDashing, kind };
}

/** Glacier step's held skate (Go skateGround): water is ground, and there is no water to swim in. */
export function skateGround(g: GroundQuery): GroundQuery {
  return { heightAt: (x, z) => Math.max(g.heightAt(x, z), g.waterAt ? g.waterAt(x, z) : -Infinity) };
}
