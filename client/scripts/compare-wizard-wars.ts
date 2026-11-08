// WP02 acceptance evidence: run the same scripted inputs through wizard-wars'
// ORIGINAL movement math and through our TS port, and report the divergence.
//
//   npm run compare:ww -w client            (finds refs/ by walking up from the repo)
//   LODESTONE_REFS=/path/to/refs npm run compare:ww -w client
//
// The reference side loads refs/wizard-wars/shared/movement.js and
// shared/constants.js at runtime (dynamic import by file path, never bundled;
// spec rule 4) and drives them with a transcription of the body of
// wizard-wars client/src/networking/ClientPrediction.ts predict() on flat
// ground: no arena clamp, barriers, mobility or status effects, which our port
// drops (see src/sim/movement.ts). Sprint was never wired up in wizard-wars,
// so the reference applies SPRINT_MULTIPLIER the way predict() applies any
// speed multiplier (ctx.speedMult).
//
// Writes docs/evidence/wp02-movement-side-by-side.{md,json,svg}.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { InputFlag, u16ToYaw } from '@lodestone/contracts';
import * as LC from '@lodestone/contracts';
import { FlatGround } from '../src/sim/ground';
import { newMoveState, stepMovement, type MoveInput, type MoveState } from '../src/sim/movement';
import { goldenScript } from '../src/sim/golden/script';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const outDir = join(repoRoot, 'docs', 'evidence');

function findRefs(): string {
  if (process.env.LODESTONE_REFS) return process.env.LODESTONE_REFS;
  // In a git worktree (.claude/worktrees/<id>) refs/ lives in the main checkout.
  let dir = repoRoot;
  for (let i = 0; i < 6; i++) {
    const cand = join(dir, 'refs');
    if (existsSync(join(cand, 'wizard-wars', 'shared', 'movement.js'))) return cand;
    dir = dirname(dir);
  }
  throw new Error('refs/wizard-wars not found; run `npm run refs` or set LODESTONE_REFS');
}

type V3 = { x: number; y: number; z: number };
interface WWState { pos: V3; vel: V3; airJumpsUsed: number }
interface WWMovement {
  applyGroundFriction(vel: { x: number; z: number }, f: number, s: number, dt: number): void;
  applyGroundAccel(vel: { x: number; z: number }, w: { x: number; z: number }, ws: number, a: number, dt: number): void;
  applyAirAccel(vel: { x: number; z: number }, w: { x: number; z: number }, ws: number, a: number, cap: number, dt: number): void;
  normalizeWishDir(x: number, z: number): { x: number; z: number };
}
type WWConstants = Record<string, number>;

const refs = findRefs();
const ww = (await import(pathToFileURL(join(refs, 'wizard-wars', 'shared', 'movement.js')).href)) as WWMovement;
const wwC = (await import(pathToFileURL(join(refs, 'wizard-wars', 'shared', 'constants.js')).href)) as WWConstants;
const wwEvents = (await import(pathToFileURL(join(refs, 'wizard-wars', 'shared', 'events.js')).href)) as { INPUT_FLAGS: Record<string, number> };
const WF = wwEvents.INPUT_FLAGS;

// Constants must agree, or "identical feel" is meaningless.
const CONST_NAMES = ['BASE_MOVE_SPEED', 'SPRINT_MULTIPLIER', 'JUMP_FORCE', 'GRAVITY', 'GROUND_ACCEL', 'AIR_ACCEL', 'GROUND_FRICTION', 'STOP_SPEED', 'AIR_CAP_SPEED', 'MAX_AIR_JUMPS', 'PLAYER_HEIGHT'];
const constRows = CONST_NAMES.map((n) => ({ name: n, ww: wwC[n], lodestone: (LC as unknown as Record<string, number>)[n] }));
const constMismatch = constRows.filter((r) => r.ww !== r.lodestone);

