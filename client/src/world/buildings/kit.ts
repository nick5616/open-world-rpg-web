// Building meshes from the kit (WP20, spec 5 "buildings from a kit"): one
// settlement's buildings, town walls, gates and dressing assembled into two
// meshes (the shell, seen from everywhere, and the interior furniture, shown
// up close), in the buildings worker.
//
// The collision boxes are the source of truth (worldgen/src/town/kit.rs):
// floor slabs, walls (split around the door), the lintel, the block above
// the ground-floor ceiling, the two sloped roof halves, door ramps, porches,
// fences, town walls and gate towers are each drawn ON their box, so what
// you see is what you bump (kit.test.ts checks walls against boxes). The
// renderer only adds what has no collision: windows, shutters, corner posts,
// jetty bands, chimneys, roof overhangs, eave trim, stilts, porch awnings,
// merlons. Faces that would sit on another box's face (wall ends at the
// building corners, the 5 cm of wall below the floor line) are left out to
// avoid z-fighting.

import { BOX_FLAG, BUILDING_FLAG, PROP_KINDS, type Building, type Settlement, type TownProp, type Towns } from '@lodestone/worldgen';
import { GLOW_DAYLIGHT, MeshBuilder, at, dirOf, local, turned, type Frame, type MeshData, type V3 } from './meshBuilder';
import { DEFAULT_DIMS, drawProp, P, PK, type Emitter, type PropCtx, type PropDims } from './props';
import { TEX, type TexName } from './textures';

/** Box kinds (worldgen bk). */
export const BK = { floor: 0, wall: 1, upper: 2, roof: 3, ramp: 4, furniture: 5, fence: 6, townWall: 7, gate: 8, deck: 9, bridgeRamp: 10, piece: 11, townProp: 12, railing: 13 } as const;
export const STYLE = { timber: 0, stone: 1, adobe: 2, stilt: 3, log: 4, cottage: 5 } as const;
export const ROLE = { house: 0, inn: 1, forge: 2, stall: 3, garden: 4, farm: 5, workshop: 6, storehouse: 7 } as const;

export interface Box {
  i: number;
  cx: number;
  cz: number;
  c: number;
  s: number;
  hx: number;
  hz: number;
  y0: number;
  y1: number;
  y2: number;
  kind: number;
  flags: number;
  owner: number;
}

export function boxAt(t: Towns, i: number): Box {
  const f = t.boxes.f;
  const o = i * 9;
  return { i, cx: f[o], cz: f[o + 1], c: f[o + 2], s: f[o + 3], hx: f[o + 4], hz: f[o + 5], y0: f[o + 6], y1: f[o + 7], y2: f[o + 8], kind: t.boxes.kind[i], flags: t.boxes.flags[i], owner: t.boxes.owner[i] };
}

export const boxFrame = (b: Box): Frame => ({ cx: b.cx, cz: b.cz, c: b.c, s: b.s });
export const buildingFrame = (b: Building): Frame => ({ cx: b.x, cz: b.z, c: b.c, s: b.s });
export const wallThickness = (style: number) => (style === STYLE.stone || style === STYLE.adobe ? 0.5 : 0.3);

interface Look {
  wall: TexName;
  inner: TexName;
  roofs: TexName[];
  gable: TexName;
  found: TexName;
  windowW: number;
  shutters: boolean;
  corners: boolean;
  tints: V3[];
}

/** Per style (kit.rs STYLE_*): materials, window size, trim. */
const LOOKS: Look[] = [
  { wall: 'timber', inner: 'plaster', roofs: ['shingle', 'clayTile'], gable: 'timber', found: 'fieldstone', windowW: 0.9, shutters: true, corners: true, tints: [[1, 1, 1], [1, 0.97, 0.9], [0.96, 0.95, 0.98], [1, 0.95, 0.88]] },
  { wall: 'stone', inner: 'plaster', roofs: ['slate'], gable: 'stone', found: 'stone', windowW: 0.75, shutters: false, corners: false, tints: [[1, 1, 1], [0.95, 0.93, 0.9], [1.04, 1.0, 0.94], [0.92, 0.94, 0.98]] },
  { wall: 'adobe', inner: 'adobe', roofs: [], gable: 'adobe', found: 'adobe', windowW: 0.7, shutters: false, corners: false, tints: [[1, 1, 1], [1.05, 0.98, 0.9], [0.95, 0.88, 0.82], [1.08, 1.02, 0.95]] },
  { wall: 'reed', inner: 'reed', roofs: ['thatch'], gable: 'reed', found: 'planks', windowW: 0.8, shutters: true, corners: true, tints: [[1, 1, 1], [0.92, 0.95, 0.85], [1.05, 0.98, 0.88], [0.9, 0.88, 0.8]] },
  { wall: 'logs', inner: 'logs', roofs: ['shingle', 'planks'], gable: 'planks', found: 'fieldstone', windowW: 0.8, shutters: true, corners: false, tints: [[1, 1, 1], [0.9, 0.85, 0.82], [1.05, 0.98, 0.9], [0.85, 0.8, 0.75]] },
  { wall: 'plaster', inner: 'plaster', roofs: ['thatch', 'clayTile'], gable: 'plaster', found: 'fieldstone', windowW: 0.9, shutters: true, corners: true, tints: [[1, 1, 1], [1, 0.95, 0.85], [1, 0.9, 0.88], [0.96, 0.98, 1]] },
];
const SHUTTERS: V3[] = [
  [0.45, 0.62, 0.45],
  [0.4, 0.5, 0.7],
  [0.72, 0.38, 0.32],
  [0.6, 0.52, 0.4],
];

