// Pure movement step: one InputFrame -> one fixed 1/60 s step. This is the
// function client prediction runs and that the Go zone server mirrors line
// for line (server/pkg/movement); the algorithm is written out in ./README.md
// and pinned by the golden trajectories in ./golden/. Any change here changes
// how the game feels AND desyncs prediction from the server, so change both
// sides together (and regenerate the goldens).
//
// adapted from wizard-wars shared/movement.js (helpers, verbatim math) and
// client/src/networking/ClientPrediction.ts predict() (step order). Dropped from
// the wizard-wars step: arena clamp, wall/barrier push-out, mobility spells,
// status-effect speed multipliers and gravity wells. They are arena/PvP
// features. Position is the FEET (wizard-wars tracked the eye).
//
// WP10 added the traversal modes of spec 8 on top of that walk/air core:
// slope rules (walkable limit, step-up, sliding), climbing, gliding with an
// updraft hook, swimming with drowning, and the stamina wheel. The walk/air
// arithmetic on walkable ground is unchanged, which is why WP02's flat and
// plane goldens still reproduce bit for bit. Everything here reads the world
// only through GroundQuery.heightAt / waterAt (the wasm collision surface on
// both sides), and only uses + - * / sqrt floor and comparisons on top of the
// existing yaw sin/cos, so TS and Go agree to the last bit or within an ulp.

import {
  AIR_ACCEL,
  AIR_CAP_SPEED,
  Activity,
  BASE_MOVE_SPEED,
  CLIMB_FACING_MIN,
  CLIMB_JUMP_SPEED,
  CLIMB_JUMP_STAMINA,
  CLIMB_JUMP_TIME_S,
  CLIMB_KICK_SPEED,
  CLIMB_MAX_TAN_SQ,
  CLIMB_RAIN_MULT,
  CLIMB_SLIP_PERIOD_S,
  CLIMB_SLIP_SPEED,
  CLIMB_SLIP_TIME_S,
  CLIMB_SPEED,
  DROWN_TIME_S,
  GLIDE_ACCEL,
  GLIDE_MIN_FALL_M,
  GLIDE_SINK_SPEED,
  GLIDE_SPEED,
  GLIDE_VERTICAL_ACCEL,
  GRAVITY,
  GROUND_ACCEL,
  GROUND_FRICTION,
  GROUND_SNAP_M,
  InputFlag,
  JUMP_FORCE,
  MANTLE_SPEED,
  MAX_AIR_JUMPS,
  MAX_STEP_UP_M,
  MOVE_STEP_HZ,
  MoveMode,
  SHORE_SEARCH_M,
  SLIDE_MAX_SPEED,
  SLOPE_PROBE_M,
  SPRINT_MULTIPLIER,
  STAMINA_CLIMB_PER_S,
  STAMINA_FINE_PER_POINT,
  STAMINA_GLIDE_PER_S,
  STAMINA_MAX,
  STAMINA_REGEN_DELAY_S,
  STAMINA_REGEN_PER_S,
  STAMINA_SPRINT_PER_S,
  STAMINA_SWIM_PER_S,
  STEP_PROBE_M,
  STOP_SPEED,
  SWIM_ACCEL,
  SWIM_DEPTH_M,
  SWIM_FLOAT_DEPTH_M,
  SWIM_SPEED,
  UPDRAFT_MAX_LIFT,
  WALKABLE_TAN_SQ,
  WORLD_SIZE_M,
  u16ToYaw,
  i16ToPitch,
} from '@lodestone/contracts';
import type { GroundQuery } from './ground';
import { beginDash, SUSTAIN, skateGround } from './dash';
import { atLevel, collideStep } from './caves';

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

/** Bits of MoveState.flags (= SelfState.flags bits 0-3, protocol.yaml). */
export const MoveFlag = {
  /** Stamina ran out: no sprint, climb or glide until it is full again. */
  exhausted: 1,
  /** Out of stamina in deep water: helpless until the shore respawn. */
  drowned: 2,
  /** This step stood on ground steeper than walkable (animation/HUD). */
  sliding: 4,
} as const;

