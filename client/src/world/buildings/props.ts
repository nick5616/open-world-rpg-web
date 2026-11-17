// Low-poly prop shapes for the towns layer (WP20): furniture, town dressing,
// work stations and structure loot, one function per PROP_KINDS entry.
//
// Each prop is drawn in its own frame (prop yaw: local u = (cos, sin), v =
// (-sin, cos)) with the half extents its collision box has (`dims`, taken
// from the furniture / town-prop box when there is one, worldgen kit.rs
// otherwise), so a table you bump is the table you see. "Front" (the side
// facing the room: hearth mouth, chest lid, counter) is local +v.
//
// Light sources (hearth, forge, lantern, brazier, torch, campfire,
// starmetal, crystal) draw their flame/glass with the always-on glow and
// report an emitter for the night light pool.

import { PROP_KINDS, type TownProp } from '@lodestone/worldgen';
import { at, dirOf, frameOf, moved, turned, type Frame, type MeshBuilder, type V3 } from './meshBuilder';
import { TEX, TILE_M, type TexName } from './textures';
import { detail } from './detail';

export const PK = Object.fromEntries(PROP_KINDS.map((k, i) => [k, i])) as Record<(typeof PROP_KINDS)[number], number>;

/** Half extents along prop u, v and height (worldgen kit.rs / layout.rs solid boxes). */
export interface PropDims {
  hu: number;
  hv: number;
  h: number;
}

export const DEFAULT_DIMS: Partial<Record<(typeof PROP_KINDS)[number], PropDims>> = {
  bed: { hu: 0.5, hv: 1.0, h: 0.5 },
  table: { hu: 0.7, hv: 0.45, h: 0.78 },
  bench: { hu: 0.6, hv: 0.16, h: 0.45 },
  hearth: { hu: 0.75, hv: 0.4, h: 1.1 },
  chest: { hu: 0.45, hv: 0.3, h: 0.55 },
  barrel: { hu: 0.3, hv: 0.3, h: 0.9 },
  crate: { hu: 0.4, hv: 0.4, h: 0.8 },
  shelf: { hu: 0.2, hv: 0.6, h: 1.8 },
  counter: { hu: 0.35, hv: 1.6, h: 1.05 },
  forge: { hu: 0.85, hv: 0.75, h: 1.0 },
  anvil: { hu: 0.4, hv: 0.22, h: 0.8 },
  quench: { hu: 0.4, hv: 0.4, h: 0.7 },
  workbench: { hu: 0.9, hv: 0.35, h: 0.9 },
  stall: { hu: 1.5, hv: 0.3, h: 1.0 },
  board: { hu: 0.9, hv: 0.15, h: 2.2 },
  well: { hu: 0.8, hv: 0.8, h: 0.9 },
  wardBed: { hu: 0.9, hv: 0.45, h: 0.3 },
  rug: { hu: 1.0, hv: 0.7, h: 0.02 },
  bookshelf: { hu: 0.25, hv: 0.6, h: 2.0 },
  statue: { hu: 0.5, hv: 0.5, h: 2.4 },
};

export interface Emitter {
  x: number;
  y: number;
  z: number;
  r: number;
  g: number;
  b: number;
  range: number;
}

export interface PropCtx {
  /** Wall thickness of the owning building (doors hang on its inner face). */
  wt: number;
  /** Door prop: the building has an open front (forge): no door leaf. */
  openFront: boolean;
  /** Ground height (for things that follow the terrain: fields). */
  heightAt: (x: number, z: number) => number;
  light: (e: Emitter) => void;
}

const FIRE: V3 = [1, 0.85, 0.7];
const W = (k: number): V3 => [k, k, k];

/** Paint by layer name. */
export function P(mb: MeshBuilder, name: TexName, color: V3 = [1, 1, 1], glow = 0): MeshBuilder {
  return mb.paint(TEX[name], TILE_M[name] || 1, color, glow);
}

/** A flame: two crossed quads with the fire picture (always-on glow). */
export function flame(mb: MeshBuilder, x: number, y: number, z: number, w: number, h: number, strength = 200): void {
  mb.paint(TEX.fire, 0, FIRE, strength);
  for (const a of [0, Math.PI / 2]) {
    const c = Math.cos(a) * w * 0.5;
    const s = Math.sin(a) * w * 0.5;
    const uv: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const pts: V3[] = [
      [x - c, y, z - s],
      [x + c, y, z + s],
      [x + c, y + h, z + s],
      [x - c, y + h, z - s],
    ];
    mb.poly(pts, [-s, 0, c], uv);
    mb.poly(pts.slice().reverse(), [s, 0, -c], uv.slice().reverse());
  }
}

