// Procedural poses (playtest 2 enemy models): one function per rig turns
// the animator's state (anim.ts) into joint rotations, offsets and scales
// (rigs.ts POSE_STRIDE layout). Pure and allocation-free: renderer.ts calls
// it every frame for every enemy at full LOD (and the rig's body joint for
// the mid LOD, which only uses joint 0).
//
// Each attack kind has a wind-up pose (read it: the tell) and a strike pose;
// the weights come from the state machine (W eases in through the wind-up and
// hands over to S through the active frames; S eases out over the recovery).
// Hits flinch, staggers wobble, deaths fall / splat / sink per rig.

import type { EnemyAnimator, AttackKind } from './anim';
import { smooth } from './anim';
import type { ModelSpec, Rig } from './spec';
import { B, C, F, POSE_STRIDE, Q, SL, W } from './rigs';

export interface PoseCtx {
  a: EnemyAnimator;
  spec: ModelSpec;
  /** Head turn toward the player (rad, + = left) and pitch, already clamped and smoothed. */
  look: number;
  lookPitch: number;
  /** Per-enemy phase offset (s), so a pack does not breathe in step. */
  phase: number;
  /** -1 / 1: which way this one falls. */
  side: number;
  /** How far (model units) the body joint can drop to reach the ground (flyers fall from their hover). */
  drop: number;
}

const PI = Math.PI;
const TAU = PI * 2;
const ease = (x: number) => smooth(0, 1, x);

/** Reset `n` joints to rest (no rotation, no offset, unit scale). */
export function resetPose(out: Float32Array, n: number): void {
  for (let j = 0; j < n; j++) {
    const o = j * POSE_STRIDE;
    out[o] = out[o + 1] = out[o + 2] = out[o + 3] = out[o + 4] = out[o + 5] = 0;
    out[o + 6] = out[o + 7] = out[o + 8] = 1;
  }
}

function rot(out: Float32Array, j: number, x: number, y: number, z: number): void {
  const o = j * POSE_STRIDE;
  out[o] += x;
  out[o + 1] += y;
  out[o + 2] += z;
}
function off(out: Float32Array, j: number, x: number, y: number, z: number): void {
  const o = j * POSE_STRIDE + 3;
  out[o] += x;
  out[o + 1] += y;
  out[o + 2] += z;
}
function scl(out: Float32Array, j: number, x: number, y: number, z: number): void {
  const o = j * POSE_STRIDE + 6;
  out[o] *= x;
  out[o + 1] *= y;
  out[o + 2] *= z;
}

/** Wind-up weight W and strike weight S (see the header). */
export function phaseWeights(a: EnemyAnimator): { w: number; s: number } {
  _ph.w = a.state === 'windup' ? ease(a.windup) : a.state === 'strike' ? 1 - ease(Math.min(1, a.strike * 1.6)) : 0;
  _ph.s = a.state === 'strike' ? ease(Math.min(1, a.strike * 1.6)) : a.state === 'recover' ? 1 - ease(a.recover) : 0;
  return _ph;
}
const _ph = { w: 0, s: 0 };

/** A jump / dive arc over the strike and recovery (0..1..0). */
function arc(a: EnemyAnimator): number {
  const p = a.state === 'strike' ? a.strike * 0.35 : a.state === 'recover' ? 0.35 + 0.65 * a.recover : a.state === 'windup' ? 0 : 1;
  return a.state === 'strike' || a.state === 'recover' ? Math.sin(PI * Math.min(1, p)) : 0;
}

export function writePose(rig: Rig, c: PoseCtx, out: Float32Array): void {
  switch (rig) {
    case 'slime':
      return slime(c, out);
    case 'quadruped':
      return quadruped(c, out);
    case 'crawler':
      return crawler(c, out);
    case 'biped':
      return biped(c, out);
    case 'floater':
      return floater(c, out);
    case 'winged':
      return winged(c, out);
  }
}

// ── Slime: squash and stretch ─────────────────────────────────────────────