/** Lodestone InputFlag bits -> wizard-wars INPUT_FLAGS bits (jump_edge moved from bit 6 to bit 5). */
function toWWFlags(f: number): number {
  let o = 0;
  if (f & InputFlag.forward) o |= WF.FORWARD;
  if (f & InputFlag.back) o |= WF.BACKWARD;
  if (f & InputFlag.left) o |= WF.LEFT;
  if (f & InputFlag.right) o |= WF.RIGHT;
  if (f & InputFlag.jump) o |= WF.JUMP;
  if (f & InputFlag.jump_edge) o |= WF.JUMP_EDGE;
  return o;
}

/** Transcription of wizard-wars ClientPrediction.predict() on flat ground at y = 0 (pos.y is the EYE there). */
function wwPredict(cur: WWState, wwFlags: number, yaw: number, dt: number, speedMult: number): WWState {
  const speed = wwC.BASE_MOVE_SPEED * speedMult;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  let wishX = 0, wishZ = 0;
  if (wwFlags & 1) { wishZ -= cos; wishX -= sin; }
  if (wwFlags & 2) { wishZ += cos; wishX += sin; }
  if (wwFlags & 4) { wishZ += sin; wishX -= cos; }
  if (wwFlags & 8) { wishZ -= sin; wishX += cos; }
  const wishDir = ww.normalizeWishDir(wishX, wishZ);
  const terrainHeightAt = () => 0;
  const currentGroundY = wwC.PLAYER_HEIGHT + terrainHeightAt();
  const isGrounded = cur.pos.y <= currentGroundY + 1e-4;
  const vel = { x: cur.vel.x, z: cur.vel.z };
  if (isGrounded) {
    ww.applyGroundFriction(vel, wwC.GROUND_FRICTION, wwC.STOP_SPEED, dt);
    ww.applyGroundAccel(vel, wishDir, speed, wwC.GROUND_ACCEL, dt);
  } else {
    ww.applyAirAccel(vel, wishDir, speed, wwC.AIR_ACCEL, wwC.AIR_CAP_SPEED, dt);
  }
  const vx = vel.x, vz = vel.z;
  let vy = cur.vel.y;
  if (!isGrounded) vy += wwC.GRAVITY * dt;
  let next = cur.airJumpsUsed;
  if ((wwFlags & WF.JUMP) && isGrounded) { vy = wwC.JUMP_FORCE; next = 0; }
  else if (!isGrounded && (wwFlags & WF.JUMP_EDGE) && cur.airJumpsUsed < wwC.MAX_AIR_JUMPS) { vy = wwC.JUMP_FORCE; next = cur.airJumpsUsed + 1; }
  const x = cur.pos.x + vx * dt;
  let y = cur.pos.y + vy * dt;
  const z = cur.pos.z + vz * dt;
  const groundY = wwC.PLAYER_HEIGHT + terrainHeightAt();
  const hugging = vy <= 0 && (y - groundY) <= 0.3;
  if (y <= groundY || hugging) { y = groundY; vy = 0; next = 0; }
  return { pos: { x, y, z }, vel: { x: vx, y: vy, z: vz }, airJumpsUsed: next };
}

const ground = new FlatGround(0);
const START = { x: 2048, z: 2048 };
const frames = goldenScript();
const sprintMult = (f: number) => (f & InputFlag.sprint ? wwC.SPRINT_MULTIPLIER : 1);

interface Sample { t: number; x: number; y: number; z: number; vx: number; vy: number; vz: number }
const fromLC = (t: number, s: MoveState): Sample => ({ t, x: s.pos.x, y: s.pos.y, z: s.pos.z, vx: s.vel.x, vy: s.vel.y, vz: s.vel.z });
const fromWW = (t: number, s: WWState): Sample => ({ t, x: s.pos.x, y: s.pos.y - wwC.PLAYER_HEIGHT, z: s.pos.z, vx: s.vel.x, vy: s.vel.y, vz: s.vel.z });

