// Towns, roads and structures (WP20, spec 5): the reader for the towns
// buffer (`LDTW`, layout in worldgen/README.md "Towns"), the `towns_build`
// export, and the building collision queries.
//
// Collision is pure TS over the buffer's f32 boxes and the Go zone runs a
// line-for-line port (server/pkg/towns). Both must give identical bits:
// same operation order, f64 arithmetic on the f32 values, no fused
// multiply-add (JS never fuses; the Go port forces separate roundings), no
// host math beyond + - * / Math.sqrt and comparisons (every box carries its
// cos/sin from the generator). The algorithm is written out in
// worldgen/README.md "Town collision" and pinned by the golden table's town
// floor/collide vectors, checked in every host.
import { MAX_STEP_UP_M, PLAYER_CAPSULE_RADIUS } from '@lodestone/contracts';
import type { AtlasHandle, Worldgen } from './index';

export const TOWNS_MAGIC = 0x5754444c; // "LDTW"
export const TOWNS_FORMAT = 1;
const HEADER_LEN = 64;
const DIR_ENTRIES = 16;

export const TOWN_SEC = { settlements: 0, buildings: 1, boxes: 2, props: 3, npcs: 4, roads: 5, points: 6, bridges: 7, signs: 8, structures: 9, pieces: 10, veins: 11, names: 12 } as const;
export const TOWN_REC = [64, 96, 40, 32, 40, 24, 12, 48, 32, 56, 40, 32, 0] as const;

export const BUILDING_STYLES = ['timber', 'stone', 'adobe', 'stilt', 'log', 'cottage'] as const;
export const BUILDING_ROLES = ['house', 'inn', 'forge', 'stall', 'garden', 'farm', 'workshop', 'storehouse', 'gatehouse'] as const;
export const ROOF_KINDS = ['gable', 'hip', 'flat', 'none'] as const;
export const BUILDING_FLAG = { porch: 1, chimney: 2, stilts: 4, openFront: 8, field: 16, jetty: 32 } as const;
export const BOX_KINDS = ['floor', 'wall', 'upper', 'roof', 'ramp', 'furniture', 'fence', 'townWall', 'gate', 'deck', 'bridgeRamp', 'piece', 'townProp', 'railing'] as const;
export const BOX_FLAG = { walk: 1, solid: 2, ceil: 4 } as const;
export const PROP_KINDS = [
  'door', 'bed', 'table', 'bench', 'hearth', 'chest', 'barrel', 'crate', 'shelf', 'counter', 'forge', 'anvil', 'quench', 'workbench', 'stall', 'board',
  'well', 'lantern', 'wardBed', 'crops', 'rug', 'bookshelf', 'campfire', 'tent', 'starmetal', 'statue', 'crystal', 'brazier', 'bones', 'rubble', 'torch',
] as const;
export type PropKind = (typeof PROP_KINDS)[number];
export const PROP_FLAG = { interact: 1, light: 2 } as const;
export const NPC_ROLES = ['villager', 'merchant', 'blacksmith', 'innkeeper', 'bounty', 'farmer', 'guard'] as const;
export const MERCHANT_KINDS = ['general', 'provisions', 'herbalist', 'tools'] as const;
// Settlement sizes and structure kinds: SETTLEMENT_SIZES / STRUCTURE_KINDS in ./format (atlas site tables).
export const PIECE_KINDS = ['pave', 'wall', 'corner', 'room', 'tower', 'ramp', 'pillars', 'tent', 'palisade', 'campfire', 'shaft', 'altar', 'crater', 'lair', 'rubble'] as const;
/** Stable-id layers of the towns layer (README "Stable ids"). */
export const TOWN_LAYER = { building: 0x20, prop: 0x21, npc: 0x22, piece: 0x23, bridge: 0x24, sign: 0x25 } as const;
const NONE = 0xffff;

export interface Settlement {
  index: number;
  id: bigint;
  site: number;
  size: number;
  style: number;
  walled: boolean;
  /** Town wall radius (m, 0 = no wall). */
  wallRadius: number;
  region: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  square: number;
  buildingFirst: number;
  buildingCount: number;
  npcFirst: number;
  npcCount: number;
  propFirst: number;
  propCount: number;
  boxFirst: number;
  boxCount: number;
  roadFirst: number;
  roadCount: number;
}

