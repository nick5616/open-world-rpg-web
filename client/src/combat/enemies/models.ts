// The enemy models (playtest 2: "every enemy is a capsule + sphere doll").
// Low-poly, flat-shaded, vertex-painted (geometry.ts), original designs in
// a Valheim / Breath of the Wild spirit: chunky readable silhouettes, a few
// characterful details (tusks, hoods, horns, crystals, glowing eyes), the
// contract colour as the body and the element as the accent. One build per
// variant (style + element), cached for the session and shared by every
// enemy of that variant (renderer.ts draws each part instanced).
//
// Every model is built at size 1, facing -Z, feet at y = 0, each part in
// its joint's frame (rigs.ts). The mid LOD is the whole model merged in its
// rest pose (one draw per variant); the far LOD is a shared box.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PartBuilder, hashString, mixHex, rng, shadeHex, triCount } from './geometry';
import type { ModelSpec, Rig, Style } from './spec';
import {
  B,
  C,
  F,
  JOINT_COUNT,
  Q,
  SL,
  W,
  avatarDims,
  bipedJoints,
  crawlerJoints,
  floaterJoints,
  quadJoints,
  slimeJoints,
  wingedJoints,
  type BipedDims,
  type Joint,
  type V3,
} from './rigs';

export type MatKind = 'opaque' | 'jelly' | 'spectral';

export interface Part {
  joint: number;
  geo: THREE.BufferGeometry;
  mat: MatKind;
}

export interface Model {
  variant: string;
  rig: Rig;
  joints: Joint[];
  parts: Part[];
  /** The whole model merged in its rest pose (mid LOD), in `midMat`. */
  mid: THREE.BufferGeometry;
  midMat: MatKind;
  /** Model-space bounds at size 1 (bars, culling, the far box). */
  height: number;
  radius: number;
  /** Ground footprint radius (aura rings): the body, not a weapon or a wing tip. */
  foot: number;
  /** Flyers: how far the model drops so its body sits at the zone's hover height (v.y is 1.5 m up). */
  flyLift: number;
  tris: number;
  midTris: number;
}

const PI = Math.PI;
const HALF = PI / 2;

// ── Kit: one PartBuilder per (joint, material) ──────────────────────────────

class Kit {
  private builders = new Map<string, { joint: number; mat: MatKind; b: PartBuilder }>();
  constructor(
    readonly spec: ModelSpec,
    readonly rand: () => number,
  ) {}
  /** The part builder of a joint (spectral models draw everything spectral). */
  at(joint: number, mat: MatKind = 'opaque'): PartBuilder {
    const m: MatKind = this.spec.spectral ? 'spectral' : mat;
    const key = `${joint}|${m}`;
    let e = this.builders.get(key);
    if (!e) {
      e = { joint, mat: m, b: new PartBuilder(this.rand, this.spec.spectral ? new THREE.Color(this.spec.color) : null) };
      this.builders.set(key, e);
    }
    return e.b;
  }
  build(variant: string): Part[] {
    const out: Part[] = [];
    for (const [, e] of this.builders) if (!e.b.empty) out.push({ joint: e.joint, mat: e.mat, geo: e.b.build(`${variant}#${e.joint}${e.mat[0]}`) });
    // opaque first (draw order), then jelly / spectral
    out.sort((a, b) => (a.mat === 'opaque' ? 0 : 1) - (b.mat === 'opaque' ? 0 : 1) || a.joint - b.joint);
    return out;
  }
}

interface Pal {
  body: string;
  dark: string;
  deep: string;
  light: string;
  belly: string;
  accent: string;
  eye: string;
  bone: string;
  hoof: string;
  leather: string;
  metal: string;
}

function palette(s: ModelSpec): Pal {
  return {
    body: s.color,
    dark: shadeHex(s.color, -0.1),
    deep: shadeHex(s.color, -0.2, -0.05),
    light: shadeHex(s.color, 0.1),
    belly: mixHex(s.color, '#e8dcc0', 0.35),
    accent: s.accent,
    eye: s.eye,
    bone: '#e6dcc2',
    hoof: '#2e2620',
    leather: '#5a3d26',
    metal: '#9aa2ac',
  };
}

// ── Shared detail helpers ─────────────────────────────────────────────────

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _up = new THREE.Vector3(0, 1, 0);
const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _ax = new THREE.Vector3();

/** Euler (XYZ) turning +Y onto `dir`. */
function aimRot(dir: THREE.Vector3): V3 {
  _q.setFromUnitVectors(_up, _d.copy(dir).normalize());
  _e.setFromQuaternion(_q, 'XYZ');
  return [_e.x, _e.y, _e.z];
}

/**
 * A curved horn (or claw, tusk, spine): `n` tapering cones from `base`
 * along `dir`, bending by `curl` rad per segment about `axis`.
 */
function horn(b: PartBuilder, base: V3, dir: V3, len: number, r: number, color: string, curl = 0.35, axis: V3 = [1, 0, 0], n = 3, glow = 0): void {
  _p.set(...base);
  const d = new THREE.Vector3(...dir).normalize();
  _ax.set(...axis).normalize();
  const seg = len / n;
  for (let i = 0; i < n; i++) {
    const r0 = r * (1 - i / n);
    const r1 = r * (1 - (i + 1) / n);
    const mid = _p.clone().addScaledVector(d, seg / 2);
    b.cyl(Math.max(0.004, r1), r0, seg * 1.08, 5, color, { pos: [mid.x, mid.y, mid.z], rot: aimRot(d), glow, jitter: 0.04 });
    _p.addScaledVector(d, seg);
    d.applyAxisAngle(_ax, curl);
  }
}

/** A horn and its mirror image across X (`base` / `dir` are the +X one). */
function hornPair(b: PartBuilder, base: V3, dir: V3, len: number, r: number, color: string, curl = 0.35, axis: V3 = [1, 0, 0], n = 3, glow = 0): void {
  horn(b, base, dir, len, r, color, curl, axis, n, glow);
  horn(b, [-base[0], base[1], base[2]], [-dir[0], dir[1], dir[2]], len, r, color, curl, [axis[0], -axis[1], -axis[2]], n, glow);
}

/** A pair of eyes at (+-x, y, z): glowing (demons, spirits) or dark beads with a glint. */
function eyes(b: PartBuilder, x: number, y: number, z: number, r: number, s: ModelSpec, opts: { white?: boolean } = {}): void {
  if (s.glowEyes) {
    b.pair((p, o) => p.ball(r, s.eye, { ...o, glow: 1, detail: 0, scale: [1, 0.75, 0.6], jitter: 0 }), { pos: [x, y, z] });
    return;
  }
  if (opts.white) b.pair((p, o) => p.ball(r * 1.35, '#f4f1e8', { ...o, detail: 1, scale: [1, 1.1, 0.7], jitter: 0.02 }), { pos: [x, y, z + r * 0.3] });
  b.pair((p, o) => p.ball(r, '#14100c', { ...o, detail: 0, jitter: 0 }), { pos: [x, y, z - (opts.white ? r * 0.5 : 0)] });
  b.pair((p, o) => p.ball(r * 0.32, '#ffffff', { ...o, glow: 0.4, detail: 0, jitter: 0 }), { pos: [x + r * 0.35, y + r * 0.35, z - r * (opts.white ? 1.2 : 0.75)] });
}

/** A limb segment hanging from its joint (pivot at the top). */
function limb(b: PartBuilder, len: number, rTop: number, rBot: number, color: string, seg = 6, o: { x?: number; z?: number; glow?: number } = {}): void {
  b.cyl(rBot, rTop, len, seg, color, { pos: [o.x ?? 0, -len / 2, o.z ?? 0], glow: o.glow });
}

// ── Slimes ────────────────────────────────────────────────────────────────

function buildSlime(k: Kit, p: Pal): Joint[] {
  const s = k.spec;
  const moss = s.style === 'moss_slime';
  const r = 0.55;
  const body = k.at(SL.body, 'jelly');
  // a dewdrop: flat base, round shoulders, a little peak
  const prof: [number, number][] = moss
    ? [[0, 0], [0.5, 0.02], [0.6, 0.14], [0.6, 0.3], [0.52, 0.46], [0.36, 0.58], [0.16, 0.65], [0, 0.67]]
    : [[0, 0], [0.46, 0.02], [0.56, 0.14], [0.57, 0.3], [0.5, 0.48], [0.34, 0.63], [0.16, 0.74], [0.05, 0.84], [0, 0.88]];
  body.lathe(prof, 9, p.body, { jitter: 0.05, shade: 0.25 });
  // a darker nucleus that shows through the jelly
  const core = k.at(SL.body);
  core.ball(0.16, shadeHex(p.body, -0.22, 0.1), { pos: [0.04, 0.24, 0.06], detail: 0 });
  core.ball(0.07, shadeHex(p.body, -0.1, 0.1), { pos: [-0.14, 0.4, 0.12], detail: 0 });
  // face: big round eyes, a small smile
  const face = k.at(SL.face);
  eyes(face, 0.15, 0.02, 0.02, 0.075, { ...s, glowEyes: s.element < 8 && s.glowEyes }, { white: true });
  face.box(0.1, 0.02, 0.03, '#2a2018', { pos: [0, -0.12, 0.05], rot: [0, 0, 0] });
  face.pair((b, o) => b.box(0.05, 0.02, 0.03, '#2a2018', o), { pos: [0.065, -0.105, 0.05], rot: [0, 0, 0.5] });
  if (moss) {
    // mossy cap with a sprout
    const cap = k.at(SL.body);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * PI * 2 + 0.3;
      const rr = i === 0 ? 0 : 0.28;
      cap.ball(0.17, i % 2 ? '#3d6e2a' : '#5a8f34', { pos: [Math.cos(a) * rr, 0.6 - (i ? 0.04 : -0.03), Math.sin(a) * rr], scale: [1.2, 0.5, 1.2], detail: 0 });
    }
    cap.cyl(0.012, 0.016, 0.18, 4, '#6b8f3a', { pos: [0.05, 0.75, 0.05] });
    cap.pair((b, o) => b.ball(0.06, '#8fd36b', { ...o, scale: [1.4, 0.35, 0.8], detail: 0 }), { pos: [0.07, 0.84, 0.05], rot: [0, 0, -0.4] });
    // little mushroom on the side
    cap.cyl(0.02, 0.025, 0.08, 5, '#e8dcc0', { pos: [-0.36, 0.5, 0.18] });
    cap.cone(0.07, 0.06, 6, '#c0503a', { pos: [-0.36, 0.56, 0.18] });
  }
  void r;
  return slimeJoints({ r: moss ? 0.58 : 0.55 });
}

// ── Quadrupeds ────────────────────────────────────────────────────────────

function quadLegs(k: Kit, upper: number, lower: number, rU: number, rL: number, col: string, foot: string, opts: { paw?: boolean; spread?: number } = {}): void {
  for (const [u, l] of [
    [Q.flU, Q.flL],
    [Q.frU, Q.frL],
    [Q.blU, Q.blL],
    [Q.brU, Q.brL],
  ] as const) {
    const back = u === Q.blU || u === Q.brU;
    const bu = k.at(u);
    bu.ball(rU * 1.25, col, { pos: [0, -0.02, 0], detail: 0, scale: [1, 1.2, back ? 1.6 : 1.3] });
    limb(bu, upper, rU, rU * 0.8, col, 5);
    const bl = k.at(l);
    limb(bl, lower, rL, rL * 0.75, col, 5);
    if (opts.paw) bl.ball(rL * 1.15, foot, { pos: [0, -lower, -0.03], scale: [1, 0.6, 1.3], detail: 0 });
    else bl.cyl(rL * 0.9, rL * 1.05, 0.07, 5, foot, { pos: [0, -lower + 0.03, 0] });
  }
}

