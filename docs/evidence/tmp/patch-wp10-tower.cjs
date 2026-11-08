const fs = require('fs');
function patch(p, pairs) {
  let s = fs.readFileSync(p, 'utf8');
  for (const [a, b] of pairs) {
    if (!s.includes(a)) throw new Error(p + ' missing ' + a.slice(0, 70));
    s = s.replace(a, b);
  }
  fs.writeFileSync(p, s);
}
patch('client/src/sim/golden/wp10.ts', [
  [`import { UpdraftColumns, type UpdraftColumn } from '../updraft';`, `import { UpdraftColumns, type UpdraftColumn } from '../updraft';
import { StructureGround } from '../../world/structures/overlay';
import { towersFromAtlas } from '../../world/structures/towers';
import type { WorldgenGround } from '../worldgenGround';`],
  [`export interface Wp10Scenario {
  name: string;
  doc: string;`, `export interface Wp10Scenario {
  name: string;
  doc: string;
  /** Run on terrain + WP12's tower overlay (the ground the game and zone use since WP12). */
  towers?: boolean;
  /**
   * Prefix the segments with a planned climb (planClimb: hold forward, rest
   * on each ledge a climb tops out on until the wheel is full) that ends at
   * this point on the top of the tower nearest to it.
   */
  climbTo?: { x: number; z: number };`],
  [`  ground: { kind: 'worldgen'; seed: string; genVersion: number };`, `  ground: { kind: 'worldgen'; seed: string; genVersion: number; structures?: 'towers' };`],
  [`const shore = { x: 1418, z: 1858, yawDeg: 180 }; // dry shore south of the lake, facing north (+z, into it)`, `const shore = { x: 1418, z: 1858, yawDeg: 180 }; // dry shore south of the lake, facing north (+z, into it)
// WP12 tower at atlas site (1888, 1760), 513 m from the spawn settlement:
// start 14 m west of its axis, facing east (yaw -90: forward = +x).
const tower = { x: 1874, z: 1760, yawDeg: -90 };`],
  [`  {
    name: 'stamina',`, `  {
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
    name: 'stamina',`],
  [`export function framesOf(sc: Wp10Scenario): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  let yaw = yawToU16((sc.start.yawDeg * Math.PI) / 180);
  let seq = 1;`, `/**
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
    if (!ground) throw new Error(\`\${sc.name}: planning a climb needs the ground\`);
    const goal = sc.climbTo;
    const top = ground.heightAt(goal.x, goal.z);
    const fx = -Math.sin((sc.start.yawDeg * Math.PI) / 180);
    const fz = -Math.cos((sc.start.yawDeg * Math.PI) / 180);
    const startState = initialWp10(sc, ground);
    const reached = (s: MoveState) => s.pos.y >= top - 1e-6 && (s.pos.x - goal.x) * fx + (s.pos.z - goal.z) * fz >= 0;
    const { flags, end } = planClimb(startState, yaw, ground, reached, 6000);
    if (!reached(end)) throw new Error(\`\${sc.name}: the planned climb does not reach the top (\${JSON.stringify(end.pos)}, top \${top})\`);
    for (const f of flags) out.push([seq++, f, yaw, 0]);
  }`],
  [`  const frames = framesOf(sc);`, `  const frames = framesOf(sc, ground);`],
  [`    ground: { kind: 'worldgen', seed: WP10_SEED, genVersion },`, `    ground: sc.towers ? { kind: 'worldgen', seed: WP10_SEED, genVersion, structures: 'towers' } : { kind: 'worldgen', seed: WP10_SEED, genVersion },`],
  [`import { MoveFlag, newMoveState, stepMovement, STEP_DT, type MoveState, type StepEnv } from '../movement';`, `import { MoveMode } from '@lodestone/contracts';
import { MoveFlag, newMoveState, stepMovement, STEP_DT, type MoveState, type StepEnv } from '../movement';`],
]);
patch('client/src/sim/golden/generate.ts', [
  [`import { runWp10, summarize, WP10_SCENARIOS, WP10_SEED } from './wp10';`, `import { runWp10, scenarioGround, summarize, WP10_SCENARIOS, WP10_SEED } from './wp10';`],
  [`    const g = runWp10(sc, ground, ground.wg.genVersion);`, `    const g = runWp10(sc, scenarioGround(sc, ground), ground.wg.genVersion);`],
]);
patch('client/src/sim/traversal.test.ts', [
  [`import { runWp10, WP10_SCENARIOS, WP10_SEED, type Wp10Golden } from './golden/wp10';`, `import { runWp10, scenarioGround, WP10_SCENARIOS, WP10_SEED, type Wp10Golden } from './golden/wp10';`],
  [`      const fresh = runWp10(sc, ground!, ground!.wg.genVersion);`, `      const fresh = runWp10(sc, scenarioGround(sc, ground!), ground!.wg.genVersion);`],
]);
console.log('ok');
