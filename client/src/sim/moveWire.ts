// MoveState <-> SelfState (protocol.yaml, v2). The server sends everything a
// replay needs: position and velocity quantized (cm, cm/s, as before), and the
// WP10 state exactly: mode, airJumps, flags (bits 0-3 MoveFlag, bits 4-7 the
// lunge counter) and moveExt (stamina in fine units | timer << 16). The Go
// twin is movement.SelfFields / movement.FromSelf (server/pkg/movement/wire.go).

import { cmToMeters, cmsToVel } from '@lodestone/contracts';
import { activityOf, FINE, type MoveState } from './movement';

/** The SelfState fields this module reads (FullSelf from the decoder satisfies it). */
export interface SelfMoveFields {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  staminaMax: number;
  mode: number;
  airJumps: number;
  flags: number;
  moveExt: number;
}

export function packFlags(s: Pick<MoveState, 'flags' | 'lunge'>): number {
  return (s.flags & 0x0f) | ((s.lunge & 0x0f) << 4);
}

/** WP13 (protocol v4): bits 24-27 dash steps, 28-31 dodge i-frame steps. */
export function packMoveExt(s: Pick<MoveState, 'stamina' | 'timer' | 'dash' | 'iframes'>): number {
  return ((s.stamina & 0xffff) | ((s.timer & 0xff) << 16) | (((s.dash ?? 0) & 0xf) << 24) | (((s.iframes ?? 0) & 0xf) << 28)) >>> 0;
}

/** Display stamina (x10, one decimal) from fine units. */
export function staminaX10(fine: number): number {
  return Math.round((fine * 10) / FINE);
}

/** The movement half of a SelfState for a state (what the zone sends). */
export function selfFields(s: MoveState): { stamina: number; staminaMax: number; mode: number; airJumps: number; activity: number; flags: number; moveExt: number } {
  return {
    stamina: staminaX10(s.stamina),
    staminaMax: staminaX10(s.staminaMax),
    mode: s.mode,
    airJumps: s.airJumps,
    activity: activityOf(s),
    flags: packFlags(s),
    moveExt: packMoveExt(s),
  };
}

/** Rebuild the replayable state from a SelfState (position/velocity are cm-quantized). */
export function fromSelf(f: SelfMoveFields): MoveState {
  return {
    pos: { x: cmToMeters(f.x), y: cmToMeters(f.y), z: cmToMeters(f.z) },
    vel: { x: cmsToVel(f.vx), y: cmsToVel(f.vy), z: cmsToVel(f.vz) },
    airJumps: f.airJumps,
    mode: f.mode,
    stamina: f.moveExt & 0xffff,
    // The wheel size travels as x10 points; whole tenths are exact in fine units.
    staminaMax: Math.round((f.staminaMax * FINE) / 10),
    timer: (f.moveExt >>> 16) & 0xff,
    lunge: (f.flags >> 4) & 0x0f,
    flags: f.flags & 0x0f,
    dash: (f.moveExt >>> 24) & 0xf,
    iframes: (f.moveExt >>> 28) & 0xf,
  };
}
