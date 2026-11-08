// Caves (WP09, spec 7): readers for the cave graph, cave cell and mouth mask
// buffers (layouts in worldgen/README.md "Caves"), the cave exports of
// worldgen.wasm, and the cave collision queries.
//
// Collision is pure TS over the cell buffers' f32 triangles, and the Go zone
// runs a line-for-line port (server/pkg/caves). Both must give identical
// bits: same operation order, f64 arithmetic, no fused multiply-add (JS
// never fuses; the Go port forces separate roundings). The algorithm is
// written out in worldgen/README.md "Cave collision" and pinned by the
// golden table's cave floor/collide vectors, checked in every host.
import { MAX_STEP_UP_M, PLAYER_CAPSULE_RADIUS } from '@lodestone/contracts';
import type { AtlasHandle, Worldgen } from './index';

export const CAVE_CELL_MAGIC = 0x5643444c; // "LDCV"
export const CAVE_GRAPH_MAGIC = 0x4743444c; // "LDCG"
export const CAVE_MASK_MAGIC = 0x4d43444c; // "LDCM"
export const CAVE_FORMAT = 1;
export const CAVE_CELL_W = 64;
export const CAVE_CELL_H = 32;
export const CAVE_SAMPLES_XZ = 33;
export const CAVE_SAMPLES_Y = 17;
export const CAVE_BINS = 34;
export const CAVE_CY_MIN = -8;
export const CAVE_CY_MAX = 23;
export const CAVE_EDIT_RECORD = 32;
const VEIN_REC = 32;
const DECO_REC = 16;

export const ORE_NAMES = ['copper', 'iron', 'silver', 'sunsteel', 'starmetal', 'voidglass'] as const;
export const GEM_NAMES = ['ruby', 'sapphire', 'topaz', 'emerald', 'aquamarine', 'sunstone', 'onyx', 'amethyst', 'opal', 'moonstone'] as const;
export const DECO_KINDS = ['fungus', 'crystal', 'stalagmite'] as const;
export const TUNNEL_KINDS = ['entry', 'tunnel', 'ravine', 'shaft'] as const;
export const DEPTH_BANDS = ['shallow', 'mid', 'deep'] as const;
export const CHAMBER_FLAG = { entrance: 1, sunlit: 2, shaft: 4, deepest: 8 } as const;
export const VEIN_FLAG = { sunlit: 1, mined: 2 } as const;
/** Layer byte of vein stable ids (README "Stable ids"). */
export const LAYER_VEIN = 7;

export interface CaveVein {
  id: bigint;
  x: number;
  y: number;
  z: number;
  /** Unit-ish normal out of the wall (i8 / 127). */
  nx: number;
  ny: number;
  nz: number;
  kind: 'ore' | 'gem';
  /** Ore id (ORE_NAMES) or gem id (GEM_NAMES). */
  material: number;
  element: number;
  hp: number;
  /** Crystals in the cluster (3..7). */
  size: number;
  flags: number;
  band: number;
  chamber: number;
}

export interface CaveDeco {
  x: number;
  y: number;
  z: number;
  kind: number;
  variant: number;
  scale: number;
  yaw: number;
}

export interface CaveCell {
  cx: number;
  cy: number;
  cz: number;
  flags: number;
  /** Origin of the cell in meters. */
  ox: number;
  oy: number;
  oz: number;
  vertexCount: number;
  triangleCount: number;
  /** 33 x 17 x 33 i8 density (field x 15.875, clamped), index (j*33 + k)*33 + i; negative = air. */
  density: Int8Array;
  positions: Float32Array;
  /** i8 x 4 per vertex: normal xyz (x127) and depth band. */
  normals: Int8Array;
  indices: Uint16Array;
  /** CSR collision columns: offsets (34*34+1) then triangle ids. */
  colOffsets: Uint32Array;
  colTris: Uint32Array;
  veins: CaveVein[];
  decos: CaveDeco[];
  system: number;
  band: number;
  minY: number;
  maxY: number;
  bytes: Uint8Array;
}

export interface CaveSystem {
  index: number;
  id: bigint;
  siteIndex: number;
  region: number;
  biome: number;
  element: number;
  element2: number;
  deepestBand: number;
  mouthY: number;
  firstChamber: number;
  chamberCount: number;
  firstTunnel: number;
  tunnelCount: number;
  firstOpening: number;
  openingCount: number;
  firstVein: number;
  veinCount: number;
  /** Local index of the deepest chamber. */
  deepest: number;
  bbox: [number, number, number, number, number, number];
  maxDepth: number;
}

export interface CaveChamber {
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  floor: number;
  depth: number;
  flags: number;
  band: number;
  /** Local parent chamber index, -1 for the entrance. */
  parent: number;
  system: number;
}

export interface CaveTunnel {
  a: number;
  b: number;
  kind: number;
  r: number;
  stretch: number;
  floorK: number;
  /** 4 axis points (3 segments), x y z each. */
  pts: number[];
  system: number;
}

