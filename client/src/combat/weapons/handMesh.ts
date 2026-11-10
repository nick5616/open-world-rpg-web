// First-person hands (playtest 2, "fix this fucked up hand": the old fist
// was a lumpy clump of boxy fingers and an oversized thumb in flat orange,
// joined to the forearm with a step). Built here like a hand is built:
//   - a palm whose cross-section wraps the grip, rounded off at the index
//     and little-finger sides, the heel of the hand and the ball of the
//     thumb behind the grip, tapering into a wrist;
//   - four fingers of three phalanges each, slimmer toward the tip, with a
//     knuckle ridge at the base and a slight swell at each joint, every
//     phalanx laid tangent to the grip (so the fingers close on each
//     grip's own radius: a wand pulls the fingertips into the palm, a staff
//     leaves them on its side), the little finger shorter and curled more;
//   - a thumb of two phalanges lying over the index and middle fingers;
//   - soft shading from the shapes themselves: every vertex is darkened by
//     how much of the hand (and the grip) it sees around it (a small
//     ray-cast ambient occlusion baked into the vertex colour), so the
//     creases between fingers, the curl into the palm and the cuff read
//     without a texture, in the avatar's skin colour.
// Same frames as before (FirstPersonWeapon aims them): the fist's grip runs
// along +Y (index side up), the wrist toward +Z, the back of the hand faces
// +X; the open hand has its palm toward -Z, fingers up +Y, wrist below.
// The left hand is the right mirrored (scale.x = -1).

import * as THREE from 'three';
import { MeshBuilder, lathe, shade, surf, sweep, type V3 } from './builder';

/** The avatar's skin (net/avatar.ts skinMat) and the navy shirt. */
const SKIN = surf('#c9a27e', 0, 0.62);
const SLEEVE = surf('#3b4a6b', 0, 0.85);
/** Occluded skin drifts warmer and darker (blood under thin skin), not grey. */
const SKIN_SHADOW = new THREE.Color('#6e4130');

export type HandDetail = 1 | 2;

/** Where the forearm meets the fist (fist local): below the knuckle row, a handle lies diagonally across the palm. */
export const FIST_WRIST = new THREE.Vector3(0.011, -0.02, 0.058);
/** Where the forearm meets the open hand (hand local). */
export const OPEN_WRIST = new THREE.Vector3(0, -0.058, 0.004);

/** Hand size relative to an adult's: a touch small, so the hand never fills the view. */
const HS = 0.93;

// ---- shared pieces ----

/** A rounded-rectangle (superellipse) section: u across (half width w), v through (half thickness t). */
function rounded(n: number, w: number, t: number, e = 2.6): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + Math.PI / n;
    const c = Math.cos(a);
    const s = Math.sin(a);
    out.push([w * Math.sign(c) * Math.abs(c) ** (2 / e), t * Math.sign(s) * Math.abs(s) ** (2 / e)]);
  }
  return out;
}

const add = (a: V3, b: V3, k = 1): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * A finger (or thumb) through its joints [base, joint, joint, tip]: each
 * phalanx a little slimmer than the last, a swell at every joint (the
 * first, the knuckle, the most), a slight waist between, a rounded tip.
 * `root` starts it inside the palm so no seam shows.
 */
function digit(b: MeshBuilder, j: V3[], w: number, t: number, side: V3, d: HandDetail, root?: V3): void {
  const pts: V3[] = [];
  const sc: [number, number][] = [];
  const taper: [number, number][] = [
    [1, 1],
    [0.95, 0.9],
    [0.9, 0.82],
    [0.86, 0.76],
  ];
  if (root && d === 2) {
    pts.push(root);
    sc.push([0.92, 0.9]);
  }
  const segs = j.length - 1;
  for (let k = 0; k < segs; k++) {
    const [w0, t0] = taper[Math.min(k, 3)];
    const [w1, t1] = taper[Math.min(k + 1, 3)];
    const swell = k === 0 ? [1.04, 1.12] : [1.05, 1.06];
    pts.push(j[k]);
    sc.push([w0 * swell[0], t0 * swell[1]]);
    if (k < segs - 1) {
      if (d === 2) {
        pts.push(lerp3(j[k], j[k + 1], 0.5));
        sc.push([((w0 + w1) / 2) * 0.96, ((t0 + t1) / 2) * 0.94]);
      }
    } else {
      // the last phalanx: its pad, then the rounded tip
      const a = j[k];
      const c = j[k + 1];
      const dir = sub(c, a);
      const tips: [number, number][] = d === 2 ? [[0.45, 1], [0.78, 0.94], [0.92, 0.78], [0.985, 0.5], [1, 0.16]] : [[0.75, 0.9], [1, 0.35]];
      for (const [f, s] of tips) {
        pts.push(add(a, dir, f));
        sc.push([w1 * s, t1 * s]);
      }
    }
  }
  sweep(b, pts, rounded(d === 2 ? 10 : 5, w, t), SKIN, { side, smooth: true, capEnd: true, capStart: !root || d < 2, scale: (i) => sc[i] });
}

