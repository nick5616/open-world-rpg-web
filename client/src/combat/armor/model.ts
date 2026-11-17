// Armor meshes (playtest 2 visible armor, CR 034): an outfit's spec
// (spec.ts) lofted into low-poly pieces with the weapons' mesh builder
// (weapons/builder.ts: vertex colour + `surf` per vertex, one material).
//
//   rig   the full avatar: EVERY piece of the outfit in ONE skinned
//         geometry. Each piece is built in its rig bone's frame and bound
//         rigidly to that bone (skinIndex = the bone, weight 1), so the
//         whole outfit is one draw call however many joints it covers
//   mid   the 25-80 m figure: a static silhouette (helmet shape, body and
//         leg colour) on its capsule, one draw call
//   fp    your first-person forearm, sleeved as the body armor is
//
// Geometry is cached per appearance and shared by every avatar wearing
// it, built once when the first of them puts it on and disposed when the
// last takes it off: nothing is rebuilt per frame, or ever while an outfit
// stays the same (`armorBuilds` counts builds for the tests).
//
// Rig frames (net/avatar.ts AVATAR_RIG): feet at y = 0, facing -Z; the
// body bone at the hips (0.88 m), the torso bone 0.04 above it (the torso
// is TORSO_PROFILE in its frame), the neck bone at torso 0.62 (head sphere
// r 0.2 at neck 0.12), shoulders at torso (+-0.36, 0.5) with the upper arm
// hanging -Y (r 0.065, 0.32 long), elbows below them (forearm r 0.055,
// the fist at -0.30), hips at body (+-0.13, 0) (thigh r 0.08, 0.44 long),
// knees below them (shin r 0.065, the sole at -0.46).

import { ownSkinHex } from '../../net/ownLook';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { M, MeshBuilder, circle, lathe, polygon, shade, surf, sweep, type Surface, type SurfaceAt, type V3 } from '../weapons/builder';
import { armorSpec, BONE_INDEX, helmKind, type ArmorBone, type ArmorPart, type ArmorSpec, type Finish } from './spec';
import { ARMOR_ITEMS, armorVisualId, packAppearance, type WornPiece } from './appearance';

/** The torso outline the shell follows (net/avatar.ts TORSO_PROFILE, kept here to avoid an import cycle). */
const TORSO: readonly (readonly [number, number, number])[] = [
  [-0.2, 0.12, 0.1],
  [-0.165, 0.185, 0.14],
  [-0.09, 0.215, 0.155],
  [0.04, 0.212, 0.152],
  [0.18, 0.238, 0.165],
  [0.32, 0.272, 0.175],
  [0.42, 0.298, 0.172],
  [0.49, 0.3, 0.158],
  [0.555, 0.225, 0.125],
  [0.605, 0.12, 0.092],
];
const DELT = { x: 0.352, y: 0.493 };
const HEAD_Y = 0.12;
const HEAD_R = 0.2;
const FRONT = Math.PI / 2; // circle(): angle pi/2 is -Z, the way the rig faces

export const DARK = surf('#141218', 0.2, 0.6);

interface Ctx {
  f: Finish;
  piece: WornPiece;
  side: -1 | 0 | 1;
}

type PartBuilder = (b: MeshBuilder, c: Ctx) => void;

// ---- shape helpers ----

/**
 * Rings of an ellipse cross-section [y, half width, half depth], in either
 * order: lofted bottom to top (outward faces); a function surface and the
 * caps follow the order given (rs[0] = row 0, the start).
 */
function rows(b: MeshBuilder, rs: readonly (readonly [number, number, number])[], segs: number, sf: SurfaceAt, opts: { smooth?: boolean; capStart?: boolean; capEnd?: boolean; cz?: number } = {}): void {
  const rev = rs[0][0] > rs[rs.length - 1][0];
  const up = rev ? [...rs].reverse() : rs;
  const at: SurfaceAt = rev && typeof sf === 'function' ? (r, k) => sf(up.length - 1 - r, k) : sf;
  b.loft(
    up.map(([y, hx, hz]) => circle(y, 1, segs, { rx: hx, rz: hz, cz: opts.cz })),
    at,
    { smooth: opts.smooth ?? true, capStart: rev ? opts.capEnd : opts.capStart, capEnd: rev ? opts.capStart : opts.capEnd },
  );
}

/** A (part of a) sphere: latitudes lat0..lat1 (radians, -pi/2 bottom .. pi/2 top). */
function dome(b: MeshBuilder, c: V3, r: number, sf: SurfaceAt, o: { lat0?: number; lat1?: number; n?: number; segs?: number; sx?: number; sy?: number; sz?: number; smooth?: boolean; capStart?: boolean } = {}): void {
  const lat0 = o.lat0 ?? -0.2;
  const lat1 = o.lat1 ?? Math.PI / 2;
  const n = o.n ?? 5;
  const prof: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const a = lat0 + ((lat1 - lat0) * i) / n;
    prof.push([Math.sin(a) * r * (o.sy ?? 1), Math.max(1e-4, Math.cos(a) * r)]);
  }
  b.with(M.t(c[0], c[1], c[2]), () => lathe(b, prof, o.segs ?? 10, sf, { rx: o.sx ?? 1, rz: o.sz ?? 1, smooth: o.smooth ?? true, capStart: o.capStart }));
}