export interface Building {
  index: number;
  id: bigint;
  settlement: number;
  role: number;
  style: number;
  x: number;
  z: number;
  floorY: number;
  baseY: number;
  /** Half extents along local u (frontage) and v (depth); the door is on the -v wall. */
  hx: number;
  hz: number;
  /** Local u axis in world xz (cos, sin of the yaw); v = (-s, c). */
  c: number;
  s: number;
  storey: number;
  roofH: number;
  floors: number;
  roof: number;
  /** Ridge along local u (else along v). */
  ridgeU: boolean;
  flags: number;
  doorU: number;
  doorW: number;
  variant: number;
  boxFirst: number;
  boxCount: number;
  propFirst: number;
  propCount: number;
  /** Street index (ROADS) the door faces, or -1 for the square. */
  street: number;
  frontX: number;
  frontZ: number;
  along: number;
}

export interface TownProp {
  index: number;
  id: bigint;
  x: number;
  y: number;
  z: number;
  /** Radians. */
  yaw: number;
  kind: number;
  variant: number;
  building: number;
  settlement: number;
  flags: number;
  /** 64 = 1.0 (crops: field width in metres). */
  scale: number;
  structure: number;
}

export interface TownNpc {
  index: number;
  id: bigint;
  settlement: number;
  role: number;
  variant: number;
  name: string;
  home: number;
  work: number;
  workProp: number;
  workX: number;
  workZ: number;
  homeX: number;
  homeZ: number;
  workYaw: number;
  merchant: number;
}

export interface TownRoad {
  index: number;
  /** x, y (ground sample), z triples. */
  points: Float32Array;
  from: number;
  to: number;
  width: number;
  /** 0 road between settlements, 1 street inside one. */
  cls: number;
  /** 0 dirt, 1 cobble. */
  surface: number;
  settlement: number;
  length: number;
}

export interface TownBridge {
  index: number;
  id: bigint;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  deckY: number;
  width: number;
  waterY: number;
  road: number;
  style: number;
  boxFirst: number;
  boxCount: number;
}

export interface TownSign {
  id: bigint;
  x: number;
  y: number;
  z: number;
  /** Up to three arms: yaw (radians) and the settlement index it points at (-1 none). */
  arms: { yaw: number; settlement: number }[];
}

export interface TownStructure {
  index: number;
  id: bigint;
  site: number;
  kind: number;
  tier: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  pieceFirst: number;
  pieceCount: number;
  propFirst: number;
  propCount: number;
  boxFirst: number;
  boxCount: number;
  /** Mineshafts: the atlas site index of the nearest cave mouth (within 800 m), else -1. */
  link: number;
}

export interface TownPiece {
  id: bigint;
  x: number;
  y: number;
  z: number;
  c: number;
  s: number;
  sx: number;
  sy: number;
  kind: number;
  variant: number;
  structure: number;
}

export interface TownVein {
  id: bigint;
  x: number;
  y: number;
  z: number;
  material: number;
  element: number;
  hp: number;
  size: number;
}

/**
 * Collision boxes as flat arrays (f32 values widened to f64), 9 floats per
 * box: cx, cz, c, s, hx, hz, y0, y1, y2; kind/flags/owner alongside.
 */
export interface TownBoxes {
  count: number;
  f: Float64Array;
  kind: Uint8Array;
  flags: Uint8Array;
  owner: Uint16Array;
}

export interface Towns {
  genVersion: number;
  seed: bigint;
  settlements: Settlement[];
  buildings: Building[];
  boxes: TownBoxes;
  props: TownProp[];
  npcs: TownNpc[];
  roads: TownRoad[];
  bridges: TownBridge[];
  signs: TownSign[];
  structures: TownStructure[];
  pieces: TownPiece[];
  veins: TownVein[];
  names: string[];
}

const opt = (v: number) => (v === NONE ? -1 : v);
const turn = (u16: number) => (u16 / 65536) * 2 * Math.PI;

