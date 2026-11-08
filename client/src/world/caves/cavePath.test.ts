// Golden cave trajectory (WP09): the scripted walker goes from in front of a
// mouth of the default world down to the deepest chamber of its system with
// the real movement step on the cave ground. The frames and sampled states
// are committed (golden/cave_path.json); this test replays them bit for bit,
// and server/pkg/caves/path_test.go replays the same frames with the Go step
// and the Go cave queries: client prediction and the server agree.
//   LODESTONE_UPDATE_CAVE_GOLDEN=1 npx vitest run src/world/caves/cavePath.test.ts   # regenerate
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CaveGroundCore, caveSystemAt, parseCaveGraph, caveGraphBytes, wasmCellSource } from '@lodestone/worldgen';
import { newMoveState, stepMovement, type MoveState } from '../../sim/movement';
import { hasWasm, testWorld } from '../testing/wasm';
import { CaveAutopilot, caveRoute } from './autopilot';

const goldenPath = fileURLToPath(new URL('./golden/cave_path.json', import.meta.url));
const SYSTEM = 0;
const MAX_FRAMES = 60 * 300;
const SAMPLE_EVERY = 30;

interface CavePathGolden {
  seed: string;
  system: number;
  start: [number, number, number];
  /** base64 of u16 LE pairs (flags, yaw) per frame. */
  frames: string;
  frameCount: number;
  /** Every SAMPLE_EVERY frames and the last: f64 bits of pos x,y,z and vel x,y,z, plus airJumps. */
  samples: { frame: number; s: string }[];
  reached: { chamber: number; depth: number; frames: number };
}

function bits(v: number): string {
  const d = new DataView(new ArrayBuffer(8));
  d.setFloat64(0, v, true);
  return d.getBigUint64(0, true).toString(16).padStart(16, '0');
}

function stateKey(s: MoveState): string {
  return [s.pos.x, s.pos.y, s.pos.z, s.vel.x, s.vel.y, s.vel.z].map(bits).join(',') + `,${s.airJumps},${s.mode}`;
}