/** A tube along Y through [y, r] stations (top or bottom first), optionally capped. */
function tube(b: MeshBuilder, prof: [number, number][], segs: number, sf: SurfaceAt, o: { smooth?: boolean; rz?: number; capStart?: boolean; capEnd?: boolean } = {}): void {
  // lathe rings go bottom to top; caps follow the order given (prof[0] = start)
  const rev = prof[0][0] > prof[prof.length - 1][0];
  const p = rev ? [...prof].reverse() : prof;
  const at: SurfaceAt = rev && typeof sf === 'function' ? (r, k) => sf(p.length - 1 - r, k) : sf;
  lathe(b, p, segs, at, { smooth: o.smooth ?? true, rz: o.rz, capStart: rev ? o.capEnd : o.capStart, capEnd: rev ? o.capStart : o.capEnd });
}

/** A small faceted gem facing -Z (the inlay). */
function gem(b: MeshBuilder, at: V3, s: number, sf: Surface): void {
  b.with(M.of(M.t(at[0], at[1], at[2]), M.rx(Math.PI / 2)), () => lathe(b, [[-s * 0.55, 1e-4], [0, s], [s * 0.55, 1e-4]], 6, sf, { smooth: false, rz: 0.75 }));
}

/** A flat-ish plate: a box of half sizes (hx, hy, hz) at c. */
function plate(b: MeshBuilder, c: V3, hx: number, hy: number, hz: number, sf: SurfaceAt, rot?: THREE.Matrix4): void {
  b.with(rot ? M.of(M.t(c[0], c[1], c[2]), rot) : M.t(c[0], c[1], c[2]), () => {
    const sq = polygon(4, Math.SQRT2 * hx, Math.SQRT2 * hz, Math.PI / 4);
    b.loft([sq.map(([u, v]) => [u, -hy, -v] as V3), sq.map(([u, v]) => [u, hy, -v] as V3)], sf, { smooth: false, capStart: true, capEnd: true });
  });
}

/** Mail: the material a shade darker, alternating rows (reads as rings). */
const mail =
  (f: Finish) =>
  (r: number): Surface =>
    shade(f.base, r % 2 ? 0.7 : 0.86);

/** A row-wise surface: `bands` maps a ring index to a surface (else `base`). */
const byRow =
  (base: Surface, bands: Record<number, Surface>): SurfaceAt =>
  (r) =>
    bands[r] ?? base;

/** The foot of a boot or sabaton: heel to toe along -Z, sole at y. */
function foot(b: MeshBuilder, y: number, sf: SurfaceAt, smooth: boolean): void {
  // the lathe's +Y turned to point forward (-Z); its z (height) squashed
  b.with(M.of(M.t(0, y + 0.035, 0.02), M.rx(-Math.PI / 2)), () =>
    lathe(
      b,
      [
        [-0.075, 0.02],
        [-0.065, 0.058],
        [0.02, 0.066],
        [0.1, 0.056],
        [0.15, 0.03],
        [0.165, 0.005],
      ],
      smooth ? 10 : 8,
      sf,
      { rz: 0.62, smooth, capStart: true, capEnd: true },
    ),
  );
}

// ---- the parts ----

const SHELL_SEGS = 14;
const HOOD_SEGS = 14;

function shellRows(k = 1.08, extra = 0.008): [number, number, number][] {
  return TORSO.map(([y, hx, hz]) => [y, hx * k + extra, hz * k * 1.04 + extra]);
}

/** The torso shell every body style starts from, with its deltoid caps. */
function shell(b: MeshBuilder, c: Ctx, sf: SurfaceAt, smooth: boolean, capColor: Surface): void {
  rows(b, shellRows(), SHELL_SEGS, sf, { smooth, capStart: true, capEnd: true });
  for (const s of [-1, 1]) dome(b, [s * DELT.x, DELT.y, 0], 0.092, capColor, { lat0: -Math.PI / 2, n: 4, segs: 8, smooth });
}

/** A column (front seam, ridge) coloured on the shell: ring vertex k at the front. */
const frontSeam =
  (base: SurfaceAt, seam: Surface, segs = SHELL_SEGS): SurfaceAt =>
  (r, k) =>
    k === Math.round(segs / 4) ? seam : typeof base === 'function' ? base(r, k) : base;