// ---- the fist ----

interface Finger {
  /** Centre along the grip (index +Y). */
  y: number;
  w: number;
  t: number;
  /** Proximal, middle, distal phalanx (m). */
  L: number[];
  /** Knuckle angle round the grip (0 = +X, back of the hand; PI/2 = -Z, front). */
  a: number;
}

const FINGERS: Finger[] = [
  { y: 0.0255, w: 0.0089, t: 0.0072, L: [0.04, 0.024, 0.019], a: 0.4 },
  { y: 0.0084, w: 0.0093, t: 0.0076, L: [0.044, 0.027, 0.02], a: 0.47 },
  { y: -0.0092, w: 0.0089, t: 0.0072, L: [0.041, 0.025, 0.019], a: 0.55 },
  { y: -0.0252, w: 0.0079, t: 0.0064, L: [0.032, 0.019, 0.017], a: 0.66 },
];

/** Polar point round the grip: angle a (0 = +X, PI/2 = -Z), radius r, height y. */
const polar = (a: number, r: number, y: number): V3 => [r * Math.cos(a), y, -r * Math.sin(a)];

/**
 * A finger's joints round a grip: from the knuckle, each phalanx runs along
 * the tangent to the circle its inner side rests on (radius rc), so it
 * touches the grip and bends at the joints, like a real closing hand.
 */
function wrapJoints(f: Finger, g: number, rm: number, rc = g + f.t * HS, turn = 1): V3[] {
  let p: [number, number] = [rm * Math.cos(f.a), rm * Math.sin(f.a)]; // (x, -z): angle a counter-clockwise
  const out: V3[] = [[p[0], f.y * HS, -p[1]]];
  for (const L0 of f.L) {
    const L = L0 * HS;
    const dd = Math.hypot(p[0], p[1]);
    const ang = Math.atan2(p[1], p[0]);
    let dir: [number, number];
    if (dd <= rc * 1.001) dir = [-Math.sin(ang) * turn, Math.cos(ang) * turn];
    else {
      const ta = ang + turn * Math.acos(rc / dd);
      const tx = rc * Math.cos(ta) - p[0];
      const tz = rc * Math.sin(ta) - p[1];
      const tl = Math.hypot(tx, tz);
      dir = [tx / tl, tz / tl];
    }
    p = [p[0] + dir[0] * L, p[1] + dir[1] * L];
    // a fingertip that would sink into the heel of the hand stops on it
    const r = Math.hypot(p[0], p[1]);
    if (r < rc) p = [(p[0] / r) * rc, (p[1] / r) * rc];
    out.push([p[0], f.y * HS, -p[1]]);
  }
  return out;
}

/**
 * The palm's cross-section round the grip (offset beyond the grip radius
 * by angle; periodic). Thick on the back of the hand (+X) and at the heel
 * and the ball of the thumb behind the grip (+Z), thin where the fingers
 * cover it (the front and the -X side).
 */
const PALM: [number, number][] = [
  [0.0, 0.0185],
  [0.38, 0.0155], // the knuckle corner (the knuckles stand out of it)
  [0.85, 0.0065],
  [1.6, 0.0035],
  [3.1, 0.0035],
  [3.6, 0.009], // the fingertips press in here
  [4.0, 0.0165], // ball of the thumb / heel, behind the grip
  [4.45, 0.021],
  [4.9, 0.0232],
  [5.45, 0.0225], // toward the wrist
  [5.95, 0.0198],
];

