// The local player's simulation driver, independent of React/three so it can
// be unit tested: per rendered frame it latches input edges, runs as many
// fixed 1/60 s steps as the accumulator allows (one InputFrame each) and
// returns a render pose interpolated between the last two steps.
//
// Why interpolate: with steps at 60 Hz and a 144 Hz display, drawing the
// latest step directly shows the camera holding still for 1-2 frames and then
// jumping, which reads as judder. Lerping prev -> current by the leftover
// accumulator fraction makes motion smooth at any refresh rate, at the cost of
// at most one step (16.7 ms) of visual latency. Look (yaw/pitch) is NOT
// interpolated: it is applied every frame straight from the mouse.

import type { GroundQuery } from './ground';
import { advanceFixedStep, lerp } from './fixedStep';
import { stepFly } from './fly';
import { JumpEdgeLatch, makeMoveInput, type HeldButtons } from './inputFrame';
import { MoveMode } from '@lodestone/contracts';
import { stepClock } from './stepClock';
import { cloneMoveState, MoveFlag, newMoveState, NO_ENV, stepMovement, STEP_DT, type MoveInput, type MoveState, type StepEnv, type Vec3 } from './movement';

export interface FrameInput {
  held: HeldButtons;
  /** Radians, unquantized; quantized per step into the InputFrame. */
  yaw: number;
  pitch: number;
  fly: boolean;
}

/** One simulated step, for WP06 to send/store for reconciliation. */
export interface StepRecord {
  seq: number;
  input: MoveInput;
  state: MoveState;
  fly: boolean;
  /** World inputs this step used (rain, updrafts): prediction replays with the same. */
  env: Readonly<StepEnv>;
}

export class LocalSim {
  private prev: MoveState;
  private cur: MoveState;
  private accum = 0;
  private latch = new JumpEdgeLatch();
  private glideLatch = new JumpEdgeLatch();
  seq = 0;
  /** Optional per-step hook (WP06: send + store for reconciliation). */
  onStep: ((r: StepRecord) => void) | null = null;
  /**
   * World inputs for the next step (WP10: rain from the weather stub at the
   * synced world time, updraft columns). Called once per step.
   */
  envSource: (() => Readonly<StepEnv>) | null = null;
  /** The env the newest step used (HUD). */
  lastEnv: Readonly<StepEnv> = NO_ENV;
  /**
   * WP13 combat: called before each step with the seq it will get and the
   * state it starts from; returns the combat bits (attack/alt/dodge/cast/
   * interact) and castSlot to put in that step's InputFrame. afterStep sees
   * the result (hit windows, the timing probe).
   */
  combatHook: ((seq: number, before: Readonly<MoveState>, sprinting: boolean) => { flags: number; castSlot: number }) | null = null;
  afterStep: ((seq: number, state: Readonly<MoveState>) => void) | null = null;

  constructor(private ground: GroundQuery, spawn: Vec3) {
    this.cur = newMoveState(spawn);
    this.prev = cloneMoveState(this.cur);
  }

  get state(): Readonly<MoveState> {
    return this.cur;
  }

  setGround(g: GroundQuery): void {
    this.ground = g;
  }

  /** Hard move (teleport, respawn, server snap): no interpolation streak across it. */
  teleport(p: { x: number; y?: number; z: number }): void {
    const y = p.y ?? this.ground.heightAt(p.x, p.z);
    // A teleport keeps the stamina wheel but resets motion and mode.
    this.cur = { ...newMoveState({ x: p.x, y, z: p.z }), stamina: this.cur.stamina, staminaMax: this.cur.staminaMax, flags: this.cur.flags & MoveFlag.exhausted };
    if (y > this.ground.heightAt(p.x, p.z)) this.cur.mode = MoveMode.air;
    this.prev = cloneMoveState(this.cur);
    this.accum = 0;
  }

  /**
   * Server reconciliation (WP06): replace the simulated state with the
   * corrected one. The previous step moves by the same delta so the render
   * interpolation between them doesn't streak across the correction; the
   * visible easing is the caller's job (a decaying render offset).
   */
  rebase(s: MoveState): void {
    const dx = s.pos.x - this.cur.pos.x;
    const dy = s.pos.y - this.cur.pos.y;
    const dz = s.pos.z - this.cur.pos.z;
    this.prev = { ...this.prev, pos: { x: this.prev.pos.x + dx, y: this.prev.pos.y + dy, z: this.prev.pos.z + dz }, vel: { ...this.prev.vel } };
    this.cur = cloneMoveState(s);
  }

  /** Standing on the ground (walk family, not airborne). */
  grounded(): boolean {
    return this.cur.mode === MoveMode.ground;
  }

  /** Advance by one rendered frame; returns the interpolated feet position to draw. */
  frame(dt: number, inp: FrameInput, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
    this.latch.sample(inp.held.jump);
    this.glideLatch.sample(inp.held.glide);
    const r = advanceFixedStep(this.accum, dt, STEP_DT);
    this.accum = r.accum;
    for (let i = 0; i < r.steps; i++) {
      const input = makeMoveInput(inp.held, this.latch.consume(), inp.yaw, inp.pitch, this.glideLatch.consume());
      if (this.combatHook && !inp.fly) {
        const c = this.combatHook(this.seq + 1, this.cur, inp.held.sprint);
        input.flags |= c.flags;
        input.castSlot = c.castSlot;
      }
      const env = this.envSource ? this.envSource() : NO_ENV;
      this.lastEnv = env;
      this.prev = this.cur;
      stepClock.seq = this.seq + 1; // doors (stepClock.ts): the world as the zone sees it for this input seq
      this.cur = inp.fly ? stepFly(this.cur, input, STEP_DT) : stepMovement(this.cur, input, this.ground, STEP_DT, env);
      this.seq++;
      this.onStep?.({ seq: this.seq, input, state: this.cur, fly: inp.fly, env });
      this.afterStep?.(this.seq, this.cur);
    }
    out.x = lerp(this.prev.pos.x, this.cur.pos.x, r.alpha);
    out.y = lerp(this.prev.pos.y, this.cur.pos.y, r.alpha);
    out.z = lerp(this.prev.pos.z, this.cur.pos.z, r.alpha);
    return out;
  }
}
