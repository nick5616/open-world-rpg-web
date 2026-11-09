// Playtest 2 perf check: CPU cost of drawing a crowd of animated players.
// N avatars (default 300) on a disc around the camera (a few near, most in
// the mid and far bands, like a busy town), each with a walking speed, the
// odd jump and an action event every couple of seconds; per frame: the
// avatar update (LOD band, animator, rig posing) plus three.js' world-matrix
// pass over the whole group (what the renderer does before drawing). No
// WebGL: this is the main-thread cost the animation adds, not GPU time.
//
//   npx vite-node client/src/net/dev/avatar-bench.ts [count] [module]
//   (module: a path to another avatar.ts to compare, e.g. an older version)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { COMBAT, Activity } from '@lodestone/contracts';

(globalThis as unknown as { document: unknown }).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => null }) };

const N = Number(process.argv[2] ?? 300);
const modPath = process.argv[3] ?? '../avatar';
const modFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), modPath.endsWith('.ts') ? modPath : `${modPath}.ts`);
const mod = (await import(/* @vite-ignore */ modFile)) as typeof import('../avatar');
const { Avatar } = mod;
const budget = mod.FullRigBudget ? new mod.FullRigBudget() : null;
let full = 0;
const { packLook } = await import('../../combat/weapons/look');
const { classifyAction } = await import('../avatarAnim');

const cam = new THREE.PerspectiveCamera();
cam.position.set(0, 1.8, 0);
const group = new THREE.Group();
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const weapons = ['sword', 'spear', 'bow', 'staff', 'wand'] as const;
const moves = COMBAT.moves.map((m) => m.id);
const avatars = Array.from({ length: N }, (_, i) => {
  const a = new Avatar(i + 1);
  group.add(a.root);
  // distance: 10 % within 25 m, 40 % 25-80 m, 50 % beyond
  const u = rnd();
  const d = process.env.NEAR === '1' ? 3 + rnd() * 22 : u < 0.1 ? 3 + rnd() * 22 : u < 0.5 ? 25 + rnd() * 55 : 80 + rnd() * 120; // NEAR=1: everyone within 25 m (worst case)
  const ang = rnd() * Math.PI * 2;
  return {
    a,
    v: { id: i + 1, kind: 1, name: `p${i}`, level: 1, healthPct: 100, activity: 0, partyId: 0, typeId: packLook({ weapon: weapons[i % 5], material: '', gem: i % 8 }), ring: 'near', delayMs: 0, x: Math.cos(ang) * d, y: 0, z: Math.sin(ang) * d, yaw: ang, pitch: 0, speed: rnd() < 0.6 ? 4.9 : rnd() < 0.5 ? 7.8 : 0, mode: 'interp' },
    nextAction: rnd() * 2,
  };
});

const dt = 1 / 60;
const frames = Number(process.env.FRAMES ?? 1200);
const times: number[] = [];
let t = 0;
const heap0 = process.memoryUsage().heapUsed;
for (let f = 0; f < frames; f++) {
  t += dt;
  const t0 = performance.now();
  const fullM = budget?.step(full);
  full = 0;
  for (const s of avatars) {
    const v = s.v;
    v.yaw += 0.45 * dt; // walking in circles, so the crowd stays where it was placed
    v.x += -Math.sin(v.yaw) * v.speed * dt;
    v.z += -Math.cos(v.yaw) * v.speed * dt;
    v.activity = Math.sin(t * 0.7 + v.id) > 0.97 ? Activity.airborne : 0;
    if (t > s.nextAction) {
      s.nextAction = t + 1 + rnd() * 2;
      const anim = (s.a as { anim?: { trigger(x: unknown): void } }).anim;
      anim?.trigger(classifyAction(moves[Math.floor(rnd() * moves.length)], weapons[v.id % 5]));
    }
    s.a.update(v as never, cam, dt, fullM);
    if ((s.a as { animLevel?: number }).animLevel === 0) full++;
  }
  group.updateMatrixWorld();
  times.push(performance.now() - t0);
}
const heap1 = process.memoryUsage().heapUsed;
const warm = times.slice(120).sort((a, b) => a - b);
const pct = (p: number) => warm[Math.min(warm.length - 1, Math.floor((p / 100) * warm.length))];
const bands = [0, 0, 0];
for (const s of avatars) bands[(s.a as { animLevel?: number }).animLevel ?? 0]++;
console.log(JSON.stringify({ module: modPath, avatars: N, bands: { full: bands[0], simplified: bands[1], none: bands[2] }, frames, msPerFrame: { mean: +(warm.reduce((x, y) => x + y, 0) / warm.length).toFixed(3), p50: +pct(50).toFixed(3), p95: +pct(95).toFixed(3), p99: +pct(99).toFixed(3) }, heapGrowthKB: Math.round((heap1 - heap0) / 1024) }));