export interface CaveOpening {
  x: number;
  y: number;
  z: number;
  rMask: number;
  rZone: number;
  system: number;
  tunnel: number;
  kind: 'mouth' | 'sinkhole';
  /** Facing (out of the hill), fraction of a turn x 65536. */
  yaw: number;
}

export interface CaveGraph {
  caveMaxDepth: number;
  gemRarityCurve: number;
  systems: CaveSystem[];
  chambers: CaveChamber[];
  tunnels: CaveTunnel[];
  openings: CaveOpening[];
  veins: CaveVein[];
  bytes: Uint8Array;
}

/** World edit as cave_build_edited takes it (vein mined + carve sphere). */
export interface CaveEdit {
  veinId: bigint;
  x: number;
  y: number;
  z: number;
  r: number;
}

function dv(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function readVein(d: DataView, o: number): CaveVein {
  return {
    id: d.getBigUint64(o, true),
    x: d.getFloat32(o + 8, true),
    y: d.getFloat32(o + 12, true),
    z: d.getFloat32(o + 16, true),
    nx: d.getInt8(o + 20) / 127,
    ny: d.getInt8(o + 21) / 127,
    nz: d.getInt8(o + 22) / 127,
    kind: d.getUint8(o + 23) === 1 ? 'gem' : 'ore',
    material: d.getUint8(o + 24),
    element: d.getUint8(o + 25),
    hp: d.getUint16(o + 26, true),
    size: d.getUint8(o + 28),
    flags: d.getUint8(o + 29),
    band: d.getUint8(o + 30),
    chamber: d.getUint8(o + 31),
  };
}

/** Human name of what a vein holds ("iron", "ruby"). */
export function veinMaterialName(v: Pick<CaveVein, 'kind' | 'material'>): string {
  return v.kind === 'gem' ? GEM_NAMES[v.material] ?? 'gem' : ORE_NAMES[v.material] ?? 'ore';
}

/** Parse a cave cell buffer. Typed arrays view `bytes` (copy it first if it lives in wasm memory). */
export function parseCaveCell(bytes: Uint8Array): CaveCell {
  const d = dv(bytes);
  if (d.getUint32(0, true) !== CAVE_CELL_MAGIC) throw new Error('not a cave cell (bad magic)');
  if (d.getUint16(4, true) !== CAVE_FORMAT) throw new Error(`cave cell format ${d.getUint16(4, true)}`);
  const cx = d.getInt32(12, true);
  const cy = d.getInt32(16, true);
  const cz = d.getInt32(20, true);
  const nv = d.getUint32(28, true);
  const nt = d.getUint32(32, true);
  const at = (o: number) => bytes.byteOffset + d.getUint32(o, true);
  const densOff = at(36);
  const posOff = at(40);
  const nrmOff = at(44);
  const idxOff = at(48);
  const colOff = at(52);
  const colLen = d.getUint32(56, true);
  const veinOff = d.getUint32(60, true);
  const nVein = d.getUint16(64, true);
  const nDeco = d.getUint16(66, true);
  const decoOff = d.getUint32(68, true);
  const nOffs = CAVE_BINS * CAVE_BINS + 1;
  const veins: CaveVein[] = [];
  for (let k = 0; k < nVein; k++) veins.push(readVein(d, veinOff + k * VEIN_REC));
  const decos: CaveDeco[] = [];
  for (let k = 0; k < nDeco; k++) {
    const o = decoOff + k * DECO_REC;
    decos.push({ x: d.getFloat32(o, true), y: d.getFloat32(o + 4, true), z: d.getFloat32(o + 8, true), kind: d.getUint8(o + 12), variant: d.getUint8(o + 13), scale: d.getUint8(o + 14), yaw: d.getUint8(o + 15) });
  }
  return {
    cx,
    cy,
    cz,
    flags: d.getUint32(24, true),
    ox: cx * CAVE_CELL_W,
    oy: cy * CAVE_CELL_H,
    oz: cz * CAVE_CELL_W,
    vertexCount: nv,
    triangleCount: nt,
    density: new Int8Array(bytes.buffer, densOff, CAVE_SAMPLES_XZ * CAVE_SAMPLES_Y * CAVE_SAMPLES_XZ),
    positions: new Float32Array(bytes.buffer, posOff, nv * 3),
    normals: new Int8Array(bytes.buffer, nrmOff, nv * 4),
    indices: new Uint16Array(bytes.buffer, idxOff, nt * 3),
    colOffsets: new Uint32Array(bytes.buffer, colOff, nOffs),
    colTris: new Uint32Array(bytes.buffer, colOff + nOffs * 4, (colLen - nOffs * 4) / 4),
    veins,
    decos,
    system: d.getUint16(72, true) === 0xffff ? -1 : d.getUint16(72, true),
    band: d.getUint8(74),
    minY: d.getFloat32(76, true),
    maxY: d.getFloat32(80, true),
    bytes,
  };
}

export function parseCaveGraph(bytes: Uint8Array): CaveGraph {
  const d = dv(bytes);
  if (d.getUint32(0, true) !== CAVE_GRAPH_MAGIC) throw new Error('not a cave graph (bad magic)');
  const u = (o: number) => d.getUint32(o, true);
  const f = (o: number) => d.getFloat32(o, true);
  const [ns, nc, nt, no, nv] = [u(12), u(16), u(20), u(24), u(28)];
  const [sysOff, chOff, tunOff, openOff, veinOff] = [u(32), u(36), u(40), u(44), u(48)];
  const systems: CaveSystem[] = [];
  const chambers: CaveChamber[] = [];
  const tunnels: CaveTunnel[] = [];
  const openings: CaveOpening[] = [];
  const veins: CaveVein[] = [];
  for (let s = 0; s < ns; s++) {
    const o = sysOff + s * 72;
    systems.push({
      index: s,
      id: d.getBigUint64(o, true),
      siteIndex: d.getUint16(o + 8, true),
      region: d.getUint8(o + 10),
      biome: d.getUint8(o + 11),
      element: d.getUint8(o + 12),
      element2: d.getUint8(o + 13),
      deepestBand: d.getUint8(o + 15),
      mouthY: f(o + 16),
      firstChamber: u(o + 20),
      chamberCount: d.getUint16(o + 24, true),
      tunnelCount: d.getUint16(o + 26, true),
      firstTunnel: u(o + 28),
      firstOpening: d.getUint16(o + 32, true),
      openingCount: d.getUint16(o + 34, true),
      firstVein: u(o + 36),
      veinCount: d.getUint16(o + 40, true),
      deepest: d.getUint16(o + 42, true),
      bbox: [f(o + 44), f(o + 48), f(o + 52), f(o + 56), f(o + 60), f(o + 64)],
      maxDepth: f(o + 68),
    });
  }
  const sysOf = (first: (s: CaveSystem) => number, count: (s: CaveSystem) => number, i: number) => systems.findIndex((s) => i >= first(s) && i < first(s) + count(s));
  for (let k = 0; k < nc; k++) {
    const o = chOff + k * 32;
    const parent = d.getUint16(o + 30, true);
    chambers.push({ x: f(o), y: f(o + 4), z: f(o + 8), rx: f(o + 12), ry: f(o + 16), floor: f(o + 20), depth: f(o + 24), flags: d.getUint8(o + 28), band: d.getUint8(o + 29), parent: parent === 0xffff ? -1 : parent, system: sysOf((s) => s.firstChamber, (s) => s.chamberCount, k) });
  }
  for (let k = 0; k < nt; k++) {
    const o = tunOff + k * 72;
    const pts: number[] = [];
    for (let i = 0; i < 12; i++) pts.push(f(o + 20 + i * 4));
    tunnels.push({ a: d.getUint16(o, true), b: d.getUint16(o + 2, true), kind: d.getUint8(o + 4), r: f(o + 8), stretch: f(o + 12), floorK: f(o + 16), pts, system: sysOf((s) => s.firstTunnel, (s) => s.tunnelCount, k) });
  }
  for (let k = 0; k < no; k++) {
    const o = openOff + k * 32;
    openings.push({ x: f(o), y: f(o + 4), z: f(o + 8), rMask: f(o + 12), rZone: f(o + 16), system: d.getUint16(o + 20, true), tunnel: d.getUint16(o + 22, true), kind: d.getUint8(o + 24) === 1 ? 'sinkhole' : 'mouth', yaw: d.getUint16(o + 26, true) });
  }
  for (let k = 0; k < nv; k++) veins.push(readVein(d, veinOff + k * VEIN_REC));
  return { caveMaxDepth: f(52), gemRarityCurve: f(56), systems, chambers, tunnels, openings, veins, bytes };
}

/** Cave cell key (cells in a Map). */
export function caveCellKey(cx: number, cy: number, cz: number): number {
  return ((cy - CAVE_CY_MIN) * 64 + cz) * 64 + cx;
}

export function caveCellValid(cx: number, cy: number, cz: number): boolean {
  return cx >= 0 && cx < 64 && cz >= 0 && cz < 64 && cy >= CAVE_CY_MIN && cy <= CAVE_CY_MAX;
}

export function encodeCaveEdits(edits: readonly CaveEdit[]): Uint8Array {
  const b = new Uint8Array(edits.length * CAVE_EDIT_RECORD);
  const d = dv(b);
  edits.forEach((e, k) => {
    const o = k * CAVE_EDIT_RECORD;
    d.setBigUint64(o, BigInt.asUintN(64, e.veinId), true);
    d.setFloat32(o + 8, e.x, true);
    d.setFloat32(o + 12, e.y, true);
    d.setFloat32(o + 16, e.z, true);
    d.setFloat32(o + 20, e.r, true);
  });
  return b;
}

// ---- wasm calls (cave exports; see worldgen/README.md "Caves")

interface CaveExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  free(ptr: number, len: number): void;
  result_len(): number;
  error_ptr(): number;
  error_len(): number;
  cave_graph(atlasPtr: number): number;
  cave_build(atlasPtr: number, cx: number, cy: number, cz: number): number;
  cave_build_edited(atlasPtr: number, cx: number, cy: number, cz: number, editsPtr: number, editsLen: number): number;
  cave_mask(atlasPtr: number, cx: number, cz: number): number;
  cave_system_at(atlasPtr: number, x: number, y: number, z: number): number;
}

