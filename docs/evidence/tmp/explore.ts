import { readFileSync } from 'node:fs';
import { InputFlag as F, yawToU16 } from '@lodestone/contracts';
import { loadWorldgenGround } from '../../../client/src/sim/worldgenGround';
import { newMoveState, slopeAt, stepMovement, waterAt, type MoveState, type StepEnv } from '../../../client/src/sim/movement';

const g = await loadWorldgenGround(readFileSync('worldgen/pkg/worldgen.wasm'), 20261108n);
const [cmd, ...rest] = process.argv.slice(2);
const deg = (t2: number) => (Math.atan(Math.sqrt(t2)) * 180) / Math.PI;
if (cmd === 'probe') {
  // probe x z dirDeg len: profile along a direction
  const [x, z, dirDeg, len] = rest.map(Number);
  const dx = Math.cos((dirDeg * Math.PI) / 180), dz = Math.sin((dirDeg * Math.PI) / 180);
  for (let d = 0; d <= len; d += 1) {
    const px = x + dx * d, pz = z + dz * d;
    const h = g.heightAt(px, pz), w = g.waterAt(px, pz);
    console.log(d, px.toFixed(1), pz.toFixed(1), 'h', h.toFixed(2), 'w', w.toFixed(2), 'slope', deg(slopeAt(g, px, pz).t2).toFixed(1));
  }
} else if (cmd === 'run') {
  // run x z yawDeg segs... seg = steps:flags[:yawDeg]
  const [x, z, yawDeg] = rest.slice(0, 3).map(Number);
  let s: MoveState = newMoveState({ x, y: g.heightAt(x, z), z });
  let yaw = yawToU16((yawDeg * Math.PI) / 180);
  const env: StepEnv = { raining: process.env.RAIN === '1', updraft: null };
  let i = 0;
  let last = -1;
  for (const seg of rest.slice(3)) {
    const [n, fl, y2] = seg.split(':');
    if (y2) yaw = yawToU16((Number(y2) * Math.PI) / 180);
    const flags = fl.split('|').filter(Boolean).reduce((a, k) => a | (F as Record<string, number>)[k], 0);
    for (let k = 0; k < Number(n); k++) {
      const f = k === 0 ? flags : flags & ~(F.jump_edge | F.glide_toggle);
      s = stepMovement(s, { flags: f, yaw, pitch: 0 }, g, undefined, env);
      i++;
      if (s.mode !== last || k === Number(n) - 1 || i % 60 === 0) {
        console.log(i, 'mode', s.mode, 'pos', s.pos.x.toFixed(2), s.pos.y.toFixed(2), s.pos.z.toFixed(2), 'v', s.vel.x.toFixed(2), s.vel.y.toFixed(2), s.vel.z.toFixed(2), 'st', (s.stamina / 60).toFixed(1), 'fl', s.flags, 't', s.timer, 'h', g.heightAt(s.pos.x, s.pos.z).toFixed(2), 'w', waterAt(g, s.pos.x, s.pos.z).toFixed(2));
        last = s.mode;
      }
    }
  }
}
