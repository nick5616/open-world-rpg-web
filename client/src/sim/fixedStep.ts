// Fixed-step accumulator for the render loop. Movement integrates in fixed
// 1/60 s steps, one InputFrame each, instead of once per rendered frame with
// that frame's raw delta: rAF timing is uneven (GC, compositor hitches,
// throttled tabs) and feeding that into integration is what made wizard-wars
// walking feel jittery before it switched (see its CameraController). The
// backlog is capped so a stall (alt-tab, long hitch) can't spiral into a burst
// of catch-up steps; the lost time is simply dropped.
//
// adapted from wizard-wars client/src/components/core/CameraController.tsx

export const MAX_MOVE_SUBSTEPS = 8;
/** Longest frame delta we accept at all; anything longer is a stall, not a frame. */
export const MAX_FRAME_DT = 0.25;

export interface FixedStepResult {
  /** Whole steps to simulate this frame. */
  steps: number;
  /** Leftover time carried to the next frame, in [0, step). */
  accum: number;
  /** accum / step: how far the render sits between the last two simulated states. */
  alpha: number;
}

export function advanceFixedStep(accum: number, frameDt: number, step: number, maxSteps = MAX_MOVE_SUBSTEPS): FixedStepResult {
  const dt = Math.min(Math.max(frameDt, 0), MAX_FRAME_DT);
  let a = Math.min(accum + dt, step * maxSteps);
  let steps = 0;
  // Tiny epsilon: 1/60 added 60 times is not exactly 1.0 in floats, and without
  // it a 60 Hz display would occasionally skip a step and double the next one.
  while (a >= step - 1e-9 && steps < maxSteps) {
    a -= step;
    steps++;
  }
  if (a < 0) a = 0;
  return { steps, accum: a, alpha: a / step };
}

/** Linear interpolation between the previous and current simulated position for rendering. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
