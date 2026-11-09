// Roads, streets, plazas, bridges and signposts (WP20, spec 5 "roads ...
// with generated bridges at river crossings and signposts at forks").
//
// Roads are drawn ON the terrain, not cut into it (worldgen README: cutting
// would change chunks, a genVersion bump): ribbons whose vertices sit on the
// exact collision surface (the wasm collision_height, which IS the lod-0
// terrain mesh) plus a small lift, rendered with polygon offset. The stretch
// under a bridge is skipped. Everything is batched per 1 km cell into two
// meshes: ground decals (roads, streets, plazas, structure paving, scorch
// marks; no shadows) and road furniture (bridges, signposts, road lanterns;
// casts shadows), so the whole road network costs a few draw calls.

import { type TownBridge, type TownRoad, type Towns } from '@lodestone/worldgen';
import { MeshBuilder, at, dirOf, frameOf, type Frame, type MeshData, type V3 } from './meshBuilder';
import { boxAt, boxFrame, BK, type Box } from './kit';
import { drawProp, P, type Emitter, type PropCtx } from './props';
import { PIECE, SK } from './structures';
import { TEX } from './textures';

export const CELL_M = 1024;
/** Ribbon lift above the terrain (m): ring streets over radial streets over footpaths over roads, plazas on top. */
export const LIFT = { road: 0.07, path: 0.08, street: 0.09, ring: 0.11, plaza: 0.13, pave: 0.08, scorch: 0.05 } as const;
/** Resample spacing along a road (m) and across it (m). */
const ALONG = 2;
const ACROSS = 1;

export interface CellMesh {
  key: string;
  cx: number;
  cz: number;
  decal: MeshData;
  furniture: MeshData;
  lights: Float32Array;
}

type HeightAt = (x: number, z: number) => number;

class Cells {
  readonly cells = new Map<string, { cx: number; cz: number; decal: MeshBuilder; furn: MeshBuilder; lights: number[] }>();
  get(x: number, z: number) {
    const cx = Math.floor(x / CELL_M);
    const cz = Math.floor(z / CELL_M);
    const key = `${cx},${cz}`;
    let c = this.cells.get(key);
    if (!c) {
      c = { cx, cz, decal: new MeshBuilder(4096), furn: new MeshBuilder(1024), lights: [] };
      this.cells.set(key, c);
    }
    return c;
  }
}

const inBox = (b: Box, x: number, z: number, pad: number) => {
  const dx = x - b.cx;
  const dz = z - b.cz;
  const u = dx * b.c + dz * b.s;
  const v = dz * b.c - dx * b.s;
  return Math.abs(u) <= b.hx + pad && Math.abs(v) <= b.hz + pad;
};

/** Resampled centreline of a road: points every ~ALONG m with cumulative distance. */
export function resample(road: TownRoad): { x: number; z: number; d: number }[] {
  const p = road.points;
  const n = p.length / 3;
  const out: { x: number; z: number; d: number }[] = [];
  if (n < 2) return out;
  let d = 0;
  out.push({ x: p[0], z: p[2], d: 0 });
  for (let i = 1; i < n; i++) {
    const ax = p[(i - 1) * 3];
    const az = p[(i - 1) * 3 + 2];
    const bx = p[i * 3];
    const bz = p[i * 3 + 2];
    const L = Math.hypot(bx - ax, bz - az);
    const k = Math.max(1, Math.round(L / ALONG));
    for (let j = 1; j <= k; j++) {
      const f = j / k;
      out.push({ x: ax + (bx - ax) * f, z: az + (bz - az) * f, d: d + L * f });
    }
    d += L;
  }
  return out;
}

/**
 * One road ribbon: rows across the road at every resampled point, each
 * vertex on the terrain + lift. Returns the quads it emitted (tests).
 */
