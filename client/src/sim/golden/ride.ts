// CR 027 (playtest 2 mounts) golden: riding the spirit steed through the
// shared step on flat ground, the tilted plane and two synthetic courses
// (a fence to jump, a building wall to bump, a hill, a 10 m drop that throws
// the rider; a ford, a lake the steed refuses, a cliff it can't climb). The
// Go replay (server/pkg/movement/ride_golden_test.go) builds the same
// grounds. Rows carry the whole carried state (mode, stamina, timer, lunge
// = the gait bits, flags = mounted/sliding/exhausted) so the replay checks
// the discrete state exactly.
//
// The script is generated against the state (jump when the fence is close,
// turn north at the wall), but the frames it produced are what the file
// stores: the replay just applies them.

import { InputFlag as F, yawToU16 } from '@lodestone/contracts';
import type { CollideResult, GroundQuery } from '../ground';
import { MoveFlag, newMoveState, stepMovement, STEP_DT, type MoveState } from '../movement';
import { makeGround, type GroundSpec } from './scenarios';

/** [x, y, z, vx, vy, vz, airJumps, mode, stamina, timer, lunge, flags] after each step. */
export type RideRow = [number, number, number, number, number, number, number, number, number, number, number, number];

export type RideGroundSpec = GroundSpec | { kind: 'course' };

export interface RideGolden {
  format: 'lodestone-movement-golden';
  version: 5;
  doc: string;
  scenario: string;
  dt: number;
  ground: RideGroundSpec;
  initial: RideRow;
  /** [seq, flags, yawU16, pitchI16, castSlot] per step. */
  frames: [number, number, number, number, number][];
  states: RideRow[];
}

export const RIDE_SCENARIOS: { name: string; ground: RideGroundSpec; start: { x: number; z: number }; script: 'basic' | 'east' | 'west' }[] = [
  { name: 'ride_flat', ground: { kind: 'flat', height: 0 }, start: { x: 2048, z: 2048 }, script: 'basic' },
  { name: 'ride_plane', ground: { kind: 'plane', base: 10, sx: 0.15, sz: -0.08 }, start: { x: 100, z: 100 }, script: 'basic' },
  { name: 'ride_course_east', ground: { kind: 'course' }, start: { x: 1000, z: 1000 }, script: 'east' },
  { name: 'ride_course_west', ground: { kind: 'course' }, start: { x: 985, z: 1000 }, script: 'west' },
];

// ---- the course (Go twin: courseGround in ride_golden_test.go)
//   z-stripes: a 26.6 degree hill rising north from z 940 to 10 m at z 920, a
//   plateau to z 880, then a sheer 10 m drop; a 63 degree cliff south of z 1040.
//   x-stripes: a ford (0.4 m deep) for x in [960, 975), a bank sloping down
//   to a lake (1.7 m) west of 955 (water at -0.5); a 1 m fence for x in
//   [1040, 1040.6).
//   A building wall: a solid box x [1060, 1062], z [900, 1040], 4 m tall.

function courseBase(z: number): number {
  if (z > 1040) return (z - 1040) * 2;
  if (z > 940) return 0;
  if (z > 920) return (940 - z) * 0.5;
  if (z > 880) return 10;
  return 0;
}

function courseHeight(x: number, z: number): number {
  let h = courseBase(z);
  if (x < 955) h -= 2.2;
  else if (x < 960) h -= 0.9 + (960 - x) * 0.26;
  else if (x < 975) h -= 0.9;
  if (x >= 1040 && x < 1040.6) h += 1;
  return h;
}

const BOX = { x0: 1060, x1: 1062, z0: 900, z1: 1040, top: 4, r: 0.4 };