function ex(wg: Worldgen): CaveExports {
  return wg.exports as unknown as CaveExports;
}

function take(wg: Worldgen, p: number, what: string): Uint8Array {
  const e = ex(wg);
  if (!p) {
    const msg = new TextDecoder().decode(new Uint8Array(e.memory.buffer).slice(e.error_ptr(), e.error_ptr() + e.error_len()));
    throw new Error(`${what}: ${msg}`);
  }
  return new Uint8Array(e.memory.buffer).slice(p, p + e.result_len());
}

/** cave_graph: every system of the world (first call builds them, tens of ms). Copied out of wasm memory. */
export function caveGraphBytes(wg: Worldgen, atlas: AtlasHandle): Uint8Array {
  return take(wg, ex(wg).cave_graph(atlas.ptr), 'cave_graph');
}

/** cave_build (or cave_build_edited when edits are given). Copied out of wasm memory. */
export function caveCellBytes(wg: Worldgen, atlas: AtlasHandle, cx: number, cy: number, cz: number, edits?: readonly CaveEdit[] | Uint8Array): Uint8Array {
  const e = ex(wg);
  const eb = edits instanceof Uint8Array ? edits : edits && edits.length ? encodeCaveEdits(edits) : null;
  if (!eb || eb.length === 0) return take(wg, e.cave_build(atlas.ptr, cx, cy, cz), `cave_build(${cx},${cy},${cz})`);
  const p = e.alloc(eb.length);
  new Uint8Array(e.memory.buffer).set(eb, p);
  try {
    return take(wg, e.cave_build_edited(atlas.ptr, cx, cy, cz, p, eb.length), `cave_build_edited(${cx},${cy},${cz})`);
  } finally {
    e.free(p, eb.length);
  }
}

