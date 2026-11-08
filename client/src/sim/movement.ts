// Pure movement step: one InputFrame -> one fixed 1/60 s step. This is the
// function client prediction runs and that the Go zone server (WP03) mirrors
// line for line; the algorithm is written out in ./README.md and pinned by the
// golden trajectories in ./golden/. Any change here changes how the game feels
// AND desyncs prediction from the server, so change both sides together (and
// regenerate the goldens).
//
// adapted from wizard-wars shared/movement.js (helpers, verbatim math) and
// client/src/networking/ClientPrediction.ts predict() (step order). Dropped from
// the wizard-wars step: arena clamp, wall/barrier push-out, mobility spells,
// status-effect speed multipliers and gravity wells. They are arena/PvP
// features; collision against terrain and caves comes from the wasm queries
// later (spec 8). Position is the FEET (wizard-wars tracked the eye).

import {
  AIR_ACCEL,
  AIR_CAP_SPEED,
  BASE_MOVE_SPEED,
  GRAVITY,
  GROUND_ACCEL,
  GROUND_FRICTION,
  GROUND_SNAP_M,
  InputFlag,
  JUMP_FORCE,
  MAX_AIR_JUMPS,
  MOVE_STEP_HZ,
  SPRINT_MULTIPLIER,
  STOP_SPEED,
  u16ToYaw,
} from '@lodestone/contracts';
import type { GroundQuery } from './ground';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Horizontal velocity, mutated in place by the Source-style helpers below. */
export interface Vec2xz {
  x: number;
  z: number;
}

/** Everything a step carries over to the next one. */
export interface MoveState {
  /** Feet position, meters. y equals ground height while standing. */
  pos: Vec3;
  /** m/s. */
  vel: Vec3;
  /** Air jumps used since last touching ground (double jump = 1 allowed). */
  airJumps: number;
}

/**
 * The movement-relevant part of a protocol InputFrame, in its WIRE units:
 * `yaw` is the u16 the client sends (yawToU16), `pitch` the i16. Taking the
 * quantized integer, not radians, is what guarantees the client predicts with
 * exactly the angle the server will decode.
 */
export interface MoveInput {
  flags: number;
  yaw: number;
  pitch: number;
}

/** Fixed step length. Every InputFrame is exactly one of these (decision 0001). */
export const STEP_DT = 1 / MOVE_STEP_HZ;

/** Grounded tolerance. The step leaves y exactly on the ground after a snap, so this only absorbs float noise. */
export const GROUND_EPS = 1e-4;

/** Ground friction: decelerates horizontal velocity, stronger below stopSpeed so players actually stop instead of sliding forever at low speed. */
export function applyGroundFriction(vel: Vec2xz, friction: number, stopSpeed: number, dt: number): void {
  const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
  if (speed < 0.01) {
    vel.x = 0;
    vel.z = 0;
    return;
  }
  const control = speed < stopSpeed ? stopSpeed : speed;
  const drop = control * friction * dt;
  const newSpeed = Math.max(speed - drop, 0) / speed;
  vel.x *= newSpeed;
  vel.z *= newSpeed;
}

/** Ground acceleration toward the wish direction, clamped so a single step never overshoots wishSpeed. */
export function applyGroundAccel(vel: Vec2xz, wishDir: Vec2xz, wishSpeed: number, accel: number, dt: number): void {
  const currentSpeed = vel.x * wishDir.x + vel.z * wishDir.z;
  const addSpeed = wishSpeed - currentSpeed;
  if (addSpeed <= 0) return;
  const accelSpeed = Math.min(accel * dt * wishSpeed, addSpeed);
  vel.x += accelSpeed * wishDir.x;
  vel.z += accelSpeed * wishDir.z;
}

/**
 * Air acceleration a la Quake/Source PM_AirAccelerate: the addSpeed check uses
 * wishSpeed clamped to airCapSpeed, but the rate scales with the full wishSpeed.
 * That mismatch is what lets air strafing gain speed (bunny hopping); it is
 * intentional and part of the tuned feel.
 */
export function applyAirAccel(
  vel: Vec2xz,
  wishDir: Vec2xz,
  wishSpeed: number,
  accel: number,
  airCapSpeed: number,
  dt: number,
): void {
  const cappedWishSpeed = Math.min(wishSpeed, airCapSpeed);
  const currentSpeed = vel.x * wishDir.x + vel.z * wishDir.z;
  const addSpeed = cappedWishSpeed - currentSpeed;
  if (addSpeed <= 0) return;
  const accelSpeed = Math.min(accel * dt * wishSpeed, addSpeed);
  vel.x += accelSpeed * wishDir.x;
  vel.z += accelSpeed * wishDir.z;
}