export function drawRoad(mb: MeshBuilder, road: TownRoad, heightAt: HeightAt, skip: (x: number, z: number) => boolean, lift: number): number {
  const pts = resample(road);
  if (pts.length < 2) return 0;
  const w = road.width;
  const k = Math.max(2, Math.ceil(w / ACROSS));
  const cobble = road.surface === 1;
  if (cobble) P(mb, 'cobble', road.cls === 1 ? [0.95, 0.93, 0.9] : [0.9, 0.88, 0.85]);
  // Footpaths (genVersion 2, class 2): lighter, trodden earth.
  else mb.paint(TEX.dirt, 0, road.cls === 2 ? [1.08, 1.02, 0.9] : [1, 1, 1]);
  const rows: { p: V3[]; d: number; skip: boolean }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let tx = b.x - a.x;
    let tz = b.z - a.z;
    const L = Math.hypot(tx, tz) || 1;
    tx /= L;
    tz /= L;
    const nx = -tz;
    const nz = tx;
    const row: V3[] = [];
    for (let j = 0; j <= k; j++) {
      const o = -w / 2 + (j * w) / k;
      const x = pts[i].x + nx * o;
      const z = pts[i].z + nz * o;
      row.push([x, heightAt(x, z) + lift, z]);
    }
    rows.push({ p: row, d: pts[i].d, skip: skip(pts[i].x, pts[i].z) });
  }
  let quads = 0;
  for (let i = 0; i + 1 < rows.length; i++) {
    if (rows[i].skip && rows[i + 1].skip) continue;
    for (let j = 0; j < k; j++) {
      const uv: [number, number][] = cobble
        ? [
            [rows[i].d / 2, (j * w) / k / 2],
            [rows[i + 1].d / 2, (j * w) / k / 2],
            [rows[i + 1].d / 2, ((j + 1) * w) / k / 2],
            [rows[i].d / 2, ((j + 1) * w) / k / 2],
          ]
        : [
            [rows[i].d / 4, j / k],
            [rows[i + 1].d / 4, j / k],
            [rows[i + 1].d / 4, (j + 1) / k],
            [rows[i].d / 4, (j + 1) / k],
          ];
      mb.quad(rows[i].p[j], rows[i + 1].p[j], rows[i + 1].p[j + 1], rows[i].p[j + 1], [0, 1, 0], uv);
      quads++;
    }
  }
  return quads;
}

/** A draped disc (plazas, scorch marks): rings every ~1.5 m, planar uvs. */
export function drawDisc(mb: MeshBuilder, x: number, z: number, r: number, heightAt: HeightAt, lift: number, tile: number): void {
  const rings = Math.max(2, Math.ceil(r / 1.5));
  const segs = Math.max(16, Math.ceil((2 * Math.PI * r) / 2));
  const pt = (ri: number, si: number): V3 => {
    const rr = (ri / rings) * r;
    const a = (si / segs) * Math.PI * 2;
    const px = x + Math.cos(a) * rr;
    const pz = z + Math.sin(a) * rr;
    return [px, heightAt(px, pz) + lift, pz];
  };
  const uv = (p: V3): [number, number] => [p[0] / tile, p[2] / tile];
  for (let ri = 0; ri < rings; ri++)
    for (let si = 0; si < segs; si++) {
      const a = pt(ri, si);
      const b = pt(ri, si + 1);
      const c = pt(ri + 1, si + 1);
      const d = pt(ri + 1, si);
      if (ri === 0) mb.poly([a, c, d], [0, 1, 0], [uv(a), uv(c), uv(d)]);
      else mb.quad(a, b, c, d, [0, 1, 0], [uv(a), uv(b), uv(c), uv(d)]);
    }
}

/** A draped square in frame f (structure paving). */
function drawPatch(mb: MeshBuilder, f: Frame, h: number, heightAt: HeightAt, lift: number, tile: number): void {
  const n = Math.ceil((2 * h) / 1);
  const pt = (i: number, j: number): V3 => {
    const p = at(f, -h + (i * 2 * h) / n, 0, -h + (j * 2 * h) / n);
    return [p[0], heightAt(p[0], p[2]) + lift, p[2]];
  };
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = pt(i, j);
      const b = pt(i + 1, j);
      const c = pt(i + 1, j + 1);
      const d = pt(i, j + 1);
      mb.quad(a, b, c, d, [0, 1, 0], [a, b, c, d].map((p) => [p[0] / tile, p[2] / tile]) as [number, number][]);
    }
}