function runLC(inputs: MoveInput[], dt: number): Sample[] {
  let s: MoveState = newMoveState({ x: START.x, y: 0, z: START.z });
  const out = [fromLC(0, s)];
  inputs.forEach((f, i) => { s = stepMovement(s, f, ground, dt); out.push(fromLC((i + 1) * dt, s)); });
  return out;
}
function runWW(inputs: { flags: number; yawRad: number }[], dt: number): Sample[] {
  let s: WWState = { pos: { x: START.x, y: wwC.PLAYER_HEIGHT, z: START.z }, vel: { x: 0, y: 0, z: 0 }, airJumpsUsed: 0 };
  const out = [fromWW(0, s)];
  inputs.forEach((f, i) => { s = wwPredict(s, toWWFlags(f.flags), f.yawRad, dt, sprintMult(f.flags)); out.push(fromWW((i + 1) * dt, s)); });
  return out;
}

function maxDiv(a: Sample[], b: Sample[]) {
  let pos = 0, vel = 0, at = 0;
  for (let i = 0; i < a.length; i++) {
    const p = Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y, a[i].z - b[i].z);
    const v = Math.hypot(a[i].vx - b[i].vx, a[i].vy - b[i].vy, a[i].vz - b[i].vz);
    if (p > pos) { pos = p; at = i; }
    if (v > vel) vel = v;
  }
  return { maxPosM: pos, maxVelMs: vel, atStep: at };
}

// A) Same dt (1/60), same quantized yaw: this isolates the port itself.
const dt60 = 1 / 60;
const lc60 = runLC(frames, dt60);
const ww60 = runWW(frames.map((f) => ({ flags: f.flags, yawRad: u16ToYaw(f.yaw) })), dt60);
const divA = maxDiv(lc60, ww60);

// B) Worst-case yaw quantization: wizard-wars sees the raw angle half an LSB
// away from what we quantize to (wizard-wars sent float yaw on the wire).
const wwRaw = runWW(frames.map((f) => ({ flags: f.flags, yawRad: ((f.yaw + 0.5) / 65536) * Math.PI * 2 })), dt60);
const divB = maxDiv(lc60, wwRaw);

// C) Native rates: wizard-wars stepped at 64 Hz, we step at 60 Hz. Resample
// the script by time (held flags follow the 60 Hz frame covering that instant;
// a jump_edge fires on the first 64 Hz step at or after its press) and compare
// time-aligned.
function resample(hz: number) {
  const dt = 1 / hz;
  const n = Math.floor((frames.length / 60) * hz);
  const out: { flags: number; yawRad: number }[] = [];
  let lastEdgeIdx = -1;
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    const src = Math.min(frames.length - 1, Math.floor(t * 60 + 1e-9));
    let flags = frames[src].flags & ~InputFlag.jump_edge;
    // edge: any 60 Hz frame in (prev step, this step] carrying jump_edge
    const hi = Math.min(frames.length - 1, Math.floor((t + dt) * 60 - 1e-9));
    for (let j = Math.max(src, lastEdgeIdx + 1); j <= hi && j < frames.length; j++) {
      if (frames[j].flags & InputFlag.jump_edge) { flags |= InputFlag.jump_edge; lastEdgeIdx = j; break; }
    }
    out.push({ flags, yawRad: u16ToYaw(frames[src].yaw) });
  }
  return out;
}
const ww64 = runWW(resample(64), 1 / 64);
function sampleAt(s: Sample[], t: number): Sample {
  const dt = s[1].t - s[0].t;
  const i = Math.min(s.length - 2, Math.floor(t / dt));
  const a = s[i], b = s[i + 1];
  const k = (t - a.t) / dt;
  const L = (p: number, q: number) => p + (q - p) * k;
  return { t, x: L(a.x, b.x), y: L(a.y, b.y), z: L(a.z, b.z), vx: L(a.vx, b.vx), vy: L(a.vy, b.vy), vz: L(a.vz, b.vz) };
}
const tEnd = Math.min(lc60[lc60.length - 1].t, ww64[ww64.length - 1].t);
const aligned60: Sample[] = [], aligned64: Sample[] = [];
for (let t = 0; t <= tEnd; t += 1 / 240) { aligned60.push(sampleAt(lc60, t)); aligned64.push(sampleAt(ww64, t)); }
const divC = maxDiv(aligned60, aligned64);