/** Everything a step carries over to the next one (all of it rides in SelfState). */
export interface MoveState {
  /** Feet position, meters. y equals ground height while standing or climbing. */
  pos: Vec3;
  /** m/s. */
  vel: Vec3;
  /** Air jumps used since last touching ground (double jump = 1 allowed). */
  airJumps: number;
  /** MoveMode: ground | air | climb | glide | swim (ground/air are re-derived from position each step). */
  mode: number;
  /** Stamina in fine units (STAMINA_FINE_PER_POINT per point), always an integer. */
  stamina: number;
  /** Wheel size in fine units. */
  staminaMax: number;
  /** Steps in the current mode family: regen delay on ground, rain slip phase on a wall, drowning countdown. 0..255. */
  timer: number;
  /** Climb-jump lunge steps remaining (0..15). */
  lunge: number;
  /** MoveFlag bits. */
  flags: number;
  /** WP13 (./dash.ts): dash steps remaining (0..15); absent = 0. */
  dash?: number;
  /** WP13: dodge i-frame steps remaining (0..15); absent = 0. */
  iframes?: number;
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
  /** WP13: InputFrame.castSlot (with the dodge flag: the dash variant, ./dash.ts). Absent = 0. */
  castSlot?: number;
}

/**
 * Updraft hook (spec 8: fire's rising heat). The chemistry engine (WP15) will
 * implement this from synced burn state; until then `UpdraftColumns`
 * (./updraft.ts) provides debug columns. Must be deterministic and identical
 * on client and server. Returns lift in m/s (clamped to [0, UPDRAFT_MAX_LIFT]).
 */
export interface UpdraftField {
  liftAt(x: number, y: number, z: number): number;
}

/**
 * World inputs to a step that are not terrain: rain (weather stub, WP15 later)
 * and updrafts. Both sides evaluate them from the same world time / synced
 * state; prediction stores the env each step used so replays reuse it.
 */
export interface StepEnv {
  raining: boolean;
  updraft: UpdraftField | null;
}

export const NO_ENV: Readonly<StepEnv> = Object.freeze({ raining: false, updraft: null });

/** Fixed step length. Every InputFrame is exactly one of these (decision 0001). */
export const STEP_DT = 1 / MOVE_STEP_HZ;

/** Grounded tolerance. The step leaves y exactly on the ground after a snap, so this only absorbs float noise. */
export const GROUND_EPS = 1e-4;

// ---- derived integers (exact products, so TS and Go get the same values)
const perStep = (ratePerS: number) => Math.round((ratePerS * STAMINA_FINE_PER_POINT) / MOVE_STEP_HZ);
const steps = (s: number) => Math.round(s * MOVE_STEP_HZ);
export const FINE = STAMINA_FINE_PER_POINT;
export const DRAIN_SPRINT = perStep(STAMINA_SPRINT_PER_S);
export const DRAIN_CLIMB = perStep(STAMINA_CLIMB_PER_S);
export const DRAIN_GLIDE = perStep(STAMINA_GLIDE_PER_S);
export const DRAIN_SWIM = perStep(STAMINA_SWIM_PER_S);
export const REGEN_PER_STEP = perStep(STAMINA_REGEN_PER_S);
export const CLIMB_JUMP_COST = Math.round(CLIMB_JUMP_STAMINA * STAMINA_FINE_PER_POINT);
export const REGEN_DELAY_STEPS = steps(STAMINA_REGEN_DELAY_S);
export const LUNGE_STEPS = steps(CLIMB_JUMP_TIME_S);
export const SLIP_PERIOD_STEPS = steps(CLIMB_SLIP_PERIOD_S);
export const SLIP_STEPS = steps(CLIMB_SLIP_TIME_S);
export const DROWN_STEPS = steps(DROWN_TIME_S);
export const TIMER_MAX = 255;
/** sqrt(1/2) as a literal both languages parse to the same double. */
const DIAG = 0.7071067811865476;

/** A fresh standing state with a full stamina wheel. */
export function newMoveState(pos: Vec3, staminaMaxPoints: number = STAMINA_MAX): MoveState {
  const max = Math.round(staminaMaxPoints * FINE);
  return { pos: { ...pos }, vel: { x: 0, y: 0, z: 0 }, airJumps: 0, mode: MoveMode.ground, stamina: max, staminaMax: max, timer: 0, lunge: 0, flags: 0, dash: 0, iframes: 0 };
}

export function cloneMoveState(s: MoveState): MoveState {
  return { ...s, pos: { ...s.pos }, vel: { ...s.vel } };
}

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
  return pos.y <= atLevel(ground, pos.y).heightAt(pos.x, pos.z) + GROUND_EPS; // WP09: caves.ts
}

/** Water surface at (x, z), or -Infinity where the ground has no water data (flat test worlds). */
export function waterAt(ground: GroundQuery, x: number, z: number): number {
  return ground.waterAt ? ground.waterAt(x, z) : -Infinity;
}

/**
 * Ground gradient (dh/dx, dh/dz) by central differences over 2*SLOPE_PROBE_M
 * (1 m). Its squared length is tan(slope)^2, compared against the *_TAN_SQ
 * literals, so no trig is needed. Smoothing over a metre keeps one odd 1 m
 * triangle of the collision mesh from deciding walk vs climb.
 */