const PARTS: Record<string, PartBuilder> = {
  // ---- head (neck bone) ----
  cap: (b, { f }) => {
    dome(b, [0, HEAD_Y, 0], HEAD_R + 0.016, f.base, { lat0: -0.08, n: 5, segs: 12 });
    tube(b, [[HEAD_Y - 0.03, HEAD_R + 0.02], [HEAD_Y - 0.005, HEAD_R + 0.03], [HEAD_Y + 0.02, HEAD_R + 0.022]], 12, f.trim, { capStart: false });
    // a little leather peak over the brow
    b.with(M.of(M.t(0, HEAD_Y + 0.015, -HEAD_R - 0.035), M.rx(0.25)), () => plate(b, [0, 0, 0], 0.09, 0.008, 0.045, f.under));
  },
  hood: (b, { f }) => {
    // open in front of the face, closed above the brow; the cowl drapes on the shoulders
    // (wide enough that the face band, the visor, stays inside it when the head turns)
    const R = HEAD_R + 0.058;
    const st: [number, number, number][] = [
      // y, radius, half-angle of the face opening
      [-0.13, 0.27, 0.0],
      [-0.07, 0.24, 0.55],
      [0.0, R, 0.75],
      [0.08, R + 0.01, 0.82],
      [0.16, R + 0.005, 0.78],
      [0.23, R - 0.01, 0.55],
      [0.29, R - 0.04, 0.25],
      [0.335, R - 0.1, 0.0],
      [0.36, 0.06, 0.0],
    ];
    const n = HOOD_SEGS;
    const ring = ([y, r, g]: [number, number, number]): V3[] => {
      const out: V3[] = [];
      for (let k = 0; k <= n; k++) {
        const a = FRONT + g + ((Math.PI * 2 - 2 * g - 1e-3) * k) / n;
        const back = Math.max(0, -Math.sin(a)); // the back of the head (z > 0) sits a little lower and fuller
        out.push([Math.cos(a) * r, y - back * 0.02, -Math.sin(a) * r * 1.05 + 0.02]);
      }
      return out;
    };
    b.loft(st.map(ring), byRow(f.base, { 0: f.trim }), { closed: false, smooth: true });
    // the lining: the same strips a hair inside, facing in (dark), so the opening has depth
    b.loft(
      st.slice(1, 7).map((x) => ring([x[0], x[1] - 0.012, x[2]]).reverse()),
      shade(f.under, 0.55),
      { closed: false, smooth: true },
    );
  },
  circlet: (b, { f }) => {
    tube(b, [[HEAD_Y + 0.045, HEAD_R + 0.008], [HEAD_Y + 0.06, HEAD_R + 0.018], [HEAD_Y + 0.075, HEAD_R + 0.008]], 16, f.base);
    // a rising point over the brow holds the jewel
    b.with(M.t(0, HEAD_Y + 0.08, -HEAD_R - 0.012), () => lathe(b, [[-0.03, 0.026], [0.0, 0.02], [0.04, 1e-4]], 4, f.edge, { smooth: false, rz: 0.4 }));
  },
  'helm.nasal': (b, { f }) => {
    // a conical spangenhelm: faceted plates, a brow band, the nasal bar
    const prof: [number, number][] = [];
    for (let i = 0; i <= 5; i++) {
      const a = -0.12 + ((Math.PI / 2 + 0.12) * i) / 5;
      prof.push([HEAD_Y + Math.sin(a) * (HEAD_R + 0.02) * (1 + 0.25 * (i / 5) ** 2), Math.max(1e-4, Math.cos(a) * (HEAD_R + 0.02))]);
    }
    lathe(b, prof, 8, (r, k) => (k % 2 ? f.base : shade(f.base, 0.9)), { smooth: false });
    tube(b, [[HEAD_Y - 0.035, HEAD_R + 0.03], [HEAD_Y + 0.02, HEAD_R + 0.03]], 8, f.trim, { smooth: false });
    plate(b, [0, HEAD_Y + 0.0, -HEAD_R - 0.035], 0.016, 0.075, 0.01, f.edge);
    for (const s of [-1, 1]) plate(b, [s * 0.15, HEAD_Y - 0.06, -0.11], 0.012, 0.07, 0.06, f.base, M.ry(s * 0.6));
  },
  'helm.closed': (b, { f, piece }) => {
    // a great helm: a barrel over the whole head, a domed top, a dark eye slit and breaths
    const R = HEAD_R + 0.03;
    const st: [number, number, number][] = [
      [HEAD_Y - 0.17, R * 0.86, R * 0.86],
      [HEAD_Y - 0.1, R, R * 0.98],
      [HEAD_Y + 0.05, R * 1.02, R],
      [HEAD_Y + 0.14, R * 1.0, R * 0.98],
      [HEAD_Y + 0.2, R * 0.86, R * 0.86],
      [HEAD_Y + 0.25, R * 0.55, R * 0.55],
      [HEAD_Y + 0.27, 0.02, 0.02],
    ];
    const vk = piece.material === 'voidglass';
    rows(b, st, 10, byRow(f.base, { 0: f.trim, 3: vk ? f.edge : f.base }), { smooth: false, capStart: true });
    plate(b, [0, HEAD_Y + 0.045, -R - 0.004], 0.13, 0.014, 0.012, DARK);
    plate(b, [0, HEAD_Y - 0.03, -R + 0.002], 0.012, 0.06, 0.016, f.edge);
    for (let i = 0; i < 3; i++) for (const s of [-1, 1]) plate(b, [s * (0.05 + i * 0.03), HEAD_Y - 0.07 - i * 0.006, -R + 0.01], 0.006, 0.006, 0.01, DARK);
  },
  'helm.ridge': (b, { f }) => {
    const R = HEAD_R + 0.03;
    const path: V3[] = [];
    for (let i = 0; i <= 8; i++) {
      const a = -0.25 + ((Math.PI + 0.5) * i) / 8; // front brow over the top to the back
      path.push([0, HEAD_Y + 0.08 + Math.sin(a) * (R * 0.82), -Math.cos(a) * R * 0.98]);
    }
    sweep(b, path, polygon(4, 0.012, 0.03), f.edge, { side: [1, 0, 0], smooth: false });
  },
  'helm.crest': (b, { f }) => {
    const R = HEAD_R + 0.03;
    const path: V3[] = [];
    for (let i = 0; i <= 8; i++) {
      const a = -0.1 + ((Math.PI + 0.2) * i) / 8;
      path.push([0, HEAD_Y + 0.12 + Math.sin(a) * R * 0.9, -Math.cos(a) * R]);
    }
    sweep(b, path, [[-0.008, 0], [0.008, 0], [0.004, 0.085], [-0.004, 0.085]], f.trim, { side: [1, 0, 0], smooth: false, scale: (i) => [1, 0.35 + 0.65 * Math.sin((i / 8) * Math.PI)] });
    // swept-back wings over the ears
    for (const s of [-1, 1]) b.with(M.of(M.t(s * (R + 0.005), HEAD_Y + 0.12, 0.02), M.rz(s * -0.5), M.rx(0.5)), () => plate(b, [0, 0.05, 0.02], 0.006, 0.07, 0.03, f.edge));
  },
  'helm.spikes': (b, { f }) => {
    const R = HEAD_R + 0.03;
    for (let i = 0; i < 5; i++) {
      const a = FRONT + (i - 2) * 0.55;
      const x = Math.cos(a) * R * 0.75;
      const z = -Math.sin(a) * R * 0.75;
      const h = i === 2 ? 0.16 : 0.11;
      b.with(M.of(M.t(x, HEAD_Y + 0.2, z), M.rx(-z * 1.6), M.rz(x * 1.6)), () => lathe(b, [[0, 0.03], [h, 1e-4]], 4, f.edge, { smooth: false }));
    }
  },
  'helm.rays': (b, { f }) => {
    const R = HEAD_R + 0.03;
    for (let i = 0; i < 7; i++) {
      const a = FRONT + (i - 3) * 0.32;
      const x = Math.cos(a) * R;
      const z = -Math.sin(a) * R;
      const h = i === 3 ? 0.13 : 0.08 + (i % 2) * 0.02;
      b.with(M.of(M.t(x, HEAD_Y + 0.16, z), M.ry(a - FRONT), M.rx(-0.35)), () => lathe(b, [[0, 0.02], [h, 1e-4]], 4, f.edge, { smooth: false, rz: 0.4 }));
    }
  },
  'gem.cap': (b, { f }) => f.gem && gem(b, [0, HEAD_Y + 0.11, -HEAD_R - 0.01], 0.024, f.gem),
  'gem.hood': (b, { f }) => f.gem && gem(b, [0, HEAD_Y + 0.21, -HEAD_R - 0.025], 0.024, f.gem),
  'gem.circlet': (b, { f }) => gem(b, [0, HEAD_Y + 0.085, -HEAD_R - 0.024], 0.022, f.gem ?? f.trim),
  'gem.helm': (b, { f, piece }) => f.gem && gem(b, helmKind(piece.material) === 'nasal' ? [0, HEAD_Y + 0.0, -HEAD_R - 0.05] : [0, HEAD_Y + 0.12, -HEAD_R - 0.04], 0.026, f.gem),

  // ---- body (torso bone, unless noted) ----
  'shell.jerkin': (b, c) => {
    const { f } = c;
    const sf = frontSeam(byRow(f.base, { 0: f.under, 1: f.under, 9: f.edge }), f.edge);
    shell(b, c, sf, true, f.base);
  },
  'shell.cuirass': (b, c) => {
    const { f } = c;
    const sf = frontSeam(byRow(f.base, { 0: f.trim, 8: f.edge, 9: f.edge }), f.edge);
    shell(b, c, sf, false, f.under);
  },
  'shell.mail': (b, c) => {
    const { f } = c;
    shell(b, c, (r) => (r === 0 ? f.trim : mail(f)(r)), true, f.base); // rings drawn as shading
  },
  'shell.robe': (b, c) => {
    const { f } = c;
    shell(b, c, frontSeam(byRow(f.base, { 8: f.trim, 9: f.trim }), f.trim), true, f.base);
  },
  belt: (b, { f, piece }) => {
    const sash = piece.style === 'robe';
    const s = sash ? f.trim : piece.style === 'cuirass' ? f.under : surf('#3a2617', 0, 0.85);
    rows(b, [[-0.13, 0.247, 0.183], [-0.1, 0.25, 0.186], [-0.07, 0.247, 0.183]], 14, s, { smooth: true });
    if (!sash) plate(b, [0, -0.1, -0.19], 0.032, 0.026, 0.008, piece.rarity > 0 ? f.trim : f.edge);
    else plate(b, [0.07, -0.16, -0.185], 0.025, 0.06, 0.008, f.trim, M.rz(0.15));
  },
  'pauldrons.leather': (b, { f }) => {
    for (const s of [-1, 1]) dome(b, [s * 0.365, 0.5, 0], 0.11, byRow(f.base, { 0: f.edge }), { lat0: -0.15, n: 3, segs: 10, sy: 0.75 });
  },
  'pauldrons.plate': (b, { f }) => {
    for (const s of [-1, 1]) {
      dome(b, [s * 0.375, 0.515, 0], 0.15, byRow(f.base, { 0: f.trim, 1: f.edge }), { lat0: -0.35, n: 4, segs: 10, sy: 0.72, smooth: false });
      // two lames under the cap
      for (let i = 0; i < 2; i++) b.with(M.t(s * 0.385, 0, 0), () => tube(b, [[0.44 - i * 0.055, 0.135 - i * 0.012], [0.4 - i * 0.055, 0.128 - i * 0.012]], 10, i ? f.edge : f.base, { smooth: false, rz: 0.95 }));
    }
  },
  'pauldrons.round': (b, { f }) => {
    for (const s of [-1, 1]) dome(b, [s * 0.37, 0.5, 0], 0.125, byRow(f.base, { 0: f.trim }), { lat0: -0.25, n: 4, segs: 10, sy: 0.7, smooth: false });
  },
  mantle: (b, { f }) => {
    rows(
      b,
      [
        [0.43, 0.36, 0.215],
        [0.5, 0.335, 0.2],
        [0.56, 0.26, 0.16],
        [0.61, 0.14, 0.11],
      ],
      14,
      byRow(f.base, { 0: f.trim }),
      { smooth: true },
    );
  },
  tabard: (b, { f, piece }) => {
    // the rarity's colour, muted to a dyed cloth (Bitchin' keeps its shimmer)
    const dye = piece.rarity > 0 ? { color: f.trim.color.clone().lerp(new THREE.Color('#2a2420'), 0.45), metal: 0, rough: 0.9, glow: Math.min(0, f.trim.glow) } : surf('#6b2b2b', 0, 0.9);
    const cloth = piece.material === 'sunsteel' ? surf('#efe6cf', 0, 0.9) : dye;
    // front panel down the chest and over the skirt (stops at the belt: the skirt carries on below)
    plate(b, [0, 0.15, -0.2], 0.11, 0.24, 0.006, cloth, M.rx(-0.06));
  },
  fauld: (b, { f }) => {
    // body bone: overlapping plates below the belt, flaring
    rows(
      b,
      [
        [-0.06, 0.24, 0.18],
        [-0.16, 0.265, 0.2],
        [-0.17, 0.27, 0.205],
        [-0.27, 0.29, 0.22],
        [-0.33, 0.3, 0.228],
      ],
      12,
      byRow(f.base, { 2: f.edge, 4: f.trim }),
      { smooth: false },
    );
  },
  'skirt.mail': (b, { f }) => {
    rows(
      b,
      [
        [-0.06, 0.245, 0.185],
        [-0.16, 0.27, 0.205],
        [-0.26, 0.29, 0.22],
        [-0.36, 0.305, 0.235],
        [-0.43, 0.31, 0.24],
      ],
      14,
      (r) => (r === 4 ? f.trim : mail(f)(r)),
      { smooth: true },
    );
  },
  'skirt.robe': (b, { f }) => {
    const st: [number, number, number][] = [
      [-0.06, 0.245, 0.19],
      [-0.2, 0.275, 0.215],
      [-0.36, 0.305, 0.245],
      [-0.52, 0.335, 0.27],
      [-0.66, 0.36, 0.29],
      [-0.7, 0.362, 0.292],
    ];
    rows(b, st, 14, frontSeam(byRow(f.base, { 4: f.trim, 5: f.trim }), f.trim, 14), { smooth: true });
  },
  'emblem.starmetal': (b, { f }) => {
    // a four-pointed star on the breast
    for (let i = 0; i < 4; i++) plate(b, [0, 0.32, -0.205], 0.012, 0.06, 0.006, { ...f.edge, glow: Math.max(f.edge.glow, 0.5) }, M.rz((i * Math.PI) / 4));
  },
  'emblem.sunsteel': (b, { f }) => {
    const sun = { ...f.edge, glow: Math.max(f.edge.glow, 0.9) };
    b.with(M.of(M.t(0, 0.3, -0.212), M.rx(Math.PI / 2)), () => lathe(b, [[-0.004, 1e-4], [0, 0.045], [0.004, 0.04]], 10, sun, { smooth: false }));
    for (let i = 0; i < 8; i++) plate(b, [Math.cos((i * Math.PI) / 4) * 0.068, 0.3 + Math.sin((i * Math.PI) / 4) * 0.068, -0.21], 0.008, 0.016, 0.004, sun, M.rz((i * Math.PI) / 4 - Math.PI / 2));
  },
  'emblem.voidglass': (b, { f }) => {
    for (const [x, y, h] of [
      [0, 0.34, 0.08],
      [-0.035, 0.31, 0.05],
      [0.035, 0.31, 0.05],
    ] as const)
      b.with(M.of(M.t(x, y, -0.2), M.rx(-0.3)), () => lathe(b, [[0, 0.016], [h, 1e-4]], 4, f.edge, { smooth: false }));
  },
  'gem.chest': (b, { f, piece }) => f.gem && gem(b, [0, piece.style === 'robe' ? 0.44 : 0.4, -0.215], 0.028, f.gem),

  // ---- arms ----
  'sleeve.short': (b, { f }) =>
    tube(b, [[0.075, 0.03], [0.05, 0.075], [-0.12, 0.078], [-0.16, 0.08], [-0.19, 0.074], [-0.36, 0.07], [-0.385, 0.04]], 10, byRow(f.base, { 3: f.edge, 4: f.under, 5: f.under, 6: f.under }), { capStart: true, capEnd: true }),
  'sleeve.mail': (b, { f }) => tube(b, [[0.075, 0.03], [0.05, 0.076], [-0.08, 0.078], [-0.2, 0.077], [-0.3, 0.075], [-0.36, 0.072], [-0.385, 0.04]], 10, mail(f), { capStart: true, capEnd: true }),
  'sleeve.wide': (b, { f }) => tube(b, [[0.075, 0.03], [0.05, 0.082], [-0.15, 0.09], [-0.3, 0.098], [-0.37, 0.1], [-0.39, 0.05]], 10, f.base, { capStart: true, capEnd: true }),
  bracer: (b, { f, piece }) => {
    const sleeve = piece.style === 'mail' ? f.under : f.under;
    tube(b, [[0.062, 0.03], [0.04, 0.064], [-0.06, 0.064]], 10, piece.style === 'mail' ? mail(f) : sleeve, { capStart: true });
    const leather = piece.style === 'jerkin' ? f.base : surf('#5a3a22', 0, 0.85);
    tube(b, [[-0.05, 0.071], [-0.07, 0.074], [-0.22, 0.07], [-0.25, 0.066], [-0.27, 0.05]], 10, byRow(leather, { 0: f.edge, 3: f.edge }), { capEnd: true });
  },
  vambrace: (b, { f }) => {
    tube(b, [[0.062, 0.03], [0.04, 0.066], [-0.04, 0.066]], 10, mail(f), { capStart: true });
    tube(b, [[-0.03, 0.072], [-0.15, 0.07], [-0.21, 0.074], [-0.23, 0.088], [-0.27, 0.09], [-0.28, 0.05]], 8, byRow(f.base, { 3: f.trim, 4: f.trim }), { smooth: false, capEnd: true });
    // the elbow cop, on the back of the joint
    dome(b, [0, -0.005, 0.025], 0.07, byRow(f.base, { 0: f.edge }), { lat0: -0.6, n: 3, segs: 8, sz: 0.8, smooth: false });
  },
  'cuff.wide': (b, { f }) =>
    tube(b, [[0.062, 0.03], [0.04, 0.09], [-0.08, 0.095], [-0.2, 0.108], [-0.25, 0.118], [-0.27, 0.118], [-0.28, 0.07]], 10, byRow(f.base, { 4: f.trim, 5: f.trim }), { capStart: true, capEnd: true }),

  // ---- legs (hip and knee bones) ----
  'thigh.soft': (b, { f }) => tube(b, [[0.07, 0.04], [0.05, 0.096], [-0.2, 0.094], [-0.4, 0.085], [-0.47, 0.06]], 10, f.base, { capStart: true, capEnd: true }),
  'shin.soft': (b, { f }) => {
    tube(b, [[0.05, 0.05], [0.03, 0.08], [-0.15, 0.076], [-0.3, 0.072]], 10, f.base, { capStart: true });
    dome(b, [0, 0, -0.045], 0.065, byRow(f.under, { 0: f.edge }), { lat0: -0.8, n: 3, segs: 8, sz: 0.7 });
  },
  boot: (b, { f, piece }) => {
    const leather = piece.material === 'leather' ? f.under : shade(f.under, 0.85);
    tube(b, [[-0.2, 0.084], [-0.24, 0.088], [-0.42, 0.08], [-0.44, 0.06]], 10, byRow(leather, { 0: f.edge }), { capEnd: true });
    foot(b, -0.47, byRow(leather, { 0: shade(leather, 0.6), 5: shade(leather, 0.6) }), true);
  },
  'boot.tall': (b, { f }) => {
    tube(b, [[0.045, 0.05], [0.025, 0.088], [-0.04, 0.094], [-0.07, 0.09], [-0.1, 0.08], [-0.42, 0.079], [-0.44, 0.06]], 10, byRow(f.base, { 1: f.trim, 2: f.trim, 3: f.under }), { capStart: true, capEnd: true });
    foot(b, -0.47, byRow(f.base, { 0: f.under, 5: f.under }), true);
  },
  'thigh.mail': (b, { f }) => {
    tube(b, [[0.07, 0.04], [0.05, 0.096], [-0.2, 0.094], [-0.4, 0.086], [-0.47, 0.06]], 10, mail(f), { capStart: true, capEnd: true });
    // the cuisse: a plate over the front of the thigh
    const arc: V3[][] = [];
    for (const [y, r] of [
      [-0.04, 0.108],
      [-0.2, 0.106],
      [-0.36, 0.098],
    ] as const) {
      const ring: V3[] = [];
      for (let k = 0; k <= 6; k++) {
        const a = FRONT - 1.2 + (2.4 * k) / 6;
        ring.push([Math.cos(a) * r, y, -Math.sin(a) * r]);
      }
      arc.push(ring);
    }
    b.loft(arc, byRow(f.base, { 0: f.edge, 2: f.trim }), { closed: false, smooth: false });
  },
  kneecop: (b, { f }) => {
    dome(b, [0, -0.005, -0.04], 0.078, byRow(f.base, { 0: f.trim }), { lat0: -0.7, n: 3, segs: 8, sz: 0.75, smooth: false });
    for (const s of [-1, 1]) plate(b, [s * 0.06, -0.01, -0.03], 0.006, 0.04, 0.03, f.edge, M.ry(s * 0.5));
  },
  greave: (b, { f }) => {
    tube(b, [[0.05, 0.05], [0.03, 0.078], [-0.04, 0.08], [-0.2, 0.077], [-0.36, 0.074], [-0.39, 0.078]], 8, byRow(f.base, { 1: f.edge, 5: f.edge }), { smooth: false, capStart: true });
  },
  sabaton: (b, { f }) => {
    tube(b, [[-0.37, 0.082], [-0.43, 0.08], [-0.45, 0.06]], 8, f.under, { smooth: false, capEnd: true });
    foot(b, -0.47, (r) => (r === 4 || r === 5 ? f.trim : r % 2 ? shade(f.base, 0.85) : f.base), false);
  },
  'gem.knee': (b, { f }) => f.gem && gem(b, [0, -0.005, -0.122], 0.02, f.gem),
};