export function caveMaskBytes(wg: Worldgen, atlas: AtlasHandle, cx: number, cz: number): Uint8Array {
  return take(wg, ex(wg).cave_mask(atlas.ptr, cx, cz), `cave_mask(${cx},${cz})`);
}

/** Cave-system index at a point via the wasm export, or -1. */
export function caveSystemAtWasm(wg: Worldgen, atlas: AtlasHandle, x: number, y: number, z: number): number {
  return ex(wg).cave_system_at(atlas.ptr, x, y, z);
}

// ---- queries on the serialized graph (mirrored in Go: server/pkg/caves)

/** Is the heightfield triangle under (x, z) dropped by a mouth mask? (README "Mouth masks") */
export function caveMasked(openings: readonly CaveOpening[], x: number, z: number): boolean {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const lower = x - x0 + (z - z0) <= 1;
  const cx = lower ? x0 + 1 / 3 : x0 + 2 / 3;
  const cz = lower ? z0 + 1 / 3 : z0 + 2 / 3;
  for (const o of openings) {
    const dx = cx - o.x;
    const dz = cz - o.z;
    if (dx * dx + dz * dz < o.rMask * o.rMask) return true;
  }
  return false;
}

/** Is heightfield triangle `tri` of the 1 m cell (x0, z0) masked? (for tile builders) */
export function caveTriMasked(openings: readonly CaveOpening[], x0: number, z0: number, tri: 0 | 1): boolean {
  const cx = tri === 0 ? x0 + 1 / 3 : x0 + 2 / 3;
  const cz = tri === 0 ? z0 + 1 / 3 : z0 + 2 / 3;
  for (const o of openings) {
    const dx = cx - o.x;
    const dz = cz - o.z;
    if (dx * dx + dz * dz < o.rMask * o.rMask) return true;
  }
  return false;
}

