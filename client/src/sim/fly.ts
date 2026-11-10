// Debug fly / noclip step (spec 14 dev tools). Client-only and NOT part of the
// movement contract with the server: when WP06 connects, fly mode must either
// be refused online or become a server-checked admin command. It reuses the
// MoveInput shape so the same input pipeline drives both modes.

import { InputFlag, MoveMode, i16ToPitch, u16ToYaw } from '@lodestone/contracts';
import type { MoveInput, MoveState } from './movement';

export const FLY_SPEED = 20; // m/s: crosses a 64 m chunk in ~3 s
export const FLY_SPRINT_MULT = 4; // shift: ~80 m/s for crossing the 4 km world quickly

/** Camera-relative flight: forward follows pitch, jump rises, crouch sinks. No gravity, no ground. */
export function stepFly(state: MoveState, input: MoveInput, dt: number, speedMult = 1): MoveState {
  const yaw = u16ToYaw(input.yaw);
  const pitch = i16ToPitch(input.pitch);
  const f = input.flags;
  const cp = Math.cos(pitch);
  // Forward in three.js camera space with YXZ euler: (-sin yaw cos p, sin p, -cos yaw cos p).
  const fx = -Math.sin(yaw) * cp;
  const fy = Math.sin(pitch);
  const fz = -Math.cos(yaw) * cp;
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  let dx = 0;
  let dy = 0;
  let dz = 0;
  if (f & InputFlag.forward) { dx += fx; dy += fy; dz += fz; }
  if (f & InputFlag.back) { dx -= fx; dy -= fy; dz -= fz; }
  if (f & InputFlag.right) { dx += rx; dz += rz; }
  if (f & InputFlag.left) { dx -= rx; dz -= rz; }
  if (f & InputFlag.jump) dy += 1;
  if (f & InputFlag.crouch) dy -= 1;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  // CR 032: the dev console's fly speed (the zone's DevFlyStep multiplies the same way).
  const speed = FLY_SPEED * speedMult * (f & InputFlag.sprint ? FLY_SPRINT_MULT : 1);
  const k = len > 0 ? speed / len : 0;
  const vel = { x: dx * k, y: dy * k, z: dz * k };
  // Stamina and timers are left as they were; leaving fly drops you into a fall.
  return {
    ...state,
    pos: { x: state.pos.x + vel.x * dt, y: state.pos.y + vel.y * dt, z: state.pos.z + vel.z * dt },
    vel,
    airJumps: 0,
    mode: MoveMode.air,
    lunge: 0,
  };
}