/** Builder ids (tests: every part a spec names has a builder). */
export const ARMOR_PART_IDS: readonly string[] = Object.keys(PARTS);

function partCtx(spec: ArmorSpec, p: ArmorPart): Ctx | null {
  const piece = spec.pieces[p.slot === 'head' ? 0 : p.slot === 'body' ? 1 : 2];
  const f = spec.finish[p.slot];
  return piece && f ? { f, piece, side: p.side } : null;
}

// ---- the full-rig geometry (skinned) ----

/** One geometry for the whole outfit, every vertex bound to its part's bone (skinIndex, weight 1). */
export function buildRigArmor(spec: ArmorSpec): THREE.BufferGeometry {
  const byBone = new Map<number, MeshBuilder>();
  for (const p of spec.parts) {
    const c = partCtx(spec, p);
    const fn = PARTS[p.id];
    if (!c || !fn) continue;
    const bone = BONE_INDEX[p.bone];
    let b = byBone.get(bone);
    if (!b) byBone.set(bone, (b = new MeshBuilder()));
    fn(b, c);
  }
  const parts: THREE.BufferGeometry[] = [];
  for (const [bone, b] of byBone) {
    if (b.vertexCount === 0) continue;
    const g = b.build();
    const n = g.getAttribute('position').count;
    const idx = new Uint16Array(n * 4);
    const w = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      idx[i * 4] = bone;
      w[i * 4] = 1;
    }
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4));
    parts.push(g);
  }
  const out = parts.length ? mergeGeometries(parts, false)! : emptySkinned();
  for (const g of parts) g.dispose();
  out.name = `armor:${spec.ap}`;
  return out;
}