function palmOffset(a: number): number {
  const T = Math.PI * 2;
  a = ((a % T) + T) % T;
  const n = PALM.length;
  for (let i = 0; i < n; i++) {
    const [a0, r0] = PALM[i];
    const [a1raw, r1] = PALM[(i + 1) % n];
    const a1 = i === n - 1 ? a1raw + T : a1raw;
    if (a >= a0 && a <= a1) {
      const t = (a - a0) / (a1 - a0);
      // Catmull-Rom between the neighbours keeps the outline round
      const rp = PALM[(i - 1 + n) % n][1];
      const rn = PALM[(i + 2) % n][1];
      return 0.5 * (2 * r0 + (-rp + r1) * t + (2 * rp - 5 * r0 + 4 * r1 - rn) * t * t + (-rp + 3 * r0 - 3 * r1 + rn) * t * t * t);
    }
  }
  return PALM[0][1];
}

function fist(b: MeshBuilder, g: number, d: HandDetail): void {
  const hi = d === 2;
  // Palm: rings across the hand, little finger (-Y) to index (+Y), each
  // round the grip; the ends close in onto the grip, rounded.
  const segs = hi ? 26 : 10;
  const rows = hi ? 11 : 4;
  const y0 = -0.037 * HS;
  const y1 = 0.036 * HS;
  const rings: V3[][] = [];
  for (let r = 0; r <= rows; r++) {
    const tt = r / rows;
    const y = y0 + (y1 - y0) * tt;
    const e = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(2 * tt - 1), 3.2)), 1 / 3.2); // rounded ends
    const ring: V3[] = [];
    for (let k = 0; k < segs; k++) {
      const a = (k / segs) * Math.PI * 2;
      let off = palmOffset(a) * HS;
      // ball of the thumb on the index side behind the grip; the heel and wrist on the little-finger side
      const behind = Math.max(0, -Math.sin(a)); // toward +Z
      off += 0.004 * behind * Math.max(0, 2 * tt - 0.9) * Math.max(0, -Math.cos(a) + 0.4);
      off += 0.003 * behind * Math.max(0, 1 - 2 * tt);
      ring.push(polar(a, g * (0.86 + 0.14 * e) + off * e, y));
    }
    rings.push(ring);
  }
  b.loft(rings, SKIN, { smooth: true, capStart: true, capEnd: true });

  // Wrist: from inside the heel of the hand out to where the forearm takes over.
  const wrist: V3[] = [
    [0.012, -0.017, g + 0.008],
    [0.0118, -0.0185, 0.042],
    [FIST_WRIST.x, FIST_WRIST.y, FIST_WRIST.z],
    [FIST_WRIST.x, FIST_WRIST.y, FIST_WRIST.z + 0.006],
  ];
  // (its end runs on inside the forearm, a little narrower, so the two meet without a step)
  sweep(b, wrist, rounded(hi ? 12 : 5, 0.0285 * HS, 0.0175 * HS, 2.2), SKIN, { side: [0, 1, 0], smooth: true, capStart: true, capEnd: true, scale: (i) => [[1, 1], [0.94, 0.98], [0.88, 1], [0.78, 0.88]][i] as [number, number] });

  // Fingers, knuckle to tip, round the grip.
  for (const f of FINGERS) {
    const rm = g + 0.0118 * HS;
    const j = wrapJoints(f, g, rm);
    const root = polar(f.a - 0.55, g + 0.009, f.y * HS);
    digit(b, j, f.w * HS, f.t * HS, [0, 1, 0], d, root);
  }

  // Thumb: out of the ball of the thumb behind the grip, wrapped the other
  // way round the grip just above the index finger, pressing on it, its tip
  // on the front of the grip (so it hugs the handle instead of pointing off it).
  const th: Finger = { y: 0.031, w: 0.0088, t: 0.0076, L: [0.031, 0.027], a: 4.2 };
  const tj = wrapJoints(th, g, g + 0.019 * HS, g + 0.0105 * HS, -1);
  tj[1][1] = 0.029 * HS;
  tj[2][1] = 0.0275 * HS;
  digit(b, tj, th.w * HS, th.t * HS, [0, 1, 0], d, polar(4.65, g + 0.01, 0.026 * HS));
}

// ---- the open hand ----

