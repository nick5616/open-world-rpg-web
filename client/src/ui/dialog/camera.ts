// The conversation camera (CR 049): ease the view to frame the person's
// face while you talk, and back to where you were looking after. First
// person the view turns toward them; third person the same turn puts the
// camera over your shoulder looking at them (the boom hangs behind the
// view direction). PlayerController calls `dialogCamStep` once a frame, right
// after the mouse look; nothing else moves the camera.

export interface Aim {
  yaw: number;
  pitch: number;
}

/** Camera-convention angles (forward = (-sin yaw, -cos yaw)) from an eye to a point. */
export function aimAt(eye: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): Aim {
  const dx = to.x - eye.x;
  const dz = to.z - eye.z;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(to.y - eye.y, Math.hypot(dx, dz)) };
}

/** Shortest signed turn from a to b (radians). */
export function turnTo(a: number, b: number): number {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}

export const dialogCam = {
  phase: 'off' as 'off' | 'in' | 'out',
  target: { x: 0, y: 0, z: 0 },
  savedYaw: 0,
  savedPitch: 0,
  /** Ease time constant, seconds. */
  tau: 0.2,
};

/** Frame `target` (the person's face); remembers the current view to restore. */
export function dialogCamBegin(target: { x: number; y: number; z: number }, yaw: number, pitch: number): void {
  if (dialogCam.phase !== 'in') {
    dialogCam.savedYaw = yaw;
    dialogCam.savedPitch = pitch;
  }
  dialogCam.target.x = target.x;
  dialogCam.target.y = target.y;
  dialogCam.target.z = target.z;
  dialogCam.phase = 'in';
}

/** Ease back to the saved view, then stop driving. */
export function dialogCamEnd(): void {
  if (dialogCam.phase === 'in') dialogCam.phase = 'out';
}

export function dialogCamReset(): void {
  dialogCam.phase = 'off';
}

/** One frame: moves lk toward the framing (or back); true while it drives the view. */
export function dialogCamStep(lk: Aim, eye: { x: number; y: number; z: number }, dt: number, reducedMotion = false): boolean {
  if (dialogCam.phase === 'off') return false;
  const goal = dialogCam.phase === 'in' ? aimAt(eye, dialogCam.target) : { yaw: dialogCam.savedYaw, pitch: dialogCam.savedPitch };
  const k = reducedMotion ? 1 : 1 - Math.exp(-Math.min(dt, 0.25) / dialogCam.tau);
  const dy = turnTo(lk.yaw, goal.yaw);
  const dp = goal.pitch - lk.pitch;
  lk.yaw += dy * k;
  lk.pitch += dp * k;
  if (dialogCam.phase === 'out' && Math.abs(dy) < 0.004 && Math.abs(dp) < 0.004) {
    lk.yaw = goal.yaw;
    lk.pitch = goal.pitch;
    dialogCam.phase = 'off';
    return false;
  }
  return true;
}
