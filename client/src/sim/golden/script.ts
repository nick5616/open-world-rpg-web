// The scripted input sequence behind the golden trajectories and the
// wizard-wars side-by-side comparison. Each segment exercises one rule of the
// step (README.md): ground accel to top speed, sprint, friction stop, diagonal
// normalization, ground jump, double jump on a fresh press, a refused third
// jump, held-jump auto-hop with air strafing while turning, backpedal.
// Changing this changes the golden files; regenerate with `npm run golden -w client`.

import { InputFlag } from '@lodestone/contracts';
import type { MoveInput } from '../movement';

const F = InputFlag;

export interface ScriptFrame extends MoveInput {
  seq: number;
}

interface Segment {
  steps: number;
  flags: number;
  /** u16 yaw at the first step of the segment. */
  yaw: number;
  /** u16 yaw added per step (wraps at 65536), for turning while moving. */
  yawRate?: number;
  /** Extra flags on specific step indices within the segment (e.g. a jump_edge press). */
  at?: Record<number, number>;
}

const SEGMENTS: Segment[] = [
  { steps: 15, flags: 0, yaw: 0 }, // idle on the ground
  { steps: 90, flags: F.forward, yaw: 0 }, // walk: accelerate to BASE_MOVE_SPEED
  { steps: 90, flags: F.forward | F.sprint, yaw: 0 }, // sprint
  { steps: 45, flags: 0, yaw: 0 }, // release: friction + STOP_SPEED floor bring it to 0
  { steps: 60, flags: F.forward | F.right, yaw: 8192 }, // diagonal at 45 deg yaw
  // Ground jump on step 0 (jump + jump_edge, as a real key press produces),
  // double jump on a fresh press at step 20, a third press at step 35 that
  // MAX_AIR_JUMPS refuses, then land and keep walking.
  { steps: 80, flags: F.forward, yaw: 8192, at: { 0: F.jump | F.jump_edge, 1: F.jump, 2: F.jump, 20: F.jump | F.jump_edge, 35: F.jump | F.jump_edge } },
  // Held jump = auto-hop on every landing; strafe left while turning left:
  // the classic air-strafe that AIR_CAP_SPEED/AIR_ACCEL let gain speed.
  { steps: 150, flags: F.left | F.jump, yaw: 8192, yawRate: 260 },
  { steps: 60, flags: F.back, yaw: 30000 }, // backpedal after landing
  { steps: 30, flags: F.back | F.left | F.sprint, yaw: 30000 }, // diagonal sprint backwards
  { steps: 70, flags: 0, yaw: 30000 }, // stop
];

export function goldenScript(): ScriptFrame[] {
  const out: ScriptFrame[] = [];
  let seq = 1;
  for (const s of SEGMENTS) {
    for (let i = 0; i < s.steps; i++) {
      const yaw = (s.yaw + (s.yawRate ?? 0) * i) & 0xffff;
      out.push({ seq: seq++, flags: s.flags | (s.at?.[i] ?? 0), yaw, pitch: 0 });
    }
  }
  return out;
}