function openHand(b: MeshBuilder, d: HandDetail): void {
  const hi = d === 2;
  // Palm: rings up the hand from the wrist to the knuckles; wide across X,
  // thin through Z, the back (+Z) a little domed and the palm cupped.
  const palm: [number, number, number, number][] = [
    // y, half width, half thickness, z centre
    [OPEN_WRIST.y - 0.006, 0.021, 0.0135, 0.006],
    [OPEN_WRIST.y + 0.008, 0.026, 0.0145, 0.005],
    [-0.03, 0.035, 0.0135, 0.003],
    [-0.008, 0.0385, 0.0118, 0.002],
    [0.012, 0.0385, 0.0105, 0.002],
    [0.026, 0.035, 0.0095, 0.002],
    [0.032, 0.03, 0.007, 0.002],
  ];
  sweep(
    b,
    palm.map(([y, , , z]) => [0, y * HS, z] as V3),
    rounded(hi ? 16 : 8, 1, 1, 2.4),
    SKIN,
    { side: [1, 0, 0], smooth: true, capStart: true, capEnd: true, scale: (i) => [palm[i][1] * HS, palm[i][2] * HS] },
  );
  // Ball of the thumb, on the palm side by the wrist.
  sweep(
    b,
    [
      [-0.006, -0.05 * HS, -0.002],
      [-0.017, -0.036 * HS, -0.008],
      [-0.024, -0.02 * HS, -0.007],
    ],
    rounded(hi ? 10 : 6, 0.012 * HS, 0.008 * HS),
    SKIN,
    { side: [0, 0, 1], smooth: true, capStart: true, capEnd: true, scale: (i) => [[0.8, 0.8], [1, 1], [0.7, 0.7]][i] as [number, number] },
  );
  // Fingers: relaxed, a little spread, each joint bent a little toward the palm.
  const spec: [number, number, number, number, number, number][] = [
    // x at the knuckle, y at the knuckle, half width, half thickness, splay (rad), length scale
    [-0.0255, 0.026, 0.0082, 0.0072, 0.1, 0.93],
    [-0.0086, 0.03, 0.0087, 0.0075, 0.03, 1],
    [0.0086, 0.028, 0.0082, 0.0071, -0.05, 0.95],
    [0.025, 0.022, 0.0071, 0.0063, -0.14, 0.76],
  ];
  const L = [0.044, 0.027, 0.02];
  const bend = [0.12, 0.2, 0.14];
  for (const [x, y, w, t, sp, k] of spec) {
    let p: V3 = [x * HS, y * HS, 0.002];
    const j: V3[] = [p];
    let pitch = 0;
    for (let i = 0; i < 3; i++) {
      pitch += bend[i];
      const l = L[i] * k * HS;
      p = add(p, [Math.sin(sp) * Math.cos(pitch), Math.cos(sp) * Math.cos(pitch), -Math.sin(pitch)], l);
      j.push(p);
    }
    digit(b, j, w * HS, t * HS, [1, 0, 0], d, [x * HS * 0.9, (y - 0.012) * HS, 0.002]);
  }
  // Thumb: out to the -X side and up, in front of the palm.
  const thumb: V3[] = [
    [-0.026 * HS, -0.026 * HS, -0.006],
    [-0.043 * HS, -0.008 * HS, -0.011],
    [-0.052 * HS, 0.012 * HS, -0.014],
    [-0.057 * HS, 0.03 * HS, -0.015],
  ];
  digit(b, thumb, 0.0094 * HS, 0.0082 * HS, [0, 0, 1], d, [-0.012 * HS, -0.04 * HS, -0.003]);
}

// ---- the forearm ----

/**
 * Forearm: the wrist at the origin, rounded into the hand (a bent wrist
 * shows no cut), the skin widening up the forearm into a turned-back sleeve
 * cuff (a lip, a band and a seam) and the sleeve running up +Y past the
 * elbow, off screen. Wider across X (thumb side to little-finger side) than
 * deep.
 */
function forearm(b: MeshBuilder, d: HandDetail): void {
  const n = d === 2 ? 12 : 8;
  lathe(b, [[-0.012, 0.01], [-0.008, 0.017], [-0.002, 0.021], [0.008, 0.0222], [0.03, 0.0255], [0.07, 0.029]], n, SKIN, { rx: 1, rz: 0.74 });
  const cuff = shade(SLEEVE, 1.12);
  const inner = shade(SLEEVE, 0.45);
  lathe(
    b,
    [
      [0.056, 0.0262],
      [0.054, 0.0335],
      [0.058, 0.0362],
      [0.088, 0.0376],
      [0.093, 0.0352],
      [0.098, 0.0372],
      [0.3, 0.043],
      [0.55, 0.05],
    ],
    n,
    (r) => (r === 0 ? inner : r <= 3 ? cuff : r === 4 ? shade(SLEEVE, 0.7) : SLEEVE),
    { rx: 1, rz: 0.85 },
  );
}

// ---- soft shading ----