function buildQuad(k: Kit, p: Pal): Joint[] {
  const s = k.spec;
  const st = s.style;
  const glow = s.glowEyes;
  if (st === 'boar') {
    const d = { hipH: 0.56, len: 0.78, halfW: 0.2, upper: 0.26, lower: 0.28, neckY: 0.06, jaw: [0, -0.08, -0.12] as V3 };
    const body = k.at(Q.body);
    body.sphere(0.42, 7, 5, p.body, { scale: [0.95, 0.9, 1.35], jitter: 0.08 });
    body.sphere(0.36, 6, 4, p.belly, { pos: [0, -0.12, -0.05], scale: [0.85, 0.6, 1.25] });
    // bristle ridge
    for (let i = 0; i < 7; i++) body.cone(0.06, 0.2 - Math.abs(i - 2) * 0.015, 4, p.deep, { pos: [0, 0.37 - Math.abs(i - 2) * 0.012, -0.36 + i * 0.11], rot: [0.5, 0, 0] });
    const head = k.at(Q.head);
    head.cyl(0.13, 0.24, 0.42, 6, p.body, { pos: [0, 0, -0.2], rot: [-HALF + 0.25, 0, 0], jitter: 0.08 });
    head.cyl(0.1, 0.1, 0.06, 7, '#c88a80', { pos: [0, -0.06, -0.42], rot: [-HALF + 0.25, 0, 0] });
    head.pair((b, o) => b.ball(0.02, '#3a2018', { ...o, detail: 0 }), { pos: [0.035, -0.07, -0.455] });
    head.pair((b, o) => b.cone(0.07, 0.16, 4, p.dark, { ...o, scale: [1, 1, 0.45] }), { pos: [0.14, 0.15, -0.05], rot: [0.3, 0, -0.5] });
    eyes(head, 0.11, 0.07, -0.2, 0.028, s);
    const jaw = k.at(Q.jaw);
    jaw.box(0.17, 0.06, 0.24, p.dark, { pos: [0, -0.02, -0.12] });
    hornPair(jaw, [0.08, 0, -0.2], [0.3, 1, -0.5], 0.2, 0.035, p.bone, -0.5, [0, 0, 1]);
    const tail = k.at(Q.tail);
    horn(tail, [0, 0, 0], [0, -0.4, 1], 0.2, 0.025, p.dark, 0.6);
    tail.ball(0.04, p.deep, { pos: [0, -0.12, 0.18], detail: 0 });
    quadLegs(k, d.upper, d.lower, 0.08, 0.06, p.dark, p.hoof);
    return quadJoints(d);
  }
  if (st === 'ram') {
    const d = { hipH: 0.6, len: 0.8, halfW: 0.2, upper: 0.28, lower: 0.3, neckY: 0.14, jaw: [0, -0.1, -0.1] as V3 };
    const wool = mixHex(p.body, '#efe6d4', 0.55);
    const body = k.at(Q.body);
    // a woolly fleece of lumps
    const r = rng(7);
    for (let i = 0; i < 14; i++) {
      const a = r() * PI * 2;
      const z = -0.38 + (i / 13) * 0.76;
      body.ball(0.2 + r() * 0.06, i % 3 ? wool : shadeHex(wool, -0.06), { pos: [Math.cos(a) * 0.22, 0.05 + Math.abs(Math.sin(a)) * 0.15, z], detail: 0 });
    }
    body.sphere(0.38, 7, 5, wool, { scale: [1, 0.95, 1.3], jitter: 0.07 });
    const head = k.at(Q.head);
    const face = shadeHex(p.body, -0.25);
    head.box(0.2, 0.22, 0.34, face, { pos: [0, 0, -0.16], rot: [0.35, 0, 0] });
    head.ball(0.17, wool, { pos: [0, 0.12, -0.04], scale: [1.1, 0.8, 1], detail: 0 });
    eyes(head, 0.1, 0.04, -0.2, 0.026, s);
    hornPair(head, [0.1, 0.12, -0.04], [1, 0.4, 0.4], 0.5, 0.075, '#b8a888', 0.9, [0, 1, 0.3], 5);
    head.pair((b, o) => b.box(0.12, 0.04, 0.06, face, o), { pos: [0.15, 0.02, -0.04], rot: [0, 0, -0.5] });
    const jaw = k.at(Q.jaw);
    jaw.box(0.14, 0.05, 0.16, face, { pos: [0, -0.02, -0.12], rot: [0.35, 0, 0] });
    k.at(Q.tail).ball(0.08, wool, { pos: [0, 0, 0.04], detail: 0 });
    quadLegs(k, d.upper, d.lower, 0.075, 0.05, face, p.hoof);
    return quadJoints(d);
  }
  if (st === 'lurker') {
    // bog lurker: a low, wide, mossy lizard with a long tail and a big mouth
    const d = { hipH: 0.4, len: 0.95, halfW: 0.3, upper: 0.2, lower: 0.2, neckY: 0.02, jaw: [0, -0.06, -0.06] as V3 };
    const body = k.at(Q.body);
    body.sphere(0.42, 8, 5, p.body, { scale: [1.15, 0.6, 1.4], jitter: 0.08 });
    body.sphere(0.36, 7, 4, p.belly, { pos: [0, -0.08, 0], scale: [1.1, 0.45, 1.3] });
    const r = rng(11);
    for (let i = 0; i < 9; i++) body.ball(0.06 + r() * 0.05, i % 2 ? '#5f7a34' : p.dark, { pos: [(r() - 0.5) * 0.5, 0.22, -0.4 + r() * 0.8], scale: [1, 0.6, 1], detail: 0 });
    const head = k.at(Q.head);
    head.sphere(0.24, 7, 4, p.body, { pos: [0, 0.02, -0.2], scale: [1.2, 0.55, 1.3] });
    head.pair((b, o) => b.ball(0.07, '#7a8a3a', { ...o, detail: 0 }), { pos: [0.13, 0.13, -0.16] });
    head.pair((b, o) => b.ball(0.04, '#e8c020', { ...o, glow: 0.35, detail: 0 }), { pos: [0.14, 0.17, -0.2] });
    head.pair((b, o) => b.ball(0.018, '#14100c', { ...o, detail: 0 }), { pos: [0.145, 0.18, -0.235] });
    const jaw = k.at(Q.jaw);
    jaw.sphere(0.22, 7, 3, p.belly, { pos: [0, -0.03, -0.18], scale: [1.15, 0.3, 1.25] });
    jaw.pair((b, o) => b.cone(0.015, 0.05, 3, p.bone, o), { pos: [0.1, 0.02, -0.32], rot: [0, 0, 0] });
    const tail = k.at(Q.tail);
    horn(tail, [0, 0, 0.05], [0, -0.25, 1], 0.9, 0.17, p.body, 0.12, [1, 0, 0], 4);
    quadLegs(k, d.upper, d.lower, 0.08, 0.065, p.dark, p.dark, { paw: true });
    return quadJoints(d);
  }
  if (st === 'stalker') {
    // rime stalker: a lean ice cat with crystal spines
    const d = { hipH: 0.66, len: 0.92, halfW: 0.15, upper: 0.32, lower: 0.32, neckY: 0.1, jaw: [0, -0.07, -0.12] as V3 };
    const body = k.at(Q.body);
    body.sphere(0.3, 7, 5, p.body, { scale: [0.9, 0.9, 1.7], jitter: 0.06 });
    body.sphere(0.26, 6, 4, p.belly, { pos: [0, -0.08, -0.05], scale: [0.85, 0.7, 1.5] });
    const crystal = s.accent;
    for (let i = 0; i < 5; i++) body.cone(0.05, 0.22 + (i % 2) * 0.1, 4, crystal, { pos: [0, 0.26, -0.32 + i * 0.16], rot: [0.3, 0, (i % 2 ? 1 : -1) * 0.2], glow: 0.55 });
    const head = k.at(Q.head);
    head.sphere(0.17, 6, 4, p.body, { pos: [0, 0.04, -0.12], scale: [1, 0.85, 1.15] });
    head.box(0.13, 0.09, 0.16, p.light, { pos: [0, -0.01, -0.27] });
    head.pair((b, o) => b.cone(0.05, 0.14, 4, p.body, o), { pos: [0.1, 0.18, -0.08], rot: [-0.2, 0, -0.3] });
    head.pair((b, o) => b.cone(0.02, 0.18, 3, crystal, { ...o, glow: 0.5 }), { pos: [0.1, 0.22, -0.02], rot: [-0.5, 0, -0.5] });
    eyes(head, 0.08, 0.06, -0.24, 0.028, { ...s, glowEyes: true, eye: crystal });
    const jaw = k.at(Q.jaw);
    jaw.box(0.1, 0.04, 0.16, p.light, { pos: [0, -0.01, -0.12] });
    jaw.pair((b, o) => b.cone(0.015, 0.06, 3, '#ffffff', { ...o, rot: [PI, 0, 0] }), { pos: [0.035, 0.04, -0.17] });
    const tail = k.at(Q.tail);
    horn(tail, [0, 0, 0], [0, 0.5, 1], 0.7, 0.05, p.body, -0.25, [1, 0, 0], 4);
    tail.cone(0.05, 0.16, 4, crystal, { pos: [0, 0.18, 0.64], rot: [1.6, 0, 0], glow: 0.6 });
    quadLegs(k, d.upper, d.lower, 0.065, 0.05, p.body, p.light, { paw: true });
    return quadJoints(d);
  }
  if (st === 'behemoth') {
    // thornhide behemoth: a hulking, mossy, thorn-backed grazer with a gore horn
    const d = { hipH: 0.7, len: 1.0, halfW: 0.3, upper: 0.32, lower: 0.34, neckY: 0.02, jaw: [0, -0.12, -0.16] as V3 };
    const body = k.at(Q.body);
    body.sphere(0.55, 8, 6, p.body, { scale: [1.0, 0.85, 1.25], jitter: 0.09 });
    body.sphere(0.45, 7, 4, p.belly, { pos: [0, -0.2, -0.05], scale: [0.9, 0.5, 1.15] });
    body.sphere(0.4, 7, 4, p.dark, { pos: [0, 0.18, -0.38], scale: [1.15, 0.9, 0.8], jitter: 0.12 }); // shoulder hump
    const r = rng(17);
    for (let i = 0; i < 16; i++) {
      const a = (r() - 0.5) * 2.2;
      const z = -0.5 + r();
      const base: V3 = [Math.sin(a) * 0.42, 0.12 + Math.cos(a) * 0.4, z * 0.9];
      horn(body, base, [Math.sin(a), Math.cos(a), 0.3], 0.18 + r() * 0.16, 0.05, i % 3 ? '#3a2a1a' : s.accent, -0.3, [1, 0, 0], 2, i % 3 ? 0 : 0.35);
    }
    for (let i = 0; i < 8; i++) body.ball(0.12, '#5f7a30', { pos: [(r() - 0.5) * 0.7, 0.42, (r() - 0.5) * 0.9], scale: [1.4, 0.4, 1.2], detail: 0 });
    const head = k.at(Q.head);
    head.box(0.38, 0.32, 0.44, p.dark, { pos: [0, -0.04, -0.2], rot: [0.35, 0, 0], jitter: 0.08 });
    head.box(0.3, 0.2, 0.18, p.body, { pos: [0, -0.14, -0.4], rot: [0.35, 0, 0] });
    horn(head, [0, 0.08, -0.38], [0, 1, -0.6], 0.42, 0.08, p.bone, 0.35, [1, 0, 0], 3); // the gore horn
    hornPair(head, [0.18, 0.1, -0.05], [1, 0.2, 0.2], 0.3, 0.06, p.bone, 0.6, [0, 0, 1], 3);
    eyes(head, 0.17, 0.04, -0.3, 0.03, s);
    const jaw = k.at(Q.jaw);
    jaw.box(0.26, 0.08, 0.26, p.deep, { pos: [0, -0.02, -0.14] });
    const tail = k.at(Q.tail);
    horn(tail, [0, 0, 0], [0, -0.6, 1], 0.4, 0.07, p.dark, 0.3, [1, 0, 0], 3);
    quadLegs(k, d.upper, d.lower, 0.13, 0.11, p.dark, p.hoof);
    return quadJoints(d);
  }
  // wolf (the gloamhound, the glintfox, and the wraith hound: the summon in its spectral material)
  const hound = st === 'wraith_hound';
  const fox = st === 'glintfox';
  const gloam = st === 'gloamhound';
  const magma = st === 'magma_hound';
  const d = { hipH: 0.62, len: 0.82, halfW: 0.14, upper: 0.3, lower: 0.31, neckY: 0.14, jaw: [0, -0.06, -0.14] as V3 };
  const body = k.at(Q.body);
  body.sphere(0.29, 7, 5, p.body, { pos: [0, 0, 0.04], scale: [0.85, 0.95, 1.6], jitter: 0.07 });
  // shaggy ruff at the chest and shoulders
  body.sphere(0.27, 6, 4, p.dark, { pos: [0, 0.06, -0.3], scale: [1.05, 1.15, 0.95], jitter: 0.1 });
  body.cone(0.16, 0.24, 5, p.dark, { pos: [0, -0.2, -0.32], rot: [PI, 0, 0] });
  body.sphere(0.22, 6, 4, p.belly, { pos: [0, -0.1, 0.06], scale: [0.8, 0.7, 1.5] });
  if (hound) for (let i = 0; i < 5; i++) body.cone(0.06, 0.3, 4, s.accent, { pos: [0, 0.24, -0.25 + i * 0.13], rot: [0.9, 0, 0], glow: 0.8 });
  if (fox) body.sphere(0.2, 6, 4, '#f6efe0', { pos: [0, -0.06, -0.32], scale: [0.8, 1, 0.7] }); // white bib
  if (gloam) {
    // the Huntsman's hounds: a studded collar and a pale stripe
    body.cyl(0.25, 0.27, 0.07, 7, '#3a2a1c', { pos: [0, 0.1, -0.42], rot: [1.2, 0, 0] });
    for (let i = 0; i < 6; i++) body.cone(0.02, 0.06, 3, '#b0b0b0', { pos: [Math.cos(i * 1.05) * 0.26, 0.1 + Math.sin(i * 1.05) * 0.2, -0.42], rot: [0, 0, i * 1.05 - HALF] });
    body.box(0.06, 0.03, 0.6, '#8a9ab0', { pos: [0, 0.27, 0.05] });
  }
  if (magma) {
    // cracked basalt hide: glowing seams along the flanks, a mane of flame, ember paws
    for (let i = 0; i < 6; i++) body.box(0.02, 0.2, 0.02, '#ff8a2a', { pos: [i % 2 ? 0.22 : -0.22, (i % 3) * 0.05, -0.2 + i * 0.12], rot: [0, 0, i % 2 ? 0.5 : -0.5], glow: 1 });
    for (let i = 0; i < 6; i++) body.cone(0.07, 0.32 - i * 0.02, 4, i % 2 ? '#ff6a1a' : '#ffc04a', { pos: [0, 0.26, -0.36 + i * 0.12], rot: [0.5, 0, 0], glow: 0.9 });
    body.sphere(0.24, 6, 4, '#2a1410', { pos: [0, 0.1, -0.32], scale: [1.05, 0.9, 0.9], jitter: 0.12 });
  }
  const head = k.at(Q.head);
  head.sphere(0.16, 6, 4, p.body, { pos: [0, 0.05, -0.1], scale: [1, 0.9, 1.1] });
  if (magma) head.pair((b, o) => b.cone(0.03, 0.2, 4, '#2a1410', { ...o, rot: [-0.6, 0, -0.5] }), { pos: [0.1, 0.2, -0.12] }); // basalt horns
  head.cyl(0.05, 0.085, 0.22, 5, p.body, { pos: [0, 0.0, -0.27], rot: [-HALF + 0.1, 0, 0] });
  head.ball(0.035, '#1a1410', { pos: [0, 0.02, -0.38], detail: 0 });
  head.pair((b, o) => b.cone(0.06, 0.17, 4, p.dark, { ...o, scale: [1, 1, 0.6] }), { pos: [0.08, 0.22, -0.04], rot: [-0.15, 0, -0.18] });
  if (fox) {
    head.pair((b, o) => b.cone(0.07, 0.22, 4, p.body, { ...o, scale: [1, 1, 0.55] }), { pos: [0.08, 0.25, -0.04], rot: [-0.1, 0, -0.25] });
    head.pair((b, o) => b.ball(0.06, '#f6efe0', { ...o, detail: 0 }), { pos: [0.07, -0.02, -0.25] }); // white cheeks
  }
  eyes(head, 0.07, 0.09, -0.19, 0.024, hound || gloam || magma ? { ...s, glowEyes: true } : s);
  const jaw = k.at(Q.jaw);
  jaw.box(0.08, 0.04, 0.2, p.light, { pos: [0, -0.01, -0.1] });
  jaw.pair((b, o) => b.cone(0.012, 0.05, 3, '#ffffff', { ...o, rot: [PI, 0, 0] }), { pos: [0.03, 0.035, -0.17] });
  const tail = k.at(Q.tail);
  if (fox) {
    // the Glintfox: a huge bushy tail with a white tip that glints
    horn(tail, [0, 0, 0], [0, 0.35, 1], 0.5, 0.16, p.body, -0.25, [1, 0, 0], 3);
    tail.ball(0.12, '#fff8e8', { pos: [0, 0.32, 0.46], detail: 0, scale: [1, 1, 1.3] });
    for (let i = 0; i < 4; i++) tail.ball(0.025, '#fff2a0', { pos: [Math.cos(i * 1.6) * 0.1, 0.2 + i * 0.05, 0.2 + i * 0.08], glow: 1, detail: 0 });
  } else horn(tail, [0, 0, 0], [0, -0.2, 1], 0.42, 0.09, p.dark, 0.3, [1, 0, 0], 3);
  if (magma) tail.cone(0.07, 0.3, 4, '#ff8a2a', { pos: [0, 0.0, 0.5], rot: [1.3, 0, 0], glow: 1 });
  quadLegs(k, d.upper, d.lower, 0.06, 0.045, fox ? '#2a1a14' : p.dark, magma ? '#ff6a1a' : p.deep, { paw: true });
  void glow;
  return quadJoints(d);
}