function slime(c: PoseCtx, out: Float32Array): void {
  const a = c.a;
  resetPose(out, 2);
  const t = a.time + c.phase;
  if (a.state === 'dying') {
    // splat: flatten into a puddle (fast), then melt away
    const k = 1 - Math.pow(1 - Math.min(1, a.death * 3), 3);
    scl(out, SL.body, 1 + 0.8 * k, 1 - 0.86 * k, 1 + 0.8 * k);
    scl(out, SL.face, 1, 0.4, 1);
    off(out, SL.face, 0, 0, -0.1 * k);
    return;
  }
  const { w, s } = phaseWeights(a);
  // idle: breathing and a slow wobble
  const br = Math.sin(t * 3);
  let sy = 1 + 0.045 * br;
  let sx = 1 - 0.025 * br;
  let ty = 0;
  let tz = 0;
  let rx = Math.sin(t * 2.1) * 0.03;
  let rz = Math.sin(t * 1.7) * 0.04;
  // locomotion: hops locked to distance; squash on contact, stretch in the air, jiggle after landing
  const m = Math.min(1, a.move);
  if (m > 0.02) {
    const h = a.gait % 1;
    const air = Math.sin(PI * h);
    const contact = Math.pow(Math.max(0, Math.cos(TAU * h)), 4);
    ty += air * 0.34 * m;
    sy += (-0.24 * contact + 0.14 * air) * m;
    sx += (0.16 * contact - 0.08 * air) * m;
    rx += -0.12 * air * m;
    const jig = Math.sin(h * 28) * contact * 0.06 * m;
    rz += jig;
  }
  // attacks
  const kind = a.attack.kind;
  if (kind === 'leap') {
    sy += -0.38 * w + 0.25 * s;
    sx += 0.28 * w - 0.12 * s;
    ty += arc(a) * 1.1;
    rx += -0.25 * s;
    tz += -0.2 * s;
  } else {
    // bump (and anything else): squash back, then stretch into a forward lunge
    sy += -0.25 * w - 0.08 * s;
    sx += 0.2 * w - 0.06 * s;
    rx += 0.18 * w - 0.32 * s;
    tz += 0.06 * w - 0.38 * s;
    out[SL.body * POSE_STRIDE + 8] *= 1 + 0.32 * s;
  }
  // the tell: a nervous shiver at the end of the wind-up
  const shiver = a.tremble * Math.sin(t * 55) * 0.04;
  sx += shiver;
  // hit: squish; stagger: wobble
  sy -= 0.22 * a.flinch;
  sx += 0.16 * a.flinch;
  rz += Math.sin(t * 16) * 0.25 * a.stagger;
  rot(out, SL.body, rx, 0, rz);
  off(out, SL.body, 0, ty, tz);
  scl(out, SL.body, sx, sy, sx);
  // face: looks at you, narrows the eyes winding up, blinks
  const blink = (t * 0.31) % 1 > 0.965 ? 0.12 : 1;
  rot(out, SL.face, c.lookPitch * 0.3, c.look * 0.35, 0);
  scl(out, SL.face, 1, blink * (1 - 0.35 * w) * (1 - 0.4 * a.flinch), 1);
}

// ── Quadrupeds ─────────────────────────────────────────────────────────────