const hash = (a: number, b: number) => {
  let h = Math.imul(a * 73856093 ^ (b * 19349663), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** Top of box b at world (x, z), or NaN outside (town.ts topAt). */
export function boxTopAt(b: Box, x: number, z: number): number {
  const dx = x - b.cx;
  const dz = z - b.cz;
  const u = dx * b.c + dz * b.s;
  const v = dz * b.c - dx * b.s;
  if (u < -b.hx || u > b.hx || v < -b.hz || v > b.hz) return NaN;
  return b.y1 + (b.y2 - b.y1) * ((u + b.hx) / (b.hx + b.hx));
}

export interface SettlementMesh {
  shell: MeshData;
  interior: MeshData;
  /** Emitters, 7 floats each: x, y, z, r, g, b, range. */
  lights: Float32Array;
  /** Playtest 2 immersion pass: chimney tops (3 floats each: x, y, z), where the smoke rises (chimneySmoke.ts). */
  smoke: Float32Array;
  /** Bounding sphere (x, y, z, r). */
  bounds: [number, number, number, number];
}

export const SKY_GLOW_INN = 70;
export const SKY_GLOW_HOUSE = 46;

/** Prop dims from its furniture / town-prop box (exact collision extents), else the kit defaults. */
export function propDims(t: Towns, p: TownProp, boxByPos: Map<string, number>): PropDims {
  const key = `${Math.round(p.x * 100)},${Math.round(p.z * 100)}`;
  const bi = boxByPos.get(key);
  const k = PROP_KINDS[p.kind];
  const def = DEFAULT_DIMS[k] ?? { hu: 0.5, hv: 0.5, h: 1 };
  if (bi === undefined) return def;
  const b = boxAt(t, bi);
  const al = Math.abs(b.c * Math.cos(p.yaw) + b.s * Math.sin(p.yaw)) > 0.7;
  return { hu: al ? b.hx : b.hz, hv: al ? b.hz : b.hx, h: Math.max(b.y1, b.y2) - p.y };
}

/** Index of furniture / town-prop boxes by centre (props and their boxes share it exactly). */
export function boxIndexByPos(t: Towns, first: number, count: number): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = first; i < first + count; i++) {
    const k = t.boxes.kind[i];
    if (k !== BK.furniture && k !== BK.townProp) continue;
    const o = i * 9;
    m.set(`${Math.round(t.boxes.f[o] * 100)},${Math.round(t.boxes.f[o + 1] * 100)}`, i);
  }
  return m;
}