// ── Crawlers ──────────────────────────────────────────────────────────────

function crawlerLegs(k: Kit, d: { leg: number; r: number }, col: string, tip: string): void {
  for (let i = 0; i < 6; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const b = k.at(C.leg0 + i);
    // out and up to the knee, then down to the ground
    const kx = side * d.leg * 0.55;
    const ky = d.leg * 0.25;
    b.cyl(d.r * 0.8, d.r, d.leg * 0.65, 4, col, { pos: [kx / 2, ky / 2, 0], rot: [0, 0, -side * (HALF - 0.42)] });
    b.ball(d.r * 1.1, col, { pos: [kx, ky, 0], detail: 0 });
    const fx = side * d.leg * 0.85;
    const fy = -d.leg * 0.55;
    b.cyl(d.r * 0.35, d.r * 0.85, Math.hypot(fx - kx, fy - ky), 4, tip, { pos: [(kx + fx) / 2, (ky + fy) / 2, 0], rot: [0, 0, Math.atan2(fx - kx, -(fy - ky)) * -1 + PI] });
  }
}

function buildCrawler(k: Kit, p: Pal): Joint[] {
  const s = k.spec;
  if (s.style === 'scuttler') {
    const d = { bodyH: 0.34, len: 0.72, halfW: 0.2, leg: 0.42 };
    const body = k.at(C.body);
    for (let i = 0; i < 4; i++) body.sphere(0.24 - i * 0.02, 7, 4, i % 2 ? p.dark : p.body, { pos: [0, 0.02, -0.2 + i * 0.15], scale: [1.15, 0.5, 0.75] });
    const head = k.at(C.head);
    head.sphere(0.17, 6, 4, p.body, { pos: [0, 0, -0.06], scale: [1.2, 0.55, 1] });
    eyes(head, 0.05, 0.08, -0.14, 0.022, s);
    for (const [j, side] of [
      [C.clawL, -1],
      [C.clawR, 1],
    ] as const) {
      const c = k.at(j);
      c.cyl(0.035, 0.045, 0.26, 4, p.dark, { pos: [side * 0.05, 0, -0.12], rot: [-HALF, 0, side * 0.4] });
      c.sphere(0.09, 6, 4, p.body, { pos: [side * 0.1, 0, -0.3], scale: [0.8, 0.55, 1.4] });
      c.cone(0.04, 0.16, 4, p.light, { pos: [side * 0.14, 0, -0.44], rot: [-HALF, 0, side * 0.3] });
      c.cone(0.03, 0.13, 4, p.light, { pos: [side * 0.06, 0, -0.43], rot: [-HALF, 0, -side * 0.3] });
    }
    const t1 = k.at(C.tail1);
    for (let i = 0; i < 3; i++) t1.sphere(0.08 - i * 0.01, 5, 3, i % 2 ? p.dark : p.body, { pos: [0, i * 0.07, 0.04 + i * 0.06], scale: [1, 0.8, 1] });
    const t2 = k.at(C.tail2);
    t2.sphere(0.07, 5, 3, p.body, { pos: [0, 0.04, 0], scale: [1, 1, 1.1] });
    t2.ball(0.07, s.accent === p.body ? '#d8b060' : p.light, { pos: [0, 0.1, -0.03], detail: 0 });
    t2.cone(0.035, 0.16, 4, '#2a1a10', { pos: [0, 0.12, -0.12], rot: [-2.2, 0, 0] });
    crawlerLegs(k, { leg: d.leg, r: 0.025 }, p.dark, p.body);
    return crawlerJoints(d);
  }
  if (s.style === 'void_mite') {
    const d = { bodyH: 0.3, len: 0.5, halfW: 0.16, leg: 0.32 };
    const body = k.at(C.body);
    body.sphere(0.16, 6, 4, p.dark, { scale: [1, 0.7, 1] });
    const head = k.at(C.head);
    head.sphere(0.1, 6, 4, p.dark, { pos: [0, 0, -0.04], scale: [1, 0.7, 1] });
    eyes(head, 0.04, 0.05, -0.1, 0.02, s);
    for (const [j, side] of [
      [C.clawL, -1],
      [C.clawR, 1],
    ] as const)
      horn(k.at(j), [side * 0.0, 0, -0.04], [side * 0.2, -0.2, -1], 0.14, 0.022, p.bone, side * 0.5, [0, 1, 0], 2);
    // bloated abdomen with void cracks
    const t1 = k.at(C.tail1);
    t1.sphere(0.27, 8, 6, p.body, { pos: [0, 0.08, 0.16], scale: [1, 0.85, 1.15], jitter: 0.08 });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * PI * 2;
      t1.box(0.03, 0.02, 0.24, s.accent, { pos: [Math.cos(a) * 0.22, 0.12 + Math.sin(a) * 0.12, 0.16], rot: [0, a * 0.3, a], glow: 0.9 });
    }
    t1.ball(0.06, s.accent, { pos: [0, 0.3, 0.16], glow: 1, detail: 0 });
    crawlerLegs(k, { leg: d.leg, r: 0.02 }, p.deep, p.dark);
    return crawlerJoints(d);
  }
  // cave crawler: a long-legged cave spider with a lantern of glowing eyes
  const d = { bodyH: 0.38, len: 0.6, halfW: 0.18, leg: 0.55 };
  const body = k.at(C.body);
  body.sphere(0.2, 7, 4, p.body, { scale: [1, 0.6, 1.1] });
  const head = k.at(C.head);
  head.sphere(0.13, 6, 4, p.dark, { pos: [0, 0.02, -0.05], scale: [1, 0.75, 1] });
  const ec = s.eye;
  for (let i = 0; i < 6; i++) head.ball(i < 2 ? 0.03 : 0.018, ec, { pos: [((i % 3) - 1) * 0.045, 0.06 + Math.floor(i / 3) * 0.035, -0.15 + Math.floor(i / 3) * 0.02], glow: 1, detail: 0 });
  for (const [j, side] of [
    [C.clawL, -1],
    [C.clawR, 1],
  ] as const)
    horn(k.at(j), [0, -0.02, -0.05], [side * 0.15, -0.6, -1], 0.16, 0.025, p.bone, -side * 0.6, [0, 1, 0], 2);
  const t1 = k.at(C.tail1);
  t1.sphere(0.27, 8, 5, p.dark, { pos: [0, 0.08, 0.22], scale: [1, 0.85, 1.3], jitter: 0.07 });
  for (let i = 0; i < 4; i++) t1.ball(0.03, ec, { pos: [(i % 2 ? 0.08 : -0.08), 0.26 + (i > 1 ? -0.04 : 0), 0.12 + Math.floor(i / 2) * 0.16], glow: 0.7, detail: 0 });
  crawlerLegs(k, { leg: d.leg, r: 0.024 }, p.dark, p.body);
  return crawlerJoints(d);
}

// ── Bipeds ────────────────────────────────────────────────────────────────

interface Humanoid {
  skin: string;
  shirt: string;
  pants: string;
  boots: string;
  /** Torso build: chest radius, belly. */
  chest: number;
  belly?: number;
  /** Hands as fists (golems, demons with claws add their own). */
  fist?: number;
  armR?: number;
  legR?: number;
}

/** The common humanoid body on the avatar skeleton: pelvis, chest, sleeves, forearms, hands, legs, boots. */
function humanoid(k: Kit, d: BipedDims, h: Humanoid): void {
  const hips = k.at(B.hips);
  hips.cyl(h.chest * 0.85, h.chest * 0.8, 0.22, 6, h.pants, { pos: [0, -0.02, 0] });
  hips.cyl(h.chest * 0.9, h.chest * 0.9, 0.06, 6, '#3a2a1c', { pos: [0, 0.08, 0] });
  hips.box(0.06, 0.05, 0.03, '#c8a050', { pos: [0, 0.08, -h.chest * 0.88] });
  const torso = k.at(B.torso);
  const top = d.shoulderY + 0.06;
  torso.cyl(h.chest * 1.15, h.chest * 0.9, top, 6, h.shirt, { pos: [0, top / 2, 0], scale: [1, 1, 0.75] });
  if (h.belly) torso.ball(h.belly, h.shirt, { pos: [0, 0.12, -h.chest * 0.25], scale: [1, 0.9, 0.85], detail: 1 });
  torso.cyl(0.07, 0.08, 0.1, 5, h.skin, { pos: [0, d.neckY - 0.03, 0] });
  const ar = h.armR ?? 0.065;
  for (const [sh, el] of [
    [B.shL, B.elL],
    [B.shR, B.elR],
  ] as const) {
    const u = k.at(sh);
    u.ball(ar * 1.35, h.shirt, { detail: 0 });
    limb(u, d.upper, ar, ar * 0.85, h.shirt, 6);
    const f = k.at(el);
    limb(f, d.fore, ar * 0.85, ar * 0.7, h.skin, 6);
    f.ball(h.fist ?? ar * 0.95, h.skin, { pos: [0, -d.fore - 0.02, 0], scale: [1, 1.15, 0.9], detail: 0 });
  }
  const lr = h.legR ?? 0.08;
  for (const [hp, kn] of [
    [B.hipL, B.knL],
    [B.hipR, B.knR],
  ] as const) {
    const t = k.at(hp);
    limb(t, d.thigh, lr, lr * 0.85, h.pants, 6);
    const s = k.at(kn);
    limb(s, d.shin, lr * 0.85, lr * 0.75, h.boots, 6);
    s.box(lr * 1.7, 0.08, lr * 2.6, h.boots, { pos: [0, -d.shin + 0.02, -lr * 0.5] });
  }
}