/** Copy of the world's towns buffer (`towns_build`). */
export function townsBytes(wg: Worldgen, atlas: AtlasHandle): Uint8Array {
  const e = wg.exports;
  if (!e.towns_build) throw new Error('worldgen.wasm has no towns_build export (rebuild: npm run build:wasm)');
  const p = e.towns_build(atlas.ptr);
  const n = e.result_len();
  if (!p) {
    const msg = new TextDecoder().decode(new Uint8Array(e.memory.buffer, e.error_ptr(), e.error_len()).slice());
    throw new Error(`towns_build failed: ${msg}`);
  }
  return new Uint8Array(e.memory.buffer, p, n).slice();
}

export function parseTowns(bytes: Uint8Array): Towns {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== TOWNS_MAGIC) throw new Error('not a towns buffer (bad magic)');
  const fmt = dv.getUint16(4, true);
  if (fmt !== TOWNS_FORMAT) throw new Error(`towns format ${fmt}, this reader reads ${TOWNS_FORMAT}`);
  if (dv.getUint32(8, true) > bytes.byteLength) throw new Error('towns buffer truncated');
  const sec = (id: number) => {
    const p = HEADER_LEN + id * 16;
    return { off: dv.getUint32(p, true), count: dv.getUint32(p + 4, true), len: dv.getUint32(p + 8, true) };
  };
  for (let id = 0; id < DIR_ENTRIES; id++) {
    const s = sec(id);
    if (s.off + s.len > bytes.byteLength) throw new Error(`towns section ${id} out of bounds`);
  }
  const u8 = (o: number) => dv.getUint8(o);
  const u16 = (o: number) => dv.getUint16(o, true);
  const u32 = (o: number) => dv.getUint32(o, true);
  const u64 = (o: number) => dv.getBigUint64(o, true);
  const f32 = (o: number) => dv.getFloat32(o, true);
  const each = <T>(id: number, fn: (o: number, i: number) => T): T[] => {
    const s = sec(id);
    const out: T[] = [];
    for (let i = 0; i < s.count; i++) out.push(fn(s.off + i * TOWN_REC[id], i));
    return out;
  };

  const nm = sec(TOWN_SEC.names);
  const names: string[] = [];
  const dec = new TextDecoder();
  for (let i = 0, o = nm.off; i < nm.count; i++) {
    const l = u16(o);
    names.push(dec.decode(bytes.subarray(o + 2, o + 2 + l)));
    o += 2 + l;
  }

  const settlements = each(TOWN_SEC.settlements, (o, index) => ({
    index,
    id: u64(o),
    site: u16(o + 8),
    size: u8(o + 10),
    style: u8(o + 11),
    walled: u8(o + 12) !== 0,
    wallRadius: u8(o + 13),
    region: u8(o + 14),
    x: f32(o + 16),
    y: f32(o + 20),
    z: f32(o + 24),
    radius: f32(o + 28),
    square: f32(o + 32),
    buildingFirst: u16(o + 36),
    buildingCount: u16(o + 38),
    npcFirst: u16(o + 40),
    npcCount: u16(o + 42),
    propFirst: u32(o + 44),
    propCount: u32(o + 48),
    boxFirst: u32(o + 52),
    boxCount: u32(o + 56),
    roadFirst: u16(o + 60),
    roadCount: u16(o + 62),
  }));
  const buildings = each(TOWN_SEC.buildings, (o, index) => ({
    index,
    id: u64(o),
    settlement: opt(u16(o + 8)),
    role: u8(o + 10),
    style: u8(o + 11),
    x: f32(o + 12),
    z: f32(o + 16),
    floorY: f32(o + 20),
    baseY: f32(o + 24),
    hx: f32(o + 28),
    hz: f32(o + 32),
    c: f32(o + 36),
    s: f32(o + 40),
    storey: f32(o + 44),
    roofH: f32(o + 48),
    floors: u8(o + 52),
    roof: u8(o + 53),
    ridgeU: u8(o + 54) !== 0,
    flags: u8(o + 55),
    doorU: f32(o + 56),
    doorW: f32(o + 60),
    variant: u8(o + 64),
    boxCount: u16(o + 66),
    boxFirst: u32(o + 68),
    propFirst: u32(o + 72),
    propCount: u16(o + 76),
    street: opt(u16(o + 78)),
    frontX: f32(o + 80),
    frontZ: f32(o + 84),
    along: f32(o + 88),
  }));
  const bs = sec(TOWN_SEC.boxes);
  const boxes: TownBoxes = { count: bs.count, f: new Float64Array(bs.count * 9), kind: new Uint8Array(bs.count), flags: new Uint8Array(bs.count), owner: new Uint16Array(bs.count) };
  for (let i = 0; i < bs.count; i++) {
    const o = bs.off + i * TOWN_REC[TOWN_SEC.boxes];
    for (let k = 0; k < 9; k++) boxes.f[i * 9 + k] = f32(o + k * 4);
    boxes.kind[i] = u8(o + 36);
    boxes.flags[i] = u8(o + 37);
    boxes.owner[i] = u16(o + 38);
  }
  const props = each(TOWN_SEC.props, (o, index) => ({
    index,
    id: u64(o),
    x: f32(o + 8),
    y: f32(o + 12),
    z: f32(o + 16),
    yaw: turn(u16(o + 20)),
    kind: u8(o + 22),
    variant: u8(o + 23),
    building: opt(u16(o + 24)),
    settlement: opt(u16(o + 26)),
    flags: u8(o + 28),
    scale: u8(o + 29),
    structure: opt(u16(o + 30)),
  }));
  const npcs = each(TOWN_SEC.npcs, (o, index) => ({
    index,
    id: u64(o),
    settlement: u16(o + 8),
    role: u8(o + 10),
    variant: u8(o + 11),
    name: names[u16(o + 12)] ?? '',
    home: opt(u16(o + 14)),
    work: opt(u16(o + 16)),
    workProp: opt(u16(o + 18)),
    workX: f32(o + 20),
    workZ: f32(o + 24),
    homeX: f32(o + 28),
    homeZ: f32(o + 32),
    workYaw: turn(u16(o + 36)),
    merchant: u8(o + 38),
  }));
  const pts = sec(TOWN_SEC.points);
  const allPoints = new Float32Array(pts.count * 3);
  for (let i = 0; i < pts.count * 3; i++) allPoints[i] = f32(pts.off + i * 4);
  const roads = each(TOWN_SEC.roads, (o, index) => ({
    index,
    points: allPoints.subarray(u32(o) * 3, (u32(o) + u32(o + 4)) * 3),
    from: opt(u16(o + 8)),
    to: opt(u16(o + 10)),
    width: f32(o + 12),
    cls: u8(o + 16),
    surface: u8(o + 17),
    settlement: opt(u16(o + 18)),
    length: f32(o + 20),
  }));
  const bridges = each(TOWN_SEC.bridges, (o, index) => ({
    index,
    id: u64(o),
    ax: f32(o + 8),
    az: f32(o + 12),
    bx: f32(o + 16),
    bz: f32(o + 20),
    deckY: f32(o + 24),
    width: f32(o + 28),
    waterY: f32(o + 32),
    road: u16(o + 36),
    style: u8(o + 38),
    boxFirst: u32(o + 40),
    boxCount: u16(o + 44),
  }));
  const signs = each(TOWN_SEC.signs, (o) => {
    const arms: TownSign['arms'] = [];
    for (let k = 0; k < 3; k++) arms.push({ yaw: turn(u16(o + 20 + k * 2)), settlement: opt(u16(o + 26 + k * 2)) });
    return { id: u64(o), x: f32(o + 8), y: f32(o + 12), z: f32(o + 16), arms };
  });
  const structures = each(TOWN_SEC.structures, (o, index) => ({
    index,
    id: u64(o),
    site: u16(o + 8),
    kind: u8(o + 10),
    tier: u8(o + 11),
    x: f32(o + 12),
    y: f32(o + 16),
    z: f32(o + 20),
    radius: f32(o + 24),
    pieceFirst: u32(o + 28),
    pieceCount: u16(o + 32),
    propCount: u16(o + 34),
    boxFirst: u32(o + 36),
    boxCount: u32(o + 40),
    propFirst: u32(o + 44),
    link: opt(u16(o + 48)),
  }));
  const pieces = each(TOWN_SEC.pieces, (o) => ({
    id: u64(o),
    x: f32(o + 8),
    y: f32(o + 12),
    z: f32(o + 16),
    c: f32(o + 20),
    s: f32(o + 24),
    sx: f32(o + 28),
    sy: f32(o + 32),
    kind: u8(o + 36),
    variant: u8(o + 37),
    structure: u16(o + 38),
  }));
  const veins = each(TOWN_SEC.veins, (o) => ({ id: u64(o), x: f32(o + 8), y: f32(o + 12), z: f32(o + 16), material: u8(o + 24), element: u8(o + 25), hp: u16(o + 26), size: u8(o + 28) }));
  return { genVersion: dv.getUint16(6, true), seed: u64(16), settlements, buildings, boxes, props, npcs, roads, bridges, signs, structures, pieces, veins, names };
}