/** Cave-system index containing (x, y, z) (within 2 m of planned air), or -1. Same as the wasm `cave_system_at`. */
export function caveSystemAt(g: CaveGraph, x: number, y: number, z: number): number {
  const PAD = 2;
  for (const s of g.systems) {
    const b = s.bbox;
    if (x < b[0] || y < b[1] || z < b[2] || x > b[3] || y > b[4] || z > b[5]) continue;
    for (let k = 0; k < s.chamberCount; k++) {
      const c = g.chambers[s.firstChamber + k];
      if (y < c.floor - PAD) continue;
      const dx = (x - c.x) / (c.rx + PAD);
      const dy = (y - c.y) / (c.ry + PAD);
      const dz = (z - c.z) / (c.rx + PAD);
      if (dx * dx + dy * dy + dz * dz <= 1) return s.index;
    }
    for (let k = 0; k < s.tunnelCount; k++) {
      const t = g.tunnels[s.firstTunnel + k];
      for (let sg = 0; sg < 3; sg++) {
        const p = t.pts;
        const ax = p[sg * 3], ay = p[sg * 3 + 1] / t.stretch, az = p[sg * 3 + 2];
        const bx = p[sg * 3 + 3], by = p[sg * 3 + 4] / t.stretch, bz = p[sg * 3 + 5];
        const py = y / t.stretch;
        const ex2 = bx - ax, ey = by - ay, ez = bz - az;
        const l2 = ex2 * ex2 + ey * ey + ez * ez;
        let tt = l2 > 0 ? ((x - ax) * ex2 + (py - ay) * ey + (z - az) * ez) / l2 : 0;
        tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
        const qx = ax + ex2 * tt - x, qy = ay + ey * tt - py, qz = az + ez * tt - z;
        const rr = t.r + PAD;
        if (qx * qx + qy * qy + qz * qz <= rr * rr) return s.index;
      }
    }
  }
  return -1;
}

// ---- collision (README "Cave collision"; Go port: server/pkg/caves/collide.go)

/** Triangles steeper than WALKABLE_SLOPE_DEG (50 deg: cos = 0.6428) are walls. */
export const CAVE_WALL_NY = 0.6427876096865394;
/** Facing down more than this: a ceiling. */
export const CAVE_CEIL_NY = -0.5;
/** Body spheres (feet + these heights), radius PLAYER_CAPSULE_RADIUS. The low one sits on the step-up height so ledges up to MAX_STEP_UP_M are stepped, not blocked. */
export const CAVE_BODY_LOW = MAX_STEP_UP_M + PLAYER_CAPSULE_RADIUS;
export const CAVE_BODY_HIGH = 1.5;
/** Floors are searched this far down (a cell and a bit); below that you're falling. */
export const CAVE_FLOOR_DROP = 34;
/** Collision resolve passes. */
export const CAVE_COLLIDE_PASSES = 2;

export interface CaveCollideResult {
  x: number;
  y: number;
  z: number;
  /** Total horizontal push (0 when untouched). */
  pushX: number;
  pushZ: number;
  ceiling: boolean;
}

/** Cells by key; the collision queries only read what is loaded. */
export interface CaveCellSource {
  cell(cx: number, cy: number, cz: number): CaveCell | undefined;
}

function cellsAlong(v: number, size: number): [number, number] {
  // The cell holding v, plus the next one when v is within 2 m of its low
  // border (its padding triangles reach 2 m into this cell's space).
  const c = Math.floor(v / size);
  return v - c * size >= size - 2 ? [c, c + 1] : [c, c];
}

/** Highest up-facing cave triangle under (x, z) whose height is <= y + MAX_STEP_UP_M (and >= y - CAVE_FLOOR_DROP), or -Infinity. */
export function caveFloorAt(src: CaveCellSource, x: number, y: number, z: number): number {
  return caveFloorIn(src, x, z, y - CAVE_FLOOR_DROP, y + MAX_STEP_UP_M, false);
}

/** Ledges are looked for this far above the feet. */
export const CAVE_LEDGE_M = 3;

/**
 * Highest (lowest when `lowest`) up-facing cave triangle height at (x, z)
 * within [bottom, top], or -Infinity (+Infinity when `lowest`) for none.
 */
export function caveFloorIn(src: CaveCellSource, x: number, z: number, bottom: number, top: number, lowest: boolean): number {
  let best = lowest ? Infinity : -Infinity;
  const [cx0, cx1] = cellsAlong(x, CAVE_CELL_W);
  const [cz0, cz1] = cellsAlong(z, CAVE_CELL_W);
  const cy0 = Math.floor((bottom - 2) / CAVE_CELL_H);
  const cy1 = Math.floor((top + 2) / CAVE_CELL_H);
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = src.cell(cx, cy, cz);
        if (!c || c.triangleCount === 0) continue;
        if (c.maxY < bottom || c.minY > top) continue;
        const bx = binOf(x, c.ox);
        const bz = binOf(z, c.oz);
        const k = bz * CAVE_BINS + bx;
        const p = c.positions;
        const ix = c.indices;
        for (let n = c.colOffsets[k]; n < c.colOffsets[k + 1]; n++) {
          const t = c.colTris[n] * 3;
          const a = ix[t] * 3, b = ix[t + 1] * 3, d = ix[t + 2] * 3;
          const h = triHeight(p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2], p[d], p[d + 1], p[d + 2], x, z);
          if (h === h && h <= top && h >= bottom && (lowest ? h < best : h > best)) best = h;
        }
      }
    }
  }
  return best;
}

