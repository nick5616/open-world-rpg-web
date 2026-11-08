// Builds the per-step InputFrame (contracts/protocol.yaml) from sampled key
// state. Kept pure so the edge-detection rules are unit tested, and so WP06
// can send exactly the frames prediction consumed.

import { InputFlag, pitchToI16, yawToU16 } from '@lodestone/contracts';
import type { MoveInput } from './movement';

/** Logical buttons the movement step understands. */
export interface HeldButtons {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
  /** WP10: the explicit glider key (G). Edge-triggered like jump: glide_toggle is set on one step per press. */
  glide: boolean;
}

export const NO_BUTTONS: Readonly<HeldButtons> = Object.freeze({
  forward: false,
  back: false,
  left: false,
  right: false,
  jump: false,
  sprint: false,
  crouch: false,
  glide: false,
});

export function heldToFlags(h: HeldButtons): number {
  let f = 0;
  if (h.forward) f |= InputFlag.forward;
  if (h.back) f |= InputFlag.back;
  if (h.left) f |= InputFlag.left;
  if (h.right) f |= InputFlag.right;
  if (h.jump) f |= InputFlag.jump;
  if (h.sprint) f |= InputFlag.sprint;
  if (h.crouch) f |= InputFlag.crouch;
  return f;
}

/**
 * Jump-edge latch (also used for the glider key's glide_toggle edge). Key state is sampled every rendered frame but steps run at
 * 60 Hz; on a 144 Hz display a quick tap can rise and fall between two steps.
 * The edge is latched on the rising frame and stays pending until a step
 * consumes it, so a press is never lost (wizard-wars pendingJumpEdge).
 */
export class JumpEdgeLatch {
  private wasDown = false;
  private pending = false;

  /** Call once per rendered frame with the current jump key state. */
  sample(down: boolean): void {
    if (down && !this.wasDown) this.pending = true;
    this.wasDown = down;
  }

  /** Call once per simulated step; returns true for exactly one step per press. */
  consume(): boolean {
    const p = this.pending;
    this.pending = false;
    return p;
  }

  reset(): void {
    this.wasDown = false;
    this.pending = false;
  }
}

/**
 * Quantize view angles and flags into the wire-unit MoveInput the step
 * consumes. `glideEdge` sets glide_toggle (the held G key itself is not a
 * flag: only presses mean anything to the step).
 */
export function makeMoveInput(held: HeldButtons, jumpEdge: boolean, yawRad: number, pitchRad: number, glideEdge = false): MoveInput {
  return {
    flags: heldToFlags(held) | (jumpEdge ? InputFlag.jump_edge : 0) | (glideEdge ? InputFlag.glide_toggle : 0),
    yaw: yawToU16(yawRad),
    pitch: pitchToI16(pitchRad),
  };
}
