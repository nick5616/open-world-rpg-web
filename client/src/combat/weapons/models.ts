// Procedural weapon models (pt/ux "weapons don't look like weapons"): sword,
// spear, bow, staff and wand, each ONE BufferGeometry (one draw call with
// the shared weapon material) built by builder.ts, at three detail levels:
//   2  first person   (< 3k triangles)
//   1  third person   (< 600 triangles, remote players within 25 m)
//   0  far            (< 200 triangles, remote players 25-90 m)
// Local frame: the grip centre (where the main hand holds it) is the origin,
// +Y runs to the business end, blades are flat in X (edges at +-X, flats
// facing +-Z), and the bow's string side is +Z (toward the archer).
//
// Looks: the material (steel by default; items.yaml materials: copper,
// iron, silver, sunsteel, starmetal, voidglass, oak) colours the metal, with
// sunsteel a warm gold-white that glows along its edges; the socketed gem
// sits where you can see it (sword: crossguard; spear: blade base; bow:
// riser; staff: cradled in the head; wand: the tip), coloured by element.
//
// Geometries are cached by look and detail and never disposed (a few dozen
// small buffers at most). The first-person bow geometry is dynamic: its
// string and nocked arrow move with the draw (setBowDraw).

import * as THREE from 'three';
import { ELEMENT_COLORS } from '../events';
import { MeshBuilder, M, circle, curve, hash, helix, lathe, polygon, shade, surf, sweep, type Surface, type SurfaceAt, type V3 } from './builder';
import { lookKey, type WeaponKind, type WeaponLook } from './look';
import { buildFist, buildForearm, buildOpenHand } from './handMesh';

export type Detail = 0 | 1 | 2;

// ---- palette ----

interface Metal {
  /** Blade / head metal. */
  base: Surface;
  edge: Surface;
  /** Fittings: guard, pommel, ferrules, socket, collar. */
  fit: Surface;
}

function metal(base: string, edge: string, fit: string, m: number, r: number, glow = 0, edgeGlow = glow, fitGlow = 0): Metal {
  return { base: surf(base, m, r, glow), edge: surf(edge, m, r * 0.7, edgeGlow), fit: surf(fit, m * 0.95, r * 1.2, fitGlow) };
}

const METALS: Record<string, Metal> = {
  '': metal('#b9c1cb', '#eef3f8', '#9aa1aa', 0.9, 0.34),
  wood: { base: surf('#a07a4c', 0, 0.75), edge: surf('#b98f5c', 0, 0.7), fit: surf('#6d4c2e', 0, 0.8) },
  leather: metal('#b9c1cb', '#eef3f8', '#9aa1aa', 0.9, 0.34),
  copper: metal('#c4774a', '#f0b086', '#9a5a36', 0.9, 0.38),
  iron: metal('#8c9198', '#c9cdd2', '#5f6369', 0.85, 0.5),
  silver: metal('#dde3ea', '#ffffff', '#b3bac3', 0.95, 0.2),
  sunsteel: metal('#f2cd78', '#fff4cf', '#d9a03c', 0.95, 0.2, 0.28, 0.9, 0.12),
  starmetal: metal('#a7b6e6', '#e6ecff', '#6f7fb8', 0.95, 0.24, 0.1, 0.35, 0.05),
  voidglass: metal('#3d2660', '#b38ff0', '#2a1a44', 0.35, 0.08, 0.18, 0.6, 0.08),
};

export function metalOf(key: string): Metal {
  return METALS[key] ?? METALS[''];
}

const WOOD = {
  ash: surf('#b88d58', 0, 0.72),
  oak: surf('#7a5332', 0, 0.75),
  dark: surf('#6a4529', 0, 0.75),
  ebony: surf('#2f1d12', 0, 0.55),
  limbBack: surf('#5e3b1f', 0, 0.6),
  limbBelly: surf('#d8bf8e', 0, 0.55),
};
const LEATHER = surf('#5b3a22', 0, 0.85);
const LEATHER_DARK = surf('#4a3020', 0, 0.9);
const CORD = surf('#8a6a44', 0, 0.9);
const STRING = surf('#e8e0cc', 0, 0.7);
const FLETCH = surf('#c23b2b', 0, 0.8);
const SKIN = surf('#c9a27e', 0, 0.7);
const SLEEVE = surf('#3b4a6b', 0, 0.85);