// Feel metrics from isolated micro-scenarios, per variant.
type Stepper = (s: Sample, flags: number, dt: number) => Sample;
const lcStepper: Stepper = (s, flags, dt) => {
  const r = stepMovement({ ...newMoveState({ x: s.x, y: s.y, z: s.z }), vel: { x: s.vx, y: s.vy, z: s.vz }, airJumps: (s as Sample & { aj?: number }).aj ?? 0 }, { flags, yaw: 0, pitch: 0 }, ground, dt);
  return Object.assign(fromLC(s.t + dt, r), { aj: r.airJumps });
};
const wwStepper: Stepper = (s, flags, dt) => {
  const r = wwPredict({ pos: { x: s.x, y: s.y + wwC.PLAYER_HEIGHT, z: s.z }, vel: { x: s.vx, y: s.vy, z: s.vz }, airJumpsUsed: (s as Sample & { aj?: number }).aj ?? 0 }, toWWFlags(flags), 0, dt, sprintMult(flags));
  return Object.assign(fromWW(s.t + dt, r), { aj: r.airJumpsUsed });
};
function feel(step: Stepper, hz: number) {
  const dt = 1 / hz;
  const zero: Sample = { t: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  const hspeed = (s: Sample) => Math.hypot(s.vx, s.vz);
  // walk / sprint top speed and time to 90 % of it
  const top = (flags: number) => {
    let s = zero, t90 = NaN;
    for (let i = 0; i < hz * 5; i++) s = step(s, flags, dt);
    const vmax = hspeed(s);
    s = zero;
    for (let i = 0; i < hz * 5; i++) { s = step(s, flags, dt); if (Number.isNaN(t90) && hspeed(s) >= 0.9 * vmax) t90 = s.t; }
    return { vmax, t90, end: s };
  };
  const walk = top(InputFlag.forward);
  const sprint = top(InputFlag.forward | InputFlag.sprint);
  // stop distance from walk top speed
  let s: Sample = { ...walk.end, t: 0, x: 0, z: 0 };
  let tStop = NaN;
  for (let i = 0; i < hz * 3; i++) { s = step(s, 0, dt); if (Number.isNaN(tStop) && hspeed(s) === 0) tStop = s.t; }
  const stopDist = Math.hypot(s.x, s.z);
  // single jump: apex and airtime
  const jump = (doubleAt: number | null) => {
    let s: Sample = { ...zero };
    let apex = 0, land = NaN;
    for (let i = 0; i < hz * 3; i++) {
      let f = i === 0 ? InputFlag.jump | InputFlag.jump_edge : 0;
      if (doubleAt !== null && Math.abs(i * dt - doubleAt) < dt / 2) f |= InputFlag.jump_edge;
      s = step(s, f, dt);
      apex = Math.max(apex, s.y);
      if (i > 0 && s.y === 0 && s.vy === 0 && Number.isNaN(land)) { land = s.t; break; }
    }
    return { apex, airtime: land };
  };
  return { walkTop: walk.vmax, walkT90: walk.t90, sprintTop: sprint.vmax, sprintT90: sprint.t90, stopDist, stopTime: tStop, ...prefix('jump', jump(null)), ...prefix('dbl', jump(1 / 3)) };
}
function prefix<T extends Record<string, number>>(p: string, o: T) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [p + k[0].toUpperCase() + k.slice(1), v])) as Record<string, number>;
}
const feelRows = {
  'wizard-wars @64 Hz (native)': feel(wwStepper, 64),
  'wizard-wars @60 Hz': feel(wwStepper, 60),
  'Lodestone TS @60 Hz': feel(lcStepper, 60),
};

