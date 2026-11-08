// WP10 movement: unit tests of each traversal rule on synthetic grounds
// (exact, fast), the shared weather/updraft/wire helpers, and the regression
// check of the terrain goldens (real generated world through worldgen.wasm;
// skipped when the wasm is not built, like the worldgen tests).
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CLIMB_MAX_SLOPE_DEG,
  CLIMB_MAX_TAN_SQ,
  CLIMB_SPEED,
  GLIDE_SINK_SPEED,
  GLIDE_SPEED,
  InputFlag as F,
  MoveMode,
  STAMINA_MAX,
  SWIM_FLOAT_DEPTH_M,
  SWIM_SPEED,
  WALKABLE_SLOPE_DEG,
  WALKABLE_TAN_SQ,
  yawToU16,
} from '@lodestone/contracts';
import { FlatGround, type GroundQuery } from './ground';
import {
  CLIMB_JUMP_COST,
  DRAIN_SPRINT,
  DROWN_STEPS,
  FINE,
  findShore,
  MoveFlag,
  newMoveState,
  REGEN_DELAY_STEPS,
  slopeAt,
  stepMovement,
  STEP_DT,
  type MoveState,
  type StepEnv,
} from './movement';
import { fromSelf, packFlags, packMoveExt, selfFields } from './moveWire';
import { parseUpdrafts, UpdraftColumns } from './updraft';
import { isRaining, weatherHash } from './weather';
import { goldenPath, wasmPath } from './golden/io';
import { runWp10, WP10_SCENARIOS, WP10_SEED, type Wp10Golden } from './golden/wp10';
import { loadWorldgenGround } from './worldgenGround';

/** Yaw (u16) whose forward is -x (west): forward = (-sin, -cos) = (-1, 0). */
const WEST = yawToU16(Math.PI / 2);
const inp = (flags: number, yaw = WEST) => ({ flags, yaw, pitch: 0 });
const DRY: StepEnv = { raining: false, updraft: null };
const WET: StepEnv = { raining: true, updraft: null };

/**
 * Flat floor at 0 for x > 10, a wall rising westward for x < 10 at the given
 * slope (rise per meter), capped at `top`, then flat on top. Optional water.
 */
class WallGround implements GroundQuery {
  constructor(
    readonly grade: number,
    readonly top = 20,
    readonly water = -Infinity,
  ) {}
  heightAt(x: number): number {
    return x >= 10 ? 0 : Math.min(this.top, (10 - x) * this.grade);
  }
  waterAt(): number {
    return this.water;
  }
}

function run(s: MoveState, n: number, flags: number, g: GroundQuery, env = DRY, yaw = WEST): MoveState {
  for (let i = 0; i < n; i++) s = stepMovement(s, inp(flags, yaw), g, STEP_DT, env);
  return s;
}

describe('slope thresholds', () => {
  it('the *_TAN_SQ literals are tan(deg)^2 of the degree constants', () => {
    expect(WALKABLE_TAN_SQ).toBeCloseTo(Math.tan((WALKABLE_SLOPE_DEG * Math.PI) / 180) ** 2, 12);
    expect(CLIMB_MAX_TAN_SQ / Math.tan((CLIMB_MAX_SLOPE_DEG * Math.PI) / 180) ** 2).toBeCloseTo(1, 12);
  });
  it('slopeAt measures rise per meter from heightAt alone', () => {
    const s = slopeAt(new WallGround(2), 5, 0);
    expect(s.gx).toBe(-2);
    expect(s.gz).toBe(0);
    expect(s.t2).toBe(4);
  });
});