function quadruped(c: PoseCtx, out: Float32Array): void {
  const a = c.a;
  resetPose(out, 12);
  const t = a.time + c.phase;
  if (a.state === 'dying') {
    // legs give, then the body rolls onto its side
    const k = ease(Math.min(1, a.death * 1.8));
    rot(out, Q.body, 0.1 * k, 0, c.side * 1.45 * k);
    off(out, Q.body, 0, -0.38 * k, 0);
    rot(out, Q.head, 0.3 * k, 0, 0);
    rot(out, Q.jaw, -0.4 * k, 0, 0);
    for (const j of [Q.flU, Q.frU]) rot(out, j, 0.5 * k, 0, 0);
    for (const j of [Q.blU, Q.brU]) rot(out, j, -0.5 * k, 0, 0);
    rot(out, Q.tail, -0.4 * k, 0, 0);
    return;
  }
  const { w, s } = phaseWeights(a);
  const m = Math.min(1.25, a.move);
  const kind = a.attack.kind;
  const charging = kind === 'charge' && a.state === 'strike';
  // gait: a trot (FL+BR / FR+BL); a fast gallop while charging
  const g = charging ? t * 15 : a.gait * TAU;
  const amp = charging ? 0.85 : 0.55 * m;
  const legs: [number, number, number, boolean][] = _legs;
  for (let i = 0; i < 4; i++) {
    const [u, l, ph, front] = legs[i];
    const p = g + ph;
    rot(out, u, Math.sin(p) * amp, 0, 0);
    const lift = Math.max(0, -Math.cos(p));
    rot(out, l, (front ? -1 : 1) * lift * amp * 1.3, 0, 0);
  }
  // body: bob, pitch with the stride, lean into turns, breathe
  const bob = Math.abs(Math.sin(g)) * 0.04 * Math.min(1, m + (charging ? 1 : 0));
  let bx = Math.sin(g * 2) * 0.03 * m;
  let by = -bob + Math.sin(t * 2) * 0.006;
  let bz = 0;
  const lean = Math.max(-0.2, Math.min(0.2, -a.turn * 0.05 * m));
  let hx = Math.sin(t * 1.3) * 0.05 + c.lookPitch * 0.6 - bx;
  let hy = c.look * (1 - w - s);
  let jaw = Math.max(0, Math.sin(t * 0.7)) * 0.06; // panting
  // attacks
  switch (kind) {
    case 'leap': {
      const ar = arc(a);
      by += -0.14 * w + ar * 0.85;
      bx += 0.12 * w - 0.25 * ar + 0.15 * s * (1 - ar);
      bz += -0.5 * s;
      rot(out, Q.flU, -0.5 * w + 0.9 * ar, 0, 0);
      rot(out, Q.frU, -0.5 * w + 0.9 * ar, 0, 0);
      rot(out, Q.blU, 0.5 * w - 0.8 * ar, 0, 0);
      rot(out, Q.brU, 0.5 * w - 0.8 * ar, 0, 0);
      jaw += 0.6 * (w * 0.5 + ar);
      hx += 0.2 * w - 0.2 * ar;
      break;
    }
    case 'charge':
      // head down, a hoof scraping the ground, then the run (the gallop above)
      hx += -0.45 * (w + s);
      by += -0.06 * w;
      bz += 0.08 * w;
      rot(out, Q.frU, Math.sin(t * 16) * 0.55 * w + 0.3 * w, 0, 0);
      bx += -0.1 * s;
      break;
    case 'spit':
      hx += 0.5 * w - 0.3 * s;
      bz += 0.08 * w - 0.12 * s;
      jaw += 0.25 * w + 0.6 * s;
      break;
    case 'stomp':
    case 'slam':
    case 'nova':
      // rear up on the hind legs, then crash down
      bx += 0.55 * w - 0.12 * s;
      by += 0.12 * w - 0.08 * s;
      rot(out, Q.flU, 0.8 * w, 0, 0);
      rot(out, Q.frU, 0.8 * w, 0, 0);
      rot(out, Q.flL, -0.9 * w, 0, 0);
      rot(out, Q.frL, -0.9 * w, 0, 0);
      jaw += 0.4 * w;
      break;
    default:
      // bite / gore / headbutt: rear back, jaw open, then lunge and snap
      bx += 0.12 * w - 0.14 * s;
      by += -0.06 * w;
      bz += 0.12 * w - 0.38 * s;
      hx += 0.4 * w - 0.35 * s;
      jaw += 0.6 * w * (1 - s);
      rot(out, Q.flU, -0.3 * w + 0.35 * s, 0, 0);
      rot(out, Q.frU, -0.3 * w + 0.35 * s, 0, 0);
  }
  // the tell: trembling with tension
  const tr = a.tremble * Math.sin(t * 50) * 0.025;
  // hit / stagger
  bx += 0.14 * a.flinch;
  bz += 0.08 * a.flinch;
  hx += 0.3 * a.flinch;
  const wob = Math.sin(t * 13) * a.stagger;
  hy += Math.sin(t * 22) * 0.35 * a.stagger;
  rot(out, Q.body, bx, tr, lean + wob * 0.22);
  off(out, Q.body, tr, by, bz);
  rot(out, Q.head, hx, hy, 0);
  rot(out, Q.jaw, -jaw, 0, 0);
  // tail: wags idle, streams out running
  rot(out, Q.tail, -0.15 + 0.35 * m + 0.4 * w, Math.sin(t * (2.5 + m * 5)) * (0.35 - 0.15 * m), 0);
  scl(out, Q.body, 1, 1 + Math.sin(t * 2) * 0.012, 1);
}
const _legs: [number, number, number, boolean][] = [
  [Q.flU, Q.flL, 0, true],
  [Q.brU, Q.brL, 0.15, false],
  [Q.frU, Q.frL, PI, true],
  [Q.blU, Q.blL, PI + 0.15, false],
];