/** Glowing lantern head (a small glass box with a cap). */
function lanternHead(mb: MeshBuilder, f: Frame, u: number, v: number, y: number, ctx: PropCtx, tint: V3 = [1, 0.78, 0.45]): void {
  P(mb, 'metal');
  mb.box(f, u - 0.14, u + 0.14, y + 0.36, y + 0.42, v - 0.14, v + 0.14, { bottom: true });
  mb.cyl(f, u, v, y + 0.42, y + 0.56, 0.12, 4, { r1: 0.0, a0: Math.PI / 4 });
  P(mb, 'glow', tint, 170);
  mb.box(f, u - 0.11, u + 0.11, y, y + 0.36, v - 0.11, v + 0.11, { bottom: true });
  const p = at(f, u, y + 0.18, v);
  ctx.light({ x: p[0], y: p[1], z: p[2], r: 1, g: 0.72, b: 0.4, range: 12 });
}

function legs(mb: MeshBuilder, f: Frame, hu: number, hv: number, y0: number, y1: number, t: number): void {
  for (const su of [-1, 1]) for (const sv of [-1, 1]) mb.box(f, su * (hu - t) - t, su * (hu - t) + t, y0, y1, sv * (hv - t) - t, sv * (hv - t) + t, { top: false });
}

/**
 * Draw one prop. `y` is the prop's base (floor or ground); `d` its half
 * extents in the prop frame.
 */