describe('walk on slopes (deferred from WP07)', () => {
  it('walks up walkable slopes (45 deg) like before', () => {
    const g = new WallGround(1);
    const s = run(newMoveState({ x: 11, y: 0, z: 0 }), 240, F.forward, g);
    expect(s.mode).toBe(MoveMode.ground);
    expect(s.pos.x).toBeLessThan(5);
    expect(s.pos.y).toBe(g.heightAt(s.pos.x));
  });

  it('a steep wall blocks walking when the wheel is empty, and does not slide you up', () => {
    const g = new WallGround(3); // 71.6 deg
    const s0 = { ...newMoveState({ x: 11, y: 0, z: 0 }), stamina: 0, flags: MoveFlag.exhausted };
    const s = run(s0, 120, F.forward, g);
    expect(s.mode).toBe(MoveMode.ground);
    expect(s.pos.y).toBeLessThan(0.5); // never walked up the wall
    expect(s.pos.x).toBeGreaterThan(9.8);
  });

  it('moving diagonally into a wall keeps the along-wall part', () => {
    const g = new WallGround(3);
    const s0 = { ...newMoveState({ x: 10.5, y: 0, z: 0 }), stamina: 0, flags: MoveFlag.exhausted };
    const s = run(s0, 120, F.forward | F.left, g); // forward = -x, left = +z for yaw west
    expect(s.pos.z).toBeGreaterThan(3);
    expect(s.pos.y).toBeLessThan(0.5);
  });

  it('standing on a steep slope slides down it, capped, and stops on the flat', () => {
    const g = new WallGround(2, 40);
    let s = newMoveState({ x: 2, y: g.heightAt(2), z: 0 });
    s = stepMovement(s, inp(0), g);
    expect(s.flags & MoveFlag.sliding).toBe(MoveFlag.sliding);
    s = run(s, 300, 0, g);
    expect(s.pos.x).toBeGreaterThan(10);
    expect(s.pos.y).toBe(0);
    expect(Math.hypot(s.vel.x, s.vel.z)).toBe(0);
  });

  it('no jumping off a slide', () => {
    const g = new WallGround(2, 40);
    const s = stepMovement(newMoveState({ x: 2, y: g.heightAt(2), z: 0 }), inp(F.jump | F.jump_edge), g);
    expect(s.vel.y).toBeLessThanOrEqual(0);
  });

  it('step-up: a short steep lip below MAX_STEP_UP_M is walked over', () => {
    // 0.5 m lip that rises over 0.25 m (63 deg), flat on both sides.
    const lip: GroundQuery = { heightAt: (x) => (x >= 10 ? 0 : x <= 9.75 ? 0.5 : (10 - x) * 2) };
    const s0 = { ...newMoveState({ x: 11, y: 0, z: 0 }), stamina: 0, flags: MoveFlag.exhausted };
    const s = run(s0, 120, F.forward, lip);
    expect(s.pos.x).toBeLessThan(8);
    expect(s.pos.y).toBe(0.5);
  });
});