function binOf(v: number, o: number): number {
  const b = Math.floor((v - o + 2) / 2);
  return b < 0 ? 0 : b > CAVE_BINS - 1 ? CAVE_BINS - 1 : b;
}

/**
 * Height of the triangle's plane at (x, z) when (x, z) lies in its xz
 * projection (edges inclusive with a 1e-9 tolerance so shared edges never
 * leave cracks) and the triangle faces up; NaN otherwise.
 */
function triHeight(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, x: number, z: number): number {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  // Up-facing: the normal (e1 x e2) has positive y (air above).
  const ny = e1z * e2x - e1x * e2z;
  if (!(ny > 0)) return NaN;
  const den = e1x * e2z - e2x * e1z;
  if (Math.abs(den) < 1e-12) return NaN;
  const px = x - ax, pz = z - az;
  const u = (px * e2z - e2x * pz) / den;
  const v = (e1x * pz - px * e1z) / den;
  if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) return NaN;
  return ay + u * e1y + v * e2y;
}

/**
 * Push a player (feet at x, y, z) out of cave walls (horizontally) and
 * ceilings (down). Order: CAVE_COLLIDE_PASSES passes x body spheres (low,
 * high) x cells (cy, cz, cx ascending) x that cell's candidate triangles
 * (ascending id, deduplicated), then one ceiling pass with the high sphere.
 */
export function caveCollide(src: CaveCellSource, x: number, y: number, z: number, out: CaveCollideResult): CaveCollideResult {
  const R = PLAYER_CAPSULE_RADIUS;
  const x0 = x, z0 = z;
  let ceiling = false;
  for (let pass = 0; pass < CAVE_COLLIDE_PASSES; pass++) {
    for (let s = 0; s < 2; s++) {
      const sy = y + (s === 0 ? CAVE_BODY_LOW : CAVE_BODY_HIGH);
      forEachTri(src, x, sy, z, R, (ax, ay, az, bx, by, bz, cx, cy, cz) => {
        const n = triNormal(ax, ay, az, bx, by, bz, cx, cy, cz);
        if (n === null || n[1] >= CAVE_WALL_NY || n[1] <= CAVE_CEIL_NY) return;
        closest(x, sy, z, ax, ay, az, bx, by, bz, cx, cy, cz, Q);
        const dx = x - Q[0], dy = sy - Q[1], dz = z - Q[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= R * R) return;
        const d = Math.sqrt(d2);
        let hx = dx, hz = dz;
        let hl = Math.sqrt(hx * hx + hz * hz);
        if (hl < 1e-6) {
          hx = n[0];
          hz = n[2];
          hl = Math.sqrt(hx * hx + hz * hz);
          if (hl < 1e-6) return;
        }
        const push = R - d;
        x = x + (hx / hl) * push;
        z = z + (hz / hl) * push;
      });
    }
  }
  const hy = y + CAVE_BODY_HIGH;
  forEachTri(src, x, hy, z, R, (ax, ay, az, bx, by, bz, cx, cy, cz) => {
    const n = triNormal(ax, ay, az, bx, by, bz, cx, cy, cz);
    if (n === null || n[1] > CAVE_CEIL_NY) return;
    closest(x, y + CAVE_BODY_HIGH, z, ax, ay, az, bx, by, bz, cx, cy, cz, Q);
    const dx = x - Q[0], dy = y + CAVE_BODY_HIGH - Q[1], dz = z - Q[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= R * R) return;
    y = y - (R - Math.sqrt(d2));
    ceiling = true;
  });
  out.x = x;
  out.y = y;
  out.z = z;
  out.pushX = x - x0;
  out.pushZ = z - z0;
  out.ceiling = ceiling;
  return out;
}

const Q = [0, 0, 0];
const SEEN: number[] = [];

type TriFn = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number) => void;

function forEachTri(src: CaveCellSource, x: number, y: number, z: number, r: number, fn: TriFn): void {
  const [cx0, cx1] = cellsAlong(x, CAVE_CELL_W);
  const [cz0, cz1] = cellsAlong(z, CAVE_CELL_W);
  const cy0 = Math.floor((y - r - 2) / CAVE_CELL_H);
  const cy1 = Math.floor((y + r + 2) / CAVE_CELL_H);
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = src.cell(cx, cy, cz);
        if (!c || c.triangleCount === 0) continue;
        if (c.maxY < y - r || c.minY > y + r) continue;
        const b0 = binOf(x - r, c.ox), b1 = binOf(x + r, c.ox);
        const k0 = binOf(z - r, c.oz), k1 = binOf(z + r, c.oz);
        SEEN.length = 0;
        for (let bz = k0; bz <= k1; bz++) {
          for (let bx = b0; bx <= b1; bx++) {
            const k = bz * CAVE_BINS + bx;
            for (let n = c.colOffsets[k]; n < c.colOffsets[k + 1]; n++) SEEN.push(c.colTris[n]);
          }
        }
        SEEN.sort((a, b) => a - b);
        const p = c.positions;
        const ix = c.indices;
        let last = -1;
        for (const ti of SEEN) {
          if (ti === last) continue;
          last = ti;
          const t = ti * 3;
          const a = ix[t] * 3, b = ix[t + 1] * 3, d = ix[t + 2] * 3;
          fn(p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2], p[d], p[d + 1], p[d + 2]);
        }
      }
    }
  }
}