/** One building's shell (walls, floor, roof, windows, ...) into `mb`. */
export function drawBuildingShell(mb: MeshBuilder, t: Towns, b: Building, heightAt: (x: number, z: number) => number): void {
  if (b.floors === 0) {
    // Stalls and ward gardens: only their fences here (props draw the rest).
    for (let i = b.boxFirst; i < b.boxFirst + b.boxCount; i++) {
      const bx = boxAt(t, i);
      if (bx.kind === BK.fence) drawFence(mb, bx);
    }
    return;
  }
  const look = LOOKS[b.style] ?? LOOKS[0];
  const F = buildingFrame(b);
  const wt = wallThickness(b.style);
  const tint = look.tints[b.variant & 3];
  const wallTop = b.floorY + b.floors * b.storey;
  mb.originY = b.floorY;
  const roofTex = look.roofs.length ? look.roofs[(b.variant >> 2) % look.roofs.length] : 'adobe';
  const stilts = (b.flags & BUILDING_FLAG.stilts) !== 0;
  const posts = (b.flags & BUILDING_FLAG.posts) !== 0;
  const stepped = (b.flags & BUILDING_FLAG.stepped) !== 0;

  for (let i = b.boxFirst; i < b.boxFirst + b.boxCount; i++) {
    const bx = boxAt(t, i);
    const f = boxFrame(bx);
    switch (bx.kind) {
      case BK.floor: {
        const solid = (bx.flags & BOX_FLAG.solid) !== 0;
        // genVersion 2: the porch deck is solid too; it is the floor box in front of the door wall.
        const porch = local(F, bx.cx, bx.cz)[1] < -b.hz + 0.01;
        if (solid && !porch) {
          // Floor slab: plank floor on top, the foundation down to baseY:
          // stone plinth, stepped plinth (genVersion 2: courses following the
          // slope), timber posts and cribbing on steep lots, or a stilt skirt.
          if (posts) drawPosts(mb, f, bx, b.floorY, heightAt);
          else {
            P(mb, stilts ? 'reed' : look.found, stilts ? [0.55, 0.5, 0.42] : [1, 1, 1]);
            mb.slopedBox(f, -bx.hx, bx.hx, -bx.hz, bx.hz, bx.y0, bx.y1, bx.y2, { top: false });
            if (!stilts) drawPlinthTrim(mb, f, bx, b.floorY, look, stepped, heightAt);
          }
          P(mb, 'floor');
          mb.slopedBox(f, -bx.hx, bx.hx, -bx.hz, bx.hz, bx.y1 - 0.001, bx.y1, bx.y2, { sides: false });
          if (stilts) drawStilts(mb, f, bx, b.floorY);
        } else if (solid) {
          // Porch deck on a slope (solid since genVersion 2): deck, posts and a
          // board skirt down to the ground, an awning on posts.
          P(mb, 'floor', [0.92, 0.85, 0.75]);
          mb.slopedBox(f, -bx.hx, bx.hx, -bx.hz, bx.hz, bx.y1 - 0.3, bx.y1, bx.y2, { bottom: true });
          P(mb, 'planks', [0.62, 0.52, 0.42]);
          mb.slopedBox(f, -bx.hx + 0.06, bx.hx - 0.06, -bx.hz + 0.06, bx.hz - 0.06, bx.y0, bx.y1 - 0.3, bx.y1 - 0.3, { top: false });
          P(mb, 'wood', [0.6, 0.48, 0.36]);
          for (const su of [-1, 1]) for (const sv of [-1, 1]) mb.box(f, su * bx.hx - 0.1 * su - 0.08, su * bx.hx - 0.1 * su + 0.08, bx.y0, bx.y1 - 0.3, sv * bx.hz - 0.1 * sv - 0.08, sv * bx.hz - 0.1 * sv + 0.08, { top: false });
          drawPorchAwning(mb, F, b, bx, wallTop, roofTex);
        } else {
          // Porch deck (walkable, not solid): deck, fascia, posts, an awning on posts.
          P(mb, 'floor', [0.92, 0.85, 0.75]);
          mb.slopedBox(f, -bx.hx, bx.hx, -bx.hz, bx.hz, bx.y1 - 0.3, bx.y1, bx.y2, { bottom: true });
          P(mb, 'wood', [0.6, 0.48, 0.36]);
          for (const su of [-1, 1]) for (const sv of [-1, 1]) mb.box(f, su * bx.hx - 0.1 * su - 0.07, su * bx.hx - 0.1 * su + 0.07, bx.y0 + 0.3, bx.y1 - 0.3, sv * bx.hz - 0.1 * sv - 0.07, sv * bx.hz - 0.1 * sv + 0.07, { top: false });
          drawPorchAwning(mb, F, b, bx, wallTop, roofTex);
        }
        break;
      }
      case BK.wall:
        drawWall(mb, t, b, bx, look, tint, wt);
        break;
      case BK.upper: {
        // Ceiling inside; on flat roofs (adobe) the walkable roof, with a lip.
        P(mb, look.inner === 'logs' ? 'planks' : 'floor', [0.85, 0.78, 0.7]);
        mb.slopedBox(f, -bx.hx, bx.hx, -bx.hz, bx.hz, bx.y0, bx.y0 + 0.001, bx.y0 + 0.001, { top: false, sides: false, bottom: true });
        if (b.roof === 2 || b.roof === 3) {
          P(mb, 'adobe', [0.86, 0.8, 0.74]);
          mb.slopedBox(f, -bx.hx, bx.hx, -bx.hz, bx.hz, bx.y0, bx.y1, bx.y2, { bottom: false });
          drawVigas(mb, F, b, wallTop);
        }
        break;
      }
      case BK.roof:
        drawRoofHalf(mb, bx, roofTex, look, tint, b);
        break;
      case BK.ramp: {
        const tex: TexName = b.style === STYLE.stone || b.style === STYLE.adobe ? (b.style === STYLE.adobe ? 'adobe' : 'stone') : 'planks';
        if (Math.abs(bx.y2 - bx.y1) > STEPS_RISE) drawSteps(mb, f, bx, tex);
        else {
          P(mb, tex, [0.9, 0.85, 0.78]);
          mb.slopedBox(f, -bx.hx, bx.hx, -bx.hz, bx.hz, bx.y0, bx.y1, bx.y2, { topPaint: { ...mb.save(), layer: TEX.floor, tile: 2 } });
        }
        break;
      }
      case BK.fence:
        drawFence(mb, bx);
        break;
    }
  }
  if (look.corners) {
    P(mb, 'wood', [0.3, 0.24, 0.2]);
    for (const su of [-1, 1])
      for (const sv of [-1, 1]) {
        const u = su * b.hx;
        const v = sv * b.hz;
        mb.box(F, Math.min(u, u - su * 0.2) - (su > 0 ? 0 : 0.03), Math.max(u, u - su * 0.2) + (su > 0 ? 0.03 : 0), b.floorY, wallTop, Math.min(v, v - sv * 0.2) - (sv > 0 ? 0 : 0.03), Math.max(v, v - sv * 0.2) + (sv > 0 ? 0.03 : 0), { top: false });
      }
  }
  if ((b.flags & BUILDING_FLAG.jetty) !== 0) {
    // Jetty band: a projecting beam at the upper floor line (timber, 2 floors).
    P(mb, 'wood', [0.45, 0.32, 0.22]);
    const y = b.floorY + b.storey;
    const e = 0.1;
    mb.box(F, -b.hx - e, b.hx + e, y - 0.12, y + 0.1, -b.hz - e, -b.hz + 0.02, { bottom: true });
    mb.box(F, -b.hx - e, b.hx + e, y - 0.12, y + 0.1, b.hz - 0.02, b.hz + e, { bottom: true });
    mb.box(F, -b.hx - e, -b.hx + 0.02, y - 0.12, y + 0.1, -b.hz, b.hz, { bottom: true });
    mb.box(F, b.hx - 0.02, b.hx + e, y - 0.12, y + 0.1, -b.hz, b.hz, { bottom: true });
  }
  if ((b.flags & BUILDING_FLAG.chimney) !== 0) drawChimney(mb, t, b, F, wallTop);
}