// ---- collision ---------------------------------------------------------

/** Box index cell size (m). Any superset of the touching boxes gives the same answers. */
export const TOWN_GRID_CELL = 8;
/** Head height of the player body (m): the cave capsule's top sphere (feet + 1.5 + 0.4). */
export const TOWN_HEAD_M = 1.9;
const STEP = MAX_STEP_UP_M;
const R = PLAYER_CAPSULE_RADIUS;

export interface TownCollideResult {
  x: number;
  y: number;
  z: number;
  pushX: number;
  pushZ: number;
  ceiling: boolean;
}

const cellKey = (cx: number, cz: number) => (cx + 32768) * 65536 + (cz + 32768);

/**
 * The town collision core (Go: towns.Collision). Boxes are solid from y0 up
 * to a top that runs from y1 (local u = -hx) to y2 (u = +hx):
 *  - floorAt(x, y, z): the highest walkable top at (x, z) that is at most a
 *    step (MAX_STEP_UP_M) above feet height y; -Infinity if none.
 *  - collide(x, y, z): two passes over the solid boxes (ascending index)
 *    whose top is more than a step above the feet and whose bottom is below
 *    the head; each pushes the body circle (PLAYER_CAPSULE_RADIUS) out of the
 *    box rectangle. Then one ceiling pass: a ceiling box whose bottom is
 *    above the step and below the head, over the pushed point, lowers y so
 *    the head touches it.
 */
