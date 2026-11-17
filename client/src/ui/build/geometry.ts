// Building piece geometry in integer centimetres (CR 041): the TS half of
// server/pkg/camps/build.go's turn / world / BoxesOf / SurfacesOf. Local
// frames are turned by quarter turns (camps rot 0, 2, 4, 6), so every
// number is exact on both sides; boxes and surfaces divide by 100 the same
// way the Go side does.

import { CAMPS, type BuildShape, type CampPieceDef } from '@lodestone/contracts';

const BY_ID = new Map<number, CampPieceDef>(CAMPS.pieces.map((p) => [p.id, p]));

/** A piece kind's definition by id (ids are sparse: 1-5, 100+, 200+). */
export function pieceDef(kind: number): CampPieceDef | undefined {
  return BY_ID.get(kind);
}

/** The building shape of a kind, undefined for the five camp pieces. */
export function shapeOf(kind: number): BuildShape | undefined {
  return BY_ID.get(kind)?.build;
}

export const isBuild = (kind: number): boolean => !!BY_ID.get(kind)?.build;

/** The cos/sin of rotation step k (45 degrees each): exact for the even steps building uses. */
const S45 = Math.SQRT1_2;
const ROT: readonly (readonly [number, number])[] = [
  [1, 0],
  [S45, S45],
  [0, 1],
  [-S45, S45],
  [-1, 0],
  [-S45, -S45],
  [0, -1],
  [S45, -S45],
];
export const rotCS = (k: number): readonly [number, number] => ROT[k & 7];

/** World (x, z) offset of local (u, v) for quarter q. */
export function turn(q: number, u: number, v: number): [number, number] {
  switch (q & 3) {
    case 1:
      return [-v, u];
    case 2:
      return [-u, -v];
    case 3:
      return [v, -u];
  }
  return [u, v];
}

export const quarter = (rot: number): number => (rot >> 1) & 3;

/** A placed building piece as the rules see it (centimetres). */
export interface BP {
  id: number;
  kind: number;
  rot: number;
  x: number;
  y: number;
  z: number;
  state: number;
  owner: string;
  party: number;
  lock: number;
}

/** World point [x, z, y] (cm) of local (u, v, y). */
export function world(bp: { rot: number; x: number; y: number; z: number }, u: number, v: number, y: number): [number, number, number] {
  const [x, z] = turn(quarter(bp.rot), u, v);
  return [bp.x + x, bp.z + z, bp.y + y];
}

/** A door's boxes depend on its state; everything else's are fixed. */
export function localBoxes(sh: BuildShape, state: number): readonly (readonly number[])[] {
  if (sh.door && (state & 1) === 1 && sh.openBoxes) return sh.openBoxes;
  return sh.boxes;
}

/** Collision boxes in the towns layout (x, z, cos, sin, hx, hz, bottom, top, top), cm / 100. */
export function boxesOf(bp: { kind: number; rot: number; x: number; y: number; z: number; state: number }): number[][] {
  const sh = shapeOf(bp.kind);
  if (!sh) return [];
  const [cs, sn] = rotCS(bp.rot);
  const out: number[][] = [];
  for (const b of localBoxes(sh, bp.state)) {
    const cu = Math.trunc((b[0] + b[1]) / 2);
    const cv = Math.trunc((b[2] + b[3]) / 2);
    const [wx, wz] = turn(quarter(bp.rot), cu, cv);
    const top = (bp.y + b[5]) / 100;
    out.push([(bp.x + wx) / 100, (bp.z + wz) / 100, cs, sn, (b[1] - b[0]) / 2 / 100, (b[3] - b[2]) / 2 / 100, (bp.y + b[4]) / 100, top, top]);
  }
  return out;
}

/** A walkable surface: centre, turn, half extents, heights at local u = -hx and +hx. */
export interface Surface {
  x: number;
  z: number;
  cs: number;
  sn: number;
  hx: number;
  hz: number;
  ya: number;
  yb: number;
}

export function surfaceOf(bp: { kind: number; rot: number; x: number; y: number; z: number }): Surface | null {
  const s = shapeOf(bp.kind)?.surface;
  if (!s) return null;
  const cu = Math.trunc((s[0] + s[1]) / 2);
  const cv = Math.trunc((s[2] + s[3]) / 2);
  const [wx, wz] = turn(quarter(bp.rot), cu, cv);
  const [cs, sn] = rotCS(bp.rot);
  return { x: (bp.x + wx) / 100, z: (bp.z + wz) / 100, cs, sn, hx: (s[1] - s[0]) / 2 / 100, hz: (s[3] - s[2]) / 2 / 100, ya: (bp.y + s[4]) / 100, yb: (bp.y + s[5]) / 100 };
}