export function slopeAt(ground: GroundQuery, x: number, z: number): { gx: number; gz: number; t2: number } {
  const w = 2 * SLOPE_PROBE_M;
  const gx = (ground.heightAt(x + SLOPE_PROBE_M, z) - ground.heightAt(x - SLOPE_PROBE_M, z)) / w;
  const gz = (ground.heightAt(x, z + SLOPE_PROBE_M) - ground.heightAt(x, z - SLOPE_PROBE_M)) / w;
  return { gx, gz, t2: gx * gx + gz * gz };
}

/** Move a 2D velocity toward a target by at most maxStep (m/s). */
function moveToward2(v: Vec2xz, tx: number, tz: number, maxStep: number): void {
  const dx = tx - v.x;
  const dz = tz - v.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d <= maxStep) {
    v.x = tx;
    v.z = tz;
    return;
  }
  const k = maxStep / d;
  v.x += dx * k;
  v.z += dz * k;
}

function moveToward1(v: number, t: number, maxStep: number): number {
  if (Math.abs(t - v) <= maxStep) return t;
  return t > v ? v + maxStep : v - maxStep;
}

/**
 * "Holding forward into a climbable wall": forward held, stamina usable, the
 * surface between walkable and CLIMB_MAX, and the wish direction within 60
 * degrees of straight uphill (wish . g >= CLIMB_FACING_MIN * |g|).
 */
function wantsClimb(flags: number, wish: Vec2xz, gx: number, gz: number, t2: number, canUse: boolean): boolean {
  if ((flags & InputFlag.forward) === 0 || !canUse) return false;
  if (t2 <= WALKABLE_TAN_SQ || t2 > CLIMB_MAX_TAN_SQ) return false;
  return wish.x * gx + wish.z * gz >= CLIMB_FACING_MIN * Math.sqrt(t2);
}

/**
 * Step-up (MAX_STEP_UP_M): an uphill move onto steep ground is a step, not a
 * wall, when the ground STEP_PROBE_M ahead is walkable and at most
 * MAX_STEP_UP_M above the feet. On today's 1 m heightfield a 0.6 m rise is
 * never steeper than 31 degrees, so this mostly forgives the lip at the top of
 * a slope; it matters more once cave meshes arrive.
 */
function stepUpOK(ground: GroundQuery, pos: Vec3, dx: number, dz: number): boolean {
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d === 0) return false;
  const px = pos.x + (dx / d) * STEP_PROBE_M;
  const pz = pos.z + (dz / d) * STEP_PROBE_M;
  if (ground.heightAt(px, pz) - pos.y > MAX_STEP_UP_M) return false;
  return slopeAt(ground, px, pz).t2 <= WALKABLE_TAN_SQ;
}

/** Deep enough to swim at (x, z) and the feet at or below floating depth. */
function entersWater(ground: GroundQuery, x: number, y: number, z: number, gy: number): number | null {
  const w = waterAt(ground, x, z);
  if (w - gy >= SWIM_DEPTH_M && y <= w - SWIM_FLOAT_DEPTH_M) return w - SWIM_FLOAT_DEPTH_M;
  return null;
}

/**
 * Nearest dry, walkable ground for a drowning respawn: rings every 2 m out to
 * 64 m, then every 8 m out to SHORE_SEARCH_M, eight compass directions each,
 * inside the world. Deterministic, so client and server respawn at the same
 * spot without a message. Swim drain (~37 m of swimming per wheel) keeps the
 * search short in practice. Falls back to the drowning spot itself.
 */
export function findShore(ground: GroundQuery, x: number, z: number): Vec3 {
  const dirs = [1, 0, DIAG, DIAG, 0, 1, -DIAG, DIAG, -1, 0, -DIAG, -DIAG, 0, -1, DIAG, -DIAG];
  for (let r = 2; r <= SHORE_SEARCH_M; r += r < 64 ? 2 : 8) {
    for (let k = 0; k < 16; k += 2) {
      const px = x + dirs[k] * r;
      const pz = z + dirs[k + 1] * r;
      if (px < 0 || pz < 0 || px >= WORLD_SIZE_M || pz >= WORLD_SIZE_M) continue;
      const h = ground.heightAt(px, pz);
      if (waterAt(ground, px, pz) < h && slopeAt(ground, px, pz).t2 <= WALKABLE_TAN_SQ) return { x: px, y: h, z: pz };
    }
  }
  return { x, y: ground.heightAt(x, z), z };
}

/** Mode families share the timer's meaning; changing family resets it. */
function family(mode: number): number {
  return mode === MoveMode.air ? MoveMode.ground : mode;
}