/** A weapon in a hand (the forearm joint; the hand is at y = -fore). Blades point ahead, a little up. */
function weapon(k: Kit, joint: number, fore: number, kind: string, p: Pal, size = 1): void {
  const b = k.at(joint);
  const y = -fore - 0.02;
  const rot: V3 = [-HALF + 0.35, 0, 0];
  const at = (len: number): V3 => [0, y + Math.sin(0.35) * len, -Math.cos(0.35) * len];
  if (kind === 'sword' || kind === 'cleaver') {
    const big = kind === 'cleaver';
    const L = (big ? 1.0 : 0.72) * size;
    b.cyl(0.025, 0.025, 0.16, 5, p.leather, { pos: at(0), rot });
    b.box(big ? 0.26 : 0.2, 0.04, 0.05, big ? '#3a2a30' : '#8a7a50', { pos: at(0.09), rot });
    b.box(big ? 0.2 : 0.07, L, 0.02, big ? '#4a4048' : p.metal, { pos: at(0.1 + L / 2), rot, jitter: 0.03 });
    if (big) b.box(0.05, L * 0.9, 0.025, s_glowEdge(k), { pos: [0.1, at(0.1 + L / 2)[1], at(0.1 + L / 2)[2]], rot, glow: 0.8 });
    else b.cone(0.035, 0.1, 4, p.metal, { pos: at(0.1 + L + 0.04), rot, scale: [1, 1, 0.3] });
  } else if (kind === 'club') {
    b.cyl(0.035, 0.03, 0.2, 5, p.leather, { pos: at(0), rot });
    b.cyl(0.11, 0.05, 0.6, 6, '#6a4a2a', { pos: at(0.38), rot, jitter: 0.1 });
    for (let i = 0; i < 4; i++) b.cone(0.02, 0.07, 3, '#8a8a8a', { pos: [Math.cos(i * 1.6) * 0.1, at(0.5 + i * 0.05)[1], at(0.5 + i * 0.05)[2]], rot: [0, 0, -HALF + i * 1.6] });
  } else if (kind === 'hammer') {
    // carried head-down ahead of the feet (raised overhead, the head comes up for the slam)
    const L = 1.3 * size;
    const down = (len: number): V3 => [0, y - Math.cos(0.45) * len, -Math.sin(0.45) * len];
    const rot: V3 = [-0.45, 0, 0];
    b.cyl(0.04, 0.04, L, 6, '#4a3a2a', { pos: down(L / 2 - 0.25), rot });
    const hp = down(L - 0.25);
    b.box(0.5, 0.3, 0.3, '#6e6e6a', { pos: hp, rot, jitter: 0.06 });
    b.box(0.52, 0.06, 0.32, '#8a7a50', { pos: [hp[0], hp[1], hp[2]], rot });
    b.box(0.08, 0.12, 0.32, k.spec.accent, { pos: [0.27, hp[1], hp[2]], rot, glow: 0.7 });
    b.box(0.08, 0.12, 0.32, k.spec.accent, { pos: [-0.27, hp[1], hp[2]], rot, glow: 0.7 });
  } else if (kind === 'spear' || kind === 'keystaff') {
    const L = (kind === 'spear' ? 1.7 : 2.0) * size;
    b.cyl(0.025, 0.03, L, 5, kind === 'spear' ? '#6a4a2a' : '#c8a050', { pos: at(L / 2 - 0.5), rot });
    const tip = at(L - 0.5);
    if (kind === 'spear') {
      b.cone(0.05, 0.26, 4, p.metal, { pos: at(L - 0.37), rot, scale: [1, 1, 0.4] });
      b.box(0.03, 0.12, 0.03, '#b03a2a', { pos: at(L - 0.55), rot });
    } else {
      // a keystaff: a gilded ring holding a light
      b.add(new THREE.TorusGeometry(0.18, 0.03, 4, 12), '#c8a050', { pos: tip, rot: [0.35, 0, 0] });
      b.ball(0.1, '#ffe9a0', { pos: tip, glow: 1, detail: 0 });
      b.box(0.14, 0.04, 0.04, '#c8a050', { pos: at(L - 0.78), rot });
    }
  } else if (kind === 'bow') {
    // vertical in the left hand: two limbs and a string
    const g = k.spec.spectral ? k.spec.accent : '#6a4a2a';
    // limbs along the forearm's Z: the bow hangs level at rest and stands upright when aimed (arm raised)
    const by = y;
    b.box(0.035, 0.035, 0.42, g, { pos: [0, by - 0.06, -0.2], rot: [0.25, 0, 0] });
    b.box(0.035, 0.035, 0.42, g, { pos: [0, by - 0.06, 0.2], rot: [-0.25, 0, 0] });
    b.box(0.045, 0.05, 0.12, p.leather, { pos: [0, by - 0.02, 0] });
    b.box(0.006, 0.006, 0.8, '#e8e0d0', { pos: [0, by + 0.04, 0], glow: k.spec.spectral ? 0.8 : 0 });
  }
}
function s_glowEdge(k: Kit): string {
  return k.spec.element < 8 ? k.spec.accent : '#ff4a2a';
}

/** Hooded head (bandits): a face, a hood, an optional mask. */
function hoodedHead(b: PartBuilder, s: ModelSpec, hood: string, skin: string, mask: string | null): void {
  b.ball(0.15, skin, { pos: [0, 0.12, 0], scale: [0.95, 1.1, 1], detail: 1 });
  b.sphere(0.19, 7, 5, hood, { pos: [0, 0.14, 0.02], thetaLen: PI * 0.62, jitter: 0.06 });
  b.cone(0.19, 0.22, 7, hood, { pos: [0, 0.28, 0.08], rot: [0.5, 0, 0] });
  b.cyl(0.2, 0.24, 0.12, 7, hood, { pos: [0, -0.02, 0.02] });
  if (mask) b.box(0.24, 0.09, 0.08, mask, { pos: [0, 0.06, -0.12] });
  eyes(b, 0.055, 0.15, -0.13, 0.018, s);
}

function demonHorns(b: PartBuilder, kind: 'small' | 'curl' | 'crown' | 'spikes' | 'ram', col: string, glow = 0, y = 0.2): void {
  if (kind === 'small') hornPair(b, [0.07, y, -0.02], [0.4, 1, 0.3], 0.18, 0.035, col, 0.4, [0, 0, -1], 3, glow);
  else if (kind === 'curl') hornPair(b, [0.1, y, 0], [1, 0.6, 0.1], 0.42, 0.06, col, 0.55, [0, 0, -1], 4, glow);
  else if (kind === 'ram') hornPair(b, [0.1, y, 0], [1, 0.3, 0.6], 0.42, 0.065, col, 0.9, [0, 1, 0.4], 5, glow);
  else if (kind === 'spikes') for (let i = 0; i < 5; i++) horn(b, [(i - 2) * 0.05, y, 0.02 + Math.abs(i - 2) * 0.03], [(i - 2) * 0.3, 1, 0.4], 0.2 + (2 - Math.abs(i - 2)) * 0.08, 0.025, col, -0.2, [1, 0, 0], 2, glow);
  else {
    for (let i = 0; i < 7; i++) {
      const a = ((i - 3) / 3) * 1.1;
      horn(b, [Math.sin(a) * 0.14, y, -Math.cos(a) * 0.06 + 0.04], [Math.sin(a) * 0.5, 1, 0.15], i === 3 ? 0.5 : 0.32 - Math.abs(i - 3) * 0.03, 0.04, col, -0.15, [1, 0, 0], 3, glow);
    }
  }
}

function clawHands(k: Kit, d: BipedDims, col: string, len = 0.14, glow = 0): void {
  for (const el of [B.elL, B.elR]) {
    const b = k.at(el);
    for (let i = 0; i < 3; i++) horn(b, [(i - 1) * 0.035, -d.fore - 0.05, -0.02], [(i - 1) * 0.2, -1, -0.6], len, 0.018, col, 0.4, [1, 0, 0], 2, glow);
  }
}

function buildBiped(k: Kit, p: Pal): Joint[] {
  const s = k.spec;
  const st = s.style as Style;
  switch (st) {
    case 'cutthroat':
    case 'archer':
    case 'gale_phantom': {
      const d = avatarDims();
      const archer = st !== 'cutthroat';
      const hood = st === 'gale_phantom' ? p.body : archer ? '#4a5a2a' : p.body;
      humanoid(k, d, { skin: '#c9a27e', shirt: archer ? mixHex(p.body, '#5a4a30', 0.4) : '#5a3d26', pants: '#3e3428', boots: '#2a2018', chest: 0.2 });
      // leather vest straps, scarf
      const t = k.at(B.torso);
      t.box(0.06, 0.5, 0.33, p.leather, { pos: [0.06, 0.25, 0], rot: [0, 0, 0.5] });
      t.cyl(0.21, 0.24, 0.1, 6, hood, { pos: [0, d.shoulderY + 0.02, 0], scale: [1, 1, 0.8] });
      if (archer) {
        // cloak and quiver
        t.cone(0.32, 0.8, 6, hood, { pos: [0, 0.18, 0.12], scale: [1, 1, 0.45], jitter: 0.08 });
        t.cyl(0.07, 0.06, 0.48, 6, p.leather, { pos: [-0.12, 0.36, 0.2], rot: [0, 0, 0.35] });
        for (let i = 0; i < 3; i++) t.cone(0.03, 0.09, 3, '#e8e0d0', { pos: [-0.2 + i * 0.03, 0.64 - i * 0.01, 0.2 + (i - 1) * 0.02], rot: [0, 0, 0.35] });
      } else {
        t.box(0.3, 0.04, 0.3, '#3a2a1c', { pos: [0, 0.05, 0], rot: [0, 0, 0.12] });
        t.box(0.05, 0.22, 0.04, '#7a7a7a', { pos: [0.18, 0.05, 0.14], rot: [0.3, 0, 0.8] }); // a dagger at the back
      }
      hoodedHead(k.at(B.head), s, hood, '#c9a27e', archer ? null : '#7a2a20');
      weapon(k, archer ? B.elL : B.elR, d.fore, archer ? 'bow' : 'sword', p);
      return bipedJoints(d);
    }
    case 'brute': {
      const d = avatarDims({ wide: 1.35, arm: 1.12 });
      humanoid(k, d, { skin: '#b88a68', shirt: '#b88a68', pants: '#4a3a2a', boots: '#2a2018', chest: 0.27, belly: 0.25, fist: 0.1, armR: 0.09, legR: 0.1 });
      const t = k.at(B.torso);
      t.box(0.08, 0.62, 0.42, p.leather, { pos: [0, 0.28, 0], rot: [0, 0, 0.55] });
      // one big pauldron (red-brown), a fur collar
      t.sphere(0.17, 6, 4, p.body, { pos: [0.4, d.shoulderY + 0.05, 0], scale: [1.1, 0.7, 1.1], thetaLen: PI * 0.6 });
      t.cyl(0.24, 0.3, 0.12, 7, '#6a5038', { pos: [0, d.shoulderY + 0.04, 0.02], jitter: 0.12 });
      const h = k.at(B.head);
      h.ball(0.17, '#b88a68', { pos: [0, 0.12, 0], scale: [1, 1.05, 1] });
      h.cone(0.13, 0.2, 5, '#5a3a24', { pos: [0, 0.0, -0.12], rot: [PI - 0.4, 0, 0] }); // beard
      h.box(0.2, 0.03, 0.04, '#3a2a1c', { pos: [0, 0.18, -0.15] }); // brow
      eyes(h, 0.06, 0.14, -0.15, 0.02, s);
      h.pair((b, o) => b.ball(0.035, '#b88a68', { ...o, detail: 0 }), { pos: [0.16, 0.12, 0] });
      weapon(k, B.elR, d.fore, 'club', p);
      return bipedJoints(d);
    }
    case 'hunt_master': {
      // the Huntsman: tall, an antlered hood, a fur mantle, a throwing spear
      const d = avatarDims();
      humanoid(k, d, { skin: '#c9a27e', shirt: p.body, pants: '#3a3020', boots: '#2a2018', chest: 0.21 });
      const t = k.at(B.torso);
      t.cyl(0.3, 0.36, 0.22, 8, '#6a5440', { pos: [0, d.shoulderY - 0.02, 0.02], jitter: 0.14 }); // fur mantle
      t.cone(0.34, 0.9, 7, shadeHex(p.body, -0.05), { pos: [0, 0.12, 0.14], scale: [1, 1, 0.4], jitter: 0.08 });
      t.box(0.06, 0.5, 0.36, p.leather, { pos: [0, 0.25, 0], rot: [0, 0, -0.5] });
      t.cone(0.05, 0.22, 5, '#d8c8a0', { pos: [0.22, 0.02, -0.08], rot: [0, 0, 1.9] }); // hunting horn
      const h = k.at(B.head);
      hoodedHead(h, s, shadeHex(p.body, -0.04), '#c9a27e', '#2a2a24');
      hornPair(h, [0.1, 0.3, 0.06], [0.6, 1, 0.2], 0.42, 0.03, '#d8c8a0', -0.25, [0, 0, 1], 3); // antlers
      hornPair(h, [0.2, 0.42, 0.08], [1, 0.6, -0.2], 0.16, 0.018, '#d8c8a0', 0.2, [0, 0, 1], 2);
      weapon(k, B.elR, d.fore, 'spear', p);
      return bipedJoints(d);
    }
    case 'starfall_sentinel':
    case 'vault_keeper':
    case 'sentinel':
    case 'mud_golem':
    case 'crystal_golem':
    case 'obsidian_golem':
    case 'warden':
      return buildGolem(k, p);
    case 'ember_imp': {
      const d = avatarDims({ k: 0.85, leg: 0.75, arm: 0.95 });
      const skin = p.body;
      humanoid(k, d, { skin, shirt: skin, pants: p.dark, boots: p.deep, chest: 0.17, belly: 0.17, armR: 0.05, legR: 0.07 });
      const t = k.at(B.torso);
      for (let i = 0; i < 4; i++) t.box(0.02, 0.18, 0.02, '#ffd060', { pos: [-0.08 + i * 0.05, 0.2 + (i % 2) * 0.06, -0.17], rot: [0, 0, (i - 1.5) * 0.4], glow: 1 });
      const h = k.at(B.head);
      h.ball(0.2, skin, { pos: [0, 0.16, 0], scale: [1.05, 0.95, 1], detail: 1 });
      h.cone(0.06, 0.1, 4, p.dark, { pos: [0, 0.07, -0.19], rot: [-HALF - 0.3, 0, 0] }); // nose
      h.pair((b, o) => b.cone(0.06, 0.2, 4, skin, o), { pos: [0.2, 0.18, 0.02], rot: [0, 0, -1.2] }); // pointed ears
      eyes(h, 0.07, 0.2, -0.17, 0.035, { ...s, glowEyes: true, eye: '#ffe080' });
      demonHorns(h, 'small', '#3a1a10', 0, 0.3);
      // flame tuft on the head and a tail with a flame tip
      h.cone(0.08, 0.22, 5, '#ffb030', { pos: [0, 0.4, 0.04], glow: 1 });
      const tl = k.at(B.tail);
      horn(tl, [0, 0, 0], [0, -0.4, 1], 0.45, 0.04, skin, -0.5, [1, 0, 0], 3);
      tl.cone(0.06, 0.16, 5, '#ffb030', { pos: [0, 0.12, 0.38], rot: [0.4, 0, 0], glow: 1 });
      return bipedJoints(d);
    }
    case 'gloamling':
    case 'ember_demon':
    case 'cinder_fiend':
    case 'storm_ghoul':
    case 'grave_brute':
    case 'gale_reaver':
    case 'umbral_stalker':
    case 'void_maw':
    case 'sovereign':
      return buildDemon(k, p);
    default:
      return buildDemon(k, p);
  }
}