/** Door rise (m) from which worldgen's door ramp is drawn as steps (worldgen town/kit.rs STEPS_RISE). */
export const STEPS_RISE = 0.55;

/**
 * Steps on a door ramp box (its u axis points up the flight, y1 at -hx, y2 at
 * +hx): treads of ~0.2 m rise whose nosings sit on the walkable slope, and a
 * stringer on each side. Collision stays the ramp's sloped top (worldgen).
 */
export function drawSteps(mb: MeshBuilder, f: Frame, bx: Box, tex: TexName): number {
  const rise = bx.y2 - bx.y1;
  const n = Math.max(2, Math.round(Math.abs(rise) / 0.2));
  const L = 2 * bx.hx;
  P(mb, tex, [0.88, 0.82, 0.74]);
  for (let k = 0; k < n; k++) {
    const u0 = -bx.hx + (k * L) / n;
    const u1 = -bx.hx + ((k + 1) * L) / n;
    const top = bx.y1 + ((k + 1) * rise) / n;
    mb.box(f, u0, u1, bx.y0, top, -bx.hz + 0.08, bx.hz - 0.08, { topPaint: { ...mb.save(), layer: TEX.floor, tile: 2 } });
  }
  P(mb, 'wood', [0.5, 0.4, 0.3]);
  for (const v0 of [-bx.hz, bx.hz - 0.08]) mb.slopedBox(f, -bx.hx, bx.hx, v0, v0 + 0.08, bx.y0, bx.y1 + 0.12, bx.y2 + 0.12, {});
  return n;
}

/**
 * Plinth trim: a projecting cap course under the floor line, and for a
 * stepped foundation (genVersion 2) a footing that steps down with the
 * ground in ~1.5 m runs along every side, so the plinth reads as built on
 * the slope.
 */
function drawPlinthTrim(mb: MeshBuilder, f: Frame, bx: Box, floorY: number, look: Look, stepped: boolean, heightAt: (x: number, z: number) => number): void {
  P(mb, look.found, [0.82, 0.8, 0.78]);
  mb.box(f, -bx.hx - 0.08, bx.hx + 0.08, floorY - 0.2, floorY - 0.05, -bx.hz - 0.08, bx.hz + 0.08, { bottom: true });
  if (!stepped) return;
  P(mb, look.found, [0.72, 0.7, 0.68]);
  const run = (len: number) => Math.max(1, Math.round(len / 1.5));
  for (const [axis, side] of [['u', -1], ['u', 1], ['v', -1], ['v', 1]] as const) {
    const len = 2 * (axis === 'u' ? bx.hz : bx.hx);
    const n = run(len);
    for (let k = 0; k < n; k++) {
      const a0 = -len / 2 + (k * len) / n;
      const a1 = -len / 2 + ((k + 1) * len) / n;
      const mid = (a0 + a1) / 2;
      const [u, v] = axis === 'u' ? [side * bx.hx, mid] : [mid, side * bx.hz];
      const [x, z] = [f.cx + u * f.c - v * f.s, f.cz + u * f.s + v * f.c];
      const top = Math.min(floorY - 0.3, heightAt(x, z) + 0.4);
      if (axis === 'u') mb.box(f, side * bx.hx - 0.14, side * bx.hx + 0.14, bx.y0, top, a0, a1);
      else mb.box(f, a0, a1, bx.y0, top, side * bx.hz - 0.14, side * bx.hz + 0.14);
    }
  }
}

/**
 * Timber posts and cribbing (genVersion 2, steep lots): a beam band under
 * the floor, a recessed board skirt over the collision outline, posts
 * every ~2 m round the outline from below the ground to the beam, and
 * cross braces on each side where it stands tall.
 */
function drawPosts(mb: MeshBuilder, f: Frame, bx: Box, floorY: number, heightAt: (x: number, z: number) => number): void {
  P(mb, 'wood', [0.45, 0.34, 0.25]);
  mb.box(f, -bx.hx - 0.04, bx.hx + 0.04, floorY - 0.32, floorY - 0.02, -bx.hz - 0.04, bx.hz + 0.04, { top: false, bottom: true });
  P(mb, 'planks', [0.55, 0.47, 0.38]);
  mb.slopedBox(f, -bx.hx + 0.02, bx.hx - 0.02, -bx.hz + 0.02, bx.hz - 0.02, bx.y0, floorY - 0.32, floorY - 0.32, { top: false });
  P(mb, 'wood', [0.42, 0.33, 0.25]);
  const at2 = (u: number, v: number): [number, number] => [f.cx + u * f.c - v * f.s, f.cz + u * f.s + v * f.c];
  for (const [hu, hv, alongU] of [
    [bx.hx, bx.hz, true],
    [bx.hz, bx.hx, false],
  ] as const) {
    const n = Math.max(1, Math.round((2 * hu) / 2));
    for (const sv of [-1, 1]) {
      let prev: { a: number; g: number } | null = null;
      for (let k = 0; k <= n; k++) {
        const a = -hu + (k * 2 * hu) / n;
        const [u, v] = alongU ? [a, sv * hv] : [sv * hv, a];
        const [x, z] = at2(u, v);
        const g = heightAt(x, z);
        mb.box(f, u - 0.1, u + 0.1, Math.min(bx.y0, g - 0.3), floorY - 0.32, v - 0.1, v + 0.1, { top: false });
        if (prev && floorY - Math.max(g, prev.g) > 1.4) {
          // A brace from the low end of this bay up to the beam.
          const lo = Math.max(g, prev.g) + 0.2;
          const [ua, va] = alongU ? [prev.a, sv * hv] : [sv * hv, prev.a];
          const [ub, vb] = alongU ? [a, sv * hv] : [sv * hv, a];
          const o = 0.06 * sv;
          mb.poly([at(f, ua, lo, va + (alongU ? o : 0)), at(f, ua + (alongU ? 0.14 : 0), lo, va + (alongU ? o : 0.14)), at(f, ub, floorY - 0.4, vb + (alongU ? o : 0)), at(f, ub - (alongU ? 0.14 : 0), floorY - 0.4, vb + (alongU ? o : -0.14))], dirOf(f, alongU ? 0 : sv, 0, alongU ? sv : 0));
        }
        prev = { a, g };
      }
    }
  }
}