/** Stamina clamp, exhaustion bookkeeping and the family-change timer reset, shared by every mode. */
function finish(prev: MoveState, s: MoveState): MoveState {
  if (family(s.mode) !== family(prev.mode)) s.timer = 0;
  if (s.mode !== MoveMode.climb) s.lunge = 0;
  if (s.stamina < 0) s.stamina = 0;
  if (s.stamina > s.staminaMax) s.stamina = s.staminaMax;
  if (s.stamina === 0) s.flags |= MoveFlag.exhausted;
  if (s.stamina >= s.staminaMax) s.flags &= ~MoveFlag.exhausted;
  return s;
}

/**
 * One fixed movement step. Pure: returns a new state, never mutates `state`.
 * Dispatches on the carried mode; ground/air re-derive "grounded" from the
 * position like WP02's step did. Order inside each mode is the contract with
 * the Go port (README.md).
 */
export function stepMovement(state: MoveState, input: MoveInput, groundIn: GroundQuery, dt: number = STEP_DT, env: Readonly<StepEnv> = NO_ENV): MoveState {
  const ground = atLevel(groundIn, state.pos.y); // WP09: caves see the ground at the player's level (caves.ts)
  const yaw = u16ToYaw(input.yaw);
  const wish = wishDirFromFlags(input.flags, yaw);
  // WP13: dodge / dash bookkeeping first (Go stepFull -> beginDash); CR 021: the pitch flies a jet dash.
  const grounded = state.pos.y <= ground.heightAt(state.pos.x, state.pos.z) + GROUND_EPS;
  const dashed = beginDash(state, input.flags, input.castSlot ?? 0, yaw, i16ToPitch(input.pitch), wish, grounded, dt);
  const st = dashed.state;
  const gm = dashed.kind === SUSTAIN.skate ? skateGround(ground) : ground; // CR 021: a held skate runs over water
  let out: MoveState;
  switch (st.mode) {
    case MoveMode.climb:
      out = stepClimb(st, input.flags, wish, gm, dt, env);
      break;
    case MoveMode.glide:
      out = stepGlide(st, input.flags, wish, gm, dt, env);
      break;
    case MoveMode.swim:
      out = stepSwim(st, input.flags, wish, gm, dt);
      break;
    default:
      out = stepWalk(st, input.flags, wish, gm, dt, dashed.dashing);
  }
  out = collideStep(ground, out); // WP09: cave walls and ceilings (caves.ts)
  out.dash = st.dash ?? 0;
  out.iframes = st.iframes ?? 0;
  return finish(state, out);
}

/**
 * Walk/air: WP02's step (wish -> grounded -> friction+accel or air accel ->
 * gravity -> jump -> integrate -> snap) plus slope rules, glider opening,
 * grabbing walls, entering water and the sprint/regen stamina rules.
 */