export class TownCollision {
  private readonly cells = new Map<number, number[]>();
  private readonly stamp: Uint32Array;
  private query = 0;
  private readonly cand: number[] = [];

  constructor(readonly boxes: TownBoxes) {
    this.stamp = new Uint32Array(boxes.count);
    const f = boxes.f;
    for (let i = 0; i < boxes.count; i++) {
      const o = i * 9;
      const r = Math.sqrt(f[o + 4] * f[o + 4] + f[o + 5] * f[o + 5]);
      const x0 = Math.floor((f[o] - r) / TOWN_GRID_CELL);
      const x1 = Math.floor((f[o] + r) / TOWN_GRID_CELL);
      const z0 = Math.floor((f[o + 1] - r) / TOWN_GRID_CELL);
      const z1 = Math.floor((f[o + 1] + r) / TOWN_GRID_CELL);
      for (let cz = z0; cz <= z1; cz++)
        for (let cx = x0; cx <= x1; cx++) {
          const k = cellKey(cx, cz);
          const l = this.cells.get(k);
          if (l) l.push(i);
          else this.cells.set(k, [i]);
        }
    }
  }

  /** True when no box is indexed near (x, z) (cheap early-out for callers). */
  empty(x: number, z: number): boolean {
    return !this.cells.has(cellKey(Math.floor(x / TOWN_GRID_CELL), Math.floor(z / TOWN_GRID_CELL)));
  }