function emptySkinned(): THREE.BufferGeometry {
  const g = new MeshBuilder().build();
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(0), 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(0), 4));
  return g;
}

// ---- the mid-LOD silhouette (static, in the mid figure's body frame) ----

/** Mid figure (net/avatar.ts): capsule r 0.3 centred 0.03 below the hips, head r 0.2 at 0.74 above them. */
const MID_HEAD = 0.74;

export function buildMidArmor(spec: ArmorSpec): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const head = spec.finish.head;
  const body = spec.finish.body;
  const legs = spec.finish.legs;
  if (head) {
    const top = shade(head.base, 1);
    switch (spec.midHead) {
      case 'closed':
        dome(b, [0, MID_HEAD, 0], 0.225, byRow(top, { 0: head.trim }), { lat0: -1.1, n: 3, segs: 7, smooth: false, capStart: true });
        lathe(b, [[MID_HEAD + 0.18, 0.04], [MID_HEAD + 0.3, 1e-4]], 4, head.edge, { smooth: false, rz: 0.3 });
        break;
      case 'nasal':
        dome(b, [0, MID_HEAD, 0], 0.22, byRow(top, { 0: head.trim }), { lat0: -0.15, n: 2, segs: 7, smooth: false, sy: 1.25 });
        break;
      case 'cap':
        dome(b, [0, MID_HEAD, 0], 0.215, byRow(top, { 0: head.trim }), { lat0: -0.1, n: 2, segs: 7 });
        break;
      case 'hood':
        dome(b, [0, MID_HEAD + 0.01, 0.02], 0.24, top, { lat0: -0.9, n: 3, segs: 7, capStart: true });
        break;
      case 'circlet':
        tube(b, [[MID_HEAD + 0.04, 0.205], [MID_HEAD + 0.07, 0.205]], 8, head.base);
        break;
    }
  }
  if (body) {
    const long = spec.midBody === 'long';
    const st: [number, number, number][] = long
      ? [
          [-0.66, 0.36, 0.36],
          [-0.3, 0.33, 0.33],
          [0.2, 0.315, 0.315],
          [0.48, 0.3, 0.3],
          [0.6, 0.2, 0.2],
        ]
      : [
          [-0.32, 0.315, 0.315],
          [-0.28, 0.32, 0.32],
          [0.2, 0.315, 0.315],
          [0.48, 0.3, 0.3],
          [0.6, 0.2, 0.2],
        ];
    rows(b, st, 8, byRow(body.base, { 1: body.trim }), { smooth: !body.faceted, capStart: true, capEnd: true });
    for (const s of [-1, 1]) dome(b, [s * 0.33, 0.48, 0], 0.12, body.faceted ? body.base : body.base, { lat0: -0.5, n: 2, segs: 6, smooth: false });
  }
  if (legs) {
    const lo = spec.midBody === 'long' ? -0.7 : -0.36;
    rows(
      b,
      [
        [-0.86, 0.26, 0.28],
        [-0.72, 0.3, 0.3],
        [lo, 0.31, 0.31],
      ],
      8,
      byRow(legs.base, { 0: legs.under }),
      { smooth: !legs.faceted, capStart: true },
    );
  }
  const g = b.build();
  g.name = `armor-mid:${spec.ap}`;
  return g;
}