/** A bridge from its boxes: deck, railings, ramps; wooden piles or stone piers down into the water. */
export function drawBridge(mb: MeshBuilder, t: Towns, br: TownBridge): void {
  const stone = br.style === 1;
  for (let i = br.boxFirst; i < br.boxFirst + br.boxCount; i++) {
    const b = boxAt(t, i);
    const f = boxFrame(b);
    mb.originY = 0;
    if (b.kind === BK.deck || b.kind === BK.bridgeRamp) {
      P(mb, stone ? 'stone' : 'wood', stone ? [0.95, 0.92, 0.88] : [0.6, 0.48, 0.36]);
      mb.slopedBox(f, -b.hx, b.hx, -b.hz, b.hz, b.kind === BK.deck ? b.y0 : Math.min(b.y1, b.y2) - 0.6, b.y1, b.y2, { bottom: true, topPaint: { ...mb.save(), layer: stone ? TEX.flagstone : TEX.floor, tile: stone ? 3 : 2 } });
      if (b.kind === BK.deck) {
        // Supports from under the deck to below the water line.
        const bottom = br.waterY - 2;
        if (stone) {
          P(mb, 'stone', [0.85, 0.82, 0.78]);
          for (const k of [-1 / 3, 1 / 3]) mb.box(f, k * b.hx * 2 - 0.7, k * b.hx * 2 + 0.7, bottom, b.y0, -b.hz - 0.2, b.hz + 0.2, { top: false });
        } else {
          P(mb, 'wood', [0.45, 0.36, 0.28]);
          const n = Math.max(1, Math.round((2 * b.hx) / 3));
          for (let k = 0; k <= n; k++) {
            const u = -b.hx + 0.3 + (k * (2 * b.hx - 0.6)) / n;
            for (const sv of [-1, 1]) mb.cyl(f, u, sv * (b.hz - 0.25), bottom, b.y0, 0.16, 6, { top: false });
            mb.box(f, u - 0.12, u + 0.12, b.y0 - 0.25, b.y0, -b.hz, b.hz, { top: false, bottom: true });
          }
        }
      }
    } else if (b.kind === BK.railing) {
      const top = Math.max(b.y1, b.y2);
      const deckY = top - 1.0;
      if (stone) {
        P(mb, 'stone', [0.92, 0.9, 0.86]);
        mb.slopedBox(f, -b.hx, b.hx, -b.hz - 0.05, b.hz + 0.05, deckY - 0.01, top, top, {});
      } else {
        P(mb, 'wood', [0.55, 0.44, 0.34]);
        const n = Math.max(1, Math.round((2 * b.hx) / 1.5));
        for (let k = 0; k <= n; k++) {
          const u = -b.hx + (k * 2 * b.hx) / n;
          mb.box(f, u - 0.06, u + 0.06, deckY, top, -0.06, 0.06, { top: true });
        }
        mb.box(f, -b.hx, b.hx, top - 0.1, top, -0.05, 0.05, { bottom: true });
        mb.box(f, -b.hx, b.hx, deckY + 0.45, deckY + 0.53, -0.04, 0.04, { bottom: true });
      }
    }
  }
}

/** Signpost at a fork: a post and up to three arms pointing along the roads (yaw = arm direction). */
export function drawSign(mb: MeshBuilder, sg: { x: number; y: number; z: number; arms: { yaw: number; settlement: number }[] }): void {
  const f = frameOf(sg.x, sg.z, 0);
  P(mb, 'wood', [0.5, 0.4, 0.3]);
  mb.box(f, -0.08, 0.08, sg.y - 0.4, sg.y + 2.75, -0.08, 0.08);
  mb.cyl(f, 0, 0, sg.y + 2.75, sg.y + 2.95, 0.12, 4, { r1: 0, a0: Math.PI / 4 });
  sg.arms.forEach((a, k) => {
    if (a.settlement < 0) return;
    const g = frameOf(sg.x, sg.z, a.yaw);
    const y = sg.y + 2.35 - k * 0.34;
    P(mb, 'planks', [0.9, 0.82, 0.68]);
    mb.box(g, 0.08, 0.95, y, y + 0.24, -0.03, 0.03, { bottom: true });
    // Pointed tip.
    mb.poly([at(g, 0.95, y, -0.03), at(g, 1.15, y + 0.12, -0.03), at(g, 0.95, y + 0.24, -0.03)], dirOf(g, 0, 0, -1));
    mb.poly([at(g, 0.95, y, 0.03), at(g, 1.15, y + 0.12, 0.03), at(g, 0.95, y + 0.24, 0.03)], dirOf(g, 0, 0, 1));
    mb.quad(at(g, 0.95, y + 0.24, -0.03), at(g, 1.15, y + 0.12, -0.03), at(g, 1.15, y + 0.12, 0.03), at(g, 0.95, y + 0.24, 0.03), [0, 1, 0]);
    // Painted lettering band.
    P(mb, 'plain', [0.2, 0.16, 0.12]);
    for (const sv of [-1, 1]) mb.quad(at(g, 0.25, y + 0.09, sv * 0.035), at(g, 0.8, y + 0.09, sv * 0.035), at(g, 0.8, y + 0.15, sv * 0.035), at(g, 0.25, y + 0.15, sv * 0.035), dirOf(g, 0, 0, sv));
  });
}

/**
 * Every road, street, plaza, paving patch, bridge, signpost and road lantern
 * of the world, batched per CELL_M cell.
 */