export function drawProp(mb: MeshBuilder, p: TownProp, d: PropDims, ctx: PropCtx): void {
  const f = frameOf(p.x, p.z, p.yaw);
  const y = p.y;
  const k = PROP_KINDS[p.kind];
  const v8 = p.variant;
  switch (k) {
    case 'door': {
      if (ctx.openFront) return;
      const w = Math.max(0.8, v8 / 10);
      const h = 2.28;
      // Open leaves swung into the room against the jambs (the doorway is open in collision).
      const leaves = w > 1.6 ? 2 : 1;
      const lw = w / leaves;
      P(mb, 'door');
      for (let l = 0; l < leaves; l++) {
        const side = l === 0 ? -1 : 1;
        const hinge = moved(f, side * (w * 0.5 - 0.02), ctx.wt * 0.5);
        const g = turned(hinge, side < 0 ? Math.PI / 2 - 0.15 : Math.PI / 2 + 0.15);
        // Leaf along local +u of g from the hinge, 6 cm thick.
        const u0 = side < 0 ? 0 : -lw;
        const u1 = side < 0 ? lw : 0;
        const uv: [number, number][] = [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ];
        const a: V3 = at(g, u0, y + 0.02, -0.03);
        const b: V3 = at(g, u1, y + 0.02, -0.03);
        const c: V3 = at(g, u1, y + h, -0.03);
        const e: V3 = at(g, u0, y + h, -0.03);
        mb.poly([a, b, c, e], dirOf(g, 0, 0, -1), uv);
        const a2: V3 = at(g, u0, y + 0.02, 0.03);
        const b2: V3 = at(g, u1, y + 0.02, 0.03);
        const c2: V3 = at(g, u1, y + h, 0.03);
        const e2: V3 = at(g, u0, y + h, 0.03);
        mb.poly([a2, b2, c2, e2], dirOf(g, 0, 0, 1), uv);
        P(mb, 'wood', W(0.7));
        mb.box(g, u0, u1, y + h - 0.02, y + h, -0.03, 0.03);
        P(mb, 'door');
      }
      return;
    }
    case 'bed': {
      P(mb, 'wood');
      mb.box(f, -d.hu, d.hu, y, y + 0.3, -d.hv, d.hv);
      mb.box(f, -d.hu, d.hu, y, y + 0.75, d.hv - 0.08, d.hv); // headboard
      const blanket: V3[] = [
        [0.75, 0.32, 0.28],
        [0.3, 0.45, 0.62],
        [0.36, 0.55, 0.34],
        [0.7, 0.6, 0.35],
      ];
      P(mb, 'cloth', blanket[v8 & 3]);
      mb.box(f, -d.hu + 0.05, d.hu - 0.05, y + 0.3, y + 0.46, -d.hv + 0.05, d.hv - 0.45);
      P(mb, 'cloth', W(0.95));
      mb.box(f, -d.hu + 0.08, d.hu - 0.08, y + 0.3, y + 0.5, d.hv - 0.42, d.hv - 0.1);
      if (detail() >= 1) {
        // Footboard, corner posts with finials, a folded blanket at the foot and a quilt stripe.
        P(mb, 'wood');
        mb.box(f, -d.hu, d.hu, y + 0.3, y + 0.5, -d.hv, -d.hv + 0.07, { bottom: false });
        for (const su of [-1, 1]) {
          mb.box(f, su * d.hu - (su > 0 ? 0.07 : 0), su * d.hu + (su < 0 ? 0.07 : 0), y, y + 1.05, d.hv - 0.07, d.hv, { top: true });
          mb.cyl(f, su * (d.hu - 0.035), d.hv - 0.035, y + 1.05, y + 1.14, 0.05, 6, { r1: 0.03 });
        }
        P(mb, 'stripes', [blanket[(v8 + 1) & 3][0] * 0.9, blanket[(v8 + 1) & 3][1] * 0.9, blanket[(v8 + 1) & 3][2] * 0.9]);
        mb.box(f, -d.hu + 0.04, d.hu - 0.04, y + 0.46, y + 0.49, -d.hv + 0.35, -d.hv + 0.65, { bottom: false });
      }
      return;
    }
    case 'table': {
      P(mb, 'wood');
      mb.box(f, -d.hu, d.hu, y + d.h - 0.06, y + d.h, -d.hv, d.hv, { bottom: true });
      legs(mb, f, d.hu - 0.05, d.hv - 0.05, y, y + d.h - 0.06, 0.05);
      // A mug and a plate.
      P(mb, 'plain', [0.62, 0.5, 0.38]);
      mb.cyl(f, d.hu * 0.4, 0, y + d.h, y + d.h + 0.12, 0.05, 6);
      P(mb, 'plain', [0.85, 0.82, 0.76]);
      mb.cyl(f, -d.hu * 0.3, 0.05, y + d.h, y + d.h + 0.02, 0.13, 8);
      if (detail() >= 1) {
        // A cloth runner, a loaf, and on some tables a candle (flame: emissive, flickering, no light).
        const runner: V3[] = [[0.85, 0.35, 0.3], [0.35, 0.5, 0.72], [0.9, 0.85, 0.7]];
        P(mb, 'cloth', runner[v8 % 3]);
        mb.box(f, -d.hu * 0.9, d.hu * 0.9, y + d.h, y + d.h + 0.008, -0.12, 0.12, { bottom: false, sides: false });
        P(mb, 'wood', [1.1, 0.85, 0.55]);
        mb.box(f, d.hu * 0.05, d.hu * 0.05 + 0.2, y + d.h + 0.008, y + d.h + 0.07, -0.07, 0.06);
        if (detail() >= 2 && (v8 + p.index) % 2 === 0) {
          P(mb, 'cloth', [1, 0.96, 0.85]);
          mb.cyl(f, -d.hu * 0.65, -0.04, y + d.h + 0.008, y + d.h + 0.14, 0.028, 5);
          const c = at(f, -d.hu * 0.65, y + d.h + 0.14, -0.04);
          flame(mb, c[0], c[1], c[2], 0.06, 0.1, 210);
        }
      }
      return;
    }
    case 'bench': {
      P(mb, 'wood', W(0.9));
      const hu = Math.min(d.hu, 0.65);
      mb.box(f, -hu, hu, y + 0.4, y + 0.46, -0.16, 0.16, { bottom: true });
      mb.box(f, -hu + 0.05, -hu + 0.13, y, y + 0.4, -0.13, 0.13, { top: false });
      mb.box(f, hu - 0.13, hu - 0.05, y, y + 0.4, -0.13, 0.13, { top: false });
      return;
    }
    case 'hearth': {
      // Stone hearth with its mouth at +v, a fire inside, a hood above.
      P(mb, v8 === 2 ? 'adobe' : 'fieldstone');
      mb.box(f, -d.hu, d.hu, y, y + 0.35, -d.hv, d.hv);
      mb.box(f, -d.hu, -d.hu + 0.25, y + 0.35, y + d.h, -d.hv, d.hv);
      mb.box(f, d.hu - 0.25, d.hu, y + 0.35, y + d.h, -d.hv, d.hv);
      mb.box(f, -d.hu, d.hu, y + 0.35, y + d.h, -d.hv, -d.hv + 0.15);
      mb.box(f, -d.hu, d.hu, y + d.h - 0.25, y + d.h, -d.hv, d.hv, { bottom: true });
      mb.box(f, -d.hu * 0.6, d.hu * 0.6, y + d.h, y + d.h + 1.2, -d.hv, -d.hv + 0.45);
      P(mb, 'wood', W(0.45));
      mb.hcyl(f, -0.3, 0.3, y + 0.42, 0, 0.06, 5);
      if (detail() >= 1) {
        // A mantel board over the opening, a cauldron on a swing crane, split logs on the hearth stone.
        P(mb, 'wood', W(0.55));
        mb.box(f, -d.hu - 0.08, d.hu + 0.08, y + d.h + 0.0, y + d.h + 0.07, -d.hv - 0.04, d.hv + 0.12, { bottom: true });
        mb.box(f, d.hu * 0.45, d.hu * 0.45 + 0.05, y + 0.4, y + d.h - 0.3, -d.hv + 0.2, -d.hv + 0.25);
        mb.box(f, -0.1, d.hu * 0.45 + 0.05, y + d.h - 0.35, y + d.h - 0.3, -d.hv + 0.2, -d.hv + 0.25, { bottom: true });
        P(mb, 'metal', W(0.55));
        mb.cyl(f, -0.1, -d.hv + 0.22, y + 0.5, y + 0.76, 0.2, 7, { r1: 0.24, top: false });
        mb.box(f, -0.11, -0.09, y + 0.76, y + d.h - 0.35, -d.hv + 0.21, -d.hv + 0.23, { top: false });
        P(mb, 'logs', [0.7, 0.6, 0.5]);
        mb.hcyl(turned(f, 0.15), -0.28, 0.28, y + 0.45, 0.15, 0.06, 5);
      }
      const c = at(f, 0, y + 0.38, 0);
      flame(mb, c[0], c[1], c[2], 0.6, 0.5);
      ctx.light({ x: c[0], y: c[1] + 0.4, z: c[2], r: 1, g: 0.55, b: 0.25, range: 9 });
      return;
    }
    case 'chest': {
      P(mb, 'wood', [0.85, 0.7, 0.55]);
      mb.box(f, -d.hu, d.hu, y, y + d.h * 0.7, -d.hv, d.hv);
      mb.hcyl(f, -d.hu, d.hu, y + d.h * 0.7, 0, d.hv, 6);
      P(mb, 'metal');
      mb.box(f, -0.05, 0.05, y + d.h * 0.45, y + d.h * 0.7, d.hv, d.hv + 0.02, { top: false });
      return;
    }
    case 'barrel': {
      P(mb, 'wood', [0.8, 0.62, 0.45]);
      const r = Math.min(d.hu, d.hv);
      mb.cyl(f, 0, 0, y, y + d.h * 0.5, r * 0.85, 8, { r1: r, top: false });
      mb.cyl(f, 0, 0, y + d.h * 0.5, y + d.h, r, 8, { r1: r * 0.85 });
      P(mb, 'metal');
      mb.cyl(f, 0, 0, y + d.h * 0.2, y + d.h * 0.26, r * 0.92, 8, { top: false });
      mb.cyl(f, 0, 0, y + d.h * 0.74, y + d.h * 0.8, r * 0.92, 8, { top: false });
      return;
    }
    case 'crate': {
      P(mb, 'planks', [0.95, 0.85, 0.65]);
      mb.box(f, -d.hu, d.hu, y, y + d.h, -d.hv, d.hv);
      return;
    }
    case 'shelf':
    case 'bookshelf': {
      P(mb, 'wood', W(0.8));
      mb.box(f, -d.hu, d.hu, y, y + d.h, -d.hv, -d.hv + 0.05);
      mb.box(f, -d.hu, d.hu, y, y + d.h, d.hv - 0.05, d.hv);
      mb.box(f, -d.hu, d.hu, y + d.h - 0.04, y + d.h, -d.hv, d.hv);
      // Filled both sides (shelves stand against side or back walls).
      if (k === 'bookshelf' || v8 === 1) {
        P(mb, 'books');
        mb.box(f, -d.hu + 0.02, d.hu - 0.02, y + 0.05, y + d.h - 0.06, -d.hv + 0.05, d.hv - 0.05, { top: false });
      } else {
        for (let s = 0; s < 4; s++) mb.box(f, -d.hu, d.hu, y + 0.1 + s * 0.45, y + 0.13 + s * 0.45, -d.hv, d.hv, { bottom: true });
        P(mb, 'plain', v8 === 2 ? [0.42, 0.42, 0.45] : [0.7, 0.55, 0.38]);
        for (let s = 0; s < 3; s++) mb.cyl(f, 0, -d.hv * 0.4 + s * d.hv * 0.4, y + 0.58, y + 0.78, 0.07, 6);
      }
      return;
    }
    case 'counter': {
      P(mb, 'planks', [0.9, 0.75, 0.55]);
      mb.box(f, -d.hu, d.hu, y, y + d.h - 0.06, -d.hv, d.hv);
      P(mb, 'wood');
      mb.box(f, -d.hu - 0.05, d.hu + 0.05, y + d.h - 0.06, y + d.h, -d.hv - 0.05, d.hv + 0.05, { bottom: true });
      P(mb, 'plain', [0.62, 0.5, 0.38]);
      mb.cyl(f, 0, d.hv * 0.5, y + d.h, y + d.h + 0.14, 0.05, 6);
      return;
    }
    case 'forge': {
      // Stone forge: coal bed glowing on top, hood and flue to the roof.
      P(mb, 'stone', W(0.8));
      mb.box(f, -d.hu, d.hu, y, y + d.h * 0.85, -d.hv, d.hv);
      mb.box(f, -d.hu, d.hu, y + d.h * 0.85, y + d.h, -d.hv, -d.hv + 0.2);
      mb.box(f, -d.hu, -d.hu + 0.15, y + d.h * 0.85, y + d.h, -d.hv, d.hv);
      mb.box(f, d.hu - 0.15, d.hu, y + d.h * 0.85, y + d.h, -d.hv, d.hv);
      // Coal bed: a dull red glow (the flame above does the bright part).
      P(mb, 'glow', [0.9, 0.3, 0.08], 128 + 26);
      mb.box(f, -d.hu + 0.15, d.hu - 0.15, y + d.h * 0.85, y + d.h * 0.9, -d.hv + 0.2, d.hv);
      P(mb, 'metal', W(0.6));
      mb.cyl(f, 0, -d.hv * 0.3, y + d.h + 0.8, y + d.h + 1.4, d.hu * 0.9, 4, { r1: 0.25, a0: Math.PI / 4, top: false });
      mb.cyl(f, 0, -d.hv * 0.3, y + d.h + 1.4, y + 3.2, 0.25, 4, { a0: Math.PI / 4 });
      const c = at(f, 0, y + d.h * 0.9, 0.1);
      flame(mb, c[0], c[1], c[2], 0.7, 0.35, 200);
      ctx.light({ x: c[0], y: c[1] + 0.5, z: c[2], r: 1, g: 0.45, b: 0.15, range: 10 });
      return;
    }
    case 'anvil': {
      P(mb, 'wood', W(0.7));
      mb.cyl(f, 0, 0, y, y + d.h * 0.6, 0.22, 7);
      P(mb, 'metal', W(0.75));
      mb.box(f, -0.1, 0.1, y + d.h * 0.6, y + d.h * 0.78, -0.12, 0.12);
      mb.box(f, -d.hu * 0.75, d.hu * 0.75, y + d.h * 0.78, y + d.h, -0.13, 0.13, { bottom: true });
      return;
    }
    case 'quench': {
      P(mb, 'wood', [0.75, 0.6, 0.45]);
      mb.cyl(f, 0, 0, y, y + d.h, Math.min(d.hu, d.hv), 8, { top: false });
      P(mb, 'water');
      mb.cyl(f, 0, 0, y + d.h - 0.08, y + d.h - 0.07, Math.min(d.hu, d.hv) - 0.03, 8);
      return;
    }
    case 'workbench': {
      if (v8 === 9) {
        // Mineshaft winch: an A-frame with a rope drum and crank.
        P(mb, 'wood', W(0.75));
        for (const su of [-0.7, 0.7]) {
          mb.box(f, su - 0.06, su + 0.06, y, y + 1.3, -0.35, -0.25);
          mb.box(f, su - 0.06, su + 0.06, y, y + 1.3, 0.25, 0.35);
        }
        P(mb, 'wood', W(0.55));
        mb.hcyl(f, -0.7, 0.7, y + 1.05, 0, 0.22, 8);
        P(mb, 'plain', [0.7, 0.62, 0.45]);
        mb.hcyl(f, -0.5, 0.5, y + 1.05, 0, 0.25, 8, false);
        P(mb, 'metal');
        mb.box(f, 0.7, 0.76, y + 0.8, y + 1.1, -0.04, 0.04);
        return;
      }
      P(mb, 'wood');
      mb.box(f, -d.hu, d.hu, y + d.h - 0.08, y + d.h, -d.hv, d.hv, { bottom: true });
      legs(mb, f, d.hu - 0.05, d.hv - 0.05, y, y + d.h - 0.08, 0.06);
      P(mb, 'metal');
      mb.box(f, -d.hu * 0.5, -d.hu * 0.2, y + d.h, y + d.h + 0.05, -0.1, 0.05);
      P(mb, 'planks', W(0.9));
      mb.box(f, d.hu * 0.2, d.hu * 0.7, y + d.h, y + d.h + 0.08, -0.15, 0.1);
      return;
    }
    case 'stall': {
      // Market stall: counter, four posts, striped awning (stall buildings).
      const hu = d.hu;
      P(mb, 'planks', [0.9, 0.75, 0.55]);
      mb.box(f, -hu, hu, y, y + d.h, -d.hv, d.hv);
      P(mb, 'wood');
      for (const su of [-hu, hu]) for (const sv of [-d.hv, 1.6]) mb.box(f, su - 0.06, su + 0.06, y, y + 2.4, sv - 0.06, sv + 0.06, { top: false });
      const tints: V3[] = [
        [1, 1, 1],
        [0.5, 0.75, 1.1],
        [0.55, 1.0, 0.6],
        [1.1, 0.9, 0.5],
      ];
      P(mb, 'stripes', tints[v8 & 3]);
      const a = at(f, -hu - 0.2, y + 2.25, -d.hv - 0.5);
      const b = at(f, hu + 0.2, y + 2.25, -d.hv - 0.5);
      const c = at(f, hu + 0.2, y + 2.6, 1.8);
      const e = at(f, -hu - 0.2, y + 2.6, 1.8);
      mb.quad(a, b, c, e, [0, 1, 0]);
      mb.quad(a, b, c, e, [0, -1, 0]);
      // Wares on the counter.
      const ware: V3[] = [
        [0.85, 0.3, 0.2],
        [0.9, 0.75, 0.3],
        [0.4, 0.7, 0.3],
        [0.6, 0.45, 0.3],
      ];
      for (let i = 0; i < 4; i++) {
        P(mb, 'plain', ware[(i + v8) & 3]);
        mb.box(f, -hu + 0.3 + i * ((2 * hu - 0.6) / 4), -hu + 0.6 + i * ((2 * hu - 0.6) / 4), y + d.h, y + d.h + 0.15, -0.2, 0.15);
      }
      return;
    }
    case 'board': {
      P(mb, 'wood', W(0.7));
      for (const su of [-d.hu + 0.08, d.hu - 0.08]) mb.box(f, su - 0.07, su + 0.07, y - 0.3, y + d.h, -0.07, 0.07);
      P(mb, 'paper');
      const uv: [number, number][] = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ];
      for (const sv of [-1, 1]) {
        const vv = sv * 0.05;
        mb.poly([at(f, -d.hu, y + 0.9, vv), at(f, d.hu, y + 0.9, vv), at(f, d.hu, y + 2.0, vv), at(f, -d.hu, y + 2.0, vv)], dirOf(f, 0, 0, sv), uv);
      }
      P(mb, 'planks', W(0.8));
      mb.box(f, -d.hu, d.hu, y + 0.85, y + 2.05, -0.04, 0.04, { sides: true, top: false });
      P(mb, 'shingle');
      mb.slopedBox(turned(f, Math.PI / 2), -0.35, 0, -d.hu - 0.15, d.hu + 0.15, y + d.h - 0.05, y + d.h - 0.05, y + d.h + 0.25);
      mb.slopedBox(turned(f, Math.PI / 2), 0, 0.35, -d.hu - 0.15, d.hu + 0.15, y + d.h - 0.05, y + d.h + 0.25, y + d.h - 0.05);
      return;
    }
    case 'well': {
      // Octagonal stone ring inside the box, a little roof on posts.
      const r = Math.min(d.hu, d.hv);
      P(mb, 'fieldstone');
      mb.cyl(f, 0, 0, y - 0.3, y + d.h, r, 8, { top: false, a0: Math.PI / 8 });
      mb.cyl(f, 0, 0, y + d.h - 0.02, y + d.h, r, 8, { a0: Math.PI / 8 });
      P(mb, 'water');
      mb.cyl(f, 0, 0, y + 0.1, y + 0.12, r - 0.2, 8, { a0: Math.PI / 8 });
      P(mb, 'wood', W(0.7));
      for (const su of [-r + 0.1, r - 0.1]) mb.box(f, su - 0.06, su + 0.06, y + d.h, y + 2.3, -0.06, 0.06, { top: false });
      mb.hcyl(f, -r + 0.1, r - 0.1, y + 1.7, 0, 0.06, 6);
      P(mb, 'shingle');
      mb.slopedBox(turned(f, Math.PI / 2), -0.8, 0, -r - 0.2, r + 0.2, y + 2.25, y + 2.25, y + 2.75);
      mb.slopedBox(turned(f, Math.PI / 2), 0, 0.8, -r - 0.2, r + 0.2, y + 2.25, y + 2.75, y + 2.25);
      P(mb, 'wood', W(0.6));
      mb.cyl(f, 0.2, 0, y + 1.2, y + 1.45, 0.14, 6, { r1: 0.17 });
      return;
    }
    case 'lantern': {
      P(mb, 'wood', W(0.55));
      mb.box(f, -0.07, 0.07, y - 0.3, y + 2.6, -0.07, 0.07);
      mb.box(f, -0.04, 0.04, y + 2.5, y + 2.58, -0.07, 0.6);
      lanternHead(mb, f, 0, 0.55, y + 2.02, ctx);
      return;
    }
    case 'wardBed': {
      // Ward flowers (spec 8): pale violet blooms demons cannot pass.
      P(mb, 'soil');
      mb.box(f, -0.9, 0.9, y - 0.2, y + 0.18, -0.45, 0.45);
      P(mb, 'wood', W(0.6));
      mb.box(f, -0.95, 0.95, y - 0.2, y + 0.24, -0.5, -0.45, { top: true });
      mb.box(f, -0.95, 0.95, y - 0.2, y + 0.24, 0.45, 0.5, { top: true });
      for (let i = 0; i < 8; i++) {
        const u = -0.75 + (i % 4) * 0.5;
        const v = i < 4 ? -0.2 : 0.2;
        P(mb, 'plain', [0.28, 0.5, 0.24]);
        mb.cyl(f, u, v, y + 0.18, y + 0.45, 0.08, 4, { r1: 0.02 });
        P(mb, 'glow', [0.72, 0.6, 1.0], 140 + 6);
        mb.cyl(f, u, v, y + 0.45, y + 0.55, 0.09, 5, { r1: 0.03 });
      }
      return;
    }
    case 'crops': {
      drawField(mb, p, ctx);
      return;
    }
    case 'rug': {
      P(mb, 'rug');
      const uv: [number, number][] = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ];
      mb.poly([at(f, -d.hu, y + 0.015, -d.hv), at(f, d.hu, y + 0.015, -d.hv), at(f, d.hu, y + 0.015, d.hv), at(f, -d.hu, y + 0.015, d.hv)], [0, 1, 0], uv);
      return;
    }
    case 'campfire': {
      P(mb, 'rock', W(0.7));
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        mb.cyl(f, Math.cos(a) * 0.55, Math.sin(a) * 0.55, y - 0.05, y + 0.18, 0.13, 5);
      }
      P(mb, 'wood', W(0.4));
      mb.hcyl(turned(f, 0.4), -0.4, 0.4, y + 0.1, 0, 0.06, 5);
      mb.hcyl(turned(f, 2.0), -0.4, 0.4, y + 0.14, 0, 0.06, 5);
      flame(mb, p.x, y + 0.05, p.z, 0.8, 0.9, 240);
      ctx.light({ x: p.x, y: y + 0.6, z: p.z, r: 1, g: 0.55, b: 0.22, range: 14 });
      return;
    }
    case 'tent': {
      return; // tents are drawn from their structure piece
    }
    case 'starmetal': {
      // Starmetal cluster (meteor crater veins): dark metal spikes with a blue glow.
      const n = 3 + (v8 % 3);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + v8;
        const g = turned(moved(f, Math.cos(a) * 0.25, Math.sin(a) * 0.25), a);
        P(mb, 'metal', [0.55, 0.6, 0.75]);
        mb.cyl(g, 0, 0, y - 0.1, y + 0.5 + (i % 2) * 0.35, 0.16, 5, { r1: 0.02 });
      }
      P(mb, 'glow', [0.45, 0.7, 1.2], 160 + 30);
      mb.cyl(f, 0, 0, y, y + 0.8, 0.09, 4, { r1: 0.0 });
      ctx.light({ x: p.x, y: y + 0.6, z: p.z, r: 0.45, g: 0.7, b: 1, range: 8 });
      return;
    }
    case 'statue': {
      P(mb, 'mossStone', W(0.95));
      mb.box(f, -0.55, 0.55, y - 0.2, y + 0.6, -0.55, 0.55);
      P(mb, 'stone', W(1.05));
      mb.box(f, -0.3, 0.3, y + 0.6, y + 1.7, -0.2, 0.2);
      mb.box(f, -0.45, 0.45, y + 1.45, y + 1.75, -0.22, 0.22);
      mb.cyl(f, 0, 0, y + 1.75, y + 2.15, 0.17, 6);
      mb.box(f, -0.08, 0.08, y + 1.0, y + 2.55, 0.25, 0.35); // a raised staff
      return;
    }
    case 'crystal': {
      P(mb, 'glow', [0.6, 0.4, 1.2], 128 + 60);
      mb.cyl(f, 0, 0, y + 0.3, y + 1.0, 0.0001, 4, { r1: 0.45, top: false });
      mb.cyl(f, 0, 0, y + 1.0, y + 1.9, 0.45, 4, { r1: 0.0 });
      ctx.light({ x: p.x, y: y + 1, z: p.z, r: 0.6, g: 0.4, b: 1, range: 16 });
      return;
    }
    case 'brazier': {
      P(mb, 'metal', W(0.8));
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        mb.box(turned(f, a), 0.18, 0.26, y, y + 0.8, -0.03, 0.03, { top: false });
      }
      mb.cyl(f, 0, 0, y + 0.75, y + 1.0, 0.25, 8, { r1: 0.4, top: false });
      P(mb, 'glow', [1, 0.45, 0.15], 200);
      mb.cyl(f, 0, 0, y + 0.92, y + 0.95, 0.33, 8);
      flame(mb, p.x, y + 0.93, p.z, 0.6, 0.7, 230);
      ctx.light({ x: p.x, y: y + 1.4, z: p.z, r: 1, g: 0.55, b: 0.22, range: 14 });
      return;
    }
    case 'bones': {
      P(mb, 'plain', [0.86, 0.82, 0.7]);
      for (let i = 0; i < 5; i++) mb.hcyl(turned(moved(f, (i % 3) * 0.3 - 0.3, (i % 2) * 0.3), i * 1.3), -0.35, 0.35, y + 0.05, 0, 0.04, 5);
      mb.cyl(f, 0.4, -0.2, y, y + 0.22, 0.13, 6, { r1: 0.1 });
      return;
    }
    case 'rubble': {
      P(mb, 'rock', W(0.85));
      for (let i = 0; i < 4; i++) {
        const a = i * 1.9 + v8;
        mb.box(turned(moved(f, Math.cos(a) * 0.5, Math.sin(a) * 0.5), a), -0.25, 0.25, y - 0.1, y + 0.2 + (i % 2) * 0.15, -0.2, 0.2);
      }
      return;
    }
    case 'torch': {
      // Wall torch: y is the flame height.
      P(mb, 'wood', W(0.5));
      mb.cyl(f, 0, 0, y - 0.5, y, 0.04, 5, { r1: 0.06 });
      flame(mb, p.x, y - 0.02, p.z, 0.3, 0.4, 230);
      ctx.light({ x: p.x, y: y + 0.2, z: p.z, r: 1, g: 0.6, b: 0.28, range: 8 });
      return;
    }
  }
}

