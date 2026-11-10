// WP13 golden: the dodge and every mobility dash variant through the shared
// step, on WP02's flat and tilted-plane grounds (the Go replay builds them in
// two lines: server/pkg/movement/dash_golden_test.go). Each row carries the
// dash and i-frame counters and stamina so the replay checks the discrete
// state exactly, not just positions.

import { COMBAT, InputFlag as F, pitchToI16, yawToU16 } from '@lodestone/contracts';
import { newMoveState, stepMovement, STEP_DT, type MoveState } from '../movement';
import { makeGround, type GroundSpec } from './scenarios';

/** [x, y, z, vx, vy, vz, airJumps, mode, stamina, dash, iframes] after each step. */
export type Row11 = [number, number, number, number, number, number, number, number, number, number, number];

export interface Wp13Golden {
  format: 'lodestone-movement-golden';
  version: 4;
  doc: string;
  scenario: string;
  dt: number;
  ground: GroundSpec;
  initial: Row11;
  /** [seq, flags, yawU16, pitchI16, castSlot] per step. */
  frames: [number, number, number, number, number][];
  states: Row11[];
}

export const WP13_SCENARIOS: { name: string; ground: GroundSpec; start: { x: number; z: number } }[] = [
  { name: 'dash_flat', ground: { kind: 'flat', height: 0 }, start: { x: 2048, z: 2048 } },
  { name: 'dash_plane', ground: { kind: 'plane', base: 10, sx: 0.15, sz: -0.08 }, start: { x: 100, z: 100 } },
  // CR 021: an island in a lake: the held skate (glacier step) runs over the water, the jet flies over it, the rest swim (islandFrames).
  { name: 'dash_island', ground: { kind: 'island', height: 2.5, bottom: 0, water: 2.6, cx: 1000, cz: 1000, r: 10 }, start: { x: 1000, z: 1000 } },
];

export function toRow11(s: MoveState): Row11 {
  return [s.pos.x, s.pos.y, s.pos.z, s.vel.x, s.vel.y, s.vel.z, s.airJumps, s.mode, s.stamina, s.dash ?? 0, s.iframes ?? 0];
}

/**
 * Script: walk, a plain dodge back with no key held, dodges while moving and
 * mid-air, a dodge spam that runs into the counters, then every dash
 * variant from combat.yaml (forward, sideways, launches), with a jump and a
 * sprint in between so dashes start from varied states.
 */
export function wp13Frames(): [number, number, number, number, number][] {
  const out: [number, number, number, number, number][] = [];
  let seq = 0;
  let yaw = 0;
  const seg = (n: number, flags: number, press = 0, slot = 0) => {
    for (let i = 0; i < n; i++) out.push([++seq, flags | (i === 0 ? press : 0), yawToU16(yaw), 0, i === 0 ? slot : 0]);
  };
  seg(30, F.forward);
  seg(40, 0, F.dodge); // plain dodge, no key: backwards
  seg(40, F.forward, F.dodge);
  seg(20, F.left | F.forward, F.dodge);
  yaw = 0.7;
  seg(10, F.forward | F.jump);
  seg(30, F.forward, F.dodge); // air dodge
  for (let i = 0; i < 6; i++) seg(5, F.right, F.dodge); // spam: counters gate it
  seg(60, F.forward | F.sprint);
  for (const d of COMBAT.dashes) {
    yaw += 0.9;
    seg(35, d.id % 2 ? F.forward : 0, F.dodge, d.id);
  }
  seg(60, 0);
  // CR 021 (dash overhaul): every held dash. The start step (dodge +
  // variant), held steps (channel + variant; the jet looks up, level, then
  // dives), a release that keeps naming the variant through the carry, then
  // idle. Frames that must NOT hold: channel with a cast flag, and channel
  // with the variant after the dash has ended.
  const push = (n: number, flags: number, pitch: number, slot: number) => {
    for (let i = 0; i < n; i++) out.push([++seq, flags, yawToU16(yaw), pitchToI16(pitch), slot]);
  };
  for (const d of COMBAT.dashes) {
    if (!d.sustain) continue;
    yaw += 0.7;
    const keys = d.id % 2 ? F.forward : F.forward | F.left;
    const jet = d.sustain.kind === 'jet';
    push(1, keys | F.dodge, jet ? 0.5 : 0, d.id);
    if (jet) {
      push(50, F.channel, 0.6, d.id);
      push(30, F.channel | F.forward, -0.1, d.id);
      push(40, F.channel, -1.2, d.id); // a dive into the ground
    } else {
      push(40, keys | F.channel, 0, d.id);
      yaw += 0.5;
      push(30, F.channel, 0, d.id); // no key: straight ahead, steered by the yaw
    }
    push(1, F.channel | F.cast, 0, d.id); // a cast step never holds (the dash runs out)
    push(d.sustain.carrySteps + 2, 0, 0, d.id); // the carry, then the exit clamp at this variant's exitSpeed
    push(20, F.channel, 0, d.id); // ended: holding does nothing
    push(40, 0, 0, 0);
  }
  return out;
}

/** CR 021 island script: glacier step off the island, held over the lake (a skate), released: it sinks into a swim. */
export function islandFrames(): [number, number, number, number, number][] {
  const out: [number, number, number, number, number][] = [];
  let seq = 0;
  const glacier = COMBAT.dashes.find((d) => d.key === 'glacier_step')!;
  const push = (n: number, flags: number, yaw: number, slot: number) => {
    for (let i = 0; i < n; i++) out.push([++seq, flags, yawToU16(yaw), 0, slot]);
  };
  push(10, 0, 0, 0);
  push(1, F.forward | F.dodge, 0, glacier.id);
  push(60, F.forward | F.channel, 0, glacier.id);
  push(30, F.forward | F.right | F.channel, 0.4, glacier.id);
  push((glacier.sustain?.carrySteps ?? 4) + 2, F.forward, 0.4, glacier.id);
  push(60, F.forward, 0.4, 0);
  return out;
}

export function runWp13(name: string): Wp13Golden {
  const sc = WP13_SCENARIOS.find((s) => s.name === name)!;
  const ground = makeGround(sc.ground);
  let s = newMoveState({ x: sc.start.x, y: ground.heightAt(sc.start.x, sc.start.z), z: sc.start.z });
  const initial = toRow11(s);
  const frames = name === 'dash_island' ? islandFrames() : wp13Frames();
  const states: Row11[] = [];
  for (const [seqN, flags, yaw, pitch, castSlot] of frames) {
    void seqN;
    s = stepMovement(s, { flags, yaw, pitch, castSlot }, ground, STEP_DT);
    states.push(toRow11(s));
  }
  return {
    format: 'lodestone-movement-golden',
    version: 4,
    doc: 'WP13 dash golden (v4: CR 021 held dashes, jet pitch, island skate), generated by client/src/sim/golden/generate.ts from stepMovement. Replay: start at `initial`, apply each frame (castSlot = dash variant with the dodge flag, and on held / carry steps), compare to states[i].',
    scenario: name,
    dt: STEP_DT,
    ground: sc.ground,
    initial,
    frames,
    states,
  };
}
