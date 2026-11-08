// WP10 golden scenarios: climb, glide, swim, slopes and stamina on REAL
// generated terrain (the official world, seed 20261108, worldgen genVersion
// 1), through the wasm collision_height / water_height both sides use. The
// Go zone step replays every file (server/pkg/movement/terrain_golden_test.go)
// on worldhost and must match within 1e-9. Sites were found by surveying the
// world (docs/evidence/wp10-sites.txt): a 14.5 m cliff above a ledge west of
// the spawn settlement, the 360 m peak at (1122, 2300) with a 70 m drop to
// the south, and the lake at (1418, 1956) (water 128.03, 2 m shelf, 8 m deep
// middle, shore at z ~1866).

import { InputFlag as F, yawToU16 } from '@lodestone/contracts';
import type { GroundQuery } from '../ground';
import { MoveMode } from '@lodestone/contracts';
import { MoveFlag, newMoveState, stepMovement, STEP_DT, type MoveState, type StepEnv } from '../movement';
import { UpdraftColumns, type UpdraftColumn } from '../updraft';
import { StructureGround } from '../../world/structures/overlay';
import { towersFromAtlas } from '../../world/structures/towers';
import type { WorldgenGround } from '../worldgenGround';

/** The world every WP10 golden runs on. */
export const WP10_SEED = '20261108';

/** [x, y, z, vx, vy, vz, airJumps, mode, stamina, timer, lunge, flags] after each step. */
export type Row12 = [number, number, number, number, number, number, number, number, number, number, number, number];

interface Seg {
  steps: number;
  flags: number;
  /** Yaw in degrees from this segment on (default: keep). */
  yawDeg?: number;
  /** Extra flags on the first step only (a key press: jump_edge, glide_toggle). */
  press?: number;
}

export interface Wp10Scenario {
  name: string;
  doc: string;
  /** Run on terrain + WP12's tower overlay (the ground the game and zone use since WP12). */
  towers?: boolean;
  /**
   * Prefix the segments with a planned climb (planClimb: hold forward, rest
   * on each ledge a climb tops out on until the wheel is full) that ends at
   * this point on the top of the tower nearest to it.
   */
  climbTo?: { x: number; z: number };
  start: { x: number; z: number; yawDeg: number };
  /** Overrides on the fresh standing state (e.g. start exhausted). */
  initial?: Partial<Pick<MoveState, 'stamina' | 'flags'>>;
  raining: boolean;
  updrafts: UpdraftColumn[];
  segments: Seg[];
}

export interface Wp10Golden {
  format: 'lodestone-movement-golden';
  version: 2;
  doc: string;
  scenario: string;
  dt: number;
  ground: { kind: 'worldgen'; seed: string; genVersion: number; structures?: 'towers' };
  env: { raining: boolean; updrafts: [number, number, number, number, number][] };
  staminaMax: number;
  initial: Row12;
  /** [seq, flags, yawU16, pitchI16] per step. */
  frames: [number, number, number, number][];
  states: Row12[];
}

const fwd = F.forward;
const climbSite = { x: 1336.2, z: 2339.35, yawDeg: 90 }; // ledge below the 14.5 m cliff, facing west (uphill)
const peak = { x: 1122, z: 2301, yawDeg: 180 }; // the 360 m peak, facing south (+z, the drop)
const shore = { x: 1418, z: 1858, yawDeg: 180 }; // dry shore south of the lake, facing north (+z, into it)
// WP12 tower at atlas site (1888, 1760), 513 m from the spawn settlement:
// start 14 m west of its axis, facing east (yaw -90: forward = +x).
const tower = { x: 1874, z: 1760, yawDeg: -90 };