// ---- first person: your forearm, sleeved as the body armor (weapons/models.ts forearm frame) ----

const SKIN = surf('#c9a27e', 0, 0.7);

/** The view model's forearm: the wrist at the origin, the sleeve up +Y (null: no body armor, the plain sleeve). */
export function buildFpForearm(spec: ArmorSpec): THREE.BufferGeometry | null {
  SKIN.color.set(ownSkinHex()); // CR 047: your chosen skin tone
  const body = spec.pieces[1];
  const f = spec.finish.body;
  if (!body || !f) return null;
  const b = new MeshBuilder();
  // the wrist, as the plain forearm (weapons/models.ts)
  lathe(b, [[-0.019, 0.004], [-0.014, 0.017], [-0.006, 0.0235], [0.006, 0.0245], [0.042, 0.028]], 10, SKIN, { rx: 1, rz: 0.74 });
  const o = { rx: 1, rz: 0.86 };
  switch (body.style) {
    case 'jerkin':
      // a stitched leather bracer, the jerkin's darker sleeve above it
      lathe(b, [[0.03, 0.033], [0.036, 0.046], [0.046, 0.047], [0.06, 0.047], [0.235, 0.05], [0.25, 0.05], [0.262, 0.049], [0.27, 0.046]], 10, byRow(f.base, { 1: f.edge, 2: f.edge, 5: f.edge, 6: f.edge }), o);
      lathe(b, [[0.26, 0.045], [0.55, 0.053]], 10, f.under, o);
      break;
    case 'cuirass':
      // a plate vambrace with a flared cuff, its rim in the rarity's colour
      lathe(b, [[0.02, 0.035], [0.026, 0.053], [0.04, 0.054], [0.046, 0.054], [0.07, 0.048], [0.28, 0.054], [0.3, 0.049]], 8, byRow(f.base, { 1: f.trim, 2: f.trim }), { ...o, smooth: false });
      lathe(b, [[0.29, 0.049], [0.42, 0.052], [0.55, 0.055]], 10, mail(f), o);
      break;
    case 'mail':
      lathe(b, [[0.03, 0.04], [0.15, 0.047], [0.3, 0.05], [0.42, 0.052], [0.55, 0.055]], 10, mail(f), o);
      lathe(b, [[0.025, 0.036], [0.035, 0.051], [0.17, 0.054], [0.18, 0.045]], 10, byRow(surf('#5a3a22', 0, 0.85), { 1: f.edge }), o);
      break;
    case 'robe':
      // a bell sleeve, a band of the rarity's colour at the cuff
      lathe(b, [[0.01, 0.035], [0.016, 0.062], [0.03, 0.063], [0.038, 0.062], [0.12, 0.057], [0.3, 0.052], [0.55, 0.055]], 10, byRow(f.base, { 1: f.trim, 2: f.trim }), o);
      break;
  }
  const g = b.build();
  g.name = `armor-fp:${spec.ap}`;
  return g;
}