// ---- outputs -------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
const result = {
  generatedBy: 'client/scripts/compare-wizard-wars.ts',
  refs: refs.replace(/\\/g, '/'),
  steps: frames.length,
  constants: constRows,
  constantMismatches: constMismatch.length,
  A_samedt_quantizedYaw: divA,
  B_samedt_rawYawHalfLsb: divB,
  C_native64_vs_60_timeAligned: divC,
  feel: feelRows,
};
writeFileSync(join(outDir, 'wp02-movement-side-by-side.json'), JSON.stringify(result, null, 2) + '\n');

const fmt = (v: number, d = 3) => (Number.isNaN(v) ? 'n/a' : v.toFixed(d));
const feelKeys: [string, string, number][] = [
  ['walkTop', 'Walk top speed (m/s)', 3], ['walkT90', 'Walk: time to 90 % (s)', 3],
  ['sprintTop', 'Sprint top speed (m/s)', 3], ['sprintT90', 'Sprint: time to 90 % (s)', 3],
  ['stopDist', 'Stop distance from walk speed (m)', 3], ['stopTime', 'Stop time (s)', 3],
  ['jumpApex', 'Jump apex (m)', 3], ['jumpAirtime', 'Jump airtime (s)', 3],
  ['dblApex', 'Double jump apex, 2nd press at 0.33 s (m)', 3], ['dblAirtime', 'Double jump airtime (s)', 3],
];
const md = [
  '# WP02: movement side-by-side, wizard-wars vs Lodestone TS port',
  '',
  `Generated by \`npm run compare:ww -w client\` (client/scripts/compare-wizard-wars.ts). Reference: \`refs/wizard-wars/shared/movement.js\` + \`shared/constants.js\` loaded at runtime, driven by a transcription of \`ClientPrediction.predict()\` on flat ground. Script: the golden input sequence (${frames.length} steps = ${(frames.length / 60).toFixed(1)} s: idle, walk, sprint, stop, diagonal, jump + double jump + refused third jump, held-jump air strafe while turning, backpedal, sprint-diagonal, stop).`,
  '',
  '## Divergence',
  '',
  '| Comparison | Max position divergence (m) | Max velocity divergence (m/s) |',
  '| --- | --- | --- |',
  `| A. Same dt (1/60 s), same quantized yaw: the port itself | ${divA.maxPosM.toExponential(2)} | ${divA.maxVelMs.toExponential(2)} |`,
  `| B. Same dt, wizard-wars sees raw yaw half a u16 LSB away (worst-case quantization) | ${divB.maxPosM.toExponential(2)} | ${divB.maxVelMs.toExponential(2)} |`,
  `| C. Native rates: wizard-wars at 64 Hz vs ours at 60 Hz, time-aligned (input resampled by time) | ${divC.maxPosM.toFixed(3)} (at t = ${(divC.atStep / 240).toFixed(2)} s) | ${divC.maxVelMs.toFixed(3)} |`,
  '',
  'A is the acceptance number: identical math gives float-noise divergence (the only difference is that wizard-wars carries the eye height, 1.8 m, inside pos.y, which changes rounding in the last bits). B shows the u16 yaw quantization is invisible. C is the step-rate change from 64 Hz to 60 Hz (decision 0001): the feel metrics below show it moves top speeds, jump height and stop distance by a few centimeters at most; the position and velocity numbers in C come from timing, not a different path: a jump or landing falls up to one step apart on the two step grids (the velocity peak is vy = +6 on one side against about -5 on the other at the same instant), and the 2.5 s held-jump air-strafe segment accumulates those per-hop offsets into a few decimeters of position.',
  '',
  '## Feel metrics',
  '',
  `| Metric | ${Object.keys(feelRows).join(' | ')} |`,
  `| --- | ${Object.keys(feelRows).map(() => '---').join(' | ')} |`,
  ...feelKeys.map(([k, label, d]) => `| ${label} | ${Object.values(feelRows).map((r) => fmt(r[k as keyof typeof r] as number, d)).join(' | ')} |`),
  '',
  'Note: the effective walk speed is about 4.9 m/s, not BASE_MOVE_SPEED (8). With friction 9 and accel 5.5 the Source-style ground equilibrium is accel x wishspeed / friction = 5.5 x 8 / 9 = 4.89 m/s (sprint: 7.82 m/s). That is how wizard-wars has always felt; BASE_MOVE_SPEED is the wish speed, not the top speed. Worth knowing when spec 8 numbers (glide 9 m/s) are tuned against walking.',
  '',
  '## Constants',
  '',
  '| Name | wizard-wars | Lodestone (contracts) |',
  '| --- | --- | --- |',
  ...constRows.map((r) => `| ${r.name} | ${r.ww} | ${r.lodestone}${r.ww !== r.lodestone ? ' **MISMATCH**' : ''} |`),
  '',
  'Plot: `wp02-movement-side-by-side.svg` (horizontal speed and feet height over time, wizard-wars at 64 Hz vs Lodestone at 60 Hz).',
  '',
].join('\n');
writeFileSync(join(outDir, 'wp02-movement-side-by-side.md'), md);

