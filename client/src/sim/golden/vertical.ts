// CR 038 golden scenarios: the movement step on the vertical world of the
// official world (seed 20261108): worldgen's VerticalGroundCore over the
// terrain (collision_height, water_height), the wasm layer_height for the
// layers, the descriptor's wind columns as the updraft field. Every place
// comes from the descriptor at generation time and the initial state is
// stored, so the files replay on their own; regenerate after a generator
// change (`npm run golden -w client`). The Go step replays them on
// worldhost (server/pkg/movement/vertical_golden_test.go) within 1e-9 with
// every discrete field exact.

import { InputFlag as F, MoveMode, yawToU16 } from '@lodestone/contracts';
import { inDomain, LAYER_SKY, LAYER_UNDER, parseVertical, terrainBase, VerticalGroundCore, verticalBytes, wasmLayerSource, type VerticalWorld } from '@lodestone/worldgen';
import { VerticalWind } from '../verticalWind';
import { newMoveState, stepMovement, STEP_DT, type MoveState, type StepEnv } from '../movement';
import type { GroundQuery } from '../ground';
import { toRow12, WP10_SEED, type Row12 } from './wp10';
import type { WorldgenGround } from '../worldgenGround';

export interface VerticalGolden {
  format: 'lodestone-movement-golden';
  version: 2;
  doc: string;
  scenario: string;
  dt: number;
  ground: { kind: 'worldgen-vertical'; seed: string; genVersion: number };
  /** The descriptor's wind (../verticalWind.ts: its columns' lift, free gliding in the sky band) is the updraft field. */
  env: { raining: false; verticalUpdrafts: true };
  staminaMax: number;
  initial: Row12;
  frames: [number, number, number, number][];
  states: Row12[];
}

export const VERTICAL_SCENARIOS = ['island_fall', 'lift_glide', 'tunnel_walk', 'cavern_swim', 'cenote_dive'] as const;
export type VerticalScenario = (typeof VERTICAL_SCENARIOS)[number];

export interface VerticalWorldGround {
  v: VerticalWorld;
  ground: VerticalGroundCore;
  env: StepEnv;
}

export function verticalGround(t: WorldgenGround): VerticalWorldGround {
  const v = parseVertical(verticalBytes(t.wg, t.atlas));
  const ground = new VerticalGroundCore(terrainBase(t.wg, t.atlas), v, wasmLayerSource(t.wg, t.atlas));
  return { v, ground, env: { raining: false, updraft: new VerticalWind(v) } };
}

/** Camera-convention yaw (forward = (-sin, -cos)) facing from (x, z) toward (tx, tz). */
const yawTo = (x: number, z: number, tx: number, tz: number) => Math.atan2(-(tx - x), -(tz - z));

/** Steps the scenario, choosing each frame from the state (a scripted driver). */
function drive(start: MoveState, ground: GroundQuery, env: StepEnv, choose: (s: MoveState, i: number) => { flags: number; yaw: number } | null, max: number) {
  let s = start;
  const frames: [number, number, number, number][] = [];
  const states: Row12[] = [];
  for (let i = 0; i < max; i++) {
    const c = choose(s, i);
    if (!c) break;
    const yaw = yawToU16(c.yaw);
    frames.push([i + 1, c.flags, yaw, 0]);
    s = stepMovement(s, { flags: c.flags, yaw, pitch: 0 }, ground, STEP_DT, env);
    states.push(toRow12(s));
  }
  return { frames, states, end: s };
}

function standAt(g: VerticalGroundCore, x: number, y: number, z: number): MoveState {
  return newMoveState({ x, y: g.floorAt(x, y, z), z });
}