// ---- one piece on its own (playtest 2 ground loot: a dropped helm, cuirass or greaves) ----

/** Rest-pose joint positions (net/avatar.ts AVATAR_RIG, feet at 0): the parts' frames when nobody wears them. */
const REST: Readonly<Record<ArmorBone, V3>> = (() => {
  const hip = 0.88;
  const torso = hip + 0.04;
  const sh = torso + 0.5;
  const out: Record<string, V3> = { body: [0, hip, 0], torso: [0, torso, 0], neck: [0, torso + 0.62, 0] };
  for (const [s, k] of [
    [-1, 'L'],
    [1, 'R'],
  ] as const) {
    out[`shoulder${k}`] = [s * 0.36, sh, 0];
    out[`elbow${k}`] = [s * 0.36, sh - 0.32, 0];
    out[`hand${k}`] = [s * 0.36, sh - 0.62, 0];
    out[`hip${k}`] = [s * 0.13, hip, 0];
    out[`knee${k}`] = [s * 0.13, hip - 0.44, 0];
  }
  return out as Record<ArmorBone, V3>;
})();

const pieceCache = new Map<string, THREE.BufferGeometry | null>();

/**
 * One armor piece (items.yaml key, rarity, gem inlay) as a static geometry
 * for the armor material, every part placed at its rest-pose joint and the
 * whole centred on its bounding box (origin = the piece's centre). Cached;
 * null for a key that is not armor.
 */