/** A wall box: style face outside, inner finish inside, windows on long enough walls. */
function drawWall(mb: MeshBuilder, t: Towns, b: Building, bx: Box, look: Look, tint: V3, wt: number): void {
  const F = buildingFrame(b);
  const [lu, lv] = local(F, bx.cx, bx.cz);
  const frontBack = Math.abs(lv) >= b.hz - wt * 0.5 - 0.02;
  const sgn = frontBack ? Math.sign(lv) || -1 : Math.sign(lu) || 1;
  const lintel = bx.y0 > b.floorY + 1;
  const y0 = lintel ? bx.y0 : Math.max(bx.y0, b.floorY);
  const top = Math.max(bx.y1, bx.y2);
  const f = boxFrame(bx);
  // Which faces: outward, inward, and ends unless they sit on the building's outline.
  const inName = frontBack ? (sgn > 0 ? '-v' : '+v') : sgn > 0 ? '-u' : '+u';
  const skip: string[] = [];
  if (frontBack) {
    if (lu - bx.hx <= -b.hx + 0.02) skip.push('-u');
    if (lu + bx.hx >= b.hx - 0.02) skip.push('+u');
  } else {
    if (lv - bx.hz <= -b.hz + 0.02) skip.push('-v');
    if (lv + bx.hz >= b.hz - 0.02) skip.push('+v');
  }
  const outer = P(mb, look.wall, tint).save();
  const inner = P(mb, look.inner, [0.95, 0.93, 0.9]).save();
  mb.restore(outer);
  mb.slopedBox(f, -bx.hx, bx.hx, -bx.hz, bx.hz, y0, bx.y1, bx.y2, {
    skip,
    bottom: lintel,
    sidePaint: { [inName]: inner } as Record<string, typeof inner>,
  });
  if (lintel) {
    // A lintel beam over the doorway.
    P(mb, 'wood', [0.5, 0.36, 0.25]);
    mb.slopedBox(f, -bx.hx - 0.1, bx.hx + 0.1, -bx.hz - 0.03, bx.hz + 0.03, bx.y0 - 0.001, bx.y0 + 0.18, bx.y0 + 0.18, { bottom: true });
    return;
  }
  // Windows (none on the open front of a forge; storehouses keep their ground floor blind).
  if (b.role === ROLE.forge && frontBack && sgn < 0) return;
  const along = frontBack ? lu : lv;
  const half = frontBack ? bx.hx : bx.hz;
  const lim = (frontBack ? b.hx : b.hz) - wt - 0.35;
  const a = Math.max(along - half + 0.3, -lim);
  const c = Math.min(along + half - 0.3, lim);
  const ww = look.windowW;
  const len = c - a;
  if (len < ww + 0.2) return;
  let n = Math.floor(len / 2.4);
  if (n === 0) n = 1;
  const plane = (frontBack ? lv : lu) + sgn * (frontBack ? bx.hz : bx.hx);
  const innerPlane = plane - sgn * wt;
  const shutter = SHUTTERS[(b.variant >> 1) & 3];
  for (let k = 0; k < b.floors; k++) {
    if (b.role === ROLE.storehouse && k === 0 && !(frontBack && sgn < 0)) continue;
    const sill = b.floorY + k * b.storey + 0.95;
    const wtop = Math.min(sill + 1.15, top - 0.35);
    if (wtop - sill < 0.6) continue;
    for (let j = 0; j < n; j++) {
      const m = a + ((j + 0.5) * len) / n;
      const lit = hash(b.index * 31 + k, j) > 0.28;
      const glow = lit ? (b.role === ROLE.inn ? SKY_GLOW_INN : SKY_GLOW_HOUSE) : 0;
      const pt = (s: number, y: number, off: number): V3 => (frontBack ? at(F, m + s, y, plane + sgn * off) : at(F, plane + sgn * off, y, m + s));
      const pti = (s: number, y: number, off: number): V3 => (frontBack ? at(F, m + s, y, innerPlane - sgn * off) : at(F, innerPlane - sgn * off, y, m + s));
      const out = frontBack ? dirOf(F, 0, 0, sgn) : dirOf(F, sgn, 0, 0);
      const inn: V3 = [-out[0], 0, -out[2]];
      const uv: [number, number][] = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ];
      mb.paint(TEX.window, 0, [1, 1, 1], glow);
      mb.poly([pt(-ww / 2, sill, 0.015), pt(ww / 2, sill, 0.015), pt(ww / 2, wtop, 0.015), pt(-ww / 2, wtop, 0.015)], out, uv);
      mb.paint(TEX.window, 0, [1, 1, 1], GLOW_DAYLIGHT); // from inside, the window shows the day outside
      mb.poly([pti(-ww / 2, sill, 0.015), pti(ww / 2, sill, 0.015), pti(ww / 2, wtop, 0.015), pti(-ww / 2, wtop, 0.015)], inn, uv);
      // Sill.
      P(mb, look.wall === 'stone' || look.wall === 'adobe' ? look.wall : 'wood', [0.85, 0.8, 0.75]);
      const s0 = pt(-ww / 2 - 0.08, sill - 0.08, 0);
      const s1 = pt(ww / 2 + 0.08, sill - 0.08, 0);
      const s2 = pt(ww / 2 + 0.08, sill - 0.08, 0.1);
      const s3 = pt(-ww / 2 - 0.08, sill - 0.08, 0.1);
      const up = (p: V3): V3 => [p[0], p[1] + 0.08, p[2]];
      mb.poly([up(s0), up(s1), up(s2), up(s3)], [0, 1, 0]);
      mb.poly([s3, s2, up(s2), up(s3)], out);
      if (look.shutters) {
        P(mb, 'planks', shutter);
        for (const side of [-1, 1]) {
          const x0 = side * (ww / 2 + 0.04);
          const x1 = side * (ww / 2 + 0.04 + ww * 0.45);
          mb.poly([pt(x0, sill - 0.02, 0.03), pt(x1, sill - 0.02, 0.03), pt(x1, wtop + 0.02, 0.03), pt(x0, wtop + 0.02, 0.03)], out);
        }
      }
    }
  }
  void t;
}

