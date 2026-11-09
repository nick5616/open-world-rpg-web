// Structure meshes (WP20, spec 5 "structures ... assembled jigsaw-style"):
// one structure's pieces and props merged into one mesh in the buildings
// worker, on the same texture array as the towns (one material, one draw).
//
// Like buildings, the collision boxes are drawn where they are: each box of
// the structure is matched to the piece whose cell holds it (worldgen
// jigsaw.rs emits a piece's boxes inside its 6 m cell; ramps poke out, so
// sloped boxes are ramps whatever the cell) and drawn in that piece's
// style: a tent box becomes an A-frame tent, pillar boxes columns, lair
// boxes obsidian spikes, the meteorite a jagged rock, palisades a row of
// sharpened logs, everything else a stone/wood block. Paving is drawn on
// the terrain by the decal layer (roads.ts), not here.

import { TOWN_STRUCTURE_KINDS, type Towns, type TownPiece } from '@lodestone/worldgen';
import { MeshBuilder, at, dirOf, local, type Frame, type MeshData, type V3 } from './meshBuilder';
import { boxAt, boxFrame, type Box } from './kit';
import { drawProp, P, type Emitter, type PropCtx } from './props';
import { TEX, type TexName } from './textures';

export const PIECE = {
  pave: 0, wall: 1, corner: 2, room: 3, tower: 4, ramp: 5, pillars: 6, tent: 7, palisade: 8, campfire: 9, shaft: 10, altar: 11, crater: 12, lair: 13, rubble: 14,
  // genVersion 2 landmarks (one piece holding all the landmark's boxes).
  stones: 15, tree: 16, arch: 17, monolith: 18, bones: 19, crystals: 20, statue: 21, spring: 22,
} as const;
export const SK = Object.fromEntries(TOWN_STRUCTURE_KINDS.map((k, i) => [k, i])) as Record<(typeof TOWN_STRUCTURE_KINDS)[number], number>;

const CELL = 6;

export interface StructureMesh {
  shell: MeshData;
  lights: Float32Array;
  bounds: [number, number, number, number];
}

/** Masonry per structure kind (STRUCTURE_KINDS order). */
const MASONRY: { tex: TexName; tint: V3 }[] = [
  { tex: 'mossStone', tint: [0.95, 0.95, 0.9] }, // ruin
  { tex: 'planks', tint: [0.85, 0.75, 0.6] }, // watchtower
  { tex: 'planks', tint: [0.75, 0.65, 0.52] }, // mineshaft
  { tex: 'stone', tint: [1.08, 1.06, 1.02] }, // shrine
  { tex: 'logs', tint: [0.85, 0.8, 0.7] }, // bandit camp
  { tex: 'stone', tint: [0.86, 0.9, 1.02] }, // wizard tower
  { tex: 'rock', tint: [0.6, 0.55, 0.5] }, // meteor crater
  { tex: 'mossStone', tint: [0.85, 0.95, 0.88] }, // sunken temple
  { tex: 'rock', tint: [0.42, 0.3, 0.32] }, // demon lair
  { tex: 'stone', tint: [0.86, 0.84, 0.8] }, // landmark (genVersion 2)
  { tex: 'logs', tint: [0.7, 0.62, 0.52] }, // enemy camp (genVersion 2)
];

const pieceFrame = (p: TownPiece): Frame => ({ cx: p.x, cz: p.z, c: p.c, s: p.s });