export const WP10_SCENARIOS: Wp10Scenario[] = [
  {
    name: 'climb',
    doc: 'Walk into the cliff (grab), climb, climb-jump lunge, traverse, climb to the top and mantle, walk on, stop.',
    start: climbSite,
    raining: false,
    updrafts: [],
    segments: [
      { steps: 20, flags: 0 },
      { steps: 180, flags: fwd },
      { steps: 1, flags: fwd, press: F.jump | F.jump_edge },
      { steps: 60, flags: fwd },
      { steps: 60, flags: fwd | F.right },
      { steps: 225, flags: fwd },
      { steps: 40, flags: fwd, yawDeg: 170 },
      { steps: 30, flags: 0 },
    ],
  },
  {
    name: 'climb_rain',
    doc: 'Same cliff in rain: half speed, a slip every 3 s, the wheel empties before the top and the climber slides back down.',
    start: climbSite,
    raining: true,
    updrafts: [],
    segments: [
      { steps: 20, flags: 0 },
      { steps: 760, flags: fwd },
      { steps: 120, flags: 0 },
    ],
  },
  {
    name: 'climb_kick',
    doc: 'Climb, hang without input (no drain), climb down, climb up, then jump while holding back: kick off the wall, fall and land.',
    start: climbSite,
    raining: false,
    updrafts: [],
    segments: [
      { steps: 20, flags: 0 },
      { steps: 200, flags: fwd },
      { steps: 60, flags: 0 },
      { steps: 40, flags: F.back },
      { steps: 40, flags: fwd | F.left },
      { steps: 1, flags: F.back, press: F.jump | F.jump_edge },
      { steps: 140, flags: 0 },
    ],
  },
  {
    name: 'glide',
    doc: 'Sprint off the peak, jump, double jump, a third press opens the glider; steer, close with G (glide_toggle), fall, reopen with G, steer left, close and fall to the slope below.',
    start: peak,
    raining: false,
    updrafts: [],
    segments: [
      { steps: 90, flags: fwd | F.sprint },
      { steps: 24, flags: fwd, press: F.jump | F.jump_edge },
      { steps: 30, flags: fwd, press: F.jump_edge },
      { steps: 240, flags: fwd, press: F.jump_edge },
      { steps: 120, flags: fwd | F.left, yawDeg: 200 },
      { steps: 30, flags: fwd, press: F.glide_toggle },
      { steps: 200, flags: fwd | F.right, press: F.glide_toggle },
      { steps: 300, flags: fwd, press: F.jump_edge },
    ],
  },
  {
    name: 'glide_updraft',
    doc: 'Glide off the peak into a debug updraft column (lift 6 m/s): rise above the takeoff, then leave the column and sink again.',
    start: peak,
    raining: false,
    updrafts: [{ x: 1122, z: 2335, radius: 10, top: 380, lift: 6 }],
    segments: [
      { steps: 90, flags: fwd | F.sprint },
      { steps: 24, flags: fwd, press: F.jump | F.jump_edge },
      { steps: 30, flags: fwd, press: F.jump_edge },
      { steps: 60, flags: fwd, press: F.jump_edge },
      { steps: 240, flags: 0 },
      { steps: 300, flags: fwd },
    ],
  },
  {
    name: 'swim',
    doc: 'Walk into the lake (swim at 1.5 m depth), swim out, turn and swim back, walk out and regenerate; then swim for the deep middle until the wheel is empty, drown and respawn at the shore.',
    start: shore,
    raining: false,
    updrafts: [],
    segments: [
      { steps: 20, flags: 0 },
      { steps: 400, flags: fwd },
      { steps: 300, flags: fwd, yawDeg: 0 },
      { steps: 150, flags: 0 },
      { steps: 1250, flags: fwd, yawDeg: 180 },
      { steps: 60, flags: 0 },
    ],
  },
  {
    name: 'slope',
    doc: 'Start exhausted at the foot of the 110 m cliff: walking into it is blocked, walking diagonally slides along it, standing regenerates (1 s delay), then the full wheel lets the same input grab and climb; hang (no drain), climb back down to the foot and settle.',
    start: { x: 1113.5, z: 2399.7, yawDeg: -23 },
    initial: { stamina: 0, flags: MoveFlag.exhausted },
    raining: false,
    updrafts: [],
    segments: [
      { steps: 90, flags: fwd },
      { steps: 60, flags: fwd | F.left },
      { steps: 200, flags: 0 },
      { steps: 120, flags: fwd },
      { steps: 60, flags: 0 },
      { steps: 150, flags: F.back },
      { steps: 60, flags: 0 },
    ],
  },
  {
    name: 'tower',
    doc: 'WP12 tower on the combined ground (terrain + structure overlay): walk into the 80 degree lower wall, climb it, rest on the ledge until the wheel is full, climb the upper wall, mantle onto the top, then run off the far edge, jump, double jump, open the glider and glide away east, steer, close with G and fall to the ground.',
    start: tower,
    towers: true,
    climbTo: { x: 1888, z: 1760 },
    raining: false,
    updrafts: [],
    segments: [
      { steps: 40, flags: fwd },
      { steps: 20, flags: fwd, press: F.jump | F.jump_edge },
      { steps: 25, flags: fwd, press: F.jump_edge },
      { steps: 360, flags: fwd, press: F.jump_edge },
      { steps: 120, flags: fwd | F.left },
      { steps: 240, flags: fwd, press: F.glide_toggle },
    ],
  },
  {
    name: 'stamina',
    doc: 'Sprint on the spawn meadow until the wheel is empty (exhausted: walking speed), keep holding sprint, stop: regen starts after 1 s and runs to full.',
    start: { x: 1920, z: 2272, yawDeg: 30 },
    raining: false,
    updrafts: [],
    segments: [
      { steps: 600, flags: fwd | F.sprint },
      { steps: 60, flags: fwd | F.sprint, yawDeg: 120 },
      { steps: 240, flags: 0 },
    ],
  },
];

export function toRow12(s: MoveState): Row12 {
  return [s.pos.x, s.pos.y, s.pos.z, s.vel.x, s.vel.y, s.vel.z, s.airJumps, s.mode, s.stamina, s.timer, s.lunge, s.flags];
}

/**
 * TS twin of movement.PlanClimb (server/pkg/movement/plan.go): hold forward,
 * and whenever a climb tops out on walkable ground, rest until the wheel is
 * full; stop when done(state). Returns the flags per step.
 */