/** The socketed gem's surface (element colour, glowing); -1 = plain quartz. */
export function gemSurface(element: number): Surface {
  if (element < 0 || element > 7) return surf('#dfe9f2', 0.1, 0.12, 0.12);
  const glow = element === 6 ? 1.6 : element === 7 ? 1.25 : 1.0;
  return surf(ELEMENT_COLORS[element], 0.15, 0.1, glow);
}

const segsOf = (d: Detail, hi: number, mid: number, lo: number) => (d === 2 ? hi : d === 1 ? mid : lo);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// ---- shared parts ----

/** A cut gem standing on +Y (pavilion below, crown and table above). */
function gem(b: MeshBuilder, R: number, element: number, d: Detail, pavilion = true): void {
  const s = gemSurface(element);
  const n = segsOf(d, 8, 6, 4);
  const prof: [number, number][] = pavilion ? [[-R * 0.95, 0], [0, R], [R * 0.42, R * 0.58]] : [[-R * 0.1, R * 0.9], [0, R], [R * 0.42, R * 0.58]];
  b.loft(
    prof.map(([y, r]) => circle(y, Math.max(r, 1e-5), n)),
    (ring) => shade(s, ring === 1 ? 1.15 : ring === 0 ? 0.75 : 1),
    { smooth: false, capEnd: true },
  );
}

/** A gem in a metal bezel, facing +Y (place it with the builder matrix). */
function setGem(b: MeshBuilder, R: number, element: number, fit: Surface, d: Detail): void {
  if (d >= 1) lathe(b, [[-0.002, R * 1.18], [0.0015, R * 1.32], [0.003, R * 1.08]], segsOf(d, 10, 6, 4), fit, { smooth: true });
  if (element >= 0) gem(b, R, element, d, false);
  else if (d >= 1) lathe(b, [[0.0, R * 1.05], [0.0012, R * 0.6]], 6, shade(fit, 0.45), { capEnd: true }); // empty socket
}

/** A leather strap wound round a grip (first person only). */
function strap(b: MeshBuilder, y0: number, y1: number, r: number, turns: number, s: Surface, width = 0.0042, thick = 0.0012): void {
  sweep(b, helix(y0, y1, r, turns, 9), polygon(4, width, thick, Math.PI / 4), (ring, k) => shade(s, k === 1 || k === 2 ? 1.12 : 0.88), { side: [0, 1, 0], smooth: true });
}

// ---- sword ----

