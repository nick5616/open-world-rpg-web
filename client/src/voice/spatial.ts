// Pure math for proximity voice (spec 10 "Proximity voice" 2-3): where the
// listener's ears point, how loud the PannerNode will make a speaker, whether
// a speaker sounds spatial or through the party radio, and whether terrain is
// between two heads. No Web Audio here, so all of it is unit-tested in Node.

import { EARSHOT_LEAVE_M, PLAYER_HEIGHT, VOICE_MAX_DISTANCE_M, VOICE_REF_DISTANCE_M } from '@lodestone/contracts';
import type { GroundQuery } from '../sim/ground';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Ears are at eye height (PLAYER_HEIGHT above the feet), for listener and speakers alike. */
export function headOf(feet: Vec3): Vec3 {
  return { x: feet.x, y: feet.y + PLAYER_HEIGHT, z: feet.z };
}

/**
 * The listener's forward and up vectors from the camera's yaw and pitch.
 * Same convention as the camera (Euler YXZ): yaw 0 looks down -Z, forward =
 * (-sin yaw cos pitch, sin pitch, -cos yaw cos pitch); up is forward's
 * perpendicular in the same vertical plane, so HRTF stays right when you
 * look up at a speaker on a ledge.
 */
export function listenerAxes(yaw: number, pitch: number): { forward: Vec3; up: Vec3 } {
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return {
    forward: { x: -Math.sin(yaw) * cp, y: sp, z: -Math.cos(yaw) * cp },
    up: { x: Math.sin(yaw) * sp, y: cp, z: Math.cos(yaw) * sp },
  };
}

/** Speaker position in the listener's frame: +right, +up, +forward (m). For logs and tests. */
export function relativeToListener(listener: Vec3, yaw: number, pitch: number, p: Vec3): { right: number; up: number; forward: number } {
  const { forward, up } = listenerAxes(yaw, pitch);
  // right = forward x up
  const right = { x: forward.y * up.z - forward.z * up.y, y: forward.z * up.x - forward.x * up.z, z: forward.x * up.y - forward.y * up.x };
  const d = { x: p.x - listener.x, y: p.y - listener.y, z: p.z - listener.z };
  const dot = (a: Vec3) => a.x * d.x + a.y * d.y + a.z * d.z;
  return { right: dot(right), up: dot(up), forward: dot(forward) };
}

/**
 * What a PannerNode with distanceModel "inverse" does to the level (Web Audio
 * spec): ref / (ref + rolloff * (clamp(d, ref, max) - ref)). With ref 2 m and
 * max 40 m: 1 at 2 m, 0.4 at 5 m, 0.1 at 20 m, 0.05 (-26 dB) from 40 m until
 * the server unsubscribes at 48 m.
 */
export function inverseDistanceGain(d: number, ref = VOICE_REF_DISTANCE_M, max = VOICE_MAX_DISTANCE_M, rolloff = 1): number {
  const dc = Math.min(Math.max(d, ref), max);
  return ref / (ref + rolloff * (dc - ref));
}

export type VoiceMode = 'spatial' | 'radio' | 'flat';

/**
 * How a subscribed speaker should sound this frame.
 *  - spatial: we draw them (interpolated position) within the leave radius;
 *    everyone the server subscribed for proximity is here.
 *  - radio: a party member beyond earshot (or not drawn at all: another
 *    region, far ring), heard flat through the radio filter (spec 10).
 *  - flat: subscribed but neither drawn nor partied, which only happens for
 *    a moment around a handoff or a snapshot gap: centered at the
 *    reference distance rather than guessing a position.
 */
export function chooseMode(distance: number | null, isPartyMember: boolean): VoiceMode {
  if (distance !== null && distance <= EARSHOT_LEAVE_M) return 'spatial';
  if (isPartyMember) return 'radio';
  return distance !== null ? 'spatial' : 'flat';
}

/**
 * Terrain occlusion without a raycast: sample the ground height along the
 * segment between two heads and report whether the ground rises above the
 * line anywhere (with a little clearance so walking over a bump doesn't
 * muffle someone). Spec 10 asks for a wasm raycast; @lodestone/worldgen has
 * one but the client does not load the wasm yet (WP05), so this uses the
 * GroundQuery every system already shares, which is exact for heightfield
 * terrain. Underground the surface is above both heads, so a sample below it
 * counts only when it is not open cave air (GroundQuery.caveAir, WP09's cave
 * density): two people in the same tunnel are not muffled, rock between them
 * still is (G3).
 *
 * Samples every 2 m (at most 32), skipping the first and last metre, which
 * are the speakers' own feet.
 */
export function terrainBetween(ground: GroundQuery, a: Vec3, b: Vec3, clearance = 0.3): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len < 3) return false;
  const n = Math.min(32, Math.max(2, Math.floor(len / 2)));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (t * len < 1 || (1 - t) * len < 1) continue;
    const x = a.x + dx * t;
    const z = a.z + dz * t;
    const lineY = a.y + dy * t;
    if (ground.heightAt(x, z) > lineY - clearance && !(ground.caveAir?.(x, lineY, z) ?? false)) return true;
  }
  return false;
}

/** Cutoff of the occlusion low-pass: open, or muffled behind a hill. */
export const OCCLUSION_OPEN_HZ = 20000;
export const OCCLUSION_MUFFLED_HZ = 900;
