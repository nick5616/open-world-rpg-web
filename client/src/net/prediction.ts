// Client-side prediction and server reconciliation for the local player.
//
// adapted from wizard-wars client/src/networking/ClientPrediction.ts. Flow:
//  1. LocalSim runs one movement step per 60 Hz InputFrame (WP02's pure
//     stepMovement) and hands us each step: seq, wire-unit input, state after.
//  2. The frames go to the zone (zoneSession.ts batches them at 30 Hz).
//  3. Each Snapshot carries SelfState (the server's state after the newest
//     frame it applied) and ackInputSeq (that frame's seq).
//  4. We drop steps <= ackSeq and compare the server's state with what we
//     predicted for that same step. Equal (to wire precision) means the
//     prediction was right: nothing to do, which is the steady state because
//     both sides run the same bit-exact step (WP02/WP03 goldens).
//  5. Otherwise replay the remaining unacked inputs from the server's state
//     and hand the corrected present to the renderer, which eases the visual
//     difference out over ~90 ms (wizard-wars CameraController) instead of
//     snapping.
//
// Why compare before replaying: SelfState is quantized (cm, cm/s). Replaying
// from it on every snapshot would inject up to 0.5 cm of quantization error
// 30 times a second, a constant shimmer of micro-corrections. wizard-wars
// replayed unconditionally because its server sent full-precision floats.

import { metersToCm, velToCms } from '@lodestone/contracts';
import type { GroundQuery } from '../sim/ground';
import { NO_ENV, stepMovement, STEP_DT, type MoveInput, type MoveState, type StepEnv } from '../sim/movement';
import { fromSelf, packFlags, packMoveExt } from '../sim/moveWire';
import type { FullSelf } from './snapshotDecoder';

export interface PredictedStep {
  seq: number;
  input: MoveInput;
  /** State after this step. */
  state: MoveState;
  /** World inputs (rain, updrafts) the step used; replays reuse them (WP10). */
  env?: Readonly<StepEnv>;
}

export interface Correction {
  /** Corrected present state (replayed from the server's state). */
  state: MoveState;
  /** Predicted minus corrected position at the moment of reconciliation (m). */
  error: { x: number; y: number; z: number };
  magnitude: number;
  ackSeq: number;
  unacked: number;
}

/**
 * Tolerances for "prediction agrees": 2 cm position, 5 cm/s velocity. Both
 * sides quantize the same doubles, so a correct prediction matches exactly;
 * the slack only absorbs the sub-cm offset left after an earlier rebase onto
 * a quantized state, which would otherwise re-trigger forever.
 */
const POS_TOL_CM = 2;
const VEL_TOL_CMS = 5;
/** 256 steps = 4.3 s of unacked input (wizard-wars cap; 128 overran on an "awful" link). */
const MAX_PENDING = 256;

export class ClientPrediction {
  private pending: PredictedStep[] = [];
  private correction: Correction | null = null;
  private lastAckSeq = 0;

  /** Every reconciliation (for the acceptance log and the HUD). */
  readonly log: { t: number; magnitude: number; unacked: number; ackSeq: number; knownAck: boolean }[] = [];
  reconciles = 0;
  agreements = 0;
  maxError = 0;

  constructor(private ground: GroundQuery) {}

  setGround(g: GroundQuery): void {
    this.ground = g;
  }

  get unacked(): number {
    return this.pending.length;
  }

  get ackSeq(): number {
    return this.lastAckSeq;
  }

  /** Drop history (reconnect, server teleport). */
  reset(): void {
    this.pending = [];
    this.correction = null;
    this.lastAckSeq = 0;
  }

  store(step: PredictedStep): void {
    this.pending.push(step);
    if (this.pending.length > MAX_PENDING) this.pending.shift();
  }

  /** Newest correction since the last call, or null. The renderer applies it once per frame. */
  takeCorrection(): Correction | null {
    const c = this.correction;
    this.correction = null;
    return c;
  }

  /**
   * Reconcile against the server's state after frame ackSeq. Returns the
   * correction (also kept for takeCorrection) or null when the prediction
   * agreed. nowMs only stamps the log.
   */
  reconcile(server: FullSelf, ackSeq: number, nowMs = 0): Correction | null {
    if (ackSeq < this.lastAckSeq) return null; // older snapshot, already handled
    const fresh = ackSeq > this.lastAckSeq;
    this.lastAckSeq = ackSeq;
    let acked: PredictedStep | undefined;
    let drop = 0;
    while (drop < this.pending.length && this.pending[drop].seq <= ackSeq) {
      if (this.pending[drop].seq === ackSeq) acked = this.pending[drop];
      drop++;
    }
    this.pending.splice(0, drop);
    if (!fresh && !acked) return null; // same ack as before: nothing new to learn

    if (acked && agrees(acked.state, server)) {
      this.agreements++;
      return null;
    }
    // Before any input is acked (ack 0) the server state is the spawn; with
    // nothing pending there is nothing to replay either.
    if (!acked && ackSeq === 0 && this.pending.length === 0) return null;

    // WP10: SelfState carries mode, stamina (exact), timers and flags too, so
    // a replay restarts from the server's whole movement state.
    let state: MoveState = fromSelf(server);
    for (const p of this.pending) {
      state = stepMovement(state, p.input, this.ground, STEP_DT, p.env ?? NO_ENV);
      p.state = state; // keep history consistent with the new timeline
    }
    const predicted = this.pending.length ? this.lastPredicted : acked?.state;
    const ref = predicted ?? state;
    const error = { x: ref.pos.x - state.pos.x, y: ref.pos.y - state.pos.y, z: ref.pos.z - state.pos.z };
    const magnitude = Math.hypot(error.x, error.y, error.z);
    this.reconciles++;
    if (magnitude > this.maxError) this.maxError = magnitude;
    this.log.push({ t: nowMs, magnitude, unacked: this.pending.length, ackSeq, knownAck: !!acked });
    if (this.log.length > 5000) this.log.shift();
    this.correction = { state, error, magnitude, ackSeq, unacked: this.pending.length };
    return this.correction;
  }

  /**
   * The latest predicted state before this reconcile rewrote history; set by
   * the driver every step via notePredicted so the error is measured against
   * what was actually on screen.
   */
  private lastPredicted: MoveState | undefined;

  notePredicted(s: MoveState): void {
    this.lastPredicted = s;
  }
}

function agrees(p: MoveState, s: FullSelf): boolean {
  return (
    Math.abs(metersToCm(p.pos.x) - s.x) <= POS_TOL_CM &&
    Math.abs(metersToCm(p.pos.y) - s.y) <= POS_TOL_CM &&
    Math.abs(metersToCm(p.pos.z) - s.z) <= POS_TOL_CM &&
    Math.abs(velToCms(p.vel.x) - s.vx) <= VEL_TOL_CMS &&
    Math.abs(velToCms(p.vel.y) - s.vy) <= VEL_TOL_CMS &&
    Math.abs(velToCms(p.vel.z) - s.vz) <= VEL_TOL_CMS &&
    p.airJumps === s.airJumps &&
    // WP10: discrete movement state must match exactly (integers on both sides).
    p.mode === s.mode &&
    packFlags(p) === s.flags &&
    packMoveExt(p) === s.moveExt
  );
}