  /** Candidate boxes for the square [x-m, x+m] x [z-m, z+m], ascending, deduplicated (reused array). */
  candidates(x: number, z: number, m: number): number[] {
    const out = this.cand;
    out.length = 0;
    this.query = (this.query + 1) >>> 0;
    if (this.query === 0) {
      this.stamp.fill(0);
      this.query = 1;
    }
    const x0 = Math.floor((x - m) / TOWN_GRID_CELL);
    const x1 = Math.floor((x + m) / TOWN_GRID_CELL);
    const z0 = Math.floor((z - m) / TOWN_GRID_CELL);
    const z1 = Math.floor((z + m) / TOWN_GRID_CELL);
    for (let cz = z0; cz <= z1; cz++)
      for (let cx = x0; cx <= x1; cx++) {
        const l = this.cells.get(cellKey(cx, cz));
        if (!l) continue;
        for (const i of l) {
          if (this.stamp[i] !== this.query) {
            this.stamp[i] = this.query;
            out.push(i);
          }
        }
      }
    out.sort((a, b) => a - b);
    return out;
  }

  /** Top of box i at (x, z), or NaN outside its rectangle. */
  topAt(i: number, x: number, z: number): number {
    const f = this.boxes.f;
    const o = i * 9;
    const dx = x - f[o];
    const dz = z - f[o + 1];
    const c = f[o + 2];
    const s = f[o + 3];
    const hx = f[o + 4];
    const hz = f[o + 5];
    const u = dx * c + dz * s;
    const v = dz * c - dx * s;
    if (u < -hx || u > hx || v < -hz || v > hz) return NaN;
    const y1 = f[o + 7];
    const y2 = f[o + 8];
    return y1 + (y2 - y1) * ((u + hx) / (hx + hx));
  }

  floorAt(x: number, y: number, z: number): number {
    let best = -Infinity;
    const l = this.cells.get(cellKey(Math.floor(x / TOWN_GRID_CELL), Math.floor(z / TOWN_GRID_CELL)));
    if (!l) return best;
    const lim = y + STEP;
    for (const i of l) {
      if ((this.boxes.flags[i] & BOX_FLAG.walk) === 0) continue;
      const t = this.topAt(i, x, z);
      if (t <= lim && t > best) best = t;
    }
    return best;
  }

  collide(x: number, y: number, z: number, out: TownCollideResult): TownCollideResult {
    out.x = x;
    out.y = y;
    out.z = z;
    out.pushX = 0;
    out.pushZ = 0;
    out.ceiling = false;
    const cands = this.candidates(x, z, R + 1);
    if (cands.length === 0) return out;
    const f = this.boxes.f;
    const flags = this.boxes.flags;
    const lim = y + STEP;
    const head = y + TOWN_HEAD_M;
    const r2 = R * R;
    let px = x;
    let pz = z;
    for (let pass = 0; pass < 2; pass++) {
      for (const i of cands) {
        if ((flags[i] & BOX_FLAG.solid) === 0) continue;
        const o = i * 9;
        const y1 = f[o + 7];
        const y2 = f[o + 8];
        const top = y1 > y2 ? y1 : y2;
        if (!(top > lim && f[o + 6] < head)) continue;
        const c = f[o + 2];
        const s = f[o + 3];
        const hx = f[o + 4];
        const hz = f[o + 5];
        const dx = px - f[o];
        const dz = pz - f[o + 1];
        const u = dx * c + dz * s;
        const v = dz * c - dx * s;
        const cu = u < -hx ? -hx : u > hx ? hx : u;
        const cv = v < -hz ? -hz : v > hz ? hz : v;
        const du = u - cu;
        const dv = v - cv;
        const d2 = du * du + dv * dv;
        if (d2 >= r2) continue;
        let pu: number;
        let pv: number;
        if (d2 > 0) {
          const d = Math.sqrt(d2);
          const k = (R - d) / d;
          pu = du * k;
          pv = dv * k;
        } else {
          // Inside the rectangle: leave by the nearest face.
          const ex = hx - (u < 0 ? -u : u);
          const ez = hz - (v < 0 ? -v : v);
          if (ex <= ez) {
            pu = (u >= 0 ? 1 : -1) * (ex + R);
            pv = 0;
          } else {
            pu = 0;
            pv = (v >= 0 ? 1 : -1) * (ez + R);
          }
        }
        const wx = pu * c - pv * s;
        const wz = pu * s + pv * c;
        px = px + wx;
        pz = pz + wz;
        out.pushX = out.pushX + wx;
        out.pushZ = out.pushZ + wz;
      }
    }
    let ny = y;
    for (const i of cands) {
      if ((flags[i] & BOX_FLAG.ceil) === 0) continue;
      const y0 = f[i * 9 + 6];
      if (!(y0 > lim && y0 < ny + TOWN_HEAD_M)) continue;
      if (Number.isNaN(this.topAt(i, px, pz))) continue;
      ny = y0 - TOWN_HEAD_M;
      out.ceiling = true;
    }
    out.x = px;
    out.y = ny;
    out.z = pz;
    return out;
  }