export function runVertical(name: VerticalScenario, w: VerticalWorldGround, genVersion: number): VerticalGolden {
  const { v, ground: g, env } = w;
  let start: MoveState;
  let run: ReturnType<typeof drive>;
  let doc: string;
  switch (name) {
    case 'island_fall': {
      const isl = v.islands.find((i) => (i.kind === 0 || i.kind === 1) && i.r > 40)!;
      start = standAt(g, isl.x, isl.top + 5, isl.z);
      if (g.layerAt(start.pos.x, start.pos.y, start.pos.z) !== LAYER_SKY) throw new Error('island_fall: not on the island');
      let off = -1;
      run = drive(start, g, env, (s, i) => {
        if (off < 0 && s.mode === MoveMode.air && s.vel.y < -5) off = i;
        if (off >= 0 && s.mode === MoveMode.ground && i > off + 10) return null;
        return { flags: off < 0 ? F.forward | F.sprint : 0, yaw: -Math.PI / 2 };
      }, 6000);
      if (!run.states.some((r) => r[4] === -54)) throw new Error('island_fall: never reached terminal speed');
      doc = `Sprint east off sky island ${isl.index} (top ${isl.top.toFixed(0)} m) and free-fall onto what is below, reaching TERMINAL_FALL_SPEED (54 m/s).`;
      break;
    }
    case 'lift_glide': {
      const lift = v.updrafts.find((u) => u.kind === 1)!;
      const arch = v.archs[lift.arch];
      const isl = v.islands[arch.firstIsland];
      start = standAt(g, lift.x, lift.bottom + 12, lift.z);
      let phase = 0;
      run = drive(start, g, env, (s, i) => {
        if (phase === 0) {
          phase = 1;
          return { flags: F.jump, yaw: 0 };
        }
        if (phase === 1) {
          // At the apex the double jump (a standing jump tops out at 1 m, under GLIDE_MIN_FALL_M).
          if (s.vel.y <= 0) {
            phase = 15;
            return { flags: F.jump_edge, yaw: 0 };
          }
          return { flags: 0, yaw: 0 };
        }
        if (phase === 15) {
          if (s.vel.y < 0 && s.pos.y - start.pos.y > 1.6) {
            phase = 2;
            return { flags: F.glide_toggle, yaw: 0 };
          }
          return { flags: 0, yaw: 0 };
        }
        if (phase === 2) {
          if (s.pos.y >= lift.top - 1 || i > 4000) phase = 3;
          return { flags: 0, yaw: 0 };
        }
        if (s.mode === MoveMode.ground) return null;
        return { flags: F.forward, yaw: yawTo(s.pos.x, s.pos.z, isl.x, isl.z) };
      }, 12000);
      const e = run.end;
      if (e.mode !== MoveMode.ground || g.layerAt(e.pos.x, e.pos.y, e.pos.z) !== LAYER_SKY) throw new Error(`lift_glide: did not land on the island (${JSON.stringify(e.pos)}, mode ${e.mode})`);
      doc = `Jump, double jump and open the glider in the sky lift at (${lift.x.toFixed(0)}, ${lift.z.toFixed(0)}) (lift ${lift.lift} m/s, no stamina drain), ride it to its top (${lift.top.toFixed(0)} m), glide to archipelago ${lift.arch}'s anchor island and land on its top.`;
      break;
    }
    case 'tunnel_walk': {
      const o = v.surfaceOpenings.find((op) => op.kind === 0)!;
      const r = v.corridors[o.target];
      const pts: [number, number][] = [];
      for (let k = 0; k < r.pts.length / 3; k++) pts.push([r.pts[k * 3], r.pts[k * 3 + 2]]);
      start = standAt(g, pts[0][0], o.y + 2, pts[0][1]);
      let k = 1;
      let jumped = 0;
      run = drive(start, g, env, (s, i) => {
        while (k < pts.length && Math.hypot(pts[k][0] - s.pos.x, pts[k][1] - s.pos.z) < 3) k++;
        if (k >= pts.length) return null;
        const jump = i % 240 === 120 && s.mode === MoveMode.ground ? F.jump : 0;
        if (jump) jumped++;
        return { flags: F.forward | jump, yaw: yawTo(s.pos.x, s.pos.z, pts[k][0], pts[k][1]) };
      }, 40000);
      const e = run.end;
      if (k < pts.length || g.layerAt(e.pos.x, e.pos.y, e.pos.z) !== LAYER_UNDER) throw new Error(`tunnel_walk: stopped at point ${k}/${pts.length} (${JSON.stringify(e.pos)})`);
      doc = `Walk the tunnel from mouth ${v.openings.indexOf(o)} (its downhill rim) down through the hole, the tunnel, the balcony and the ledge ramp to the cavern floor (${pts.length} corridor points), jumping every 4 s.`;
      void jumped;
      break;
    }
    case 'cavern_swim': {
      const c = v.chambers.find((ch) => ch.layer === LAYER_UNDER && ch.lakeE > 0)!;
      // From the lake's middle walk out along +x until dry, then turn round and swim in.
      let sx = c.x;
      let sy = c.floor;
      for (let d = 0; d < c.rx; d += 2) {
        const x = c.x + d;
        const y = g.floorAt(x, c.floor + 3, c.z);
        if (g.waterAtLevel(x, y + 0.1, c.z) < y - 0.2 && g.layerAt(x, y, c.z) === LAYER_UNDER) {
          sx = x + 4;
          sy = y;
          break;
        }
      }
      start = standAt(g, sx, sy + 2, c.z);
      run = drive(start, g, env, () => ({ flags: F.forward, yaw: Math.PI / 2 }), 1500);
      if (!run.states.some((r) => r[7] === MoveMode.swim)) throw new Error('cavern_swim: never swam');
      doc = `Walk west from the dry shore of chamber ${c.index}'s lake into it and swim (the layer's water lattice), until the wheel runs low.`;
      break;
    }
    case 'cenote_dive': {
      const sh = v.shafts[0];
      const rim = sh.r + 4;
      start = standAt(g, sh.x - rim, sh.top + 20, sh.z);
      run = drive(start, g, env, (s, i) => {
        if (s.mode === MoveMode.swim && i > 60) return null;
        return { flags: F.forward, yaw: -Math.PI / 2 };
      }, 3000);
      if (run.end.mode !== MoveMode.swim) throw new Error(`cenote_dive: ended in mode ${run.end.mode} at ${JSON.stringify(run.end.pos)}`);
      doc = `Walk east off the rim of cenote shaft 0 and fall ${(sh.top - sh.bottom).toFixed(0)}+ m into its lake (no fall damage in water).`;
      break;
    }
  }
  void inDomain;
  return {
    format: 'lodestone-movement-golden',
    version: 2,
    doc: `${doc} CR 038. Generated by client/src/sim/golden/generate.ts on worldgen.wasm (VerticalGroundCore over collision_height / water_height, layer_height; the descriptor's updrafts). Row: [x,y,z,vx,vy,vz,airJumps,mode,stamina,timer,lunge,flags].`,
    scenario: name,
    dt: STEP_DT,
    ground: { kind: 'worldgen-vertical', seed: WP10_SEED, genVersion },
    env: { raining: false, verticalUpdrafts: true },
    staminaMax: start.staminaMax,
    initial: toRow12(start),
    frames: run.frames,
    states: run.states,
  };
}

/** Replays a golden's frames from its initial state (the TS regression check). */
export function replayVertical(gd: VerticalGolden, w: VerticalWorldGround): Row12[] {
  const r = gd.initial;
  let s: MoveState = { pos: { x: r[0], y: r[1], z: r[2] }, vel: { x: r[3], y: r[4], z: r[5] }, airJumps: r[6], mode: r[7], stamina: r[8], staminaMax: gd.staminaMax, timer: r[9], lunge: r[10], flags: r[11], dash: 0, iframes: 0 };
  const out: Row12[] = [];
  for (const f of gd.frames) {
    s = stepMovement(s, { flags: f[1], yaw: f[2], pitch: f[3] }, w.ground, STEP_DT, w.env);
    out.push(toRow12(s));
  }
  return out;
}