// ── Crawlers ───────────────────────────────────────────────────────────────

function crawler(c: PoseCtx, out: Float32Array): void {
  const a = c.a;
  resetPose(out, 12);
  const t = a.time + c.phase;
  if (a.state === 'dying') {
    // flip onto the back, legs curl up and twitch
    const k = ease(Math.min(1, a.death * 2));
    rot(out, C.body, 0, 0, c.side * PI * k);
    off(out, C.body, 0, 0.05 * k, 0);
    for (let i = 0; i < 6; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      rot(out, C.leg0 + i, 0, 0, side * (0.9 * k + Math.sin(t * 30 + i) * 0.15 * (1 - a.death)));
    }
    rot(out, C.tail1, -0.5 * k, 0, 0);
    return;
  }
  const { w, s } = phaseWeights(a);
  const m = Math.min(1.3, a.move);
  const g = a.gait * TAU;
  // tripod gait: L0 R1 L2 together
  for (let i = 0; i < 6; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const pair = Math.floor(i / 2);
    const ph = g + ((pair + (side > 0 ? 0 : 1)) % 2) * PI;
    const sweep = Math.sin(ph) * 0.38 * m + Math.sin(t * 3 + i) * 0.03;
    const lift = Math.max(0, Math.cos(ph)) * 0.35 * m;
    rot(out, C.leg0 + i, 0, sweep, side * lift);
  }
  let bx = 0;
  let by = Math.abs(Math.sin(g * 2)) * 0.02 * m;
  let bz = 0;
  let hx = c.lookPitch * 0.4;
  const hy = c.look * 0.5 * (1 - w);
  let claw = Math.sin(t * 2.3) > 0.9 ? 0.25 : 0; // an idle snip
  let t1 = Math.sin(t * 1.4) * 0.06;
  let t2 = Math.sin(t * 1.9) * 0.08;
  switch (a.attack.kind) {
    case 'sting':
      // tail cocks back, then stabs forward over the body
      t1 += 0.35 * w - 0.75 * s;
      t2 += 0.3 * w - 0.7 * s;
      bz += 0.08 * w - 0.12 * s;
      bx += -0.1 * w + 0.12 * s;
      break;
    case 'leap': {
      const ar = arc(a);
      by += -0.1 * w + ar * 0.7;
      bx += 0.1 * w - 0.2 * ar;
      bz += -0.4 * s;
      claw += 0.5 * (w + ar);
      break;
    }
    case 'spit':
      hx += 0.4 * w - 0.3 * s;
      bz += 0.06 * w;
      break;
    default:
      // pincers / fangs wide, then snap shut in a lunge
      claw += 0.55 * w - 0.25 * s;
      bz += 0.1 * w - 0.3 * s;
      hx += 0.25 * w - 0.2 * s;
      by += -0.04 * w;
  }
  const tr = a.tremble * Math.sin(t * 60) * 0.02;
  bz += 0.1 * a.flinch;
  bx += -0.15 * a.flinch;
  rot(out, C.body, bx, Math.sin(t * 14) * 0.3 * a.stagger, Math.sin(t * 11) * 0.2 * a.stagger);
  off(out, C.body, tr, by, bz);
  rot(out, C.head, hx, hy, 0);
  rot(out, C.clawL, 0, claw, 0);
  rot(out, C.clawR, 0, -claw, 0);
  rot(out, C.tail1, t1, 0, 0);
  rot(out, C.tail2, t2, 0, 0);
}

// ── Bipeds (the avatar skeleton) ───────────────────────────────────────────