const N3: [number, number, number] = [0, 0, 0];

function triNormal(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): [number, number, number] | null {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (l < 1e-12) return null;
  N3[0] = nx / l;
  N3[1] = ny / l;
  N3[2] = nz / l;
  return N3;
}

/** Closest point on triangle abc to p (Ericson, Real-Time Collision Detection 5.1.5), written to out. */
function closest(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, out: number[]): void {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) {
    out[0] = ax; out[1] = ay; out[2] = az;
    return;
  }
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) {
    out[0] = bx; out[1] = by; out[2] = bz;
    return;
  }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    out[0] = ax + v * abx; out[1] = ay + v * aby; out[2] = az + v * abz;
    return;
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) {
    out[0] = cx; out[1] = cy; out[2] = cz;
    return;
  }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    out[0] = ax + w * acx; out[1] = ay + w * acy; out[2] = az + w * acz;
    return;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    out[0] = bx + w * (cx - bx); out[1] = by + w * (cy - by); out[2] = bz + w * (cz - bz);
    return;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  out[0] = ax + abx * v + acx * w;
  out[1] = ay + aby * v + acy * w;
  out[2] = az + abz * v + acz * w;
}

/** Step between ray probes; each probe gathers triangles within CAVE_RAY_PROBE_R, so consecutive probes overlap and no triangle the ray crosses is missed. */
export const CAVE_RAY_STEP = 1.5;
export const CAVE_RAY_PROBE_R = 1.2;

/**
 * Ray against loaded cave triangles (both faces): distance along the
 * normalized direction to the first hit, or -1 within maxDist. For line of
 * sight (WP13 hit validation), aim and spell impacts. Probes every
 * CAVE_RAY_STEP m gather candidate triangles near the ray and test them
 * (Moller-Trumbore); stops once the nearest hit lies behind the probes.
 * Go twin: caves.Raycast (same order, same results).
 */
export function caveRaycast(src: CaveCellSource, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): number {
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(len > 0)) return -1;
  dx = dx / len;
  dy = dy / len;
  dz = dz / len;
  let best = Infinity;
  const steps = Math.ceil(maxDist / CAVE_RAY_STEP);
  for (let k = 0; k <= steps; k++) {
    const t0 = Math.min(k * CAVE_RAY_STEP, maxDist);
    forEachTri(src, ox + dx * t0, oy + dy * t0, oz + dz * t0, CAVE_RAY_PROBE_R, (ax, ay, az, bx, by, bz, cx, cy, cz) => {
      const t = rayTri(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, cx, cy, cz);
      if (t >= 0 && t <= maxDist && t < best) best = t;
    });
    if (best <= t0) break;
  }
  return best === Infinity ? -1 : best;
}

function rayTri(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): number {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return -1;
  const inv = 1 / det;
  const sx = ox - ax, sy = oy - ay, sz = oz - az;
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t >= 0 ? t : -1;
}

/** Below the heightfield by more than this (and not in a mouth hole) counts as underground. */
export const CAVE_UNDER_M = 1;

/**
 * Is (x, y, z) inside solid rock? Trilinear density of the cell holding the
 * point (i8 samples, negative = air); a missing or invalid cell counts as
 * rock. Used only where no cave floor answers (see CaveGroundCore.floorAt).
 */
export function caveRock(src: CaveCellSource, x: number, y: number, z: number): boolean {
  const cx = Math.floor(x / CAVE_CELL_W);
  const cy = Math.floor(y / CAVE_CELL_H);
  const cz = Math.floor(z / CAVE_CELL_W);
  const c = src.cell(cx, cy, cz);
  if (!c) return true;
  const fx = (x - c.ox) / 2;
  const fy = (y - c.oy) / 2;
  const fz = (z - c.oz) / 2;
  const i = Math.min(Math.floor(fx), CAVE_SAMPLES_XZ - 2);
  const j = Math.min(Math.floor(fy), CAVE_SAMPLES_Y - 2);
  const k = Math.min(Math.floor(fz), CAVE_SAMPLES_XZ - 2);
  const tx = fx - i;
  const ty = fy - j;
  const tz = fz - k;
  const d = c.density;
  const at = (a: number, b: number, e: number) => d[((j + b) * CAVE_SAMPLES_XZ + (k + e)) * CAVE_SAMPLES_XZ + (i + a)];
  const x00 = at(0, 0, 0) + (at(1, 0, 0) - at(0, 0, 0)) * tx;
  const x10 = at(0, 1, 0) + (at(1, 1, 0) - at(0, 1, 0)) * tx;
  const x01 = at(0, 0, 1) + (at(1, 0, 1) - at(0, 0, 1)) * tx;
  const x11 = at(0, 1, 1) + (at(1, 1, 1) - at(0, 1, 1)) * tx;
  const y0 = x00 + (x10 - x00) * ty;
  const y1 = x01 + (x11 - x01) * ty;
  return y0 + (y1 - y0) * tz >= 0;
}