function buildGolem(k: Kit, p: Pal): Joint[] {
  const s = k.spec;
  const st = s.style;
  const warden = st === 'warden' || st === 'vault_keeper';
  const keeper = st === 'vault_keeper';
  const star = st === 'starfall_sentinel';
  const d = avatarDims({ wide: warden ? 1.35 : 1.55, arm: warden ? 1.05 : 1.2, leg: warden ? 0.95 : 0.78 });
  const stone = p.body;
  const glowCol = keeper ? '#ffe08a' : s.element < 8 ? s.accent : st === 'crystal_golem' ? '#bfe8ff' : st === 'obsidian_golem' ? '#ff7a22' : st === 'mud_golem' ? '#d0a050' : warden ? '#ffb040' : '#7fd8ff';
  const hips = k.at(B.hips);
  hips.box(0.5, 0.26, 0.34, p.dark, { pos: [0, -0.02, 0], jitter: 0.08 });
  const t = k.at(B.torso);
  const lumpy = st === 'mud_golem';
  if (lumpy) {
    const r = rng(5);
    t.ball(0.4, stone, { pos: [0, 0.32, 0], scale: [1.15, 1, 0.85], jitter: 0.1 });
    for (let i = 0; i < 8; i++) t.ball(0.14 + r() * 0.08, i % 3 ? stone : '#4f6a2a', { pos: [(r() - 0.5) * 0.7, 0.2 + r() * 0.5, (r() - 0.5) * 0.4], detail: 0 });
  } else {
    t.box(0.72, 0.5, 0.42, stone, { pos: [0, 0.34, 0], jitter: 0.08 });
    t.box(0.56, 0.26, 0.36, p.dark, { pos: [0, 0.06, 0] });
  }
  // glowing heart / rune lines
  t.ball(0.08, glowCol, { pos: [0, 0.36, -0.21], glow: 1, detail: 0 });
  if (!lumpy) for (let i = 0; i < 3; i++) t.box(0.03, 0.2, 0.02, glowCol, { pos: [-0.2 + i * 0.2, 0.36, -0.215], rot: [0, 0, (i - 1) * 0.6], glow: 0.9 });
  // shoulders: boulders / pauldrons / crystals
  for (const side of [-1, 1]) {
    if (star) for (let i = 0; i < 3; i++) t.add(new THREE.OctahedronGeometry(0.1 + i * 0.03, 0), i === 1 ? '#e8e0ff' : glowCol, { pos: [side * (0.3 + i * 0.07), d.shoulderY + 0.2 + i * 0.05, 0.04], scale: [0.6, 1.6, 0.6], rot: [0, 0, side * -0.5], glow: 0.9 });
    if (st === 'crystal_golem') for (let i = 0; i < 4; i++) t.cone(0.07 + i * 0.01, 0.34 + i * 0.06, 5, i % 2 ? glowCol : shadeHex(glowCol, -0.1), { pos: [side * (0.3 + i * 0.04), d.shoulderY + 0.1, -0.05 + i * 0.06], rot: [0.3 + i * 0.1, 0, side * -(0.4 + i * 0.15)], glow: 0.5 });
    else if (st === 'obsidian_golem') {
      // jagged glass shards, edged with lava
      for (let i = 0; i < 3; i++) t.add(new THREE.OctahedronGeometry(0.12 + i * 0.03, 0), i === 1 ? '#3a3040' : '#15121a', { pos: [side * (0.3 + i * 0.06), d.shoulderY + 0.14 + i * 0.05, 0.0], scale: [0.6, 1.8, 0.6], rot: [0, 0, side * -0.4], jitter: 0.04 });
      t.box(0.3, 0.2, 0.34, '#15121a', { pos: [side * (d.shoulderX + 0.02), d.shoulderY + 0.02, 0], rot: [0, 0, side * -0.3] });
      t.box(0.32, 0.03, 0.36, glowCol, { pos: [side * (d.shoulderX + 0.02), d.shoulderY - 0.1, 0], rot: [0, 0, side * -0.3], glow: 0.9 });
    } else t.box(0.3, 0.22, 0.34, warden ? '#5a5048' : stone, { pos: [side * (d.shoulderX + 0.02), d.shoulderY + 0.06, 0], rot: [0, 0, side * -0.3], jitter: 0.08 });
  }
  if (st === 'warden' || st === 'mud_golem') for (let i = 0; i < 6; i++) t.ball(0.07, '#5a7a30', { pos: [(i - 2.5) * 0.11, d.shoulderY + 0.12, 0.08 + (i % 2) * 0.06], scale: [1.2, 0.5, 1], detail: 0 }); // moss
  if (warden) {
    // a tattered tabard and a mossy cape
    t.box(0.34, 0.6, 0.03, keeper ? '#2a3a6a' : '#6a2a24', { pos: [0, 0.0, -0.22] });
    t.box(0.22, 0.08, 0.035, '#c8a050', { pos: [0, 0.2, -0.235] });
    if (keeper) for (let i = 0; i < 3; i++) t.box(0.74, 0.04, 0.44, '#c8a050', { pos: [0, 0.18 + i * 0.16, 0], glow: 0.1 }); // gilded bands
    const cape = k.at(B.tail);
    cape.box(0.66, 1.1, 0.04, keeper ? '#2a3a6a' : '#3a4a2a', { pos: [0, 0.0, 0.08], jitter: 0.1 });
  }
  // arms: thick stone limbs and big fists
  for (const [sh, el] of [
    [B.shL, B.elL],
    [B.shR, B.elR],
  ] as const) {
    const u = k.at(sh);
    if (lumpy) u.ball(0.13, stone, { pos: [0, -d.upper / 2, 0], scale: [1, 1.6, 1], detail: 0 });
    else u.box(0.2, d.upper, 0.2, stone, { pos: [0, -d.upper / 2, 0], jitter: 0.06 });
    const f = k.at(el);
    if (lumpy) f.ball(0.12, stone, { pos: [0, -d.fore / 2, 0], scale: [1, 1.6, 1], detail: 0 });
    else f.box(0.19, d.fore, 0.19, p.dark, { pos: [0, -d.fore / 2, 0] });
    if (st === 'crystal_golem') f.ball(0.17, glowCol, { pos: [0, -d.fore - 0.08, 0], glow: 0.45, detail: 0, scale: [1, 1.2, 1] });
    else f.box(0.27, 0.26, 0.27, warden ? '#5a5048' : stone, { pos: [0, -d.fore - 0.08, 0], jitter: 0.07 });
  }
  for (const [hp, kn] of [
    [B.hipL, B.knL],
    [B.hipR, B.knR],
  ] as const) {
    const u = k.at(hp);
    u.box(0.22, d.thigh, 0.24, stone, { pos: [0, -d.thigh / 2, 0], jitter: 0.06 });
    const l = k.at(kn);
    l.box(0.2, d.shin, 0.22, p.dark, { pos: [0, -d.shin / 2, 0] });
    l.box(0.28, 0.12, 0.36, stone, { pos: [0, -d.shin + 0.05, -0.05] });
  }
  // a small head sunk between the shoulders
  const h = k.at(B.head);
  if (keeper) {
    // a hooded stone face with a glowing slit and a crown of keys
    h.box(0.28, 0.32, 0.28, '#7a7468', { pos: [0, 0.12, 0] });
    h.sphere(0.24, 7, 4, '#2a3a6a', { pos: [0, 0.16, 0.03], thetaLen: PI * 0.6 });
    h.box(0.2, 0.04, 0.03, glowCol, { pos: [0, 0.14, -0.145], glow: 1 });
    for (let i = 0; i < 5; i++) h.box(0.03, 0.16, 0.03, '#c8a050', { pos: [(i - 2) * 0.07, 0.36, 0], rot: [0, 0, (i - 2) * 0.2] });
  } else if (warden) {
    h.box(0.3, 0.32, 0.3, '#5a5048', { pos: [0, 0.12, 0] });
    h.box(0.22, 0.05, 0.03, glowCol, { pos: [0, 0.15, -0.155], glow: 1 });
    demonHorns(h, 'curl', '#bfb49a', 0, 0.22);
  } else if (st === 'sentinel' || star) {
    h.box(0.26, 0.24, 0.26, stone, { pos: [0, 0.06, 0], rot: [0, PI / 4, 0] });
    h.box(0.04, 0.1, 0.04, glowCol, { pos: [0, 0.08, -0.17], glow: 1 });
    h.cone(0.06, 0.2, 4, p.dark, { pos: [0, 0.27, 0] });
  } else {
    h.ball(0.15, stone, { pos: [0, 0.06, -0.04], detail: 0 });
    eyes(h, 0.06, 0.08, -0.16, 0.03, { ...s, glowEyes: true, eye: glowCol });
    if (st === 'crystal_golem') h.cone(0.05, 0.26, 4, glowCol, { pos: [0, 0.24, 0], glow: 0.6 });
    if (st === 'obsidian_golem') for (let i = 0; i < 3; i++) h.cone(0.04, 0.22 + (i % 2) * 0.08, 4, '#15121a', { pos: [(i - 1) * 0.07, 0.2, 0.0], rot: [0, 0, (i - 1) * 0.3] });
  }
  if (st === 'warden') weapon(k, B.elR, d.fore, 'hammer', p);
  if (keeper) weapon(k, B.elR, d.fore, 'keystaff', p);
  if (star) k.at(B.torso).add(new THREE.OctahedronGeometry(0.14, 0), '#f0e8ff', { pos: [0, 0.36, -0.24], glow: 1 }); // a fallen star in the chest
  return bipedJoints({ ...d, neckY: d.neckY - 0.08 });
}