function biped(c: PoseCtx, out: Float32Array): void {
  const a = c.a;
  const sp = c.spec;
  resetPose(out, 12);
  const t = a.time + c.phase;
  const heavy = sp.style === 'sentinel' || sp.style === 'mud_golem' || sp.style === 'crystal_golem' || sp.style === 'warden' || sp.style === 'grave_brute' || sp.style === 'starfall_sentinel' || sp.style === 'vault_keeper';
  if (a.state === 'dying') {
    // knees buckle, then a fall onto the back, arms flung out
    const kn = ease(Math.min(1, a.death * 2.8));
    const fall = ease(Math.max(0, Math.min(1, (a.death - 0.2) * 1.8)));
    off(out, B.hips, 0, -0.32 * kn - 0.3 * fall, 0.1 * fall);
    rot(out, B.hips, 1.45 * fall, 0, c.side * 0.15 * fall);
    rot(out, B.torso, -0.3 * kn + 0.1 * fall, 0, 0);
    rot(out, B.head, 0.4 * fall, c.side * 0.4 * fall, 0);
    rot(out, B.hipL, 1.1 * kn - 0.6 * fall, 0, -0.15 * fall);
    rot(out, B.hipR, 0.9 * kn - 0.5 * fall, 0, 0.2 * fall);
    rot(out, B.knL, -1.5 * kn + 0.6 * fall, 0, 0);
    rot(out, B.knR, -1.3 * kn + 0.5 * fall, 0, 0);
    rot(out, B.shL, 0.4 * kn - 0.5 * fall, 0, -1.2 * fall);
    rot(out, B.shR, 0.4 * kn - 0.5 * fall, 0, 1.2 * fall);
    rot(out, B.elL, 0.6 * kn, 0, 0);
    rot(out, B.elR, 0.6 * kn, 0, 0);
    return;
  }
  const { w, s } = phaseWeights(a);
  const m = Math.min(1.3, a.move);
  const g = a.gait * TAU;
  const stride = heavy ? 0.42 : 0.62;
  // walk: legs, knees, arms counter-swing (the avatar's cycle)
  const lg = Math.sin(g) * stride * m;
  rot(out, B.hipL, lg, 0, 0);
  rot(out, B.hipR, -lg, 0, 0);
  rot(out, B.knL, -(0.15 + 0.85 * Math.max(0, Math.sin(g - 1.2))) * m, 0, 0);
  rot(out, B.knR, -(0.15 + 0.85 * Math.max(0, Math.sin(g + PI - 1.2))) * m, 0, 0);
  let hipY = -0.03 * m + Math.abs(Math.cos(g)) * 0.035 * m + Math.sin(t * 1.7) * 0.006;
  let hipZ = 0;
  let hipRx = 0;
  let hipRy = 0;
  let sway = heavy ? Math.sin(g) * 0.07 * m : Math.sin(g) * 0.025 * m;
  let tx = sp.hunch + 0.08 * m + Math.sin(t * 1.7) * 0.015; // torso pitch (forward +)
  let ty = Math.sin(g) * 0.12 * m;
  let tz = 0;
  const armSwing = Math.sin(g) * 0.45 * m;
  // arms at rest: a fighting stance, a little out
  let lS = -armSwing + 0.1;
  let rS = armSwing + 0.1;
  let lSp = -0.12;
  let rSp = 0.12;
  let lE = 0.25 + 0.2 * m;
  let rE = 0.25 + 0.2 * m;
  if (sp.weapon === 'sword' || sp.weapon === 'cleaver' || sp.weapon === 'spear' || sp.weapon === 'keystaff') {
    rS += 0.25;
    rE += 0.45; // the weapon held ready ahead
  }
  if (sp.hunch > 0) {
    lS += sp.hunch * 0.8;
    rS += sp.hunch * 0.8;
    lSp -= 0.15;
    rSp += 0.15;
  }
  let hx = sp.hunch * 0.8 + c.lookPitch * 0.6; // a hunched demon still looks ahead
  let hy = c.look * 0.75;
  let kneeBend = 0;
  switch (a.attack.kind) {
    case 'slam':
    case 'stomp':
      if (a.attack.kind === 'stomp' && !heavy) {
        // one foot up, then down hard
        rot(out, B.hipR, 1.1 * w, 0, 0);
        rot(out, B.knR, -1.3 * w, 0, 0);
        lSp += -0.6 * w;
        rSp += 0.6 * w;
        tx += -0.12 * w + 0.15 * s;
        hipY += 0.04 * w - 0.12 * s;
        kneeBend += 0.4 * s;
        break;
      }
      // both arms overhead, lean back, then crash down
      lS += 2.7 * w + (0.65 - lS) * s;
      rS += 2.7 * w + (0.65 - rS) * s;
      lSp += 0.12 * w;
      rSp -= 0.12 * w;
      lE += 0.4 * w - 0.2 * s;
      rE += 0.4 * w - 0.2 * s;
      tx += -0.28 * w + 0.5 * s;
      hipY += 0.04 * w - 0.16 * s;
      kneeBend += 0.55 * s;
      hx += 0.2 * w - 0.2 * s;
      break;
    case 'punch':
      // cock the right fist back, then drive it forward
      rS += -0.7 * w + 1.55 * s;
      rE += 1.5 * w - 0.4 * s;
      ty += 0.55 * w - 0.45 * s;
      hipZ += 0.08 * w - 0.25 * s;
      lS += 0.6 * w;
      lE += 0.8 * w;
      break;
    case 'shoot':
      // bow arm up (left), draw back to the cheek (right), sideways stance
      lS += 1.45 * (w + s) - lS * (w + s) * 0.5;
      lE += -lE * (w + s);
      rS += 1.4 * w + 1.2 * s;
      rE += 2.0 * w + 0.9 * s;
      rSp += -0.2 * w;
      ty += 0.35 * (w + s);
      hy *= 1 - w - s;
      break;
    case 'throw':
      // spear back over the shoulder, then the throw
      rS += 2.6 * w + (1.2 - rS) * s;
      rE += 0.6 * w - 0.4 * s;
      rSp += 0.3 * w;
      ty += 0.6 * w - 0.6 * s;
      tx += -0.15 * w + 0.3 * s;
      lS += 1.2 * w;
      hipZ += 0.1 * w - 0.2 * s;
      break;
    case 'cast':
    case 'nova':
    case 'spit': {
      const nova = a.attack.kind === 'nova';
      lS += 1.9 * w + (nova ? -0.6 : 1.3) * s;
      rS += 1.9 * w + (nova ? -0.6 : 1.3) * s;
      lSp += -0.5 * w - (nova ? 1.3 : 0.1) * s;
      rSp += 0.5 * w + (nova ? 1.3 : 0.1) * s;
      lE += 0.3 * w - 0.4 * s;
      rE += 0.3 * w - 0.4 * s;
      tx += -0.2 * w + 0.15 * s;
      hx += 0.3 * w;
      kneeBend += nova ? 0.4 * s : 0;
      hipY += nova ? -0.08 * s : 0;
      break;
    }
    case 'charge':
    case 'leap': {
      // crouch, weapon back, then the lunge (and a jump for leaps)
      const ar = a.attack.kind === 'leap' ? arc(a) : 0;
      kneeBend += 0.8 * w - 0.5 * ar;
      hipY += -0.16 * w + ar * 0.9;
      tx += 0.35 * w + 0.2 * s;
      hipZ += -0.45 * s;
      rS += -0.5 * w + 1.9 * s;
      rE += 0.6 * w - 0.4 * s;
      lS += -0.4 * w + 0.6 * s;
      break;
    }
    default:
      // swipe / bite / claw: weapon arm raised back across, twist, then the cut
      rS += 2.3 * w + (0.6 - rS) * s;
      rSp += 0.45 * w - 0.3 * s;
      rE += 0.5 * w - 0.3 * s;
      ty += 0.6 * w - 0.55 * s;
      tx += -0.1 * w + 0.2 * s;
      hipZ += 0.04 * w - 0.2 * s;
      lS += 0.3 * w + 0.5 * s;
      lSp += -0.3 * s;
      if (sp.hunch > 0) {
        // demons rake with both claws
        lS += 2.0 * w - 0.4 * s;
        lSp += -0.4 * w;
      }
  }
  // tell: a shiver; hit: knocked back; stagger: arms flail
  const tr = a.tremble * Math.sin(t * 50) * 0.02;
  tx += -0.32 * a.flinch;
  hx += 0.35 * a.flinch;
  hipZ += 0.08 * a.flinch;
  lSp += -0.35 * a.flinch;
  rSp += 0.35 * a.flinch;
  const st = a.stagger;
  if (st > 0) {
    tx += -0.35 * st;
    sway += Math.sin(t * 9) * 0.25 * st;
    lS += Math.sin(t * 13) * 0.9 * st;
    rS += Math.sin(t * 13 + 2) * 0.9 * st;
    lSp += -0.6 * st;
    rSp += 0.6 * st;
    kneeBend += 0.4 * st;
    hx += 0.3 * st;
  }
  if (kneeBend) {
    rot(out, B.hipL, kneeBend * 0.6, 0, 0);
    rot(out, B.hipR, kneeBend * 0.6, 0, 0);
    rot(out, B.knL, -kneeBend, 0, 0);
    rot(out, B.knR, -kneeBend, 0, 0);
    hipY -= kneeBend * 0.12;
  }
  rot(out, B.hips, hipRx, hipRy, sway * 0.5);
  off(out, B.hips, tr, hipY, hipZ);
  rot(out, B.torso, -tx, ty - hipRy, sway * 0.5 + tz); // forward lean is a negative pitch
  rot(out, B.head, hx, hy - ty * 0.7, 0);
  rot(out, B.shL, lS, 0, lSp);
  rot(out, B.shR, rS, 0, rSp);
  rot(out, B.elL, lE, 0, 0);
  rot(out, B.elR, rE, 0, 0);
  // tail / cape: swings behind
  rot(out, B.tail, 0.15 + 0.35 * m + Math.sin(t * 2.2) * 0.08, Math.sin(t * 1.6 + g) * 0.2, 0);
}