describe('climb', () => {
  const wall = new WallGround(3, 6); // 71.6 deg, 6 m tall

  it('holding forward into a climbable wall grabs it and climbs at CLIMB_SPEED along the surface', () => {
    let s = run(newMoveState({ x: 10.3, y: 0, z: 0 }), 30, F.forward, wall);
    expect(s.mode).toBe(MoveMode.climb);
    s = run(s, 30, F.forward, wall); // off the foot: the slope probe straddles the kink there
    const a = s;
    s = run(s, 60, F.forward, wall);
    const surf = Math.hypot(s.pos.x - a.pos.x, s.pos.y - a.pos.y, s.pos.z - a.pos.z);
    expect(surf).toBeCloseTo(CLIMB_SPEED, 6);
    expect(s.stamina).toBe(a.stamina - 60 * 10); // 10/s for 1 s, in fine units
  });

  it('hanging still costs nothing; left/right traverse along the contour', () => {
    let s = run(newMoveState({ x: 10.3, y: 0, z: 0 }), 90, F.forward, wall);
    const st = s.stamina;
    s = run(s, 60, 0, wall);
    expect(s.stamina).toBe(st);
    const y = s.pos.y;
    s = run(s, 60, F.right, wall);
    expect(s.pos.y).toBeCloseTo(y, 9);
    expect(Math.abs(s.pos.z)).toBeCloseTo(CLIMB_SPEED, 6);
  });

  it('mantles onto the top with a forward push', () => {
    const s = run(newMoveState({ x: 10.3, y: 0, z: 0 }), 600, F.forward, wall);
    expect(s.mode).toBe(MoveMode.ground);
    expect(s.pos.y).toBe(6);
    expect(s.pos.x).toBeLessThan(8);
  });

  it('climb-jump lunge costs CLIMB_JUMP_STAMINA and covers ~2 m up the wall', () => {
    let s = run(newMoveState({ x: 10.3, y: 0, z: 0 }), 60, F.forward, new WallGround(3, 40));
    const a = s;
    s = stepMovement(s, inp(F.jump | F.jump_edge), new WallGround(3, 40));
    expect(a.stamina - s.stamina).toBe(CLIMB_JUMP_COST);
    s = run(s, 14, 0, new WallGround(3, 40));
    const surf = Math.hypot(s.pos.x - a.pos.x, s.pos.y - a.pos.y);
    expect(surf).toBeCloseTo(2, 6);
    expect(s.lunge).toBe(0);
  });

  it('jump + back kicks off the wall', () => {
    let s = run(newMoveState({ x: 10.3, y: 0, z: 0 }), 90, F.forward, wall);
    s = stepMovement(s, inp(F.back | F.jump | F.jump_edge), wall);
    expect(s.mode).toBe(MoveMode.air);
    expect(s.vel.x).toBeGreaterThan(0);
    expect(s.vel.y).toBeGreaterThan(0);
  });

  it('rain halves climb speed and slips you back every few seconds', () => {
    const tall = new WallGround(3, 100);
    const grab = run(newMoveState({ x: 10.3, y: 0, z: 0 }), 60, F.forward, tall);
    const dry = run(grab, 60, F.forward, tall, DRY); // timer ~55..115: before the first slip window (150..179)
    const wet = run(grab, 60, F.forward, tall, WET);
    expect(wet.pos.y - grab.pos.y).toBeCloseTo((dry.pos.y - grab.pos.y) / 2, 6);
    // Over a full 3 s period the slip (0.5 s at 3 m/s down) eats into the progress.
    let s = grab;
    let lowest = Infinity;
    const ys: number[] = [];
    for (let i = 0; i < 180; i++) {
      s = stepMovement(s, inp(F.forward), tall, STEP_DT, WET);
      ys.push(s.pos.y);
      lowest = Math.min(lowest, s.pos.y);
    }
    const descents = ys.slice(1).filter((y, i) => y < ys[i]).length;
    expect(descents).toBe(30);
  });

  it('an empty wheel lets go (slides down)', () => {
    let s = run(newMoveState({ x: 10.3, y: 0, z: 0 }), 30, F.forward, new WallGround(3, 100));
    s = { ...s, stamina: 5 };
    s = run(s, 3, F.forward, new WallGround(3, 100));
    expect(s.flags & MoveFlag.exhausted).toBe(MoveFlag.exhausted);
    expect(s.mode).not.toBe(MoveMode.climb);
  });
});

describe('glide', () => {
  const high = new FlatGround(0);
  const falling = (): MoveState => ({ ...newMoveState({ x: 0, y: 50, z: 0 }), mode: MoveMode.air, vel: { x: 0, y: -3, z: 0 }, airJumps: 1 });

  it('a jump press while falling more than GLIDE_MIN_FALL_M opens the glider; glide_toggle opens it without the double jump', () => {
    expect(stepMovement(falling(), inp(F.jump_edge), high).mode).toBe(MoveMode.glide);
    const fresh = { ...falling(), airJumps: 0 };
    expect(stepMovement(fresh, inp(F.jump_edge), high).mode).toBe(MoveMode.air); // double jump first
    expect(stepMovement(fresh, inp(F.glide_toggle), high).mode).toBe(MoveMode.glide);
    // Too low, or rising: no glider.
    expect(stepMovement({ ...falling(), pos: { x: 0, y: 1, z: 0 } }, inp(F.jump_edge), high).mode).not.toBe(MoveMode.glide);
    expect(stepMovement({ ...falling(), vel: { x: 0, y: 3, z: 0 } }, inp(F.jump_edge), high).mode).toBe(MoveMode.air);
  });

  it('sinks at GLIDE_SINK_SPEED, flies at GLIDE_SPEED where steered, drains and closes on a press', () => {
    let s = stepMovement(falling(), inp(F.jump_edge), high);
    s = run(s, 120, F.forward, high);
    expect(s.mode).toBe(MoveMode.glide);
    expect(s.vel.y).toBe(-GLIDE_SINK_SPEED);
    expect(Math.hypot(s.vel.x, s.vel.z)).toBeCloseTo(GLIDE_SPEED, 9);
    expect(s.vel.x).toBeLessThan(0); // west
    expect(s.stamina).toBe(STAMINA_MAX * FINE - 120 * 6);
    s = stepMovement(s, inp(F.jump_edge), high);
    expect(s.mode).toBe(MoveMode.air);
    expect(s.airJumps).toBe(1); // closing never grants a double jump
  });

  it('rides an updraft column up to its top', () => {
    const env: StepEnv = { raining: false, updraft: new UpdraftColumns([{ x: 0, z: 0, radius: 5, top: 60, lift: 6 }]) };
    let s = stepMovement(falling(), inp(F.jump_edge), high, STEP_DT, env);
    s = run(s, 600, 0, high, env);
    expect(s.pos.y).toBeGreaterThan(59);
    expect(s.pos.y).toBeLessThan(61);
  });

  it('lands on contact', () => {
    let s = stepMovement({ ...falling(), pos: { x: 0, y: 3, z: 0 } }, inp(F.jump_edge), high);
    s = run(s, 200, F.forward, high);
    expect(s.mode).toBe(MoveMode.ground);
    expect(s.pos.y).toBe(0);
  });
});