function stepWalk(s: MoveState, flags: number, wish: Vec2xz, ground: GroundQuery, dt: number, dashing = false): MoveState {
  const exhausted = (s.flags & MoveFlag.exhausted) !== 0;
  const canUse = !exhausted && s.stamina > 0;
  const sprinting = (flags & InputFlag.sprint) !== 0 && canUse;
  const speed = BASE_MOVE_SPEED * (sprinting ? SPRINT_MULTIPLIER : 1);

  // Grounded is whatever the previous step's snap left behind (y exactly on
  // the ground). wizard-wars once used a 0.05 tolerance here and client and
  // server then disagreed about descending players; keep it tight.
  const h0 = ground.heightAt(s.pos.x, s.pos.z);
  const grounded = s.pos.y <= h0 + GROUND_EPS;
  let sliding = false;
  let sl = { gx: 0, gz: 0, t2: 0 };
  if (grounded) {
    sl = slopeAt(ground, s.pos.x, s.pos.z);
    sliding = sl.t2 > WALKABLE_TAN_SQ;
  }

  const vel: Vec2xz = { x: s.vel.x, z: s.vel.z };
  if (dashing) {
    // WP13: a dash holds its horizontal velocity (no friction, no steering);
    // walls still take the into-wall part away below.
  } else if (grounded && !sliding) {
    applyGroundFriction(vel, GROUND_FRICTION, STOP_SPEED, dt);
    applyGroundAccel(vel, wish, speed, GROUND_ACCEL, dt);
  } else if (sliding) {
    // Steeper than walkable: no friction, no control; the horizontal part of
    // gravity along the surface (g sin cos = g t / (1 + t^2)) pulls downhill.
    const t = Math.sqrt(sl.t2);
    const a = (-GRAVITY * t) / (1 + sl.t2);
    vel.x -= (sl.gx / t) * a * dt;
    vel.z -= (sl.gz / t) * a * dt;
    const sp = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
    if (sp > SLIDE_MAX_SPEED) {
      const k = SLIDE_MAX_SPEED / sp;
      vel.x *= k;
      vel.z *= k;
    }
  } else {
    applyAirAccel(vel, wish, speed, AIR_ACCEL, AIR_CAP_SPEED, dt);
  }

  let vy = s.vel.y;
  if (!grounded) vy += GRAVITY * dt;

  // Held `jump` on the ground jumps every time you land (auto-hop, as in
  // wizard-wars); the double jump needs a fresh press (`jump_edge`) so holding
  // space through the apex doesn't burn it. In the air a press that has no
  // double jump left opens the glider, if we are falling more than
  // GLIDE_MIN_FALL_M above the ground; `glide_toggle` opens it directly
  // (skipping the double jump). No jumping off a slide: that would climb
  // steep slopes by hopping.
  let airJumps = s.airJumps;
  let glide = false;
  const canGlide = !grounded && canUse && vy < 0 && s.pos.y - h0 > GLIDE_MIN_FALL_M;
  if ((flags & InputFlag.jump) !== 0 && grounded && !sliding) {
    vy = JUMP_FORCE;
    airJumps = 0;
  } else if ((flags & InputFlag.glide_toggle) !== 0 && canGlide) {
    glide = true;
  } else if (!grounded && (flags & InputFlag.jump_edge) !== 0 && airJumps < MAX_AIR_JUMPS) {
    vy = JUMP_FORCE;
    airJumps = airJumps + 1;
  } else if ((flags & InputFlag.jump_edge) !== 0 && canGlide) {
    glide = true;
  }
  if (glide) airJumps = MAX_AIR_JUMPS; // closing the glider never grants a double jump

  let x = s.pos.x + vel.x * dt;
  let y = s.pos.y + vy * dt;
  let z = s.pos.z + vel.z * dt;
  let groundY = ground.heightAt(x, z);
  let climb = false;

  // Slope rule (deferred from WP07): a grounded move that would climb steeper
  // than walkable onto steep ground is a wall, unless it is a step. Holding
  // into a climbable wall grabs it; otherwise the move keeps only its part
  // along the contour (slide along the wall), or stops if that is a wall too.
  if (grounded && !sliding) {
    const dx = x - s.pos.x;
    const dz = z - s.pos.z;
    const rise = groundY - s.pos.y;
    if (rise > 0 && rise * rise > WALKABLE_TAN_SQ * (dx * dx + dz * dz)) {
      const w = slopeAt(ground, x, z);
      if (w.t2 > WALKABLE_TAN_SQ && !stepUpOK(ground, s.pos, dx, dz)) {
        if (wantsClimb(flags, wish, w.gx, w.gz, w.t2, canUse)) {
          climb = true;
        } else {
          const t = Math.sqrt(w.t2);
          const nx = w.gx / t;
          const nz = w.gz / t;
          const d = dx * nx + dz * nz;
          const x2 = s.pos.x + (dx - d * nx);
          const z2 = s.pos.z + (dz - d * nz);
          const vd = vel.x * nx + vel.z * nz;
          if (vd > 0) {
            vel.x -= vd * nx;
            vel.z -= vd * nz;
          }
          const gy2 = ground.heightAt(x2, z2);
          const rise2 = gy2 - s.pos.y;
          const ex = x2 - s.pos.x;
          const ez = z2 - s.pos.z;
          if (rise2 > 0 && rise2 * rise2 > WALKABLE_TAN_SQ * (ex * ex + ez * ez) && slopeAt(ground, x2, z2).t2 > WALKABLE_TAN_SQ) {
            x = s.pos.x;
            z = s.pos.z;
            groundY = h0;
            vel.x = 0;
            vel.z = 0;
          } else {
            x = x2;
            z = z2;
            groundY = gy2;
          }
        }
      }
    }
  } else if (sliding) {
    // Holding forward into the slope you are sliding on grabs it.
    climb = wantsClimb(flags, wish, sl.gx, sl.gz, sl.t2, canUse);
    if (climb) {
      x = s.pos.x;
      z = s.pos.z;
      groundY = h0;
    }
  } else if (y <= groundY && (flags & InputFlag.forward) !== 0) {
    // Airborne and about to touch a climbable wall while holding into it.
    const w = slopeAt(ground, x, z);
    climb = wantsClimb(flags, wish, w.gx, w.gz, w.t2, canUse);
  }

  let mode: number;
  if (climb) {
    y = groundY;
    vy = 0;
    airJumps = 0;
    mode = MoveMode.climb;
  } else {
    // Snap when below ground, or when descending within GROUND_SNAP_M of it so
    // walking down a slope stays grounded instead of stuttering through tiny falls.
    const hugging = vy <= 0 && y - groundY <= GROUND_SNAP_M;
    if (y <= groundY || hugging) {
      y = groundY;
      vy = 0;
      airJumps = 0;
      glide = false;
    }
    const fy = entersWater(ground, x, y, z, groundY);
    if (fy !== null) {
      y = fy;
      vy = 0;
      airJumps = 0;
      mode = MoveMode.swim;
    } else if (glide) {
      mode = MoveMode.glide;
    } else {
      mode = y <= groundY + GROUND_EPS ? MoveMode.ground : MoveMode.air;
    }
  }

  // Stamina: sprinting on the ground drains and restarts the regen delay;
  // every other step on walkable ground counts toward it and then refills.
  // Air and slides neither drain nor count.
  let stamina = s.stamina;
  let timer = s.timer;
  if (grounded && !sliding) {
    if (sprinting && (wish.x !== 0 || wish.z !== 0)) {
      stamina -= DRAIN_SPRINT;
      timer = 0;
    } else {
      timer = Math.min(timer + 1, TIMER_MAX);
      if (timer >= REGEN_DELAY_STEPS) stamina = Math.min(s.staminaMax, stamina + REGEN_PER_STEP);
    }
  }
  const outFlags = (s.flags & MoveFlag.exhausted) | (sliding ? MoveFlag.sliding : 0);
  return { pos: { x, y, z }, vel: { x: vel.x, y: vy, z: vel.z }, airJumps, mode, stamina, staminaMax: s.staminaMax, timer, lunge: 0, flags: outFlags };
}