function courseCollide(x: number, y: number, z: number, out: CollideResult): CollideResult {
  out.x = x;
  out.y = y;
  out.z = z;
  out.pushX = 0;
  out.pushZ = 0;
  out.ceiling = false;
  const b = BOX;
  if (y >= b.top || x <= b.x0 - b.r || x >= b.x1 + b.r || z <= b.z0 - b.r || z >= b.z1 + b.r) return out;
  const dl = x - (b.x0 - b.r);
  const dr = b.x1 + b.r - x;
  const dn = z - (b.z0 - b.r);
  const ds = b.z1 + b.r - z;
  const m = Math.min(dl, dr, dn, ds);
  if (m === dl) out.x = b.x0 - b.r;
  else if (m === dr) out.x = b.x1 + b.r;
  else if (m === dn) out.z = b.z0 - b.r;
  else out.z = b.z1 + b.r;
  out.pushX = out.x - x;
  out.pushZ = out.z - z;
  return out;
}

export const COURSE: GroundQuery = {
  heightAt: courseHeight,
  waterAt: (x: number) => (x < 975 ? -0.5 : -Infinity),
  collide: courseCollide,
};

export function rideGround(g: RideGroundSpec): GroundQuery {
  return g.kind === 'course' ? COURSE : makeGround(g);
}

export function toRideRow(s: MoveState): RideRow {
  return [s.pos.x, s.pos.y, s.pos.z, s.vel.x, s.vel.y, s.vel.z, s.airJumps, s.mode, s.stamina, s.timer, s.lunge, s.flags];
}

/** A rider in the saddle (what the zone's Mount does: the flag, a trot gait). */
export function mountedState(ground: GroundQuery, x: number, z: number): MoveState {
  const s = newMoveState({ x, y: ground.heightAt(x, z), z });
  s.flags |= MoveFlag.mounted;
  return s;
}

type Frame = [number, number, number, number, number];

/** Runs a state-aware script; returns the frames and the states after each. */
function drive(ground: GroundQuery, s0: MoveState, script: (push: (n: number, flags: number, yaw: number) => void, st: () => MoveState) => void): { frames: Frame[]; states: RideRow[] } {
  const frames: Frame[] = [];
  const states: RideRow[] = [];
  let s = s0;
  let seq = 0;
  const push = (n: number, flags: number, yaw: number) => {
    for (let i = 0; i < n; i++) {
      const f: Frame = [++seq, flags, yawToU16(yaw), 0, 0];
      frames.push(f);
      s = stepMovement(s, { flags, yaw: f[2], pitch: 0, castSlot: 0 }, ground, STEP_DT);
      states.push(toRideRow(s));
    }
  };
  script(push, () => s);
  return { frames, states };
}

const W = F.forward;
const SP = F.sprint;
const J = F.jump | F.jump_edge;

/** Gaits, spurs, turning, brake, back up, pivots, a jump, a dodge that must do nothing, hop off, walk. */
function basicScript(push: (n: number, flags: number, yaw: number) => void): void {
  push(20, 0, 0); // standing in the saddle
  push(90, W, 0); // trot
  push(1, W | SP, 0); // spur: gallop
  push(40, W | SP, 0); // holding Shift does not spur again
  push(40, W, 0);
  push(1, W | SP, 0); // spur at a gallop: the burst
  push(30, W, 0.0);
  push(90, W, 1.2); // look left: a gallop turn (75 deg/s)
  push(1, W | F.dodge, 1.2); // dodge while mounted: nothing
  push(30, W | F.left, 1.2); // diagonal steer
  push(1, W | J, 1.2); // jump while moving
  push(50, W, 1.2);
  push(40, F.back, 1.2); // brake (and rein in to a walk)
  push(40, F.back, 1.2); // back up away from the look
  push(30, W, 1.2); // a walk now
  push(30, F.right, 1.2); // A/D alone: turn at a walk
  push(40, 0, 1.2); // stop
  for (let i = 0; i < 7; i++) {
    push(1, W | SP, 0.3); // spur until the wheel runs short
    push(5, W, 0.3);
  }
  push(120, 0, 0.3); // stop and let the wheel refill
  push(1, J, 0.3); // Space at a standstill: hop off
  push(60, W, 0.3); // on foot again
}