// ── Floaters ───────────────────────────────────────────────────────────────

function floater(c: PoseCtx, out: Float32Array): void {
  const a = c.a;
  resetPose(out, 6);
  const t = a.time + c.phase;
  if (a.state === 'dying') {
    // sink, shrink and come apart into motes (the dissolve)
    const k = ease(a.death);
    off(out, F.core, 0, -Math.min(c.drop, 0.55 + c.drop * 0.5) * k, 0);
    scl(out, F.core, 1 - 0.4 * k, 1 - 0.6 * k, 1 - 0.4 * k);
    rot(out, F.ring, 0, a.spin + k * 6, 0);
    scl(out, F.ring, 1 + k, 1, 1 + k);
    off(out, F.handL, -0.2 * k, -0.3 * k, 0);
    off(out, F.handR, 0.2 * k, -0.3 * k, 0);
    rot(out, F.head, 0.5 * k, 0, 0);
    return;
  }
  const { w, s } = phaseWeights(a);
  const m = Math.min(1.3, a.move);
  let cy = Math.sin(t * 2.1) * 0.08;
  let cz = 0;
  let cx = 0.25 * m + Math.sin(t * 1.3) * 0.03; // lean into the drift
  let pulse = 1 + Math.sin(t * 4) * 0.03;
  const lean = Math.max(-0.3, Math.min(0.3, -a.turn * 0.06));
  // hands bob out of step
  let lx = 0;
  let ly = Math.sin(t * 2.1 + 1) * 0.06;
  let lz = 0;
  let rx = 0;
  let ry = Math.sin(t * 2.1 + 2) * 0.06;
  let rz = 0;
  let ring = 1;
  if (a.attack.kind === 'nova' || a.attack.kind === 'stomp' || a.attack.kind === 'slam') {
    // gather in, then burst outward
    lx += 0.25 * w - 0.35 * s;
    rx += -0.25 * w + 0.35 * s;
    ly += 0.15 * w + 0.2 * s;
    ry += 0.15 * w + 0.2 * s;
    lz += -0.15 * w;
    rz += -0.15 * w;
    pulse *= 1 - 0.15 * w + 0.3 * s;
    ring = 1 - 0.2 * w + 0.7 * s;
    cy += 0.12 * w - 0.06 * s;
  } else {
    // cast / bolt / claw: hands rise, the body draws back, then a thrust
    ly += 0.32 * w - 0.12 * s;
    ry += 0.32 * w - 0.12 * s;
    lz += 0.12 * w - 0.4 * s;
    rz += 0.12 * w - 0.4 * s;
    lx += 0.08 * w;
    rx += -0.08 * w;
    cx += -0.22 * w + 0.25 * s;
    cz += 0.12 * w - 0.25 * s;
    pulse *= 1 + 0.12 * w;
  }
  const tr = a.tremble * Math.sin(t * 55) * 0.025;
  cz += 0.16 * a.flinch;
  cx += -0.3 * a.flinch;
  rot(out, F.core, cx, 0, lean + Math.sin(t * 11) * 0.35 * a.stagger);
  off(out, F.core, tr, cy, cz);
  scl(out, F.core, pulse, pulse, pulse);
  rot(out, F.ring, 0.15 * Math.sin(t * 0.9), a.spin, 0.15 * Math.cos(t * 0.7));
  scl(out, F.ring, ring, ring, ring);
  off(out, F.handL, lx, ly, lz);
  off(out, F.handR, rx, ry, rz);
  rot(out, F.handL, 0.4 * w - 0.6 * s, 0, -0.2);
  rot(out, F.handR, 0.4 * w - 0.6 * s, 0, 0.2);
  rot(out, F.tail, 0.35 * m + Math.sin(t * 5) * 0.06, t * 0.4, 0);
  rot(out, F.head, c.lookPitch * 0.5 - cx * 0.5, c.look * 0.7, 0);
}