function sword(b: MeshBuilder, l: WeaponLook, d: Detail): void {
  const mt = metalOf(l.material);
  // Blade: tapered, bevelled to the edges, a fuller down the first two
  // thirds; faceted so the bevels catch the light.
  const N = segsOf(d, 12, 6, 3);
  const y0 = 0.07;
  const len = 0.74;
  const rings: V3[][] = [];
  const kinds: number[] = []; // per section point: 0 edge, 1 bevel, 2 flat, 3 fuller
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const y = y0 + len * t;
    const w = t < 0.72 ? lerp(0.026, 0.02, t / 0.72) : Math.max(0.0006, 0.02 * Math.pow(1 - (t - 0.72) / 0.28, 0.8));
    const th = Math.max(0.0005, lerp(0.0048, 0.0022, t) * (t > 0.9 ? (1 - t) / 0.1 + 0.15 : 1));
    if (d === 2) {
      const fade = t < 0.05 ? 0 : t < 0.62 ? 1 : Math.max(0, 1 - (t - 0.62) / 0.1);
      const ft = th * (1 - 0.5 * fade);
      const sec: [number, number, number][] = [
        [w, 0, 0], [0.6 * w, -0.62 * th, 1], [0.3 * w, -th, 2], [0.15 * w, -ft, 3], [-0.15 * w, -ft, 3], [-0.3 * w, -th, 2], [-0.6 * w, -0.62 * th, 1],
        [-w, 0, 0], [-0.6 * w, 0.62 * th, 1], [-0.3 * w, th, 2], [-0.15 * w, ft, 3], [0.15 * w, ft, 3], [0.3 * w, th, 2], [0.6 * w, 0.62 * th, 1],
      ];
      rings.push(sec.map(([x, z]) => [x, y, z]));
      if (i === 0) for (const s of sec) kinds.push(s[2]);
    } else {
      const sec: [number, number, number][] = d === 1 ? [[w, 0, 0], [0.35 * w, -th, 2], [-0.35 * w, -th, 2], [-w, 0, 0], [-0.35 * w, th, 2], [0.35 * w, th, 2]] : [[w, 0, 0], [0, -th, 2], [-w, 0, 0], [0, th, 2]];
      rings.push(sec.map(([x, z]) => [x, y, z]));
      if (i === 0) for (const s of sec) kinds.push(s[2]);
    }
  }
  b.loft(rings, (_, k) => (kinds[k] === 0 ? mt.edge : kinds[k] === 1 ? shade(mt.base, 1.08, 1.6) : kinds[k] === 3 ? shade(mt.base, 0.78) : mt.base), { smooth: false });

  // Crossguard: a bar across the blade, ends swept toward the blade, with
  // finials; a langet block in the middle carries the gem on both faces.
  const gn = segsOf(d, 9, 5, 2);
  const guard: V3[] = [];
  for (let i = 0; i < gn; i++) {
    const x = lerp(-0.1, 0.1, i / (gn - 1));
    guard.push([x, 0.045 + 0.02 * Math.pow(Math.abs(x) / 0.1, 2), 0]);
  }
  sweep(b, guard, polygon(segsOf(d, 8, 6, 4), 0.011, 0.0085), (_, k) => shade(mt.fit, k % 2 ? 1.1 : 0.92), {
    side: [0, 0, 1],
    smooth: d === 0,
    capStart: true,
    capEnd: true,
    scale: (i) => {
      const e = Math.abs(i / (gn - 1) - 0.5) * 2;
      return [lerp(1.15, 0.75, e), lerp(1.2, 0.8, e)];
    },
  });
  if (d >= 1) {
    for (const sx of [-1, 1])
      b.with(M.t(sx * 0.104, 0.065, 0), () => lathe(b, [[-0.012, 0.0005], [-0.006, 0.009], [0.003, 0.01], [0.01, 0.0005]], segsOf(d, 8, 5, 4), mt.fit, { smooth: true }));
    // langet block over the blade's root
    sweep(b, [[0, 0.028, 0], [0, 0.05, 0], [0, 0.075, 0]], polygon(8, 0.03, 0.0125), mt.fit, { side: [1, 0, 0], smooth: false, capEnd: true, scale: (i) => [i === 2 ? 0.55 : 1, i === 2 ? 0.7 : 1] });
    for (const sz of [-1, 1]) b.with(M.of(M.t(0, 0.052, sz * 0.0125), M.rx((sz * Math.PI) / 2)), () => setGem(b, 0.0095, l.gem, mt.fit, d));
  }

  // Grip: a swelled core wound with a leather strap, metal collars.
  const gs = segsOf(d, 10, 6, 4);
  if (d === 2) {
    lathe(b, [[-0.125, 0.0118], [-0.1, 0.0128], [-0.05, 0.0138], [0, 0.0128], [0.028, 0.0118]], gs, LEATHER_DARK);
    strap(b, -0.118, 0.022, 0.0128, 6, LEATHER);
  } else {
    const st = d === 1 ? 6 : 2;
    const prof: [number, number][] = [];
    for (let i = 0; i <= st; i++) prof.push([lerp(-0.125, 0.028, i / st), 0.013]);
    lathe(b, prof, gs, (r) => (d === 1 && r % 2 ? shade(LEATHER, 0.7) : LEATHER));
  }
  lathe(b, [[0.026, 0.0135], [0.029, 0.015], [0.034, 0.015], [0.037, 0.012]], gs, mt.fit, { smooth: d < 2 });
  lathe(b, [[-0.134, 0.012], [-0.13, 0.0145], [-0.124, 0.0145], [-0.121, 0.0125]], gs, mt.fit, { smooth: d < 2 });

  // Pommel: a wheel, its faces toward +-Z, with the peen below.
  const ps = segsOf(d, 12, 8, 5);
  b.with(M.of(M.t(0, -0.158, 0), M.rx(Math.PI / 2)), () =>
    lathe(
      b,
      d < 2 ? [[-0.009, 0.024], [0.009, 0.024]] : [[-0.0095, 0.011], [-0.0095, 0.02], [-0.006, 0.0255], [0.006, 0.0255], [0.0095, 0.02], [0.0095, 0.011]],
      ps,
      (r) => (r === 2 || r === 3 ? mt.fit : shade(mt.fit, 0.9)),
      { smooth: false, capStart: true, capEnd: true },
    ),
  );
  if (d >= 1) lathe(b, [[-0.188, 0.0005], [-0.186, 0.006], [-0.18, 0.006], [-0.176, 0.004]], 6, mt.fit, { smooth: true });
}