const DIRS = (() => {
  // cosine-weighted directions over the +Z hemisphere (golden-angle spiral)
  const out: THREE.Vector3[] = [];
  const n = 10;
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt((i + 0.5) / n);
    const a = i * 2.39996;
    out.push(new THREE.Vector3(r * Math.cos(a), r * Math.sin(a), Math.sqrt(Math.max(0, 1 - r * r))));
  }
  return out;
})();

/**
 * Bake a soft ambient occlusion into the vertex colours: short rays from
 * every vertex over its hemisphere against the mesh itself (and, for a
 * fist, the grip it holds, a cylinder of radius `grip` along Y); occluded
 * skin goes darker and warmer. A uniform grid keeps it to the triangles
 * near each ray (a few ms per hand).
 */
export function bakeOcclusion(geo: THREE.BufferGeometry, reach: number, strength: number, grip = 0): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
  const col = geo.getAttribute('color') as THREE.BufferAttribute;
  const idx = geo.index!.array;
  const P = pos.array as Float32Array;
  const cell = reach;
  const grid = new Map<number, number[]>();
  const key = (x: number, y: number, z: number) => (x + 512) * 1048576 + (y + 512) * 1024 + (z + 512);
  for (let t = 0; t < idx.length; t += 3) {
    let mnx = Infinity;
    let mny = Infinity;
    let mnz = Infinity;
    let mxx = -Infinity;
    let mxy = -Infinity;
    let mxz = -Infinity;
    for (let k = 0; k < 3; k++) {
      const i = idx[t + k] * 3;
      mnx = Math.min(mnx, P[i]);
      mxx = Math.max(mxx, P[i]);
      mny = Math.min(mny, P[i + 1]);
      mxy = Math.max(mxy, P[i + 1]);
      mnz = Math.min(mnz, P[i + 2]);
      mxz = Math.max(mxz, P[i + 2]);
    }
    for (let x = Math.floor(mnx / cell); x <= Math.floor(mxx / cell); x++)
      for (let y = Math.floor(mny / cell); y <= Math.floor(mxy / cell); y++)
        for (let z = Math.floor(mnz / cell); z <= Math.floor(mxz / cell); z++) {
          const k = key(x, y, z);
          const l = grid.get(k);
          if (l) l.push(t);
          else grid.set(k, [t]);
        }
  }
  // per triangle: centroid and bounding radius (cheap rejection before the ray tests)
  const nt = idx.length / 3;
  const cen = new Float32Array(nt * 4);
  for (let t = 0; t < nt; t++) {
    const i0 = idx[t * 3] * 3;
    const i1 = idx[t * 3 + 1] * 3;
    const i2 = idx[t * 3 + 2] * 3;
    const cx = (P[i0] + P[i1] + P[i2]) / 3;
    const cy = (P[i0 + 1] + P[i1 + 1] + P[i2 + 1]) / 3;
    const cz = (P[i0 + 2] + P[i1 + 2] + P[i2 + 2]) / 3;
    let r = 0;
    for (const i of [i0, i1, i2]) r = Math.max(r, Math.hypot(P[i] - cx, P[i + 1] - cy, P[i + 2] - cz));
    cen.set([cx, cy, cz, r], t * 4);
  }
  // per triangle: a corner and the two edges from it
  const TE = new Float32Array(nt * 9);
  for (let t = 0; t < nt; t++) {
    const i0 = idx[t * 3] * 3;
    const i1 = idx[t * 3 + 1] * 3;
    const i2 = idx[t * 3 + 2] * 3;
    TE.set([P[i0], P[i0 + 1], P[i0 + 2], P[i1] - P[i0], P[i1 + 1] - P[i0 + 1], P[i1 + 2] - P[i0 + 2], P[i2] - P[i0], P[i2 + 1] - P[i0 + 1], P[i2 + 2] - P[i0 + 2]], t * 9);
  }
  const stamp = new Int32Array(nt).fill(-1);
  const o = new THREE.Vector3();
  const n = new THREE.Vector3();
  const tx = new THREE.Vector3();
  const ty = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const base = new THREE.Color();
  const c = new THREE.Color();
  const tris: number[] = [];
  for (let v = 0; v < pos.count; v++) {
    n.fromBufferAttribute(nor, v);
    o.fromBufferAttribute(pos, v).addScaledVector(n, reach * 0.02);
    // the triangles within reach, in front of this vertex
    tris.length = 0;
    const cx = Math.floor(o.x / cell);
    const cy = Math.floor(o.y / cell);
    const cz = Math.floor(o.z / cell);
    for (let x = cx - 1; x <= cx + 1; x++)
      for (let y = cy - 1; y <= cy + 1; y++)
        for (let z = cz - 1; z <= cz + 1; z++) {
          const l = grid.get(key(x, y, z));
          if (!l) continue;
          for (const t3 of l) {
            const t = t3 / 3;
            if (stamp[t] === v) continue;
            stamp[t] = v;
            const k = t * 4;
            const dx = cen[k] - o.x;
            const dy = cen[k + 1] - o.y;
            const dz = cen[k + 2] - o.z;
            const rr = reach + cen[k + 3];
            if (dx * dx + dy * dy + dz * dz > rr * rr) continue;
            if (dx * n.x + dy * n.y + dz * n.z < -cen[k + 3]) continue;
            tris.push(t3);
          }
        }
    // tangent frame round the normal
    tx.set(Math.abs(n.x) < 0.9 ? 1 : 0, Math.abs(n.x) < 0.9 ? 0 : 1, 0).cross(n).normalize();
    ty.crossVectors(n, tx);
    let occ = 0;
    for (const d of DIRS) {
      dir.set(0, 0, 0).addScaledVector(tx, d.x).addScaledVector(ty, d.y).addScaledVector(n, d.z);
      let hit = reach;
      const dx = dir.x;
      const dy = dir.y;
      const dz = dir.z;
      for (const t3 of tris) {
        // Moller-Trumbore against the triangle's corner and edges (precomputed)
        const k = t3 * 3;
        const e1x = TE[k + 3];
        const e1y = TE[k + 4];
        const e1z = TE[k + 5];
        const e2x = TE[k + 6];
        const e2y = TE[k + 7];
        const e2z = TE[k + 8];
        const px = dy * e2z - dz * e2y;
        const py = dz * e2x - dx * e2z;
        const pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-12 && det < 1e-12) continue;
        const inv = 1 / det;
        const sx = o.x - TE[k];
        const sy = o.y - TE[k + 1];
        const sz = o.z - TE[k + 2];
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y;
        const qy = sz * e1x - sx * e1z;
        const qz = sx * e1y - sy * e1x;
        const w = (dx * qx + dy * qy + dz * qz) * inv;
        if (w < 0 || u + w > 1) continue;
        const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (dist > 1e-5 && dist < hit) hit = dist;
      }
      if (grip > 0) {
        // the handle: an infinite cylinder along Y
        const A = dir.x * dir.x + dir.z * dir.z;
        const B = 2 * (o.x * dir.x + o.z * dir.z);
        const C = o.x * o.x + o.z * o.z - grip * grip;
        if (C > 0 && A > 1e-9) {
          const disc = B * B - 4 * A * C;
          if (disc >= 0) {
            const s = (-B - Math.sqrt(disc)) / (2 * A);
            if (s > 0 && s < hit) hit = s;
          }
        }
      }
      occ += 1 - hit / reach;
    }
    occ = Math.min(1, (occ / DIRS.length) * strength);
    base.fromBufferAttribute(col, v);
    c.copy(base).lerp(SKIN_SHADOW.clone().multiply(base).multiplyScalar(1.9), occ * 0.75);
    c.multiplyScalar(1 - 0.35 * occ);
    col.setXYZ(v, c.r, c.g, c.b);
  }
  col.needsUpdate = true;
}

// ---- geometry ----

/** A right fist closed on a grip of radius `g`, shaded. */
export function buildFist(g: number, d: HandDetail): THREE.BufferGeometry {
  const b = new MeshBuilder();
  fist(b, g, d);
  const geo = b.build();
  if (d === 2) bakeOcclusion(geo, 0.012, 2.4, g); // (third person draws it in one plain skin material)
  return geo;
}

/** An open right hand, palm forward (-Z), fingers up, shaded. */
export function buildOpenHand(d: HandDetail = 2): THREE.BufferGeometry {
  const b = new MeshBuilder();
  openHand(b, d);
  const geo = b.build();
  bakeOcclusion(geo, 0.014, 1.5);
  return geo;
}

export function buildForearm(d: HandDetail = 2): THREE.BufferGeometry {
  const b = new MeshBuilder();
  forearm(b, d);
  const geo = b.build();
  bakeOcclusion(geo, 0.012, 1.2);
  return geo;
}

