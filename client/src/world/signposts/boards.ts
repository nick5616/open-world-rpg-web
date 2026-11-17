// Where a signpost's lettering goes (CR 052): for every board of a post, the
// two faces (front and back) as a world-space quad plus the arrow angle the
// reader of that face sees. Pure; SignpostLayer.tsx turns these into one
// small mesh per nearby post and a canvas texture of the words.
//
// Fork posts are the towns buffer's (roads.ts drawSign): arm k at height
// y + 2.35 - 0.34 k, a plank from 0.08 to 0.95 m along its yaw, +-0.03 m
// thick. Exit posts are ours: boards stacked on a post, each running from
// the post toward the road, its faces turned along the road.

import { arrowAngle, type Signpost } from './placement';

/** Rows of the label texture: 3 boards x 2 faces, each ROW_PX tall in a 512 x 512 canvas. */
export const ROW_PX = 84;
export const TEX_W = 512;
export const TEX_H = 512;
/** Half length / half height of a label quad (6:1, like a row). */
const LABEL_HL = 0.72;
const LABEL_HH = 0.12;

export interface Face {
  /** Quad corners (bottom-left, bottom-right, top-right, top-left) as the reader sees them. */
  c: [number, number, number][];
  /** Outward normal (x, z). */
  nx: number;
  nz: number;
  /** Arrow rotation as the reader sees it (radians clockwise from up). */
  arrow: number;
  /** Row in the label texture. */
  row: number;
}

export interface BoardLayout {
  /** Index into the post's boards. */
  board: number;
  faces: Face[];
  /** Plank centre, axis (x, z), half length, half height (exit posts draw their own planks). */
  cx: number;
  cy: number;
  cz: number;
  ax: number;
  az: number;
  hl: number;
  hh: number;
}

/** Height of the topmost exit board above the post's foot, and the step between boards. */
export const EXIT_TOP_Y = 2.55;
export const EXIT_STEP_Y = 0.34;
/** Plank half thickness, and how far in front of it the lettering floats. */
export const PLANK_HT = 0.03;
export const LABEL_OFFSET = 0.045;

function face(cx: number, cy: number, cz: number, nx: number, nz: number, hl: number, hh: number, dx: number, dz: number, row: number): Face {
  // The reader looks along f = -n; their right is (n.z, -n.x).
  const rx = nz;
  const rz = -nx;
  const ox = cx + nx * LABEL_OFFSET;
  const oz = cz + nz * LABEL_OFFSET;
  const c: [number, number, number][] = [
    [ox - rx * hl, cy - hh, oz - rz * hl],
    [ox + rx * hl, cy - hh, oz + rz * hl],
    [ox + rx * hl, cy + hh, oz + rz * hl],
    [ox - rx * hl, cy + hh, oz - rz * hl],
  ];
  return { c, nx, nz, arrow: arrowAngle(-nx, -nz, dx, dz), row };
}

/** The boards of a post. `footY` is the ground height at an exit post (forks carry their own). */
export function layoutBoards(p: Signpost, footY: number): BoardLayout[] {
  const out: BoardLayout[] = [];
  if (p.kind === 'fork') {
    p.boards.forEach((b, i) => {
      const yaw = p.yaws[i];
      const k = p.armIndex[i];
      const ux = Math.cos(yaw);
      const uz = Math.sin(yaw);
      const vx = -uz;
      const vz = ux;
      const y = p.y + 2.35 - k * 0.34 + 0.12;
      // The label's middle: 0.52 m out along the arm (the plank runs 0.08 to 0.95).
      const cx = p.x + ux * 0.52;
      const cz = p.z + uz * 0.52;
      const faces = [face(cx, y, cz, vx, vz, 0.4, 0.067, b.dx, b.dz, i * 2), face(cx, y, cz, -vx, -vz, 0.4, 0.067, b.dx, b.dz, i * 2 + 1)];
      out.push({ board: i, faces, cx, cy: y, cz, ax: ux, az: uz, hl: 0.435, hh: 0.12 });
    });
    return out;
  }
  const t = p.roadDir ?? { x: 1, z: 0 };
  // From the post toward the road.
  const ax = t.z;
  const az = -t.x;
  p.boards.forEach((b, i) => {
    const cx = p.x + ax * 0.78;
    const cz = p.z + az * 0.78;
    const y = footY + EXIT_TOP_Y - i * EXIT_STEP_Y;
    const faces = [face(cx, y, cz, t.x, t.z, LABEL_HL, LABEL_HH, b.dx, b.dz, i * 2), face(cx, y, cz, -t.x, -t.z, LABEL_HL, LABEL_HH, b.dx, b.dz, i * 2 + 1)];
    out.push({ board: i, faces, cx, cy: y, cz, ax, az, hl: 0.77, hh: 0.15 });
  });
  return out;
}