/**
 * The movement ground with caves (README "Cave collision", "Ground
 * dispatch"): the surface ground (terrain, or terrain + structures) on the
 * open surface, cave triangles in mouth holes and underground. The step
 * views it at the player's level (`atLevel`, client/src/sim/caves.ts).
 */
export class CaveGroundCore {
  private readonly res: CaveCollideResult = { x: 0, y: 0, z: 0, pushX: 0, pushZ: 0, ceiling: false };

  constructor(
    readonly surface: (x: number, z: number) => number,
    readonly openings: readonly CaveOpening[],
    readonly cells: CaveCellSource,
    /** Surface water (the wasm water_height), if the surface has water. */
    readonly water?: (x: number, z: number) => number,
    /** The bare heightfield (no structures) for the in-cave test: climbing a tower wall is not being underground. Default: surface. */
    readonly terrain?: (x: number, z: number) => number,
  ) {}

  /** The surface ground (no level): what non-step callers see. */
  heightAt(x: number, z: number): number {
    return this.surface(x, z);
  }

  waterAt(x: number, z: number): number {
    return this.water ? this.water(x, z) : -Infinity;
  }

  /** In a mouth hole or more than CAVE_UNDER_M under the surface at y? */
  inCave(x: number, y: number, z: number): boolean {
    return y < (this.terrain ?? this.surface)(x, z) - CAVE_UNDER_M || caveMasked(this.openings, x, z);
  }

  /**
   * The ground under feet height y at (x, z): the surface outside caves; in
   * a cave the highest cave floor in [y - 34, y + MAX_STEP_UP_M]; with no
   * floor there, the lowest ledge within CAVE_LEDGE_M above (a real step:
   * the step and climb rules decide), else `y` itself inside rock (walls
   * are collide's job, never a slope to climb), else y - 35 in open air
   * (keep falling); the old surface in a mouth hole whose cells are missing.
   */
  floorAt(x: number, y: number, z: number): number {
    const h = this.surface(x, z);
    if (!this.inCave(x, y, z)) return h;
    const f = caveFloorAt(this.cells, x, y, z);
    if (f > -Infinity) return f;
    if (caveMasked(this.openings, x, z)) return h;
    const ledge = caveFloorIn(this.cells, x, z, y + MAX_STEP_UP_M, y + CAVE_LEDGE_M, true);
    if (ledge < Infinity) return ledge;
    return caveRock(this.cells, x, y + 1, z) ? y : y - CAVE_FLOOR_DROP - 1;
  }

  /** The ground viewed at feet height y (the movement step's view). */
  atLevel(y: number): { heightAt(x: number, z: number): number; waterAt(x: number, z: number): number; collide(x: number, y: number, z: number, out: CaveCollideResult): CaveCollideResult } {
    return {
      heightAt: (x, z) => this.floorAt(x, y, z),
      waterAt: (x, z) => (this.inCave(x, y, z) ? -Infinity : this.waterAt(x, z)),
      collide: (cx, cy, cz, out) => this.collide(cx, cy, cz, out),
    };
  }

  /** Wall/ceiling push-out; untouched (push 0) outside caves. */
  collide(x: number, y: number, z: number, out: CaveCollideResult): CaveCollideResult {
    if (!this.inCave(x, y, z)) {
      out.x = x; out.y = y; out.z = z; out.pushX = 0; out.pushZ = 0; out.ceiling = false;
      return out;
    }
    return caveCollide(this.cells, x, y, z, out);
  }

  /** Convenience for tools: a fresh result. */
  collideNew(x: number, y: number, z: number): CaveCollideResult {
    return { ...this.collide(x, y, z, this.res) };
  }
}

/** A cell source that builds cave cells on demand through the wasm (cached). */
export function wasmCellSource(wg: Worldgen, atlas: AtlasHandle): CaveCellSource {
  const cells = new Map<number, CaveCell>();
  return {
    cell(cx, cy, cz) {
      if (!caveCellValid(cx, cy, cz)) return undefined;
      const k = caveCellKey(cx, cy, cz);
      let c = cells.get(k);
      if (!c) {
        c = parseCaveCell(caveCellBytes(wg, atlas, cx, cy, cz));
        cells.set(k, c);
      }
      return c;
    },
  };
}