export function planClimb(s: MoveState, yawU16: number, ground: GroundQuery, done: (s: MoveState) => boolean, maxSteps: number): { flags: number[]; end: MoveState } {
  const flags: number[] = [];
  let resting = false;
  while (flags.length < maxSteps && !done(s)) {
    const f = resting ? 0 : F.forward;
    const next = stepMovement(s, { flags: f, yaw: yawU16, pitch: 0 }, ground, STEP_DT);
    if (!resting && s.mode === MoveMode.climb && next.mode === MoveMode.ground) resting = true;
    else if (resting && next.stamina >= next.staminaMax) resting = false;
    flags.push(f);
    s = next;
  }
  return { flags, end: s };
}

/** The ground a scenario runs on: plain terrain, or terrain + WP12 towers. */
export function scenarioGround(sc: Wp10Scenario, terrain: WorldgenGround): GroundQuery {
  return sc.towers ? new StructureGround(terrain, towersFromAtlas(terrain.atlas.data, terrain).overlay) : terrain;
}

export function framesOf(sc: Wp10Scenario, ground?: GroundQuery): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  let yaw = yawToU16((sc.start.yawDeg * Math.PI) / 180);
  let seq = 1;
  if (sc.climbTo) {
    if (!ground) throw new Error(`${sc.name}: planning a climb needs the ground`);
    const goal = sc.climbTo;
    const top = ground.heightAt(goal.x, goal.z);
    const fx = -Math.sin((sc.start.yawDeg * Math.PI) / 180);
    const fz = -Math.cos((sc.start.yawDeg * Math.PI) / 180);
    const startState = initialWp10(sc, ground);
    const reached = (s: MoveState) => s.pos.y >= top - 1e-6 && (s.pos.x - goal.x) * fx + (s.pos.z - goal.z) * fz >= 0;
    const { flags, end } = planClimb(startState, yaw, ground, reached, 6000);
    if (!reached(end)) throw new Error(`${sc.name}: the planned climb does not reach the top (${JSON.stringify(end.pos)}, top ${top})`);
    for (const f of flags) out.push([seq++, f, yaw, 0]);
  }
  for (const seg of sc.segments) {
    if (seg.yawDeg !== undefined) yaw = yawToU16((seg.yawDeg * Math.PI) / 180);
    for (let i = 0; i < seg.steps; i++) out.push([seq++, seg.flags | (i === 0 ? (seg.press ?? 0) : 0), yaw, 0]);
  }
  return out;
}

export function initialWp10(sc: Wp10Scenario, ground: GroundQuery): MoveState {
  const s = newMoveState({ x: sc.start.x, y: ground.heightAt(sc.start.x, sc.start.z), z: sc.start.z });
  return { ...s, ...sc.initial };
}

export function envOf(sc: Wp10Scenario): StepEnv {
  return { raining: sc.raining, updraft: sc.updrafts.length ? new UpdraftColumns(sc.updrafts) : null };
}

export function runWp10(sc: Wp10Scenario, ground: GroundQuery, genVersion: number): Wp10Golden {
  let s = initialWp10(sc, ground);
  const initial = toRow12(s);
  const env = envOf(sc);
  const frames = framesOf(sc, ground);
  const states: Row12[] = [];
  for (const f of frames) {
    s = stepMovement(s, { flags: f[1], yaw: f[2], pitch: f[3] }, ground, STEP_DT, env);
    states.push(toRow12(s));
  }
  return {
    format: 'lodestone-movement-golden',
    version: 2,
    doc: `${sc.doc} Generated by client/src/sim/golden/generate.ts on worldgen.wasm (collision_height, water_height). Replay: start at \`initial\` (staminaMax in fine units), apply each frame with dt and env, compare to states[i]. Row: [x,y,z,vx,vy,vz,airJumps,mode,stamina,timer,lunge,flags]. See client/src/sim/README.md.`,
    scenario: sc.name,
    dt: STEP_DT,
    ground: sc.towers ? { kind: 'worldgen', seed: WP10_SEED, genVersion, structures: 'towers' } : { kind: 'worldgen', seed: WP10_SEED, genVersion },
    env: { raining: sc.raining, updrafts: sc.updrafts.map((c) => [c.x, c.z, c.radius, c.top, c.lift]) },
    staminaMax: s.staminaMax,
    initial,
    frames,
    states,
  };
}

/** Per-mode step counts and the transitions, for the generator's log and the evidence file. */
export function summarize(g: Wp10Golden): string {
  const names = ['ground', 'air', 'climb', 'glide', 'swim'];
  const counts: Record<string, number> = {};
  const trans: string[] = [];
  let last = g.initial[7];
  g.states.forEach((r, i) => {
    counts[names[r[7]]] = (counts[names[r[7]]] ?? 0) + 1;
    if (r[7] !== last) trans.push(`${i + 1}:${names[last]}->${names[r[7]]}@(${r[0].toFixed(1)},${r[1].toFixed(1)},${r[2].toFixed(1)})`);
    last = r[7];
  });
  const end = g.states[g.states.length - 1];
  return `${g.scenario}: ${g.states.length} steps, modes ${JSON.stringify(counts)}, end stamina ${(end[8] / 60).toFixed(1)} flags ${end[11]}\n  ${trans.join(' ')}`;
}