// SVG: two stacked plots, speed and height over time.
function svg(): string {
  const W = 960, H = 220, pad = 40;
  const series = [
    { name: 'wizard-wars @64 Hz', color: '#d9480f', s: ww64, dash: '' },
    { name: 'Lodestone TS @60 Hz', color: '#1c7ed6', s: lc60, dash: '6 4' },
  ];
  const plot = (y0: number, title: string, f: (s: Sample) => number, maxV: number) => {
    const sx = (t: number) => pad + (t / tEnd) * (W - 2 * pad);
    const sy = (v: number) => y0 + H - pad / 2 - (v / maxV) * (H - pad);
    const lines = series.map(({ color, s, dash }) => `<polyline fill="none" stroke="${color}" stroke-width="1.5" ${dash ? `stroke-dasharray="${dash}"` : ''} points="${s.filter((p) => p.t <= tEnd).map((p) => `${sx(p.t).toFixed(1)},${sy(f(p)).toFixed(1)}`).join(' ')}"/>`);
    const ticks = [0, maxV / 2, maxV].map((v) => `<text x="${pad - 6}" y="${sy(v) + 4}" font-size="10" text-anchor="end">${v.toFixed(1)}</text><line x1="${pad}" x2="${W - pad}" y1="${sy(v)}" y2="${sy(v)}" stroke="#ddd"/>`);
    const tt = Array.from({ length: Math.floor(tEnd) + 1 }, (_, i) => `<text x="${sx(i)}" y="${y0 + H}" font-size="10" text-anchor="middle">${i}s</text>`);
    return `<text x="${pad}" y="${y0 + 12}" font-size="12" font-weight="bold">${title}</text>${ticks.join('')}${tt.join('')}${lines.join('')}`;
  };
  const legend = series.map((s, i) => `<line x1="${W - 260}" x2="${W - 230}" y1="${14 + i * 14}" y2="${14 + i * 14}" stroke="${s.color}" stroke-width="2" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''}/><text x="${W - 224}" y="${18 + i * 14}" font-size="11">${s.name}</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${2 * H + 30}" font-family="sans-serif"><rect width="100%" height="100%" fill="white"/>${plot(10, 'Horizontal speed (m/s)', (p) => Math.hypot(p.vx, p.vz), 9)}${plot(H + 20, 'Feet height (m)', (p) => p.y, 2.5)}${legend.join('')}</svg>\n`;
}
writeFileSync(join(outDir, 'wp02-movement-side-by-side.svg'), svg());

console.log(md);
if (constMismatch.length > 0 || divA.maxPosM > 1e-9) {
  console.error('FAIL: port diverges from wizard-wars');
  process.exit(1);
}