// ── Winged ─────────────────────────────────────────────────────────────────

function winged(c: PoseCtx, out: Float32Array): void {
  const a = c.a;
  const st = c.spec.style;
  resetPose(out, 8);
  const t = a.time + c.phase;
  const rate = st === 'gloom_bat' ? 15 : st === 'lumen_moth' ? 7 : 9;
  const amp = st === 'gloom_bat' ? 0.85 : st === 'lumen_moth' ? 0.65 : 0.7;
  if (a.state === 'dying') {
    // wings go limp, it tumbles to the ground
    const k = ease(Math.min(1, a.death * 1.6));
    const fl = Math.sin(t * rate) * amp * (1 - k);
    off(out, W.body, 0, -c.drop * k * k, 0);
    rot(out, W.body, 0.6 * k, 0, c.side * 1.2 * k);
    rot(out, W.wingL, 0, 0, -fl + 0.5 * k);
    rot(out, W.wingR, 0, 0, fl - 0.5 * k);
    rot(out, W.wingLo, 0, 0, 0.6 * k);
    rot(out, W.wingRo, 0, 0, -0.6 * k);
    return;
  }
  const { w, s } = phaseWeights(a);
  const m = Math.min(1.3, a.move);
  const kind = a.attack.kind;
  const dive = kind === 'leap' || kind === 'slam';
  const ph = t * rate * (1 + 0.25 * m) ;
  let flap = Math.sin(ph) * amp;
  let flapO = Math.sin(ph - 0.7) * amp * 0.7;
  let by = -Math.sin(ph) * 0.05;
  let bx = -0.3 * m;
  let bz = 0;
  let hx = c.lookPitch * 0.5 + 0.3 * m * 0.5;
  // wing sweep back (ry) folds them
  let sweep = 0;
  if (dive) {
    // climb with wings high, then fold and swoop
    const ar = arc(a);
    flap = flap * (1 - w) + 1.0 * w;
    flap *= 1 - s;
    flapO *= 1 - s;
    sweep += 0.9 * s;
    bx += 0.4 * w - 1.0 * s;
    by += 0.3 * w - 0.75 * ar;
    bz += -0.5 * s;
  } else {
    // bite / bolt: a hover with wings spread wide, the head back, then a strike
    flap = flap * (1 - 0.6 * w) + 0.5 * w;
    hx += 0.4 * w - 0.4 * s;
    bx += 0.25 * w - 0.2 * s;
    bz += 0.08 * w - 0.3 * s;
  }
  const tr = a.tremble * Math.sin(t * 50) * 0.03;
  bz += 0.15 * a.flinch;
  bx += -0.3 * a.flinch;
  by += Math.sin(t * 9) * 0.1 * a.stagger;
  rot(out, W.body, bx, 0, Math.max(-0.4, Math.min(0.4, -a.turn * 0.08)) + Math.sin(t * 12) * 0.4 * a.stagger);
  off(out, W.body, tr, by, bz);
  rot(out, W.head, hx, c.look * 0.6, 0);
  rot(out, W.wingL, 0, -sweep, -flap);
  rot(out, W.wingR, 0, sweep, flap);
  rot(out, W.wingLo, 0, -sweep * 0.5, -flapO);
  rot(out, W.wingRo, 0, sweep * 0.5, flapO);
  rot(out, W.tail, 0.2 * m + Math.sin(ph * 0.5) * 0.1, 0, 0);
  rot(out, W.legs, 0.6 * m + (dive ? -0.8 * s : 0), 0, 0);
}

/** Which kind an attack id animates as (tests, the gallery). */
export function kindsByRig(): Record<Rig, AttackKind[]> {
  return {
    slime: ['bump', 'leap'],
    quadruped: ['bite', 'charge', 'leap', 'spit', 'stomp'],
    crawler: ['bite', 'sting', 'leap', 'spit'],
    biped: ['swipe', 'slam', 'punch', 'stomp', 'shoot', 'throw', 'cast', 'nova', 'charge', 'leap'],
    floater: ['cast', 'nova'],
    winged: ['leap', 'bite', 'cast'],
  };
}