/** Same state as a walk-family state (for handing a step back to stepWalk). */
function asWalk(s: MoveState, mode: number): MoveState {
  return { ...s, mode };
}

/**
 * Glide: steer toward wish * GLIDE_SPEED, sink toward -GLIDE_SINK_SPEED plus
 * updraft lift, drain stamina. A press (jump_edge or glide_toggle) or an empty
 * wheel closes it and the step runs as a fall; touching ground lands (or grabs
 * a climbable wall when holding into it); deep water swims.
 */
function stepGlide(s: MoveState, flags: number, wish: Vec2xz, ground: GroundQuery, dt: number, env: Readonly<StepEnv>): MoveState {
  const canUse = (s.flags & MoveFlag.exhausted) === 0 && s.stamina > 0;
  if (!canUse || (flags & (InputFlag.jump_edge | InputFlag.glide_toggle)) !== 0) {
    return stepWalk(asWalk(s, MoveMode.air), flags & ~(InputFlag.jump_edge | InputFlag.glide_toggle), wish, ground, dt);
  }
  const vel: Vec2xz = { x: s.vel.x, z: s.vel.z };
  moveToward2(vel, wish.x * GLIDE_SPEED, wish.z * GLIDE_SPEED, GLIDE_ACCEL * dt);
  let lift = env.updraft ? env.updraft.liftAt(s.pos.x, s.pos.y, s.pos.z) : 0;
  if (!(lift > 0)) lift = 0; // also maps NaN to 0
  if (lift > UPDRAFT_MAX_LIFT) lift = UPDRAFT_MAX_LIFT;
  let vy = moveToward1(s.vel.y, -GLIDE_SINK_SPEED + lift, GLIDE_VERTICAL_ACCEL * dt);
  const x = s.pos.x + vel.x * dt;
  let y = s.pos.y + vy * dt;
  const z = s.pos.z + vel.z * dt;
  const groundY = ground.heightAt(x, z);
  let mode: number = MoveMode.glide;
  let airJumps = s.airJumps;
  if (y <= groundY) {
    const w = slopeAt(ground, x, z);
    mode = wantsClimb(flags, wish, w.gx, w.gz, w.t2, canUse) ? MoveMode.climb : MoveMode.ground;
    y = groundY;
    vy = 0;
    airJumps = 0;
  }
  if (mode !== MoveMode.climb) {
    const fy = entersWater(ground, x, y, z, groundY);
    if (fy !== null) {
      y = fy;
      vy = 0;
      airJumps = 0;
      mode = MoveMode.swim;
    }
  }
  return { pos: { x, y, z }, vel: { x: vel.x, y: vy, z: vel.z }, airJumps, mode, stamina: s.stamina - DRAIN_GLIDE, staminaMax: s.staminaMax, timer: 0, lunge: 0, flags: s.flags & MoveFlag.exhausted };
}