export function rideRun(name: string): RideGolden {
  const sc = RIDE_SCENARIOS.find((s) => s.name === name)!;
  const ground = rideGround(sc.ground);
  const s0 = mountedState(ground, sc.start.x, sc.start.z);
  const initial = toRideRow(s0);
  const EAST = -Math.PI / 2;
  const NORTH = 0;
  const WEST = Math.PI / 2;
  const SOUTH = Math.PI;
  const { frames, states } = drive(ground, s0, (push, st) => {
    if (sc.script === 'basic') return basicScript(push);
    if (sc.script === 'east') {
      // Gallop east, jump the fence, bump the building, follow it north, up
      // the hill, off the plateau's edge: thrown by the fall, walk on.
      push(10, 0, EAST);
      push(30, W, EAST);
      push(1, W | SP, EAST);
      push(20, W, EAST);
      let guard = 0;
      while (st().pos.x < 1037.2 && guard++ < 600) push(1, W, EAST);
      push(1, W | J, EAST); // over the fence
      guard = 0;
      while (st().pos.x < 1058.2 && guard++ < 600) push(1, W, EAST);
      push(40, W, EAST); // into the wall: pushed out, stopped
      push(30, W | F.left, EAST); // along it (north)
      guard = 0;
      while (st().pos.z > 870 && guard++ < 1200 && (st().flags & MoveFlag.mounted) !== 0) push(1, W, NORTH);
      push(60, W, NORTH); // thrown at the bottom (or the fall): on foot
      return;
    }
    // west: through the ford (slower), refused at the lake, brake, back up,
    // turn south into the cliff (refused, slides along), stop, hop off.
    push(10, 0, WEST);
    let g0 = 0;
    while (st().pos.x > 961 && g0++ < 900) push(1, W, WEST);
    push(60, W, WEST); // the lake: refused at its edge
    push(40, W | F.left, WEST);
    push(30, F.back, WEST);
    push(30, F.back, WEST);
    push(1, W | SP, SOUTH);
    let guard = 0;
    while (st().pos.z < 1039 && guard++ < 900) push(1, W, SOUTH);
    push(60, W, SOUTH); // the cliff: a wall to the steed
    push(30, W | F.right, SOUTH);
    push(60, 0, SOUTH);
    push(1, J, SOUTH); // hop off
    push(40, W, SOUTH); // on foot the 63 degree cliff is a climb
  });
  return {
    format: 'lodestone-movement-golden',
    version: 5,
    doc: 'CR 027 ride golden, generated by client/src/sim/golden/generate.ts from stepMovement. `initial` is a rider in the saddle (flags bit 3 mounted, as the zone mounts). Replay: apply each frame, compare to states[i] (positions 1e-9 m, the rest exactly). Ground `course`: courseGround in server/pkg/movement/ride_golden_test.go.',
    scenario: name,
    dt: STEP_DT,
    ground: sc.ground,
    initial,
    frames,
    states,
  };
}

/** What a golden exercised (generator log, tests). */
export function rideSummary(g: RideGolden): Record<string, number> {
  let maxSpeed = 0;
  let spurs = 0;
  let jumps = 0;
  let dismountAt = -1;
  let refusals = 0;
  let prevStamina = g.initial[8];
  let prev = g.initial;
  g.states.forEach((r, i) => {
    const sp = Math.hypot(r[3], r[5]);
    if (r[11] & MoveFlag.mounted) maxSpeed = Math.max(maxSpeed, sp);
    if (r[8] < prevStamina - 100) spurs++;
    if (r[4] > 6.5 && prev[4] <= 6.5) jumps++;
    if (dismountAt < 0 && (prev[11] & MoveFlag.mounted) !== 0 && (r[11] & MoveFlag.mounted) === 0) dismountAt = i;
    if (r[11] & MoveFlag.mounted && Math.hypot(prev[3], prev[5]) > 1 && sp === 0) refusals++;
    prevStamina = r[8];
    prev = r;
  });
  return { steps: g.states.length, maxSpeed: Math.round(maxSpeed * 100) / 100, spurs, jumps, dismountAt, refusals };
}