export function armorPieceGeometry(key: string, rarity: number, gem = -1): THREE.BufferGeometry | null {
  const ck = `${key}|${rarity}|${gem}`;
  if (pieceCache.has(ck)) return pieceCache.get(ck)!;
  const id = armorVisualId(key);
  let g: THREE.BufferGeometry | null = null;
  if (id) {
    const slot = ARMOR_ITEMS[id - 1].armor;
    const pieces: (Pick<WornPiece, 'key' | 'rarity' | 'gem'> | null)[] = [null, null, null];
    pieces[slot === 'head' ? 0 : slot === 'body' ? 1 : 2] = { key, rarity: Math.max(0, Math.min(7, rarity)), gem };
    const spec = armorSpec(packAppearance(pieces));
    const b = new MeshBuilder();
    for (const p of spec.parts) {
      const c = partCtx(spec, p);
      const fn = PARTS[p.id];
      if (!c || !fn) continue;
      const o = REST[p.bone];
      b.with(M.t(o[0], o[1], o[2]), () => fn(b, c));
    }
    if (b.vertexCount > 0) {
      g = b.build();
      const c = g.boundingBox!.getCenter(new THREE.Vector3());
      g.translate(-c.x, -c.y, -c.z);
      g.computeBoundingBox();
      g.computeBoundingSphere();
      g.name = `armor-piece:${ck}`;
    }
  }
  pieceCache.set(ck, g);
  return g;
}

// ---- the cache ----

export interface ArmorMeshes {
  spec: ArmorSpec;
  rig: THREE.BufferGeometry;
  mid: THREE.BufferGeometry;
  /** First-person forearm (null: no body armor). */
  fp: THREE.BufferGeometry | null;
}

interface Entry extends ArmorMeshes {
  refs: number;
}

const cache = new Map<number, Entry>();
/** Outfits built so far (tests: nothing is rebuilt while an appearance stays the same). */
export const armorBuilds = { count: 0 };

/** The meshes of appearance `ap` (built on first use, shared): pair every acquire with a release. */
export function acquireArmor(ap: number): ArmorMeshes {
  let e = cache.get(ap);
  if (!e) {
    const spec = armorSpec(ap);
    e = { spec, rig: buildRigArmor(spec), mid: buildMidArmor(spec), fp: buildFpForearm(spec), refs: 0 };
    armorBuilds.count++;
    cache.set(ap, e);
  }
  e.refs++;
  return e;
}

export function releaseArmor(ap: number): void {
  const e = cache.get(ap);
  if (!e || --e.refs > 0) return;
  cache.delete(ap);
  e.rig.dispose();
  e.mid.dispose();
  e.fp?.dispose();
}

/** Outfits held now (tests). */
export function cachedArmor(): number[] {
  return [...cache.keys()];
}