/** The piece whose cell holds (x, z) (nearest centre when none does). */
export function pieceFor(pieces: TownPiece[], x: number, z: number): TownPiece | null {
  let best: TownPiece | null = null;
  let bd = Infinity;
  for (const p of pieces) {
    const [u, v] = local(pieceFrame(p), x, z);
    const inside = Math.abs(u) <= CELL * 0.5 + 0.05 && Math.abs(v) <= CELL * 0.5 + 0.05;
    const d = Math.hypot(u, v) - (inside ? 1000 : 0);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

export function buildStructureMesh(t: Towns, si: number, heightAt: (x: number, z: number) => number): StructureMesh {
  const st = t.structures[si];
  const mb = new MeshBuilder(1 << 12);
  const lights: number[] = [];
  const light = (e: Emitter) => lights.push(e.x, e.y, e.z, e.r, e.g, e.b, e.range);
  const pieces = t.pieces.slice(st.pieceFirst, st.pieceFirst + st.pieceCount);
  const mas = MASONRY[st.kind] ?? MASONRY[0];
  let maxY = st.y;
  for (let i = st.boxFirst; i < st.boxFirst + st.boxCount; i++) {
    const b = boxAt(t, i);
    maxY = Math.max(maxY, b.y1, b.y2);
    const p = pieceFor(pieces, b.cx, b.cz);
    drawPieceBox(mb, b, p, st.kind, mas, heightAt);
  }
  for (const p of pieces) {
    maxY = Math.max(maxY, p.y + p.sy);
    drawPieceDecor(mb, p, st.kind, mas, t, si);
  }
  const ctx: PropCtx = { wt: 0.6, openFront: false, heightAt, light };
  for (let i = st.propFirst; i < st.propFirst + st.propCount; i++) {
    const p = t.props[i];
    drawProp(mb, p, { hu: 0.5, hv: 0.5, h: 1 }, ctx);
  }
  return { shell: mb.data(), lights: new Float32Array(lights), bounds: [st.x, (st.y + maxY) / 2, st.z, Math.hypot(st.radius + 6, (maxY - st.y) / 2 + 6)] };
}

function drawPieceBox(mb: MeshBuilder, b: Box, p: TownPiece | null, kind: number, mas: { tex: TexName; tint: V3 }, heightAt: (x: number, z: number) => number): void {
  const f = boxFrame(b);
  const top = Math.max(b.y1, b.y2);
  mb.originY = 0;
  if (b.y1 !== b.y2) {
    // Ramps (room steps, the watchtower ramp): planks on a timber frame.
    P(mb, 'planks', [0.85, 0.75, 0.6]);
    mb.slopedBox(f, -b.hx, b.hx, -b.hz, b.hz, b.y0, b.y1, b.y2, { topPaint: { ...mb.save(), layer: TEX.floor, tile: 2 } });
    return;
  }
  const pk = p?.kind ?? PIECE.wall;
  if (pk >= PIECE.stones) {
    drawLandmarkBox(mb, f, b, pk, top, heightAt);
    return;
  }
  switch (pk) {
    case PIECE.tent: {
      // A-frame tent over the box: ridge along u, canvas to the ground at +-v.
      const g = p ? heightAt(b.cx, b.cz) - 0.05 : b.y0;
      const tints: V3[] = [
        [0.85, 0.8, 0.68],
        [0.62, 0.5, 0.4],
        [0.55, 0.6, 0.45],
        [0.7, 0.42, 0.36],
      ];
      P(mb, 'cloth', tints[(p?.variant ?? 0) & 3]);
      const ridge = (u: number) => at(f, u, top, 0);
      for (const sv of [-1, 1]) mb.quad(at(f, -b.hx, g, sv * b.hz), at(f, b.hx, g, sv * b.hz), ridge(b.hx), ridge(-b.hx), [0, 0.6, 0].map((x, k) => x + dirOf(f, 0, 0, sv)[k]) as V3);
      for (const su of [-1, 1]) {
        mb.poly([at(f, su * b.hx, g, -b.hz), at(f, su * b.hx, g, b.hz), ridge(su * b.hx)], dirOf(f, su, 0, 0));
        // Entrance flap shadow on the -u end.
        if (su < 0) {
          P(mb, 'plain', [0.12, 0.1, 0.08]);
          mb.poly([at(f, -b.hx - 0.01, g, -b.hz * 0.4), at(f, -b.hx - 0.01, g, b.hz * 0.4), at(f, -b.hx - 0.01, g + (top - g) * 0.6, 0)], dirOf(f, -1, 0, 0));
          P(mb, 'cloth', tints[(p?.variant ?? 0) & 3]);
        }
      }
      P(mb, 'wood', [0.5, 0.4, 0.3]);
      mb.hcyl(f, -b.hx - 0.15, b.hx + 0.15, top + 0.02, 0, 0.05, 5);
      return;
    }
    case PIECE.pillars: {
      // A column inscribed in the pillar box, with base and capital.
      const r = Math.min(b.hx, b.hz);
      P(mb, mas.tex === 'logs' || mas.tex === 'planks' ? 'stone' : mas.tex, mas.tint);
      mb.box(f, -r, r, b.y0, b.y0 + (heightAt(b.cx, b.cz) - b.y0) + 0.35, -r, r);
      mb.cyl(f, 0, 0, heightAt(b.cx, b.cz) + 0.35, top - 0.3, r * 0.8, 8);
      mb.box(f, -r, r, top - 0.3, top, -r, r);
      return;
    }
    case PIECE.lair: {
      P(mb, 'rock', [0.32, 0.22, 0.28]);
      mb.cyl(f, 0, 0, b.y0, top, Math.min(b.hx, b.hz) * 1.25, 5, { r1: 0.04 });
      return;
    }
    case PIECE.crater: {
      // The meteorite: a lumpy dark rock filling the box, with glowing seams.
      P(mb, 'rock', [0.42, 0.38, 0.4]);
      mb.cyl(f, 0, 0, b.y0, top - 0.9, Math.max(b.hx, b.hz) * 1.05, 7, { r1: Math.max(b.hx, b.hz) * 0.95, top: false });
      mb.cyl(f, 0, 0, top - 0.9, top, Math.max(b.hx, b.hz) * 0.95, 7, { r1: 0.35 });
      P(mb, 'glow', [0.4, 0.65, 1.1], 128 + 50);
      for (let k = 0; k < 3; k++) {
        const a = k * 2.1;
        const u = Math.cos(a) * b.hx * 1.0;
        const v = Math.sin(a) * b.hz * 1.0;
        mb.box(f, u - 0.06, u + 0.06, top - 1.6, top - 0.6, v - 0.06, v + 0.06);
      }
      return;
    }
    case PIECE.palisade: {
      // Sharpened logs side by side along the box's long axis.
      const long = b.hx >= b.hz;
      const L = long ? b.hx : b.hz;
      const n = Math.max(2, Math.round((2 * L) / 0.42));
      P(mb, 'logs', [0.82, 0.72, 0.6]);
      for (let k = 0; k < n; k++) {
        const a = -L + ((k + 0.5) * 2 * L) / n;
        const u = long ? a : 0;
        const v = long ? 0 : a;
        const h = top + ((k * 7) % 3) * 0.12;
        mb.cyl(f, u, v, b.y0, h, 0.21, 6, { top: false });
        mb.cyl(f, u, v, h, h + 0.4, 0.21, 6, { r1: 0.02 });
      }
      return;
    }
    case PIECE.shaft: {
      P(mb, 'wood', [0.6, 0.5, 0.4]);
      mb.slopedBox(f, -b.hx, b.hx, -b.hz, b.hz, b.y0, b.y1, b.y2, {});
      return;
    }
    case PIECE.tower: {
      const wood = kind === SK.watchtower;
      P(mb, wood ? 'planks' : mas.tex, wood ? [0.8, 0.7, 0.56] : mas.tint);
      mb.slopedBox(f, -b.hx, b.hx, -b.hz, b.hz, b.y0, b.y1, b.y2, { topPaint: { ...mb.save(), layer: wood ? TEX.floor : TEX.flagstone, tile: wood ? 2 : 3 } });
      drawTowerTrim(mb, f, b, top, wood);
      return;
    }
    default: {
      P(mb, kind === SK.mineshaft && pk === PIECE.room ? 'planks' : mas.tex, mas.tint);
      mb.slopedBox(f, -b.hx, b.hx, -b.hz, b.hz, b.y0, b.y1, b.y2, {});
    }
  }
}

/** Tower trim: corner posts and a railing (wood) or merlons and lit slit windows (stone). */
function drawTowerTrim(mb: MeshBuilder, f: Frame, b: Box, top: number, wood: boolean): void {
  if (wood) {
    P(mb, 'wood', [0.5, 0.4, 0.3]);
    for (const su of [-1, 1]) for (const sv of [-1, 1]) mb.box(f, su * b.hx - 0.12, su * b.hx + 0.12, b.y0, top + 1.1, sv * b.hz - 0.12, sv * b.hz + 0.12);
    for (const [u0, u1, v0, v1] of [
      [-b.hx, b.hx, -b.hz, -b.hz + 0.08],
      [-b.hx, b.hx, b.hz - 0.08, b.hz],
      [-b.hx, -b.hx + 0.08, -b.hz, b.hz],
      [b.hx - 0.08, b.hx, -b.hz, b.hz],
    ])
      mb.box(f, u0, u1, top + 0.9, top + 1.05, v0, v1, { bottom: true });
    return;
  }
  P(mb, 'stone', [0.86, 0.9, 1.02]);
  for (let side = 0; side < 4; side++) {
    for (let k = 0; k < 3; k++) {
      const a = -1.5 + k * 1.5;
      const [u0, u1, v0, v1] = side === 0 ? [a - 0.35, a + 0.35, b.hz - 0.4, b.hz] : side === 1 ? [a - 0.35, a + 0.35, -b.hz, -b.hz + 0.4] : side === 2 ? [b.hx - 0.4, b.hx, a - 0.35, a + 0.35] : [-b.hx, -b.hx + 0.4, a - 0.35, a + 0.35];
      mb.box(f, u0, u1, top, top + 0.8, v0, v1);
    }
  }
  // Lit slit windows up the shaft (always on: the wizard is home).
  const H = top - b.y0;
  for (let y = top - 3; y > top - H + 4; y -= 3.2) {
    for (const sv of [-1, 1]) {
      mb.paint(TEX.window, 0, [1, 1, 1], 128 + 24);
      mb.quad(at(f, -0.25, y, sv * (b.hz + 0.02)), at(f, 0.25, y, sv * (b.hz + 0.02)), at(f, 0.25, y + 1.0, sv * (b.hz + 0.02)), at(f, -0.25, y + 1.0, sv * (b.hz + 0.02)), dirOf(f, 0, 0, sv), [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]);
    }
  }
}

/**
 * Landmark boxes (genVersion 2): standing stones, an elder tree's trunk and
 * roots, arch piers and lintel, a monolith, giant ribs and skull, crystal
 * spires, a colossus and its plinth, hot-spring rocks. Each is drawn inside
 * its collision box (decoration above or around it comes from the piece).
 */
function drawLandmarkBox(mb: MeshBuilder, f: Frame, b: Box, pk: number, top: number, heightAt: (x: number, z: number) => number): void {
  const r = Math.min(b.hx, b.hz);
  const R = Math.max(b.hx, b.hz);
  const g = heightAt(b.cx, b.cz);
  switch (pk) {
    case PIECE.stones:
      P(mb, 'rock', [0.78, 0.78, 0.74]);
      if (top - g < 0.8) mb.box(f, -b.hx, b.hx, b.y0, top, -b.hz, b.hz);
      else mb.cyl(f, 0, 0, b.y0, top, R * 0.95, 5, { r1: R * 0.6 });
      return;
    case PIECE.tree:
      P(mb, 'wood', [0.55, 0.45, 0.36]);
      if (top - g < 0.8) mb.cyl(f, 0, 0, b.y0, top, r, 6, { r1: r * 0.5 });
      else mb.cyl(f, 0, 0, b.y0, top, R * 1.05, 8, { r1: R * 0.8 });
      return;
    case PIECE.bones:
      P(mb, 'plain', [0.88, 0.84, 0.72]);
      if (top - g < 0.8) mb.cyl(f, 0, 0, b.y0, top, R, 7, { r1: R * 0.8 });
      else mb.cyl(f, 0, 0, b.y0, top, R * 1.1, 6, { r1: 0.05 });
      return;
    case PIECE.crystals:
      P(mb, 'glow', [0.5, 0.8, 1.1], 128 + 70);
      mb.cyl(f, 0, 0, b.y0, top - R * 0.8, R * 1.05, 6);
      mb.cyl(f, 0, 0, top - R * 0.8, top, R * 1.05, 6, { r1: 0.02 });
      return;
    case PIECE.spring:
      P(mb, 'rock', [0.62, 0.6, 0.58]);
      mb.box(f, -b.hx, b.hx, b.y0, top, -b.hz, b.hz);
      return;
    case PIECE.monolith:
      P(mb, 'rock', [0.35, 0.34, 0.38]);
      mb.box(f, -b.hx, b.hx, b.y0, top, -b.hz, b.hz);
      P(mb, 'glow', [0.55, 0.85, 1.0], 128 + 40);
      for (let y = g + 1.2; y < top - 0.6; y += 1.1) mb.box(f, -0.18, 0.18, y, y + 0.5, -b.hz - 0.01, -b.hz + 0.02, { bottom: true });
      return;
    default:
      // Arch piers and lintel, the colossus and its plinth: dressed stone.
      P(mb, 'stone', [0.92, 0.9, 0.86]);
      mb.box(f, -b.hx, b.hx, b.y0, top, -b.hz, b.hz, { bottom: true });
  }
}

/** Per-piece decoration that has no box: the shaft's head frame and pit; landmark canopies, statues and pools. */
function drawPieceDecor(mb: MeshBuilder, p: TownPiece, kind: number, mas: { tex: TexName; tint: V3 }, t: Towns, si: number): void {
  const f = pieceFrame(p);
  void mas;
  void t;
  void si;
  void kind;
  if (p.kind === PIECE.tree) {
    // The elder tree's canopy: stacked broad crowns on a tall trunk.
    const y = p.y + 6.5;
    P(mb, 'wood', [0.55, 0.45, 0.36]);
    mb.cyl(f, 0, 0, y - 0.5, y + 4, 0.75, 7, { r1: 0.45 });
    P(mb, 'plain', [0.32, 0.5, 0.24]);
    mb.cyl(f, 0, 0, y, y + 3.5, 7.5, 9, { r1: 5.5 });
    mb.cyl(f, 0, 0, y + 3.5, y + 7, 5.5, 9, { r1: 3.2 });
    mb.cyl(f, 0, 0, y + 7, y + 10.5, 3.2, 8, { r1: 0.3 });
  } else if (p.kind === PIECE.statue) {
    // A robed colossus on the figure box: body, shoulders, head, a raised arm.
    const y = p.y + 1.3;
    P(mb, 'stone', [0.9, 0.88, 0.84]);
    mb.cyl(f, 0, 0, y + 5.5, y + 6.5, 0.45, 8, { r1: 0.38 });
    mb.box(f, -1.0, 1.0, y + 4.6, y + 5.5, -0.5, 0.5, { bottom: true });
    mb.box(f, 0.75, 1.05, y + 5.0, y + 7.8, -0.15, 0.15, { bottom: true });
  } else if (p.kind === PIECE.spring) {
    // The pool: a still, glinting disc inside the rocks, and a wisp of steam.
    P(mb, 'water', [0.75, 0.95, 1.0]);
    const y = p.y + 0.12;
    const pts: V3[] = [];
    for (let k = 0; k < 12; k++) pts.push(at(f, Math.cos((k / 12) * Math.PI * 2) * 2.8, y, Math.sin((k / 12) * Math.PI * 2) * 2.8));
    mb.poly(pts.reverse(), [0, 1, 0]);
  } else if (p.kind === PIECE.arch) {
    P(mb, 'stone', [0.85, 0.83, 0.8]);
    mb.box(f, -2.3, 2.3, p.y + p.sy, p.y + p.sy + 0.35, -0.45, 0.45, { bottom: true });
  }
  if (p.kind === PIECE.shaft) {
    const y = p.y;
    P(mb, 'plain', [0.03, 0.03, 0.03]);
    mb.quad(at(f, -1.3, y + 0.04, -1.3), at(f, 1.3, y + 0.04, -1.3), at(f, 1.3, y + 0.04, 1.3), at(f, -1.3, y + 0.04, 1.3), [0, 1, 0]);
    P(mb, 'wood', [0.55, 0.45, 0.35]);
    mb.box(f, -1.6, 1.6, y + 3.8, y + 4.1, -1.45, -1.25, { bottom: true });
    mb.box(f, -1.6, 1.6, y + 3.8, y + 4.1, 1.25, 1.45, { bottom: true });
    mb.box(f, -0.12, 0.12, y + 4.1, y + 4.35, -1.45, 1.45, { bottom: true });
    P(mb, 'metal', [0.7, 0.68, 0.66]);
    mb.hcyl({ ...f, c: -f.s, s: f.c }, -0.12, 0.12, y + 4.7, 0, 0.55, 10);
    P(mb, 'plain', [0.65, 0.58, 0.42]);
    mb.box(f, -0.02, 0.02, y + 0.5, y + 4.6, -0.55, -0.51);
  }
}