/**
 * Climb: move over the heightfield surface at CLIMB_SPEED measured along the
 * surface (halved in rain), input relative to the wall: forward = straight up
 * the slope, back = down, left/right = along the contour. Jump = lunge up
 * (CLIMB_JUMP_STAMINA), jump + back = kick off. Rain makes you slip down for
 * CLIMB_SLIP_TIME_S once per CLIMB_SLIP_PERIOD_S. Reaching walkable ground
 * while moving up is the mantle (a forward push onto the top); an empty
 * wheel or an unclimbable surface lets go, which on a heightfield means
 * sliding down it.
 */
function stepClimb(s: MoveState, flags: number, wish: Vec2xz, ground: GroundQuery, dt: number, env: Readonly<StepEnv>): MoveState {
  const canUse = (s.flags & MoveFlag.exhausted) === 0 && s.stamina > 0;
  const here = slopeAt(ground, s.pos.x, s.pos.z);
  if (!canUse || here.t2 <= WALKABLE_TAN_SQ || here.t2 > CLIMB_MAX_TAN_SQ) {
    // Letting go: on a heightfield that is standing on the slope, so the walk
    // step slides us down it (no jumping off a slide). It cannot re-grab:
    // wantsClimb fails for an empty wheel or an unclimbable surface.
    // The climb's velocity is only a report of the last move, so it must not
    // leak into walk physics (an upward vy would launch us off the wall).
    return stepWalk({ ...s, mode: MoveMode.ground, vel: { x: 0, y: 0, z: 0 } }, flags & ~(InputFlag.jump | InputFlag.jump_edge), wish, ground, dt);
  }
  const t = Math.sqrt(here.t2);
  const ux = here.gx / t;
  const uz = here.gz / t;
  // Right-hand direction for a climber facing the wall (facing u = (ux, uz)).
  const rx = -uz;
  const rz = ux;
  const slipping = env.raining && s.timer >= SLIP_PERIOD_STEPS - SLIP_STEPS;
  let lunge = s.lunge;
  let stamina = s.stamina;

  if ((flags & InputFlag.jump_edge) !== 0 && !slipping && lunge === 0) {
    if ((flags & InputFlag.back) !== 0) {
      // Kick off the wall: away from it and up, as a fresh jump.
      const vx = -ux * CLIMB_KICK_SPEED;
      const vz = -uz * CLIMB_KICK_SPEED;
      const x = s.pos.x + vx * dt;
      let y = s.pos.y + JUMP_FORCE * dt;
      const z = s.pos.z + vz * dt;
      const groundY = ground.heightAt(x, z);
      let vy = JUMP_FORCE;
      if (y <= groundY) {
        y = groundY;
        vy = 0;
      }
      const mode = y <= groundY + GROUND_EPS ? MoveMode.ground : MoveMode.air;
      return { pos: { x, y, z }, vel: { x: vx, y: vy, z: vz }, airJumps: 0, mode, stamina, staminaMax: s.staminaMax, timer: 0, lunge: 0, flags: s.flags & MoveFlag.exhausted };
    }
    lunge = LUNGE_STEPS;
    stamina -= Math.min(stamina, CLIMB_JUMP_COST);
  }

  let a = 0;
  let b = 0;
  let speed: number;
  if (slipping) {
    a = -1;
    speed = CLIMB_SLIP_SPEED;
  } else if (lunge > 0) {
    a = 1;
    speed = CLIMB_JUMP_SPEED;
    lunge--;
  } else {
    a = ((flags & InputFlag.forward) !== 0 ? 1 : 0) - ((flags & InputFlag.back) !== 0 ? 1 : 0);
    b = ((flags & InputFlag.right) !== 0 ? 1 : 0) - ((flags & InputFlag.left) !== 0 ? 1 : 0);
    if (a !== 0 && b !== 0) {
      a *= DIAG;
      b *= DIAG;
    }
    speed = env.raining ? CLIMB_SPEED * CLIMB_RAIN_MULT : CLIMB_SPEED;
    if (a !== 0 || b !== 0) stamina -= DRAIN_CLIMB;
  }

  // Up the slope, a surface distance d covers d / sqrt(1 + t^2) horizontally;
  // along the contour the surface is level, so horizontal = surface distance.
  const k = 1 / Math.sqrt(1 + here.t2);
  const ha = a * speed * k * dt;
  const hb = b * speed * dt;
  const x = s.pos.x + ux * ha + rx * hb;
  const z = s.pos.z + uz * ha + rz * hb;
  let y = ground.heightAt(x, z);
  let vel = { x: (x - s.pos.x) / dt, y: (y - s.pos.y) / dt, z: (z - s.pos.z) / dt };
  let mode: number = MoveMode.climb;
  const timer = (s.timer + 1) % SLIP_PERIOD_STEPS;

  const there = slopeAt(ground, x, z);
  if (there.t2 <= WALKABLE_TAN_SQ) {
    // Off the wall: topped out (mantle push onto the top) or reached the foot.
    mode = MoveMode.ground;
    vel = y > s.pos.y ? { x: ux * MANTLE_SPEED, y: 0, z: uz * MANTLE_SPEED } : { x: 0, y: 0, z: 0 };
  } else if (there.t2 > CLIMB_MAX_TAN_SQ) {
    mode = MoveMode.ground; // too steep to hold: the next step slides
    vel = { x: 0, y: 0, z: 0 };
  }
  const fy = entersWater(ground, x, y, z, y);
  if (fy !== null) {
    y = fy;
    vel = { x: 0, y: 0, z: 0 };
    mode = MoveMode.swim;
  }
  return { pos: { x, y, z }, vel, airJumps: 0, mode, stamina, staminaMax: s.staminaMax, timer, lunge: mode === MoveMode.climb ? lunge : 0, flags: s.flags & MoveFlag.exhausted };
}