  collideNew(x: number, y: number, z: number): TownCollideResult {
    return this.collide(x, y, z, { x: 0, y: 0, z: 0, pushX: 0, pushZ: 0, ceiling: false });
  }
}

/** Minimal ground shape the town ground wraps (the client's GroundQuery and the golden runner's terrain both fit). */
export interface TownBaseGround {
  heightAt(x: number, z: number): number;
  waterAt?(x: number, z: number): number;
  normalAt?(x: number, z: number): { x: number; y: number; z: number };
  atLevel?(y: number): TownBaseGround;
  collide?(x: number, y: number, z: number, out: TownCollideResult): TownCollideResult;
}

/**
 * The movement ground with buildings (Go: towns.Ground). The step views it
 * at the player's level (WP09 hook): heightAt there is the higher of the
 * base view (terrain, towers, caves) and the town floor within a step of
 * the feet; collide runs the base view's push-out (caves) and then the
 * town's. Non-step callers (rendering, spawns) see the base surface.
 */
export class TownGroundCore {
  private readonly tmp: TownCollideResult = { x: 0, y: 0, z: 0, pushX: 0, pushZ: 0, ceiling: false };

  constructor(
    readonly base: TownBaseGround,
    readonly towns: TownCollision,
  ) {}

  heightAt(x: number, z: number): number {
    return this.base.heightAt(x, z);
  }

  waterAt(x: number, z: number): number {
    return this.base.waterAt ? this.base.waterAt(x, z) : -Infinity;
  }

  normalAt(x: number, z: number): { x: number; y: number; z: number } {
    return this.base.normalAt?.(x, z) ?? { x: 0, y: 1, z: 0 };
  }

  /** The ground under feet at height y: max(base view, town floor within a step). */
  floorAt(x: number, y: number, z: number): number {
    const bv = this.base.atLevel ? this.base.atLevel(y) : this.base;
    const b = bv.heightAt(x, z);
    const t = this.towns.floorAt(x, y, z);
    return t > b ? t : b;
  }

  atLevel(y: number): TownBaseGround & { collide(x: number, y: number, z: number, out: TownCollideResult): TownCollideResult } {
    const bv = this.base.atLevel ? this.base.atLevel(y) : this.base;
    const towns = this.towns;
    const tmp = this.tmp;
    return {
      heightAt: (x, z) => {
        const b = bv.heightAt(x, z);
        const t = towns.floorAt(x, y, z);
        return t > b ? t : b;
      },
      waterAt: (x, z) => (bv.waterAt ? bv.waterAt(x, z) : -Infinity),
      normalAt: (x, z) => bv.normalAt?.(x, z) ?? { x: 0, y: 1, z: 0 },
      collide: (cx, cy, cz, out) => {
        let x = cx;
        let yy = cy;
        let z = cz;
        let px = 0;
        let pz = 0;
        let ceil = false;
        if (bv.collide) {
          const r = bv.collide(cx, cy, cz, tmp);
          x = r.x;
          yy = r.y;
          z = r.z;
          px = r.pushX;
          pz = r.pushZ;
          ceil = r.ceiling;
        }
        towns.collide(x, yy, z, out);
        out.pushX = out.pushX + px;
        out.pushZ = out.pushZ + pz;
        out.ceiling = out.ceiling || ceil;
        return out;
      },
    };
  }
}