// ---- spear ----

function spear(b: MeshBuilder, l: WeaponLook, d: Detail): void {
  const mt = metalOf(l.material);
  const s = segsOf(d, 8, 6, 4);
  // Ash shaft with a little grain.
  const st = segsOf(d, 14, 5, 2);
  const prof: [number, number][] = [];
  for (let i = 0; i <= st; i++) {
    const t = i / st;
    prof.push([lerp(-0.6, 1.19, t), lerp(0.0168, 0.0145, t)]);
  }
  lathe(b, prof, s, (r, k) => shade(WOOD.ash, 0.86 + 0.24 * hash(r, k * 3 + 1)));
  // Butt spike (ferrule).
  lathe(b, [[-0.69, 0.0005], [-0.64, 0.008], [-0.605, 0.0172], [-0.585, 0.0178], [-0.575, 0.016]], s, mt.fit, { smooth: d < 2 });
  // Grip wrap where the main hand holds it.
  if (d === 2) strap(b, -0.11, 0.11, 0.0168, 4, LEATHER);
  else if (d === 1) lathe(b, [[-0.11, 0.0178], [0.11, 0.0178]], s, LEATHER);
  // Cord binding under the socket.
  if (d >= 1) {
    const cb: [number, number][] = [];
    const n = d === 2 ? 8 : 2;
    for (let i = 0; i <= n; i++) cb.push([lerp(1.125, 1.175, i / n), i % 2 ? 0.0172 : 0.0158]);
    lathe(b, cb, s, CORD);
  }
  // Socket: a tapered tube with a moulded ring.
  lathe(b, [[1.172, 0.0175], [1.19, 0.019], [1.2, 0.021], [1.212, 0.0185], [1.3, 0.0128], [1.345, 0.0105]], s, (r) => (r === 2 ? mt.edge : mt.fit), { smooth: d < 2 });
  // Leaf-shaped head with a raised midrib.
  const N = segsOf(d, 12, 6, 3);
  const rings: V3[][] = [];
  const kinds: number[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const y = lerp(1.335, 1.68, t);
    const w = Math.max(0.0006, 0.038 * Math.pow(Math.sin(Math.PI * (0.13 + 0.87 * Math.pow(t, 0.85))), 0.9));
    const th = Math.max(0.0005, lerp(0.0085, 0.0012, t));
    const sec: [number, number, number][] =
      d === 0
        ? [[w, 0, 0], [0, -th, 2], [-w, 0, 0], [0, th, 2]]
        : [[w, 0, 0], [0.5 * w, -0.42 * th, 1], [0.1 * w, -th, 2], [-0.1 * w, -th, 2], [-0.5 * w, -0.42 * th, 1], [-w, 0, 0], [-0.5 * w, 0.42 * th, 1], [-0.1 * w, th, 2], [0.1 * w, th, 2], [0.5 * w, 0.42 * th, 1]];
    rings.push(sec.map(([x, z]) => [x, y, z]));
    if (i === 0) for (const q of sec) kinds.push(q[2]);
  }
  b.loft(rings, (_, k) => (kinds[k] === 0 ? mt.edge : kinds[k] === 2 ? shade(mt.base, 1.1, 1.4) : mt.base), { smooth: false });
  if (d >= 1) for (const sz of [-1, 1]) b.with(M.of(M.t(0, 1.268, sz * 0.0148), M.rx((sz * Math.PI) / 2)), () => setGem(b, 0.0075, l.gem, mt.fit, d));
}

// ---- bow ----

const BOW = {
  tipY: 0.685,
  tipZ: 0.012,
  brace: 0.15, // string rest distance from the grip (toward the archer)
  arrowY: 0.058,
  arrowX: -0.017,
  arrowLen: 0.74,
};
/** Full draw (m) of the first-person bow's string. */
export const BOW_MAX_DRAW = 0.24;

