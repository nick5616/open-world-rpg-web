// Playtest 2 dev console (CR 032): the two dev cheats that change movement,
// stepped identically here and on the zone (server/zone/internal/game/
// devconsole.go devFrame) so prediction keeps agreeing:
//   - fly: the debug fly step (fly.ts) at FLY_SPEED x the console's speed,
//   - infinite stamina: the wheel refilled (and exhaustion cleared) before
//     each step.
// They ride the step's env (StepEnv.dev), so reconciliation replays with
// what each step used. Only a zone in dev mode turns them on (Event 1400).

import { stepFly } from './fly';
import type { GroundQuery } from './ground';
import { MoveFlag, stepMovement, type MoveInput, type MoveState, type StepEnv } from './movement';

export interface DevMove {
  /** Fly speed multiplier; 0 = not flying. */
  fly: number;
  stamina: boolean;
}

/** What the zone's latest dev status (Event 1400) turned on for this player. */
export const devMove: DevMove = { fly: 0, stamina: false };

/** The env with this step's dev movement attached (unchanged when none is on). */
export function withDevMove<T extends StepEnv>(env: T): T {
  if (devMove.fly <= 0 && !devMove.stamina) return env;
  return { ...env, dev: { fly: devMove.fly, stamina: devMove.stamina } };
}

/** stepMovement, or the dev fly step / a refilled wheel when the env says so. */
export function stepDev(state: MoveState, input: MoveInput, ground: GroundQuery, dt: number, env: Readonly<StepEnv>): MoveState {
  const d = env.dev;
  if (!d) return stepMovement(state, input, ground, dt, env);
  if (d.stamina && state.staminaMax > 0) state = { ...state, stamina: state.staminaMax, flags: state.flags & ~MoveFlag.exhausted };
  return d.fly > 0 ? stepFly(state, input, dt, d.fly) : stepMovement(state, input, ground, dt, env);
}