function buildDemon(k: Kit, p: Pal): Joint[] {
  const s = k.spec;
  const st = s.style;
  const el = s.element < 8 ? s.accent : '#ff3b2a';
  const big = st === 'grave_brute' || st === 'cinder_fiend' || st === 'void_maw' || st === 'sovereign';
  const lean = st === 'gloamling' || st === 'ember_demon' || st === 'umbral_stalker' || st === 'gale_reaver' || st === 'storm_ghoul';
  const d = avatarDims({ wide: big ? 1.35 : 1.05, arm: lean ? 1.3 : 1.18, leg: st === 'umbral_stalker' ? 1.1 : 0.95 });
  const skin = p.body;
  humanoid(k, d, { skin, shirt: skin, pants: p.dark, boots: p.deep, chest: big ? 0.26 : 0.19, belly: st === 'void_maw' ? 0.3 : undefined, armR: big ? 0.085 : 0.055, legR: big ? 0.1 : 0.07 });
  const t = k.at(B.torso);
  // a spined back
  for (let i = 0; i < 4; i++) t.cone(0.04 + (big ? 0.02 : 0), 0.16 + i * 0.03, 4, p.deep, { pos: [0, 0.12 + i * 0.12, 0.14 + (big ? 0.05 : 0)], rot: [1.1, 0, 0] });
  // glowing cracks / runes on the chest
  const cracks = st === 'ember_demon' || st === 'cinder_fiend' || st === 'storm_ghoul' || st === 'sovereign' || st === 'grave_brute';
  if (cracks) for (let i = 0; i < 5; i++) t.box(0.02, 0.22, 0.02, el, { pos: [-0.12 + i * 0.06, 0.18 + (i % 2) * 0.12, -(big ? 0.22 : 0.17)], rot: [0, 0, (i - 2) * 0.5], glow: 1 });
  if (st === 'void_maw') {
    // a maw in the belly: a ring of glowing teeth
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * PI * 2;
      t.cone(0.025, 0.1, 3, '#e8e0f0', { pos: [Math.cos(a) * 0.14, 0.14 + Math.sin(a) * 0.1, -0.3], rot: [-HALF, 0, a + HALF], glow: 0.3 });
    }
    t.ball(0.12, el, { pos: [0, 0.14, -0.24], scale: [1, 0.7, 0.4], glow: 1, detail: 0 });
  }
  if (st === 'grave_brute') {
    // bone plates on the shoulders
    for (const side of [-1, 1]) t.sphere(0.2, 6, 3, p.bone, { pos: [side * (d.shoulderX + 0.02), d.shoulderY + 0.06, 0], scale: [1, 0.6, 1.1], thetaLen: PI * 0.55 });
  }
  if (st === 'sovereign') {
    // armour plates and a cape (the tail joint)
    for (const side of [-1, 1]) t.sphere(0.2, 6, 3, '#2a1a20', { pos: [side * (d.shoulderX + 0.03), d.shoulderY + 0.06, 0], scale: [1.1, 0.7, 1.1], thetaLen: PI * 0.55 });
    t.box(0.4, 0.06, 0.3, '#c8a050', { pos: [0, d.shoulderY + 0.07, 0], glow: 0.15 });
    k.at(B.tail).box(0.7, 1.15, 0.04, '#3a0a14', { pos: [0, 0.0, 0.1], jitter: 0.1 });
  } else if (st !== 'grave_brute') {
    const tl = k.at(B.tail);
    horn(tl, [0, -0.05, 0], [0, -0.6, 1], lean ? 0.7 : 0.5, 0.045, skin, -0.3, [1, 0, 0], 4);
    tl.cone(0.05, 0.12, 3, el, { pos: [0, lean ? -0.12 : -0.08, lean ? 0.66 : 0.48], rot: [1.9, 0, 0], glow: 0.6 });
  }
  if (st === 'ember_demon') {
    // a crown of flame, smouldering shoulders
    for (const side of [-1, 1]) for (let i = 0; i < 3; i++) t.cone(0.05, 0.22 + i * 0.04, 4, i % 2 ? '#ffc04a' : '#ff6a1a', { pos: [side * (d.shoulderX + 0.02 + i * 0.03), d.shoulderY + 0.1 + i * 0.05, 0.02], rot: [0, 0, side * -(0.2 + i * 0.2)], glow: 0.9 });
    for (let i = 0; i < 5; i++) k.at(B.head).cone(0.05, 0.28 - Math.abs(i - 2) * 0.05, 4, i % 2 ? '#ffc04a' : '#ff6a1a', { pos: [(i - 2) * 0.06, 0.34, 0.02], rot: [0, 0, (i - 2) * 0.22], glow: 1 });
  }
  if (st === 'gale_reaver') for (const e of [B.elL, B.elR]) k.at(e).cone(0.04, 0.6, 4, el, { pos: [0, -d.fore - 0.1, -0.24], rot: [-HALF - 0.4, 0, 0], scale: [0.5, 1, 1.4], glow: 0.35 }); // blade arms
  if (st === 'storm_ghoul') for (let i = 0; i < 3; i++) t.cone(0.03, 0.3, 3, el, { pos: [(i - 1) * 0.12, d.shoulderY + 0.12, 0.08], rot: [0.5, 0, (i - 1) * 0.4], glow: 0.8 });
  if (st === 'umbral_stalker') for (let i = 0; i < 4; i++) t.cone(0.08, 0.5, 4, '#100818', { pos: [(i - 1.5) * 0.1, 0.0, 0.16], rot: [2.6, 0, (i - 1.5) * 0.2] }); // shadow rags
  // head: a skull-ish face with glowing eyes and horns
  const h = k.at(B.head);
  const hw = big ? 0.18 : 0.15;
  h.ball(hw, skin, { pos: [0, 0.1, -0.02], scale: [1, 0.95, 1.1], detail: 1 });
  h.box(hw * 1.1, 0.08, hw * 0.9, p.dark, { pos: [0, 0.0, -0.1] }); // jaw
  for (let i = 0; i < 4; i++) h.cone(0.012, 0.04, 3, p.bone, { pos: [(i - 1.5) * 0.03, 0.04, -0.17], rot: [PI, 0, 0] });
  h.box(hw * 1.3, 0.03, 0.05, p.deep, { pos: [0, 0.16, -0.14], rot: [0.2, 0, 0] }); // heavy brow
  eyes(h, 0.06, 0.12, -0.15, 0.03, s);
  const hornCol = st === 'sovereign' ? '#1a1014' : st === 'grave_brute' ? p.bone : '#2a1a14';
  const hornKind = st === 'sovereign' ? 'crown' : st === 'cinder_fiend' || st === 'grave_brute' ? 'curl' : st === 'storm_ghoul' || st === 'gale_reaver' ? 'spikes' : st === 'void_maw' ? 'ram' : 'small';
  demonHorns(h, hornKind, hornCol, st === 'sovereign' ? 0.25 : 0, big ? 0.22 : 0.19);
  if (st === 'sovereign') h.ball(0.05, el, { pos: [0, 0.28, -0.12], glow: 1, detail: 0 });
  clawHands(k, d, p.bone, big ? 0.18 : 0.14, 0);
  if (st === 'sovereign') weapon(k, B.elR, d.fore, 'cleaver', p, 1.1);
  return bipedJoints(d);
}

// ── Floaters ──────────────────────────────────────────────────────────────