describe('swim', () => {
  // Floor 3 m below a water surface at 0 for x < 10, then a shallow shelf at
  // -1 (water 1 m deep: walked) that a floating swimmer (feet at -1.4) can
  // step onto, then dry land at +0.5 from x = 14.
  const lake: GroundQuery = { heightAt: (x) => (x < 10 ? -3 : x < 14 ? -1 : 0.5), waterAt: () => 0 };

  it('floats at the surface, swims at SWIM_SPEED, walks out on the beach', () => {
    let s = run({ ...newMoveState({ x: 5, y: -3, z: 0 }) }, 1, 0, lake);
    expect(s.mode).toBe(MoveMode.swim);
    expect(s.pos.y).toBe(-SWIM_FLOAT_DEPTH_M);
    s = run(s, 150, F.forward, lake, DRY, yawToU16(-Math.PI / 2)); // east
    expect(s.mode).toBe(MoveMode.ground);
    expect(s.pos.x).toBeGreaterThan(10);
  });

  it('a bank higher than a step is a wall: climbed when holding into it, else it stops you', () => {
    const cliffLake: GroundQuery = { heightAt: (x) => (x < 10 ? -3 : 3), waterAt: () => 0 };
    const east = yawToU16(-Math.PI / 2);
    const floating = run(newMoveState({ x: 8, y: -3, z: 0 }), 1, 0, cliffLake);
    const blocked = run(floating, 120, F.right, cliffLake, DRY, yawToU16(0)); // strafe east, not "into" it
    expect(blocked.mode).toBe(MoveMode.swim);
    expect(blocked.pos.x).toBeLessThan(10);
    const climbed = run(floating, 60, F.forward, cliffLake, DRY, east);
    expect(climbed.mode).toBe(MoveMode.climb);
  });

  it('drains always, drowns at zero and respawns at the nearest shore with a full wheel', () => {
    let s = run(newMoveState({ x: 5, y: -3, z: 0 }), 1, 0, lake);
    s = { ...s, stamina: 16 };
    s = run(s, 2, 0, lake);
    expect(s.flags & MoveFlag.drowned).toBe(MoveFlag.drowned);
    s = run(s, DROWN_STEPS - 1, F.forward, lake);
    expect(s.mode).toBe(MoveMode.swim);
    s = run(s, 1, 0, lake);
    expect(s.mode).toBe(MoveMode.ground);
    expect(s.pos).toEqual({ x: 15, y: 0.5, z: 0 }); // ring at 10 m, east (the shelf is still wet)
    expect(s.stamina).toBe(s.staminaMax);
    expect(s.flags).toBe(0);
    expect(findShore(lake, 5, 0)).toEqual({ x: 15, y: 0.5, z: 0 });
  });

  it('SWIM_SPEED is the steady swim speed', () => {
    let s = run(newMoveState({ x: 5, y: -3, z: 0 }), 1, 0, lake);
    s = run(s, 60, F.forward, lake, DRY, yawToU16(0)); // north (-z), stays in water
    expect(Math.hypot(s.vel.x, s.vel.z)).toBeCloseTo(SWIM_SPEED, 9);
  });
});