function bow(b: MeshBuilder, l: WeaponLook, d: Detail): void {
  const mt = metalOf(l.material);
  // Riser: an ellipse section, slimmer leather-wrapped grip in the middle.
  const rs = segsOf(d, 10, 6, 4);
  const rn = segsOf(d, 10, 4, 2);
  const rp: V3[][] = [];
  for (let i = 0; i <= rn; i++) {
    const t = i / rn;
    const y = lerp(-0.18, 0.18, t);
    const g = Math.abs(y) < 0.05 ? 0.88 : 1;
    rp.push(circle(y, 1, rs, { rx: 0.0165 * g * lerp(0.75, 1, 1 - Math.abs(y) / 0.18), rz: 0.022 * g, cz: 0.006 + 0.008 * (1 - Math.abs(y) / 0.18) }));
  }
  b.loft(rp, (r) => (Math.abs(lerp(-0.18, 0.18, r / rn)) < 0.05 ? LEATHER : WOOD.oak), { smooth: true });
  // Limbs: tapering laminated strips, curving toward the archer and
  // recurving at the tips; horn nocks at the ends.
  const ln = segsOf(d, 14, 7, 4);
  const sec: [number, number][] = d === 0 ? polygon(4, 0.017, 0.006, Math.PI / 4) : polygon(8, 0.017, 0.0065, Math.PI / 8);
  for (const sy of [1, -1]) {
    const path = curve(
      [
        [0, 0.16 * sy, 0.004],
        [0, 0.27 * sy, 0.032],
        [0, 0.4 * sy, 0.068],
        [0, 0.52 * sy, 0.085],
        [0, 0.6 * sy, 0.078],
        [0, 0.655 * sy, 0.048],
        [0, BOW.tipY * sy, BOW.tipZ],
      ],
      ln,
    );
    if (sy < 0) path.reverse();
    sweep(b, path, sec, (_, k) => (sec[k][1] > 0.002 ? WOOD.limbBack : sec[k][1] < -0.002 ? WOOD.limbBelly : WOOD.oak), {
      side: [1, 0, 0],
      smooth: true,
      scale: (i) => {
        const t = sy > 0 ? i / (ln - 1) : 1 - i / (ln - 1);
        return [lerp(1.0, 0.45, t), lerp(1.0, 0.7, t)];
      },
    });
    if (d >= 1) b.with(M.of(M.t(0, BOW.tipY * sy, BOW.tipZ), M.rx(sy > 0 ? 0 : Math.PI)), () => lathe(b, [[-0.01, 0.006], [0.004, 0.0065], [0.016, 0.0008]], 5, surf('#2a2018', 0, 0.4)));
  }
  // Metal fittings: riser caps where the limbs seat.
  if (d >= 1) for (const sy of [1, -1]) b.with(M.of(M.t(0, 0.165 * sy, 0.006), M.rx(sy > 0 ? 0 : Math.PI)), () => lathe(b, [[-0.012, 0.0175], [0.004, 0.0185], [0.012, 0.012]], rs, mt.fit, { rx: 0.9, rz: 1.25 }));
  // Socketed gem in the riser above the grip, on the archer's side and the back.
  if (d >= 1) {
    b.with(M.of(M.t(0, 0.105, 0.0285), M.rx(Math.PI / 2)), () => setGem(b, 0.0085, l.gem, mt.fit, d));
    b.with(M.of(M.t(0, 0.105, -0.012), M.rx(-Math.PI / 2)), () => setGem(b, 0.0075, l.gem, mt.fit, d));
  }
  // String: tip -> nock -> tip; the nock ring is marked so the draw can move it.
  const ss = d === 2 ? 4 : 3;
  const strSec = polygon(ss, 0.0019, 0.0019);
  const nock: V3 = [0, BOW.arrowY, BOW.brace];
  const top: V3 = [0, BOW.tipY, BOW.tipZ];
  const bot: V3 = [0, -BOW.tipY, BOW.tipZ];
  /** One half of the string; returns the first vertex of its nock-end ring. */
  const stringPart = (a: V3, c: V3) => {
    const T = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]).normalize();
    const S = new THREE.Vector3(1, 0, 0);
    const N = new THREE.Vector3().crossVectors(T, S);
    const ring = (p: V3) => strSec.map(([u, v]) => [p[0] + S.x * u + N.x * v, p[1] + S.y * u + N.y * v, p[2] + S.z * u + N.z * v] as V3);
    const start = b.vertexCount;
    b.loft([ring(a), ring(c)], STRING, { smooth: true });
    return start + ss; // smooth loft: ring 0's vertices, then ring 1's
  };
  const nockIdx: number[] = [];
  for (const from of [top, bot]) {
    const first = stringPart(from, nock);
    for (let k = 0; k < ss; k++) nockIdx.push(first + k);
  }
  if (d === 2) {
    b.marks.set('nock', nockIdx);
    // Nocked arrow (shown while drawing): shaft, head, fletching, nock.
    b.mark('arrow', () => arrow(b, mt, l.material));
  }
}