function buildFloater(k: Kit, p: Pal): Joint[] {
  const s = k.spec;
  const st = s.style;
  const glowCol = s.element < 8 ? s.accent : mixHex(p.body, '#ffffff', 0.4);
  if (st === 'shade' || st === 'rime_wraith' || st === 'archon') {
    // a hooded, legless robed figure: robe (core), hood (head), floating hands
    const archon = st === 'archon';
    const tall = st === 'rime_wraith' ? 1.2 : archon ? 1.25 : 1;
    const d = { coreY: 0.75 * tall, handX: 0.42 * tall, handY: 0.25 * tall, headY: 0.55 * tall };
    const core = k.at(F.core);
    const robe = archon ? '#3a2a5a' : p.body;
    core.lathe(
      [
        [0.08, 0.62],
        [0.22, 0.5],
        [0.27, 0.25],
        [0.3, 0],
        [0.36, -0.3],
        [0.42, -0.55],
        [0.01, -0.56],
      ].map(([r, y]) => [r * tall, y * tall] as [number, number]),
      7,
      robe,
      { jitter: 0.07 },
    );
    if (archon) {
      core.cyl(0.32, 0.36, 0.08, 7, '#c8a050', { pos: [0, 0.05, 0], glow: 0.15 });
      for (let i = 0; i < 5; i++) core.box(0.03, 0.3, 0.02, glowCol, { pos: [Math.sin((i - 2) * 0.35) * 0.4, -0.35, -Math.cos((i - 2) * 0.35) * 0.4], rot: [0, (i - 2) * 0.35, 0], glow: 1 });
    }
    // tattered hem trails (tail joint)
    const tl = k.at(F.tail);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * PI * 2;
      tl.cone(0.1 * tall, 0.36 * tall, 3, p.dark, { pos: [Math.cos(a) * 0.3 * tall, -0.62 * tall, Math.sin(a) * 0.3 * tall], rot: [PI, 0, 0] });
    }
    const h = k.at(F.head);
    h.sphere(0.2 * tall, 7, 5, robe, { pos: [0, 0, 0.02], thetaLen: PI * 0.7 });
    h.cone(0.2 * tall, 0.3 * tall, 7, robe, { pos: [0, 0.16 * tall, 0.06], rot: [0.35, 0, 0] });
    h.sphere(0.15 * tall, 6, 4, '#0a0610', { pos: [0, -0.02, -0.06] });
    eyes(h, 0.055 * tall, 0.0, -0.16 * tall, 0.032, { ...s, glowEyes: true, eye: glowCol });
    if (st === 'rime_wraith') for (let i = 0; i < 5; i++) h.cone(0.03, 0.26, 4, glowCol, { pos: [(i - 2) * 0.07, 0.28, 0.02], rot: [0.2, 0, (i - 2) * 0.25], glow: 0.7 });
    if (archon) {
      // a halo (ring joint) and orbs
      const ring = k.at(F.ring);
      ring.add(new THREE.TorusGeometry(0.5, 0.035, 4, 18), glowCol, { pos: [0, 0.95, 0.2], rot: [HALF - 0.25, 0, 0], glow: 1 });
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * PI * 2;
        ring.ball(0.11, glowCol, { pos: [Math.cos(a) * 0.85, 0.1, Math.sin(a) * 0.85], glow: 1, detail: 0 });
      }
    }
    for (const hand of [F.handL, F.handR]) {
      const b = k.at(hand);
      const side = hand === F.handL ? -1 : 1;
      b.cyl(0.07, 0.1, 0.22, 5, robe, { pos: [0, 0.1, 0.05], rot: [0.5, 0, 0] }); // a sleeve
      b.ball(0.07, archon ? '#c0b0e0' : '#2a2030', { detail: 0, scale: [1, 1.2, 0.8] });
      for (let i = 0; i < 3; i++) horn(b, [(i - 1) * 0.03, -0.05, -0.02], [(i - 1) * 0.2, -1, -0.5], 0.14, 0.015, archon ? '#e0d8f0' : '#1a1020', 0.35, [1, 0, 0], 2);
      if (st === 'rime_wraith' && side > 0) b.cone(0.05, 1.1, 4, glowCol, { pos: [0, -0.05, -0.45], rot: [-HALF, 0, 0], glow: 0.6 });
      if (archon) b.ball(0.09, glowCol, { pos: [0, -0.16, -0.08], glow: 1, detail: 0 });
    }
    return floaterJoints(d);
  }
  if (st === 'the_hush') {
    // CR 035's final boss, its own figure: a towering mourning veil with no
    // body under it, a featureless porcelain mask split by one glowing crack,
    // a crown of broken tuning-fork tines, a ribcage opening in the veil over
    // the stolen songs (a dim violet heart), long sleeves and long pale
    // fingers, a broken halo of silence and ribbons that trail into nothing.
    const d = { coreY: 1.25, handX: 0.62, handY: 0.42, headY: 0.82 };
    const veil = p.body;
    const lining = mixHex(p.body, '#5a3a7a', 0.45);
    const bone = '#e6e1ee';
    const silver = '#b9b3cc';
    const glow = '#c9a8ff';
    const core = k.at(F.core);
    // the veil: a tall narrow column that flares into a long hem
    core.lathe(
      [
        [0.06, 0.78],
        [0.2, 0.7],
        [0.3, 0.6],
        [0.26, 0.35],
        [0.24, 0.1],
        [0.3, -0.2],
        [0.4, -0.5],
        [0.5, -0.78],
        [0.01, -0.8],
      ],
      9,
      veil,
      { jitter: 0.08, shade: 0.35 },
    );
    // high draped shoulders
    core.pair((b, o) => b.cone(0.16, 0.42, 5, shadeHex(veil, 0.04), { ...o, jitter: 0.08 }), { pos: [0.26, 0.6, 0.02], rot: [0, 0, -1.1] });
    // the opening in the veil: a lining, ribs of bone and the stolen songs
    core.sphere(0.17, 7, 5, lining, { pos: [0, 0.38, -0.17], scale: [1, 1.25, 0.45] });
    core.ball(0.085, glow, { pos: [0, 0.38, -0.2], glow: 1, detail: 1 });
    core.ball(0.05, '#ffffff', { pos: [0, 0.38, -0.25], glow: 1, detail: 0 });
    for (let i = 0; i < 3; i++) {
      const y = 0.29 + i * 0.08;
      core.pair((b, o) => b.box(0.12 - Math.abs(i - 1) * 0.02, 0.016, 0.022, shadeHex(bone, -0.18), { ...o, rot: [0, 0.5, 0.3] }), { pos: [0.07, y, -0.235] });
    }
    // a hem of faint motes where the veil stops being cloth
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * PI * 2;
      core.ball(0.03, glow, { pos: [Math.cos(a) * 0.46, -0.74, Math.sin(a) * 0.46], glow: 0.8, detail: 0 });
    }
    // ribbons that trail into nothing (the tail joint sways them)
    const tl = k.at(F.tail);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * PI * 2 + 0.2;
      const len = 0.3 + (i % 3) * 0.08;
      tl.cone(0.07, len, 3, i % 2 ? veil : shadeHex(veil, -0.05), { pos: [Math.cos(a) * 0.4, -0.74 - len * 0.5, Math.sin(a) * 0.4], rot: [PI + Math.sin(a) * 0.25, 0, Math.cos(a) * 0.25], scale: [1, 1, 0.35] });
    }
    // the head: a hood around a featureless mask with one glowing crack
    const h = k.at(F.head);
    // the hood, open at the front (-Z) so the mask shows
    h.add(new THREE.SphereGeometry(0.21, 9, 6, PI * 1.5 + 0.85, PI * 2 - 1.7, 0, PI * 0.78), veil, { pos: [0, 0.02, 0.03] });
    h.sphere(0.2, 8, 5, '#07050c', { pos: [0, 0.0, 0.06], scale: [0.95, 1, 0.8] }); // the dark inside of the hood
    h.cone(0.2, 0.34, 8, veil, { pos: [0, 0.2, 0.08], rot: [0.28, 0, 0] });
    h.sphere(0.13, 8, 6, bone, { pos: [0, 0, -0.07], scale: [0.85, 1.15, 0.75], jitter: 0.03, shade: 0.12 });
    h.box(0.012, 0.2, 0.012, glow, { pos: [0.02, 0.0, -0.165], rot: [0, 0, 0.12], glow: 1 });
    h.box(0.01, 0.07, 0.01, glow, { pos: [0.045, -0.07, -0.16], rot: [0, 0, -0.5], glow: 1 });
    // the crown of broken tines (a tuning fork's two prongs, snapped at different heights)
    for (let i = 0; i < 7; i++) {
      const a = (i - 3) * 0.32;
      const len = 0.26 + (i % 2 ? 0.12 : 0.24) * (1 - Math.abs(i - 3) / 4);
      h.box(0.022, len, 0.022, i % 3 === 0 ? silver : bone, { pos: [Math.sin(a) * 0.17, 0.2 + len / 2, 0.04 + Math.cos(a) * 0.06 - 0.04], rot: [0.1, 0, -a * 0.55], jitter: 0.03 });
      if (i % 2 === 0) h.box(0.03, 0.03, 0.03, glow, { pos: [Math.sin(a) * 0.17 - Math.sin(a * 0.55) * len, 0.2 + len, 0.0], glow: 0.9 });
    }
    // the broken halo of silence and the songs it keeps (ring joint: turns slowly)
    const ring = k.at(F.ring);
    for (let i = 0; i < 5; i++) {
      const a0 = (i / 5) * PI * 2;
      ring.add(new THREE.TorusGeometry(0.62, 0.02, 3, 6, PI * 0.28), silver, { pos: [0, 1.08, 0.24], rot: [HALF - 0.2, 0, a0], glow: 0.25 });
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * PI * 2 + 0.4;
      ring.add(new THREE.OctahedronGeometry(0.06, 0), glow, { pos: [Math.cos(a) * 0.9, -0.1 + (i % 2) * 0.18, Math.sin(a) * 0.9], scale: [0.6, 1.4, 0.6], glow: 1 });
    }
    // long sleeves and long pale fingers
    for (const hand of [F.handL, F.handR]) {
      const b = k.at(hand);
      const side = hand === F.handL ? -1 : 1;
      // a long sleeve: narrow at the wrist, draping down into a ragged open end
      b.cone(0.14, 0.62, 6, veil, { pos: [0, -0.2, 0.09], rot: [0.25, 0, 0], jitter: 0.08, shade: 0.3 });
      b.cone(0.05, 0.26, 3, shadeHex(veil, -0.05), { pos: [side * 0.06, -0.58, 0.16], rot: [PI + 0.2, 0, side * 0.2], scale: [1, 1, 0.4] });
      b.ball(0.06, bone, { detail: 0, scale: [1, 1.3, 0.7] });
      for (let i = 0; i < 4; i++) horn(b, [(i - 1.5) * 0.028, -0.05, -0.02], [(i - 1.5) * 0.18, -1, -0.35], 0.34, 0.014, bone, 0.22, [1, 0, 0], 3);
      horn(b, [0.05, -0.02, -0.03], [0.6, -0.6, -0.4], 0.16, 0.012, bone, 0.25, [1, 0, 0], 2);
    }
    return floaterJoints(d);
  }
  if (st === 'hollow_bell') {
    // "A bell with no clapper that tolls anyway": an old bronze bell gone
    // dark, hung from nothing by a broken chain, cracks of violet light, a
    // hollow mouth that glows where the clapper should be, and rings of
    // sound around its lip (ring joint: they spread when it tolls).
    const d = { coreY: 0.95, handX: 0, handY: 0, headY: 0.42 };
    const bronze = mixHex(p.body, '#8a6a3e', 0.62);
    const verd = mixHex(bronze, '#4f7a6a', 0.35);
    const glow = '#b98cff';
    const core = k.at(F.core);
    // outer wall: crown, shoulder, waist, the flared lip (top to bottom: faces out)
    const outer: [number, number][] = [
      [0.02, 0.42],
      [0.17, 0.4],
      [0.22, 0.34],
      [0.23, 0.18],
      [0.25, 0.0],
      [0.3, -0.18],
      [0.4, -0.32],
      [0.42, -0.38],
    ];
    core.lathe(outer, 12, bronze, { jitter: 0.06, shade: 0.3 });
    // inner wall, bottom to top (faces in): the hollow you see under the lip
    core.lathe(
      [
        [0.385, -0.37],
        [0.34, -0.28],
        [0.25, -0.12],
        [0.2, 0.08],
        [0.17, 0.3],
        [0.02, 0.33],
      ],
      12,
      '#120c18',
      { jitter: 0.02, shade: 0 },
    );
    // the lip's bead and a band of verdigris at the shoulder
    core.add(new THREE.TorusGeometry(0.405, 0.025, 4, 16), verd, { pos: [0, -0.37, 0], rot: [HALF, 0, 0] });
    core.add(new THREE.TorusGeometry(0.225, 0.018, 4, 14), verd, { pos: [0, 0.3, 0], rot: [HALF, 0, 0] });
    core.add(new THREE.TorusGeometry(0.255, 0.014, 4, 14), verd, { pos: [0, 0.02, 0], rot: [HALF, 0, 0] });
    // the glow where the clapper should be, and inside the lip
    core.ball(0.09, glow, { pos: [0, -0.12, 0], glow: 1, detail: 1 });
    core.add(new THREE.TorusGeometry(0.37, 0.012, 3, 16), glow, { pos: [0, -0.355, 0], rot: [HALF, 0, 0], glow: 1 });
    // cracks of light (a jagged line of short glowing slivers down the side)
    const crack = (a: number, y0: number, n: number) => {
      let y = y0;
      let aa = a;
      for (let i = 0; i < n; i++) {
        const r = 0.235 + Math.max(0, -y) * 0.38 + 0.008;
        core.box(0.016, 0.085, 0.012, glow, { pos: [Math.sin(aa) * r, y - 0.04, -Math.cos(aa) * r], rot: [0, -aa, (i % 2 ? 0.45 : -0.45)], glow: 1 });
        y -= 0.075;
        aa += i % 2 ? 0.05 : -0.04;
      }
    };
    crack(0.2, 0.26, 7);
    crack(2.4, 0.12, 5);
    crack(4.3, 0.2, 6);
    // the crown loop and a broken chain up into nothing (head joint)
    const h = k.at(F.head);
    h.add(new THREE.TorusGeometry(0.075, 0.025, 4, 10), bronze, { pos: [0, 0.06, 0] });
    for (let i = 0; i < 3; i++) h.add(new THREE.TorusGeometry(0.05, 0.016, 4, 8), '#2a2430', { pos: [0, 0.2 + i * 0.085, 0], rot: [0, (i % 2) * HALF, 0], jitter: 0.03 });
    h.box(0.02, 0.05, 0.02, glow, { pos: [0, 0.45, 0], rot: [0.3, 0, 0.4], glow: 0.9 });
    // rings of sound (they spread on the toll)
    const ring = k.at(F.ring);
    ring.add(new THREE.TorusGeometry(0.55, 0.012, 3, 20), glow, { pos: [0, -0.3, 0], rot: [HALF, 0, 0], glow: 0.9 });
    ring.add(new THREE.TorusGeometry(0.7, 0.008, 3, 22), glow, { pos: [0, -0.24, 0], rot: [HALF, 0, 0], glow: 0.6 });
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * PI * 2;
      ring.add(new THREE.OctahedronGeometry(0.035, 0), bronze, { pos: [Math.cos(a) * 0.62, 0.05, Math.sin(a) * 0.62], scale: [0.7, 1.6, 0.7] });
    }
    return floaterJoints(d);
  }
  if (st === 'sunlit_sentinel') {
    // the light summon's turret: a faceted crystal over a turning ring
    const d = { coreY: 1.2, handX: 0, handY: 0, headY: 0 };
    const core = k.at(F.core);
    core.add(new THREE.OctahedronGeometry(0.42, 0), p.body, { scale: [1, 1.7, 1], glow: 0.7 });
    core.add(new THREE.OctahedronGeometry(0.2, 0), '#ffffff', { glow: 1 });
    const ring = k.at(F.ring);
    ring.add(new THREE.TorusGeometry(0.62, 0.05, 4, 16), p.body, { pos: [0, -0.85, 0], rot: [HALF, 0, 0], glow: 0.6 });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * PI * 2;
      ring.cone(0.07, 0.28, 4, p.light, { pos: [Math.cos(a) * 0.62, -0.75, Math.sin(a) * 0.62], glow: 0.8 });
    }
    return floaterJoints(d);
  }
  // elemental motes: a core with a ring of bits
  const d = { coreY: 0.8, handX: 0.4, handY: 0, headY: 0 };
  const core = k.at(F.core);
  const ring = k.at(F.ring);
  if (st === 'frost_mote') {
    const r = rng(3);
    core.add(new THREE.OctahedronGeometry(0.22, 0), '#e8f6ff', { glow: 0.6, scale: [1, 1.3, 1] });
    for (let i = 0; i < 9; i++) {
      const dir = new THREE.Vector3(r() - 0.5, r() - 0.3, r() - 0.5).normalize();
      core.cone(0.07, 0.3 + r() * 0.2, 4, i % 2 ? p.body : '#dff2ff', { pos: [dir.x * 0.2, dir.y * 0.2, dir.z * 0.2], rot: aimRot(dir), glow: 0.35 });
    }
    eyes(core, 0.07, 0.04, -0.2, 0.03, { ...s, glowEyes: true, eye: '#2a4a6a' });
    for (let i = 0; i < 5; i++) ring.add(new THREE.OctahedronGeometry(0.05, 0), '#ffffff', { pos: [Math.cos(i * 1.26) * 0.45, Math.sin(i * 2.1) * 0.1, Math.sin(i * 1.26) * 0.45], glow: 0.8 });
  } else if (st === 'spark_wisp') {
    core.ball(0.2, '#fff6c0', { glow: 1, detail: 1 });
    for (let i = 0; i < 10; i++) {
      const a = i * 2.4;
      const dir = new THREE.Vector3(Math.cos(a) * Math.sin(i * 0.9 + 0.4), Math.cos(i * 0.9 + 0.4), Math.sin(a) * Math.sin(i * 0.9 + 0.4)).normalize();
      core.cone(0.045, 0.28, 3, p.body, { pos: [dir.x * 0.2, dir.y * 0.2, dir.z * 0.2], rot: aimRot(dir), glow: 0.8 });
    }
    for (let i = 0; i < 4; i++) ring.box(0.03, 0.18, 0.03, '#ffffff', { pos: [Math.cos(i * 1.57) * 0.4, 0, Math.sin(i * 1.57) * 0.4], rot: [0.5, 0, i], glow: 1 });
  } else {
    // arcane wisp: a crystal in a turning ring of motes
    core.add(new THREE.OctahedronGeometry(0.2, 0), p.body, { scale: [1, 1.5, 1], glow: 0.75 });
    core.add(new THREE.OctahedronGeometry(0.1, 0), '#ffffff', { glow: 1 });
    ring.add(new THREE.TorusGeometry(0.36, 0.02, 3, 16), glowCol, { rot: [HALF, 0, 0], glow: 0.8 });
    for (let i = 0; i < 3; i++) ring.ball(0.05, '#ffffff', { pos: [Math.cos(i * 2.09) * 0.36, 0, Math.sin(i * 2.09) * 0.36], glow: 1, detail: 0 });
  }
  return floaterJoints(d);
}

// ── Winged ────────────────────────────────────────────────────────────────