/** Normalize a raw key-direction sum into a unit wish direction (or zero when no keys are held). */
export function normalizeWishDir(x: number, z: number): Vec2xz {
  const len = Math.sqrt(x * x + z * z);
  if (len === 0) return { x: 0, z: 0 };
  return { x: x / len, z: z / len };
}

/**
 * Wish direction from the movement flags and a yaw in radians. Yaw 0 faces -Z
 * (three.js camera convention: forward = (-sin yaw, -cos yaw)); positive yaw
 * turns left. Opposite keys cancel.
 */
export function wishDirFromFlags(flags: number, yaw: number): Vec2xz {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  let wishX = 0;
  let wishZ = 0;
  if (flags & InputFlag.forward) {
    wishZ -= cos;
    wishX -= sin;
  }
  if (flags & InputFlag.back) {
    wishZ += cos;
    wishX += sin;
  }
  if (flags & InputFlag.left) {
    wishZ += sin;
    wishX -= cos;
  }
  if (flags & InputFlag.right) {
    wishZ -= sin;
    wishX += cos;
  }
  return normalizeWishDir(wishX, wishZ);
}

/** True when `pos` stands on the ground (see GROUND_EPS). */
export function isGrounded(pos: Vec3, ground: GroundQuery): boolean {
  return pos.y <= ground.heightAt(pos.x, pos.z) + GROUND_EPS;
}

/**
 * One fixed movement step. Pure: returns a new state, never mutates `state`.
 * Order matters and is the contract with the Go port (README.md):
 * wish dir -> grounded test -> friction+accel or air accel -> gravity ->
 * jump / air jump -> integrate -> ground snap.
 */
export function stepMovement(state: MoveState, input: MoveInput, ground: GroundQuery, dt: number = STEP_DT): MoveState {
  const { flags } = input;
  const yaw = u16ToYaw(input.yaw);
  const speed = BASE_MOVE_SPEED * ((flags & InputFlag.sprint) !== 0 ? SPRINT_MULTIPLIER : 1);
  const wishDir = wishDirFromFlags(flags, yaw);

  // Grounded is whatever the previous step's snap left behind (y exactly on
  // the ground). wizard-wars once used a 0.05 tolerance here and client and
  // server then disagreed about descending players; keep it tight.
  const grounded = isGrounded(state.pos, ground);

  const vel: Vec2xz = { x: state.vel.x, z: state.vel.z };
  if (grounded) {
    applyGroundFriction(vel, GROUND_FRICTION, STOP_SPEED, dt);
    applyGroundAccel(vel, wishDir, speed, GROUND_ACCEL, dt);
  } else {
    applyAirAccel(vel, wishDir, speed, AIR_ACCEL, AIR_CAP_SPEED, dt);
  }

  let vy = state.vel.y;
  if (!grounded) vy += GRAVITY * dt;

  // Held `jump` on the ground jumps every time you land (auto-hop, as in
  // wizard-wars); the double jump needs a fresh press (`jump_edge`) so holding
  // space through the apex doesn't burn it.
  let airJumps = state.airJumps;
  if ((flags & InputFlag.jump) !== 0 && grounded) {
    vy = JUMP_FORCE;
    airJumps = 0;
  } else if (!grounded && (flags & InputFlag.jump_edge) !== 0 && airJumps < MAX_AIR_JUMPS) {
    vy = JUMP_FORCE;
    airJumps = airJumps + 1;
  }

  const x = state.pos.x + vel.x * dt;
  let y = state.pos.y + vy * dt;
  const z = state.pos.z + vel.z * dt;

  // Snap when below ground, or when descending within GROUND_SNAP_M of it so
  // walking down a slope stays grounded instead of stuttering through tiny falls.
  const groundY = ground.heightAt(x, z);
  const hugging = vy <= 0 && y - groundY <= GROUND_SNAP_M;
  if (y <= groundY || hugging) {
    y = groundY;
    vy = 0;
    airJumps = 0;
  }

  return { pos: { x, y, z }, vel: { x: vel.x, y: vy, z: vel.z }, airJumps };
}

export function cloneMoveState(s: MoveState): MoveState {
  return { pos: { ...s.pos }, vel: { ...s.vel }, airJumps: s.airJumps };
}