/** The nocked arrow, built pointing -Z from the string's rest point. */
function arrow(b: MeshBuilder, mt: Metal, material: string): void {
  const z0 = BOW.brace;
  const z1 = BOW.brace - BOW.arrowLen;
  b.with(M.of(M.t(BOW.arrowX, BOW.arrowY, 0), M.rx(-Math.PI / 2)), () => {
    // after rx(-pi/2): local +Y -> world -Z, so y = -z
    lathe(b, [[-z0, 0.0036], [-z1 - 0.004, 0.0036]], 6, WOOD.ash, { smooth: true });
    lathe(b, [[-z0 - 0.002, 0.003], [-z0 + 0.012, 0.0045]], 6, surf('#222', 0, 0.5)); // nock
    const head = material === 'sunsteel' ? mt.edge : metalOf('iron').edge;
    lathe(b, [[-z1 - 0.006, 0.004], [-z1 + 0.012, 0.0085], [-z1 + 0.05, 0.0005]], 4, head, { smooth: false });
    // three vanes
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + Math.PI / 2;
      const ca = Math.cos(a);
      const sa = -Math.sin(a);
      const y0 = -z0 + 0.02;
      const y1 = -z0 + 0.12;
      const r0 = 0.0035;
      const vane: V3[][] = [
        [[ca * r0, y0, sa * r0], [ca * r0, y1, sa * r0]],
        [[ca * 0.016, y0 + 0.012, sa * 0.016], [ca * 0.011, y1 - 0.004, sa * 0.011]],
      ];
      b.loft(vane, k === 0 ? shade(FLETCH, 1.25) : FLETCH, { closed: false, smooth: false });
      b.loft([vane[1], vane[0]], k === 0 ? shade(FLETCH, 1.25) : FLETCH, { closed: false, smooth: false });
    }
  });
}

// ---- staff ----

function staff(b: MeshBuilder, l: WeaponLook, d: Detail): void {
  const mt = metalOf(l.material);
  const s = segsOf(d, 9, 6, 4);
  const st = segsOf(d, 26, 9, 3);
  const rings: V3[][] = [];
  const knot = (y: number) => 0.0045 * Math.exp(-Math.pow((y - 0.22) / 0.03, 2)) + 0.0035 * Math.exp(-Math.pow((y + 0.36) / 0.035, 2)) + 0.003 * Math.exp(-Math.pow((y - 0.55) / 0.025, 2));
  for (let i = 0; i <= st; i++) {
    const t = i / st;
    const y = lerp(-0.74, 0.78, t);
    const cx = 0.008 * Math.sin(y * 4.1 + 0.3);
    const cz = 0.006 * Math.sin(y * 6.3 + 1.2);
    const r0 = lerp(0.0165, 0.0195, t) + 0.0016 * Math.sin(y * 9) + knot(y);
    rings.push(circle(y, 1, s, { cx, cz, rAt: (a) => r0 + (d === 2 ? 0.0022 * (hash(i, Math.round(a * 100)) - 0.5) + 0.0012 * Math.sin(a * 3 + y * 20) : 0) }));
  }
  b.loft(rings, (r, k) => shade(WOOD.dark, 0.78 + 0.36 * hash(r * 7, k)), { smooth: true });
  // Butt cap and the collar under the head.
  lathe(b, [[-0.765, 0.0005], [-0.76, 0.013], [-0.735, 0.0185], [-0.725, 0.017]], s, mt.fit, { smooth: d < 2 });
  if (d >= 1) lathe(b, [[0.74, 0.0205], [0.75, 0.0235], [0.775, 0.0235], [0.79, 0.019]], s, (r) => (r === 1 || r === 2 ? mt.edge : mt.fit), { smooth: true });
  if (d === 2) strap(b, -0.1, 0.12, 0.0185, 3.5, LEATHER);
  // Head: carved tines rising from the collar and curling over the gem.
  const tines = d === 0 ? 0 : 4;
  for (let k = 0; k < tines; k++) {
    const a = (k / tines) * Math.PI * 2 + Math.PI / 4;
    const c = Math.cos(a);
    const sn = -Math.sin(a);
    const path = curve(
      [
        [c * 0.012, 0.785, sn * 0.012],
        [c * 0.032, 0.84, sn * 0.032],
        [c * 0.043, 0.9, sn * 0.043],
        [c * 0.036, 0.955, sn * 0.036],
        [c * 0.016, 0.99, sn * 0.016],
        [c * 0.004, 0.998, sn * 0.004],
      ],
      segsOf(d, 10, 5, 3),
    );
    const n = path.length;
    sweep(b, path, polygon(d === 2 ? 5 : 4, 0.0058, 0.0048), (r) => shade(WOOD.dark, 0.85 + 0.3 * (r / n)), { side: [Math.sin(a), 0, Math.cos(a)], smooth: true, capEnd: true, scale: (i) => [lerp(1.1, 0.35, i / (n - 1)), lerp(1.1, 0.35, i / (n - 1))] });
  }
  b.with(M.t(0, 0.9, 0), () => gem(b, d === 0 ? 0.03 : 0.034, l.gem, d));
}