/** One roof half on its box: sloped surface with overhangs, underside, trim, the gable triangle, a ridge cap. */
function drawRoofHalf(mb: MeshBuilder, bx: Box, roofTex: TexName, look: Look, tint: V3, b: Building): void {
  const f = boxFrame(bx);
  const ridgePos = bx.y2 > bx.y1; // ridge at +hx
  const r = ridgePos ? bx.hx : -bx.hx;
  const e = -r;
  const eaveY = Math.min(bx.y1, bx.y2);
  const topY = Math.max(bx.y1, bx.y2);
  const slope = (topY - eaveY) / (2 * bx.hx);
  const thatch = roofTex === 'thatch';
  const oe = thatch ? 0.6 : 0.45;
  const og = thatch ? 0.4 : 0.3;
  const th = thatch ? 0.28 : 0.12;
  const ue = e + Math.sign(e) * oe;
  const ye = eaveY - slope * oe;
  const V = bx.hz + og;
  const out = (du: number) => dirOf(f, du, 0, 0);
  // Surface (exactly on the walkable roof top over the box).
  P(mb, roofTex);
  mb.poly([at(f, ue, ye, -V), at(f, r, topY, -V), at(f, r, topY, V), at(f, ue, ye, V)], [0, 1, 0]);
  // Underside and trim.
  P(mb, 'planks', [0.55, 0.45, 0.35]);
  mb.poly([at(f, ue, ye - th, -V), at(f, r, topY - th, -V), at(f, r, topY - th, V), at(f, ue, ye - th, V)], [0, -1, 0]);
  P(mb, thatch ? 'thatch' : 'wood', thatch ? [0.85, 0.8, 0.7] : [0.5, 0.36, 0.25]);
  mb.poly([at(f, ue, ye - th, -V), at(f, ue, ye, -V), at(f, ue, ye, V), at(f, ue, ye - th, V)], out(Math.sign(e)));
  for (const sv of [-1, 1]) mb.poly([at(f, ue, ye - th, sv * V), at(f, r, topY - th, sv * V), at(f, r, topY, sv * V), at(f, ue, ye, sv * V)], dirOf(f, 0, 0, sv));
  // Gable triangle on the building's end walls.
  P(mb, look.gable, tint);
  mb.originY = b.floorY;
  for (const sv of [-1, 1]) mb.poly([at(f, e, eaveY, sv * bx.hz), at(f, r, topY, sv * bx.hz), at(f, r, eaveY, sv * bx.hz)], dirOf(f, 0, 0, sv));
  if (ridgePos) {
    P(mb, thatch ? 'thatch' : 'wood', thatch ? [0.8, 0.72, 0.6] : [0.45, 0.33, 0.25]);
    mb.hcyl(turned(f, Math.PI / 2), -V - 0.02, V + 0.02, topY, -r, 0.13, 4);
  }
}

/** Awning over a porch: a lean-to from the wall above the door to two posts at the deck's front. */
function drawPorchAwning(mb: MeshBuilder, F: Frame, b: Building, deck: Box, wallTop: number, roofTex: TexName): void {
  const yWall = Math.min(wallTop - 0.15, b.floorY + 2.75);
  const yFront = yWall - 0.4;
  const front = -b.hz - 2.0 - 0.15;
  const hu = deck.hx + 0.2;
  P(mb, roofTex === 'thatch' ? 'thatch' : roofTex === 'adobe' ? 'planks' : roofTex);
  mb.poly([at(F, -hu, yWall, -b.hz), at(F, hu, yWall, -b.hz), at(F, hu, yFront, front), at(F, -hu, yFront, front)], [0, 1, 0]);
  P(mb, 'planks', [0.55, 0.45, 0.35]);
  mb.poly([at(F, -hu, yWall - 0.08, -b.hz), at(F, hu, yWall - 0.08, -b.hz), at(F, hu, yFront - 0.08, front), at(F, -hu, yFront - 0.08, front)], [0, -1, 0]);
  P(mb, 'wood', [0.5, 0.38, 0.28]);
  for (const su of [-1, 1]) {
    const u = su * (deck.hx - 0.12);
    mb.box(F, u - 0.06, u + 0.06, b.floorY, yFront, front + 0.1, front + 0.22, { top: false });
  }
}

