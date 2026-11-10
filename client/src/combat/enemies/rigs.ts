// Rig layouts (playtest 2 enemy models): the joints of each rig family, in
// a model at size 1 facing -Z with its feet at y = 0. A joint is a pivot
// (its rest offset in the parent joint's frame); the parts of a model are
// built in their joint's frame (models.ts) and posed per frame by pose.ts,
// which writes one rotation / offset / scale per joint into a Float32Array
// (POSE_STRIDE floats per joint). renderer.ts composes the joint matrices
// and draws every part of every enemy of a variant as one instanced draw.

import type { Rig } from './spec';
import { AVATAR_RIG } from '../../net/avatar';

export type V3 = [number, number, number];

export interface Joint {
  parent: number;
  pos: V3;
}

/** Per joint in a pose buffer: rx ry rz (XYZ euler), tx ty tz (added to the rest offset), sx sy sz. */
export const POSE_STRIDE = 9;
export const MAX_JOINTS = 12;

// ── Joint indices per rig ─────────────────────────────────────────────────

export const SL = { body: 0, face: 1 } as const;
export const Q = { body: 0, head: 1, jaw: 2, tail: 3, flU: 4, flL: 5, frU: 6, frL: 7, blU: 8, blL: 9, brU: 10, brL: 11 } as const;
export const C = { body: 0, head: 1, tail1: 2, tail2: 3, clawL: 4, clawR: 5, leg0: 6 } as const;
export const B = { hips: 0, torso: 1, head: 2, shL: 3, elL: 4, shR: 5, elR: 6, hipL: 7, knL: 8, hipR: 9, knR: 10, tail: 11 } as const;
export const F = { core: 0, ring: 1, handL: 2, handR: 3, tail: 4, head: 5 } as const;
export const W = { body: 0, head: 1, wingL: 2, wingR: 3, tail: 4, legs: 5, wingLo: 6, wingRo: 7 } as const;

export const JOINT_COUNT: Record<Rig, number> = { slime: 2, quadruped: 12, crawler: 12, biped: 12, floater: 6, winged: 8 };

// ── Dimensions ────────────────────────────────────────────────────────────

export interface SlimeDims {
  r: number;
}
export function slimeJoints(d: SlimeDims): Joint[] {
  return [
    { parent: -1, pos: [0, 0, 0] },
    { parent: 0, pos: [0, d.r * 0.95, -d.r * 0.78] },
  ];
}

export interface QuadDims {
  /** Hip (body pivot) height. */
  hipH: number;
  /** Shoulder-to-hip length. */
  len: number;
  halfW: number;
  upper: number;
  lower: number;
  /** Neck base above the body pivot, and the jaw hinge in the head frame. */
  neckY: number;
  jaw: V3;
}
export function quadJoints(d: QuadDims): Joint[] {
  const z = d.len / 2;
  return [
    { parent: -1, pos: [0, d.hipH, 0] },
    { parent: 0, pos: [0, d.neckY, -z] },
    { parent: 1, pos: d.jaw },
    { parent: 0, pos: [0, 0.04, z] },
    { parent: 0, pos: [d.halfW, -0.04, -z + 0.08] },
    { parent: 4, pos: [0, -d.upper, 0] },
    { parent: 0, pos: [-d.halfW, -0.04, -z + 0.08] },
    { parent: 6, pos: [0, -d.upper, 0] },
    { parent: 0, pos: [d.halfW, -0.04, z - 0.06] },
    { parent: 8, pos: [0, -d.upper, 0] },
    { parent: 0, pos: [-d.halfW, -0.04, z - 0.06] },
    { parent: 10, pos: [0, -d.upper, 0] },
  ];
}