// ---- wand ----

function wand(b: MeshBuilder, l: WeaponLook, d: Detail): void {
  const mt = metalOf(l.material);
  const s = segsOf(d, 10, 6, 4);
  const st = segsOf(d, 34, 10, 3);
  const bead = (y: number, at: number, h: number, w: number) => h * Math.exp(-Math.pow((y - at) / w, 2));
  const prof: [number, number][] = [];
  const isBead: boolean[] = [];
  for (let i = 0; i <= st; i++) {
    const y = lerp(-0.09, 0.262, i / st);
    const t = (y + 0.09) / 0.352;
    const bump = bead(y, 0.036, 0.0032, 0.004) + bead(y, 0.05, 0.0022, 0.003) + bead(y, 0.13, 0.0018, 0.004) + bead(y, 0.205, 0.0014, 0.004) + bead(y, -0.086, 0.004, 0.006);
    prof.push([y, lerp(0.0102, 0.0046, t) + (y < 0.03 ? 0.0008 : 0) + (d > 0 ? bump : 0)]);
    isBead.push(bump > 0.0009);
  }
  lathe(b, prof, s, (r) => (isBead[r] ? WOOD.oak : WOOD.ebony));
  if (d === 2) strap(b, -0.075, 0.025, 0.0108, 3, shade(WOOD.oak, 0.8), 0.0026, 0.0007);
  // Ferrule and three claws holding the gem.
  lathe(b, [[0.25, 0.0049], [0.258, 0.0062], [0.27, 0.0062], [0.276, 0.0052]], s, (r) => (r === 1 ? mt.edge : mt.fit), { smooth: d < 2 });
  if (d >= 1)
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      const c = Math.cos(a);
      const sn = -Math.sin(a);
      const path = curve([[c * 0.005, 0.274, sn * 0.005], [c * 0.0105, 0.285, sn * 0.0105], [c * 0.0095, 0.296, sn * 0.0095], [c * 0.004, 0.303, sn * 0.004]], d === 2 ? 5 : 3);
      sweep(b, path, polygon(3, 0.0016, 0.0013), mt.fit, { side: [Math.sin(a), 0, Math.cos(a)], smooth: true });
    }
  b.with(M.t(0, 0.292, 0), () => gem(b, 0.0125, l.gem, d));
}

const BUILDERS: Record<WeaponKind, (b: MeshBuilder, l: WeaponLook, d: Detail) => void> = { sword, spear, bow, staff, wand };

// ---- hands ----
// Built in handMesh.ts (playtest 2: an anatomical, shaded hand).

export { FIST_WRIST, OPEN_WRIST } from './handMesh';
/** Grip radius (m) the main-hand fist closes on, per weapon (models above). */
export const GRIP_R: Record<WeaponKind, number> = { sword: 0.0136, spear: 0.0178, bow: 0.0185, staff: 0.0205, wand: 0.0108 };