/** Stilts under a stilt house: posts at the corners and mid-sides, just outside the skirt. */
function drawStilts(mb: MeshBuilder, f: Frame, bx: Box, floorY: number): void {
  P(mb, 'wood', [0.5, 0.42, 0.34]);
  for (const su of [-1, 0, 1])
    for (const sv of [-1, 1]) {
      const u = su * (bx.hx - 0.05);
      const v = sv * (bx.hz + 0.03);
      mb.cyl(f, u, v, bx.y0, floorY - 0.02, 0.11, 6);
    }
  P(mb, 'planks', [0.7, 0.6, 0.48]);
  mb.slopedBox(f, -bx.hx - 0.04, bx.hx + 0.04, -bx.hz - 0.04, bx.hz + 0.04, floorY - 0.3, floorY - 0.02, floorY - 0.02, { top: false });
}

/** Beam ends (vigas) poking out under an adobe flat roof. */
function drawVigas(mb: MeshBuilder, F: Frame, b: Building, wallTop: number): void {
  P(mb, 'wood', [0.5, 0.38, 0.28]);
  const y = wallTop - 0.4;
  for (let u = -b.hx + 0.6; u <= b.hx - 0.5; u += 0.9) {
    mb.cyl(F, u, -b.hz - 0.15, y, y + 0.001, 0.08, 5, { top: false });
    mb.box(F, u - 0.07, u + 0.07, y - 0.07, y + 0.07, -b.hz - 0.35, -b.hz + 0.01, { bottom: true });
    mb.box(F, u - 0.07, u + 0.07, y - 0.07, y + 0.07, b.hz - 0.01, b.hz + 0.35, { bottom: true });
  }
}

/** Chimney tops collected while a settlement mesh is built (buildSettlementMesh), else null. */
let smokeSink: number[] | null = null;

/** A chimney stack straddling the back wall behind the hearth or forge, above the roof. */
function drawChimney(mb: MeshBuilder, t: Towns, b: Building, F: Frame, wallTop: number): void {
  let u = b.hx * 0.35;
  for (let i = b.propFirst; i < b.propFirst + b.propCount; i++) {
    const p = t.props[i];
    if (p.kind === PK.hearth || p.kind === PK.forge) {
      u = local(F, p.x, p.z)[0];
      break;
    }
  }
  const v = b.hz - 0.3;
  const w = at(F, u, 0, v);
  let roofY = wallTop;
  for (let i = b.boxFirst; i < b.boxFirst + b.boxCount; i++) {
    if (t.boxes.kind[i] !== BK.roof) continue;
    const y = boxTopAt(boxAt(t, i), w[0], w[2]);
    if (y > roofY) roofY = y;
  }
  const top = roofY + 1.1;
  smokeSink?.push(w[0], top + 0.14, w[2]);
  P(mb, b.style === STYLE.stone ? 'stone' : 'fieldstone', [0.9, 0.88, 0.85]);
  mb.box(F, u - 0.45, u + 0.45, b.baseY, top, v - 0.35, v + 0.45, { top: true });
  P(mb, 'stone', [0.7, 0.68, 0.66]);
  mb.box(F, u - 0.5, u + 0.5, top, top + 0.12, v - 0.4, v + 0.5, { bottom: true });
}

/** Garden fence: posts and two rails inside the solid fence box. */
function drawFence(mb: MeshBuilder, bx: Box): void {
  const f = boxFrame(bx);
  const top = Math.max(bx.y1, bx.y2);
  const g = top - 0.9; // ground line (fence is 0.9 m tall)
  const long = bx.hx >= bx.hz;
  const L = long ? bx.hx : bx.hz;
  const n = Math.max(1, Math.round((2 * L) / 1.2));
  P(mb, 'wood', [0.78, 0.68, 0.55]);
  for (let k = 0; k <= n; k++) {
    const a = -L + (k * 2 * L) / n;
    if (long) mb.box(f, a - 0.05, a + 0.05, bx.y0, top, -0.06, 0.06);
    else mb.box(f, -0.06, 0.06, bx.y0, top, a - 0.05, a + 0.05);
  }
  for (const y of [g + 0.35, g + 0.72]) {
    if (long) mb.box(f, -L, L, y, y + 0.08, -0.03, 0.03, { bottom: true });
    else mb.box(f, -0.03, 0.03, y, y + 0.08, -L, L, { bottom: true });
  }
}

