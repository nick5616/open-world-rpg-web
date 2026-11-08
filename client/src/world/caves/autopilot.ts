// Scripted walker for caves (WP09 acceptance: "walk from a mouth to the
// deepest chamber"). Pure TS, no three.js: the golden cave trajectory, the
// headless browser walk and the Go zone test drive it (or replay its
// frames). It follows the cave graph, which doubles as the nav graph: start
// on the hillside in front of the mouth, down the entry ramp, then tunnel by
// tunnel along the parent chain to the deepest chamber.
//
// Steering is deliberately dumb (walk at the next waypoint, hop when stuck):
// the point is to prove the generated geometry is walkable with the real
// movement step, not to be a good pathfinder.

import { InputFlag, yawToU16 } from '@lodestone/contracts';
import type { CaveGraph } from '@lodestone/worldgen';
import type { MoveInput, MoveState } from '../../sim/movement';

export interface Waypoint {
  x: number;
  y: number;
  z: number;
  /** Chamber index (global) reached at this waypoint, or -1. */
  chamber: number;
}

/** Route from in front of system `si`'s mouth to its deepest chamber. */
export function caveRoute(g: CaveGraph, si: number): { start: { x: number; z: number }; points: Waypoint[] } {
  const s = g.systems[si];
  const o = g.openings[s.firstOpening];
  const entry = g.tunnels[s.firstTunnel];
  const p = entry.pts;
  // Start a few meters further out than the ramp's outer end, along the ramp.
  const dx = p[0] - p[3];
  const dz = p[2] - p[5];
  const dl = Math.hypot(dx, dz) || 1;
  const start = { x: p[0] + (dx / dl) * 6, z: p[2] + (dz / dl) * 6 };
  const points: Waypoint[] = [{ x: o.x, y: o.y, z: o.z, chamber: -1 }];
  for (let k = 1; k < 4; k++) points.push({ x: p[k * 3], y: p[k * 3 + 1], z: p[k * 3 + 2], chamber: k === 3 ? s.firstChamber : -1 });
  // Parent chain from the deepest chamber up to the entrance.
  const chain: number[] = [];
  for (let c = s.deepest; c > 0; c = g.chambers[s.firstChamber + c].parent) chain.push(c);
  chain.reverse();
  for (const c of chain) {
    const parent = g.chambers[s.firstChamber + c].parent;
    let t = -1;
    for (let k = 0; k < s.tunnelCount; k++) {
      const tt = g.tunnels[s.firstTunnel + k];
      if (tt.kind !== 0 && tt.kind !== 3 && tt.a === parent && tt.b === c) t = s.firstTunnel + k;
    }
    if (t < 0) throw new Error(`no tunnel ${parent} -> ${c}`);
    const tp = g.tunnels[t].pts;
    for (let k = 1; k < 4; k++) points.push({ x: tp[k * 3], y: tp[k * 3 + 1], z: tp[k * 3 + 2], chamber: k === 3 ? s.firstChamber + c : -1 });
  }
  return { start, points };
}

export class CaveAutopilot {
  next = 0;
  done = false;
  private stuck = 0;
  private lastX = NaN;
  private lastZ = NaN;
  private hop = 0;

  constructor(readonly points: readonly Waypoint[], readonly reach = 1.6) {}

  /** The input for one 1/60 s step from state s. */
  step(s: MoveState): MoveInput {
    let w = this.points[this.next];
    while (!this.done && Math.hypot(w.x - s.pos.x, w.z - s.pos.z) < (this.next === this.points.length - 1 ? 2.5 : this.reach)) {
      if (this.next === this.points.length - 1) this.done = true;
      else w = this.points[++this.next];
    }
    if (this.done) return { flags: 0, yaw: 0, pitch: 0 };
    const yaw = Math.atan2(-(w.x - s.pos.x), -(w.z - s.pos.z));
    let flags = InputFlag.forward;
    // Hop when barely moving for half a second (a lip, a bump in a ravine).
    const moved = Math.hypot(s.pos.x - this.lastX, s.pos.z - this.lastZ);
    this.lastX = s.pos.x;
    this.lastZ = s.pos.z;
    this.stuck = moved < 0.02 ? this.stuck + 1 : 0;
    if (this.stuck > 30 && this.hop === 0) this.hop = 20;
    if (this.hop > 0) {
      if (this.hop === 20) flags |= InputFlag.jump | InputFlag.jump_edge;
      this.hop--;
    }
    return { flags, yaw: yawToU16(yaw), pitch: 0 };
  }
}