describe.skipIf(!hasWasm)('cave path: mouth to deepest chamber', () => {
  it('walks there, and the committed trajectory replays bit for bit', async () => {
    const { wg, atlas } = await testWorld();
    const graph = parseCaveGraph(caveGraphBytes(wg, atlas));
    const ground = new CaveGroundCore((x, z) => wg.collisionHeight(atlas, x, z), graph.openings, wasmCellSource(wg, atlas));
    const s = graph.systems[SYSTEM];
    const deepest = graph.chambers[s.firstChamber + s.deepest];

    if (process.env.LODESTONE_UPDATE_CAVE_GOLDEN === '1' || !fs.existsSync(goldenPath)) {
      const route = caveRoute(graph, SYSTEM);
      const pilot = new CaveAutopilot(route.points);
      let st: MoveState = newMoveState({ x: route.start.x, y: wg.collisionHeight(atlas, route.start.x, route.start.z), z: route.start.z });
      const start: [number, number, number] = [st.pos.x, st.pos.y, st.pos.z];
      const frames: number[] = [];
      const samples: CavePathGolden['samples'] = [];
      let n = 0;
      for (; n < MAX_FRAMES && !pilot.done; n++) {
        const inp = pilot.step(st);
        frames.push(inp.flags, inp.yaw);
        st = stepMovement(st, inp, ground);
        if ((n + 1) % SAMPLE_EVERY === 0) samples.push({ frame: n + 1, s: stateKey(st) });
      }
      samples.push({ frame: n, s: stateKey(st) });
      const sys = caveSystemAt(graph, st.pos.x, st.pos.y + 1, st.pos.z);
      console.log(`[cave-path] ${pilot.done ? 'reached' : 'DID NOT reach'} the deepest chamber of system ${SYSTEM} in ${n} frames (${(n / 60).toFixed(1)} s): (${st.pos.x.toFixed(2)}, ${st.pos.y.toFixed(2)}, ${st.pos.z.toFixed(2)}), chamber floor ${deepest.floor.toFixed(2)}, depth ${(s.mouthY - st.pos.y).toFixed(1)} m, system ${sys}`);
      expect(pilot.done).toBe(true);
      const u16 = new Uint16Array(frames);
      const g: CavePathGolden = {
        seed: '20261108',
        system: SYSTEM,
        start,
        frames: Buffer.from(u16.buffer).toString('base64'),
        frameCount: n,
        samples,
        reached: { chamber: s.firstChamber + s.deepest, depth: s.mouthY - st.pos.y, frames: n },
      };
      fs.mkdirSync(fileURLToPath(new URL('./golden/', import.meta.url)), { recursive: true });
      fs.writeFileSync(goldenPath, JSON.stringify(g, null, 1) + '\n');
    }

    // Replay the committed frames.
    const g = JSON.parse(fs.readFileSync(goldenPath, 'utf8')) as CavePathGolden;
    const raw = Buffer.from(g.frames, 'base64');
    const f16 = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
    let st: MoveState = newMoveState({ x: g.start[0], y: g.start[1], z: g.start[2] });
    let k = 0;
    const want = new Map(g.samples.map((x) => [x.frame, x.s]));
    let mismatches = 0;
    for (let n = 0; n < g.frameCount; n++) {
      st = stepMovement(st, { flags: f16[n * 2], yaw: f16[n * 2 + 1], pitch: 0 }, ground);
      const w = want.get(n + 1);
      if (w !== undefined) {
        k++;
        if (w !== stateKey(st)) mismatches++;
      }
    }
    expect(mismatches).toBe(0);
    expect(k).toBeGreaterThan(10);
    // Ends in the deepest chamber, standing near its floor, deep underground.
    expect(caveSystemAt(graph, st.pos.x, st.pos.y + 1, st.pos.z)).toBe(SYSTEM);
    expect(Math.hypot(st.pos.x - deepest.x, st.pos.z - deepest.z)).toBeLessThan(deepest.rx);
    expect(Math.abs(st.pos.y - deepest.floor)).toBeLessThan(2.5);
  }, 120_000);
});

describe.skipIf(!hasWasm)('cave walkability across systems', () => {
  it('the scripted walker reaches the deepest chamber of most systems', async () => {
    const { wg, atlas } = await testWorld();
    const graph = parseCaveGraph(caveGraphBytes(wg, atlas));
    const ground = new CaveGroundCore((x, z) => wg.collisionHeight(atlas, x, z), graph.openings, wasmCellSource(wg, atlas));
    let reached = 0;
    const lines: string[] = [];
    for (let si = 0; si < graph.systems.length; si++) {
      const route = caveRoute(graph, si);
      const pilot = new CaveAutopilot(route.points);
      let st: MoveState = newMoveState({ x: route.start.x, y: wg.collisionHeight(atlas, route.start.x, route.start.z), z: route.start.z });
      let n = 0;
      for (; n < MAX_FRAMES && !pilot.done; n++) st = stepMovement(st, pilot.step(st), ground);
      if (pilot.done) reached++;
      const s = graph.systems[si];
      lines.push(`sys ${si}: ${pilot.done ? 'reached' : `stuck at waypoint ${pilot.next}/${route.points.length}`} depth ${(s.mouthY - st.pos.y).toFixed(0)} m in ${(n / 60).toFixed(0)} s at (${st.pos.x.toFixed(1)}, ${st.pos.y.toFixed(1)}, ${st.pos.z.toFixed(1)})`);
    }
    console.log(`[cave-path] ${reached}/${graph.systems.length} systems walked to the deepest chamber\n  ${lines.join('\n  ')}`);
    expect(reached / graph.systems.length).toBeGreaterThanOrEqual(0.9);
  }, 600_000);
});