/**
 * Swim: at the surface (feet SWIM_FLOAT_DEPTH_M under it), steer toward
 * wish * SWIM_SPEED, drain stamina always (you cannot tread water forever).
 * Shallow water stands you up unless the bank is a wall (climb it if you
 * hold into it, else stop). An empty wheel drowns you: DROWN_TIME_S helpless,
 * then respawn at findShore with a full wheel.
 */
function stepSwim(s: MoveState, flags: number, wish: Vec2xz, ground: GroundQuery, dt: number): MoveState {
  if ((s.flags & MoveFlag.drowned) !== 0) {
    const timer = s.timer + 1;
    if (timer >= DROWN_STEPS) {
      const p = findShore(ground, s.pos.x, s.pos.z);
      return { pos: p, vel: { x: 0, y: 0, z: 0 }, airJumps: 0, mode: MoveMode.ground, stamina: s.staminaMax, staminaMax: s.staminaMax, timer: 0, lunge: 0, flags: 0 };
    }
    return { ...s, pos: { ...s.pos }, vel: { x: 0, y: 0, z: 0 }, timer };
  }
  const vel: Vec2xz = { x: s.vel.x, z: s.vel.z };
  moveToward2(vel, wish.x * SWIM_SPEED, wish.z * SWIM_SPEED, SWIM_ACCEL * dt);
  let x = s.pos.x + vel.x * dt;
  let z = s.pos.z + vel.z * dt;
  let y = s.pos.y;
  const vy = 0;
  const groundY = ground.heightAt(x, z);
  const w = waterAt(ground, x, z);
  const stamina = s.stamina - DRAIN_SWIM;
  const exhausted = s.flags & MoveFlag.exhausted;
  let mode: number = MoveMode.swim;
  if (w - groundY < SWIM_DEPTH_M) {
    if (groundY - s.pos.y > MAX_STEP_UP_M) {
      // The bank is a wall, not a beach.
      const sl = slopeAt(ground, x, z);
      if (wantsClimb(flags, wish, sl.gx, sl.gz, sl.t2, exhausted === 0 && stamina > 0)) {
        y = groundY;
        mode = MoveMode.climb;
      } else {
        x = s.pos.x;
        z = s.pos.z;
        vel.x = 0;
        vel.z = 0;
      }
    } else if (y <= groundY || y - groundY <= GROUND_SNAP_M) {
      y = groundY;
      mode = MoveMode.ground;
    } else {
      mode = MoveMode.air;
    }
  } else {
    y = w - SWIM_FLOAT_DEPTH_M;
  }
  if (mode === MoveMode.swim && stamina <= 0) {
    return { pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 }, airJumps: 0, mode, stamina: 0, staminaMax: s.staminaMax, timer: 0, lunge: 0, flags: exhausted | MoveFlag.drowned };
  }
  return { pos: { x, y, z }, vel: { x: vel.x, y: vy, z: vel.z }, airJumps: 0, mode, stamina, staminaMax: s.staminaMax, timer: 0, lunge: 0, flags: exhausted };
}

/** Activity bits (protocol Activity) other players see for a movement state. */
export function activityOf(s: Pick<MoveState, 'mode'>): number {
  switch (s.mode) {
    case MoveMode.climb:
      return Activity.climbing;
    case MoveMode.glide:
      return Activity.gliding | Activity.airborne;
    case MoveMode.swim:
      return Activity.swimming;
    case MoveMode.air:
      return Activity.airborne;
    default:
      return 0;
  }
}