// ---- cache ----

const cache = new Map<string, THREE.BufferGeometry>();

export interface WeaponGeometryInfo {
  triangles: number;
  /** First-person bow: vertex indices of the string's nock ring and the arrow. */
  nock?: number[];
  arrow?: number[];
  base?: Float32Array;
}

export function buildWeapon(look: WeaponLook, d: Detail): THREE.BufferGeometry {
  const b = new MeshBuilder();
  if (look.weapon) BUILDERS[look.weapon](b, look, d);
  const g = b.build();
  const info: WeaponGeometryInfo = { triangles: b.triangleCount };
  if (look.weapon === 'bow' && d === 2) {
    info.nock = b.marks.get('nock') ?? [];
    info.arrow = b.marks.get('arrow') ?? [];
    info.base = Float32Array.from(g.getAttribute('position').array as Float32Array);
    (g.getAttribute('position') as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
  }
  g.userData.weapon = info;
  g.name = `weapon:${lookKey(look)}:${d}`;
  return g;
}

/** The cached geometry for a look at a detail level (never disposed). */
export function weaponGeometry(look: WeaponLook, d: Detail): THREE.BufferGeometry {
  const key = `${lookKey(look)}#${d}`;
  let g = cache.get(key);
  if (!g) {
    g = buildWeapon(look, d);
    cache.set(key, g);
  }
  return g;
}

/** The looks built so far ("sword|sunsteel|5#1", ...): tests and headless captures. */
export function cachedWeaponKeys(): string[] {
  return [...cache.keys()];
}

const fistGeos = new Map<string, THREE.BufferGeometry>();
let armGeo: THREE.BufferGeometry | null = null;
let openGeo: THREE.BufferGeometry | null = null;

/** A right fist closed on a grip of radius `gripR` (cached per radius and detail: 2 first person, 1 third person). */
export function fistGeometry(gripR = GRIP_R.sword, d: Detail = 2): THREE.BufferGeometry {
  const key = `${gripR.toFixed(4)}#${d}`;
  let g = fistGeos.get(key);
  if (!g) {
    g = buildFist(gripR, d === 2 ? 2 : 1);
    g.name = `fist:${key}`;
    fistGeos.set(key, g);
  }
  return g;
}

/** An open right hand, palm forward (-Z), fingers up. */
export function openHandGeometry(): THREE.BufferGeometry {
  openGeo ??= buildOpenHand();
  return openGeo;
}

export function forearmGeometry(): THREE.BufferGeometry {
  armGeo ??= buildForearm();
  return armGeo;
}

/** Where the bow's string meets the arrow at a given draw (bow-local). */
export function bowNock(draw: number): THREE.Vector3 {
  return new THREE.Vector3(0, BOW.arrowY, BOW.brace + draw);
}

/**
 * Pull the first-person bow's string back by `draw` metres; the arrow is
 * shown nocked only when `nocked`. Writes the position buffer only when the
 * values change.
 */
export function setBowDraw(g: THREE.BufferGeometry, draw: number, nocked: boolean): void {
  const info = g.userData.weapon as WeaponGeometryInfo | undefined;
  if (!info?.base || !info.nock || !info.arrow) return;
  const key = `${draw.toFixed(4)}|${nocked}`;
  if (g.userData.drawKey === key) return;
  g.userData.drawKey = key;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const a = pos.array as Float32Array;
  const base = info.base;
  for (const i of info.nock) a[i * 3 + 2] = base[i * 3 + 2] + draw;
  for (const i of info.arrow) {
    if (nocked) {
      a[i * 3] = base[i * 3];
      a[i * 3 + 1] = base[i * 3 + 1];
      a[i * 3 + 2] = base[i * 3 + 2] + draw;
    } else {
      a[i * 3] = BOW.arrowX;
      a[i * 3 + 1] = BOW.arrowY;
      a[i * 3 + 2] = BOW.brace;
    }
  }
  pos.needsUpdate = true;
}

export function weaponTriangles(g: THREE.BufferGeometry): number {
  return (g.userData.weapon as WeaponGeometryInfo | undefined)?.triangles ?? (g.index ? g.index.count / 3 : 0);
}