/** Town wall segment (stone, merlons on the outer edge) or gate tower (merlons all round). */
function drawTownWall(mb: MeshBuilder, bx: Box, s: Settlement): void {
  const f = boxFrame(bx);
  const top = Math.max(bx.y1, bx.y2);
  P(mb, 'stone', [0.92, 0.9, 0.86]);
  mb.slopedBox(f, -bx.hx, bx.hx, -bx.hz, bx.hz, bx.y0, bx.y1, bx.y2, { topPaint: { ...mb.save(), layer: TEX.flagstone, tile: 3 } });
  if (bx.kind === BK.townWall) {
    // Outer edge: the side away from the town centre.
    const [, lv] = local(f, s.x, s.z);
    const out = lv > 0 ? -1 : 1;
    const n = Math.max(1, Math.floor((2 * bx.hx) / 1.6));
    for (let k = 0; k < n; k++) {
      const u = -bx.hx + ((k + 0.5) * 2 * bx.hx) / n;
      const v0 = out * (bx.hz - 0.35);
      mb.box(f, u - 0.4, u + 0.4, top, top + 0.75, Math.min(v0, out * bx.hz), Math.max(v0, out * bx.hz));
    }
  } else {
    for (const side of [0, 1, 2, 3]) {
      const g = turned(f, (side * Math.PI) / 2);
      const L = side % 2 === 0 ? bx.hx : bx.hz;
      const D = side % 2 === 0 ? bx.hz : bx.hx;
      for (let k = 0; k < 3; k++) {
        const u = -L + ((k + 0.5) * 2 * L) / 3;
        mb.box(g, u - 0.35, u + 0.35, top, top + 0.85, D - 0.35, D);
      }
    }
  }
}

/** A stone arch beam between the two gate towers of a street (above head height, no collision). */
function drawGateLintel(mb: MeshBuilder, a: Box, b: Box, heightAt: (x: number, z: number) => number): void {
  const dx = b.cx - a.cx;
  const dz = b.cz - a.cz;
  const L = Math.hypot(dx, dz);
  if (L < 1 || L > 20) return;
  const f: Frame = { cx: (a.cx + b.cx) / 2, cz: (a.cz + b.cz) / 2, c: dx / L, s: dz / L };
  const top = Math.min(Math.max(a.y1, a.y2), Math.max(b.y1, b.y2)) - 1.2;
  const ground = heightAt(f.cx, f.cz);
  if (top - 1.2 < ground + 3.8) return;
  P(mb, 'stone', [0.88, 0.86, 0.82]);
  mb.box(f, -L / 2, L / 2, top - 1.2, top, -0.8, 0.8, { bottom: true });
}

/**
 * The whole settlement: every building shell, town wall, gate and outdoor
 * prop into one shell mesh; furniture into the interior mesh.
 */
export function buildSettlementMesh(t: Towns, si: number, heightAt: (x: number, z: number) => number): SettlementMesh {
  const s = t.settlements[si];
  const shell = new MeshBuilder(1 << 14);
  const interior = new MeshBuilder(1 << 13);
  const lights: number[] = [];
  const light = (e: Emitter) => lights.push(e.x, e.y, e.z, e.r, e.g, e.b, e.range);
  const boxByPos = boxIndexByPos(t, s.boxFirst, s.boxCount);
  let maxY = s.y;
  const smoke: number[] = [];
  for (let bi = s.buildingFirst; bi < s.buildingFirst + s.buildingCount; bi++) {
    const b = t.buildings[bi];
    smokeSink = smoke;
    try {
      drawBuildingShell(shell, t, b, heightAt);
    } finally {
      smokeSink = null;
    }
    maxY = Math.max(maxY, b.floorY + b.floors * b.storey + b.roofH + 1.5);
    const ctx: PropCtx = { wt: wallThickness(b.style), openFront: (b.flags & BUILDING_FLAG.openFront) !== 0, heightAt, light };
    for (let pi = b.propFirst; pi < b.propFirst + b.propCount; pi++) {
      const p = t.props[pi];
      // Outdoors (doors, fields, flower beds, market stalls) belongs to the shell.
      // Door leaves are drawn (and swung) by doorsMesh.ts, one instanced draw for every door.
      if (p.kind === PK.door) continue;
      const outdoor = p.kind === PK.crops || p.kind === PK.wardBed || b.floors === 0;
      shell.originY = 0;
      drawProp(outdoor ? shell : interior, p, propDims(t, p, boxByPos), ctx);
    }
  }
  // Town walls and gate towers.
  const gates: Box[] = [];
  for (let i = s.boxFirst; i < s.boxFirst + s.boxCount; i++) {
    const k = t.boxes.kind[i];
    if (k !== BK.townWall && k !== BK.gate) continue;
    const bx = boxAt(t, i);
    shell.originY = 0;
    drawTownWall(shell, bx, s);
    if (k === BK.gate) gates.push(bx);
  }
  for (let g = 0; g + 1 < gates.length; g += 2) drawGateLintel(shell, gates[g], gates[g + 1], heightAt);
  // Outdoor town props (board, well, street lanterns, gate braziers).
  const tctx: PropCtx = { wt: 0.3, openFront: false, heightAt, light };
  for (let pi = s.propFirst; pi < s.propFirst + s.propCount; pi++) {
    const p = t.props[pi];
    if (p.building >= 0 || p.structure >= 0) continue;
    drawProp(shell, p, propDims(t, p, boxByPos), tctx);
  }
  return { shell: shell.data(), interior: interior.data(), lights: new Float32Array(lights), smoke: new Float32Array(smoke), bounds: [s.x, (s.y + maxY) / 2, s.z, Math.hypot(s.radius + 4, (maxY - s.y) / 2 + 10)] };
}