describe('stamina wheel', () => {
  const flat = new FlatGround(0);
  it('sprint drains, empty = exhausted (no sprint), regen after the delay, cleared when full', () => {
    let s = run(newMoveState({ x: 0, y: 0, z: 0 }), 60, F.forward | F.sprint, flat);
    expect(s.stamina).toBe(STAMINA_MAX * FINE - 60 * DRAIN_SPRINT);
    s = run(s, 440, F.forward | F.sprint, flat); // 500 steps x 12 = the whole wheel
    expect(s.stamina).toBe(0);
    expect(s.flags & MoveFlag.exhausted).toBe(MoveFlag.exhausted);
    s = run(s, 40, F.forward | F.sprint, flat); // sprint held, but exhausted: walking
    expect(Math.hypot(s.vel.x, s.vel.z)).toBeLessThan(5.2);
    expect(s.stamina).toBe(0); // walking counts toward the 1 s delay...
    s = run(s, REGEN_DELAY_STEPS - 41, 0, flat);
    expect(s.stamina).toBe(0);
    s = run(s, 1, 0, flat);
    expect(s.stamina).toBeGreaterThan(0);
    s = run(s, 300, 0, flat);
    expect(s.stamina).toBe(s.staminaMax);
    expect(s.flags).toBe(0);
  });
});

describe('shared helpers', () => {
  it('weather stub vectors (same table in server/pkg/weather/weather_test.go)', () => {
    expect(weatherHash(20261108n, 0)).toBe(weatherHash(20261108n, 0));
    const vec = [0, 1, 2, 3, 2946000, -1].map((w) => weatherHash(20261108n, w));
    expect(vec).toEqual([689418537, 1815390235, 4091472293, 4141916889, 2727198801, 3880554713]);
    expect(isRaining(20261108n, 0)).toBe(false); // 689418537 % 100 = 37
    expect(isRaining(20261108n, 600 * 2946000)).toBe(true); // 2727198801 % 100 = 1
    // About a quarter of windows rain.
    let wet = 0;
    for (let w = 0; w < 4000; w++) if (isRaining(7n, w * 600)) wet++;
    expect(wet / 4000).toBeGreaterThan(0.2);
    expect(wet / 4000).toBeLessThan(0.3);
  });

  it('updraft spec parsing and lift', () => {
    const cols = parseUpdrafts('10,20,5,100,6; bad; 1,2,3,4');
    expect(cols).toEqual([{ x: 10, z: 20, radius: 5, top: 100, lift: 6 }]);
    const u = new UpdraftColumns(cols);
    expect(u.liftAt(12, 50, 21)).toBe(6);
    expect(u.liftAt(12, 101, 21)).toBe(0);
    expect(u.liftAt(16, 50, 20)).toBe(0);
  });

  it('SelfState packing round-trips the whole movement state', () => {
    const s: MoveState = { ...newMoveState({ x: 12.34, y: 5.67, z: -8.9 }), mode: MoveMode.climb, stamina: 4321, timer: 177, lunge: 9, flags: MoveFlag.sliding };
    const f = { x: 1234, y: 567, z: -890, vx: 0, vy: 0, vz: 0, ...selfFields(s) };
    expect(f.flags).toBe(packFlags(s));
    expect(f.moveExt).toBe(packMoveExt(s));
    expect(f.activity).toBe(1);
    expect(fromSelf(f)).toEqual(s);
  });
});

const haveWasm = existsSync(wasmPath);
describe.skipIf(!haveWasm)('WP10 terrain goldens (worldgen.wasm, seed 20261108)', async () => {
  const ground = haveWasm ? await loadWorldgenGround(readFileSync(wasmPath), WP10_SEED) : null;
  for (const sc of WP10_SCENARIOS) {
    it(`${sc.name}: stepMovement reproduces the committed golden bit-exactly`, () => {
      const file = JSON.parse(readFileSync(goldenPath(`wp10_${sc.name}`), 'utf8')) as Wp10Golden;
      const fresh = runWp10(sc, ground!, ground!.wg.genVersion);
      expect(file.frames).toEqual(fresh.frames);
      expect(file.initial).toEqual(fresh.initial);
      for (let i = 0; i < fresh.states.length; i++) {
        if (file.states[i].some((v, k) => v !== fresh.states[i][k])) {
          throw new Error(`step ${i + 1} differs: golden ${JSON.stringify(file.states[i])} vs now ${JSON.stringify(fresh.states[i])}. If intended, run \`npm run golden -w client\` and check the Go replay.`);
        }
      }
    });
  }
});