export function buildRoadCells(t: Towns, heightAt: HeightAt): CellMesh[] {
  const cells = new Cells();
  // Roads and streets (minus what's under a bridge).
  const bridgeBoxes = new Map<number, Box[]>();
  for (const br of t.bridges) {
    const l = bridgeBoxes.get(br.road) ?? [];
    for (let i = br.boxFirst; i < br.boxFirst + br.boxCount; i++) {
      const b = boxAt(t, i);
      if (b.kind === BK.deck || b.kind === BK.bridgeRamp) l.push(b);
    }
    bridgeBoxes.set(br.road, l);
  }
  for (const r of t.roads) {
    const bb = bridgeBoxes.get(r.index) ?? [];
    const skip = (x: number, z: number) => bb.some((b) => inBox(b, x, z, 0.3));
    const ring = r.cls === 1 && r.from === r.to && r.from >= 0 && r.points.length >= 9 && Math.hypot(r.points[0] - r.points[r.points.length - 3], r.points[2] - r.points[r.points.length - 1]) < 1;
    const lift = r.cls === 0 ? LIFT.road : r.cls === 2 ? LIFT.path : ring ? LIFT.ring : LIFT.street;
    // Split long roads by cell so each cell's mesh stays local (culling).
    const p = r.points;
    const n = p.length / 3;
    const keyOf = (j: number) => `${Math.floor(p[j * 3] / CELL_M)},${Math.floor(p[j * 3 + 2] / CELL_M)}`;
    let start = 0;
    for (let i = 1; i < n; i++) {
      if (keyOf(i) !== keyOf(start) || i === n - 1) {
        const mid = (start + i) >> 1;
        const sub: TownRoad = { ...r, points: p.subarray(start * 3, (i + 1) * 3) };
        drawRoad(cells.get(p[mid * 3], p[mid * 3 + 2]).decal, sub, heightAt, skip, lift);
        start = i;
      }
    }
  }
  // Plazas (the square around the waypoint stone).
  for (const s of t.settlements) {
    const c = cells.get(s.x, s.z).decal;
    if (s.size >= 2) P(c, 'flagstone');
    else P(c, 'cobble', [0.95, 0.93, 0.9]);
    drawDisc(c, s.x, s.z, s.square + 0.5, heightAt, LIFT.plaza, s.size >= 2 ? 3 : 2);
  }
  // Structure paving and ground marks.
  for (const st of t.structures) {
    for (let i = st.pieceFirst; i < st.pieceFirst + st.pieceCount; i++) {
      const pc = t.pieces[i];
      const c = cells.get(pc.x, pc.z).decal;
      const f: Frame = { cx: pc.x, cz: pc.z, c: pc.c, s: pc.s };
      if (pc.kind === PIECE.pave || pc.kind === PIECE.altar || pc.kind === PIECE.pillars) {
        P(c, 'flagstone', st.kind === SK.ruin || st.kind === SK.sunken_temple ? [0.85, 0.9, 0.8] : [1, 1, 1]);
        drawPatch(c, f, 2.9, heightAt, LIFT.pave, 3);
      } else if (pc.kind === PIECE.crater) {
        P(c, 'soil', [0.35, 0.3, 0.28]);
        drawDisc(c, pc.x, pc.z, 7, heightAt, LIFT.scorch, 2);
      } else if (pc.kind === PIECE.lair) {
        P(c, 'rock', [0.3, 0.2, 0.22]);
        drawDisc(c, pc.x, pc.z, 4.2, heightAt, LIFT.scorch, 3);
      } else if (pc.kind === PIECE.campfire) {
        c.paint(TEX.soil, 2, [0.6, 0.5, 0.42]);
        drawDisc(c, pc.x, pc.z, 2.6, heightAt, LIFT.scorch, 2);
      }
    }
  }
  // Bridges and signposts.
  for (const br of t.bridges) drawBridge(cells.get((br.ax + br.bx) / 2, (br.az + br.bz) / 2).furn, t, br);
  for (const sg of t.signs) drawSign(cells.get(sg.x, sg.z).furn, sg);
  // Road lanterns: props in no settlement's range and no structure.
  const owned = new Uint8Array(t.props.length);
  for (const s of t.settlements) owned.fill(1, s.propFirst, s.propFirst + s.propCount);
  for (const st of t.structures) owned.fill(1, st.propFirst, st.propFirst + st.propCount);
  for (const p of t.props) {
    if (owned[p.index] || p.building >= 0) continue;
    const c = cells.get(p.x, p.z);
    const ctx: PropCtx = { wt: 0.3, openFront: false, heightAt, light: (e: Emitter) => c.lights.push(e.x, e.y, e.z, e.r, e.g, e.b, e.range) };
    drawProp(c.furn, p, { hu: 0.2, hv: 0.2, h: 2.6 }, ctx);
  }
  return [...cells.cells.entries()].map(([key, c]) => ({ key, cx: c.cx, cz: c.cz, decal: c.decal.data(), furniture: c.furn.data(), lights: new Float32Array(c.lights) }));
}