export interface CrawlerDims {
  bodyH: number;
  len: number;
  halfW: number;
  leg: number;
}
export function crawlerJoints(d: CrawlerDims): Joint[] {
  const j: Joint[] = [
    { parent: -1, pos: [0, d.bodyH, 0] },
    { parent: 0, pos: [0, 0.02, -d.len * 0.5] },
    { parent: 0, pos: [0, 0.04, d.len * 0.48] },
    { parent: 2, pos: [0, 0.2, 0.18] },
    { parent: 1, pos: [d.halfW * 0.7, -0.02, -0.1] },
    { parent: 1, pos: [-d.halfW * 0.7, -0.02, -0.1] },
  ];
  for (let i = 0; i < 3; i++) {
    const z = (i - 1) * d.len * 0.3;
    j.push({ parent: 0, pos: [d.halfW, 0, z] }, { parent: 0, pos: [-d.halfW, 0, z] });
  }
  return j;
}

export interface BipedDims {
  hipY: number;
  torsoY: number;
  shoulderX: number;
  shoulderY: number;
  neckY: number;
  upper: number;
  fore: number;
  thigh: number;
  shin: number;
  hipX: number;
}
/** The player avatar's skeleton (net/avatar.ts), scaled per build. */
export function avatarDims(o: Partial<BipedDims> & { k?: number; arm?: number; leg?: number; wide?: number } = {}): BipedDims {
  const k = o.k ?? 1;
  const arm = o.arm ?? 1;
  const leg = o.leg ?? 1;
  const wide = o.wide ?? 1;
  const R = AVATAR_RIG;
  const thigh = R.THIGH * leg * k;
  const shin = R.SHIN * leg * k;
  return {
    hipY: o.hipY ?? thigh + shin,
    torsoY: o.torsoY ?? R.TORSO_Y * k,
    shoulderX: o.shoulderX ?? R.SHOULDER.x * wide * k,
    shoulderY: o.shoulderY ?? R.SHOULDER.y * k,
    neckY: o.neckY ?? R.NECK_Y * k,
    upper: o.upper ?? R.UPPER_ARM * arm * k,
    fore: o.fore ?? R.FOREARM * arm * k,
    thigh,
    shin,
    hipX: o.hipX ?? R.HIP_X * wide * k,
  };
}
export function bipedJoints(d: BipedDims): Joint[] {
  return [
    { parent: -1, pos: [0, d.hipY, 0] },
    { parent: 0, pos: [0, d.torsoY, 0] },
    { parent: 1, pos: [0, d.neckY, 0] },
    { parent: 1, pos: [-d.shoulderX, d.shoulderY, 0] },
    { parent: 3, pos: [0, -d.upper, 0] },
    { parent: 1, pos: [d.shoulderX, d.shoulderY, 0] },
    { parent: 5, pos: [0, -d.upper, 0] },
    { parent: 0, pos: [-d.hipX, 0, 0] },
    { parent: 7, pos: [0, -d.thigh, 0] },
    { parent: 0, pos: [d.hipX, 0, 0] },
    { parent: 9, pos: [0, -d.thigh, 0] },
    { parent: 0, pos: [0, 0.02, 0.12] },
  ];
}

export interface FloaterDims {
  /** Core height above the pivot. */
  coreY: number;
  handX: number;
  handY: number;
  headY: number;
}
export function floaterJoints(d: FloaterDims): Joint[] {
  return [
    { parent: -1, pos: [0, d.coreY, 0] },
    { parent: 0, pos: [0, 0, 0] },
    { parent: 0, pos: [-d.handX, d.handY, -0.1] },
    { parent: 0, pos: [d.handX, d.handY, -0.1] },
    { parent: 0, pos: [0, -0.1, 0.02] },
    { parent: 0, pos: [0, d.headY, 0] },
  ];
}

export interface WingedDims {
  bodyY: number;
  wingX: number;
  span: number;
  headZ: number;
}
export function wingedJoints(d: WingedDims): Joint[] {
  return [
    { parent: -1, pos: [0, d.bodyY, 0] },
    { parent: 0, pos: [0, 0.08, d.headZ] },
    { parent: 0, pos: [-d.wingX, 0.08, 0] },
    { parent: 0, pos: [d.wingX, 0.08, 0] },
    { parent: 0, pos: [0, 0, 0.2] },
    { parent: 0, pos: [0, -0.15, 0] },
    { parent: 2, pos: [-d.span * 0.5, 0, 0] },
    { parent: 3, pos: [d.span * 0.5, 0, 0] },
  ];
}