function buildWinged(k: Kit, p: Pal): Joint[] {
  const s = k.spec;
  const st = s.style;
  if (st === 'gloom_bat') {
    const d = { bodyY: 0.8, wingX: 0.14, span: 0.9, headZ: -0.14 };
    const body = k.at(W.body);
    body.ball(0.2, p.body, { scale: [1, 1.1, 1], detail: 1, jitter: 0.1 });
    body.ball(0.14, p.belly, { pos: [0, -0.04, -0.08], detail: 0 });
    const h = k.at(W.head);
    h.ball(0.13, p.body, { pos: [0, 0.04, -0.02], detail: 1 });
    h.pair((b, o) => b.cone(0.07, 0.26, 4, p.dark, { ...o, scale: [1, 1, 0.5] }), { pos: [0.08, 0.2, 0.0], rot: [0, 0, -0.35] });
    h.box(0.06, 0.05, 0.05, '#c88a90', { pos: [0, 0.0, -0.13] });
    h.pair((b, o) => b.cone(0.012, 0.05, 3, '#ffffff', { ...o, rot: [PI, 0, 0] }), { pos: [0.03, -0.04, -0.12] });
    eyes(h, 0.05, 0.07, -0.11, 0.025, { ...s, glowEyes: true });
    for (const [inner, outer, side] of [
      [W.wingL, W.wingLo, -1],
      [W.wingR, W.wingRo, 1],
    ] as const) {
      const a = k.at(inner);
      a.ball(0.25, p.dark, { pos: [side * 0.22, 0, 0.04], scale: [1, 0.06, 0.8], detail: 1 });
      a.cyl(0.015, 0.02, 0.45, 4, p.deep, { pos: [side * 0.22, 0.02, -0.14], rot: [0, 0, HALF] });
      const o = k.at(outer);
      o.ball(0.28, p.dark, { pos: [side * 0.22, 0, 0.08], scale: [1, 0.05, 0.85], detail: 1 });
      for (let i = 0; i < 3; i++) o.cyl(0.008, 0.014, 0.4, 3, p.deep, { pos: [side * 0.18, 0.02, 0.0 + i * 0.1], rot: [0, -side * (0.5 + i * 0.4), HALF] });
    }
    k.at(W.legs).pair((b, o) => b.cone(0.02, 0.12, 3, p.deep, { ...o, rot: [PI, 0, 0] }), { pos: [0.06, -0.12, 0.05] });
    return wingedJoints(d);
  }
  if (st === 'lumen_moth') {
    const d = { bodyY: 0.85, wingX: 0.08, span: 0.8, headZ: -0.24 };
    const fur = mixHex(p.body, '#fff0c8', 0.5);
    const body = k.at(W.body);
    body.sphere(0.13, 6, 5, fur, { pos: [0, 0, 0.02], scale: [1, 1, 1.6], jitter: 0.1 });
    const tl = k.at(W.tail);
    tl.sphere(0.12, 6, 5, p.body, { pos: [0, -0.02, 0.18], scale: [1, 0.9, 2.2] });
    for (let i = 0; i < 3; i++) tl.cyl(0.11 - i * 0.02, 0.12 - i * 0.02, 0.03, 6, s.accent, { pos: [0, -0.02, 0.12 + i * 0.12], rot: [HALF, 0, 0], glow: 0.6 });
    const h = k.at(W.head);
    h.ball(0.11, fur, { detail: 1 });
    eyes(h, 0.07, 0.02, -0.07, 0.045, { ...s, glowEyes: true, eye: '#2a2010' });
    hornPair(h, [0.04, 0.08, -0.06], [0.3, 1, -0.6], 0.3, 0.012, '#6a5030', -0.6, [1, 0, 0], 3);
    for (const [inner, outer, side] of [
      [W.wingL, W.wingLo, -1],
      [W.wingR, W.wingRo, 1],
    ] as const) {
      const a = k.at(inner);
      a.ball(0.3, p.body, { pos: [side * 0.28, 0, -0.08], scale: [1, 0.04, 0.85], detail: 1 });
      a.ball(0.08, s.accent, { pos: [side * 0.3, 0.015, -0.1], scale: [1, 0.2, 1], glow: 1, detail: 0 });
      const o = k.at(outer);
      o.ball(0.24, shadeHex(p.body, -0.06), { pos: [side * 0.12, 0, 0.22], scale: [1, 0.04, 1.05], detail: 1 });
      o.ball(0.05, s.accent, { pos: [side * 0.14, 0.012, 0.24], scale: [1, 0.2, 1], glow: 1, detail: 0 });
    }
    return wingedJoints(d);
  }
  if (st === 'sky_wyvern') {
    // a long-necked sky drake: leathery spread wings on finger bones, a barbed tail, hind talons
    const d = { bodyY: 0.95, wingX: 0.2, span: 1.5, headZ: -0.42 };
    const body = k.at(W.body);
    body.sphere(0.24, 7, 5, p.body, { scale: [0.85, 0.85, 1.7], jitter: 0.07 });
    body.sphere(0.17, 6, 4, p.belly, { pos: [0, -0.1, -0.05], scale: [0.8, 0.7, 1.6] });
    for (let i = 0; i < 5; i++) body.cone(0.04, 0.13, 4, p.dark, { pos: [0, 0.2 - i * 0.012, -0.28 + i * 0.14], rot: [0.2, 0, 0] });
    const h = k.at(W.head);
    h.cyl(0.07, 0.1, 0.3, 5, p.body, { pos: [0, 0.0, 0.12], rot: [HALF - 0.2, 0, 0] });
    h.sphere(0.12, 6, 4, p.body, { pos: [0, 0.02, -0.08], scale: [0.9, 0.8, 1.3] });
    h.cone(0.05, 0.16, 4, p.dark, { pos: [0, 0.0, -0.24], rot: [-HALF, 0, 0] });
    eyes(h, 0.07, 0.06, -0.14, 0.03, { ...s, glowEyes: true });
    h.pair((b, o) => b.cone(0.03, 0.26, 4, p.bone, o), { pos: [0.06, 0.08, 0.0], rot: [1.1, 0, -0.35] });
    for (const [inner, outer, side] of [
      [W.wingL, W.wingLo, -1],
      [W.wingR, W.wingRo, 1],
    ] as const) {
      const a = k.at(inner);
      a.cyl(0.03, 0.05, 0.6, 5, p.dark, { pos: [side * 0.3, 0.02, -0.02], rot: [0, 0, HALF] });
      a.ball(0.34, shadeHex(s.accent, -0.2, -0.3), { pos: [side * 0.3, -0.02, 0.2], scale: [1, 0.04, 0.9], detail: 1 });
      const o = k.at(outer);
      for (let i = 0; i < 3; i++) o.cyl(0.012, 0.02, 0.6 - i * 0.1, 4, p.dark, { pos: [side * (0.28 - i * 0.04), 0.0, i * 0.16], rot: [0, -side * (0.3 + i * 0.35), HALF] });
      o.ball(0.34, shadeHex(s.accent, -0.2, -0.3), { pos: [side * 0.2, -0.02, 0.2], scale: [1, 0.04, 0.9], detail: 1 });
    }
    const tl = k.at(W.tail);
    horn(tl, [0, 0, 0], [0, -0.1, 1], 0.7, 0.08, p.body, 0.2, [1, 0, 0], 4);
    tl.cone(0.08, 0.2, 4, p.bone, { pos: [0, -0.12, 0.72], rot: [1.9, 0, 0] });
    const lg = k.at(W.legs);
    lg.pair((b, o) => b.cyl(0.03, 0.05, 0.28, 4, p.dark, o), { pos: [0.1, -0.18, 0.08] });
    hornPair(lg, [0.1, -0.34, 0.06], [0, -0.3, -1], 0.14, 0.02, p.bone, 0.6, [1, 0, 0], 2);
    return wingedJoints(d);
  }
  // gale harpy: a feathered bird-woman, wings of long feathers, talons
  const d = { bodyY: 0.95, wingX: 0.18, span: 1.1, headZ: -0.16 };
  const body = k.at(W.body);
  body.sphere(0.24, 7, 5, p.body, { scale: [0.9, 1.25, 1], jitter: 0.08 });
  body.sphere(0.18, 6, 4, p.belly, { pos: [0, 0.02, -0.08], scale: [0.85, 1.2, 0.8] });
  const h = k.at(W.head);
  h.ball(0.14, '#d8b898', { pos: [0, 0.16, 0], detail: 1 });
  h.cone(0.04, 0.12, 4, '#e8c050', { pos: [0, 0.12, -0.15], rot: [-HALF - 0.4, 0, 0] });
  eyes(h, 0.05, 0.19, -0.11, 0.025, { ...s, glowEyes: true });
  for (let i = 0; i < 5; i++) h.cone(0.04, 0.32, 3, i % 2 ? s.accent : p.dark, { pos: [(i - 2) * 0.04, 0.3, 0.08], rot: [-0.9 + Math.abs(i - 2) * 0.1, 0, (i - 2) * 0.25] });
  for (const [inner, outer, side] of [
    [W.wingL, W.wingLo, -1],
    [W.wingR, W.wingRo, 1],
  ] as const) {
    const a = k.at(inner);
    a.cyl(0.04, 0.06, 0.55, 5, p.body, { pos: [side * 0.27, 0, 0], rot: [0, 0, HALF] });
    for (let i = 0; i < 4; i++) a.box(0.1, 0.02, 0.42, i % 2 ? p.dark : p.body, { pos: [side * (0.08 + i * 0.13), -0.02, 0.2], rot: [0, side * -0.1, 0] });
    const o = k.at(outer);
    for (let i = 0; i < 5; i++) o.box(0.09, 0.02, 0.5 - i * 0.05, i % 2 ? s.accent : p.light, { pos: [side * (0.05 + i * 0.11), 0, 0.22 - i * 0.02], rot: [0, side * (-0.15 - i * 0.12), 0] });
  }
  const tl = k.at(W.tail);
  for (let i = 0; i < 3; i++) tl.box(0.08, 0.02, 0.4, i === 1 ? s.accent : p.dark, { pos: [(i - 1) * 0.06, -0.1, 0.2], rot: [0.3, (i - 1) * 0.3, 0] });
  const lg = k.at(W.legs);
  lg.pair((b, o) => b.cyl(0.025, 0.04, 0.3, 4, '#c8a040', o), { pos: [0.08, -0.2, 0] });
  hornPair(lg, [0.08, -0.36, 0], [0, -0.3, -1], 0.12, 0.02, '#2a2018', 0.6, [1, 0, 0], 2);
  return wingedJoints(d);
}

// ── The cache ─────────────────────────────────────────────────────────────

const cache = new Map<string, Model>();
const _m = new THREE.Matrix4();
const _rest: THREE.Matrix4[] = Array.from({ length: 16 }, () => new THREE.Matrix4());

/** The model of a spec's variant (built once per variant, kept for the session). */
export function modelFor(spec: ModelSpec): Model {
  let m = cache.get(spec.variant);
  if (m) return m;
  const k = new Kit(spec, rng(hashString(spec.variant)));
  const p = palette(spec);
  const joints = (() => {
    switch (spec.rig) {
      case 'slime':
        return buildSlime(k, p);
      case 'quadruped':
        return buildQuad(k, p);
      case 'crawler':
        return buildCrawler(k, p);
      case 'biped':
        return buildBiped(k, p);
      case 'floater':
        return buildFloater(k, p);
      case 'winged':
        return buildWinged(k, p);
    }
  })();
  if (joints.length !== JOINT_COUNT[spec.rig]) throw new Error(`rig ${spec.rig}: ${joints.length} joints`);
  if (spec.collar) collar(k, spec);
  const parts = k.build(spec.variant);
  // rest-pose world matrices -> the merged mid LOD
  for (let j = 0; j < joints.length; j++) {
    _m.makeTranslation(...joints[j].pos);
    const par = joints[j].parent;
    if (par >= 0) _rest[j].multiplyMatrices(_rest[par], _m);
    else _rest[j].copy(_m);
  }
  const midMat: MatKind = spec.spectral ? 'spectral' : spec.rig === 'slime' ? 'jelly' : 'opaque';
  const pieces = parts.map((pt) => pt.geo.clone().applyMatrix4(_rest[pt.joint]));
  const mid = mergeGeometries(pieces, false)!;
  for (const g of pieces) g.dispose();
  mid.name = `${spec.variant}#mid`;
  mid.computeBoundingBox();
  const bb = mid.boundingBox!;
  mid.computeBoundingSphere();
  m = {
    variant: spec.variant,
    rig: spec.rig,
    joints,
    parts,
    mid,
    midMat,
    height: Math.max(0.3, bb.max.y),
    radius: Math.max(0.3, Math.hypot(Math.max(-bb.min.x, bb.max.x), Math.max(-bb.min.z, bb.max.z))),
    foot: Math.max(0.3, Math.min(Math.hypot(Math.max(-bb.min.x, bb.max.x), Math.max(-bb.min.z, bb.max.z)), bb.max.y * 0.42)),
    // the body (joint 0) of a hovering model sits ~0.45 m above the zone's position
    flyLift: spec.rig === 'floater' || spec.rig === 'winged' ? Math.max(0, joints[0].pos[1] - 0.45) : 0,
    tris: parts.reduce((a, pt) => a + triCount(pt.geo), 0),
    midTris: triCount(mid),
  };
  cache.set(spec.variant, m);
  return m;
}

// ── CR 029: a pet's collar ───────────────────────────────────────────────

/** Neck ring radius per quadruped style (model space at size 1). */
const NECK: Partial<Record<Style, number>> = { boar: 0.21, wolf: 0.15, ram: 0.17, stalker: 0.15, lurker: 0.19, glintfox: 0.1, gloamhound: 0.15, magma_hound: 0.15, behemoth: 0.25 };

/**
 * A tamed pet's collar: a leather band (gold for a shiny) around the neck
 * with a gold tag that catches the light; a slime wears it as a ribbon
 * round its middle, a crawler behind its head.
 */
function collar(k: Kit, s: ModelSpec): void {
  const band = s.collar === 2 ? '#f0c040' : '#b8352a';
  const tag = '#ffd76a';
  const ring = (b: PartBuilder, r: number, tube: number, pos: V3, rot: V3) => {
    b.add(new THREE.TorusGeometry(r, tube, 4, 14), band, { pos, rot, jitter: 0.02, shade: 0.05 });
  };
  switch (s.rig) {
    case 'slime': {
      const b = k.at(SL.body);
      ring(b, 0.5, 0.045, [0, 0.34, 0], [HALF, 0, 0]);
      b.ball(0.06, tag, { pos: [0, 0.3, -0.53], detail: 0, glow: 0.35 });
      return;
    }
    case 'quadruped': {
      const r = NECK[s.style] ?? 0.15;
      const b = k.at(Q.head);
      ring(b, r, Math.max(0.025, r * 0.18), [0, -0.01, -0.03], [-0.45, 0, 0]);
      b.ball(Math.max(0.028, r * 0.22), tag, { pos: [0, -r - 0.02, -0.09], detail: 0, glow: 0.35 });
      return;
    }
    case 'crawler': {
      const b = k.at(C.head);
      ring(b, 0.16, 0.03, [0, 0, 0.02], [0, 0, 0]);
      b.ball(0.035, tag, { pos: [0, -0.17, 0], detail: 0, glow: 0.35 });
      return;
    }
    default: {
      const b = k.at(0);
      ring(b, 0.2, 0.03, [0, 0.3, 0], [HALF, 0, 0]);
    }
  }
}

/** Variants built so far (tests, the gallery). */
export function builtVariants(): string[] {
  return [...cache.keys()];
}

let farGeo: THREE.BufferGeometry | null = null;
/** The far LOD: one shared low box (white, tinted per instance), 1 m tall at size 1 x the model height. */
export function farGeometry(): THREE.BufferGeometry {
  if (!farGeo) {
    const b = new PartBuilder(rng(1));
    b.add(new THREE.OctahedronGeometry(0.5, 0), '#ffffff', { pos: [0, 0.5, 0], scale: [0.9, 1, 0.9], jitter: 0.08, shade: 0.35 });
    farGeo = b.build('enemy#far');
  }
  return farGeo;
}