/**
 * Farm field behind a farmhouse (worldgen: crops prop, scale = width m,
 * depth 9 m): tilled soil rows draped on the ground and low crop ridges.
 */
export function drawField(mb: MeshBuilder, p: TownProp, ctx: PropCtx): void {
  const f = frameOf(p.x, p.z, p.yaw);
  const hw = Math.max(4, p.scale) * 0.5;
  const hd = 4.5;
  const gold = p.variant === 2 || p.variant === 4 ? 0 : 1; // style -> crop look
  const col: V3 = gold ? [0.55, 0.8, 0.35] : [0.95, 0.8, 0.42];
  const step = 1;
  const nu = Math.max(2, Math.ceil((hw * 2) / step));
  const nv = Math.max(2, Math.ceil((hd * 2) / step));
  const H = (u: number, v: number) => {
    const q = at(f, u, 0, v);
    return ctx.heightAt(q[0], q[2]) + 0.06;
  };
  P(mb, 'soil');
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      const u0 = -hw + (i * 2 * hw) / nu;
      const u1 = -hw + ((i + 1) * 2 * hw) / nu;
      const v0 = -hd + (j * 2 * hd) / nv;
      const v1 = -hd + ((j + 1) * 2 * hd) / nv;
      mb.quad(at(f, u0, H(u0, v0), v0), at(f, u1, H(u1, v0), v0), at(f, u1, H(u1, v1), v1), at(f, u0, H(u0, v1), v1), [0, 1, 0]);
    }
  // Crop ridges every 0.9 m along u, in 1 m pieces following the ground.
  P(mb, 'crops', col);
  for (let v = -hd + 0.45; v < hd; v += 0.9) {
    for (let i = 0; i < nu; i++) {
      const u0 = -hw + (i * 2 * hw) / nu + 0.05;
      const u1 = -hw + ((i + 1) * 2 * hw) / nu - 0.05;
      const y0 = H(u0, v);
      const y1 = H(u1, v);
      const h = 0.45;
      const a = at(f, u0, y0 - 0.02, v - 0.22);
      const b = at(f, u1, y1 - 0.02, v - 0.22);
      const c = at(f, u1, y1 + h, v);
      const d = at(f, u0, y0 + h, v);
      const e = at(f, u1, y1 - 0.02, v + 0.22);
      const g = at(f, u0, y0 - 0.02, v + 0.22);
      mb.quad(a, b, c, d, [f.s, 0.5, -f.c]);
      mb.quad(g, e, c, d, [-f.s, 0.5, f.c]);
    }
  }
}
